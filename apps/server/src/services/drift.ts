import { serviceUrlSchema, type DriftItem, type DriftReport } from '@burrow/shared';
import { eq, inArray } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { CfIngressRule } from '../cloudflare/types.js';
import type { Db } from '../db/client.js';
import { proxyHosts, type ProxyHostRow } from '../db/schema.js';
import { SettingKeys, type SettingsRepository } from '../db/settings.js';
import { errorMessage } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import { ingressEqual, isCatchAll, keyOfRule } from './ingress.js';
import type { Inspection, Reconciler } from './reconciler.js';

export interface DriftServiceOptions {
  db: Db;
  settings: SettingsRepository;
  reconciler: Reconciler;
  logger: Logger;
  /** Seconds between scheduled checks (0: none), shown in the UI. */
  intervalSeconds: number;
}

/** A difference, plus what "keep the Cloudflare version" would do for it. */
interface Finding extends DriftItem {
  /** For a changed route: the live rule to copy into the host. */
  liveRule?: CfIngressRule;
}

/**
 * Drift detection: someone changed, in the Cloudflare dashboard, a route, a
 * DNS record or an Access application that Burrow manages.
 *
 * Every check (startup, every `RECONCILE_INTERVAL_SECONDS`, or on demand)
 * compares Cloudflare with Burrow **without writing anything** and lists the
 * differences. The affected hosts get the `drift` sync status and the UI
 * shows an alert. The user then chooses, for the whole list:
 *
 * - **revert**: make Cloudflare match Burrow again (a full sync);
 * - **keep**: Cloudflare is the source of truth for what exists there. Burrow
 *   copies a changed route into the host, and disables a host whose route or
 *   CNAME was deleted (or replaced by someone else's record). Differences that
 *   cannot be kept (e.g. a removed Access application: Burrow never lowers
 *   protection silently) are reverted.
 *
 * With `autoRepair` on, every check reverts the differences right away (the
 * v0.1 behaviour). Event `detected` (report) fires when new differences appear:
 * the hook for notifications.
 */
export class DriftService extends EventEmitter<{ detected: [DriftReport] }> {
  private report: Omit<DriftReport, 'autoRepair' | 'intervalSeconds'> = {
    checkedAt: null,
    items: [],
    error: null,
  };
  private findings: Finding[] = [];
  private signature = '';

  constructor(private readonly opts: DriftServiceOptions) {
    super();
  }

  autoRepair(): boolean {
    return this.opts.settings.get<boolean>(SettingKeys.driftAutoRepair) ?? false;
  }

  setAutoRepair(value: boolean): DriftReport {
    this.opts.settings.set(SettingKeys.driftAutoRepair, value);
    return this.last();
  }

  last(): DriftReport {
    return {
      ...this.report,
      autoRepair: this.autoRepair(),
      intervalSeconds: this.opts.intervalSeconds,
    };
  }

  /** Scheduled run: repair when `autoRepair` is on, otherwise only detect. */
  async scheduled(): Promise<DriftReport> {
    if (this.autoRepair()) {
      try {
        await this.opts.reconciler.sync();
      } catch (err) {
        this.opts.logger.warn({ err: errorMessage(err) }, 'automatic repair failed');
      }
    }
    return this.check();
  }

  /** Compare Cloudflare with Burrow now. Never throws: failures go in `error`. */
  async check(): Promise<DriftReport> {
    let inspection: Inspection;
    try {
      inspection = await this.opts.reconciler.inspect();
    } catch (err) {
      this.report = { checkedAt: nowIso(), items: this.report.items, error: errorMessage(err) };
      return this.last();
    }
    const rows = this.opts.db.select().from(proxyHosts).all();
    this.findings = findDrift(inspection, rows);
    const items = this.findings.map(({ liveRule: _rule, ...item }) => item);
    this.report = {
      checkedAt: nowIso(),
      items,
      error: inspection.failures.length > 0 ? inspection.failures.join('; ') : null,
    };
    this.markHosts(items);

    const signature = JSON.stringify(items.map((i) => [i.kind, i.target, i.detail]));
    if (items.length > 0 && signature !== this.signature) {
      this.opts.logger.warn({ differences: items.length }, 'Cloudflare differs from Burrow');
      this.emit('detected', this.last());
    }
    this.signature = signature;
    return this.last();
  }

  /** Apply the user's choice for the current differences, then check again. */
  async resolve(strategy: 'revert' | 'keep'): Promise<DriftReport> {
    if (strategy === 'keep') {
      await this.check(); // decide on fresh data
      this.keep(this.findings);
    }
    await this.opts.reconciler.sync();
    return this.check();
  }

  /** Copy what Cloudflare has into the hosts, where that makes sense. */
  private keep(findings: Finding[]): void {
    const { db } = this.opts;
    const toDisable = new Set<number>();
    for (const f of findings) {
      if (!f.keepable) continue;
      if (f.kind === 'ingress.changed' && f.liveRule) {
        const r = f.liveRule;
        const { noTLSVerify, httpHostHeader, originServerName, ...extra } = r.originRequest ?? {};
        db.update(proxyHosts)
          .set({
            service: r.service,
            noTlsVerify: noTLSVerify === true,
            httpHostHeader: typeof httpHostHeader === 'string' ? httpHostHeader : '',
            originServerName: typeof originServerName === 'string' ? originServerName : '',
            originRequestExtra: extra,
            updatedAt: nowIso(),
          })
          .where(inArray(proxyHosts.id, f.hostIds))
          .run();
      } else {
        for (const id of f.hostIds) toDisable.add(id);
      }
    }
    if (toDisable.size > 0) {
      db.update(proxyHosts)
        .set({ enabled: false, updatedAt: nowIso() })
        .where(inArray(proxyHosts.id, [...toDisable]))
        .run();
    }
    this.opts.logger.info(
      { kept: findings.filter((f) => f.keepable).length },
      'kept the Cloudflare version of drifted resources',
    );
  }

  /** `drift` status on affected hosts; back to `synced` for hosts no longer affected. */
  private markHosts(items: DriftItem[]): void {
    const { db } = this.opts;
    const affected = new Map<number, string>();
    for (const item of items) {
      for (const id of item.hostIds) if (!affected.has(id)) affected.set(id, item.detail);
    }
    for (const row of db.select().from(proxyHosts).all()) {
      const detail = affected.get(row.id);
      if (detail !== undefined && (row.syncStatus === 'synced' || row.syncStatus === 'drift')) {
        db.update(proxyHosts)
          .set({ syncStatus: 'drift', syncError: detail })
          .where(eq(proxyHosts.id, row.id))
          .run();
      } else if (detail === undefined && row.syncStatus === 'drift') {
        db.update(proxyHosts)
          .set({ syncStatus: 'synced', syncError: null })
          .where(eq(proxyHosts.id, row.id))
          .run();
      }
    }
  }
}

/** Describe an ingress rule's settings for humans. */
function describeRule(rule: CfIngressRule): string {
  const opts = Object.entries(rule.originRequest ?? {})
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  return opts ? `${rule.service} (${opts})` : rule.service;
}

/** Turn an inspection into a list of differences. Pure: unit tested. */
export function findDrift(inspection: Inspection, rows: ProxyHostRow[]): Finding[] {
  const findings: Finding[] = [];
  const hostsByKey = (key: string) =>
    rows.filter((r) => `${r.hostname.toLowerCase()}|${r.path}` === key).map((r) => r.id);

  for (const t of inspection.tunnels) {
    const tunnel = t.row.name;
    const { plan } = t;

    if (plan.actions.some((a) => a.kind === 'ingress.update')) {
      const live = new Map(t.ingress.filter((r) => !isCatchAll(r)).map((r) => [keyOfRule(r), r]));
      const wanted = new Map(
        plan.ingress.filter((r) => !isCatchAll(r)).map((r) => [keyOfRule(r), r]),
      );
      const managed = new Set(t.row.managedIngress);
      const before = findings.length;

      for (const [key, rule] of wanted) {
        if (!managed.has(key) && !live.has(key)) {
          // Never published yet (pending change made in Burrow): not drift, but still a difference.
          findings.push({
            kind: 'ingress.missing',
            target: rule.hostname ?? key,
            tunnel,
            hostIds: hostsByKey(key),
            detail: `The route to ${rule.service} is not published yet.`,
            keepable: false,
          });
          continue;
        }
        const current = live.get(key);
        if (!current) {
          findings.push({
            kind: 'ingress.missing',
            target: rule.hostname ?? key,
            tunnel,
            hostIds: hostsByKey(key),
            detail: `The route to ${rule.service} was removed from the tunnel ${tunnel}.`,
            keepable: true,
          });
        } else if (!ingressEqual([current], [rule])) {
          findings.push({
            kind: 'ingress.changed',
            target: rule.hostname ?? key,
            tunnel,
            hostIds: hostsByKey(key),
            detail: `The route now goes to ${describeRule(current)} instead of ${describeRule(rule)}.`,
            keepable: serviceUrlSchema.safeParse(current.service).success,
            liveRule: current,
          });
        }
      }
      for (const [key, rule] of live) {
        if (managed.has(key) && !wanted.has(key)) {
          findings.push({
            kind: 'ingress.extra',
            target: rule.hostname ?? key,
            tunnel,
            hostIds: [],
            detail: `A route Burrow created (to ${rule.service}) is still on the tunnel but no enabled host uses it.`,
            keepable: false,
          });
        }
      }
      if (findings.length === before) {
        findings.push({
          kind: 'ingress.changed',
          target: tunnel,
          tunnel,
          hostIds: [],
          detail: 'The order of the routes or the catch-all rule of the tunnel changed.',
          keepable: false,
        });
      }
    }

    for (const a of plan.actions) {
      switch (a.kind) {
        case 'dns.create':
          findings.push({
            kind: 'dns.missing',
            target: a.hostname,
            tunnel,
            hostIds: a.hostIds,
            detail: `The CNAME record of ${a.hostname} is missing.`,
            keepable: true,
          });
          break;
        case 'dns.update': {
          const record = inspection.dnsRecords.find((r) => r.id === a.recordId);
          const what = record
            ? `${record.type} ${record.content}${record.proxied ? '' : ' (not proxied)'}`
            : 'something else';
          findings.push({
            kind: 'dns.changed',
            target: a.hostname,
            tunnel,
            hostIds: a.hostIds,
            detail: `The DNS record of ${a.hostname} now is ${what} instead of a proxied CNAME to the tunnel.`,
            keepable: false,
          });
          break;
        }
        case 'dns.delete':
          findings.push({
            kind: 'dns.extra',
            target: a.hostname,
            tunnel,
            hostIds: [],
            detail: `A DNS record Burrow created for ${a.hostname} is left over.`,
            keepable: false,
          });
          break;
        case 'host.conflict':
          findings.push({
            kind: 'dns.conflict',
            target: a.hostname,
            tunnel,
            hostIds: a.hostIds,
            detail: a.reason,
            keepable: true,
          });
          break;
        default:
          break;
      }
    }
  }

  for (const a of inspection.access) {
    const base = { target: a.hostname, tunnel: null, keepable: false };
    if (a.kind === 'access.create') {
      findings.push({
        ...base,
        kind: 'access.missing',
        hostIds: a.hostIds,
        detail: `The Cloudflare Access application protecting ${a.hostname} is missing.`,
      });
    } else if (a.kind === 'access.update') {
      findings.push({
        ...base,
        kind: 'access.changed',
        hostIds: a.hostIds,
        detail: `The Cloudflare Access application or policy of ${a.hostname} was changed.`,
      });
    } else if (a.kind === 'access.delete') {
      findings.push({
        ...base,
        kind: 'access.extra',
        hostIds: [],
        detail: `An Access application or policy Burrow created for ${a.hostname} is left over.`,
      });
    } else if (a.kind === 'access.conflict') {
      findings.push({ ...base, kind: 'access.conflict', hostIds: a.hostIds, detail: a.reason });
    }
  }

  for (const row of inspection.missing) {
    findings.push({
      kind: 'tunnel.missing',
      target: row.name,
      tunnel: row.name,
      hostIds: rows.filter((r) => r.tunnelId === row.id).map((r) => r.id),
      detail:
        row.origin === 'created'
          ? `The tunnel ${row.name} was deleted on Cloudflare. Reverting recreates it.`
          : `The imported tunnel ${row.name} was deleted on Cloudflare. Move its hosts to another tunnel.`,
      keepable: false,
    });
  }

  return findings;
}
