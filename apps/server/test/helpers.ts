import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { MockCloudflare } from '../mock/cloudflare.js';

export const FAKE_CLOUDFLARED = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-cloudflared.sh',
);
export const VALID_TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz0123';
export const ADMIN = { email: 'admin@example.com', password: 'correct horse battery staple' };

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  mock: MockCloudflare;
  dataDir: string;
  close: () => Promise<void>;
}

/** A full Burrow app (fresh data dir) wired to an in-memory Cloudflare mock. */
export async function createTestApp(opts: { apiRateLimit?: number } = {}): Promise<TestApp> {
  const mock = new MockCloudflare();
  await mock.listen();
  const dataDir = mkdtempSync(join(tmpdir(), 'burrow-test-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    CLOUDFLARE_API_BASE: mock.url,
    CLOUDFLARED_PATH: FAKE_CLOUDFLARED,
    LOG_LEVEL: 'silent',
    RECONCILE_INTERVAL_SECONDS: '0',
    HEALTHCHECK_INTERVAL_SECONDS: '0',
    WEB_DIST_DIR: join(dataDir, 'no-web'),
    CLOUDFLARED_METRICS: '127.0.0.1:0',
  });
  const ctx = createContext(config, pino({ level: 'silent' }), {
    cloudflareRetryBaseMs: 1,
    supervisor: { backoff: { initialMs: 50, maxMs: 200 }, killTimeoutMs: 1000 },
    healthTimeoutMs: 1000,
  });
  const app = await buildApp(ctx, { apiRateLimit: opts.apiRateLimit ?? 10_000 });
  return {
    app,
    ctx,
    mock,
    dataDir,
    close: async () => {
      await ctx.lifecycle.stop();
      await app.close();
      ctx.sqlite.close();
      await mock.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Session {
  cookies: Record<string, string>;
  csrf: string;
  headers: Record<string, string>;
}

/** Create the admin (first call) and return cookie + CSRF headers for inject(). */
export async function setupAdmin(app: FastifyInstance): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: ADMIN });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'burrow_session')!;
  const csrf = res.json<{ csrfToken: string }>().csrfToken;
  return { cookies: { burrow_session: cookie.value }, csrf, headers: { 'x-csrf-token': csrf } };
}

/** Admin + saved token + enabled zone: ready to create hosts. */
export async function setupConfigured(
  t: TestApp,
): Promise<Session & { zoneId: string; zoneName: string }> {
  const session = await setupAdmin(t.app);
  const res = await t.app.inject({
    method: 'PUT',
    url: '/api/cloudflare/token',
    cookies: session.cookies,
    headers: session.headers,
    payload: { token: VALID_TOKEN },
  });
  if (res.statusCode !== 200) throw new Error(`token failed: ${res.statusCode} ${res.body}`);
  const zone = t.mock.state.zones[0]!;
  const z = await t.app.inject({
    method: 'PATCH',
    url: `/api/zones/${zone.id}`,
    cookies: session.cookies,
    headers: session.headers,
    payload: { enabled: true },
  });
  if (z.statusCode !== 200) throw new Error(`zone failed: ${z.statusCode} ${z.body}`);
  return { ...session, zoneId: zone.id, zoneName: zone.name };
}

/** Wait until `fn` returns truthy (polling). */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 5000,
  stepMs = 20,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** `app.inject` bound to a session: `call('POST', '/api/hosts', body)`. */
export type ApiCall = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) => Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;

export function apiFor(t: TestApp, s: Session): ApiCall {
  return (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      cookies: s.cookies,
      headers: s.headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
}
