import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiFor, createTestApp, setupConfigured, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('temporary hosts', () => {
  it('are removed with their route and DNS record once expired', async () => {
    const s = await setupConfigured(t);
    const call = apiFor(t, s);
    const expiresAt = inMinutes(120);
    const res = await call('POST', '/api/hosts', {
      subdomain: 'demo',
      zoneId: s.zoneId,
      service: 'http://10.0.0.1:3000',
      expiresAt,
    });
    expect(res.statusCode).toBe(201);
    const host = res.json();
    expect(host.expiresAt).toBe(expiresAt);
    const hostname = `demo.${s.zoneName}`;
    expect(t.mock.state.dns.some((r) => r.name === hostname)).toBe(true);

    // Not expired yet.
    expect(await t.ctx.hosts.removeExpired()).toEqual([]);

    // An update without expiresAt keeps it; temporary hosts are not exported.
    const kept = await call('PUT', `/api/hosts/${host.id}`, {
      subdomain: 'demo',
      zoneId: s.zoneId,
      service: 'http://10.0.0.1:3001',
    });
    expect(kept.json().expiresAt).toBe(expiresAt);
    expect((await call('GET', '/api/config/export')).json().hosts).toHaveLength(0);

    // Two hours later.
    const removed = await t.ctx.hosts.removeExpired(new Date(Date.now() + 121 * 60_000));
    expect(removed).toEqual([hostname]);
    expect((await call('GET', '/api/hosts')).json().hosts).toHaveLength(0);
    expect(t.mock.state.dns.some((r) => r.name === hostname)).toBe(false);
    const ingress = t.mock.state.tunnels.find((x) => !x.deleted_at)?.config?.ingress ?? [];
    expect(ingress.some((r) => r.hostname === hostname)).toBe(false);
  });

  it('can be made permanent, and refuse a time in the past', async () => {
    const s = await setupConfigured(t);
    const call = apiFor(t, s);
    const past = await call('POST', '/api/hosts', {
      subdomain: 'old',
      zoneId: s.zoneId,
      service: 'http://10.0.0.1:3000',
      expiresAt: inMinutes(-5),
    });
    expect(past.statusCode).toBe(400);
    expect((await call('GET', '/api/hosts')).json().hosts).toHaveLength(0);

    const host = (
      await call('POST', '/api/hosts', {
        subdomain: 'demo',
        zoneId: s.zoneId,
        service: 'http://10.0.0.1:3000',
        expiresAt: inMinutes(60),
      })
    ).json();
    const permanent = await call('PUT', `/api/hosts/${host.id}`, {
      subdomain: 'demo',
      zoneId: s.zoneId,
      service: 'http://10.0.0.1:3000',
      expiresAt: null,
    });
    expect(permanent.json().expiresAt).toBeNull();
    expect(await t.ctx.hosts.removeExpired(new Date(Date.now() + 1e9))).toEqual([]);
  });
});
