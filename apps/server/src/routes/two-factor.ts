import {
  confirmPasswordSchema,
  enableTotpSchema,
  registerPasskeySchema,
  renamePasskeySchema,
  type Passkey,
  type PasskeyOptions,
  type RecoveryCodes,
  type TotpSetup,
  type TwoFactorStatus,
} from '@burrow/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor, requireSession, userId, webAuthnOrigin } from '../http/session.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
/** Password confirmations are rate limited like the login. */
const CONFIRM_RATE_LIMIT = { max: 5, timeWindow: '1 minute' };

/**
 * Two-factor settings of the signed-in admin. Browser session only: an API
 * token can never change how the account signs in. Turning a factor off or
 * replacing the recovery codes asks for the password again.
 */
export async function twoFactorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/auth/2fa')) requireSession(req);
  });

  app.get('/api/auth/2fa', async (req): Promise<TwoFactorStatus> =>
    ctx.twoFactor.status(userId(req)),
  );

  app.post('/api/auth/2fa/totp/setup', async (req): Promise<TotpSetup> =>
    ctx.twoFactor.startTotpSetup(userId(req)),
  );

  app.post('/api/auth/2fa/totp/enable', async (req): Promise<RecoveryCodes> => {
    const { code } = enableTotpSchema.parse(req.body);
    const recoveryCodes = ctx.twoFactor.enableTotp(userId(req), code);
    ctx.audit.record(actor(req), 'auth.2fa.totp.enable');
    return { recoveryCodes };
  });

  app.post(
    '/api/auth/2fa/totp/disable',
    { config: { rateLimit: CONFIRM_RATE_LIMIT } },
    async (req, reply) => {
      const { password } = confirmPasswordSchema.parse(req.body);
      await ctx.auth.confirmPassword(userId(req), password);
      ctx.twoFactor.disableTotp(userId(req));
      ctx.audit.record(actor(req), 'auth.2fa.totp.disable');
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/auth/2fa/recovery-codes',
    { config: { rateLimit: CONFIRM_RATE_LIMIT } },
    async (req): Promise<RecoveryCodes> => {
      const { password } = confirmPasswordSchema.parse(req.body);
      await ctx.auth.confirmPassword(userId(req), password);
      const recoveryCodes = ctx.twoFactor.regenerateRecoveryCodes(userId(req));
      ctx.audit.record(actor(req), 'auth.2fa.recovery.regenerate');
      return { recoveryCodes };
    },
  );

  app.post('/api/auth/2fa/passkeys/options', async (req): Promise<PasskeyOptions> =>
    ctx.twoFactor.registrationOptions(userId(req), webAuthnOrigin(req)),
  );

  app.post('/api/auth/2fa/passkeys', async (req, reply) => {
    const input = registerPasskeySchema.parse(req.body);
    const result = await ctx.twoFactor.register(
      userId(req),
      input.name,
      input.challengeId,
      input.response,
      webAuthnOrigin(req),
    );
    ctx.audit.record(actor(req), 'auth.2fa.passkey.add', input.name);
    return reply.status(201).send(result);
  });

  app.patch('/api/auth/2fa/passkeys/:id', async (req): Promise<Passkey> => {
    const { id } = idParams.parse(req.params);
    const { name } = renamePasskeySchema.parse(req.body);
    return ctx.twoFactor.rename(userId(req), id, name);
  });

  app.delete(
    '/api/auth/2fa/passkeys/:id',
    { config: { rateLimit: CONFIRM_RATE_LIMIT } },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const { password } = confirmPasswordSchema.parse(req.body);
      await ctx.auth.confirmPassword(userId(req), password);
      const name = ctx.twoFactor.removePasskey(userId(req), id);
      ctx.audit.record(actor(req), 'auth.2fa.passkey.remove', name);
      return reply.status(204).send();
    },
  );
}
