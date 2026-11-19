import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerClient, parseDockerHost, type DockerContainer } from '../src/docker/client.js';
import { containerAddress, parseLabels } from '../src/docker/labels.js';
import { apiFor, createTestApp, setupConfigured, type TestApp } from './helpers.js';

const SELF_ID = 'b0bbee5e1f00aaaaaaaaaaaaaaaa';

function container(over: Partial<DockerContainer> & { labels?: Record<string, string> }) {
  const { labels, ...rest } = over;
  return {
    Id: 'c0ffee000000111111111111',
    Names: ['/app'],
    Image: 'example/app:latest',
    State: 'running',
    Labels: labels ?? {},
    Ports: [],
    HostConfig: { NetworkMode: 'proxy' },
    NetworkSettings: { Networks: { proxy: { IPAddress: '172.20.0.5' } } },
    ...rest,
  } satisfies DockerContainer;
}

/** Burrow itself, on the `proxy` network. */
const self = container({
  Id: SELF_ID,
  Names: ['/burrow'],
  NetworkSettings: { Networks: { proxy: { IPAddress: '172.20.0.2' } } },
});

describe('docker labels', () => {
  const proxy = new Set(['proxy']);

  it('ignores containers without burrow.host and honours burrow.enable=false', () => {
    expect(parseLabels(container({}), proxy).kind).toBe('none');
    expect(
      parseLabels(
        container({ labels: { 'burrow.host': 'a.example.com', 'burrow.enable': 'false' } }),
        proxy,
      ).kind,
    ).toBe('ignored');
  });

  it('builds the service from the container name on a shared network', () => {
    const r = parseLabels(
      container({ labels: { 'burrow.host': 'App.Example.com', 'burrow.port': '3000' } }),
      proxy,
    );
    expect(r).toMatchObject({
      kind: 'ok',
      spec: { hostname: 'app.example.com', service: 'http://app:3000' },
    });
  });

  it('uses the template port, scheme and options', () => {
    const r = parseLabels(
      container({ labels: { 'burrow.host': 'pve.example.com', 'burrow.template': 'portainer' } }),
      proxy,
    );
    expect(r).toMatchObject({
      kind: 'ok',
      spec: { service: 'https://app:9443', noTLSVerify: true, template: 'portainer' },
    });
  });

  it('uses the only exposed port, and accepts a full service override', () => {
    const exposed = container({
      labels: { 'burrow.host': 'a.example.com' },
      Ports: [{ PrivatePort: 8096, Type: 'tcp' }],
    });
    expect(parseLabels(exposed, proxy)).toMatchObject({ spec: { service: 'http://app:8096' } });
    const full = container({
      labels: { 'burrow.host': 'a.example.com', 'burrow.service': 'https://10.0.0.5:8443' },
    });
    expect(parseLabels(full, proxy)).toMatchObject({ spec: { service: 'https://10.0.0.5:8443' } });
  });

  it('reads Access emails and domains', () => {
    const r = parseLabels(
      container({
        labels: {
          'burrow.host': 'a.example.com',
          'burrow.access': 'Me@Example.com, family.example',
          'burrow.access.session': '6h',
        },
      }),
      proxy,
    );
    expect(r).toMatchObject({
      spec: {
        access: {
          enabled: true,
          emails: ['me@example.com'],
          emailDomains: ['family.example'],
          sessionDuration: '6h',
        },
      },
    });
  });

  it('reports bad labels', () => {
    const r = parseLabels(
      container({ labels: { 'burrow.host': 'a.example.com', 'burrow.port': 'http' } }),
      proxy,
    );
    expect(r).toMatchObject({ kind: 'error', message: expect.stringMatching(/port/) });
    const tpl = parseLabels(
      container({ labels: { 'burrow.host': 'a.example.com', 'burrow.template': 'nope' } }),
      proxy,
    );
    expect(tpl).toMatchObject({ kind: 'error', message: expect.stringMatching(/template/) });
  });

  it('picks an address Burrow can reach', () => {
    const bridgeOnly = container({
      HostConfig: { NetworkMode: 'bridge' },
      NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.9' } } },
    });
    // Default bridge has no DNS for names: use the IP.
    expect(containerAddress(bridgeOnly, new Set(['bridge']))).toEqual({ address: '172.17.0.9' });
    // No shared network.
    expect(containerAddress(bridgeOnly, new Set(['proxy']))).toHaveProperty('error');
    // Burrow not in Docker: first IP.
    expect(containerAddress(bridgeOnly, null)).toEqual({ address: '172.17.0.9' });
    // Host network.
    const host = container({ HostConfig: { NetworkMode: 'host' } });
    expect(containerAddress(host, null)).toHaveProperty('error');
  });
});

describe('docker client', () => {
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    server = undefined;
    dir = undefined;
  });

  it('parses DOCKER_HOST values', () => {
    expect(parseDockerHost('unix:///var/run/docker.sock')).toEqual({
      socketPath: '/var/run/docker.sock',
    });
    expect(parseDockerHost('tcp://socket-proxy:2375')).toEqual({
      host: 'socket-proxy',
      port: 2375,
    });
    expect(() => parseDockerHost('ssh://nope')).toThrow(/Unsupported/);
  });

  it('lists containers over a unix socket, read-only', async () => {
    dir = mkdtempSync(join(tmpdir(), 'burrow-docker-'));
    const socket = join(dir, 'docker.sock');
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([container({ labels: { 'burrow.host': 'a.example.com' } })]));
    });
    await new Promise<void>((r) => server!.listen(socket, r));
    const list = await new DockerClient(`unix://${socket}`).listContainers();
    expect(list[0]!.Labels).toEqual({ 'burrow.host': 'a.example.com' });
    expect(seen).toEqual(['GET /v1.41/containers/json?all=1']);
  });

  it('explains a missing socket', async () => {
    await expect(
      new DockerClient('unix:///nonexistent/docker.sock').listContainers(),
    ).rejects.toThrow(/No Docker socket/);
  });
});

describe('docker discovery', () => {
  let t: TestApp;
  let containers: DockerContainer[] = [];
  let failing = false;
  afterEach(async () => {
    await t.close();
  });

  async function start() {
    containers = [self];
    failing = false;
    t = await createTestApp({
      docker: {
        listContainers: async () => {
          if (failing) throw new Error('Docker is down');
          return containers;
        },
      },
      dockerSelfHostname: SELF_ID.slice(0, 12),
    });
    const s = await setupConfigured(t);
    return { s, call: apiFor(t, s) };
  }

  const ingressHostnames = () =>
    (t.mock.state.tunnels.find((x) => !x.deleted_at)?.config?.ingress ?? [])
      .map((r) => r.hostname)
      .filter(Boolean);

  it('is off by default and does nothing', async () => {
    const { call } = await start();
    containers.push(container({ labels: { 'burrow.host': `app.${t.mock.state.zones[0]!.name}` } }));
    const res = await call('POST', '/api/docker/scan');
    expect(res.json()).toMatchObject({ enabled: false, containers: [] });
    expect((await call('GET', '/api/hosts')).json().hosts).toHaveLength(0);
  });

  it('publishes labelled containers, updates them and removes them with the container', async () => {
    const { s, call } = await start();
    const hostname = `app.${s.zoneName}`;
    containers.push(
      container({ labels: { 'burrow.host': hostname, 'burrow.port': '3000' } }),
      container({ Id: 'dddd', Names: ['/plain'] }),
    );

    const on = await call('PUT', '/api/docker/settings', { enabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({
      enabled: true,
      reachable: true,
      containers: [{ name: 'app', hostname, service: 'http://app:3000', status: 'published' }],
    });
    const host = (await call('GET', '/api/hosts')).json().hosts[0];
    expect(host).toMatchObject({ hostname, source: 'docker', sourceRef: 'app' });
    expect(ingressHostnames()).toContain(hostname);
    expect(t.mock.state.dns.some((r) => r.name === hostname)).toBe(true);

    // Manual edits are refused: the labels own the host.
    const edit = await call('DELETE', `/api/hosts/${host.id}`);
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.message).toMatch(/Docker labels/);

    // Label change: the host follows.
    containers[1] = container({ labels: { 'burrow.host': hostname, 'burrow.port': '4000' } });
    await call('POST', '/api/docker/scan');
    expect((await call('GET', `/api/hosts/${host.id}`)).json().service).toBe('http://app:4000');

    // Docker unreachable: nothing is removed.
    failing = true;
    const down = (await call('POST', '/api/docker/scan')).json();
    expect(down).toMatchObject({ reachable: false, error: 'Docker is down' });
    expect((await call('GET', '/api/hosts')).json().hosts).toHaveLength(1);

    // Container removed: the host, its route and its DNS record go away.
    failing = false;
    containers = [self];
    await call('POST', '/api/docker/scan');
    expect((await call('GET', '/api/hosts')).json().hosts).toHaveLength(0);
    expect(ingressHostnames()).not.toContain(hostname);
    expect(t.mock.state.dns.some((r) => r.name === hostname)).toBe(false);
  });

  it('never takes over a manual host and reports unknown zones', async () => {
    const { s, call } = await start();
    const manual = await call('POST', '/api/hosts', {
      subdomain: 'taken',
      zoneId: s.zoneId,
      service: 'http://10.0.0.1:80',
    });
    expect(manual.statusCode).toBe(201);
    containers.push(
      container({ labels: { 'burrow.host': `taken.${s.zoneName}` } }),
      container({
        Id: 'eeee',
        Names: ['/other'],
        labels: { 'burrow.host': 'x.unknown-zone.test' },
      }),
    );
    const status = (await call('PUT', '/api/docker/settings', { enabled: true })).json();
    const byName = Object.fromEntries(status.containers.map((c: { name: string }) => [c.name, c]));
    expect(byName.app).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/manually/),
    });
    expect(byName.other).toMatchObject({ status: 'error', message: expect.stringMatching(/zone/) });
    const hosts = (await call('GET', '/api/hosts')).json().hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0].service).toBe('http://10.0.0.1:80');
  });

  it('leaves Docker hosts out of config exports', async () => {
    const { s, call } = await start();
    containers.push(container({ labels: { 'burrow.host': `app.${s.zoneName}` } }));
    await call('PUT', '/api/docker/settings', { enabled: true });
    const exported = (await call('GET', '/api/config/export')).json();
    expect(exported.hosts).toHaveLength(0);
  });
});
