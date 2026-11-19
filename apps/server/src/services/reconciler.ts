import type { SyncAction, SyncResult } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { CloudflareApiError, type CloudflareClient } from '../cloudflare/client.js';
import type { CfIngressRule, CfTunnelConfiguration } from '../cloudflare/types.js';
import type { Db } from '../db/client.js';
import { proxyHosts, zones, type ProxyHostRow } from '../db/schema.js';
import { SettingKeys, type SettingsRepository } from '../db/settings.js';
import { AppError, errorMessage } from '../lib/errors.js';
import { Mutex } from '../lib/mutex.js';
import { nowIso } from '../lib/time.js';
import {
  desiredAccess,
  planAccess,
  type AccessAction,
  type AccessActual,
  type AccessHost,
} from './access-plan.js';
import { PERMISSION_NAMES, type CloudflareService } from './cloudflare.js';
import { keyOfRule } from './ingress.js';
import { plan, type ActualState, type PlanHost, type ZonedDnsRecord } from './plan.js';
import type { EnsuredTunnel, TunnelService } from './tunnel.js';

/** A hostname to look at in a targeted sync. */
export interface SyncScopeItem {
  zoneId: string;
  hostname: string;
}

/** Per-host outcome of a sync. */
export interface HostSyncResult {
  ok: boolean;
  error?: AppError;
  /** `access` when the failure comes from Cloudflare Access (the host was not published). */
  stage?: 'access';
}

export interface SyncOutcome {
  result: SyncResult;
  hosts: Map<number, HostSyncResult>;
}

export interface ReconcilerOptions {
  db: Db;
  settings: SettingsRepository;
  cloudflare: CloudflareService;
  tunnels: TunnelService;
  logger: Logger;
}

const EMPTY_RESULT: SyncResult = { startedAt: null, finishedAt: null, ok: true, actions: [] };

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError('CLOUDFLARE_API_ERROR', errorMessage(err), 502);
}

export function toAccessHost(row: ProxyHostRow): AccessHost {
  return {
    id: row.id,
    hostname: row.hostname,
    enabled: row.enabled,
    accessEnabled: row.accessEnabled,
    accessEmails: row.accessEmails,
    accessEmailDomains: row.accessEmailDomains,
    accessSessionDuration: row.accessSessionDuration,
  };
}

/** Explain Access failures in terms the user can act on. */
function toAccessError(err: unknown): AppError {
  const e = toAppError(err);
  if (e.code === 'CLOUDFLARE_PERMISSION_MISSING') {
    return new AppError(
      e.code,
      `The API token cannot manage Cloudflare Access. Add the "${PERMISSION_NAMES.access}" permission to protect hosts.`,
      400,
      e.details,
    );
  }
  if (err instanceof CloudflareApiError && err.httpStatus >= 400 && err.httpStatus < 500) {
    return new AppError(
      e.code,
      `${e.message}. If Zero Trust was never used on this account, open Zero Trust in the Cloudflare dashboard once to choose a team name.`,
      e.statusCode,
      e.details,
    );
  }
  return e;
}

/** Ignore "not found" on deletes: the resource is already gone. */
async function ignoreNotFound<T>(p: Promise<T>): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CloudflareApiError && err.isNotFound) return;
    throw err;
  }
}

/** Everything needed to plan and apply one tunnel. */
interface TunnelContext {
  ensured: EnsuredTunnel;
  configuration: CfTunnelConfiguration;
  hosts: PlanHost[];
  actual: ActualState;
}

/** What the Access step tells the rest of the run. */
interface AccessStep {
  /** Hostnames that must not be published this run (protection wanted but not in place). */
  blocked: Set<string>;
  /** Delete Access resources no longer wanted. Call only once routes and DNS are removed. */
  finish: () => Promise<void>;
}

export function toPlanHost(row: ProxyHostRow): PlanHost {
  return {
    id: row.id,
    zoneId: row.zoneId,
    hostname: row.hostname,
    path: row.path,
    service: row.service,
    noTlsVerify: row.noTlsVerify,
    httpHostHeader: row.httpHostHeader,
    originServerName: row.originServerName,
    originRequestExtra: row.originRequestExtra,
    enabled: row.enabled,
  };
}

/**
 * Makes Cloudflare match the proxy hosts stored in SQLite.
 *
 * Runs at startup, periodically, on `POST /api/sync` and after every host
 * change (scoped to the hostnames involved). All runs are serialised through
 * one mutex because the tunnel configuration is replaced as a whole.
 *
 * Events: `synced` (SyncResult) after every run.
 */
export class Reconciler extends EventEmitter<{ synced: [SyncResult] }> {
  private readonly mutex = new Mutex();
  private lastResult: SyncResult = EMPTY_RESULT;

  constructor(private readonly opts: ReconcilerOptions) {
    super();
  }

  /** Result of the last full or scoped run. */
  last(): SyncResult {
    return this.lastResult;
  }

  /**
   * Reconcile. Without `scope`, every host and every relevant zone is checked
   * (full run, including orphan cleanup). With `scope`, DNS is only checked
   * for those hostnames; the ingress document is always fully recomputed.
   * Throws `CLOUDFLARE_NOT_CONFIGURED` when there is no token.
   */
  sync(options: { scope?: SyncScopeItem[] } = {}): Promise<SyncOutcome> {
    if (!this.opts.cloudflare.isConfigured()) {
      return Promise.reject(
        new AppError('CLOUDFLARE_NOT_CONFIGURED', 'Cloudflare is not configured yet.', 400),
      );
    }
    return this.mutex.run(() => this.execute(options.scope));
  }

  private async execute(initialScope: SyncScopeItem[] | undefined): Promise<SyncOutcome> {
    const { db, logger } = this.opts;
    let scope = initialScope;
    const startedAt = nowIso();
    const actions: SyncAction[] = [];
    const hostResults = new Map<number, HostSyncResult>();
    const recordIds = new Map<string, string>();
    let rows: ProxyHostRow[] = db.select().from(proxyHosts).all();

    const fail = (id: number, error: AppError, stage?: 'access') => {
      if (!hostResults.get(id) || hostResults.get(id)!.ok)
        hostResults.set(id, { ok: false, error, stage });
    };
    const inScope = (row: ProxyHostRow) =>
      !scope || scope.some((s) => s.hostname.toLowerCase() === row.hostname.toLowerCase());

    try {
      const { client, accountId } = this.opts.cloudflare.getContext();
      const { ok: ensured, failed } = await this.opts.tunnels.ensureAll();
      for (const t of ensured.filter((x) => x.changed)) {
        actions.push({ kind: 'tunnel.create', target: t.row.name, ok: true, error: null });
        scope = undefined; // new tunnel: rewrite everything
      }
      rows = db.select().from(proxyHosts).all();
      const defaultId = ensured[0]!.row.id;
      const tunnelOf = (row: ProxyHostRow) => row.tunnelId ?? defaultId;

      for (const f of failed) {
        actions.push({
          kind: 'ingress.update',
          target: f.row.name,
          ok: false,
          error: f.error.message,
        });
        for (const row of rows)
          if (tunnelOf(row) === f.row.id && inScope(row)) fail(row.id, f.error);
      }

      const { records, unavailable } = await this.loadDns(client, rows, scope);
      const dnsScope = scope ? new Set(scope.map((s) => s.hostname.toLowerCase())) : undefined;

      const contexts: TunnelContext[] = [];
      for (const t of ensured) {
        const own = rows.filter((r) => tunnelOf(r) === t.row.id);
        try {
          const configuration = await client.getTunnelConfiguration(accountId, t.tunnel.id);
          contexts.push({
            ensured: t,
            configuration,
            hosts: own.map(toPlanHost),
            actual: {
              tunnelId: t.tunnel.id,
              ingress: configuration.config?.ingress ?? [],
              managedKeys: t.row.managedIngress,
              dnsRecords: records,
              unavailableZones: unavailable,
              dnsScope,
              otherHostnames: new Set(
                rows
                  .filter((r) => tunnelOf(r) !== t.row.id && r.enabled)
                  .map((r) => r.hostname.toLowerCase()),
              ),
            },
          });
        } catch (err) {
          const e = toAppError(err);
          actions.push({ kind: 'ingress.update', target: t.row.name, ok: false, error: e.message });
          for (const row of own) if (inScope(row)) fail(row.id, e);
        }
      }

      // Cloudflare Access comes first, so a protected hostname is never public,
      // not even for a moment. Hostnames with a DNS conflict are skipped: Burrow
      // will not publish them, so it must not put an Access app in front of them.
      const dnsConflicts = new Set(
        contexts.flatMap((c) =>
          plan(c.hosts, c.actual)
            .actions.filter((a) => a.kind === 'host.conflict')
            .map((a) => a.hostname.toLowerCase()),
        ),
      );
      const access = await this.syncAccess(client, accountId, rows, scope, dnsConflicts, {
        actions,
        fail,
      });

      let ingressFailed = false;
      for (const c of contexts) {
        const r = await this.applyTunnel(client, accountId, c, access.blocked, {
          actions,
          fail,
          recordIds,
          rows: rows.filter((row) => tunnelOf(row) === c.ensured.row.id && inScope(row)),
        });
        if (r.ingressFailed) ingressFailed = true;
      }

      // Remove protection only once the routes it guarded are gone: if a
      // tunnel configuration could not be written, keep it for the next run.
      if (!ingressFailed && failed.length === 0 && contexts.length === ensured.length) {
        await access.finish();
      }
    } catch (err) {
      const e = toAppError(err);
      logger.warn({ err: e.message }, 'reconciliation failed');
      actions.push({ kind: 'ingress.update', target: 'tunnel', ok: false, error: e.message });
      for (const row of rows) if (inScope(row)) fail(row.id, e);
    }

    this.persistHostStatuses(rows.filter(inScope), hostResults, recordIds);

    const result: SyncResult = {
      startedAt,
      finishedAt: nowIso(),
      ok: actions.every((a) => a.ok),
      actions,
    };
    this.lastResult = result;
    if (actions.length > 0) {
      logger.info(
        { ok: result.ok, actions: actions.length, scoped: Boolean(scope) },
        'reconciliation finished',
      );
    }
    this.emit('synced', result);
    return { result, hosts: hostResults };
  }

  /** Write one tunnel's planned ingress and DNS changes. */
  private async applyTunnel(
    client: CloudflareClient,
    accountId: string,
    c: TunnelContext,
    blocked: Set<string>,
    out: {
      actions: SyncAction[];
      fail: (id: number, error: AppError) => void;
      recordIds: Map<string, string>;
      /** This tunnel's hosts that are in scope. */
      rows: ProxyHostRow[];
    },
  ): Promise<{ ingressFailed: boolean }> {
    const { actions, fail, recordIds } = out;
    const { row: tunnelRow, tunnel } = c.ensured;
    const { configuration } = c;
    const tunnels = this.opts.tunnels;

    // Fail closed: a host whose protection could not be put in place is unpublished.
    const p = plan(
      c.hosts.map((h) => (blocked.has(h.hostname.toLowerCase()) ? { ...h, enabled: false } : h)),
      c.actual,
    );
    for (const [id, e] of p.hostErrors) {
      fail(id, new AppError(e.code, e.message, e.code === 'DNS_CONFLICT' ? 409 : 502));
    }

    let liveIngress = c.actual.ingress;
    let ingressFailed = false;
    const failedCreates = new Set<string>();

    for (const action of p.actions) {
      if (ingressFailed && action.kind !== 'host.conflict') break;
      switch (action.kind) {
        case 'ingress.update': {
          try {
            await client.putTunnelConfiguration(accountId, tunnel.id, {
              ...(configuration.config ?? {}),
              ingress: action.rules,
            });
            liveIngress = action.rules;
            tunnels.setManagedIngress(tunnelRow.id, p.managedKeys);
            actions.push({ kind: 'ingress.update', target: tunnel.name, ok: true, error: null });
          } catch (err) {
            const e = toAppError(err);
            ingressFailed = true;
            actions.push({
              kind: 'ingress.update',
              target: tunnel.name,
              ok: false,
              error: e.message,
            });
            for (const row of out.rows) fail(row.id, e);
          }
          break;
        }
        case 'host.conflict':
          actions.push({
            kind: 'host.conflict',
            target: action.hostname,
            ok: false,
            error: action.reason,
          });
          break;
        case 'dns.create':
        case 'dns.update': {
          try {
            const record =
              action.kind === 'dns.create'
                ? await client.createDnsRecord(action.zoneId, action.record)
                : await client.updateDnsRecord(action.zoneId, action.recordId, action.record);
            recordIds.set(action.hostname, record.id);
            actions.push({ kind: action.kind, target: action.hostname, ok: true, error: null });
          } catch (err) {
            const e = toAppError(err);
            actions.push({
              kind: action.kind,
              target: action.hostname,
              ok: false,
              error: e.message,
            });
            for (const id of action.hostIds) fail(id, e);
            if (action.kind === 'dns.create') failedCreates.add(action.hostname);
          }
          break;
        }
        case 'dns.delete': {
          try {
            await client.deleteDnsRecord(action.zoneId, action.recordId);
            actions.push({ kind: 'dns.delete', target: action.hostname, ok: true, error: null });
          } catch (err) {
            const e = toAppError(err);
            actions.push({
              kind: 'dns.delete',
              target: action.hostname,
              ok: false,
              error: e.message,
            });
            for (const id of action.hostIds) fail(id, e);
          }
          break;
        }
      }
    }

    if (!ingressFailed && !p.actions.some((a) => a.kind === 'ingress.update')) {
      tunnels.setManagedIngress(tunnelRow.id, p.managedKeys);
    }

    // Compensate: a hostname whose CNAME could not be created must not stay in the ingress.
    if (failedCreates.size > 0 && !ingressFailed) {
      const drop = (r: CfIngressRule) =>
        !!r.hostname &&
        failedCreates.has(r.hostname.toLowerCase()) &&
        p.managedKeys.includes(keyOfRule(r));
      const compensated = liveIngress.filter((r) => !drop(r));
      if (compensated.length !== liveIngress.length) {
        try {
          await client.putTunnelConfiguration(accountId, tunnel.id, {
            ...(configuration.config ?? {}),
            ingress: compensated,
          });
          tunnels.setManagedIngress(
            tunnelRow.id,
            p.managedKeys.filter((k) => !failedCreates.has(k.split('|')[0]!)),
          );
          actions.push({
            kind: 'ingress.update',
            target: `${tunnel.name} (rollback)`,
            ok: true,
            error: null,
          });
        } catch (err) {
          actions.push({
            kind: 'ingress.update',
            target: `${tunnel.name} (rollback)`,
            ok: false,
            error: toAppError(err).message,
          });
        }
      }
    }

    for (const [hostname, id] of p.dnsRecordIds)
      if (!recordIds.has(hostname)) recordIds.set(hostname, id);
    return { ingressFailed };
  }

  /**
   * Create or update the Access applications of protected hosts, and prepare
   * the deletion of the ones no longer wanted. Nothing is listed or written
   * when no host is protected and Burrow manages no Access application, so
   * the Access permission stays optional.
   */
  private async syncAccess(
    client: CloudflareClient,
    accountId: string,
    rows: ProxyHostRow[],
    scope: SyncScopeItem[] | undefined,
    skip: Set<string>,
    out: {
      actions: SyncAction[];
      fail: (id: number, error: AppError, stage?: 'access') => void;
    },
  ): Promise<AccessStep> {
    const { settings } = this.opts;
    const { actions, fail } = out;
    const managed = new Set(settings.get<string[]>(SettingKeys.managedAccess) ?? []);
    const scopeSet = scope ? new Set(scope.map((s) => s.hostname.toLowerCase())) : undefined;
    const inScope = (h: string) => !scopeSet || scopeSet.has(h);
    const wanted = desiredAccess(rows.map(toAccessHost));
    for (const h of skip) wanted.delete(h);

    const blocked = new Set<string>();
    const noop: AccessStep = { blocked, finish: async () => undefined };
    if (![...wanted.keys(), ...managed].some(inScope)) return noop;

    let actual: AccessActual;
    try {
      const [apps, policies] = await Promise.all([
        client.listAccessApps(accountId),
        client.listAccessPolicies(accountId),
      ]);
      actual = { apps, policies };
    } catch (err) {
      const e = toAccessError(err);
      actions.push({
        kind: 'access.update',
        target: 'Cloudflare Access',
        ok: false,
        error: e.message,
      });
      for (const [hostname, d] of wanted) {
        if (!inScope(hostname)) continue;
        for (const id of d.hostIds) fail(id, e, 'access');
        // Protection never confirmed: do not publish. Already protected: keep as is.
        if (!managed.has(hostname)) blocked.add(hostname);
      }
      return noop;
    }

    const ap = planAccess(wanted, actual, { managed, scope: scopeSet });
    for (const hostname of ap.conflicts.keys()) blocked.add(hostname);
    const saveManaged = () => settings.set(SettingKeys.managedAccess, [...managed].sort());

    for (const action of ap.ensure) {
      if (action.kind === 'access.conflict') {
        actions.push({
          kind: action.kind,
          target: action.hostname,
          ok: false,
          error: action.reason,
        });
        const e = new AppError('ACCESS_CONFLICT', action.reason, 409);
        for (const id of action.hostIds) fail(id, e, 'access');
        continue;
      }
      if (action.kind !== 'access.create' && action.kind !== 'access.update') continue;
      try {
        await this.applyAccess(client, accountId, action);
        managed.add(action.hostname);
        actions.push({ kind: action.kind, target: action.hostname, ok: true, error: null });
      } catch (err) {
        const e = toAccessError(err);
        actions.push({ kind: action.kind, target: action.hostname, ok: false, error: e.message });
        for (const id of action.hostIds) fail(id, e, 'access');
        // A failed update leaves the previous policy in place; a failed create leaves none.
        if (action.kind === 'access.create') blocked.add(action.hostname);
      }
    }
    saveManaged();

    return {
      blocked,
      finish: async () => {
        for (const action of ap.remove) {
          if (action.kind !== 'access.delete') continue;
          try {
            if (action.appId) await ignoreNotFound(client.deleteAccessApp(accountId, action.appId));
            for (const id of action.policyIds) {
              await ignoreNotFound(client.deleteAccessPolicy(accountId, id));
            }
            if (!wanted.has(action.hostname)) managed.delete(action.hostname);
            actions.push({ kind: 'access.delete', target: action.hostname, ok: true, error: null });
          } catch (err) {
            actions.push({
              kind: 'access.delete',
              target: action.hostname,
              ok: false,
              error: toAccessError(err).message,
            });
          }
        }
        saveManaged();
      },
    };
  }

  /** Execute one create/update: the policy first, then the application linked to it. */
  private async applyAccess(
    client: CloudflareClient,
    accountId: string,
    action: Extract<AccessAction, { kind: 'access.create' | 'access.update' }>,
  ): Promise<void> {
    const existing = action.kind === 'access.create' ? action.existingPolicyId : action.policyId;
    let policyId = existing;
    if (policyId) {
      if (action.policyChanged) await client.updateAccessPolicy(accountId, policyId, action.policy);
    } else {
      policyId = (await client.createAccessPolicy(accountId, action.policy)).id;
    }
    const body = { ...action.app, policies: [{ id: policyId, precedence: 1 }] };
    try {
      if (action.kind === 'access.create') await client.createAccessApp(accountId, body);
      else if (action.appChanged || !existing) {
        await client.updateAccessApp(accountId, action.appId, body);
      }
    } catch (err) {
      if (!existing) await client.deleteAccessPolicy(accountId, policyId).catch(() => undefined);
      throw err;
    }
  }

  /** Write each host's sync status back to SQLite. */
  private persistHostStatuses(
    rows: ProxyHostRow[],
    results: Map<number, HostSyncResult>,
    recordIds: Map<string, string>,
  ): void {
    const now = nowIso();
    for (const row of rows) {
      const r = results.get(row.id);
      if (r && !r.ok) {
        this.opts.db
          .update(proxyHosts)
          .set({ syncStatus: 'error', syncError: r.error?.message ?? 'Unknown error' })
          .where(eq(proxyHosts.id, row.id))
          .run();
        continue;
      }
      results.set(row.id, { ok: true });
      this.opts.db
        .update(proxyHosts)
        .set({
          syncStatus: 'synced',
          syncError: null,
          lastSyncedAt: now,
          dnsRecordId: row.enabled
            ? (recordIds.get(row.hostname.toLowerCase()) ?? row.dnsRecordId)
            : null,
        })
        .where(eq(proxyHosts.id, row.id))
        .run();
    }
  }

  /**
   * Load the DNS records the planner needs. Full run: every record of every
   * zone that has hosts or is enabled. Scoped run: only the given hostnames.
   */
  private async loadDns(
    client: CloudflareClient,
    rows: ProxyHostRow[],
    scope: SyncScopeItem[] | undefined,
  ): Promise<{ records: ZonedDnsRecord[]; unavailable: Map<string, string> }> {
    const records: ZonedDnsRecord[] = [];
    const unavailable = new Map<string, string>();

    if (scope) {
      const seen = new Set<string>();
      for (const item of scope) {
        const key = `${item.zoneId}|${item.hostname.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const found = await client.listDnsRecords(item.zoneId, { 'name.exact': item.hostname });
          records.push(...found.map((r) => ({ ...r, zoneId: item.zoneId })));
        } catch (err) {
          unavailable.set(item.zoneId, `Could not read DNS records: ${errorMessage(err)}`);
        }
      }
      return { records, unavailable };
    }

    const zoneIds = new Set<string>(rows.map((r) => r.zoneId));
    for (const z of this.opts.db.select().from(zones).where(eq(zones.enabled, true)).all())
      zoneIds.add(z.id);
    for (const zoneId of zoneIds) {
      try {
        const found = await client.listDnsRecords(zoneId);
        records.push(...found.map((r) => ({ ...r, zoneId })));
      } catch (err) {
        unavailable.set(zoneId, `Could not read DNS records: ${errorMessage(err)}`);
      }
    }
    return { records, unavailable };
  }
}
