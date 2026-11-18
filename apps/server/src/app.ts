import secureJson from 'secure-json-parse';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './context.js';
import { registerErrorHandler } from './http/errors.js';
import { registerSession, requireAuth } from './http/session.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { cloudflareRoutes } from './routes/cloudflare.js';
import { healthRoutes } from './routes/health.js';
import { hostRoutes } from './routes/hosts.js';
import { logRoutes } from './routes/logs.js';
import { tunnelRoutes } from './routes/tunnel.js';

/** Fastify takes a hop count as a function; booleans and address lists as-is. */
function toTrustProxy(
  value: boolean | number | string,
): boolean | string | ((addr: string, hop: number) => boolean) {
  if (typeof value === 'number') return (_addr, hop) => hop < value;
  return value;
}

export interface BuildAppOptions {
  /** Global API rate limit per IP and minute (default 300). */
  apiRateLimit?: number;
}

/**
 * Build the Fastify application around an {@link AppContext}.
 * Pure factory: does not listen and does not start background jobs, so tests
 * can drive it with `app.inject()`.
 */
export async function buildApp(
  ctx: AppContext,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.logger as FastifyBaseLogger,
    trustProxy: toTrustProxy(ctx.config.trustProxy),
    bodyLimit: 64 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/health')) return;
    req.log.debug({ method: req.method, url: req.url, status: reply.statusCode }, 'request');
  });

  registerErrorHandler(app);

  // Accept an empty JSON body (e.g. `curl -X POST -H 'content-type: application/json'`)
  // so scripted calls to bodiless endpoints like POST /api/sync just work.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(
        null,
        secureJson.parse(text, undefined, { protoAction: 'error', constructorAction: 'error' }),
      );
    } catch {
      const err = new Error('Request body is not valid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(helmet, {
    hsts: false, // TLS is terminated by Cloudflare or your own proxy
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: options.apiRateLimit ?? 300,
    timeWindow: '1 minute',
    allowList: (req) => !req.url.startsWith('/api/'),
    errorResponseBuilder: (_req, context) =>
      new AppError(
        'RATE_LIMITED',
        `Too many requests. Try again in ${context.after}.`,
        context.statusCode,
      ),
  });

  registerSession(app, ctx);

  // Public routes.
  await app.register(async (scope) => {
    await healthRoutes(scope, ctx);
    await authRoutes(scope, ctx);
  });

  // Everything else requires a session (and the CSRF header on mutations).
  await app.register(async (scope) => {
    scope.addHook('preHandler', requireAuth(ctx));
    await cloudflareRoutes(scope, ctx);
    await hostRoutes(scope, ctx);
    await tunnelRoutes(scope, ctx);
    await logRoutes(scope, ctx);
  });

  const webRoot = ctx.config.webDistDir;
  const hasWeb = existsSync(join(webRoot, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      setHeaders: (reply, path) => {
        reply.header(
          'cache-control',
          path.includes(`${join('/', 'assets', '/')}`)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    });
  } else {
    ctx.logger.warn({ webRoot }, 'web UI not found: only the API is served');
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (
      req.url.startsWith('/api/') ||
      req.url === '/api' ||
      (req.method !== 'GET' && req.method !== 'HEAD')
    ) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Route ${req.method} ${req.url.split('?')[0]} not found`,
        },
      });
    }
    if (!hasWeb) {
      return reply
        .status(404)
        .type('text/plain')
        .send('Burrow web UI is not built. The API is available under /api.');
    }
    // SPA fallback: client-side routes are served index.html.
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });

  return app;
}
