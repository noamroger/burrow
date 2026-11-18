import {
  changePasswordSchema,
  createAdminSchema,
  loginSchema,
  type MeResponse,
  type SetupStatus,
} from '@burrow/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import {
  assertCsrf,
  clearSessionCookie,
  requireAuth,
  SESSION_COOKIE,
  setSessionCookie,
  userId,
} from '../http/session.js';

/** Login and setup attempts allowed per IP and minute. */
const LOGIN_RATE_LIMIT = { max: 5, timeWindow: '1 minute' };

/** Setup, login, logout, current user and password change. */
export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const startSession = (
    req: FastifyRequest,
    reply: FastifyReply,
    user: { id: number; email: string },
  ): MeResponse => {
    ctx.auth.deleteSession(req.cookies[SESSION_COOKIE]); // rotate on login
    const session = ctx.auth.createSession(user.id);
    setSessionCookie(ctx, req, reply, session.cookieValue, session.expiresAt);
    return { user: { id: user.id, email: user.email }, csrfToken: session.csrfToken };
  };

  app.get('/api/setup/status', async (): Promise<SetupStatus> => {
    const cloudflareConfigured = ctx.cloudflare.isConfigured();
    return {
      userCreated: ctx.auth.hasUser(),
      cloudflareConfigured,
      tunnelReady: cloudflareConfigured && ctx.tunnels.stored() !== null,
    };
  });

  app.post('/api/setup/admin', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const input = createAdminSchema.parse(req.body);
    const user = await ctx.auth.createAdmin(input.email, input.password);
    ctx.audit.record(user.id, 'setup.admin', user.email);
    req.log.info({ userId: user.id }, 'admin account created');
    return reply.status(201).send(startSession(req, reply, user));
  });

  app.post('/api/auth/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const user = await ctx.auth.login(input.email, input.password);
    ctx.audit.record(user.id, 'auth.login');
    return reply.send(startSession(req, reply, user));
  });

  app.post('/api/auth/logout', async (req, reply) => {
    assertCsrf(req);
    ctx.auth.deleteSession(req.cookies[SESSION_COOKIE]);
    clearSessionCookie(ctx, req, reply);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireAuth(ctx) }, async (req): Promise<MeResponse> => {
    const auth = req.auth!;
    return { user: auth.user, csrfToken: auth.session.csrfToken };
  });

  app.post(
    '/api/auth/password',
    { preHandler: requireAuth(ctx), config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (req, reply) => {
      const input = changePasswordSchema.parse(req.body);
      await ctx.auth.changePassword(
        userId(req),
        input.currentPassword,
        input.newPassword,
        req.auth!.session.id,
      );
      ctx.audit.record(userId(req), 'auth.password');
      return reply.status(204).send();
    },
  );
}
