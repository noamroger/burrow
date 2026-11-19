import {
  DEFAULT_HOST_HOME,
  hostHomeSchema,
  accessSessionDurationSchema,
  buildHostname,
  dnsOwnershipComment,
  ingressPathSchema,
  serviceUrlSchema,
  subdomainSchema,
  type AccessSessionDuration,
  type HostSource,
  type ImportedRoute,
  type OriginHealth,
  type ProxyHost,
  type ProxyHostInput,
  type ProxyHostParsedInput,
} from '@burrow/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import type { CfIngressRule } from '../cloudflare/types.js';
import { proxyHosts, tunnels, zones, type ProxyHostRow, type TunnelRow } from '../db/schema.js';
import { AppError, errorMessage, errors } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import { DOCKER_DISCOVERY, diff, type ActorLike, type AuditService } from './audit.js';
import type { CloudflareService } from './cloudflare.js';
import type { HealthService } from './health.js';
import { keyOfRule } from './ingress.js';
import { isOwnedRecord, tunnelTarget } from './plan.js';
import type { Reconciler, SyncScopeItem } from './reconciler.js';
import type { TunnelService } from './tunnel.js';

/** Who owns a host: the user (`manual`) or a container's labels (`docker`). */
export interface HostOrigin {
  source: HostSource;
  /** Container name for Docker hosts. */
  ref: string | null;
}

export interface HostServiceOptions {
  db: Db;
  reconciler: Reconciler;
  cloudflare: CloudflareService;
  health: HealthService;
  audit: AuditService;
  tunnels: TunnelService;
  logger: Logger;
}

/**
 * CRUD for proxy hosts. Every change is written to SQLite first (desired
 * state), then pushed to Cloudflare through a reconciler run scoped to the
 * hostnames involved.
 *
 * - Create is all-or-nothing: if Cloudflare refuses, the row is removed and
 *   the error returned (409 `DNS_CONFLICT` when a foreign record exists).
 * - Update keeps the new values; a DNS conflict or a Cloudflare Access
 *   failure reverts them (the host goes back to how it was published).
 * - Delete removes the row, then the ingress rule and Burrow's CNAME. If
 *   Cloudflare is unreachable, the next reconciliation cleans up.
 */
export class HostService {
  constructor(private readonly opts: HostServiceOptions) {}

  /** Map a row to the API shape. */
  toApi(row: ProxyHostRow, zoneName?: string, tunnelName?: string | null): ProxyHost {
    const name =
      zoneName ??
      this.opts.db.select({ name: zones.name }).from(zones).where(eq(zones.id, row.zoneId)).get()
        ?.name ??
      (row.subdomain === '@' ? row.hostname : row.hostname.slice(row.subdomain.length + 1));
    const health: OriginHealth = this.opts.health.get(row.id);
    const tName =
      tunnelName !== undefined
        ? tunnelName
        : row.tunnelId !== null
          ? (this.opts.tunnels.find(row.tunnelId)?.name ?? null)
          : null;
    return {
      id: row.id,
      subdomain: row.subdomain,
      zoneId: row.zoneId,
      zoneName: name,
      tunnelId: row.tunnelId,
      tunnelName: tName,
      hostname: row.hostname,
      service: row.service,
      path: row.path,
      enabled: row.enabled,
      options: {
        noTLSVerify: row.noTlsVerify,
        httpHostHeader: row.httpHostHeader,
        originServerName: row.originServerName,
        extra: row.originRequestExtra,
      },
      access: {
        enabled: row.accessEnabled,
        emails: row.accessEmails,
        emailDomains: row.accessEmailDomains,
        sessionDuration: toSessionDuration(row.accessSessionDuration),
        browserRendering: row.accessBrowserRendering ?? null,
      },
      template: row.template,
      source: row.source,
      sourceRef: row.sourceRef,
      expiresAt: row.expiresAt,
      maintenance: {
        enabled: row.maintenanceEnabled,
        until: row.maintenanceUntil,
        page: row.maintenancePage ?? null,
      },
      home: hostHomeSchema.catch(DEFAULT_HOST_HOME).parse(row.home ?? {}),
      sync: { status: row.syncStatus, error: row.syncError, lastSyncedAt: row.lastSyncedAt },
      health,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** The settings of a host as API input (audit snapshots and undo). */
  toInput(row: ProxyHostRow): ProxyHostInput {
    return {
      subdomain: row.subdomain,
      zoneId: row.zoneId,
      ...(row.tunnelId !== null ? { tunnelId: row.tunnelId } : {}),
      service: row.service,
      path: row.path,
      enabled: row.enabled,
      options: {
        noTLSVerify: row.noTlsVerify,
        httpHostHeader: row.httpHostHeader,
        originServerName: row.originServerName,
      },
      access: {
        enabled: row.accessEnabled,
        emails: row.accessEmails,
        emailDomains: row.accessEmailDomains,
        sessionDuration: toSessionDuration(row.accessSessionDuration),
        browserRendering: row.accessBrowserRendering ?? null,
      },
      template: (row.template ?? null) as ProxyHostInput['template'],
      expiresAt: row.expiresAt,
      home: hostHomeSchema.catch(DEFAULT_HOST_HOME).parse(row.home ?? {}),
    };
  }

  rows(): ProxyHostRow[] {
    return this.opts.db
      .select()
      .from(proxyHosts)
      .orderBy(asc(proxyHosts.hostname), asc(proxyHosts.path))
      .all();
  }

  list(): ProxyHost[] {
    const names = new Map(
      this.opts.db
        .select()
        .from(zones)
        .all()
        .map((z) => [z.id, z.name]),
    );
    const tunnelNames = new Map(this.opts.tunnels.list().map((t) => [t.id, t.name]));
    return this.rows().map((r) =>
      this.toApi(
        r,
        names.get(r.zoneId),
        r.tunnelId !== null ? (tunnelNames.get(r.tunnelId) ?? null) : null,
      ),
    );
  }

  getRow(id: number): ProxyHostRow {
    const row = this.opts.db.select().from(proxyHosts).where(eq(proxyHosts.id, id)).get();
    if (!row) throw errors.notFound('Proxy host');
    return row;
  }

  get(id: number): ProxyHost {
    return this.toApi(this.getRow(id));
  }

  /** Resolve zone + hostname for an input and check uniqueness. */
  private resolve(input: ProxyHostParsedInput, excludeId?: number) {
    if (!this.opts.cloudflare.isConfigured()) throw errors.cloudflareNotConfigured();
    const zone = this.opts.db.select().from(zones).where(eq(zones.id, input.zoneId)).get();
    if (!zone || !zone.enabled) {
      throw errors.validation(
        'This zone is not enabled in Burrow. Enable it on the Zones page first.',
        {
          field: 'zoneId',
        },
      );
    }
    const hostname = buildHostname(input.subdomain, zone.name);
    const path = input.path ?? '';
    const clash = this.opts.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .where(
        and(
          eq(proxyHosts.hostname, hostname),
          eq(proxyHosts.path, path),
          excludeId !== undefined ? ne(proxyHosts.id, excludeId) : undefined,
        ),
      )
      .get();
    if (clash) {
      throw errors.conflict(`${hostname}${path ? ` (path ${path})` : ''} is already published.`, {
        hostId: clash.id,
      });
    }
    return { zone, hostname, path };
  }

  /** The tunnel a host goes to: the one asked for, the current one on update, or the default. */
  private resolveTunnel(input: ProxyHostParsedInput, current?: number | null): number | null {
    if (input.tunnelId !== undefined) {
      const row = this.opts.tunnels.find(input.tunnelId);
      if (!row) throw errors.validation('This tunnel does not exist.', { field: 'tunnelId' });
      return row.id;
    }
    if (current !== undefined) return current;
    return this.opts.tunnels.getDefault()?.id ?? null;
  }

  private values(
    input: ProxyHostParsedInput,
    hostname: string,
    path: string,
    tunnelId: number | null,
  ) {
    return {
      subdomain: input.subdomain,
      tunnelId,
      zoneId: input.zoneId,
      hostname,
      service: input.service,
      path,
      enabled: input.enabled,
      noTlsVerify: input.options.noTLSVerify,
      httpHostHeader: input.options.httpHostHeader,
      originServerName: input.options.originServerName,
      accessEnabled: input.access.enabled,
      accessEmails: [...new Set(input.access.emails)],
      accessEmailDomains: [...new Set(input.access.emailDomains)],
      accessSessionDuration: input.access.sessionDuration,
      accessBrowserRendering: input.access.browserRendering,
      template: input.template,
      ...(input.expiresAt !== undefined ? { expiresAt: expiry(input.expiresAt) } : {}),
      ...(input.home !== undefined ? { home: input.home } : {}),
    };
  }

  /**
   * Hosts created from Docker labels are changed through the labels: the API
   * refuses to edit or delete them (`managed` is set by the discovery itself).
   */
  private assertEditable(row: ProxyHostRow, managed?: HostOrigin): void {
    if (row.source === 'docker' && managed?.source !== 'docker') {
      throw errors.conflict(
        `${row.hostname} comes from the Docker labels of the container "${row.sourceRef ?? '?'}". Change or remove the labels instead.`,
        { source: row.source, sourceRef: row.sourceRef },
      );
    }
  }

  /** Create a host and publish it. */
  async create(
    input: ProxyHostParsedInput,
    by: ActorLike,
    origin: HostOrigin = { source: 'manual', ref: null },
  ): Promise<ProxyHost> {
    const { hostname, path } = this.resolve(input);
    const row = this.opts.db
      .insert(proxyHosts)
      .values({
        ...this.values(input, hostname, path, this.resolveTunnel(input)),
        source: origin.source,
        sourceRef: origin.ref,
        syncStatus: 'pending',
      })
      .returning()
      .get();

    const scope = [{ zoneId: row.zoneId, hostname }];
    const failure = (await this.syncAndGetResult(row.id, scope)).error;
    if (failure) {
      this.opts.db.delete(proxyHosts).where(eq(proxyHosts.id, row.id)).run();
      // Remove anything that may have been published before the failure.
      await this.opts.reconciler.sync({ scope }).catch(() => undefined);
      throw failure;
    }
    const created = this.getRow(row.id);
    this.opts.audit.record(actorFor(by, origin), 'host.create', hostname + path, {
      details: { note: created.service },
      undo:
        origin.source === 'manual'
          ? { kind: 'host.delete', hostId: row.id, expect: this.toInput(created) }
          : null,
    });
    this.probeLater(row.id);
    return this.get(row.id);
  }

  /** Replace a host's settings. */
  async update(
    id: number,
    input: ProxyHostParsedInput,
    by: ActorLike,
    managed?: HostOrigin,
  ): Promise<ProxyHost> {
    const before = this.getRow(id);
    this.assertEditable(before, managed);
    const { hostname, path } = this.resolve(input, id);
    this.opts.db
      .update(proxyHosts)
      .set({
        ...this.values(input, hostname, path, this.resolveTunnel(input, before.tunnelId)),
        ...(managed ? { sourceRef: managed.ref } : {}),
        syncStatus: 'pending',
        updatedAt: nowIso(),
      })
      .where(eq(proxyHosts.id, id))
      .run();

    const scope = uniqueScope([
      { zoneId: before.zoneId, hostname: before.hostname },
      { zoneId: input.zoneId, hostname },
    ]);
    const result = await this.syncAndGetResult(id, scope);
    const failure = result.error;
    if (failure && (failure.code === 'DNS_CONFLICT' || result.stage === 'access')) {
      const { id: _id, createdAt: _c, ...previous } = before;
      this.opts.db.update(proxyHosts).set(previous).where(eq(proxyHosts.id, id)).run();
      await this.opts.reconciler.sync({ scope }).catch(() => undefined);
      throw failure;
    }
    const after = this.getRow(id);
    const changes = diff(this.toInput(before), this.toInput(after));
    if (changes.length > 0) {
      this.opts.audit.record(actorFor(by, managed), 'host.update', hostname + path, {
        details: { changes },
        undo:
          after.source === 'manual'
            ? {
                kind: 'host.restore',
                hostId: id,
                input: this.toInput(before),
                expect: this.toInput(after),
              }
            : null,
      });
    }
    this.opts.health.forget(id);
    this.probeLater(id);
    if (failure) throw failure;
    return this.get(id);
  }

  /**
   * Turn the public hostname routes of an imported tunnel into proxy hosts.
   * Routes Burrow cannot represent (no hostname, non-URL services such as
   * `http_status:404`, hostnames outside the account's zones, already
   * published hostnames) are reported as skipped and stay on the tunnel,
   * untouched. Zones of imported hosts are enabled.
   */
  async importRoutes(tunnel: TunnelRow, ingress: CfIngressRule[]): Promise<ImportedRoute[]> {
    const liveZones = (await this.opts.cloudflare.listZones()).sort(
      (a, b) => b.name.length - a.name.length,
    );
    const report: ImportedRoute[] = [];
    const imported: string[] = [];
    for (const rule of ingress) {
      if (!rule.hostname) continue;
      const hostname = rule.hostname.toLowerCase();
      const path = rule.path ?? '';
      const entry = { hostname, path, service: rule.service };
      const skip = (reason: string) => report.push({ ...entry, skipped: reason });

      if (!serviceUrlSchema.safeParse(rule.service).success) {
        skip('The service is not a URL Burrow can manage; the route is kept as is.');
        continue;
      }
      if (!ingressPathSchema.safeParse(path).success) {
        skip('The path is too long.');
        continue;
      }
      const zone = liveZones.find((z) => hostname === z.name || hostname.endsWith(`.${z.name}`));
      if (!zone) {
        skip('No zone of this account matches this hostname.');
        continue;
      }
      const subdomain = hostname === zone.name ? '@' : hostname.slice(0, -zone.name.length - 1);
      if (!subdomainSchema.safeParse(subdomain).success) {
        skip('This hostname is not supported by Burrow.');
        continue;
      }
      const clash = this.opts.db
        .select({ id: proxyHosts.id })
        .from(proxyHosts)
        .where(and(eq(proxyHosts.hostname, hostname), eq(proxyHosts.path, path)))
        .get();
      if (clash) {
        skip('This hostname is already published by Burrow.');
        continue;
      }

      const { noTLSVerify, httpHostHeader, originServerName, ...extra } = rule.originRequest ?? {};
      this.opts.db
        .insert(zones)
        .values({ id: zone.id, name: zone.name, enabled: true })
        .onConflictDoUpdate({ target: zones.id, set: { enabled: true, name: zone.name } })
        .run();
      this.opts.db
        .insert(proxyHosts)
        .values({
          subdomain,
          zoneId: zone.id,
          hostname,
          service: rule.service,
          path,
          tunnelId: tunnel.id,
          noTlsVerify: noTLSVerify === true,
          httpHostHeader: typeof httpHostHeader === 'string' ? httpHostHeader : '',
          originServerName: typeof originServerName === 'string' ? originServerName : '',
          originRequestExtra: extra,
          syncStatus: 'pending',
        })
        .run();
      imported.push(keyOfRule(rule));
      report.push({ ...entry, skipped: null });
      await this.adoptRecord(zone.id, hostname, tunnel.cfId);
    }
    if (imported.length > 0) {
      const current = this.opts.db.select().from(tunnels).where(eq(tunnels.id, tunnel.id)).get();
      this.opts.tunnels.setManagedIngress(tunnel.id, [
        ...new Set([...(current?.managedIngress ?? []), ...imported]),
      ]);
    }
    return report;
  }

  /**
   * An imported route usually has a CNAME made by the dashboard, without
   * Burrow's comment. The user asked to import it, so Burrow adopts it: the
   * comment is added only when the record already points at this tunnel.
   * Anything else is left alone (and reported as a conflict by the next sync).
   */
  private async adoptRecord(zoneId: string, hostname: string, cfTunnelId: string): Promise<void> {
    const { client } = this.opts.cloudflare.getContext();
    try {
      const records = await client.listDnsRecords(zoneId, { 'name.exact': hostname });
      for (const r of records) {
        if (
          r.type === 'CNAME' &&
          r.content.toLowerCase() === tunnelTarget(cfTunnelId) &&
          !isOwnedRecord(r)
        ) {
          await client.updateDnsRecord(zoneId, r.id, { comment: dnsOwnershipComment(cfTunnelId) });
        }
      }
    } catch (err) {
      this.opts.logger.warn({ hostname, err: errorMessage(err) }, 'could not adopt DNS record');
    }
  }

  /** Delete a host and unpublish it. */
  async remove(
    id: number,
    by: ActorLike,
    managed?: HostOrigin,
    reason: 'delete' | 'expire' = 'delete',
  ): Promise<void> {
    const row = this.getRow(id);
    this.assertEditable(row, managed);
    this.opts.db.delete(proxyHosts).where(eq(proxyHosts.id, id)).run();
    this.opts.health.forget(id);
    this.opts.audit.record(actorFor(by, managed), `host.${reason}`, row.hostname + row.path, {
      details: { note: row.service },
      undo:
        row.source === 'manual' && reason === 'delete'
          ? { kind: 'host.recreate', input: this.toInput(row), extra: row.originRequestExtra }
          : null,
    });
    if (!this.opts.cloudflare.isConfigured()) return;
    try {
      await this.opts.reconciler.sync({ scope: [{ zoneId: row.zoneId, hostname: row.hostname }] });
    } catch (err) {
      this.opts.logger.warn(
        { hostname: row.hostname, err: errorMessage(err) },
        'could not unpublish host now; the next reconciliation will clean up',
      );
    }
  }

  /**
   * Remove temporary hosts whose time is up (periodic job). Each removal
   * unpublishes the route, the DNS record and the Access application.
   * Returns the hostnames removed.
   */
  async removeExpired(now = new Date()): Promise<string[]> {
    const expired = this.rows().filter(
      (r) => r.expiresAt !== null && Date.parse(r.expiresAt) <= now.getTime(),
    );
    const removed: string[] = [];
    for (const row of expired) {
      try {
        await this.remove(row.id, null, { source: row.source, ref: row.sourceRef }, 'expire');
        this.opts.logger.info({ hostname: row.hostname }, 'temporary host expired and removed');
        removed.push(row.hostname + row.path);
      } catch (err) {
        this.opts.logger.warn(
          { hostname: row.hostname, err: errorMessage(err) },
          'could not remove expired host',
        );
      }
    }
    return removed;
  }

  /** Probe a host's origin now. */
  async check(id: number): Promise<OriginHealth> {
    const row = this.getRow(id);
    return this.opts.health.check(id, row);
  }

  /** Probe every enabled host (periodic health job). */
  async checkAll(): Promise<void> {
    await this.opts.health.checkAll(this.rows().filter((r) => r.enabled));
  }

  private async syncAndGetResult(
    id: number,
    scope: SyncScopeItem[],
  ): Promise<{ error: AppError | null; stage?: 'access' }> {
    const outcome = await this.opts.reconciler.sync({ scope });
    const result = outcome.hosts.get(id);
    if (result && !result.ok) {
      return {
        error: result.error ?? new AppError('CLOUDFLARE_API_ERROR', 'Synchronisation failed', 502),
        stage: result.stage,
      };
    }
    return { error: null };
  }

  private probeLater(id: number): void {
    const row = this.opts.db.select().from(proxyHosts).where(eq(proxyHosts.id, id)).get();
    if (!row || !row.enabled) return;
    void this.opts.health.check(id, row).catch(() => undefined);
  }
}

function toSessionDuration(value: string): AccessSessionDuration {
  const parsed = accessSessionDurationSchema.safeParse(value);
  return parsed.success ? parsed.data : '24h';
}

function uniqueScope(items: SyncScopeItem[]): SyncScopeItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.zoneId}|${i.hostname}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Changes made by Docker discovery are logged as such. */
function actorFor(by: ActorLike, origin?: HostOrigin): ActorLike {
  return by === null && origin?.source === 'docker' ? DOCKER_DISCOVERY : by;
}

/** Validate an expiry: null (permanent) or a time in the future, normalised to UTC. */
function expiry(value: string | null): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time) || time <= Date.now()) {
    throw errors.validation('The expiry time must be in the future.', { field: 'expiresAt' });
  }
  return new Date(time).toISOString();
}
