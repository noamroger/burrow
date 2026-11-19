import { configImportSchema, type ConfigImportReport } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { userId } from '../http/session.js';
import { errors } from '../lib/errors.js';

/** Configuration export and import. Registered behind `requireAuth`. */
export async function configRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/config/export', async (req, reply) => {
    const doc = ctx.configIo.export();
    ctx.audit.record(userId(req), 'config.export');
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-disposition', `attachment; filename="burrow-config-${day}.json"`)
      .send(doc);
  });

  app.post(
    '/api/config/import',
    { bodyLimit: 5 * 1024 * 1024 },
    async (req): Promise<ConfigImportReport> => {
      if (!ctx.cloudflare.isConfigured()) throw errors.cloudflareNotConfigured();
      const input = configImportSchema.parse(req.body);
      const report = await ctx.configIo.import(input.config, input.mode, input.dryRun);
      if (!input.dryRun) ctx.audit.record(userId(req), `config.import.${input.mode}`);
      return report;
    },
  );
}
