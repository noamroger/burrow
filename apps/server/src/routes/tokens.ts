import { createApiTokenSchema, type ApiTokenList } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireSession, userId } from '../http/session.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Personal API tokens. Only a signed-in browser session can manage them. */
export async function tokenRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/tokens', async (req): Promise<ApiTokenList> => {
    requireSession(req);
    return { tokens: ctx.apiTokens.list(userId(req)) };
  });

  app.post('/api/tokens', async (req, reply) => {
    requireSession(req);
    const { name } = createApiTokenSchema.parse(req.body);
    const created = ctx.apiTokens.create(userId(req), name);
    ctx.audit.record(userId(req), 'token.create', name);
    return reply.status(201).send(created);
  });

  app.delete('/api/tokens/:id', async (req, reply) => {
    requireSession(req);
    const { id } = idParams.parse(req.params);
    const row = ctx.apiTokens.remove(userId(req), id);
    ctx.audit.record(userId(req), 'token.delete', row.name);
    return reply.status(204).send();
  });
}
