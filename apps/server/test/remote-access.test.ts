import { clientCommand } from '@burrow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiFor, createTestApp, setupConfigured, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const ingress = () => t.mock.state.tunnels.find((x) => !x.deleted_at)?.config?.ingress ?? [];
const access = { enabled: true, emails: ['me@example.com'] };

describe('TCP, SSH and RDP hosts', () => {
  it('publishes an SSH host with a browser-rendered terminal', async () => {
    const s = await setupConfigured(t);
    const call = apiFor(t, s);
    const res = await call('POST', '/api/hosts', {
      subdomain: 'ssh',
      zoneId: s.zoneId,
      service: 'ssh://192.168.1.10:22',
      access: { ...access, browserRendering: 'ssh' },
    });
    expect(res.statusCode).toBe(201);
    const hostname = `ssh.${s.zoneName}`;
    expect(res.json().access.browserRendering).toBe('ssh');
    expect(ingress()).toContainEqual({ hostname, service: 'ssh://192.168.1.10:22' });
    const app = t.mock.state.accessApps.find((a) => a.domain === hostname)!;
    expect(app.type).toBe('ssh');

    // Turning the browser terminal off keeps the protection as a regular app.
    const off = await call('PUT', `/api/hosts/${res.json().id}`, {
      subdomain: 'ssh',
      zoneId: s.zoneId,
      service: 'ssh://192.168.1.10:22',
      access,
    });
    expect(off.statusCode).toBe(200);
    expect(t.mock.state.accessApps.find((a) => a.domain === hostname)!.type).toBe('self_hosted');
  });

  it('publishes VNC over TCP with a browser desktop, and RDP for cloudflared clients', async () => {
    const s = await setupConfigured(t);
    const call = apiFor(t, s);
    const vnc = await call('POST', '/api/hosts', {
      subdomain: 'vnc',
      zoneId: s.zoneId,
      service: 'tcp://192.168.1.11:5900',
      access: { ...access, browserRendering: 'vnc' },
    });
    expect(vnc.statusCode).toBe(201);
    expect(t.mock.state.accessApps.find((a) => a.domain === `vnc.${s.zoneName}`)!.type).toBe('vnc');
    const rdp = await call('POST', '/api/hosts', {
      subdomain: 'rdp',
      zoneId: s.zoneId,
      service: 'rdp://192.168.1.12:3389',
    });
    expect(rdp.statusCode).toBe(201);
    expect(ingress()).toContainEqual({
      hostname: `rdp.${s.zoneName}`,
      service: 'rdp://192.168.1.12:3389',
    });
  });

  it('rejects browser rendering that cannot work', async () => {
    const s = await setupConfigured(t);
    const call = apiFor(t, s);
    const http = await call('POST', '/api/hosts', {
      subdomain: 'web',
      zoneId: s.zoneId,
      service: 'http://192.168.1.10:80',
      access: { ...access, browserRendering: 'ssh' },
    });
    expect(http.statusCode).toBe(400);
    const unprotected = await call('POST', '/api/hosts', {
      subdomain: 'ssh',
      zoneId: s.zoneId,
      service: 'ssh://192.168.1.10:22',
      access: { enabled: false, browserRendering: 'ssh' },
    });
    expect(unprotected.statusCode).toBe(400);
    const withPath = await call('POST', '/api/hosts', {
      subdomain: 'ssh',
      zoneId: s.zoneId,
      service: 'ssh://192.168.1.10:22',
      path: '^/x',
      access: { ...access, browserRendering: 'ssh' },
    });
    expect(withPath.statusCode).toBe(400);
  });

  it('builds the client commands', () => {
    expect(clientCommand('ssh.example.com', 'ssh://10.0.0.1:22')).toBe(
      'ssh -o ProxyCommand="cloudflared access ssh --hostname %h" user@ssh.example.com',
    );
    expect(clientCommand('rdp.example.com', 'rdp://10.0.0.1:3389')).toContain(
      'cloudflared access rdp --hostname rdp.example.com',
    );
    expect(clientCommand('db.example.com', 'tcp://10.0.0.1:5432')).toBe(
      'cloudflared access tcp --hostname db.example.com --url localhost:5432',
    );
    expect(clientCommand('a.example.com', 'http://10.0.0.1')).toBeNull();
  });
});
