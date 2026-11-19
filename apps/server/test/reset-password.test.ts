import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generatePassword,
  parseArgs,
  readAdmins,
  resetPassword,
} from '../src/cli/reset-password.js';
import { totpCode, totpStep } from '../src/lib/totp.js';
import { ADMIN, createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

const NEW_PASSWORD = 'a brand new passphrase';

let t: TestApp;
let session: Session;
beforeEach(async () => {
  t = await createTestApp();
  session = await setupAdmin(t.app);
});
afterEach(async () => {
  await t.close();
});

const login = (password: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: ADMIN.email, password },
  });

async function enableTotp() {
  const call = (url: string, payload?: object) =>
    t.app.inject({
      method: 'POST',
      url,
      cookies: session.cookies,
      headers: session.headers,
      payload,
    });
  const { secret } = (await call('/api/auth/2fa/totp/setup')).json();
  await call('/api/auth/2fa/totp/enable', { code: totpCode(secret, totpStep()) });
}

describe('burrow-reset-password', () => {
  it('parses its options', () => {
    expect(parseArgs(['--generate', '--disable-2fa', '--email=a@b.c'])).toMatchObject({
      generate: true,
      disable2fa: true,
      email: 'a@b.c',
    });
    expect(parseArgs(['--keep-2fa']).disable2fa).toBe(false);
    expect(() => parseArgs(['--generate', '--password-stdin'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option');
  });

  it('generates long passwords that pass the policy', () => {
    const pw = generatePassword();
    expect(pw).toMatch(/^[\w]{6}(-[\w]{6}){3}$/);
    expect(generatePassword()).not.toBe(pw);
  });

  it('sets a new password, signs out every session and logs it', async () => {
    const result = await resetPassword({
      dataDir: t.dataDir,
      password: NEW_PASSWORD,
      disable2fa: false,
    });
    expect(result).toEqual({ email: ADMIN.email, twoFactorWasOn: false, twoFactorDisabled: false });
    expect((await login(ADMIN.password)).statusCode).toBe(401);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies: session.cookies });
    expect(me.statusCode).toBe(401);
    const row = t.ctx.sqlite
      .prepare("SELECT target FROM audit_log WHERE action = 'auth.password.reset'")
      .get() as { target: string };
    expect(row.target).toContain('reset script');
  });

  it('refuses a weak password and leaves everything as it was', async () => {
    await expect(
      resetPassword({ dataDir: t.dataDir, password: 'short', disable2fa: false }),
    ).rejects.toThrow('at least 12 characters');
    expect((await login(ADMIN.password)).statusCode).toBe(200);
  });

  it('keeps two-step verification unless asked to turn it off', async () => {
    await enableTotp();
    expect(readAdmins(t.dataDir)).toEqual([{ id: 1, email: ADMIN.email, twoFactor: true }]);

    await resetPassword({ dataDir: t.dataDir, password: NEW_PASSWORD, disable2fa: false });
    expect((await login(NEW_PASSWORD)).json().mfaRequired).toBe(true);

    const result = await resetPassword({
      dataDir: t.dataDir,
      password: NEW_PASSWORD,
      disable2fa: true,
    });
    expect(result.twoFactorDisabled).toBe(true);
    expect((await login(NEW_PASSWORD)).json()).toMatchObject({ user: { email: ADMIN.email } });
  });

  it('explains an unknown email', async () => {
    await expect(
      resetPassword({
        dataDir: t.dataDir,
        password: NEW_PASSWORD,
        disable2fa: false,
        email: 'who@example.com',
      }),
    ).rejects.toThrow('No account with the email who@example.com');
  });
});
