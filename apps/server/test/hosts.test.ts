import { dnsOwnershipComment, type ProxyHost } from '@burrow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingKeys } from '../src/db/settings.js';
import {
  createTestApp,
  setupAdmin,
  setupConfigured,
  VALID_TOKEN,
  waitFor,
  type Session,
  type TestApp,
} from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const tunnel = () => t.mock.state.tunnels.find((x) => !x.deleted_at)!;
const ingress = () => tunnel().config?.ingress ?? [];
const dns = () => t.mock.state.dns;

function api(s: Session) {
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    t.app.inject({
      method,
      url,
      cookies: s.cookies,
      headers: s.headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  return call;
}

describe('Cloudflare token', () => {
  it('rejects an invalid token with permission details', async () => {
    const s = await setupAdmin(t.app);
    const res = await api(s)('PUT', '/api/cloudflare/token', {
      token: 'invalid-token-0123456789abcdef',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'CLOUDFLARE_TOKEN_INVALID',
      details: { permissions: [] },
    });
    expect(t.ctx.cloudflare.isConfigured()).toBe(false);
  });

  it('rejects a token without tunnel permission and lists the checks', async () => {
    const s = await setupAdmin(t.app);
    const res = await api(s)('PUT', '/api/cloudflare/token', {
      token: 'noperm-token-0123456789abcdef',
    });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('CLOUDFLARE_PERMISSION_MISSING');
    expect(err.details.permissions).toContainEqual(
      expect.objectContaining({ name: 'Account › Cloudflare Tunnel › Edit', ok: false }),
    );
  });

  it('saves the token encrypted, creates the tunnel and starts cloudflared', async () => {
    const s = await setupAdmin(t.app);
    const res = await api(s)('PUT', '/api/cloudflare/token', { token: VALID_TOKEN });
    expect(res.statusCode).toBe(200);
    const settings = res.json();
    expect(settings).toMatchObject({
      configured: true,
      tokenHint: VALID_TOKEN.slice(-4),
      account: { name: 'Mock Account' },
    });
    expect(settings.permissions.every((p: { ok: boolean }) => p.ok)).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(VALID_TOKEN);

    const stored = t.ctx.sqlite
      .prepare("SELECT value FROM settings WHERE key = 'cloudflare.token'")
      .get() as { value: string };
    expect(stored.value).not.toContain(VALID_TOKEN);

    expect(t.mock.state.tunnels).toHaveLength(1);
    expect(tunnel().name).toMatch(/^burrow-[0-9a-f]{6}$/);
    expect(tunnel().config_src).toBe('cloudflare');
    await waitFor(() => t.ctx.supervisor.status().state === 'running');

    const status = (await api(s)('GET', '/api/setup/status')).json();
    expect(status).toEqual({ userCreated: true, cloudflareConfigured: true, tunnelReady: true });
    const info = (await api(s)('GET', '/api/tunnel')).json();
    expect(info.tunnel).toMatchObject({ id: tunnel().id, status: 'inactive' });
    expect(info.connectors[0].connections[0].colo).toBe('cdg01');
  });

  it('asks to choose when several accounts are visible, without saving anything', async () => {
    t.mock.state.accounts.push({ id: 'f'.repeat(32), name: 'Second' });
    const s = await setupAdmin(t.app);
    const res = await api(s)('PUT', '/api/cloudflare/token', { token: VALID_TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, account: null });
    expect(res.json().availableAccounts).toHaveLength(2);
    expect(t.ctx.cloudflare.isConfigured()).toBe(false);
    expect(t.mock.state.tunnels).toHaveLength(0);

    const chosen = await api(s)('PUT', '/api/cloudflare/token', {
      token: VALID_TOKEN,
      accountId: t.mock.state.accounts[0]!.id,
    });
    expect(chosen.json()).toMatchObject({ configured: true, account: { name: 'Mock Account' } });
  });

  it('reuses the stored tunnel on a second save', async () => {
    const s = await setupAdmin(t.app);
    await api(s)('PUT', '/api/cloudflare/token', { token: VALID_TOKEN });
    await api(s)('PUT', '/api/cloudflare/token', { token: VALID_TOKEN });
    expect(t.mock.state.tunnels).toHaveLength(1);
  });

  it('DELETE stops cloudflared and forgets the token', async () => {
    const s = await setupAdmin(t.app);
    await api(s)('PUT', '/api/cloudflare/token', { token: VALID_TOKEN });
    const res = await api(s)('DELETE', '/api/cloudflare/token');
    expect(res.statusCode).toBe(204);
    expect(t.ctx.supervisor.status().state).toBe('disabled');
    expect((await api(s)('GET', '/api/cloudflare')).json()).toMatchObject({
      configured: false,
      tokenHint: null,
    });
  });
});

describe('zones', () => {
  it('merges live zones with the local enabled flag', async () => {
    const s = await setupConfigured(t);
    const zones = (await api(s)('GET', '/api/zones')).json().zones;
    expect(zones).toEqual([
      expect.objectContaining({ name: 'example.com', enabled: true, hostCount: 0 }),
      expect.objectContaining({ name: 'example.org', enabled: false, hostCount: 0 }),
    ]);
  });

  it('refuses to disable a zone that still has hosts', async () => {
    const s = await setupConfigured(t);
    await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://127.0.0.1:1',
    });
    const res = await api(s)('PATCH', `/api/zones/${s.zoneId}`, { enabled: false });
    expect(res.statusCode).toBe(409);
  });

  it('cannot create hosts in a zone that is not enabled', async () => {
    const s = await setupConfigured(t);
    const other = t.mock.state.zones[1]!;
    const res = await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: other.id,
      service: 'http://x:1',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('proxy hosts', () => {
  it('creates a host: ingress rule + proxied CNAME with the ownership comment', async () => {
    const s = await setupConfigured(t);
    const res = await api(s)('POST', '/api/hosts', {
      subdomain: 'App',
      zoneId: s.zoneId,
      service: 'https://192.168.1.20:8443',
      options: { noTLSVerify: true, httpHostHeader: 'nas.lan' },
    });
    expect(res.statusCode).toBe(201);
    const host = res.json<ProxyHost>();
    expect(host).toMatchObject({
      subdomain: 'app',
      hostname: 'app.example.com',
      zoneName: 'example.com',
      enabled: true,
      sync: { status: 'synced', error: null },
      options: { noTLSVerify: true, httpHostHeader: 'nas.lan', originServerName: '' },
    });

    expect(ingress()).toEqual([
      {
        hostname: 'app.example.com',
        service: 'https://192.168.1.20:8443',
        originRequest: { noTLSVerify: true, httpHostHeader: 'nas.lan' },
      },
      { service: 'http_status:404' },
    ]);
    expect(dns()).toEqual([
      expect.objectContaining({
        type: 'CNAME',
        name: 'app.example.com',
        content: `${tunnel().id}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: dnsOwnershipComment(tunnel().id),
      }),
    ]);
    const list = (await api(s)('GET', '/api/hosts')).json().hosts;
    expect(list).toHaveLength(1);
    expect((await api(s)('GET', `/api/hosts/${host.id}`)).json().id).toBe(host.id);
  });

  it('supports the zone apex and path rules sharing one CNAME', async () => {
    const s = await setupConfigured(t);
    const root = await api(s)('POST', '/api/hosts', {
      subdomain: '@',
      zoneId: s.zoneId,
      service: 'http://web:80',
    });
    const apiHost = await api(s)('POST', '/api/hosts', {
      subdomain: '@',
      zoneId: s.zoneId,
      service: 'http://api:80',
      path: '^/api',
    });
    expect(root.statusCode).toBe(201);
    expect(apiHost.statusCode).toBe(201);
    expect(ingress().map((r) => [r.hostname, r.path ?? ''])).toEqual([
      ['example.com', '^/api'],
      ['example.com', ''],
      [undefined, ''],
    ]);
    expect(dns().filter((r) => r.name === 'example.com')).toHaveLength(1);
  });

  it('returns 409 CONFLICT for a duplicate hostname and path', async () => {
    const s = await setupConfigured(t);
    await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    const dup = await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://b:1',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CONFLICT');
  });

  it('returns 409 DNS_CONFLICT and changes nothing when a foreign record exists', async () => {
    const s = await setupConfigured(t);
    t.mock.addDnsRecord({
      zone_id: s.zoneId,
      name: 'taken.example.com',
      type: 'A',
      content: '192.0.2.10',
    });
    await waitFor(() => ingress().length > 0); // initial background reconcile wrote the catch-all
    const before = JSON.stringify(ingress());
    const res = await api(s)('POST', '/api/hosts', {
      subdomain: 'taken',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DNS_CONFLICT');
    expect((await api(s)('GET', '/api/hosts')).json().hosts).toEqual([]);
    expect(dns()).toHaveLength(1);
    expect(dns()[0]!.content).toBe('192.0.2.10');
    expect(JSON.stringify(ingress())).toBe(before);
  });

  it('rolls back the ingress rule when the CNAME cannot be created', async () => {
    const s = await setupConfigured(t);
    t.mock.failNext('POST', /\/dns_records$/, 400, 1, 'DNS write not allowed');
    const res = await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('DNS write not allowed');
    expect(ingress().some((r) => r.hostname === 'app.example.com')).toBe(false);
    expect((await api(s)('GET', '/api/hosts')).json().hosts).toEqual([]);
  });

  it('maps a 403 from Cloudflare to CLOUDFLARE_PERMISSION_MISSING', async () => {
    const s = await setupConfigured(t);
    t.mock.failNext('POST', /\/dns_records$/, 403, 1, 'Authentication error');
    const res = await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    expect(res.json().error.code).toBe('CLOUDFLARE_PERMISSION_MISSING');
  });

  it('keeps foreign ingress rules untouched', async () => {
    const s = await setupConfigured(t);
    const foreign = { hostname: 'ssh.example.com', service: 'ssh://10.0.0.5:22' };
    tunnel().config = { ingress: [foreign, { service: 'http_status:404' }] };
    await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    expect(ingress()).toContainEqual(foreign);
    const id = (await api(s)('GET', '/api/hosts')).json().hosts[0].id;
    await api(s)('DELETE', `/api/hosts/${id}`);
    expect(ingress()).toEqual([foreign, { service: 'http_status:404' }]);
  });

  it('updates a host and moves the CNAME when the subdomain changes', async () => {
    const s = await setupConfigured(t);
    const created = (
      await api(s)('POST', '/api/hosts', {
        subdomain: 'old',
        zoneId: s.zoneId,
        service: 'http://a:1',
      })
    ).json();
    const res = await api(s)('PUT', `/api/hosts/${created.id}`, {
      subdomain: 'new',
      zoneId: s.zoneId,
      service: 'http://b:2',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hostname: 'new.example.com',
      service: 'http://b:2',
      sync: { status: 'synced' },
    });
    expect(ingress()).toEqual([
      { hostname: 'new.example.com', service: 'http://b:2' },
      { service: 'http_status:404' },
    ]);
    expect(dns().map((r) => r.name)).toEqual(['new.example.com']);
  });

  it('reverts an update that hits a DNS conflict', async () => {
    const s = await setupConfigured(t);
    t.mock.addDnsRecord({ zone_id: s.zoneId, name: 'taken.example.com' });
    const created = (
      await api(s)('POST', '/api/hosts', {
        subdomain: 'mine',
        zoneId: s.zoneId,
        service: 'http://a:1',
      })
    ).json();
    const res = await api(s)('PUT', `/api/hosts/${created.id}`, {
      subdomain: 'taken',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    expect(res.statusCode).toBe(409);
    expect((await api(s)('GET', `/api/hosts/${created.id}`)).json().hostname).toBe(
      'mine.example.com',
    );
    expect(ingress()[0]).toMatchObject({ hostname: 'mine.example.com' });
    expect(
      dns()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['mine.example.com', 'taken.example.com']);
  });

  it('disabling a host removes its rule and CNAME but keeps the row', async () => {
    const s = await setupConfigured(t);
    const created = (
      await api(s)('POST', '/api/hosts', {
        subdomain: 'app',
        zoneId: s.zoneId,
        service: 'http://a:1',
      })
    ).json();
    const res = await api(s)('PUT', `/api/hosts/${created.id}`, {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
      enabled: false,
    });
    expect(res.json()).toMatchObject({ enabled: false, sync: { status: 'synced' } });
    expect(ingress()).toEqual([{ service: 'http_status:404' }]);
    expect(dns()).toEqual([]);

    const again = await api(s)('PUT', `/api/hosts/${created.id}`, {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    expect(again.json().enabled).toBe(true);
    expect(dns()).toHaveLength(1);
  });

  it('deletes a host: rule, CNAME and row', async () => {
    const s = await setupConfigured(t);
    const created = (
      await api(s)('POST', '/api/hosts', {
        subdomain: 'app',
        zoneId: s.zoneId,
        service: 'http://a:1',
      })
    ).json();
    const res = await api(s)('DELETE', `/api/hosts/${created.id}`);
    expect(res.statusCode).toBe(204);
    expect(ingress()).toEqual([{ service: 'http_status:404' }]);
    expect(dns()).toEqual([]);
    expect((await api(s)('GET', `/api/hosts/${created.id}`)).statusCode).toBe(404);
  });

  it('probes the origin on demand', async () => {
    const s = await setupConfigured(t);
    const created = (
      await api(s)('POST', '/api/hosts', {
        subdomain: 'app',
        zoneId: s.zoneId,
        service: 'http://127.0.0.1:1',
      })
    ).json();
    const res = await api(s)('POST', `/api/hosts/${created.id}/check`);
    expect(res.json()).toMatchObject({ state: 'down', error: expect.stringMatching(/refused/i) });
    expect((await api(s)('GET', `/api/hosts/${created.id}`)).json().health.state).toBe('down');
  });

  it('writes audit entries without secrets', async () => {
    const s = await setupConfigured(t);
    await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    const rows = t.ctx.sqlite.prepare('SELECT action, target FROM audit_log').all() as Array<{
      action: string;
      target: string;
    }>;
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'setup.admin',
        'cloudflare.token.save',
        'zone.enable',
        'host.create',
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain(VALID_TOKEN);
  });
});

describe('reconciliation', () => {
  it('repairs drift: deleted CNAME, edited rule and orphans', async () => {
    const s = await setupConfigured(t);
    await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    const tid = tunnel().id;
    // Someone deletes our CNAME, edits our rule, and an orphan of ours is left behind.
    t.mock.state.dns = [];
    tunnel().config = {
      ingress: [
        { hostname: 'app.example.com', service: 'http://tampered:1' },
        { service: 'http_status:404' },
      ],
    };
    t.mock.addDnsRecord({
      zone_id: s.zoneId,
      name: 'orphan.example.com',
      type: 'CNAME',
      content: `${tid}.cfargotunnel.com`,
      comment: dnsOwnershipComment(tid),
    });
    t.mock.addDnsRecord({
      zone_id: s.zoneId,
      name: 'manual.example.com',
      type: 'A',
      content: '192.0.2.2',
    });

    const res = await api(s)('POST', '/api/sync');
    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result.ok).toBe(true);
    expect(result.actions.map((a: { kind: string }) => a.kind).sort()).toEqual([
      'dns.create',
      'dns.delete',
      'ingress.update',
    ]);
    expect(ingress()[0]).toEqual({ hostname: 'app.example.com', service: 'http://a:1' });
    expect(
      dns()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['app.example.com', 'manual.example.com']);

    expect((await api(s)('GET', '/api/sync')).json()).toEqual(result);
    const second = (await api(s)('POST', '/api/sync')).json();
    expect(second.actions).toEqual([]);
  });

  it('marks a host in conflict when a foreign record appears later', async () => {
    const s = await setupConfigured(t);
    const created = (
      await api(s)('POST', '/api/hosts', {
        subdomain: 'app',
        zoneId: s.zoneId,
        service: 'http://a:1',
      })
    ).json();
    t.mock.state.dns[0]!.comment = 'edited by hand';
    const result = (await api(s)('POST', '/api/sync')).json();
    expect(result.ok).toBe(false);
    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: 'host.conflict', target: 'app.example.com' }),
    );
    const host = (await api(s)('GET', `/api/hosts/${created.id}`)).json();
    expect(host.sync.status).toBe('error');
    expect(host.sync.error).toMatch(/not created by Burrow/);
    expect(dns()[0]!.comment).toBe('edited by hand');
  });

  it('recreates a tunnel deleted on Cloudflare and repoints the CNAMEs', async () => {
    const s = await setupConfigured(t);
    await api(s)('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
    });
    await waitFor(() => t.ctx.supervisor.status().state === 'running');
    const oldId = tunnel().id;
    const oldPid = t.ctx.supervisor.status().pid;
    tunnel().deleted_at = new Date().toISOString();

    const result = (await api(s)('POST', '/api/sync')).json();
    expect(result.actions.map((a: { kind: string }) => a.kind)).toEqual([
      'tunnel.create',
      'ingress.update',
      'dns.update',
    ]);
    const fresh = tunnel();
    expect(fresh.id).not.toBe(oldId);
    expect(t.ctx.settings.get(SettingKeys.tunnelId)).toBe(fresh.id);
    expect(fresh.config?.ingress?.[0]).toMatchObject({ hostname: 'app.example.com' });
    expect(dns()[0]).toMatchObject({
      content: `${fresh.id}.cfargotunnel.com`,
      comment: dnsOwnershipComment(fresh.id),
    });
    // cloudflared is restarted with the new token.
    await waitFor(
      () =>
        t.ctx.supervisor.status().state === 'running' && t.ctx.supervisor.status().pid !== oldPid,
    );
  });

  it('reports Cloudflare outages in the result and marks hosts as error', async () => {
    const s = await setupConfigured(t);
    const created = (
      await api(s)('POST', '/api/hosts', {
        subdomain: 'app',
        zoneId: s.zoneId,
        service: 'http://a:1',
      })
    ).json();
    t.mock.failNext('GET', /\/configurations$/, 500, 10);
    const result = (await api(s)('POST', '/api/sync')).json();
    expect(result.ok).toBe(false);
    expect((await api(s)('GET', `/api/hosts/${created.id}`)).json().sync.status).toBe('error');
  });
});

describe('logs', () => {
  it('returns the recent cloudflared lines', async () => {
    const s = await setupConfigured(t);
    await waitFor(() => t.ctx.supervisor.status().state === 'running');
    const lines = (await api(s)('GET', '/api/logs?limit=50')).json().lines;
    expect(
      lines.some((l: { message: string }) => l.message.includes('Registered tunnel connection')),
    ).toBe(true);
  });

  it('streams lines over SSE with Last-Event-ID resume', async () => {
    const s = await setupConfigured(t);
    await waitFor(() => t.ctx.supervisor.status().state === 'running');
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const res = await fetch(`${address}/api/logs/stream`, {
      headers: { cookie: `burrow_session=${s.cookies.burrow_session}`, 'last-event-id': '0' },
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('Registered tunnel connection')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain('event: state');
    expect(text).toMatch(/id: 1\nevent: log\ndata: \{/);
  });
});
