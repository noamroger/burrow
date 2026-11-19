import {
  saveTokenSchema,
  updateZoneSchema,
  type CloudflareSettings,
  type ZoneList,
} from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor } from '../http/session.js';

/** Cloudflare token settings and zones. Registered behind `requireAuth`. */
export async function cloudflareRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/cloudflare', async (): Promise<CloudflareSettings> => ctx.cloudflare.getSettings());

  app.put('/api/cloudflare/token', async (req): Promise<CloudflareSettings> => {
    const input = saveTokenSchema.parse(req.body);
    const outcome = await ctx.cloudflare.saveToken(input);
    if (!outcome.saved) return outcome.settings;
    ctx.audit.record(actor(req), 'cloudflare.token.save', outcome.settings.account?.id);
    await ctx.lifecycle.onCloudflareConfigured(outcome.accountChanged);
    return ctx.cloudflare.getSettings();
  });

  app.delete('/api/cloudflare/token', async (req, reply) => {
    await ctx.lifecycle.onCloudflareRemoved();
    ctx.cloudflare.deleteToken();
    ctx.audit.record(actor(req), 'cloudflare.token.delete');
    return reply.status(204).send();
  });

  app.get('/api/zones', async (): Promise<ZoneList> => ({ zones: await ctx.zones.list() }));

  app.patch('/api/zones/:id', async (req) => {
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).parse(req.params);
    const { enabled } = updateZoneSchema.parse(req.body);
    const was = ctx.zones.getLocal(id)?.enabled ?? false;
    const zone = await ctx.zones.update(id, enabled);
    if (was !== enabled) {
      ctx.audit.record(actor(req), enabled ? 'zone.enable' : 'zone.disable', zone.name, {
        undo: { kind: 'zone.enabled', zoneId: id, enabled: was },
      });
    }
    return zone;
  });
}
