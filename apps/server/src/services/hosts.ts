import {
  buildHostname,
  type OriginHealth,
  type ProxyHost,
  type ProxyHostParsedInput,
} from '@burrow/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { proxyHosts, zones, type ProxyHostRow } from '../db/schema.js';
import { AppError, errorMessage, errors } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import type { AuditService } from './audit.js';
import type { CloudflareService } from './cloudflare.js';
import type { HealthService } from './health.js';
import type { Reconciler, SyncScopeItem } from './reconciler.js';

export interface HostServiceOptions {
  db: Db;
  reconciler: Reconciler;
  cloudflare: CloudflareService;
  health: HealthService;
  audit: AuditService;
  logger: Logger;
}

/**
 * CRUD for proxy hosts. Every change is written to SQLite first (desired
 * state), then pushed to Cloudflare through a reconciler run scoped to the
 * hostnames involved.
 *
 * - Create is all-or-nothing: if Cloudflare refuses, the row is removed and
 *   the error returned (409 `DNS_CONFLICT` when a foreign record exists).
 * - Update keeps the new values; a DNS conflict reverts them.
 * - Delete removes the row, then the ingress rule and Burrow's CNAME. If
 *   Cloudflare is unreachable, the next reconciliation cleans up.
 */
export class HostService {
  constructor(private readonly opts: HostServiceOptions) {}

  /** Map a row to the API shape. */
  toApi(row: ProxyHostRow, zoneName?: string): ProxyHost {
    const name =
      zoneName ??
      this.opts.db.select({ name: zones.name }).from(zones).where(eq(zones.id, row.zoneId)).get()
        ?.name ??
      (row.subdomain === '@' ? row.hostname : row.hostname.slice(row.subdomain.length + 1));
    const health: OriginHealth = this.opts.health.get(row.id);
    return {
      id: row.id,
      subdomain: row.subdomain,
      zoneId: row.zoneId,
      zoneName: name,
      hostname: row.hostname,
      service: row.service,
      path: row.path,
      enabled: row.enabled,
      options: {
        noTLSVerify: row.noTlsVerify,
        httpHostHeader: row.httpHostHeader,
        originServerName: row.originServerName,
      },
      sync: { status: row.syncStatus, error: row.syncError, lastSyncedAt: row.lastSyncedAt },
      health,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
    return this.rows().map((r) => this.toApi(r, names.get(r.zoneId)));
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

  private values(input: ProxyHostParsedInput, hostname: string, path: string) {
    return {
      subdomain: input.subdomain,
      zoneId: input.zoneId,
      hostname,
      service: input.service,
      path,
      enabled: input.enabled,
      noTlsVerify: input.options.noTLSVerify,
      httpHostHeader: input.options.httpHostHeader,
      originServerName: input.options.originServerName,
    };
  }

  /** Create a host and publish it. */
  async create(input: ProxyHostParsedInput, userId: number | null): Promise<ProxyHost> {
    const { hostname, path } = this.resolve(input);
    const row = this.opts.db
      .insert(proxyHosts)
      .values({ ...this.values(input, hostname, path), syncStatus: 'pending' })
      .returning()
      .get();

    const scope = [{ zoneId: row.zoneId, hostname }];
    const failure = await this.syncAndGetError(row.id, scope);
    if (failure) {
      this.opts.db.delete(proxyHosts).where(eq(proxyHosts.id, row.id)).run();
      // Remove anything that may have been published before the failure.
      await this.opts.reconciler.sync({ scope }).catch(() => undefined);
      throw failure;
    }
    this.opts.audit.record(userId, 'host.create', hostname + path);
    this.probeLater(row.id);
    return this.get(row.id);
  }

  /** Replace a host's settings. */
  async update(id: number, input: ProxyHostParsedInput, userId: number | null): Promise<ProxyHost> {
    const before = this.getRow(id);
    const { hostname, path } = this.resolve(input, id);
    this.opts.db
      .update(proxyHosts)
      .set({ ...this.values(input, hostname, path), syncStatus: 'pending', updatedAt: nowIso() })
      .where(eq(proxyHosts.id, id))
      .run();

    const scope = uniqueScope([
      { zoneId: before.zoneId, hostname: before.hostname },
      { zoneId: input.zoneId, hostname },
    ]);
    const failure = await this.syncAndGetError(id, scope);
    if (failure?.code === 'DNS_CONFLICT') {
      const { id: _id, createdAt: _c, ...previous } = before;
      this.opts.db.update(proxyHosts).set(previous).where(eq(proxyHosts.id, id)).run();
      await this.opts.reconciler.sync({ scope }).catch(() => undefined);
      throw failure;
    }
    this.opts.audit.record(userId, 'host.update', hostname + path);
    this.opts.health.forget(id);
    this.probeLater(id);
    if (failure) throw failure;
    return this.get(id);
  }

  /** Delete a host and unpublish it. */
  async remove(id: number, userId: number | null): Promise<void> {
    const row = this.getRow(id);
    this.opts.db.delete(proxyHosts).where(eq(proxyHosts.id, id)).run();
    this.opts.health.forget(id);
    this.opts.audit.record(userId, 'host.delete', row.hostname + row.path);
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

  /** Probe a host's origin now. */
  async check(id: number): Promise<OriginHealth> {
    const row = this.getRow(id);
    return this.opts.health.check(id, row);
  }

  /** Probe every enabled host (periodic health job). */
  async checkAll(): Promise<void> {
    await this.opts.health.checkAll(this.rows().filter((r) => r.enabled));
  }

  private async syncAndGetError(id: number, scope: SyncScopeItem[]): Promise<AppError | null> {
    const outcome = await this.opts.reconciler.sync({ scope });
    const result = outcome.hosts.get(id);
    if (result && !result.ok) {
      return result.error ?? new AppError('CLOUDFLARE_API_ERROR', 'Synchronisation failed', 502);
    }
    return null;
  }

  private probeLater(id: number): void {
    const row = this.opts.db.select().from(proxyHosts).where(eq(proxyHosts.id, id)).get();
    if (!row || !row.enabled) return;
    void this.opts.health.check(id, row).catch(() => undefined);
  }
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
