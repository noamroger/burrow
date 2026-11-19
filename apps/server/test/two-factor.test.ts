import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { base32Decode, base32Encode, totpCode, totpStep, verifyTotp } from '../src/lib/totp.js';
import { SoftAuthenticator } from './fixtures/authenticator.js';
import { ADMIN, apiFor, createTestApp, setupAdmin, type Session, type TestApp } from './helpers.js';

const HOST = 'burrow.test';
const ORIGIN = `https://${HOST}`;

let t: TestApp;
let session: Session;
beforeEach(async () => {
  t = await createTestApp();
  session = await setupAdmin(t.app);
});
afterEach(async () => {
  await t.close();
});

/** Session-bound call, sent as if the browser were on https://burrow.test. */
function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return t.app.inject({
    method,
    url,
    cookies: session.cookies,
    headers: { ...session.headers, host: HOST },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

function publicCall(url: string, payload: unknown) {
  return t.app.inject({ method: 'POST', url, headers: { host: HOST }, payload: payload as object });
}

async function enableTotp(): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await call('POST', '/api/auth/2fa/totp/setup');
  expect(setup.statusCode).toBe(200);
  const { secret, uri, qrSvg } = setup.json();
  expect(uri).toMatch(/^otpauth:\/\/totp\/Burrow%3Aadmin%40example\.com\?secret=/);
  expect(qrSvg).toContain('<svg');
  const res = await call('POST', '/api/auth/2fa/totp/enable', {
    code: totpCode(secret, totpStep() - 1),
  });
  expect(res.statusCode).toBe(200);
  return { secret, recoveryCodes: res.json().recoveryCodes };
}

async function addPasskey(auth: SoftAuthenticator, name = 'YubiKey') {
  const opts = await call('POST', '/api/auth/2fa/passkeys/options');
  expect(opts.statusCode).toBe(200);
  const { challengeId, options } = opts.json();
  expect(options.rp).toEqual({ name: 'Burrow', id: HOST });
  return call('POST', '/api/auth/2fa/passkeys', {
    name,
    challengeId,
    response: auth.register(options),
  });
}

describe('TOTP helpers', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    // RFC 6238 appendix B, truncated to 6 digits.
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts one step of drift and refuses replays', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCode(secret, step + 1), { nowMs: now })).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), { nowMs: now, notAfter: step })).toBeNull();
  });
});

describe('two-factor authentication', () => {
  it('is off by default: the password alone signs in', async () => {
    const status = await call('GET', '/api/auth/2fa');
    expect(status.json()).toEqual({
      totpEnabled: false,
      passkeys: [],
      recoveryCodesLeft: 0,
      enabled: false,
    });
    const login = await publicCall('/api/auth/login', ADMIN);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { email: ADMIN.email } });
  });

  it('turns TOTP on with a confirmed code and stores the secret encrypted', async () => {
    const { secret, recoveryCodes } = await enableTotp();
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const row = t.ctx.db.select().from(users).get()!;
    expect(row.totpSecretEnc).not.toContain(secret);
    expect(JSON.stringify(row.recoveryCodes)).not.toContain(recoveryCodes[0]);
    expect((await call('GET', '/api/auth/2fa')).json()).toMatchObject({
      totpEnabled: true,
      recoveryCodesLeft: 10,
      enabled: true,
    });
  });

  it('refuses a wrong confirmation code', async () => {
    await call('POST', '/api/auth/2fa/totp/setup');
    const res = await call('POST', '/api/auth/2fa/totp/enable', { code: '000000' });
    expect(res.statusCode).toBe(400);
    expect((await call('GET', '/api/auth/2fa')).json().totpEnabled).toBe(false);
  });

  it('asks for a code after the password, then opens a session', async () => {
    const { secret } = await enableTotp();
    const login = await publicCall('/api/auth/login', ADMIN);
    expect(login.statusCode).toBe(200);
    const challenge = login.json();
    expect(challenge).toMatchObject({ mfaRequired: true, methods: ['totp', 'recovery'] });
    expect(login.cookies.find((c) => c.name === 'burrow_session')).toBeUndefined();

    const bad = await publicCall('/api/auth/login/verify', {
      ticket: challenge.ticket,
      code: '000000',
    });
    expect(bad.statusCode).toBe(401);

    const ok = await publicCall('/api/auth/login/verify', {
      ticket: challenge.ticket,
      code: totpCode(secret, totpStep()),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      user: { email: ADMIN.email },
      csrfToken: expect.any(String),
    });
    expect(ok.cookies.find((c) => c.name === 'burrow_session')).toBeDefined();

    // The ticket is single use.
    const again = await publicCall('/api/auth/login/verify', {
      ticket: challenge.ticket,
      code: totpCode(secret, totpStep()),
    });
    expect(again.json().error.code).toBe('MFA_EXPIRED');
  });

  it('does not accept the same TOTP code twice', async () => {
    const { secret } = await enableTotp();
    const code = totpCode(secret, totpStep());
    const first = (await publicCall('/api/auth/login', ADMIN)).json().ticket;
    expect((await publicCall('/api/auth/login/verify', { ticket: first, code })).statusCode).toBe(
      200,
    );
    const second = (await publicCall('/api/auth/login', ADMIN)).json().ticket;
    expect((await publicCall('/api/auth/login/verify', { ticket: second, code })).statusCode).toBe(
      401,
    );
  });

  it('drops the ticket after five wrong codes', async () => {
    await enableTotp();
    const { ticket } = (await publicCall('/api/auth/login', ADMIN)).json();
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await publicCall('/api/auth/login/verify', { ticket, code: '000000' });
      codes.push(res.json().error.code);
    }
    expect(codes).toEqual([
      'UNAUTHORIZED',
      'UNAUTHORIZED',
      'UNAUTHORIZED',
      'UNAUTHORIZED',
      'MFA_EXPIRED',
    ]);
  });

  it('accepts each recovery code once', async () => {
    const { recoveryCodes } = await enableTotp();
    const code = recoveryCodes[3]!.toUpperCase();
    const first = (await publicCall('/api/auth/login', ADMIN)).json().ticket;
    const ok = await publicCall('/api/auth/login/verify', { ticket: first, code });
    expect(ok.statusCode).toBe(200);
    const second = (await publicCall('/api/auth/login', ADMIN)).json().ticket;
    const reused = await publicCall('/api/auth/login/verify', { ticket: second, code });
    expect(reused.statusCode).toBe(401);
    expect((await call('GET', '/api/auth/2fa')).json().recoveryCodesLeft).toBe(9);
  });

  it('needs the password to turn TOTP off or renew the recovery codes', async () => {
    await enableTotp();
    const wrong = await call('POST', '/api/auth/2fa/totp/disable', { password: 'nope' });
    expect(wrong.statusCode).toBe(400);
    const renewed = await call('POST', '/api/auth/2fa/recovery-codes', {
      password: ADMIN.password,
    });
    expect(renewed.json().recoveryCodes).toHaveLength(10);
    const off = await call('POST', '/api/auth/2fa/totp/disable', { password: ADMIN.password });
    expect(off.statusCode).toBe(204);
    expect((await call('GET', '/api/auth/2fa')).json()).toMatchObject({
      enabled: false,
      recoveryCodesLeft: 0,
    });
    expect((await publicCall('/api/auth/login', ADMIN)).json()).toMatchObject({
      user: { email: ADMIN.email },
    });
  });

  it('refuses API tokens on the two-factor routes', async () => {
    const created = await apiFor(t, session)('POST', '/api/tokens', { name: 'ci' });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/2fa',
      headers: { authorization: `Bearer ${created.json().token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('writes the changes to the audit log', async () => {
    await enableTotp();
    const actions = t.ctx.sqlite
      .prepare('SELECT action FROM audit_log ORDER BY id')
      .all()
      .map((r) => (r as { action: string }).action);
    expect(actions).toContain('auth.2fa.totp.enable');
  });
});

describe('passkeys', () => {
  it('registers a passkey and uses it as the second step', async () => {
    const key = new SoftAuthenticator(ORIGIN);
    const added = await addPasskey(key);
    expect(added.statusCode).toBe(201);
    expect(added.json().passkey).toMatchObject({ name: 'YubiKey', backedUp: false });
    expect(added.json().recoveryCodes).toHaveLength(10);

    const login = (await publicCall('/api/auth/login', ADMIN)).json();
    expect(login.methods).toEqual(['passkey', 'recovery']);
    const opts = await publicCall('/api/auth/passkey/options', { ticket: login.ticket });
    expect(opts.statusCode).toBe(200);
    const { challengeId, options } = opts.json();
    expect(options.allowCredentials).toEqual([
      { id: key.id, type: 'public-key', transports: ['usb'] },
    ]);
    const ok = await publicCall('/api/auth/passkey/verify', {
      challengeId,
      response: key.authenticate(options),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ user: { email: ADMIN.email } });
    const status = (await call('GET', '/api/auth/2fa')).json();
    expect(status.passkeys[0].lastUsedAt).toEqual(expect.any(String));
  });

  it('signs in without a password, but only with user verification', async () => {
    const key = new SoftAuthenticator(ORIGIN);
    await addPasskey(key);

    const weak = (await publicCall('/api/auth/passkey/options', {})).json();
    const refused = await publicCall('/api/auth/passkey/verify', {
      challengeId: weak.challengeId,
      response: key.authenticate(weak.options, false),
    });
    expect(refused.statusCode).toBe(401);

    const opts = (await publicCall('/api/auth/passkey/options', {})).json();
    expect(opts.options.userVerification).toBe('required');
    const ok = await publicCall('/api/auth/passkey/verify', {
      challengeId: opts.challengeId,
      response: key.authenticate(opts.options),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses an unknown key and a replayed challenge', async () => {
    const key = new SoftAuthenticator(ORIGIN);
    await addPasskey(key);
    const stranger = new SoftAuthenticator(ORIGIN);
    const opts = (await publicCall('/api/auth/passkey/options', {})).json();
    const res = await publicCall('/api/auth/passkey/verify', {
      challengeId: opts.challengeId,
      response: stranger.authenticate(opts.options),
    });
    expect(res.statusCode).toBe(401);
    const replay = await publicCall('/api/auth/passkey/verify', {
      challengeId: opts.challengeId,
      response: key.authenticate(opts.options),
    });
    expect(replay.json().error.code).toBe('MFA_EXPIRED');
  });

  it('rejects a registration made for another site', async () => {
    const key = new SoftAuthenticator('https://evil.test');
    const res = await addPasskey(key);
    expect(res.statusCode).toBe(400);
  });

  it('renames and removes a passkey (password required)', async () => {
    await addPasskey(new SoftAuthenticator(ORIGIN));
    const id = (await call('GET', '/api/auth/2fa')).json().passkeys[0].id;
    const renamed = await call('PATCH', `/api/auth/2fa/passkeys/${id}`, { name: 'Laptop' });
    expect(renamed.json().name).toBe('Laptop');
    expect(
      (await call('DELETE', `/api/auth/2fa/passkeys/${id}`, { password: 'nope' })).statusCode,
    ).toBe(400);
    const removed = await call('DELETE', `/api/auth/2fa/passkeys/${id}`, {
      password: ADMIN.password,
    });
    expect(removed.statusCode).toBe(204);
    expect((await call('GET', '/api/auth/2fa')).json()).toMatchObject({
      enabled: false,
      passkeys: [],
    });
  });
});
