import { dockerSettingsSchema, type DockerStatus } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { userId } from '../http/session.js';

/** Docker auto-discovery. Behind `requireAuth`. */
export async function dockerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/docker', async (): Promise<DockerStatus> => ctx.docker.status());

  app.post('/api/docker/scan', async (): Promise<DockerStatus> => ctx.docker.scan());

  app.put('/api/docker/settings', async (req): Promise<DockerStatus> => {
    const { enabled } = dockerSettingsSchema.parse(req.body);
    ctx.audit.record(userId(req), enabled ? 'docker.discovery.on' : 'docker.discovery.off');
    return ctx.docker.setEnabled(enabled);
  });
}
