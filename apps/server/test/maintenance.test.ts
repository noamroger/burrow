import { DEFAULT_MAINTENANCE_PAGE, renderMaintenancePage } from '@burrow/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceService } from '../src/services/maintenance.js';
import { apiFor, createTestApp, setupConfigured, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const ingress = () => t.mock.state.tunnels.find((x) => !x.deleted_at)?.config?.ingress ?? [];

describe('maintenance page rendering', () => {
  it('escapes the simple design and fills placeholders', () => {
    const html = renderMaintenancePage(
      { ...DEFAULT_MAINTENANCE_PAGE, title: '<b>Back soon</b>', message: 'Host: {{hostname}}' },
      { hostname: 'app.example.com', until: '2026-11-20T18:00:00.000Z' },
    );
    expect(html).toContain('&lt;b&gt;Back soon&lt;/b&gt;');
    expect(html).toContain('Host: app.example.com');
    expect(html).toContain('Expected back');
    expect(html).not.toContain('<b>Back soon</b>');
  });

  it('serves custom HTML as written, with escaped placeholders', () => {
    const html = renderMaintenancePage(
      { ...DEFAULT_MAINTENANCE_PAGE, mode: 'html', html: '<h1>{{hostname}}</h1><p>{{until}}</p>' },
      { hostname: 'a<b>.example.com', until: null },
    );
    expect(html).toBe('<h1>a&lt;b&gt;.example.com</h1><p></p>');
  });
});

describe('maintenance mode', () => {
  it('routes the host to the maintenance server and back', async () => {
    const s = await setupConfigured(t);
    const call = apiFor(t, s);
    const host = (
      await call('POST', '/api/hosts', {
        subdomain: 'app',
        zoneId: s.zoneId,
        service: 'https://10.0.0.1:8443',
        options: { noTLSVerify: true },
      })
    ).json();
    const hostname = `app.${s.zoneName}`;
    const rule = () => ingress().find((r) => r.hostname === hostname);

    const on = await call('PUT', `/api/hosts/${host.id}/maintenance`, {
      enabled: true,
      until: '2030-01-01T10:00:00Z',
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().maintenance).toMatchObject({
      enabled: true,
      until: '2030-01-01T10:00:00.000Z',
      page: null,
    });
    expect(on.json().service).toBe('https://10.0.0.1:8443');
    expect(rule()).toEqual({ hostname, service: 'http://127.0.0.1:8081' });

    // The maintenance server answers for that hostname with the default page.
    const r = t.ctx.maintenance.respond(`${hostname}:443`);
    expect(r.status).toBe(503);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(1000);
    expect(r.body).toContain(DEFAULT_MAINTENANCE_PAGE.title);

    // No drift reported for the switched route.
    const drift = (await call('POST', '/api/drift/check')).json();
    expect(drift.items).toEqual([]);

    const off = await call('PUT', `/api/hosts/${host.id}/maintenance`, { enabled: false });
    expect(off.json().maintenance.enabled).toBe(false);
    expect(rule()).toEqual({
      hostname,
      service: 'https://10.0.0.1:8443',
      originRequest: { noTLSVerify: true },
    });
  });

  it('uses the default page from settings, or a page for the host', async () => {
    const s = await setupConfigured(t);
    const call = apiFor(t, s);
    const saved = await call('PUT', '/api/maintenance/page', {
      title: 'Upgrading the NAS',
      accentColor: '#123456',
    });
    expect(saved.statusCode).toBe(200);
    expect((await call('GET', '/api/maintenance/page')).json().title).toBe('Upgrading the NAS');
    expect((await call('PUT', '/api/maintenance/page', { accentColor: 'red; }' })).statusCode).toBe(
      400,
    );

    const host = (
      await call('POST', '/api/hosts', {
        subdomain: 'app',
        zoneId: s.zoneId,
        service: 'http://10.0.0.1:80',
      })
    ).json();
    const hostname = `app.${s.zoneName}`;
    await call('PUT', `/api/hosts/${host.id}/maintenance`, { enabled: true });
    expect(t.ctx.maintenance.respond(hostname).body).toContain('Upgrading the NAS');

    await call('PUT', `/api/hosts/${host.id}/maintenance`, {
      enabled: true,
      page: { mode: 'html', html: '<p>Custom {{hostname}}</p>' },
    });
    const r = t.ctx.maintenance.respond(hostname);
    expect(r.body).toBe(`<p>Custom ${hostname}</p>`);
    expect(r.headers['content-security-policy']).toBeUndefined();
    // Unknown hostnames still get a page.
    expect(t.ctx.maintenance.respond('other.example.net').status).toBe(503);
  });

  it('listens on its own port and answers every path', async () => {
    const options = {
      db: t.ctx.db,
      settings: t.ctx.settings,
      hosts: t.ctx.hosts,
      reconciler: t.ctx.reconciler,
      cloudflare: t.ctx.cloudflare,
      audit: t.ctx.audit,
      logger: pino({ level: 'silent' }),
      listen: '127.0.0.1',
      origin: 'http://127.0.0.1:8081',
    };
    // Port 0 = turned off.
    const off = new MaintenanceService({ ...options, port: 0 });
    await off.start();
    expect(off.address()).toBeNull();

    const live = new MaintenanceService({
      ...options,
      port: 20_000 + Math.floor(Math.random() * 20_000),
    });
    await live.start();
    const res = await fetch(`http://127.0.0.1:${live.address()}/api/hosts`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    await live.stop();
  });
});
