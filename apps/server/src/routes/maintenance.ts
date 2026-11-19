import { maintenancePageSchema, type MaintenancePage, type ProxyHost } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor } from '../http/session.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Pages can carry an uploaded logo: allow bigger bodies on these routes. */
const BODY_LIMIT = 1024 * 1024;

/** Maintenance mode. Behind `requireAuth`. */
export async function maintenanceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/maintenance/page', async (): Promise<MaintenancePage> =>
    ctx.maintenance.defaultPage(),
  );

  app.put(
    '/api/maintenance/page',
    { bodyLimit: BODY_LIMIT },
    async (req): Promise<MaintenancePage> =>
      ctx.maintenance.saveDefaultPage(maintenancePageSchema.parse(req.body), actor(req)),
  );

  app.put(
    '/api/hosts/:id/maintenance',
    { bodyLimit: BODY_LIMIT },
    async (req): Promise<ProxyHost> => {
      const { id } = idParams.parse(req.params);
      return ctx.maintenance.setHost(id, req.body as never, actor(req));
    },
  );
}
