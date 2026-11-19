import { auditQuerySchema, type AuditPage, type AuditUndoResult } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor } from '../http/session.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Audit log and undo. Behind `requireAuth`. */
export async function auditRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/audit', async (req): Promise<AuditPage> =>
    ctx.audit.list(auditQuerySchema.parse(req.query)),
  );

  app.post('/api/audit/:id/undo', async (req): Promise<AuditUndoResult> => {
    const { id } = idParams.parse(req.params);
    return ctx.undo.undo(id, actor(req));
  });
}
