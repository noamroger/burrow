import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthService, probeOrigin } from '../src/services/health.js';

let server: Server;
let base: string;
const seen: Array<{ method: string; host: string | undefined }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method!, host: req.headers.host });
    if (req.url === '/no-head' && req.method === 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    res.writeHead(req.url === '/broken' ? 500 : 200).end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const target = (service: string, extra = {}) => ({
  service,
  noTlsVerify: false,
  httpHostHeader: '',
  originServerName: '',
  ...extra,
});

describe('probeOrigin', () => {
  it('reports up with status and latency', async () => {
    const h = await probeOrigin(target(base));
    expect(h).toMatchObject({ state: 'up', statusCode: 200, error: null });
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('counts any HTTP answer as reachable', async () => {
    expect(await probeOrigin(target(`${base}/broken`))).toMatchObject({
      state: 'up',
      statusCode: 500,
    });
  });

  it('falls back to GET when HEAD is not allowed', async () => {
    seen.length = 0;
    const h = await probeOrigin(target(`${base}/no-head`));
    expect(h.statusCode).toBe(200);
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'GET']);
  });

  it('sends httpHostHeader as Host', async () => {
    seen.length = 0;
    await probeOrigin(target(base, { httpHostHeader: 'internal.lan' }));
    expect(seen[0]!.host).toBe('internal.lan');
  });

  it('reports down with a helpful message when nothing listens', async () => {
    const h = await probeOrigin(target('http://127.0.0.1:1'), 1000);
    expect(h.state).toBe('down');
    expect(h.error).toMatch(/refused/i);
  });

  it('probes TCP services with a connect', async () => {
    const port = (server.address() as AddressInfo).port;
    expect((await probeOrigin(target(`tcp://127.0.0.1:${port}`))).state).toBe('up');
    expect((await probeOrigin(target('tcp://127.0.0.1:1'), 1000)).state).toBe('down');
  });

  it('does not probe unix sockets', async () => {
    expect((await probeOrigin(target('unix:/var/run/app.sock'))).state).toBe('unknown');
  });
});

describe('HealthService', () => {
  it('caches results per host', async () => {
    const health = new HealthService(1000);
    expect(health.get(1).state).toBe('unknown');
    await health.check(1, target(base));
    expect(health.get(1).state).toBe('up');
    health.forget(1);
    expect(health.get(1).state).toBe('unknown');
  });
});
