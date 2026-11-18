import type { LogLine, LogList } from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { SupervisorStatus } from '../services/supervisor.js';

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(2000).default(500) });
const streamQuery = z.object({ lastEventId: z.coerce.number().int().min(0).optional() });

/** cloudflared logs: snapshot and live stream (SSE). Registered behind `requireAuth`. */
export async function logRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
    streams.clear();
  });

  app.get('/api/logs', async (req): Promise<LogList> => {
    const { limit } = listQuery.parse(req.query);
    return { lines: ctx.logs.recent(limit) };
  });

  /**
   * Server-Sent Events. Resume with the `Last-Event-ID` header (sent by
   * EventSource on reconnect) or `?lastEventId=<seq>` on the first connection.
   */
  app.get('/api/logs/stream', async (req, reply) => {
    const header = req.headers['last-event-id'];
    const { lastEventId: fromQuery } = streamQuery.parse(req.query);
    const fromHeader =
      typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : undefined;
    const resumeFrom = fromHeader ?? fromQuery;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    streams.add(res);

    const sendLine = (line: LogLine) =>
      res.write(`id: ${line.seq}\nevent: log\ndata: ${JSON.stringify(line)}\n\n`);
    const sendState = (state: SupervisorStatus) =>
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);

    res.write('retry: 3000\n\n');
    sendState(ctx.supervisor.status());
    if (resumeFrom !== undefined) ctx.logs.since(resumeFrom).forEach(sendLine);

    ctx.logs.on('line', sendLine);
    ctx.supervisor.on('state', sendState);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);

    const cleanup = () => {
      clearInterval(ping);
      ctx.logs.off('line', sendLine);
      ctx.supervisor.off('state', sendState);
      streams.delete(res);
    };
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
  });
}
