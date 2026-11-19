import type {
  AvailableTunnel,
  Connector,
  CreateTunnelInput,
  TunnelInfo,
  TunnelStatus,
  UpdateTunnelInput,
} from '@burrow/shared';
import { asc, desc, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { CloudflareApiError } from '../cloudflare/client.js';
import type { CfTunnel } from '../cloudflare/types.js';
import type { Db } from '../db/client.js';
import { proxyHosts, tunnels, type TunnelRow } from '../db/schema.js';
import { SettingKeys, type SettingsRepository } from '../db/settings.js';
import { AppError, errorMessage, errors } from '../lib/errors.js';
import type { CloudflareService } from './cloudflare.js';

/** A tunnel row checked against Cloudflare. */
export interface EnsuredTunnel {
  row: TunnelRow;
  tunnel: CfTunnel;
  /** True when the Cloudflare tunnel is new (created, adopted or recreated). */
  changed: boolean;
}

export interface TunnelFailure {
  row: TunnelRow;
  error: AppError;
}

export interface TunnelServiceOptions {
  db: Db;
  settings: SettingsRepository;
  cloudflare: CloudflareService;
  logger: Logger;
}

/**
 * The tunnels Burrow manages, and their run tokens.
 *
 * One tunnel is the *default*: Burrow creates it at setup (`burrow-<6 hex>`,
 * remotely managed) and new hosts go there unless another tunnel is chosen.
 * More tunnels can be created, or existing remotely managed tunnels of the
 * account imported.
 *
 * A tunnel Burrow created is recreated if someone deletes it on Cloudflare;
 * an imported tunnel is not (its hosts report an error instead).
 *
 * Events: `changed` (row) when a tunnel's Cloudflare id changed (new, adopted
 * or recreated tunnel: a running cloudflared needs the new token), `listChanged`
 * when tunnels are added, removed or their settings change.
 */
export class TunnelService extends EventEmitter<{ changed: [TunnelRow]; listChanged: [] }> {
  private inflight: Promise<EnsuredTunnel> | null = null;

  constructor(private readonly opts: TunnelServiceOptions) {
    super();
  }

  /* ------------------------------ local rows ------------------------------ */

  /** Every tunnel, default first, then by name. */
  list(): TunnelRow[] {
    return this.opts.db
      .select()
      .from(tunnels)
      .orderBy(desc(tunnels.isDefault), asc(tunnels.name))
      .all();
  }

  find(id: number): TunnelRow | undefined {
    return this.opts.db.select().from(tunnels).where(eq(tunnels.id, id)).get();
  }

  get(id: number): TunnelRow {
    const row = this.find(id);
    if (!row) throw errors.notFound('Tunnel');
    return row;
  }

  getDefault(): TunnelRow | undefined {
    return this.opts.db.select().from(tunnels).where(eq(tunnels.isDefault, true)).get();
  }

  /** Cloudflare id and name of the default tunnel, without calling the API. */
  stored(): { id: string; name: string } | null {
    const row = this.getDefault();
    return row ? { id: row.cfId, name: row.name } : null;
  }

  setManagedIngress(id: number, keys: string[]): void {
    this.opts.db.update(tunnels).set({ managedIngress: keys }).where(eq(tunnels.id, id)).run();
  }

  /** Hosts without a tunnel (new installs, or after a tunnel was forgotten) go to the default one. */
  private assignOrphanHosts(defaultId: number): void {
    this.opts.db
      .update(proxyHosts)
      .set({ tunnelId: defaultId })
      .where(isNull(proxyHosts.tunnelId))
      .run();
  }

  /* --------------------------- Cloudflare side ---------------------------- */

  /**
   * Make sure the default tunnel exists: find the stored one, or create
   * `burrow-<6 hex>` with `config_src: cloudflare`. Recreates it if it was
   * deleted on Cloudflare. Concurrent callers share the same in-flight call.
   */
  ensureDefault(): Promise<EnsuredTunnel> {
    this.inflight ??= this.doEnsureDefault().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doEnsureDefault(): Promise<EnsuredTunnel> {
    const current = this.getDefault();
    if (current) {
      const ensured = await this.ensureOne(current);
      this.assignOrphanHosts(ensured.row.id);
      return ensured;
    }
    const { client, accountId } = this.opts.cloudflare.getContext();
    const name =
      this.opts.settings.get<string>(SettingKeys.tunnelName) ??
      `burrow-${randomBytes(3).toString('hex')}`;
    this.opts.settings.set(SettingKeys.tunnelName, name);
    const existing = (await client.listTunnels(accountId, { name })).find(
      (t) => t.name === name && !t.deleted_at,
    );
    const tunnel = existing ?? (await client.createTunnel(accountId, name));
    const known = this.opts.db.select().from(tunnels).where(eq(tunnels.cfId, tunnel.id)).get();
    const row = known
      ? this.opts.db
          .update(tunnels)
          .set({ isDefault: true })
          .where(eq(tunnels.id, known.id))
          .returning()
          .get()
      : this.opts.db
          .insert(tunnels)
          .values({ cfId: tunnel.id, name: tunnel.name, origin: 'created', isDefault: true })
          .returning()
          .get();
    this.opts.settings.delete(SettingKeys.tunnelName);
    this.assignOrphanHosts(row.id);
    this.opts.logger.info(
      { tunnelId: tunnel.id, name: tunnel.name },
      existing ? 'tunnel adopted' : 'tunnel created',
    );
    this.emit('changed', row);
    this.emit('listChanged');
    return { row, tunnel, changed: true };
  }

  /**
   * Check one tunnel on Cloudflare. A tunnel Burrow created is recreated
   * (same name) if it was deleted; an imported one fails instead.
   */
  async ensureOne(row: TunnelRow): Promise<EnsuredTunnel> {
    const { client, accountId } = this.opts.cloudflare.getContext();
    try {
      const tunnel = await client.getTunnel(accountId, row.cfId);
      if (!tunnel.deleted_at) return { row, tunnel, changed: false };
    } catch (err) {
      if (!(err instanceof CloudflareApiError && err.isNotFound)) throw err;
    }
    if (row.origin === 'imported') {
      throw new AppError(
        'CLOUDFLARE_API_ERROR',
        `The tunnel "${row.name}" no longer exists on Cloudflare. Move its hosts to another tunnel, then remove it from Burrow.`,
        502,
      );
    }
    this.opts.logger.warn(
      { tunnelId: row.cfId, name: row.name },
      'tunnel no longer exists on Cloudflare, creating a new one',
    );
    const existing = (await client.listTunnels(accountId, { name: row.name })).find(
      (t) => t.name === row.name && !t.deleted_at,
    );
    const tunnel = existing ?? (await client.createTunnel(accountId, row.name));
    const updated = this.opts.db
      .update(tunnels)
      .set({ cfId: tunnel.id, managedIngress: [] })
      .where(eq(tunnels.id, row.id))
      .returning()
      .get();
    this.emit('changed', updated);
    return { row: updated, tunnel, changed: true };
  }

  /**
   * Ensure the default tunnel (throws if that fails), then check every other
   * tunnel. Failures of other tunnels are returned, not thrown.
   */
  async ensureAll(): Promise<{ ok: EnsuredTunnel[]; failed: TunnelFailure[] }> {
    const first = await this.ensureDefault();
    const ok: EnsuredTunnel[] = [first];
    const failed: TunnelFailure[] = [];
    for (const row of this.list()) {
      if (row.id === first.row.id) continue;
      try {
        ok.push(await this.ensureOne(row));
      } catch (err) {
        failed.push({
          row,
          error:
            err instanceof AppError
              ? err
              : new AppError('CLOUDFLARE_API_ERROR', errorMessage(err), 502),
        });
      }
    }
    return { ok, failed };
  }

  /** The run token for cloudflared. Never stored. */
  async getRunToken(id: number): Promise<string> {
    const row = this.get(id);
    const { row: current } = row.isDefault ? await this.ensureDefault() : await this.ensureOne(row);
    const { client, accountId } = this.opts.cloudflare.getContext();
    return client.getTunnelToken(accountId, current.cfId);
  }

  /** Create a new remotely managed tunnel. */
  async create(input: Required<CreateTunnelInput>): Promise<TunnelRow> {
    const { client, accountId } = this.opts.cloudflare.getContext();
    await this.ensureDefault();
    const existing = (await client.listTunnels(accountId, { name: input.name })).find(
      (t) => t.name === input.name && !t.deleted_at,
    );
    if (existing) {
      throw errors.conflict(
        `A tunnel named "${input.name}" already exists in this account. Import it instead, or pick another name.`,
      );
    }
    const tunnel = await client.createTunnel(accountId, input.name);
    const row = this.opts.db
      .insert(tunnels)
      .values({
        cfId: tunnel.id,
        name: tunnel.name,
        origin: 'created',
        runConnector: input.runConnector,
      })
      .returning()
      .get();
    this.opts.logger.info({ tunnelId: tunnel.id, name: tunnel.name }, 'tunnel created');
    this.emit('listChanged');
    return row;
  }

  /**
   * Start managing an existing tunnel of the account. Only remotely managed
   * tunnels can be imported: a locally managed one keeps its routes in a
   * config file on the connector, which the API cannot change.
   */
  async import(cfId: string, runConnector: boolean): Promise<{ row: TunnelRow; tunnel: CfTunnel }> {
    const { client, accountId } = this.opts.cloudflare.getContext();
    if (this.opts.db.select().from(tunnels).where(eq(tunnels.cfId, cfId)).get()) {
      throw errors.conflict('This tunnel is already managed by Burrow.');
    }
    let tunnel: CfTunnel;
    try {
      tunnel = await client.getTunnel(accountId, cfId);
    } catch (err) {
      if (err instanceof CloudflareApiError && err.isNotFound) throw errors.notFound('Tunnel');
      throw err;
    }
    if (tunnel.deleted_at) throw errors.notFound('Tunnel');
    if (tunnel.config_src && tunnel.config_src !== 'cloudflare') {
      throw errors.validation(
        `"${tunnel.name}" is a locally managed tunnel (its routes live in a config file on the connector). Migrate it to a remotely managed tunnel in the Cloudflare dashboard, then import it.`,
      );
    }
    await this.ensureDefault();
    const row = this.opts.db
      .insert(tunnels)
      .values({ cfId: tunnel.id, name: tunnel.name, origin: 'imported', runConnector })
      .returning()
      .get();
    this.opts.logger.info({ tunnelId: tunnel.id, name: tunnel.name }, 'tunnel imported');
    this.emit('listChanged');
    return { row, tunnel };
  }

  /** Tunnels of the account that Burrow does not manage yet. */
  async listAvailable(): Promise<AvailableTunnel[]> {
    const { client, accountId } = this.opts.cloudflare.getContext();
    const known = new Set(this.list().map((r) => r.cfId));
    const all = (await client.listTunnels(accountId)).filter(
      (t) => !t.deleted_at && !known.has(t.id),
    );
    return Promise.all(
      all.map(async (t): Promise<AvailableTunnel> => {
        const configSrc = t.config_src === 'local' ? 'local' : 'cloudflare';
        let routeCount: number | null = null;
        if (configSrc === 'cloudflare') {
          try {
            const cfg = await client.getTunnelConfiguration(accountId, t.id);
            routeCount = (cfg.config?.ingress ?? []).filter((r) => r.hostname).length;
          } catch {
            routeCount = null;
          }
        }
        return {
          cfId: t.id,
          name: t.name,
          status: toTunnelStatus(t.status),
          createdAt: t.created_at,
          configSrc,
          routeCount,
        };
      }),
    );
  }

  /** Change local settings of a tunnel. */
  update(id: number, input: UpdateTunnelInput): TunnelRow {
    const row = this.get(id);
    if (input.isDefault && !row.isDefault) {
      this.opts.db.transaction((tx) => {
        tx.update(tunnels).set({ isDefault: false }).where(eq(tunnels.isDefault, true)).run();
        tx.update(tunnels).set({ isDefault: true }).where(eq(tunnels.id, id)).run();
      });
    }
    if (input.runConnector !== undefined) {
      this.opts.db
        .update(tunnels)
        .set({ runConnector: input.runConnector })
        .where(eq(tunnels.id, id))
        .run();
    }
    this.emit('listChanged');
    return this.get(id);
  }

  /** Delete a tunnel on Cloudflare (stop its connector first). Missing tunnels are ignored. */
  async deleteOnCloudflare(row: TunnelRow): Promise<void> {
    const { client, accountId } = this.opts.cloudflare.getContext();
    try {
      await client.cleanupTunnelConnections(accountId, row.cfId);
    } catch (err) {
      if (!(err instanceof CloudflareApiError && err.isNotFound)) throw err;
    }
    try {
      await client.deleteTunnel(accountId, row.cfId);
    } catch (err) {
      if (!(err instanceof CloudflareApiError && err.isNotFound)) throw err;
    }
  }

  /** Forget a tunnel locally. Its hosts (if any) fall back to the default tunnel. */
  forget(id: number): void {
    this.opts.db.delete(tunnels).where(eq(tunnels.id, id)).run();
    this.emit('listChanged');
  }

  /** Forget every tunnel (the account changed). Hosts are kept and move to the next default tunnel. */
  forgetAll(): void {
    this.opts.db.delete(tunnels).run();
    this.opts.settings.delete(SettingKeys.tunnelName);
    this.emit('listChanged');
  }

  /** Live status of every tunnel of the account, by Cloudflare id. Empty when unreachable. */
  async statuses(): Promise<Map<string, TunnelStatus>> {
    if (!this.opts.cloudflare.isConfigured()) return new Map();
    try {
      const { client, accountId } = this.opts.cloudflare.getContext();
      const list = await client.listTunnels(accountId);
      return new Map(list.map((t) => [t.id, toTunnelStatus(t.status)]));
    } catch (err) {
      this.opts.logger.warn({ err: errorMessage(err) }, 'could not list tunnels');
      return new Map();
    }
  }

  /** Tunnel details and connectors (without the supervisor part). Default tunnel when `id` is omitted. */
  async info(id?: number): Promise<Omit<TunnelInfo, 'supervisor'>> {
    const row = id === undefined ? this.getDefault() : this.get(id);
    if (!row || !this.opts.cloudflare.isConfigured()) return { tunnel: null, connectors: [] };
    const { client, accountId } = this.opts.cloudflare.getContext();
    try {
      const [tunnel, connectors] = await Promise.all([
        client.getTunnel(accountId, row.cfId),
        client.listTunnelConnections(accountId, row.cfId),
      ]);
      return {
        tunnel: {
          id: tunnel.id,
          name: tunnel.name,
          status: toTunnelStatus(tunnel.status),
          createdAt: tunnel.created_at,
        },
        connectors: connectors.map((c): Connector => ({
          id: c.id,
          version: c.version,
          arch: c.arch,
          runAt: c.run_at ?? null,
          connections: (c.conns ?? []).map((conn) => ({
            colo: conn.colo_name,
            openedAt: conn.opened_at,
            originIp: conn.origin_ip,
          })),
        })),
      };
    } catch (err) {
      this.opts.logger.warn({ err: errorMessage(err) }, 'could not fetch tunnel details');
      return {
        tunnel: { id: row.cfId, name: row.name, status: 'unknown', createdAt: '' },
        connectors: [],
      };
    }
  }
}

export function toTunnelStatus(status: string): TunnelStatus {
  return (['inactive', 'degraded', 'healthy', 'down'] as const).includes(status as never)
    ? (status as TunnelStatus)
    : 'unknown';
}
