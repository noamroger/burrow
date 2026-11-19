import { dockerSettingsSchema, type DockerStatus } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { actor } from '../http/session.js';

/** Docker auto-discovery. Behind `requireAuth`. */
export async function dockerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/docker', async (): Promise<DockerStatus> => ctx.docker.status());

  app.post('/api/docker/scan', async (): Promise<DockerStatus> => ctx.docker.scan());

  app.put('/api/docker/settings', async (req): Promise<DockerStatus> => {
    const { enabled } = dockerSettingsSchema.parse(req.body);
    const was = ctx.docker.status().enabled;
    const status = await ctx.docker.setEnabled(enabled);
    if (was !== enabled) {
      ctx.audit.record(actor(req), enabled ? 'docker.discovery.on' : 'docker.discovery.off', null, {
        undo: { kind: 'docker.enabled', enabled: was },
      });
    }
    return status;
  });
}
