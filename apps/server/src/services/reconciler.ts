import type { SyncAction, SyncResult } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { CloudflareClient } from '../cloudflare/client.js';
import type { CfIngressRule } from '../cloudflare/types.js';
import type { Db } from '../db/client.js';
import { proxyHosts, zones, type ProxyHostRow } from '../db/schema.js';
import { SettingKeys, type SettingsRepository } from '../db/settings.js';
import { AppError, errorMessage } from '../lib/errors.js';
import { Mutex } from '../lib/mutex.js';
import { nowIso } from '../lib/time.js';
import type { CloudflareService } from './cloudflare.js';
import { keyOfRule } from './ingress.js';
import { plan, type PlanHost, type ZonedDnsRecord } from './plan.js';
import type { TunnelService } from './tunnel.js';

/** A hostname to look at in a targeted sync. */
export interface SyncScopeItem {
  zoneId: string;
  hostname: string;
}

/** Per-host outcome of a sync. */
export interface HostSyncResult {
  ok: boolean;
  error?: AppError;
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
    const { db, settings, logger } = this.opts;
    let scope = initialScope;
    const startedAt = nowIso();
    const actions: SyncAction[] = [];
    const hostResults = new Map<number, HostSyncResult>();
    const recordIds = new Map<string, string>();
    let rows: ProxyHostRow[] = db.select().from(proxyHosts).all();

    const fail = (id: number, error: AppError) => {
      if (!hostResults.get(id) || hostResults.get(id)!.ok)
        hostResults.set(id, { ok: false, error });
    };
    const inScope = (row: ProxyHostRow) =>
      !scope || scope.some((s) => s.hostname.toLowerCase() === row.hostname.toLowerCase());

    try {
      const { client, accountId } = this.opts.cloudflare.getContext();
      const { tunnel, changed } = await this.opts.tunnels.ensureTunnel();
      if (changed) {
        actions.push({ kind: 'tunnel.create', target: tunnel.name, ok: true, error: null });
        scope = undefined; // new tunnel: rewrite everything
      }
      rows = db.select().from(proxyHosts).all();

      const configuration = await client.getTunnelConfiguration(accountId, tunnel.id);
      const currentIngress: CfIngressRule[] = configuration.config?.ingress ?? [];
      const managedKeys = settings.get<string[]>(SettingKeys.managedIngress) ?? [];
      const { records, unavailable } = await this.loadDns(client, rows, scope);

      const p = plan(rows.map(toPlanHost), {
        tunnelId: tunnel.id,
        ingress: currentIngress,
        managedKeys,
        dnsRecords: records,
        unavailableZones: unavailable,
        dnsScope: scope ? new Set(scope.map((s) => s.hostname.toLowerCase())) : undefined,
      });
      for (const [id, e] of p.hostErrors) {
        fail(id, new AppError(e.code, e.message, e.code === 'DNS_CONFLICT' ? 409 : 502));
      }

      let liveIngress = currentIngress;
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
              settings.set(SettingKeys.managedIngress, p.managedKeys);
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
              for (const row of rows) if (inScope(row)) fail(row.id, e);
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
        settings.set(SettingKeys.managedIngress, p.managedKeys);
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
            settings.set(
              SettingKeys.managedIngress,
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
