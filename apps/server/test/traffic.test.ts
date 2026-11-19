import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillSeries } from '../src/services/traffic.js';
import {
  apiFor,
  createTestApp,
  setupAdmin,
  setupConfigured,
  type ApiCall,
  type TestApp,
} from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

async function withHost(): Promise<{ call: ApiCall; id: number; hostname: string }> {
  const s = await setupConfigured(t);
  const call = apiFor(t, s);
  const host = (
    await call('POST', '/api/hosts', {
      subdomain: 'media',
      zoneId: s.zoneId,
      service: 'http://jf:8096',
    })
  ).json();
  return { call, id: host.id, hostname: host.hostname };
}

describe('traffic statistics', () => {
  it('reads a host from the GraphQL Analytics API', async () => {
    const { call, id, hostname } = await withHost();
    const res = await call('GET', `/api/traffic/hosts/${id}?range=24h`);
    expect(res.statusCode).toBe(200);
    const traffic = res.json();
    expect(traffic).toMatchObject({ hostId: id, hostname, range: '24h' });
    expect(traffic.series.length).toBeGreaterThanOrEqual(24);
    expect(traffic.series.length).toBeLessThanOrEqual(25);
    expect(traffic.totals.requests).toBe(
      traffic.series.reduce((a: number, p: { requests: number }) => a + p.requests, 0),
    );
    expect(traffic.totals.bytes).toBe(traffic.totals.requests * 24_000);
    expect(traffic.statuses['2xx']).toBeGreaterThan(traffic.statuses['5xx']);
    expect(traffic.topCountries[0]).toMatchObject({ country: 'FR' });

    // Answered through the GraphQL endpoint.
    const calls = t.mock.state.requests.filter((r) => r.path === '/graphql');
    expect(calls.length).toBeGreaterThan(0);

    const month = (await call('GET', `/api/traffic/hosts/${id}?range=30d`)).json();
    expect(month.series.length).toBeGreaterThanOrEqual(30);
    expect(month.series.length).toBeLessThanOrEqual(31);
    expect(month.series[0].start).toMatch(/T00:00:00.000Z$/);

    expect((await call('GET', '/api/traffic/hosts/999')).statusCode).toBe(404);
  });

  it('caches answers for a few minutes', async () => {
    const { call, id } = await withHost();
    await call('GET', `/api/traffic/hosts/${id}?range=7d`);
    const before = t.mock.state.requests.filter((r) => r.path === '/graphql').length;
    await call('GET', `/api/traffic/hosts/${id}?range=7d`);
    expect(t.mock.state.requests.filter((r) => r.path === '/graphql').length).toBe(before);
  });

  it('lists every host over 24 hours', async () => {
    const { call, id, hostname } = await withHost();
    const overview = (await call('GET', '/api/traffic')).json();
    expect(overview.error).toBeNull();
    expect(overview.hosts).toEqual([
      expect.objectContaining({ hostId: id, hostname, requests: expect.any(Number) }),
    ]);
    expect(overview.hosts[0].requests).toBeGreaterThan(0);
  });

  it('explains a missing Analytics permission', async () => {
    const session = await setupAdmin(t.app);
    const call = apiFor(t, session);
    const saved = await call('PUT', '/api/cloudflare/token', {
      token: 'token-noanalytics-abcdefghijklmnop',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().permissions).toContainEqual(
      expect.objectContaining({ name: 'Zone › Analytics › Read', ok: false, optional: true }),
    );
    const zone = t.mock.state.zones[0]!;
    await call('PATCH', `/api/zones/${zone.id}`, { enabled: true });
    const host = (
      await call('POST', '/api/hosts', { subdomain: 'x', zoneId: zone.id, service: 'http://x:80' })
    ).json();

    const res = await call('GET', `/api/traffic/hosts/${host.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CLOUDFLARE_PERMISSION_MISSING');
    expect(res.json().error.message).toMatch(/Zone › Analytics › Read/);
    const overview = (await call('GET', '/api/traffic')).json();
    expect(overview.hosts).toEqual([]);
    expect(overview.error).toMatch(/Analytics/);
  });

  it('reports the permission as granted with a normal token', async () => {
    const s = await setupConfigured(t);
    const settings = (await apiFor(t, s)('GET', '/api/cloudflare')).json();
    expect(settings.permissions).toContainEqual(
      expect.objectContaining({ name: 'Zone › Analytics › Read', ok: true }),
    );
  });
});

describe('fillSeries', () => {
  it('fills missing hours with zeros', () => {
    const start = Date.parse('2026-11-19T00:30:00Z');
    const end = Date.parse('2026-11-19T04:10:00Z');
    const points = fillSeries(
      [
        {
          count: 5,
          sum: { edgeResponseBytes: 10, visits: 1 },
          dimensions: { ts: '2026-11-19T02:00:00Z' },
        },
      ],
      start,
      end,
      false,
    );
    expect(points.map((p) => p.requests)).toEqual([0, 0, 5, 0, 0]);
    expect(points[0]!.start).toBe('2026-11-19T00:00:00.000Z');
  });
});
