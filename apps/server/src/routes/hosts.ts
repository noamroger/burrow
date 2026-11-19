import {
  proxyHostInputSchema,
  SERVICE_TEMPLATES,
  type OriginHealth,
  type ProxyHost,
  type ProxyHostList,
  type ServiceTemplateList,
} from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor } from '../http/session.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Proxy host CRUD. Registered behind `requireAuth`. */
export async function hostRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/templates', async (): Promise<ServiceTemplateList> => ({
    templates: [...SERVICE_TEMPLATES],
  }));

  app.get('/api/hosts', async (): Promise<ProxyHostList> => ({ hosts: ctx.hosts.list() }));

  app.get('/api/hosts/:id', async (req): Promise<ProxyHost> => {
    const { id } = idParams.parse(req.params);
    return ctx.hosts.get(id);
  });

  app.post('/api/hosts', async (req, reply) => {
    const input = proxyHostInputSchema.parse(req.body);
    const host = await ctx.hosts.create(input, actor(req));
    return reply.status(201).send(host);
  });

  app.put('/api/hosts/:id', async (req): Promise<ProxyHost> => {
    const { id } = idParams.parse(req.params);
    const input = proxyHostInputSchema.parse(req.body);
    return ctx.hosts.update(id, input, actor(req));
  });

  app.delete('/api/hosts/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await ctx.hosts.remove(id, actor(req));
    return reply.status(204).send();
  });

  app.post('/api/hosts/:id/check', async (req): Promise<OriginHealth> => {
    const { id } = idParams.parse(req.params);
    return ctx.hosts.check(id);
  });
}
