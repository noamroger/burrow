/**
 * Per-host traffic, read from the Cloudflare GraphQL Analytics API
 * (`httpRequestsAdaptiveGroups`, visitor requests only). Needs the optional
 * token permission Zone › Analytics › Read. Cloudflare samples this data, so
 * numbers are close estimates; every plan keeps at least 30 days.
 */
import { z } from 'zod';
import { monitoringRangeSchema } from './monitoring.js';

export const trafficPointSchema = z.object({
  start: z.string(),
  requests: z.number().int(),
  bytes: z.number(),
  visits: z.number().int(),
});
export type TrafficPoint = z.infer<typeof trafficPointSchema>;

/** GET /api/traffic/hosts/:id?range=24h|7d|30d -> 200 */
export const hostTrafficSchema = z.object({
  hostId: z.number().int(),
  hostname: z.string(),
  range: monitoringRangeSchema,
  totals: z.object({ requests: z.number().int(), bytes: z.number(), visits: z.number().int() }),
  /** Hourly (24h, 7d) or daily (30d) points, oldest first, gaps filled with zeros. */
  series: z.array(trafficPointSchema),
  /** Requests by response status class. */
  statuses: z.object({
    '2xx': z.number().int(),
    '3xx': z.number().int(),
    '4xx': z.number().int(),
    '5xx': z.number().int(),
  }),
  topCountries: z.array(z.object({ country: z.string(), requests: z.number().int() })),
  fetchedAt: z.string(),
});
export type HostTraffic = z.infer<typeof hostTrafficSchema>;

/** GET /api/traffic -> 200: requests and bandwidth of every host over 24 hours. */
export const trafficOverviewSchema = z.object({
  hosts: z.array(
    z.object({
      hostId: z.number().int(),
      hostname: z.string(),
      requests: z.number().int(),
      bytes: z.number(),
    }),
  ),
  /** Set when the analytics could not be read (missing permission…); hosts is then empty. */
  error: z.string().nullable(),
  fetchedAt: z.string(),
});
export type TrafficOverview = z.infer<typeof trafficOverviewSchema>;
