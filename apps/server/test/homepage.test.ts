import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiFor, createTestApp, setupConfigured, type ApiCall, type TestApp } from './helpers.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let t: TestApp;
let icons: Server;
let iconRequests: string[];
let call: ApiCall;
let zoneId: string;

beforeEach(async () => {
  iconRequests = [];
  icons = createServer((req, res) => {
    iconRequests.push(req.url ?? '');
    if (req.url === '/svg/jellyfin.svg' || req.url === '/custom/logo.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.end(SVG);
    } else if (req.url === '/not-an-image') {
      res.setHeader('content-type', 'text/html');
      res.end('<html></html>');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => icons.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(icons.address() as AddressInfo).port}`;
  t = await createTestApp({ iconBaseUrl: base });
  const s = await setupConfigured(t);
  call = apiFor(t, s);
  zoneId = s.zoneId;
});
afterEach(async () => {
  await t.close();
  icons.closeAllConnections();
  await new Promise<void>((r) => icons.close(() => r()));
});

function iconBase(): string {
  return `http://127.0.0.1:${(icons.address() as AddressInfo).port}`;
}

async function host(body: Record<string, unknown>) {
  const res = await call('POST', '/api/hosts', { zoneId, ...body });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const anonymous = (url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers });

describe('homepage', () => {
  it('is off by default, then private, then public', async () => {
    expect((await anonymous('/api/home')).statusCode).toBe(404);
    expect((await call('GET', '/api/home')).statusCode).toBe(404);
    expect((await call('GET', '/api/homepage/settings')).json()).toMatchObject({
      enabled: false,
      visibility: 'private',
      title: 'Home',
    });

    await call('PUT', '/api/homepage/settings', { enabled: true });
    expect((await anonymous('/api/home')).statusCode).toBe(401);
    expect((await call('GET', '/api/home')).statusCode).toBe(200);

    await call('PUT', '/api/homepage/settings', { enabled: true, visibility: 'public' });
    expect((await anonymous('/api/home')).statusCode).toBe(200);

    // A public hostname needs a public page.
    const bad = await call('PUT', '/api/homepage/settings', {
      enabled: true,
      visibility: 'private',
      publicHostname: 'home.example.com',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('lists the services by group, without their origin URLs', async () => {
    await call('PUT', '/api/homepage/settings', {
      enabled: true,
      visibility: 'public',
      title: 'Our place',
    });
    const jf = await host({
      subdomain: 'media',
      service: 'http://192.168.1.20:8096',
      template: 'jellyfin',
    });
    await host({
      subdomain: 'ha',
      service: 'http://10.0.0.5:8123',
      home: { title: 'Lights', description: 'Home Assistant', group: 'House' },
    });
    await host({ subdomain: 'hidden', service: 'http://10.0.0.6', home: { visible: false } });
    await host({ subdomain: 'raw', service: 'tcp://10.0.0.7:25565' });
    await host({ subdomain: 'off', service: 'http://10.0.0.8', enabled: false });

    const res = await anonymous('/api/home');
    const data = res.json();
    expect(data.title).toBe('Our place');
    expect(data.groups.map((g: { name: string }) => g.name).sort()).toEqual(['House', 'Services']);
    const services = data.groups.flatMap((g: { services: unknown[] }) => g.services);
    expect(services).toHaveLength(2);
    expect(services.find((s: { id: number }) => s.id === jf.id)).toMatchObject({
      title: 'Jellyfin',
      url: `https://${jf.hostname}`,
      monogram: 'J',
      icon: expect.stringMatching(new RegExp(`^/api/home/icons/${jf.id}\\?v=`)),
      state: expect.stringMatching(/^(up|down|unknown)$/),
    });
    const lights = services.find((s: { title: string }) => s.title === 'Lights');
    expect(lights).toMatchObject({ description: 'Home Assistant', icon: null, monogram: 'L' });
    expect(res.body).not.toContain('192.168.1.20');
    expect(res.body).not.toContain('10.0.0.5');

    // Hidden statuses.
    await call('PUT', '/api/homepage/settings', {
      enabled: true,
      visibility: 'public',
      showStatus: false,
    });
    const quiet = (await anonymous('/api/home')).json();
    expect(quiet.groups[0].services[0].state).toBeNull();
  });

  it('serves icons from Dashboard Icons, URLs and uploads, cached', async () => {
    await call('PUT', '/api/homepage/settings', { enabled: true, visibility: 'public' });
    const jf = await host({ subdomain: 'media', service: 'http://jf:8096', template: 'jellyfin' });
    const custom = await host({
      subdomain: 'app',
      service: 'http://app',
      home: { icon: `${iconBase()}/custom/logo.svg` },
    });
    const uploaded = await host({
      subdomain: 'up',
      service: 'http://up',
      home: { icon: `data:image/png;base64,${PNG_1PX}` },
    });
    const broken = await host({
      subdomain: 'broken',
      service: 'http://broken',
      home: { icon: `${iconBase()}/not-an-image` },
    });
    const missing = await host({
      subdomain: 'nope',
      service: 'http://nope',
      home: { icon: 'nope' },
    });

    const first = await anonymous(`/api/home/icons/${jf.id}`);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/svg+xml');
    expect(first.headers['content-security-policy']).toContain('sandbox');
    expect(first.headers['cache-control']).toBe('public, max-age=86400');
    expect(first.body).toBe(SVG);
    // Cached on disk: not downloaded again.
    await anonymous(`/api/home/icons/${jf.id}`);
    expect(iconRequests.filter((u) => u === '/svg/jellyfin.svg')).toHaveLength(1);

    expect((await anonymous(`/api/home/icons/${custom.id}`)).body).toBe(SVG);
    const png = await anonymous(`/api/home/icons/${uploaded.id}`);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');

    expect((await anonymous(`/api/home/icons/${broken.id}`)).statusCode).toBe(404);
    // A Dashboard Icons name tries the SVG, then the PNG.
    expect((await anonymous(`/api/home/icons/${missing.id}`)).statusCode).toBe(404);
    expect(iconRequests).toEqual(expect.arrayContaining(['/svg/nope.svg', '/png/nope.png']));

    // Rejected icon values.
    const bad = await call('POST', '/api/hosts', {
      zoneId,
      subdomain: 'bad',
      service: 'http://bad',
      home: { icon: 'javascript:alert(1)' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('keeps the homepage settings of a host when an update omits them', async () => {
    const h = await host({ subdomain: 'app', service: 'http://app', home: { title: 'App' } });
    const updated = await call('PUT', `/api/hosts/${h.id}`, {
      zoneId,
      subdomain: 'app',
      service: 'http://app:8080',
    });
    expect(updated.json().home).toMatchObject({ title: 'App', visible: true });
  });

  it('restricts the public hostname to the homepage', async () => {
    await call('PUT', '/api/homepage/settings', {
      enabled: true,
      visibility: 'public',
      publicHostname: 'Home.Example.com',
    });
    expect((await call('GET', '/api/homepage/settings')).json().publicHostname).toBe(
      'home.example.com',
    );
    const at = (url: string, method: 'GET' | 'POST' = 'GET') =>
      t.app.inject({ method, url, headers: { host: 'home.example.com' } });

    expect((await at('/api/home')).statusCode).toBe(200);
    const root = await at('/');
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/home');
    for (const url of [
      '/api/hosts',
      '/api/auth/me',
      '/api/setup/status',
      '/settings',
      '/api/docs',
    ]) {
      expect((await at(url)).statusCode, url).toBe(404);
    }
    expect((await at('/api/auth/login', 'POST')).statusCode).toBe(404);
    // The admin hostname is unaffected.
    expect((await call('GET', '/api/hosts')).statusCode).toBe(200);

    // Turned off: the hostname is a normal one again.
    await call('PUT', '/api/homepage/settings', { enabled: false });
    expect((await at('/api/setup/status')).statusCode).toBe(200);
  });
});
