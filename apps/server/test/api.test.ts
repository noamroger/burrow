import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiFor, createTestApp, setupConfigured, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('OpenAPI', () => {
  it('serves the OpenAPI document and the docs page without a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/hosts', '/api/tunnels/import', '/api/config/import']),
    );
    const create = doc.paths['/api/hosts'].post;
    expect(create.requestBody.content['application/json'].schema.properties).toHaveProperty(
      'subdomain',
    );

    const page = await t.app.inject({ method: 'GET', url: '/api/docs/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).not.toMatch(/upgrade-insecure-requests/);
  });
});

describe('API tokens', () => {
  it('authenticates with a bearer token, without CSRF header', async () => {
    const s = await setupConfigured(t);
    const created = await apiFor(t, s)('POST', '/api/tokens', { name: 'ci' });
    expect(created.statusCode).toBe(201);
    const { token, hint } = created.json();
    expect(token).toMatch(/^burrow_/);
    expect(token.startsWith(hint)).toBe(true);

    const auth = { authorization: `Bearer ${token}` };
    const list = await t.app.inject({ method: 'GET', url: '/api/hosts', headers: auth });
    expect(list.statusCode).toBe(200);
    const host = await t.app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: auth,
      payload: { subdomain: 'ci', zoneId: s.zoneId, service: 'http://ci:80' },
    });
    expect(host.statusCode).toBe(201);

    // A token cannot mint tokens or change the password.
    const mint = await t.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: auth,
      payload: { name: 'x' },
    });
    expect(mint.statusCode).toBe(403);

    const tokens = (await apiFor(t, s)('GET', '/api/tokens')).json().tokens;
    expect(tokens).toEqual([
      expect.objectContaining({ name: 'ci', lastUsedAt: expect.any(String) }),
    ]);
    expect(JSON.stringify(tokens)).not.toContain(token);

    await apiFor(t, s)('DELETE', `/api/tokens/${tokens[0].id}`);
    const after = await t.app.inject({ method: 'GET', url: '/api/hosts', headers: auth });
    expect(after.statusCode).toBe(401);
  });

  it('ignores Authorization headers that are not Burrow tokens', async () => {
    const s = await setupConfigured(t);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/hosts',
      cookies: s.cookies,
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('configuration export and import', () => {
  it('exports without secrets and imports the file back', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    await api('POST', '/api/tunnels', { name: 'lab' });
    await api('POST', '/api/hosts', {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://app:80',
      options: { noTLSVerify: true },
      access: { enabled: false },
    });
    const lab = (await api('GET', '/api/tunnels'))
      .json()
      .tunnels.find((x: { name: string }) => x.name === 'lab');
    await api('POST', '/api/hosts', {
      subdomain: 'lab',
      zoneId: s.zoneId,
      service: 'http://lab:80',
      tunnelId: lab.id,
    });

    const exported = await api('GET', '/api/config/export');
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toMatch(/attachment; filename="burrow-config-/);
    const doc = exported.json();
    expect(doc).toMatchObject({ burrow: 1, zones: ['example.com'] });
    expect(doc.hosts).toEqual([
      expect.objectContaining({
        subdomain: 'app',
        zone: 'example.com',
        options: expect.objectContaining({ noTLSVerify: true }),
      }),
      expect.objectContaining({ subdomain: 'lab', tunnel: 'lab' }),
    ]);
    expect(exported.body).not.toContain('test-token');

    // Same file again: nothing changes.
    const same = (await api('POST', '/api/config/import', { config: doc })).json();
    expect(same.hosts).toMatchObject({
      created: [],
      updated: [],
      unchanged: ['app.example.com', 'lab.example.com'],
    });

    // Edit the file: one change, one new host, one removed host (replace mode), dry run first.
    doc.hosts[0].service = 'http://app:8080';
    doc.hosts.push({ subdomain: 'new', zone: 'example.com', service: 'http://new:1' });
    doc.hosts.push({ subdomain: 'x', zone: 'unknown.net', service: 'http://x:1' });
    doc.hosts.splice(1, 1);
    const dry = (
      await api('POST', '/api/config/import', { config: doc, mode: 'replace', dryRun: true })
    ).json();
    expect(dry).toMatchObject({
      dryRun: true,
      hosts: {
        created: ['new.example.com'],
        updated: ['app.example.com'],
        removed: ['lab.example.com'],
      },
      sync: null,
    });
    expect(dry.warnings.join(' ')).toMatch(/unknown\.net/);
    expect((await api('GET', '/api/hosts')).json().hosts).toHaveLength(2);

    const real = (await api('POST', '/api/config/import', { config: doc, mode: 'replace' })).json();
    expect(real.sync.ok).toBe(true);
    const hosts = (await api('GET', '/api/hosts')).json().hosts;
    expect(hosts.map((h: { hostname: string }) => h.hostname)).toEqual([
      'app.example.com',
      'new.example.com',
    ]);
    expect(hosts[0].service).toBe('http://app:8080');
    expect(t.mock.state.dns.map((r) => r.name).sort()).toEqual([
      'app.example.com',
      'new.example.com',
    ]);
  });

  it('creates missing tunnels by name and rejects duplicate hosts', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    const bad = await api('POST', '/api/config/import', {
      config: {
        burrow: 1,
        hosts: [
          { subdomain: 'a', zone: 'example.com', service: 'http://a:1' },
          { subdomain: 'a', zone: 'example.com', service: 'http://b:1' },
        ],
      },
    });
    expect(bad.statusCode).toBe(400);

    const res = (
      await api('POST', '/api/config/import', {
        config: {
          burrow: 1,
          tunnels: [{ name: 'site-b', runConnector: false }],
          hosts: [{ subdomain: 'b', zone: 'example.com', tunnel: 'site-b', service: 'http://b:1' }],
        },
      })
    ).json();
    expect(res.tunnelsCreated).toEqual(['site-b']);
    const host = (await api('GET', '/api/hosts')).json().hosts[0];
    expect(host.tunnelName).toBe('site-b');
  });
});
