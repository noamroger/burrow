import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiFor, createTestApp, setupConfigured, type ApiCall, type TestApp } from './helpers.js';

let t: TestApp;
let api: ApiCall;
let hostId: number;

beforeEach(async () => {
  t = await createTestApp();
  const s = await setupConfigured(t);
  api = apiFor(t, s);
  hostId = (
    await api('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://app:80',
    })
  ).json().id;
});
afterEach(async () => {
  await t.close();
});

const tunnel = () => t.mock.state.tunnels.find((x) => !x.deleted_at)!;
const rule = () => tunnel().config!.ingress!.find((r) => r.hostname === 'app.example.com');
const writes = () => t.mock.state.requests.filter((r) => r.method !== 'GET').length;
const host = async () => (await api('GET', `/api/hosts/${hostId}`)).json();

describe('drift detection', () => {
  it('reports nothing when Cloudflare matches', async () => {
    const report = (await api('POST', '/api/drift/check')).json();
    expect(report).toMatchObject({ items: [], error: null, autoRepair: false });
  });

  it('detects a route edited in the dashboard without writing, and keeps it on request', async () => {
    rule()!.service = 'http://app:8080';
    rule()!.originRequest = { noTLSVerify: true, connectTimeout: '10s' };
    const before = writes();
    const report = (await api('POST', '/api/drift/check')).json();
    expect(writes()).toBe(before);
    expect(report.items).toEqual([
      expect.objectContaining({
        kind: 'ingress.changed',
        target: 'app.example.com',
        hostIds: [hostId],
        keepable: true,
      }),
    ]);
    expect((await host()).sync.status).toBe('drift');

    const after = (await api('POST', '/api/drift/resolve', { strategy: 'keep' })).json();
    expect(after.items).toEqual([]);
    const h = await host();
    expect(h).toMatchObject({
      service: 'http://app:8080',
      options: { noTLSVerify: true, extra: { connectTimeout: '10s' } },
      sync: { status: 'synced' },
    });
  });

  it('reverts a deleted route', async () => {
    tunnel().config!.ingress = tunnel().config!.ingress!.filter(
      (r) => r.hostname !== 'app.example.com',
    );
    const report = (await api('POST', '/api/drift/check')).json();
    expect(report.items).toEqual([
      expect.objectContaining({ kind: 'ingress.missing', keepable: true }),
    ]);
    const after = (await api('POST', '/api/drift/resolve', { strategy: 'revert' })).json();
    expect(after.items).toEqual([]);
    expect(rule()).toMatchObject({ service: 'http://app:80' });
  });

  it('keeping a deleted CNAME disables the host and removes its route', async () => {
    t.mock.state.dns = [];
    const report = (await api('POST', '/api/drift/check')).json();
    expect(report.items).toEqual([
      expect.objectContaining({ kind: 'dns.missing', keepable: true }),
    ]);
    const after = (await api('POST', '/api/drift/resolve', { strategy: 'keep' })).json();
    expect(after.items).toEqual([]);
    expect((await host()).enabled).toBe(false);
    expect(rule()).toBeUndefined();
    expect(t.mock.state.dns).toEqual([]);
  });

  it('reports a repointed CNAME as not keepable', async () => {
    t.mock.state.dns[0]!.content = 'elsewhere.example.net';
    const report = (await api('POST', '/api/drift/check')).json();
    expect(report.items).toEqual([
      expect.objectContaining({
        kind: 'dns.changed',
        keepable: false,
        detail: expect.stringContaining('elsewhere.example.net'),
      }),
    ]);
  });

  it('reports a deleted tunnel without recreating it', async () => {
    const old = tunnel();
    old.deleted_at = new Date().toISOString();
    const report = (await api('POST', '/api/drift/check')).json();
    expect(report.items).toEqual([
      expect.objectContaining({ kind: 'tunnel.missing', hostIds: [hostId] }),
    ]);
    expect(t.mock.state.tunnels.filter((x) => !x.deleted_at)).toHaveLength(0);
  });

  it('repairs automatically when auto-repair is on', async () => {
    const settings = (await api('PUT', '/api/drift/settings', { autoRepair: true })).json();
    expect(settings.autoRepair).toBe(true);
    rule()!.service = 'http://evil:1';
    const report = await t.ctx.drift.scheduled();
    expect(report.items).toEqual([]);
    expect(rule()!.service).toBe('http://app:80');
  });

  it('emits an event when new differences appear', async () => {
    const seen: number[] = [];
    t.ctx.drift.on('detected', (r) => seen.push(r.items.length));
    rule()!.service = 'http://x:1';
    await t.ctx.drift.check();
    await t.ctx.drift.check(); // same differences: no second event
    expect(seen).toEqual([1]);
  });
});
