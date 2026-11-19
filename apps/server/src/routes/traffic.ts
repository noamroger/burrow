import { monitoringRangeSchema, type HostTraffic, type TrafficOverview } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const rangeQuery = z.object({ range: monitoringRangeSchema.default('24h') });

/** Traffic statistics from Cloudflare Analytics. Behind `requireAuth`. */
export async function trafficRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/traffic', async (): Promise<TrafficOverview> => ctx.traffic.overview());

  app.get('/api/traffic/hosts/:id', async (req): Promise<HostTraffic> => {
    const { id } = idParams.parse(req.params);
    const { range } = rangeQuery.parse(req.query);
    return ctx.traffic.host(id, range);
  });
}
