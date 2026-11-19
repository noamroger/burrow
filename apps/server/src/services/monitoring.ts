import type {
  Heartbeat,
  HostMonitorDetail,
  HostMonitorSummary,
  Incident,
  MonitorBucket,
  MonitoringOverview,
  MonitoringRange,
  OriginHealth,
} from '@burrow/shared';
import type Database from 'better-sqlite3';
import { desc, eq, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { healthChecks, proxyHosts, type ProxyHostRow } from '../db/schema.js';
import { errorMessage, errors } from '../lib/errors.js';
import type { HealthService } from './health.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Length of each range and the size of its buckets (chart bars). */
export const RANGES: Record<MonitoringRange, { ms: number; buckets: number }> = {
  '24h': { ms: DAY, buckets: 96 }, // 15 minutes
  '7d': { ms: 7 * DAY, buckets: 84 }, // 2 hours
  '30d': { ms: 30 * DAY, buckets: 90 }, // 8 hours
};

/** Heartbeats returned per host in the overview. */
const HEARTBEATS = 60;

export interface HostDownEvent {
  hostId: number;
  hostname: string;
  path: string;
  error: string | null;
  since: string;
}

export interface HostUpEvent {
  hostId: number;
  hostname: string;
  path: string;
  downSince: string;
  durationSeconds: number;
}

export interface MonitoringServiceOptions {
  db: Db;
  sqlite: Database.Database;
  health: HealthService;
  logger: Logger;
  retentionDays: number;
  intervalSeconds: number;
  /** Consecutive failed probes before a host counts as down (default 2: one blip is not an outage). */
  failuresBeforeDown?: number;
}

/** What the monitor remembers about a host between probes. */
interface Tracking {
  failures: number;
  /** Time of the first failure of the current streak. */
  firstFailure: number | null;
  /** The `down` event was sent for this streak. */
  down: boolean;
}

interface Aggregate {
  host_id: number;
  checks: number;
  up: number;
  latency: number | null;
}

/**
 * Uptime history: stores every probe result of the {@link HealthService},
 * computes uptime, response times and incidents, and serves the public
 * status badges.
 *
 * Events `down` / `up` fire when a host starts failing (after
 * `failuresBeforeDown` failed probes in a row) and when it recovers: the
 * hook for notifications. Hosts in maintenance mode do not raise `down`.
 */
export class MonitoringService extends EventEmitter<{ down: [HostDownEvent]; up: [HostUpEvent] }> {
  private readonly tracking = new Map<number, Tracking>();
  private readonly threshold: number;

  constructor(private readonly opts: MonitoringServiceOptions) {
    super();
    this.threshold = Math.max(1, opts.failuresBeforeDown ?? 2);
    opts.health.on('result', (hostId, result) => {
      try {
        this.record(hostId, result);
      } catch (err) {
        opts.logger.warn({ hostId, err: errorMessage(err) }, 'could not record a health check');
      }
    });
  }

  /** Store a probe result and raise `down` / `up` on transitions. */
  record(hostId: number, result: OriginHealth): void {
    if (result.state === 'unknown') return;
    const row = this.row(hostId);
    if (!row) return; // deleted while the probe ran
    const at = Date.parse(result.checkedAt ?? '') || Date.now();
    const up = result.state === 'up';
    const state = this.state(hostId);
    this.opts.db
      .insert(healthChecks)
      .values({
        hostId,
        checkedAt: at,
        up,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode,
        error: result.error,
      })
      .run();

    if (up) {
      if (state.down && state.firstFailure !== null) {
        this.emit('up', {
          hostId,
          hostname: row.hostname,
          path: row.path,
          downSince: new Date(state.firstFailure).toISOString(),
          durationSeconds: Math.max(0, Math.round((at - state.firstFailure) / 1000)),
        });
      }
      this.tracking.set(hostId, { failures: 0, firstFailure: null, down: false });
      return;
    }
    state.failures++;
    state.firstFailure ??= at;
    if (!state.down && state.failures >= this.threshold) {
      state.down = true;
      if (!row.maintenanceEnabled && row.enabled) {
        this.emit('down', {
          hostId,
          hostname: row.hostname,
          path: row.path,
          error: result.error,
          since: new Date(state.firstFailure).toISOString(),
        });
      }
    }
  }

  /** Tracking state, rebuilt from the history after a restart (no repeated alerts). */
  private state(hostId: number): Tracking {
    let state = this.tracking.get(hostId);
    if (state) return state;
    const recent = this.opts.db
      .select({ up: healthChecks.up, at: healthChecks.checkedAt })
      .from(healthChecks)
      .where(eq(healthChecks.hostId, hostId))
      .orderBy(desc(healthChecks.checkedAt))
      .limit(500)
      .all();
    state = { failures: 0, firstFailure: null, down: false };
    for (const r of recent) {
      if (r.up) break;
      state.failures++;
      state.firstFailure = r.at;
    }
    state.down = state.failures >= this.threshold;
    this.tracking.set(hostId, state);
    return state;
  }

  private row(hostId: number): ProxyHostRow | undefined {
    return this.opts.db.select().from(proxyHosts).where(eq(proxyHosts.id, hostId)).get();
  }

  /** Delete history older than the retention (hourly job). Returns the number of rows removed. */
  prune(now = Date.now()): number {
    const cutoff = now - this.opts.retentionDays * DAY;
    return this.opts.db.delete(healthChecks).where(lt(healthChecks.checkedAt, cutoff)).run()
      .changes;
  }

  /** Every host with its uptime and latest probes. */
  overview(now = Date.now()): MonitoringOverview {
    const rows = this.opts.db.select().from(proxyHosts).orderBy(proxyHosts.hostname).all();
    const windows = {
      h24: this.aggregates(now - DAY),
      d7: this.aggregates(now - 7 * DAY),
      d30: this.aggregates(now - 30 * DAY),
    };
    return {
      intervalSeconds: this.opts.intervalSeconds,
      retentionDays: this.opts.retentionDays,
      hosts: rows.map((row) => this.summarize(row, windows)),
    };
  }

  /** One host: summary, history buckets and incidents over a range. */
  detail(hostId: number, range: MonitoringRange, now = Date.now()): HostMonitorDetail {
    const row = this.row(hostId);
    if (!row) throw errors.notFound('Proxy host');
    const { ms, buckets: count } = RANGES[range];
    const start = now - ms;
    const buckets = this.buckets(hostId, start, ms / count, count);
    const total = buckets.reduce((a, b) => a + b.checks, 0);
    const up = buckets.reduce((a, b) => a + b.up, 0);
    return {
      summary: this.summarize(row, {
        h24: this.aggregates(now - DAY, hostId),
        d7: this.aggregates(now - 7 * DAY, hostId),
        d30: this.aggregates(now - 30 * DAY, hostId),
      }),
      range,
      uptime: total > 0 ? up / total : null,
      buckets,
      incidents: this.incidents(hostId, start, now),
    };
  }

  /**
   * Fixed-size time slices from `start`: probes, successes and response
   * times (successful probes only) in each.
   */
  buckets(hostId: number, start: number, size: number, count: number): MonitorBucket[] {
    const rows = this.opts.sqlite
      .prepare(
        `SELECT CAST((checked_at - @start) / @size AS INTEGER) AS b,
                COUNT(*) AS checks, SUM(up) AS up,
                AVG(CASE WHEN up = 1 THEN latency_ms END) AS avg,
                MAX(CASE WHEN up = 1 THEN latency_ms END) AS max
           FROM health_checks
          WHERE host_id = @hostId AND checked_at >= @start AND checked_at < @end
          GROUP BY b`,
      )
      .all({ hostId, start, size, end: start + size * count }) as Array<{
      b: number;
      checks: number;
      up: number;
      avg: number | null;
      max: number | null;
    }>;
    const byIndex = new Map(rows.map((r) => [r.b, r]));
    return Array.from({ length: count }, (_, i) => {
      const r = byIndex.get(i);
      return {
        start: new Date(start + i * size).toISOString(),
        checks: r?.checks ?? 0,
        up: r?.up ?? 0,
        avgLatencyMs: r?.avg == null ? null : Math.round(r.avg),
        maxLatencyMs: r?.max ?? null,
      };
    });
  }

  /** Streaks of failed probes, newest first. */
  incidents(hostId: number, start: number, now = Date.now()): Incident[] {
    const rows = this.opts.sqlite
      .prepare(
        `SELECT checked_at AS at, up, error FROM health_checks
          WHERE host_id = ? AND checked_at >= ? ORDER BY checked_at`,
      )
      .all(hostId, start) as Array<{ at: number; up: number; error: string | null }>;
    const list: Incident[] = [];
    let open: { start: number; error: string | null } | null = null;
    for (const r of rows) {
      if (!r.up && !open) open = { start: r.at, error: r.error };
      else if (r.up && open) {
        list.push(incident(open.start, r.at, open.error));
        open = null;
      }
    }
    if (open) list.push({ ...incident(open.start, now, open.error), end: null });
    return list.reverse().slice(0, 50);
  }

  /** Create (or replace) the secret badge URL of a host. */
  enableBadge(hostId: number): string {
    if (!this.row(hostId)) throw errors.notFound('Proxy host');
    const token = randomBytes(18).toString('base64url');
    this.opts.db
      .update(proxyHosts)
      .set({ badgeToken: token })
      .where(eq(proxyHosts.id, hostId))
      .run();
    return token;
  }

  disableBadge(hostId: number): void {
    if (!this.row(hostId)) throw errors.notFound('Proxy host');
    this.opts.db
      .update(proxyHosts)
      .set({ badgeToken: null })
      .where(eq(proxyHosts.id, hostId))
      .run();
  }

  /** What the public badge shows. Null when the token is unknown. */
  badge(
    token: string,
    now = Date.now(),
  ): {
    hostname: string;
    state: 'up' | 'down' | 'unknown';
    uptime: number | null;
    hours: Array<number | null>;
  } | null {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const row = this.opts.db
      .select()
      .from(proxyHosts)
      .where(eq(proxyHosts.badgeToken, token))
      .get();
    if (!row) return null;
    const summary = this.summarize(row, {
      h24: [],
      d7: [],
      d30: this.aggregates(now - 30 * DAY, row.id),
    });
    // The last 12 hours, one slice per hour.
    const hourStart = Math.floor(now / HOUR) * HOUR - 11 * HOUR;
    const hours = this.buckets(row.id, hourStart, HOUR, 12).map((b) =>
      b.checks > 0 ? b.up / b.checks : null,
    );
    return { hostname: row.hostname, state: summary.state, uptime: summary.uptime.d30, hours };
  }

  private aggregates(since: number, hostId?: number): Aggregate[] {
    return this.opts.sqlite
      .prepare(
        `SELECT host_id, COUNT(*) AS checks, SUM(up) AS up,
                AVG(CASE WHEN up = 1 THEN latency_ms END) AS latency
           FROM health_checks
          WHERE checked_at >= ? ${hostId !== undefined ? 'AND host_id = ?' : ''}
          GROUP BY host_id`,
      )
      .all(...(hostId !== undefined ? [since, hostId] : [since])) as Aggregate[];
  }

  private summarize(
    row: ProxyHostRow,
    windows: { h24: Aggregate[]; d7: Aggregate[]; d30: Aggregate[] },
  ): HostMonitorSummary {
    const find = (list: Aggregate[]) => list.find((a) => a.host_id === row.id);
    const ratio = (a: Aggregate | undefined) => (a && a.checks > 0 ? a.up / a.checks : null);
    const heartbeats: Heartbeat[] = this.opts.db
      .select({
        at: healthChecks.checkedAt,
        up: healthChecks.up,
        latencyMs: healthChecks.latencyMs,
      })
      .from(healthChecks)
      .where(eq(healthChecks.hostId, row.id))
      .orderBy(desc(healthChecks.checkedAt))
      .limit(HEARTBEATS)
      .all()
      .reverse()
      .map((h) => ({ at: new Date(h.at).toISOString(), up: h.up, latencyMs: h.latencyMs }));

    const live = this.opts.health.get(row.id).state;
    const last = heartbeats[heartbeats.length - 1];
    const state = live !== 'unknown' ? live : last ? (last.up ? 'up' : 'down') : 'unknown';
    const tracking = this.state(row.id);
    const latency = find(windows.h24)?.latency;
    return {
      hostId: row.id,
      hostname: row.hostname,
      path: row.path,
      enabled: row.enabled,
      state: row.enabled ? state : 'unknown',
      downSince:
        state === 'down' && tracking.firstFailure !== null
          ? new Date(tracking.firstFailure).toISOString()
          : null,
      uptime: {
        h24: ratio(find(windows.h24)),
        d7: ratio(find(windows.d7)),
        d30: ratio(find(windows.d30)),
      },
      avgLatencyMs: latency == null ? null : Math.round(latency),
      heartbeats,
      badgeToken: row.badgeToken,
    };
  }
}

function incident(start: number, end: number, error: string | null): Incident {
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    durationSeconds: Math.max(0, Math.round((end - start) / 1000)),
    error,
  };
}
