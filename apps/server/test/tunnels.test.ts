import { dnsOwnershipComment } from '@burrow/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findMigrationsFolder } from '../src/db/client.js';
import { apiFor, createTestApp, setupConfigured, waitFor, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const live = () => t.mock.state.tunnels.filter((x) => !x.deleted_at);
const byName = (name: string) => live().find((x) => x.name === name)!;
const hostnames = (name: string) =>
  (byName(name).config?.ingress ?? []).map((r) => r.hostname).filter(Boolean);

describe('several tunnels', () => {
  it('creates a second tunnel and publishes a host through it', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    const created = await api('POST', '/api/tunnels', { name: 'lab' });
    expect(created.statusCode).toBe(201);
    const lab = created.json();
    expect(lab).toMatchObject({ name: 'lab', origin: 'created', isDefault: false });

    const host = await api('POST', '/api/hosts', {
      subdomain: 'lab',
      zoneId: s.zoneId,
      service: 'http://lab:80',
      tunnelId: lab.id,
    });
    expect(host.statusCode).toBe(201);
    expect(host.json()).toMatchObject({ tunnelId: lab.id, tunnelName: 'lab' });
    expect(hostnames('lab')).toEqual(['lab.example.com']);
    const record = t.mock.state.dns.find((r) => r.name === 'lab.example.com')!;
    expect(record.content).toBe(`${lab.cfId}.cfargotunnel.com`);
    expect(record.comment).toBe(dnsOwnershipComment(lab.cfId));

    // One cloudflared per tunnel.
    await waitFor(() => t.ctx.supervisors.status(lab.id).state === 'running');
    const list = (await api('GET', '/api/tunnels')).json();
    expect(list.tunnels).toHaveLength(2);
    expect(list.tunnels[0].isDefault).toBe(true);
    expect(list.tunnels[1]).toMatchObject({ name: 'lab', hostCount: 1 });
  });

  it('moves a host to another tunnel without deleting its CNAME', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    const host = (
      await api('POST', '/api/hosts', { subdomain: 'app', zoneId: s.zoneId, service: 'http://a:1' })
    ).json();
    const defaultName = live()[0]!.name;
    expect(hostnames(defaultName)).toEqual(['app.example.com']);
    const recordId = t.mock.state.dns[0]!.id;

    const lab = (await api('POST', '/api/tunnels', { name: 'lab' })).json();
    const moved = await api('PUT', `/api/hosts/${host.id}`, {
      subdomain: 'app',
      zoneId: s.zoneId,
      service: 'http://a:1',
      tunnelId: lab.id,
    });
    expect(moved.statusCode).toBe(200);
    expect(hostnames(defaultName)).toEqual([]);
    expect(hostnames('lab')).toEqual(['app.example.com']);
    expect(t.mock.state.dns).toHaveLength(1);
    expect(t.mock.state.dns[0]).toMatchObject({
      id: recordId,
      content: `${lab.cfId}.cfargotunnel.com`,
      comment: dnsOwnershipComment(lab.cfId),
    });

    // A full sync is stable: nothing more to do.
    const sync = (await api('POST', '/api/sync')).json();
    expect(sync.ok).toBe(true);
    expect(sync.actions).toEqual([]);
  });

  it('refuses to delete the default tunnel or a tunnel with hosts, deletes an empty one', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    const tunnels = () => api('GET', '/api/tunnels').then((r) => r.json().tunnels);
    const [main] = await tunnels();
    expect((await api('DELETE', `/api/tunnels/${main.id}`)).statusCode).toBe(409);

    const lab = (await api('POST', '/api/tunnels', { name: 'lab' })).json();
    const host = (
      await api('POST', '/api/hosts', {
        subdomain: 'x',
        zoneId: s.zoneId,
        service: 'http://x:1',
        tunnelId: lab.id,
      })
    ).json();
    expect((await api('DELETE', `/api/tunnels/${lab.id}`)).statusCode).toBe(409);
    await api('DELETE', `/api/hosts/${host.id}`);

    const res = await api('DELETE', `/api/tunnels/${lab.id}`);
    expect(res.statusCode).toBe(204);
    expect(live().map((x) => x.name)).not.toContain('lab');
    expect(await tunnels()).toHaveLength(1);
    expect(t.ctx.supervisors.get(lab.id)).toBeUndefined();
  });

  it('makes another tunnel the default one', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    const lab = (await api('POST', '/api/tunnels', { name: 'lab' })).json();
    const res = await api('PATCH', `/api/tunnels/${lab.id}`, { isDefault: true });
    expect(res.json()).toMatchObject({ isDefault: true });
    const host = (
      await api('POST', '/api/hosts', { subdomain: 'n', zoneId: s.zoneId, service: 'http://n:1' })
    ).json();
    expect(host.tunnelName).toBe('lab');
  });

  it('stops cloudflared when "run connector" is turned off', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    const lab = (await api('POST', '/api/tunnels', { name: 'lab' })).json();
    await waitFor(() => t.ctx.supervisors.status(lab.id).state === 'running');
    await api('PATCH', `/api/tunnels/${lab.id}`, { runConnector: false });
    await waitFor(() => t.ctx.supervisors.get(lab.id) === undefined);
    expect(t.ctx.supervisors.status(lab.id).state).toBe('disabled');
    const start = await api('POST', `/api/tunnels/${lab.id}/start`);
    expect(start.statusCode).toBe(400);
  });
});

describe('importing a tunnel', () => {
  it('imports a remotely managed tunnel and its routes, adopting the dashboard CNAMEs', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    const existing = t.mock.addTunnel({
      name: 'home',
      config: {
        ingress: [
          {
            hostname: 'jellyfin.example.com',
            service: 'http://192.168.1.10:8096',
            originRequest: { noTLSVerify: true, connectTimeout: '30s' },
          },
          { hostname: 'hello.example.com', service: 'hello_world' },
          { hostname: 'other.unknown.net', service: 'http://x:1' },
          { service: 'http_status:404' },
        ],
      },
    });
    const cname = t.mock.addDnsRecord({
      zone_id: s.zoneId,
      name: 'jellyfin.example.com',
      type: 'CNAME',
      content: `${existing.id}.cfargotunnel.com`,
      proxied: true,
    });

    const available = (await api('GET', '/api/tunnels/available')).json();
    expect(available.tunnels).toEqual([
      expect.objectContaining({ cfId: existing.id, configSrc: 'cloudflare', routeCount: 3 }),
    ]);

    const res = await api('POST', '/api/tunnels/import', { cfId: existing.id });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.tunnel).toMatchObject({ name: 'home', origin: 'imported', runConnector: false });
    expect(body.routes).toEqual([
      expect.objectContaining({ hostname: 'jellyfin.example.com', skipped: null }),
      expect.objectContaining({ hostname: 'hello.example.com', skipped: expect.any(String) }),
      expect.objectContaining({ hostname: 'other.unknown.net', skipped: expect.any(String) }),
    ]);

    const hosts = (await api('GET', '/api/hosts')).json().hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      hostname: 'jellyfin.example.com',
      tunnelName: 'home',
      options: { noTLSVerify: true, extra: { connectTimeout: '30s' } },
      sync: { status: 'synced' },
    });
    // The CNAME was adopted, not recreated.
    expect(t.mock.state.dns.find((r) => r.id === cname.id)!.comment).toBe(
      dnsOwnershipComment(existing.id),
    );
    // Routes Burrow cannot manage are kept untouched; extra options survive a rewrite.
    const ingress = byName('home').config!.ingress!;
    expect(ingress).toContainEqual({ hostname: 'hello.example.com', service: 'hello_world' });
    expect(ingress).toContainEqual(
      expect.objectContaining({
        hostname: 'jellyfin.example.com',
        originRequest: { noTLSVerify: true, connectTimeout: '30s' },
      }),
    );
    expect(t.ctx.supervisors.get(body.tunnel.id)).toBeUndefined();
  });

  it('refuses a locally managed tunnel', async () => {
    const s = await setupConfigured(t);
    const local = t.mock.addTunnel({ name: 'old', config_src: 'local' });
    const res = await apiFor(t, s)('POST', '/api/tunnels/import', { cfId: local.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/locally managed/);
  });

  it('does not recreate an imported tunnel deleted on Cloudflare', async () => {
    const s = await setupConfigured(t);
    const api = apiFor(t, s);
    const existing = t.mock.addTunnel({
      name: 'home',
      config: {
        ingress: [
          { hostname: 'a.example.com', service: 'http://a:1' },
          { service: 'http_status:404' },
        ],
      },
    });
    await api('POST', '/api/tunnels/import', { cfId: existing.id });
    existing.deleted_at = new Date().toISOString();
    const sync = (await api('POST', '/api/sync')).json();
    expect(sync.ok).toBe(false);
    expect(live().map((x) => x.name)).not.toContain('home');
    const host = (await api('GET', '/api/hosts')).json().hosts[0];
    expect(host.sync.status).toBe('error');
    expect(host.sync.error).toMatch(/no longer exists/);
  });
});

describe('migration from a single tunnel', () => {
  it('moves the tunnel stored in settings into the tunnels table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-mig-'));
    try {
      const folder = join(dir, 'drizzle');
      cpSync(findMigrationsFolder(), folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const full = structuredClone(journal);
      journal.entries = journal.entries.filter((e: { tag: string }) =>
        ['0000_init', '0001_access'].includes(e.tag),
      );
      writeFileSync(journalPath, JSON.stringify(journal));

      const sqlite = new Database(join(dir, 'burrow.db'));
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: folder });
      const insert = sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      insert.run('tunnel.id', JSON.stringify('11111111-2222-3333-4444-555555555555'));
      insert.run('tunnel.name', JSON.stringify('burrow-abc123'));
      insert.run('tunnel.managed_ingress', JSON.stringify(['app.example.com|']));
      sqlite
        .prepare(
          "INSERT INTO proxy_hosts (subdomain, zone_id, hostname, service) VALUES ('app', 'z', 'app.example.com', 'http://a:1')",
        )
        .run();

      writeFileSync(journalPath, JSON.stringify(full));
      migrate(db, { migrationsFolder: folder });

      expect(sqlite.prepare('SELECT * FROM tunnels').all()).toEqual([
        expect.objectContaining({
          cf_id: '11111111-2222-3333-4444-555555555555',
          name: 'burrow-abc123',
          origin: 'created',
          is_default: 1,
          managed_ingress: '["app.example.com|"]',
        }),
      ]);
      expect(sqlite.prepare('SELECT tunnel_id FROM proxy_hosts').get()).toEqual({ tunnel_id: 1 });
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'tunnel.%'").get(),
      ).toEqual({ n: 0 });
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
