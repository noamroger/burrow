import type { BackupRun, BackupStatus } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { userId } from '../http/session.js';

/** Scheduled SQLite backups. Behind `requireAuth`. */
export async function backupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/backups', async (): Promise<BackupStatus> => ctx.backups.status());

  app.put('/api/backups/settings', async (req): Promise<BackupStatus> => {
    ctx.backups.save(req.body);
    ctx.audit.record(userId(req), 'backup.settings');
    return ctx.backups.status();
  });

  /** Back up now. 200 even when it failed: `ok` and `error` say what happened. */
  app.post('/api/backups', async (req): Promise<BackupRun> => {
    ctx.audit.record(userId(req), 'backup.run');
    return ctx.backups.run();
  });

  app.get<{ Params: { name: string } }>('/api/backups/:name', async (req, reply) => {
    const data = await ctx.backups.read(req.params.name);
    ctx.audit.record(userId(req), 'backup.download', req.params.name);
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${req.params.name}"`)
      .header('cache-control', 'no-store')
      .send(data);
  });
}
