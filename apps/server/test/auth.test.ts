import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, sessions } from '../src/db/schema.js';
import { ADMIN, createTestApp, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('health and setup', () => {
  it('GET /api/health is public', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', version: expect.any(String) });
  });

  it('reports setup status and answers SETUP_REQUIRED before setup', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({
      userCreated: false,
      cloudflareConfigured: false,
      tunnelReady: false,
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/hosts' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SETUP_REQUIRED');
  });

  it('creates the admin once, then locks setup', async () => {
    const first = await t.app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      user: { id: 1, email: ADMIN.email },
      csrfToken: expect.any(String),
    });
    const cookie = first.cookies.find((c) => c.name === 'burrow_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });

    const second = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { ...ADMIN, email: 'x@example.com' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('SETUP_ALREADY_DONE');
  });

  it('validates input with the shared schemas', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { email: 'nope', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('stores only the hash of the session id and an argon2id password hash', async () => {
    const s = await setupAdmin(t.app);
    const rows = t.ctx.db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(s.cookies.burrow_session);
    const hash = t.ctx.sqlite.prepare('SELECT password_hash FROM users').get() as {
      password_hash: string;
    };
    expect(hash.password_hash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('login, me, logout', () => {
  it('logs in, returns the CSRF token from /me and logs out', async () => {
    await setupAdmin(t.app);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ADMIN@example.com ', password: ADMIN.password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = {
      burrow_session: login.cookies.find((c) => c.name === 'burrow_session')!.value,
    };

    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    expect(me.statusCode).toBe(200);
    expect(me.json().csrfToken).toBe(login.json().csrfToken);

    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/auth/logout', cookies });
    expect(noCsrf.statusCode).toBe(403);

    const logout = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies,
      headers: { 'x-csrf-token': me.json().csrfToken },
    });
    expect(logout.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies })).statusCode).toBe(
      401,
    );
  });

  it('rejects wrong credentials with the same message for unknown users', async () => {
    await setupAdmin(t.app);
    const wrongPw = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: 'wrong' },
    });
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'who@example.com', password: 'wrong' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrongPw.json()).toEqual(unknown.json());
  });

  it('rate limits login to 5 attempts per minute per IP', async () => {
    await setupAdmin(t.app);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: ADMIN.email, password: 'wrong' },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
    const last = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    expect(last.json().error.code).toBe('RATE_LIMITED');
  });

  it('rotates the session on login', async () => {
    const s = await setupAdmin(t.app);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      cookies: s.cookies,
      payload: ADMIN,
    });
    const fresh = login.cookies.find((c) => c.name === 'burrow_session')!.value;
    expect(fresh).not.toBe(s.cookies.burrow_session);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies: s.cookies })).statusCode,
    ).toBe(401);
  });
});

describe('CSRF', () => {
  it('requires the X-CSRF-Token header on mutating requests', async () => {
    const s = await setupAdmin(t.app);
    const missing = await t.app.inject({ method: 'POST', url: '/api/sync', cookies: s.cookies });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('CSRF_INVALID');
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/sync',
      cookies: s.cookies,
      headers: { 'x-csrf-token': 'x' },
    });
    expect(wrong.statusCode).toBe(403);
    const right = await t.app.inject({
      method: 'POST',
      url: '/api/sync',
      cookies: s.cookies,
      headers: s.headers,
    });
    expect(right.json().error.code).toBe('CLOUDFLARE_NOT_CONFIGURED');
  });

  it('does not require it for GET', async () => {
    const s = await setupAdmin(t.app);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/hosts', cookies: s.cookies })).statusCode,
    ).toBe(200);
  });
});

describe('password change', () => {
  it('returns 400 (not 401) for a wrong current password', async () => {
    const s = await setupAdmin(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      cookies: s.cookies,
      headers: s.headers,
      payload: { currentPassword: 'wrong', newPassword: 'another long password' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('changes the password, keeps this session and revokes the others', async () => {
    const s = await setupAdmin(t.app);
    const other = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    const otherCookies = {
      burrow_session: other.cookies.find((c) => c.name === 'burrow_session')!.value,
    };
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      cookies: s.cookies,
      headers: s.headers,
      payload: { currentPassword: ADMIN.password, newPassword: 'another long password' },
    });
    expect(res.statusCode).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies: s.cookies })).statusCode,
    ).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', cookies: otherCookies }))
        .statusCode,
    ).toBe(401);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { ...ADMIN, password: 'another long password' },
    });
    expect(login.statusCode).toBe(200);
    expect(
      t.ctx.db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.action),
    ).toContain('auth.password');
  });
});

describe('misc HTTP behaviour', () => {
  it('returns JSON 404 for unknown API routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('sets security headers without upgrade-insecure-requests or HSTS', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
