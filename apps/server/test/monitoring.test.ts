import type { OriginHealth } from '@burrow/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatUptime, renderBadge } from '../src/services/badge.js';
import {
  MonitoringService,
  type HostDownEvent,
  type HostUpEvent,
} from '../src/services/monitoring.js';
import {
  apiFor,
  createTestApp,
  setupConfigured,
  waitFor,
  type ApiCall,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let call: ApiCall;
let zoneId: string;
let origin: Server;
let originUrl: string;

beforeEach(async () => {
  t = await createTestApp();
  const s = await setupConfigured(t);
  call = apiFor(t, s);
  zoneId = s.zoneId;
  origin = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await t.close();
  origin.closeAllConnections();
  await new Promise<void>((r) => origin.close(() => r()));
});

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Create a host and wait for its first probe, then forget that probe. */
async function host(subdomain = 'app'): Promise<number> {
  const res = await call('POST', '/api/hosts', { subdomain, zoneId, service: originUrl });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as number;
  await waitFor(() => t.ctx.health.get(id).checkedAt);
  await new Promise((r) => setTimeout(r, 20));
  t.ctx.sqlite.exec('DELETE FROM health_checks');
  return id;
}

function probe(up: boolean, at: number, latencyMs = 40): OriginHealth {
  return {
    state: up ? 'up' : 'down',
    statusCode: up ? 200 : null,
    latencyMs: up ? latencyMs : null,
    error: up ? null : 'Connection refused',
    checkedAt: new Date(at).toISOString(),
  };
}

describe('uptime history', () => {
  it('records every probe of the health checker', async () => {
    const id = await host();
    await call('POST', `/api/hosts/${id}/check`);
    await call('POST', `/api/hosts/${id}/check`);
    const overview = (await call('GET', '/api/monitoring')).json();
    const summary = overview.hosts.find((h: { hostId: number }) => h.hostId === id);
    expect(summary.heartbeats).toHaveLength(2);
    expect(summary).toMatchObject({ state: 'up', uptime: { h24: 1, d7: 1, d30: 1 } });
    expect(summary.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(overview.retentionDays).toBe(30);
  });

  it('computes uptime, buckets and incidents over a range', async () => {
    const id = await host();
    const now = Date.now();
    // 2 hours ago: up, up, down, down, up (every 10 minutes), then up until now.
    const pattern = [true, true, false, false, true];
    pattern.forEach((up, i) =>
      t.ctx.monitoring.record(id, probe(up, now - 2 * HOUR + i * 10 * MIN, 100)),
    );
    t.ctx.monitoring.record(id, probe(true, now - MIN, 50));
    // 3 days ago: one failure (outside 24h, inside 7d).
    t.ctx.monitoring.record(id, probe(false, now - 3 * 24 * HOUR));

    const day = (await call('GET', `/api/monitoring/hosts/${id}?range=24h`)).json();
    expect(day.range).toBe('24h');
    expect(day.buckets).toHaveLength(96);
    expect(day.uptime).toBeCloseTo(4 / 6);
    expect(day.buckets.reduce((a: number, b: { checks: number }) => a + b.checks, 0)).toBe(6);
    expect(day.incidents).toHaveLength(1);
    expect(day.incidents[0]).toMatchObject({
      durationSeconds: 20 * 60,
      error: 'Connection refused',
    });
    expect(day.incidents[0].end).not.toBeNull();
    expect(day.summary.uptime.h24).toBeCloseTo(4 / 6);
    expect(day.summary.uptime.d7).toBeCloseTo(4 / 7);

    const week = (await call('GET', `/api/monitoring/hosts/${id}?range=7d`)).json();
    expect(week.buckets).toHaveLength(84);
    expect(week.incidents).toHaveLength(2);
    // The older one ended with the next successful probe.
    expect(week.incidents[1].end).not.toBeNull();

    expect((await call('GET', `/api/monitoring/hosts/${id}?range=1y`)).statusCode).toBe(400);
    expect((await call('GET', '/api/monitoring/hosts/999')).statusCode).toBe(404);
  });

  it('prunes history older than the retention, and drops it with the host', async () => {
    const id = await host();
    const now = Date.now();
    t.ctx.monitoring.record(id, probe(true, now - 31 * 24 * HOUR));
    t.ctx.monitoring.record(id, probe(true, now - HOUR));
    expect(t.ctx.monitoring.prune(now)).toBe(1);
    expect((await call('DELETE', `/api/hosts/${id}`)).statusCode).toBe(204);
    const left = t.ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM health_checks').get() as {
      n: number;
    };
    expect(left.n).toBe(0);
  });
});

describe('down / up events', () => {
  it('fires once per outage, after two failed probes, and survives a restart', async () => {
    const id = await host();
    const downs: HostDownEvent[] = [];
    const ups: HostUpEvent[] = [];
    t.ctx.monitoring.on('down', (e) => downs.push(e));
    t.ctx.monitoring.on('up', (e) => ups.push(e));
    const now = Date.now();

    t.ctx.monitoring.record(id, probe(false, now - 5 * MIN));
    expect(downs).toHaveLength(0); // one blip is not an outage
    t.ctx.monitoring.record(id, probe(false, now - 4 * MIN));
    t.ctx.monitoring.record(id, probe(false, now - 3 * MIN));
    expect(downs).toHaveLength(1);
    expect(downs[0]).toMatchObject({ hostId: id, since: new Date(now - 5 * MIN).toISOString() });

    // A new monitor (Burrow restarted) knows the host is already down.
    const restarted = new MonitoringService({
      db: t.ctx.db,
      sqlite: t.ctx.sqlite,
      health: t.ctx.health,
      logger: pino({ level: 'silent' }),
      retentionDays: 30,
      intervalSeconds: 60,
    });
    const afterRestart: HostDownEvent[] = [];
    const recovered: HostUpEvent[] = [];
    restarted.on('down', (e) => afterRestart.push(e));
    restarted.on('up', (e) => recovered.push(e));
    restarted.record(id, probe(false, now - 2 * MIN));
    expect(afterRestart).toHaveLength(0);
    restarted.record(id, probe(true, now - MIN));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.durationSeconds).toBe(4 * 60);
  });

  it('stays quiet for hosts in maintenance mode', async () => {
    const id = await host();
    t.ctx.sqlite.prepare('UPDATE proxy_hosts SET maintenance_enabled = 1 WHERE id = ?').run(id);
    const downs: HostDownEvent[] = [];
    t.ctx.monitoring.on('down', (e) => downs.push(e));
    t.ctx.monitoring.record(id, probe(false, Date.now() - 2 * MIN));
    t.ctx.monitoring.record(id, probe(false, Date.now() - MIN));
    expect(downs).toHaveLength(0);
  });
});

describe('public status badge', () => {
  it('is off until enabled, then served to anyone as an embeddable SVG', async () => {
    const id = await host();
    t.ctx.monitoring.record(id, probe(true, Date.now() - MIN));
    const hostname = (await call('GET', `/api/hosts/${id}`)).json().hostname as string;

    const created = await call('POST', `/api/monitoring/hosts/${id}/badge`);
    expect(created.statusCode).toBe(200);
    const token = created.json().badgeToken as string;
    expect(token.length).toBeGreaterThanOrEqual(20);

    const badge = await t.app.inject({ method: 'GET', url: `/api/badge/${token}.svg` });
    expect(badge.statusCode).toBe(200);
    expect(badge.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(badge.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(badge.headers['cache-control']).toMatch(/max-age=60/);
    expect(badge.body).toContain(hostname);
    expect(badge.body).toContain('100%');
    expect(badge.body).toMatch(/>up</);

    const custom = await t.app.inject({
      method: 'GET',
      url: `/api/badge/${token}?label=${encodeURIComponent('My <app>')}&theme=chalk`,
    });
    expect(custom.body).toContain('My &lt;app&gt;');
    expect(custom.body).toContain('#faf7f3');

    // Regenerating invalidates the old URL; disabling removes it.
    const again = (await call('POST', `/api/monitoring/hosts/${id}/badge`)).json().badgeToken;
    expect(again).not.toBe(token);
    expect((await t.app.inject({ method: 'GET', url: `/api/badge/${token}` })).statusCode).toBe(
      404,
    );
    expect((await call('DELETE', `/api/monitoring/hosts/${id}/badge`)).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/api/badge/${again}` })).statusCode).toBe(
      404,
    );
  });

  it('cannot be managed without a session', async () => {
    const id = await host();
    const res = await t.app.inject({ method: 'POST', url: `/api/monitoring/hosts/${id}/badge` });
    expect(res.statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/monitoring' })).statusCode).toBe(401);
  });
});

describe('badge rendering', () => {
  it('formats uptime without rounding up', () => {
    expect(formatUptime(1)).toBe('100%');
    expect(formatUptime(0.99999)).toBe('99.99%');
    expect(formatUptime(0.5)).toBe('50%');
    expect(formatUptime(null)).toBe('no data');
  });

  it('draws one bar per hour and escapes the label', () => {
    const svg = renderBadge({
      label: '"><script>',
      state: 'down',
      uptime: 0.9,
      hours: [1, 0.95, 0.2, null],
      theme: 'soil',
    });
    expect(svg).not.toContain('<script>');
    expect(svg.match(/<rect x="[\d.]+" y="\d+" width="3"/g)).toHaveLength(4);
    expect(svg).toContain('aria-label="&quot;&gt;&lt;script&gt;: down, 90% uptime over 30 days"');
  });
});
