import { driftSettingsSchema, resolveDriftSchema, type DriftReport } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { userId } from '../http/session.js';
import { errors } from '../lib/errors.js';

/** Drift detection: differences between Cloudflare and Burrow. Behind `requireAuth`. */
export async function driftRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/drift', async (): Promise<DriftReport> => ctx.drift.last());

  app.post('/api/drift/check', async (): Promise<DriftReport> => {
    if (!ctx.cloudflare.isConfigured()) throw errors.cloudflareNotConfigured();
    return ctx.drift.check();
  });

  app.post('/api/drift/resolve', async (req): Promise<DriftReport> => {
    if (!ctx.cloudflare.isConfigured()) throw errors.cloudflareNotConfigured();
    const { strategy } = resolveDriftSchema.parse(req.body);
    ctx.audit.record(userId(req), `drift.${strategy}`);
    return ctx.drift.resolve(strategy);
  });

  app.put('/api/drift/settings', async (req): Promise<DriftReport> => {
    const { autoRepair } = driftSettingsSchema.parse(req.body);
    ctx.audit.record(userId(req), autoRepair ? 'drift.autorepair.on' : 'drift.autorepair.off');
    return ctx.drift.setAutoRepair(autoRepair);
  });
}
