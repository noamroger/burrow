/**
 * Service monitoring: every health probe of a host is kept for a while
 * (`MONITORING_RETENTION_DAYS`, 30 by default) so Burrow can show uptime
 * percentages, response times and incidents, Uptime Kuma style.
 *
 * Public status badges: a host can get a secret, unguessable badge URL
 * (`/api/badge/<token>`) that serves an SVG with its status and uptime.
 */
import { z } from 'zod';

export const MONITORING_RANGES = ['24h', '7d', '30d'] as const;
export const monitoringRangeSchema = z.enum(MONITORING_RANGES);
export type MonitoringRange = z.infer<typeof monitoringRangeSchema>;

/** One probe result. */
export const heartbeatSchema = z.object({
  at: z.string(),
  up: z.boolean(),
  latencyMs: z.number().int().nullable(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

/** Share of successful probes (0 to 1), or null when there is no data. */
const ratio = z.number().min(0).max(1).nullable();

export const hostMonitorSummarySchema = z.object({
  hostId: z.number().int(),
  hostname: z.string(),
  path: z.string(),
  enabled: z.boolean(),
  /** Current state (last probe). */
  state: z.enum(['up', 'down', 'unknown']),
  /** Since when the host has been failing, when it is down. */
  downSince: z.string().nullable(),
  uptime: z.object({ h24: ratio, d7: ratio, d30: ratio }),
  /** Average response time over the last 24 hours. */
  avgLatencyMs: z.number().int().nullable(),
  /** The latest probes, oldest first (at most 60). */
  heartbeats: z.array(heartbeatSchema),
  /** Secret part of the public badge URL; null when the badge is off. */
  badgeToken: z.string().nullable(),
});
export type HostMonitorSummary = z.infer<typeof hostMonitorSummarySchema>;

/** GET /api/monitoring -> 200 */
export const monitoringOverviewSchema = z.object({
  /** Seconds between probes (`HEALTHCHECK_INTERVAL_SECONDS`, 0 = off). */
  intervalSeconds: z.number().int(),
  retentionDays: z.number().int(),
  hosts: z.array(hostMonitorSummarySchema),
});
export type MonitoringOverview = z.infer<typeof monitoringOverviewSchema>;

/** A time slice of the history. */
export const monitorBucketSchema = z.object({
  start: z.string(),
  /** Probes in the slice (0 = no data). */
  checks: z.number().int(),
  up: z.number().int(),
  avgLatencyMs: z.number().int().nullable(),
  maxLatencyMs: z.number().int().nullable(),
});
export type MonitorBucket = z.infer<typeof monitorBucketSchema>;

/** Consecutive failed probes. */
export const incidentSchema = z.object({
  start: z.string(),
  /** First successful probe after it; null while it lasts. */
  end: z.string().nullable(),
  durationSeconds: z.number().int(),
  /** Error of the first failed probe. */
  error: z.string().nullable(),
});
export type Incident = z.infer<typeof incidentSchema>;

/** GET /api/monitoring/hosts/:id?range=24h|7d|30d -> 200 */
export const hostMonitorDetailSchema = z.object({
  summary: hostMonitorSummarySchema,
  range: monitoringRangeSchema,
  /** Uptime over the range. */
  uptime: ratio,
  buckets: z.array(monitorBucketSchema),
  /** Newest first, at most 50. */
  incidents: z.array(incidentSchema),
});
export type HostMonitorDetail = z.infer<typeof hostMonitorDetailSchema>;

/** POST /api/monitoring/hosts/:id/badge -> 200 (creates or replaces the badge URL) */
export const badgeResponseSchema = z.object({ badgeToken: z.string() });
export type BadgeResponse = z.infer<typeof badgeResponseSchema>;

/** Query parameters of the public badge. */
export const badgeQuerySchema = z.object({
  /** Text on the left; default: the hostname. */
  label: z.string().trim().min(1).max(40).optional(),
  /** `soil` (dark, default) or `chalk` (light). */
  theme: z.enum(['soil', 'chalk']).default('soil'),
});
export type BadgeQuery = z.infer<typeof badgeQuerySchema>;
