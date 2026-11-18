import type { HealthResponse } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';

/**
 * `GET /api/health`: public, used by the Docker HEALTHCHECK. Checks the
 * process and the database only: a Cloudflare outage must not make Docker
 * restart the container in a loop.
 */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', { config: { rateLimit: false } }, async (): Promise<HealthResponse> => {
    try {
      ctx.sqlite.prepare('SELECT 1').get();
    } catch {
      throw new AppError('INTERNAL_ERROR', 'Database unavailable', 503);
    }
    return {
      status: 'ok',
      version: ctx.version,
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
    };
  });
}
