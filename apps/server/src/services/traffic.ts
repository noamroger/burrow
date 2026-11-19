import type { HostTraffic, MonitoringRange, TrafficOverview, TrafficPoint } from '@burrow/shared';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { proxyHosts } from '../db/schema.js';
import { errorMessage, errors } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import type { CloudflareService } from './cloudflare.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Range length; hourly points except 30 days (daily). Cloudflare allows 30 days per query. */
const RANGES: Record<MonitoringRange, { ms: number; daily: boolean }> = {
  '24h': { ms: DAY, daily: false },
  '7d': { ms: 7 * DAY, daily: false },
  '30d': { ms: 30 * DAY - 60_000, daily: true },
};

interface Group {
  count: number;
  sum?: { edgeResponseBytes?: number; visits?: number };
  dimensions: Record<string, string | number>;
}

interface ZoneResult {
  viewer: { zones: Array<Record<string, Group[]>> };
}

export interface TrafficServiceOptions {
  db: Db;
  cloudflare: CloudflareService;
  logger: Logger;
  /** How long answers are cached (default 5 minutes: analytics lag a few minutes anyway). */
  ttlMs?: number;
}

/**
 * Traffic of the published hostnames, from the Cloudflare GraphQL Analytics
 * API. Only visitor requests (`requestSource: eyeball`) are counted. Results
 * are cached for a few minutes. A host with a path shares the numbers of its
 * hostname: Cloudflare counts by hostname.
 */
export class TrafficService {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly ttlMs: number;

  constructor(private readonly opts: TrafficServiceOptions) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** One host over a range. Throws Cloudflare errors (403 permission missing…). */
  host(hostId: number, range: MonitoringRange): Promise<HostTraffic> {
    const row = this.opts.db.select().from(proxyHosts).where(eq(proxyHosts.id, hostId)).get();
    if (!row) throw errors.notFound('Proxy host');
    return this.cached(`host:${row.hostname}:${range}`, async () => {
      const { client } = this.opts.cloudflare.getContext();
      const { ms, daily } = RANGES[range];
      const end = new Date();
      const start = new Date(end.getTime() - ms);
      const time = daily ? 'date' : 'datetimeHour';
      const filter = `{ datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball", clientRequestHTTPHost: ${JSON.stringify(row.hostname)} }`;
      const data = await client.graphql<ZoneResult>(
        `query HostTraffic($zoneTag: string!, $start: Time!, $end: Time!) {
          viewer { zones(filter: { zoneTag: $zoneTag }) {
            series: httpRequestsAdaptiveGroups(filter: ${filter}, limit: 1000, orderBy: [${time}_ASC]) {
              count sum { edgeResponseBytes visits } dimensions { ts: ${time} }
            }
            statuses: httpRequestsAdaptiveGroups(filter: ${filter}, limit: 100, orderBy: [count_DESC]) {
              count dimensions { edgeResponseStatus }
            }
            countries: httpRequestsAdaptiveGroups(filter: ${filter}, limit: 5, orderBy: [count_DESC]) {
              count dimensions { clientCountryName }
            }
          } }
        }`,
        { zoneTag: row.zoneId, start: start.toISOString(), end: end.toISOString() },
      );
      const zone = data.viewer.zones[0] ?? {};
      const series = fillSeries(zone.series ?? [], start.getTime(), end.getTime(), daily);
      const statuses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
      for (const g of zone.statuses ?? []) {
        const cls = `${String(g.dimensions.edgeResponseStatus)[0]}xx` as keyof typeof statuses;
        if (cls in statuses) statuses[cls] += g.count;
      }
      return {
        hostId: row.id,
        hostname: row.hostname,
        range,
        totals: series.reduce(
          (t, p) => ({
            requests: t.requests + p.requests,
            bytes: t.bytes + p.bytes,
            visits: t.visits + p.visits,
          }),
          { requests: 0, bytes: 0, visits: 0 },
        ),
        series,
        statuses,
        topCountries: (zone.countries ?? [])
          .filter((g) => g.dimensions.clientCountryName)
          .map((g) => ({ country: String(g.dimensions.clientCountryName), requests: g.count })),
        fetchedAt: nowIso(),
      };
    });
  }

  /** Requests and bandwidth of every host over 24 hours. Never throws: errors go in `error`. */
  async overview(): Promise<TrafficOverview> {
    if (!this.opts.cloudflare.isConfigured()) {
      return { hosts: [], error: 'Cloudflare is not configured.', fetchedAt: nowIso() };
    }
    try {
      return await this.cached('overview', async () => {
        const rows = this.opts.db.select().from(proxyHosts).all();
        const byZone = new Map<string, string[]>();
        for (const r of rows) {
          const list = byZone.get(r.zoneId) ?? [];
          if (!list.includes(r.hostname)) list.push(r.hostname);
          byZone.set(r.zoneId, list);
        }
        const { client } = this.opts.cloudflare.getContext();
        const end = new Date();
        const start = new Date(end.getTime() - DAY);
        const totals = new Map<string, { requests: number; bytes: number }>();
        for (const [zoneId, hostnames] of byZone) {
          const data = await client.graphql<ZoneResult>(
            `query Overview($zoneTag: string!, $start: Time!, $end: Time!) {
              viewer { zones(filter: { zoneTag: $zoneTag }) {
                hosts: httpRequestsAdaptiveGroups(
                  filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball", clientRequestHTTPHost_in: ${JSON.stringify(hostnames)} }
                  limit: 1000, orderBy: [count_DESC]
                ) { count sum { edgeResponseBytes } dimensions { clientRequestHTTPHost } }
              } }
            }`,
            { zoneTag: zoneId, start: start.toISOString(), end: end.toISOString() },
          );
          for (const g of data.viewer.zones[0]?.hosts ?? []) {
            totals.set(String(g.dimensions.clientRequestHTTPHost).toLowerCase(), {
              requests: g.count,
              bytes: g.sum?.edgeResponseBytes ?? 0,
            });
          }
        }
        return {
          hosts: rows.map((r) => ({
            hostId: r.id,
            hostname: r.hostname,
            requests: totals.get(r.hostname)?.requests ?? 0,
            bytes: totals.get(r.hostname)?.bytes ?? 0,
          })),
          error: null,
          fetchedAt: nowIso(),
        };
      });
    } catch (err) {
      this.opts.logger.debug({ err: errorMessage(err) }, 'traffic overview unavailable');
      return { hosts: [], error: errorMessage(err), fetchedAt: nowIso() };
    }
  }
}

/** One point per hour (or day) between start and end, zeros where Cloudflare has nothing. */
export function fillSeries(
  groups: Group[],
  start: number,
  end: number,
  daily: boolean,
): TrafficPoint[] {
  const step = daily ? DAY : HOUR;
  const first = Math.floor(start / step) * step;
  const byKey = new Map<number, Group>();
  for (const g of groups) {
    const ts = String(g.dimensions.ts);
    const time = Date.parse(daily ? `${ts}T00:00:00Z` : ts);
    if (!Number.isNaN(time)) byKey.set(Math.floor(time / step) * step, g);
  }
  const points: TrafficPoint[] = [];
  for (let t = first; t < end; t += step) {
    const g = byKey.get(t);
    points.push({
      start: new Date(t).toISOString(),
      requests: g?.count ?? 0,
      bytes: g?.sum?.edgeResponseBytes ?? 0,
      visits: g?.sum?.visits ?? 0,
    });
  }
  return points;
}
