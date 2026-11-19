import type { Channel, ChannelList, ChannelTestResult } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor } from '../http/session.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Notification channels. Behind `requireAuth`. */
export async function notificationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/notifications', async (): Promise<ChannelList> => ({
    channels: ctx.notifications.list(),
  }));

  app.post('/api/notifications/channels', async (req, reply) => {
    const channel = ctx.notifications.create(req.body);
    ctx.audit.record(actor(req), 'notification.create', channel.name);
    return reply.status(201).send(channel);
  });

  app.put('/api/notifications/channels/:id', async (req): Promise<Channel> => {
    const { id } = idParams.parse(req.params);
    const channel = ctx.notifications.update(id, req.body);
    ctx.audit.record(actor(req), 'notification.update', channel.name);
    return channel;
  });

  app.delete('/api/notifications/channels/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    ctx.notifications.remove(id);
    ctx.audit.record(actor(req), 'notification.delete', String(id));
    return reply.status(204).send();
  });

  /** 200 even when delivery failed: `ok` and `error` say what happened. */
  app.post('/api/notifications/channels/:id/test', async (req): Promise<ChannelTestResult> => {
    const { id } = idParams.parse(req.params);
    return ctx.notifications.test(id);
  });
}
