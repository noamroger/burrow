import secureJson from 'secure-json-parse';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './context.js';
import { registerErrorHandler } from './http/errors.js';
import { buildOpenApi } from './http/openapi.js';
import { registerSession, requireAuth } from './http/session.js';
import { AppError } from './lib/errors.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { cloudflareRoutes } from './routes/cloudflare.js';
import { configRoutes } from './routes/config.js';
import { backupRoutes } from './routes/backups.js';
import { dockerRoutes } from './routes/docker.js';
import { driftRoutes } from './routes/drift.js';
import { healthRoutes } from './routes/health.js';
import { homeRoutes, homepageSettingsRoutes } from './routes/homepage.js';
import { hostRoutes } from './routes/hosts.js';
import { logRoutes } from './routes/logs.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { badgeRoutes, monitoringRoutes } from './routes/monitoring.js';
import { notificationRoutes } from './routes/notifications.js';
import { trafficRoutes } from './routes/traffic.js';
import { tokenRoutes } from './routes/tokens.js';
import { tunnelRoutes } from './routes/tunnel.js';
import { twoFactorRoutes } from './routes/two-factor.js';

/** Fastify takes a hop count as a function; booleans and address lists as-is. */
function toTrustProxy(
  value: boolean | number | string,
): boolean | string | ((addr: string, hop: number) => boolean) {
  if (typeof value === 'number') return (_addr, hop) => hop < value;
  return value;
}

/** What the homepage's public hostname may reach: the page, its assets, its data, badges. */
const HOMEPAGE_HOST_PATHS = [
  /^\/home\/?$/,
  /^\/assets\/[\w.-]+$/,
  /^\/(favicon\.svg|logo\.svg|theme-init\.js)$/,
  /^\/api\/home$/,
  /^\/api\/home\/icons\/\d+$/,
  /^\/api\/badge\/[\w-]+(\.svg)?$/,
];

/**
 * Requests for the homepage's public hostname (Settings › Homepage) only
 * reach the homepage: the admin UI and the rest of the API answer 404 there,
 * whatever the session.
 */
function restrictHomepageHostname(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onRequest', async (req, reply) => {
    const hostname = ctx.homepage.publicHostname();
    if (!hostname || req.hostname.toLowerCase() !== hostname) return;
    const path = req.url.split('?')[0]!;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/') return reply.redirect('/home', 302);
      if (HOMEPAGE_HOST_PATHS.some((re) => re.test(path))) return;
    }
    return reply.status(404).type('text/plain').send('Not found');
  });
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
  restrictHomepageHostname(app, ctx);

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

  // API documentation (public: it describes the open source API, no data).
  await app.register(swagger, {
    mode: 'static',
    specification: { document: buildOpenApi(ctx.version) as never },
  });
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    staticCSP: true,
    // Burrow is often opened over plain HTTP on the LAN: never upgrade to HTTPS,
    // and never call the public validator.
    transformStaticCSP: (header) =>
      header.replace(/\s*upgrade-insecure-requests;?/, '').replace(' validator.swagger.io', ''),
    theme: { title: 'Burrow API' },
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      tryItOutEnabled: false,
      validatorUrl: null,
    },
  });
  app.get('/api/openapi.json', { config: { rateLimit: false } }, async () => app.swagger());

  // Public routes.
  await app.register(async (scope) => {
    await healthRoutes(scope, ctx);
    await authRoutes(scope, ctx);
    await badgeRoutes(scope, ctx);
    await homeRoutes(scope, ctx);
  });

  // Everything else requires a session (and the CSRF header on mutations).
  await app.register(async (scope) => {
    scope.addHook('preHandler', requireAuth(ctx));
    await cloudflareRoutes(scope, ctx);
    await hostRoutes(scope, ctx);
    await tunnelRoutes(scope, ctx);
    await logRoutes(scope, ctx);
    await configRoutes(scope, ctx);
    await driftRoutes(scope, ctx);
    await backupRoutes(scope, ctx);
    await dockerRoutes(scope, ctx);
    await maintenanceRoutes(scope, ctx);
    await monitoringRoutes(scope, ctx);
    await notificationRoutes(scope, ctx);
    await trafficRoutes(scope, ctx);
    await homepageSettingsRoutes(scope, ctx);
    await tokenRoutes(scope, ctx);
    await twoFactorRoutes(scope, ctx);
    await auditRoutes(scope, ctx);
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
