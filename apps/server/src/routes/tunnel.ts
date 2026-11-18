import type { SyncResult, TunnelInfo } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { errors } from '../lib/errors.js';
import { userId } from '../http/session.js';

/** Tunnel status, cloudflared control and reconciliation. Registered behind `requireAuth`. */
export async function tunnelRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/tunnel', async (): Promise<TunnelInfo> => ({
    ...(await ctx.tunnels.info()),
    supervisor: ctx.supervisor.status(),
  }));

  const control = (action: 'start' | 'stop' | 'restart') =>
    app.post(`/api/tunnel/${action}`, async (req, reply) => {
      if (action !== 'stop' && !ctx.cloudflare.isConfigured())
        throw errors.cloudflareNotConfigured();
      ctx.audit.record(userId(req), `tunnel.${action}`);
      const run =
        action === 'start'
          ? ctx.supervisor.start()
          : action === 'stop'
            ? ctx.supervisor.stop()
            : ctx.supervisor.restart();
      // Do not wait for cloudflared to connect: progress is visible over SSE.
      run.catch((err: unknown) => req.log.warn({ err }, `tunnel ${action} failed`));
      return reply.status(202).send(ctx.supervisor.status());
    });
  control('start');
  control('stop');
  control('restart');

  app.get('/api/sync', async (): Promise<SyncResult> => ctx.reconciler.last());

  app.post('/api/sync', async (req): Promise<SyncResult> => {
    ctx.audit.record(userId(req), 'sync.run');
    const { result } = await ctx.reconciler.sync();
    return result;
  });
}
