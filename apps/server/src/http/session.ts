import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { safeEqual, type AuthenticatedSession } from '../services/auth.js';
import type { WebAuthnOrigin } from '../services/two-factor.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The current session, resolved from the cookie for every `/api` request. */
    auth: AuthenticatedSession | null;
  }
}

export const SESSION_COOKIE = 'burrow_session';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function secureCookie(ctx: AppContext, req: FastifyRequest): boolean {
  if (ctx.config.secureCookies === 'true') return true;
  if (ctx.config.secureCookies === 'false') return false;
  return req.protocol === 'https';
}

/** Send the session cookie (HttpOnly, SameSite=Strict, Secure on HTTPS). */
export function setSessionCookie(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  value: string,
  expires: Date,
): void {
  reply.setCookie(SESSION_COOKIE, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie(ctx, req),
    expires,
  });
}

export function clearSessionCookie(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie(ctx, req),
  });
}

/** Resolve `request.auth` from the session cookie on every API request. */
export function registerSession(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (/^Bearer\s+burrow_/i.test(req.headers.authorization ?? '')) {
      // API tokens never fall back to the cookie: a wrong token is a 401.
      // Other Authorization headers (e.g. Basic auth of a reverse proxy) are ignored.
      req.auth = ctx.apiTokens.authenticate(req.headers.authorization);
      return;
    }
    const value = req.cookies[SESSION_COOKIE];
    const auth = ctx.auth.getSession(value);
    req.auth = auth;
    if (auth?.renewedUntil && value) setSessionCookie(ctx, req, reply, value, auth.renewedUntil);
  });
}

/** Throws unless the request carries the session's CSRF token. */
export function assertCsrf(req: FastifyRequest): void {
  // Browsers never attach an Authorization header on their own: no CSRF risk.
  if (SAFE_METHODS.has(req.method) || !req.auth || req.auth.via === 'token') return;
  const header = req.headers[CSRF_HEADER];
  if (typeof header !== 'string' || !safeEqual(header, req.auth.session.csrfToken)) {
    throw new AppError(
      'CSRF_INVALID',
      'Missing or invalid CSRF token. Reload the page and try again.',
      403,
    );
  }
}

/**
 * preHandler for protected routes: a valid session, plus the CSRF header on
 * mutating requests. Before setup, answers `SETUP_REQUIRED`.
 */
export function requireAuth(ctx: AppContext) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.auth) {
      if (!ctx.auth.hasUser()) {
        throw new AppError('SETUP_REQUIRED', 'Create the admin account first.', 401);
      }
      throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
    }
    assertCsrf(req);
  };
}

/** Refuse API tokens on routes reserved to a signed-in browser (tokens, password). */
export function requireSession(req: FastifyRequest): void {
  if (req.auth?.via === 'token') {
    throw new AppError('FORBIDDEN', 'Sign in to the web UI to do this; API tokens cannot.', 403);
  }
}

/**
 * The host name passkeys are bound to (WebAuthn RP ID) and the origins the
 * browser may report, taken from the request: Burrow is reached on whatever
 * address the admin uses (LAN IP, local name, public hostname).
 */
export function webAuthnOrigin(req: FastifyRequest): WebAuthnOrigin {
  const host = req.host;
  return { rpId: req.hostname, origins: [`https://${host}`, `http://${host}`] };
}

/** The authenticated user id (only call behind {@link requireAuth}). */
export function userId(req: FastifyRequest): number {
  if (!req.auth) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
  return req.auth.user.id;
}
