import {
  changePasswordSchema,
  createAdminSchema,
  loginSchema,
  passkeyLoginOptionsInputSchema,
  passkeyLoginVerifySchema,
  verifyLoginSchema,
  type LoginResponse,
  type MeResponse,
  type PasskeyOptions,
  type SetupStatus,
} from '@burrow/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { Actor } from '../services/audit.js';
import {
  actor,
  assertCsrf,
  clearSessionCookie,
  requireAuth,
  requireSession,
  SESSION_COOKIE,
  setSessionCookie,
  userId,
  webAuthnOrigin,
} from '../http/session.js';

/** The user signing in, for the audit log. */
const loginActor = (req: FastifyRequest, user: { id: number; email: string }): Actor => ({
  userId: user.id,
  label: user.email,
  ip: req.ip,
});

/** Login and setup attempts allowed per IP and minute. */
const LOGIN_RATE_LIMIT = { max: 5, timeWindow: '1 minute' };

/** Setup, login (with the optional second factor), logout, current user and password change. */
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
    ctx.audit.record(loginActor(req, user), 'setup.admin', user.email);
    req.log.info({ userId: user.id }, 'admin account created');
    return reply.status(201).send(startSession(req, reply, user));
  });

  app.post('/api/auth/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const user = await ctx.auth.login(input.email, input.password);
    const methods = ctx.twoFactor.methods(user.id);
    if (methods.length > 0) {
      const body: LoginResponse = {
        mfaRequired: true,
        ticket: ctx.twoFactor.createTicket(user.id),
        methods,
      };
      return reply.send(body);
    }
    ctx.audit.record(loginActor(req, user), 'auth.login', null, { details: { note: 'password' } });
    return reply.send(startSession(req, reply, user));
  });

  /** Second step: a code from the authenticator app, or a recovery code. */
  app.post(
    '/api/auth/login/verify',
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (req, reply) => {
      const input = verifyLoginSchema.parse(req.body);
      const { userId: id, method } = ctx.twoFactor.verifyTicketCode(input.ticket, input.code);
      const user = ctx.auth.findUser(id);
      ctx.audit.record(loginActor(req, user), 'auth.login', null, {
        details: { note: method === 'recovery' ? 'password + recovery code' : 'password + TOTP' },
      });
      return reply.send(startSession(req, reply, user));
    },
  );

  /** Passkey sign-in, after the password (with `ticket`) or on its own. */
  app.post(
    '/api/auth/passkey/options',
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (req): Promise<PasskeyOptions> => {
      const input = passkeyLoginOptionsInputSchema.parse(req.body ?? {});
      return ctx.twoFactor.loginOptions(webAuthnOrigin(req), input.ticket);
    },
  );

  app.post(
    '/api/auth/passkey/verify',
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (req, reply) => {
      const input = passkeyLoginVerifySchema.parse(req.body);
      const id = await ctx.twoFactor.verifyLogin(
        input.challengeId,
        input.response,
        webAuthnOrigin(req),
      );
      const user = ctx.auth.findUser(id);
      ctx.audit.record(loginActor(req, user), 'auth.login', null, {
        details: { note: 'passkey' },
      });
      return reply.send(startSession(req, reply, user));
    },
  );

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
      requireSession(req);
      const input = changePasswordSchema.parse(req.body);
      await ctx.auth.changePassword(
        userId(req),
        input.currentPassword,
        input.newPassword,
        req.auth!.session.id,
      );
      ctx.audit.record(actor(req), 'auth.password');
      return reply.status(204).send();
    },
  );
}
