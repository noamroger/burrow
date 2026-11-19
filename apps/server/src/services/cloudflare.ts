import type { CloudflareSettings, PermissionCheck, SaveTokenInput } from '@burrow/shared';
import type { Logger } from 'pino';
import { CloudflareApiError, CloudflareClient } from '../cloudflare/client.js';
import type { CfAccount, CfZone } from '../cloudflare/types.js';
import { SettingKeys, type SettingsRepository } from '../db/settings.js';
import { AppError, errorMessage, errors } from '../lib/errors.js';
import type { SecretBox } from '../lib/secretbox.js';

export interface CloudflareServiceOptions {
  settings: SettingsRepository;
  box: SecretBox;
  apiBase: string;
  logger: Logger;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Faster retries in tests. */
  retryBaseMs?: number;
}

/** A ready-to-use client bound to the configured account. */
export interface CloudflareContext {
  client: CloudflareClient;
  accountId: string;
}

export const PERMISSION_NAMES = {
  tunnel: 'Account › Cloudflare Tunnel › Edit',
  account: 'Account › Account Settings › Read',
  dns: 'Zone › DNS › Edit',
  zone: 'Zone › Zone › Read',
  access: 'Account › Access: Apps and Policies › Edit',
} as const;

/** Result of saving a token: either saved, or the user must pick an account first. */
export interface SaveTokenOutcome {
  saved: boolean;
  settings: CloudflareSettings;
}

/**
 * Owns the Cloudflare API token: verification, permission checks, encrypted
 * storage and the shared {@link CloudflareClient}.
 */
export class CloudflareService {
  private cached: { token: string; client: CloudflareClient } | null = null;

  constructor(private readonly opts: CloudflareServiceOptions) {}

  /** Build a client for an arbitrary token (used to verify a token before saving it). */
  createClient(token: string): CloudflareClient {
    return new CloudflareClient({
      token,
      baseUrl: this.opts.apiBase,
      logger: this.opts.logger,
      fetch: this.opts.fetch,
      retryBaseMs: this.opts.retryBaseMs,
    });
  }

  /** True once a token and an account are stored. */
  isConfigured(): boolean {
    return Boolean(
      this.opts.settings.get<string>(SettingKeys.cloudflareToken) &&
      this.opts.settings.get<string>(SettingKeys.cloudflareAccountId),
    );
  }

  /** The decrypted token, or undefined. Keep it in memory only. */
  getToken(): string | undefined {
    const encrypted = this.opts.settings.get<string>(SettingKeys.cloudflareToken);
    return encrypted ? this.opts.box.decrypt(encrypted) : undefined;
  }

  /** Secrets that must be scrubbed from any log output. */
  knownSecrets(): string[] {
    return this.cached ? [this.cached.token] : [];
  }

  /** Client + account id, or throws `CLOUDFLARE_NOT_CONFIGURED`. */
  getContext(): CloudflareContext {
    const accountId = this.opts.settings.get<string>(SettingKeys.cloudflareAccountId);
    if (!accountId) throw errors.cloudflareNotConfigured();
    if (!this.cached) {
      const token = this.getToken();
      if (!token) throw errors.cloudflareNotConfigured();
      this.cached = { token, client: this.createClient(token) };
    }
    return { client: this.cached.client, accountId };
  }

  /** Settings as shown in the UI. The token itself is never returned. */
  getSettings(): CloudflareSettings {
    if (!this.isConfigured()) {
      return {
        configured: false,
        tokenHint: null,
        account: null,
        availableAccounts: [],
        permissions: [],
      };
    }
    const s = this.opts.settings;
    const id = s.get<string>(SettingKeys.cloudflareAccountId)!;
    const account = { id, name: s.get<string>(SettingKeys.cloudflareAccountName) ?? id };
    let tokenHint: string | null = null;
    try {
      tokenHint = this.getToken()?.slice(-4) ?? null;
    } catch {
      tokenHint = null;
    }
    return {
      configured: true,
      tokenHint,
      account,
      availableAccounts: [account],
      permissions: s.get<PermissionCheck[]>(SettingKeys.cloudflarePermissions) ?? [],
    };
  }

  /**
   * Verify a token, check its permissions and store it encrypted.
   *
   * When the token sees several accounts and none was chosen, nothing is
   * stored and the returned settings list `availableAccounts` so the UI can ask.
   */
  async saveToken(input: SaveTokenInput): Promise<SaveTokenOutcome> {
    const token = input.token.trim();
    const client = this.createClient(token);

    const { accounts, accountsError } = await this.verify(client, input.accountId);

    // Pick the account.
    let account: CfAccount | undefined;
    if (input.accountId) {
      account =
        accounts.find((a) => a.id === input.accountId) ??
        (accountsError ? { id: input.accountId, name: input.accountId } : undefined);
      if (!account) {
        throw errors.validation('This token cannot access the selected account.', {
          availableAccounts: accounts.map(({ id, name }) => ({ id, name })),
        });
      }
    } else if (accounts.length === 1) {
      account = accounts[0];
    } else if (accounts.length > 1) {
      return {
        saved: false,
        settings: {
          configured: false,
          tokenHint: token.slice(-4),
          account: null,
          availableAccounts: accounts.map(({ id, name }) => ({ id, name })),
          permissions: [this.accountCheck(accounts, accountsError)],
        },
      };
    } else {
      throw new AppError(
        'CLOUDFLARE_PERMISSION_MISSING',
        `The token cannot list any account. Add the "${PERMISSION_NAMES.account}" permission, or provide the account id.`,
        400,
        { permissions: [this.accountCheck(accounts, accountsError)] },
      );
    }

    const permissions = await this.checkPermissions(client, account!.id, accounts, accountsError);
    const missing = permissions.filter(
      (p) => !p.ok && (p.name === PERMISSION_NAMES.tunnel || p.name === PERMISSION_NAMES.zone),
    );
    if (missing.length > 0) {
      throw new AppError(
        'CLOUDFLARE_PERMISSION_MISSING',
        `The token is missing: ${missing.map((p) => p.name).join(', ')}`,
        400,
        { permissions },
      );
    }

    const s = this.opts.settings;
    const previousAccount = s.get<string>(SettingKeys.cloudflareAccountId);
    if (previousAccount && previousAccount !== account!.id) {
      // Tunnels belong to an account: start fresh in the new one.
      s.delete(SettingKeys.tunnelId, SettingKeys.tunnelName, SettingKeys.managedIngress);
    }
    s.set(SettingKeys.cloudflareToken, this.opts.box.encrypt(token));
    s.set(SettingKeys.cloudflareAccountId, account!.id);
    s.set(SettingKeys.cloudflareAccountName, account!.name);
    s.set(SettingKeys.cloudflarePermissions, permissions);
    this.cached = { token, client };
    this.opts.logger.info({ accountId: account!.id }, 'cloudflare token saved');
    return { saved: true, settings: this.getSettings() };
  }

  /** Forget the token and account. The tunnel id is kept so it can be reused later. */
  deleteToken(): void {
    this.opts.settings.delete(
      SettingKeys.cloudflareToken,
      SettingKeys.cloudflareAccountId,
      SettingKeys.cloudflareAccountName,
      SettingKeys.cloudflarePermissions,
    );
    this.cached = null;
  }

  /** List zones visible with the configured token. */
  async listZones(): Promise<CfZone[]> {
    const { client } = this.getContext();
    return client.listZones();
  }

  /**
   * Check that the token is active. Tries the user-token endpoint first, then
   * the account-token endpoint for each visible (or requested) account.
   */
  private async verify(
    client: CloudflareClient,
    requestedAccountId: string | undefined,
  ): Promise<{ accounts: CfAccount[]; accountsError: unknown }> {
    let verified = false;
    try {
      const v = await client.verifyUserToken();
      if (v.status !== 'active') {
        throw new AppError('CLOUDFLARE_TOKEN_INVALID', `The token is ${v.status}.`, 400, {
          permissions: [],
        });
      }
      verified = true;
    } catch (err) {
      if (err instanceof AppError && !(err instanceof CloudflareApiError)) throw err;
      if (
        err instanceof CloudflareApiError &&
        err.httpStatus !== 401 &&
        err.httpStatus !== 403 &&
        err.httpStatus !== 400
      ) {
        throw err; // network error or Cloudflare outage: do not claim the token is invalid
      }
      // Possibly an account-owned token: try the account endpoint below.
    }

    let accounts: CfAccount[] = [];
    let accountsError: unknown = null;
    try {
      accounts = await client.listAccounts();
    } catch (err) {
      accountsError = err;
    }

    if (!verified) {
      const candidates = requestedAccountId ? [requestedAccountId] : accounts.map((a) => a.id);
      for (const id of candidates) {
        try {
          const v = await client.verifyAccountToken(id);
          if (v.status === 'active') {
            verified = true;
            break;
          }
        } catch {
          // try the next account
        }
      }
    }
    if (!verified) {
      throw new AppError(
        'CLOUDFLARE_TOKEN_INVALID',
        'Cloudflare did not accept this token. Check that it is copied completely and still active.',
        400,
        { permissions: [] },
      );
    }
    return { accounts, accountsError };
  }

  private accountCheck(accounts: CfAccount[], accountsError: unknown): PermissionCheck {
    if (accountsError) {
      return { name: PERMISSION_NAMES.account, ok: false, message: errorMessage(accountsError) };
    }
    return accounts.length > 0
      ? {
          name: PERMISSION_NAMES.account,
          ok: true,
          message: `${accounts.length} account(s) visible`,
        }
      : {
          name: PERMISSION_NAMES.account,
          ok: false,
          message: 'No account visible with this token',
        };
  }

  /**
   * Probe each permission with a harmless read call. DNS write access cannot
   * be probed without writing, so it is confirmed when the first host is published.
   */
  private async checkPermissions(
    client: CloudflareClient,
    accountId: string,
    accounts: CfAccount[],
    accountsError: unknown,
  ): Promise<PermissionCheck[]> {
    const checks: PermissionCheck[] = [this.accountCheck(accounts, accountsError)];

    try {
      await client.listTunnels(accountId);
      checks.push({ name: PERMISSION_NAMES.tunnel, ok: true });
    } catch (err) {
      checks.push({ name: PERMISSION_NAMES.tunnel, ok: false, message: errorMessage(err) });
    }

    let zones: CfZone[] = [];
    try {
      zones = await client.listZones();
      checks.push(
        zones.length > 0
          ? { name: PERMISSION_NAMES.zone, ok: true, message: `${zones.length} zone(s) visible` }
          : { name: PERMISSION_NAMES.zone, ok: false, message: 'No zone visible with this token' },
      );
    } catch (err) {
      checks.push({ name: PERMISSION_NAMES.zone, ok: false, message: errorMessage(err) });
    }

    const firstZone = zones[0];
    if (!firstZone) {
      checks.push({
        name: PERMISSION_NAMES.dns,
        ok: false,
        message: 'No zone to check DNS access on',
      });
    } else {
      try {
        await client.requestEnvelope('GET', `/zones/${firstZone.id}/dns_records`, {
          query: { per_page: 5 },
        });
        checks.push({
          name: PERMISSION_NAMES.dns,
          ok: true,
          message:
            'Read access confirmed; write access is confirmed when the first host is published',
        });
      } catch (err) {
        checks.push({ name: PERMISSION_NAMES.dns, ok: false, message: errorMessage(err) });
      }
    }

    // Optional: only needed to protect hosts with Cloudflare Access.
    try {
      await client.requestEnvelope('GET', `/accounts/${accountId}/access/apps`, {
        query: { per_page: 1 },
      });
      checks.push({
        name: PERMISSION_NAMES.access,
        ok: true,
        optional: true,
        message: 'Private hosts can be protected with Cloudflare Access',
      });
    } catch (err) {
      checks.push({
        name: PERMISSION_NAMES.access,
        ok: false,
        optional: true,
        message: `Optional, needed only to protect hosts with Cloudflare Access: ${errorMessage(err)}`,
      });
    }
    return checks;
  }
}
