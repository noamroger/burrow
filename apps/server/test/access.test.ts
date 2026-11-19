import { accessResourceName, type ProxyHost } from '@burrow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingKeys } from '../src/db/settings.js';
import { createTestApp, setupConfigured, type Session, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const tunnel = () => t.mock.state.tunnels.find((x) => !x.deleted_at)!;
const ingressHosts = () => (tunnel().config?.ingress ?? []).map((r) => r.hostname).filter(Boolean);
const apps = () => t.mock.state.accessApps;
const policies = () => t.mock.state.accessPolicies;
const dnsNames = () => t.mock.state.dns.map((r) => r.name);

function api(s: Session) {
  return (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      cookies: s.cookies,
      headers: s.headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
}

function hostBody(s: Session & { zoneId: string }, overrides: Record<string, unknown> = {}) {
  return {
    subdomain: 'nas',
    zoneId: s.zoneId,
    service: 'http://192.168.1.20:5000',
    access: { enabled: true, emails: ['Me@Example.com'], emailDomains: ['@family.example'] },
    ...overrides,
  };
}

describe('Cloudflare Access', () => {
  it('protects a host: reusable policy + self-hosted app, created before the route', async () => {
    const s = await setupConfigured(t);
    t.mock.state.requests.length = 0;
    const res = await api(s)('POST', '/api/hosts', hostBody(s));
    expect(res.statusCode).toBe(201);
    const host = res.json<ProxyHost>();
    expect(host.access).toEqual({
      enabled: true,
      emails: ['me@example.com'],
      emailDomains: ['family.example'],
      sessionDuration: '24h',
      browserRendering: null,
    });

    expect(policies()).toHaveLength(1);
    expect(policies()[0]).toMatchObject({
      name: accessResourceName('nas.example.com'),
      decision: 'allow',
      include: [
        { email: { email: 'me@example.com' } },
        { email_domain: { domain: 'family.example' } },
      ],
    });
    expect(apps()).toHaveLength(1);
    expect(apps()[0]).toMatchObject({
      name: '[Burrow] nas.example.com',
      type: 'self_hosted',
      domain: 'nas.example.com',
      destinations: [{ type: 'public', uri: 'nas.example.com' }],
      session_duration: '24h',
      app_launcher_visible: false,
      policyIds: [policies()[0]!.id],
    });
    expect(ingressHosts()).toEqual(['nas.example.com']);
    expect(dnsNames()).toEqual(['nas.example.com']);

    // The Access app exists before the hostname goes live.
    const order = t.mock.state.requests.map((r) => `${r.method} ${r.path}`);
    const appAt = order.findIndex((r) => r.startsWith('POST') && r.endsWith('/access/apps'));
    // (A background startup sync may write the configuration earlier: look at the last write.)
    const ingressAt = order.findLastIndex(
      (r) => r.startsWith('PUT') && r.endsWith('/configurations'),
    );
    const dnsAt = order.findIndex((r) => r.startsWith('POST') && r.endsWith('/dns_records'));
    expect(appAt).toBeGreaterThanOrEqual(0);
    expect(appAt).toBeLessThan(ingressAt);
    expect(appAt).toBeLessThan(dnsAt);
    expect(t.ctx.settings.get(SettingKeys.managedAccess)).toEqual(['nas.example.com']);
  });

  it('never calls the Access API while no host is protected', async () => {
    const s = await setupConfigured(t);
    t.mock.state.requests.length = 0;
    const res = await api(s)('POST', '/api/hosts', hostBody(s, { access: undefined }));
    expect(res.statusCode).toBe(201);
    await api(s)('POST', '/api/sync');
    expect(t.mock.state.requests.some((r) => r.path.includes('/access/'))).toBe(false);
  });

  it('rejects protection without any allowed email or domain', async () => {
    const s = await setupConfigured(t);
    const res = await api(s)(
      'POST',
      '/api/hosts',
      hostBody(s, { access: { enabled: true, emails: [], emailDomains: [] } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(apps()).toHaveLength(0);
  });

  it('updates the policy when the allow list changes, and removes protection when turned off', async () => {
    const s = await setupConfigured(t);
    const host = (await api(s)('POST', '/api/hosts', hostBody(s))).json<ProxyHost>();
    const appId = apps()[0]!.id;

    const res = await api(s)(
      'PUT',
      `/api/hosts/${host.id}`,
      hostBody(s, {
        access: { enabled: true, emails: ['friend@example.net'], sessionDuration: '6h' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(apps()).toHaveLength(1);
    expect(apps()[0]).toMatchObject({ id: appId, session_duration: '6h' });
    expect(policies()).toHaveLength(1);
    expect(policies()[0]!.include).toEqual([{ email: { email: 'friend@example.net' } }]);

    const off = await api(s)('PUT', `/api/hosts/${host.id}`, hostBody(s, { access: undefined }));
    expect(off.statusCode).toBe(200);
    expect(off.json<ProxyHost>().access.enabled).toBe(false);
    expect(apps()).toHaveLength(0);
    expect(policies()).toHaveLength(0);
    // Still published, now public.
    expect(ingressHosts()).toEqual(['nas.example.com']);
    expect(t.ctx.settings.get(SettingKeys.managedAccess)).toEqual([]);
  });

  it('deletes the Access app and policy after the route when the host is deleted', async () => {
    const s = await setupConfigured(t);
    const host = (await api(s)('POST', '/api/hosts', hostBody(s))).json<ProxyHost>();
    t.mock.state.requests.length = 0;
    const res = await api(s)('DELETE', `/api/hosts/${host.id}`);
    expect(res.statusCode).toBe(204);
    expect(apps()).toHaveLength(0);
    expect(policies()).toHaveLength(0);
    expect(ingressHosts()).toEqual([]);
    expect(dnsNames()).toEqual([]);

    const order = t.mock.state.requests.map((r) => `${r.method} ${r.path}`);
    const ingressAt = order.findIndex((r) => r.startsWith('PUT') && r.endsWith('/configurations'));
    const appAt = order.findIndex((r) => r.startsWith('DELETE') && r.includes('/access/apps/'));
    expect(ingressAt).toBeLessThan(appAt);
  });

  it('merges the allow lists of hosts sharing a hostname into one app', async () => {
    const s = await setupConfigured(t);
    await api(s)('POST', '/api/hosts', hostBody(s));
    const res = await api(s)(
      'POST',
      '/api/hosts',
      hostBody(s, {
        path: '^/api',
        service: 'http://192.168.1.20:6000',
        access: { enabled: true, emails: ['bot@example.com'], sessionDuration: '30m' },
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(apps()).toHaveLength(1);
    expect(apps()[0]!.session_duration).toBe('30m');
    expect(policies()[0]!.include).toEqual([
      { email: { email: 'bot@example.com' } },
      { email: { email: 'me@example.com' } },
      { email_domain: { domain: 'family.example' } },
    ]);
  });

  it('refuses with ACCESS_CONFLICT and publishes nothing when a foreign app covers the hostname', async () => {
    const s = await setupConfigured(t);
    t.mock.addAccessApp({ name: 'My NAS', domain: 'nas.example.com' });
    const res = await api(s)('POST', '/api/hosts', hostBody(s));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACCESS_CONFLICT');
    expect(res.json().error.message).toContain('"My NAS"');
    expect(apps()).toHaveLength(1);
    expect(apps()[0]!.name).toBe('My NAS');
    expect(policies()).toHaveLength(0);
    expect(ingressHosts()).toEqual([]);
    expect(dnsNames()).toEqual([]);
    const hosts = (await api(s)('GET', '/api/hosts')).json<{ hosts: ProxyHost[] }>().hosts;
    expect(hosts).toHaveLength(0);
  });

  it('fails closed: a host whose app cannot be created is not published', async () => {
    const s = await setupConfigured(t);
    t.mock.failNext('POST', /\/access\/apps$/, 400, 1, 'Zero Trust is not set up');
    const res = await api(s)('POST', '/api/hosts', hostBody(s));
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('Zero Trust');
    expect(ingressHosts()).toEqual([]);
    expect(dnsNames()).toEqual([]);
    // The policy created just before the failure is cleaned up.
    expect(policies()).toHaveLength(0);
  });

  it('explains a missing Access permission and keeps a public host as it was', async () => {
    const s = await setupConfigured(t);
    const host = (
      await api(s)('POST', '/api/hosts', hostBody(s, { access: undefined }))
    ).json<ProxyHost>();
    t.mock.failNext('GET', /\/access\/apps$/, 403, 1);
    const res = await api(s)('PUT', `/api/hosts/${host.id}`, hostBody(s));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'CLOUDFLARE_PERMISSION_MISSING' });
    expect(res.json().error.message).toContain('Access: Apps and Policies');
    // Reverted: still published, still public.
    const after = (await api(s)('GET', `/api/hosts/${host.id}`)).json<ProxyHost>();
    expect(after.access.enabled).toBe(false);
    expect(after.sync.status).toBe('synced');
    expect(ingressHosts()).toEqual(['nas.example.com']);
    expect(dnsNames()).toEqual(['nas.example.com']);
  });

  it('keeps an already protected host published when Access is briefly unreachable', async () => {
    const s = await setupConfigured(t);
    await api(s)('POST', '/api/hosts', hostBody(s));
    t.mock.failNext('GET', /\/access\/policies$/, 500, 10);
    const res = await api(s)('POST', '/api/sync');
    expect(res.json().ok).toBe(false);
    expect(ingressHosts()).toEqual(['nas.example.com']);
    expect(apps()).toHaveLength(1);
  });

  it('repairs drift: deleted app, edited policy, and orphans it owns', async () => {
    const s = await setupConfigured(t);
    await api(s)('POST', '/api/hosts', hostBody(s));
    const other = (
      await api(s)('POST', '/api/hosts', hostBody(s, { subdomain: 'old' }))
    ).json<ProxyHost>();
    expect(apps()).toHaveLength(2);

    // Drift: app of nas deleted by hand, policy of old edited, a foreign app untouched.
    const nasApp = apps().find((a) => a.domain === 'nas.example.com')!;
    t.mock.state.accessApps = apps().filter((a) => a !== nasApp);
    policies().find((p) => p.name === accessResourceName('old.example.com'))!.include = [
      { everyone: {} },
    ];
    t.mock.addAccessApp({ name: 'Wiki', domain: 'wiki.example.com' });
    // old is deleted from the DB while Cloudflare is down: its app becomes an orphan.
    t.mock.failNext('GET', /\/cfd_tunnel\/[^/]+\/configurations$/, 500, 4);
    await api(s)('DELETE', `/api/hosts/${other.id}`);

    const res = await api(s)('POST', '/api/sync');
    expect(res.json().ok).toBe(true);
    expect(
      apps()
        .map((a) => a.domain)
        .sort(),
    ).toEqual(['nas.example.com', 'wiki.example.com']);
    expect(policies()).toHaveLength(1);
    expect(policies()[0]!.name).toBe('[Burrow] nas.example.com');
    expect(ingressHosts()).toEqual(['nas.example.com']);
  });

  it('marks the Access permission as optional in the token checks', async () => {
    const s = await setupConfigured(t);
    const settings = (await api(s)('GET', '/api/cloudflare')).json();
    expect(settings.permissions).toContainEqual(
      expect.objectContaining({
        name: 'Account › Access: Apps and Policies › Edit',
        ok: true,
        optional: true,
      }),
    );
  });

  it('saves a token without the Access permission', async () => {
    const s = await setupConfigured(t);
    const res = await api(s)('PUT', '/api/cloudflare/token', {
      token: 'noaccess-token-0123456789abcdef',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().permissions).toContainEqual(
      expect.objectContaining({ name: 'Account › Access: Apps and Policies › Edit', ok: false }),
    );
  });
});
