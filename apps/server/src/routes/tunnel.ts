import {
  createTunnelSchema,
  importTunnelSchema,
  updateTunnelSchema,
  type AvailableTunnelList,
  type ImportTunnelResult,
  type SyncResult,
  type TunnelInfo,
  type TunnelList,
  type TunnelSummary,
} from '@burrow/shared';
import { count } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { proxyHosts, type TunnelRow } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { userId } from '../http/session.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const deleteQuery = z.object({
  deleteOnCloudflare: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

/** Tunnels, cloudflared control and reconciliation. Registered behind `requireAuth`. */
export async function tunnelRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const hostCounts = () =>
    new Map(
      ctx.db
        .select({ tunnelId: proxyHosts.tunnelId, n: count() })
        .from(proxyHosts)
        .groupBy(proxyHosts.tunnelId)
        .all()
        .map((r) => [r.tunnelId, r.n]),
    );

  const summary = (
    row: TunnelRow,
    statuses: Map<string, TunnelSummary['status']>,
    counts = hostCounts(),
  ): TunnelSummary => ({
    id: row.id,
    cfId: row.cfId,
    name: row.name,
    origin: row.origin,
    runConnector: row.runConnector,
    isDefault: row.isDefault,
    hostCount: counts.get(row.id) ?? 0,
    status: statuses.get(row.cfId) ?? 'unknown',
    supervisor: ctx.supervisors.status(row.id),
  });

  const requireConfigured = () => {
    if (!ctx.cloudflare.isConfigured()) throw errors.cloudflareNotConfigured();
  };

  /* ---- default tunnel (v0.1 routes, kept for scripts) ---- */

  app.get('/api/tunnel', async (): Promise<TunnelInfo> => ({
    ...(await ctx.tunnels.info()),
    supervisor: ctx.supervisors.defaultStatus(),
  }));

  const control = (
    req: FastifyRequest,
    reply: FastifyReply,
    action: 'start' | 'stop' | 'restart',
    row: TunnelRow | undefined,
  ) => {
    if (action !== 'stop') requireConfigured();
    if (!row) throw errors.notFound('Tunnel');
    if (!row.runConnector && action !== 'stop') {
      throw errors.validation(
        'Burrow does not run a connector for this tunnel. Turn on "Run cloudflared in Burrow" first.',
      );
    }
    const supervisor = ctx.supervisors.get(row.id);
    ctx.audit.record(userId(req), `tunnel.${action}`, row.name);
    if (supervisor) {
      const run =
        action === 'start'
          ? supervisor.start()
          : action === 'stop'
            ? supervisor.stop()
            : supervisor.restart();
      // Do not wait for cloudflared to connect: progress is visible over SSE.
      run.catch((err: unknown) => req.log.warn({ err }, `tunnel ${action} failed`));
    }
    return reply.status(202).send(ctx.supervisors.status(row.id));
  };

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/tunnel/${action}`, async (req, reply) =>
      control(req, reply, action, ctx.tunnels.getDefault()),
    );
    app.post(`/api/tunnels/:id/${action}`, async (req, reply) => {
      const { id } = idParams.parse(req.params);
      return control(req, reply, action, ctx.tunnels.find(id));
    });
  }

  /* ---- several tunnels ---- */

  app.get('/api/tunnels', async (): Promise<TunnelList> => {
    const statuses = await ctx.tunnels.statuses();
    const counts = hostCounts();
    return { tunnels: ctx.tunnels.list().map((r) => summary(r, statuses, counts)) };
  });

  app.get('/api/tunnels/available', async (): Promise<AvailableTunnelList> => {
    requireConfigured();
    return { tunnels: await ctx.tunnels.listAvailable() };
  });

  app.get('/api/tunnels/:id', async (req): Promise<TunnelInfo> => {
    const { id } = idParams.parse(req.params);
    ctx.tunnels.get(id);
    return { ...(await ctx.tunnels.info(id)), supervisor: ctx.supervisors.status(id) };
  });

  app.post('/api/tunnels', async (req, reply) => {
    requireConfigured();
    const input = createTunnelSchema.parse(req.body);
    const row = await ctx.tunnels.create(input);
    ctx.audit.record(userId(req), 'tunnel.create', row.name);
    return reply.status(201).send(summary(row, await ctx.tunnels.statuses()));
  });

  app.post('/api/tunnels/import', async (req, reply) => {
    requireConfigured();
    const input = importTunnelSchema.parse(req.body);
    const { row } = await ctx.tunnels.import(input.cfId, input.runConnector);
    ctx.audit.record(userId(req), 'tunnel.import', row.name);
    let routes: ImportTunnelResult['routes'] = [];
    if (input.importRoutes) {
      const { client, accountId } = ctx.cloudflare.getContext();
      const config = await client.getTunnelConfiguration(accountId, row.cfId);
      routes = await ctx.hosts.importRoutes(row, config.config?.ingress ?? []);
      if (routes.some((r) => !r.skipped)) {
        // Adopt the CNAMEs and write Burrow's comment on them.
        await ctx.reconciler
          .sync()
          .catch((err: unknown) => req.log.warn({ err }, 'sync after import failed'));
      }
    }
    const result: ImportTunnelResult = {
      tunnel: summary(ctx.tunnels.get(row.id), await ctx.tunnels.statuses()),
      routes,
    };
    return reply.status(201).send(result);
  });

  app.patch('/api/tunnels/:id', async (req): Promise<TunnelSummary> => {
    const { id } = idParams.parse(req.params);
    const input = updateTunnelSchema.parse(req.body);
    const row = ctx.tunnels.update(id, input);
    ctx.audit.record(userId(req), 'tunnel.update', row.name);
    return summary(row, await ctx.tunnels.statuses());
  });

  app.delete('/api/tunnels/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { deleteOnCloudflare } = deleteQuery.parse(req.query);
    const row = ctx.tunnels.get(id);
    if (row.isDefault) {
      throw errors.conflict('This is the default tunnel. Make another tunnel the default first.');
    }
    const hosts = hostCounts().get(row.id) ?? 0;
    if (hosts > 0) {
      throw errors.conflict(
        `${hosts} proxy host(s) still use this tunnel. Move or delete them first.`,
      );
    }
    // Stop its connector, then clean up what Burrow wrote on it (routes, CNAMEs).
    ctx.tunnels.update(id, { runConnector: false });
    await ctx.supervisors.sync();
    if (ctx.cloudflare.isConfigured()) {
      await ctx.reconciler.sync();
      // Tunnels Burrow created are deleted by default; imported ones are only forgotten.
      if (deleteOnCloudflare ?? row.origin === 'created') {
        await ctx.tunnels.deleteOnCloudflare(row);
      }
    }
    ctx.tunnels.forget(id);
    ctx.audit.record(userId(req), 'tunnel.delete', row.name);
    return reply.status(204).send();
  });

  /* ---- sync ---- */

  app.get('/api/sync', async (): Promise<SyncResult> => ctx.reconciler.last());

  app.post('/api/sync', async (req): Promise<SyncResult> => {
    ctx.audit.record(userId(req), 'sync.run');
    const { result } = await ctx.reconciler.sync();
    return result;
  });
}
