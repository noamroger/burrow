import {
  badgeQuerySchema,
  monitoringRangeSchema,
  type BadgeResponse,
  type HostMonitorDetail,
  type MonitoringOverview,
} from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor } from '../http/session.js';
import { renderBadge } from '../services/badge.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const rangeQuery = z.object({ range: monitoringRangeSchema.default('24h') });

/** Uptime history and badge management. Behind `requireAuth`. */
export async function monitoringRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/monitoring', async (): Promise<MonitoringOverview> => ctx.monitoring.overview());

  app.get('/api/monitoring/hosts/:id', async (req): Promise<HostMonitorDetail> => {
    const { id } = idParams.parse(req.params);
    const { range } = rangeQuery.parse(req.query);
    return ctx.monitoring.detail(id, range);
  });

  app.post('/api/monitoring/hosts/:id/badge', async (req): Promise<BadgeResponse> => {
    const { id } = idParams.parse(req.params);
    const badgeToken = ctx.monitoring.enableBadge(id);
    ctx.audit.record(actor(req), 'badge.enable', String(id));
    return { badgeToken };
  });

  app.delete('/api/monitoring/hosts/:id/badge', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    ctx.monitoring.disableBadge(id);
    ctx.audit.record(actor(req), 'badge.disable', String(id));
    return reply.status(204).send();
  });
}

/**
 * Public status badge: `GET /api/badge/<token>` (or `<token>.svg`). Anyone
 * with the URL sees the hostname (or the `label`), the status and the
 * 30-day uptime; nothing else. Embeddable from any site.
 */
export async function badgeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { token: string } }>('/api/badge/:token', async (req, reply) => {
    const token = req.params.token.replace(/\.svg$/, '');
    const parsed = badgeQuerySchema.safeParse(req.query);
    const query = parsed.success ? parsed.data : { theme: 'soil' as const, label: undefined };
    const data = ctx.monitoring.badge(token);
    const svg = renderBadge(
      data
        ? { ...data, label: query.label ?? data.hostname, theme: query.theme }
        : {
            label: query.label ?? 'badge',
            state: 'unknown',
            uptime: null,
            hours: [],
            theme: query.theme,
          },
    );
    return reply
      .status(data ? 200 : 404)
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=60, s-maxage=60')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(svg);
  });
}
