import type { DriftReport, SupervisorStatus } from '@burrow/shared';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/lib/secretbox.js';
import { NotificationService } from '../src/services/notifications.js';
import {
  apiFor,
  createTestApp,
  setupAdmin,
  waitFor,
  type ApiCall,
  type TestApp,
} from './helpers.js';

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
  json: Record<string, unknown>;
}

let t: TestApp;
let call: ApiCall;
let receiver: Server;
let base: string;
let received: Received[];
/** Status the receiver answers with. */
let status: number;

beforeEach(async () => {
  t = await createTestApp();
  call = apiFor(t, await setupAdmin(t.app));
  received = [];
  status = 204;
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body, json: JSON.parse(body) });
      res.statusCode = status;
      res.end(status >= 400 ? 'Unknown Webhook' : '');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await t.close();
  receiver.closeAllConnections();
  await new Promise<void>((r) => receiver.close(() => r()));
});

const discord = () => ({
  name: 'Discord',
  type: 'discord',
  events: ['host.down', 'host.up'],
  config: { webhookUrl: `${base}/api/webhooks/123/secret-part` },
});

describe('notification channels', () => {
  it('never returns secrets and keeps them when omitted', async () => {
    const created = await call('POST', '/api/notifications/channels', discord());
    expect(created.statusCode).toBe(201);
    const channel = created.json();
    expect(channel).toMatchObject({
      name: 'Discord',
      type: 'discord',
      enabled: true,
      config: { hasSecret: true, webhookHint: '…t-part' },
      lastSentAt: null,
    });
    expect(JSON.stringify(channel)).not.toContain('secret-part');

    const updated = await call('PUT', `/api/notifications/channels/${channel.id}`, {
      ...discord(),
      name: 'Ops',
      config: {},
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Ops', config: { hasSecret: true } });
    // Still delivers to the saved URL.
    expect((await call('POST', `/api/notifications/channels/${channel.id}/test`)).json()).toEqual({
      ok: true,
      error: null,
    });
    expect(received[0]!.path).toBe('/api/webhooks/123/secret-part');

    // The stored config is encrypted.
    const raw = t.ctx.sqlite.prepare('SELECT config_enc FROM notification_channels').get() as {
      config_enc: string;
    };
    expect(raw.config_enc).not.toContain('secret-part');

    expect((await call('DELETE', `/api/notifications/channels/${channel.id}`)).statusCode).toBe(
      204,
    );
    expect((await call('GET', '/api/notifications')).json().channels).toEqual([]);
  });

  it('validates the input', async () => {
    const bad = [
      { ...discord(), config: { webhookUrl: 'https://example.com/hook' } },
      { ...discord(), config: {} },
      { ...discord(), events: [] },
      { ...discord(), events: ['host.exploded'] },
      { name: 'n', type: 'ntfy', events: ['host.down'], config: { topic: 'no spaces' } },
      { name: 'w', type: 'webhook', events: ['host.down'], config: { url: 'ftp://x' } },
    ];
    for (const body of bad) {
      expect((await call('POST', '/api/notifications/channels', body)).statusCode).toBe(400);
    }
  });

  it('reports a failed delivery on the test call and on the channel', async () => {
    status = 404;
    const id = (await call('POST', '/api/notifications/channels', discord())).json().id;
    const result = (await call('POST', `/api/notifications/channels/${id}/test`)).json();
    expect(result).toEqual({ ok: false, error: 'HTTP 404: Unknown Webhook' });
    const [channel] = (await call('GET', '/api/notifications')).json().channels;
    expect(channel.lastError).toBe('HTTP 404: Unknown Webhook');
    expect(channel.lastSentAt).not.toBeNull();
  });
});

describe('delivery', () => {
  async function channels() {
    await call('POST', '/api/notifications/channels', discord());
    await call('POST', '/api/notifications/channels', {
      name: 'Phone',
      type: 'ntfy',
      events: ['host.down', 'drift.detected'],
      config: { serverUrl: `${base}/`, topic: 'burrow-alerts', token: 'tk_secret' },
    });
    await call('POST', '/api/notifications/channels', {
      name: 'Hook',
      type: 'webhook',
      events: ['backup.failed', 'drift.detected'],
      config: { url: `${base}/hook`, secret: 'signing-key' },
    });
    await call('POST', '/api/notifications/channels', {
      ...discord(),
      name: 'Off',
      enabled: false,
    });
  }

  it('sends host outages to the subscribed channels, in each format', async () => {
    await channels();
    // Through the monitor's event, as in production.
    t.ctx.monitoring.emit('down', {
      hostId: 1,
      hostname: 'app.example.com',
      path: '',
      error: 'Connection refused',
      since: '2026-11-19T05:00:00.000Z',
    });
    await waitFor(() => received.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(2); // Discord + ntfy; the webhook and the disabled one are not subscribed

    const d = received.find((r) => r.path.startsWith('/api/webhooks'))!;
    const embed = (d.json.embeds as Array<Record<string, unknown>>)[0]!;
    expect(d.json.username).toBe('Burrow');
    expect(embed).toMatchObject({
      title: 'app.example.com is down',
      description: 'Connection refused',
      color: 0xb4322f,
      url: 'https://app.example.com',
    });

    const n = received.find((r) => r.path === '/')!;
    expect(n.headers.authorization).toBe('Bearer tk_secret');
    expect(n.json).toMatchObject({
      topic: 'burrow-alerts',
      title: 'app.example.com is down',
      priority: 5,
      tags: ['rotating_light'],
      click: 'https://app.example.com',
    });

    received = [];
    await t.ctx.notifications.onHostUp({
      hostId: 1,
      hostname: 'app.example.com',
      path: '',
      downSince: '2026-11-19T05:00:00.000Z',
      durationSeconds: 3720,
    });
    expect(received).toHaveLength(1);
    expect((received[0]!.json.embeds as Array<{ description: string }>)[0]!.description).toBe(
      'It was down for 1 h 2 min.',
    );
  });

  it('signs generic webhooks and reports drift and failed backups', async () => {
    await channels();
    const report: DriftReport = {
      checkedAt: '2026-11-19T05:00:00.000Z',
      items: [
        {
          kind: 'ingress.changed',
          target: 'app.example.com',
          tunnel: 'burrow',
          hostIds: [1],
          detail: 'The route now goes to http://other:80 instead of http://app:80.',
          keepable: true,
        },
      ],
      error: null,
      autoRepair: false,
      intervalSeconds: 300,
    };
    t.ctx.drift.emit('detected', report);
    await waitFor(() => received.length === 2);
    const hook = received.find((r) => r.path === '/hook')!;
    expect(hook.headers['x-burrow-event']).toBe('drift.detected');
    const expected = createHmac('sha256', 'signing-key').update(hook.body).digest('hex');
    expect(hook.headers['x-burrow-signature']).toBe(`sha256=${expected}`);
    expect(hook.json).toMatchObject({
      event: 'drift.detected',
      severity: 'warning',
      title: 'Cloudflare was changed outside Burrow (1 difference)',
      data: { items: report.items },
    });

    received = [];
    t.ctx.backups.emit('failed', {
      at: report.checkedAt!,
      ok: false,
      name: null,
      error: 'Disk full',
    });
    await waitFor(() => received.length === 1);
    expect(received[0]!.json).toMatchObject({ event: 'backup.failed', message: 'Disk full' });
  });

  it('reports a tunnel down only when it stays disconnected, then back up', async () => {
    let state: SupervisorStatus['state'] = 'backoff';
    const service = new NotificationService({
      db: t.ctx.db,
      box: SecretBox.load(t.dataDir, undefined),
      logger: pino({ level: 'silent' }),
      tunnelGraceMs: 50,
      tunnelState: () => state,
      tunnelName: () => 'home',
    });
    await call('POST', '/api/notifications/channels', {
      name: 'Hook',
      type: 'webhook',
      events: ['tunnel.down', 'tunnel.up'],
      config: { url: `${base}/hook` },
    });
    const status = (s: SupervisorStatus['state']): SupervisorStatus => ({
      state: s,
      pid: null,
      restarts: 3,
      startedAt: null,
      lastExitCode: 1,
      nextRetryAt: null,
      cloudflaredVersion: null,
    });

    // A quick restart: back to running within the grace period, nothing sent.
    service.onTunnelState(1, status('backoff'));
    service.onTunnelState(1, status('running'));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);

    // A real outage.
    service.onTunnelState(1, status('backoff'));
    service.onTunnelState(1, status('starting'));
    service.onTunnelState(1, status('backoff'));
    await waitFor(() => received.length === 1);
    expect(received[0]!.json).toMatchObject({ event: 'tunnel.down', title: 'Tunnel home is down' });

    state = 'running';
    service.onTunnelState(1, status('running'));
    await waitFor(() => received.length === 2);
    expect(received[1]!.json).toMatchObject({ event: 'tunnel.up', severity: 'resolved' });

    // Stopping on purpose is not an outage.
    service.onTunnelState(1, status('backoff'));
    service.onTunnelState(1, status('stopped'));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(2);
    service.stop();
  });
});
