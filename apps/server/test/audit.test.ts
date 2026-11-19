import type { AuditEntry } from '@burrow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diff } from '../src/services/audit.js';
import { apiFor, createTestApp, setupConfigured, type ApiCall, type TestApp } from './helpers.js';

let t: TestApp;
let call: ApiCall;
let zoneId: string;
let zoneName: string;
beforeEach(async () => {
  t = await createTestApp();
  const s = await setupConfigured(t);
  call = apiFor(t, s);
  zoneId = s.zoneId;
  zoneName = s.zoneName;
});
afterEach(async () => {
  await t.close();
});

const ingressHosts = () =>
  (t.mock.state.tunnels.find((x) => !x.deleted_at)?.config?.ingress ?? [])
    .map((r) => r.hostname)
    .filter(Boolean);
const cnames = () => t.mock.state.dns.filter((r) => r.type === 'CNAME').map((r) => r.name);

async function entries(query = ''): Promise<AuditEntry[]> {
  const res = await call('GET', `/api/audit${query}`);
  expect(res.statusCode).toBe(200);
  return res.json().entries;
}

async function latest(action: string): Promise<AuditEntry> {
  const found = (await entries()).find((e) => e.action === action);
  if (!found) throw new Error(`no ${action} entry`);
  return found;
}

async function createHost(subdomain = 'app') {
  const res = await call('POST', '/api/hosts', {
    subdomain,
    zoneId,
    service: 'http://10.0.0.5:8080',
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: number; hostname: string };
}

describe('diff', () => {
  it('lists the changed fields as dotted paths', () => {
    expect(
      diff(
        { a: 1, nested: { b: [1, 2], c: 'x' }, gone: true },
        { a: 1, nested: { b: [1, 3], c: 'x' }, added: 'y' },
      ),
    ).toEqual([
      { field: 'added', before: null, after: 'y' },
      { field: 'gone', before: true, after: null },
      { field: 'nested.b', before: [1, 2], after: [1, 3] },
    ]);
  });
});

describe('audit log', () => {
  it('records who changed what, from where, with the fields that changed', async () => {
    const host = await createHost();
    const res = await call('PUT', `/api/hosts/${host.id}`, {
      subdomain: 'app',
      zoneId,
      service: 'http://10.0.0.6:8080',
      options: { noTLSVerify: true },
    });
    expect(res.statusCode).toBe(200);

    const update = await latest('host.update');
    expect(update).toMatchObject({
      category: 'host',
      target: `app.${zoneName}`,
      actor: { label: 'admin@example.com', userId: 1, ip: '127.0.0.1' },
      undoable: true,
      undoneAt: null,
    });
    expect(update.details?.changes).toEqual([
      { field: 'options.noTLSVerify', before: false, after: true },
      { field: 'service', before: 'http://10.0.0.5:8080', after: 'http://10.0.0.6:8080' },
    ]);
  });

  it('names the API token that made a change', async () => {
    const token = (await call('POST', '/api/tokens', { name: 'deploy script' })).json().token;
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/drift/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { autoRepair: true },
    });
    expect(res.statusCode).toBe(200);
    expect((await latest('drift.autorepair.on')).actor.label).toBe('API token "deploy script"');
  });

  it('filters by category, text and undoable, and pages', async () => {
    await createHost('one');
    await createHost('two');
    await call('PUT', '/api/drift/settings', { autoRepair: true });

    const hosts = await entries('?category=host');
    expect(hosts.map((e) => e.action)).toEqual(['host.create', 'host.create']);
    expect((await entries('?q=two.')).map((e) => e.target)).toEqual([`two.${zoneName}`]);
    expect((await entries('?undoable=true')).every((e) => e.undoable)).toBe(true);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await entries(`?from=${encodeURIComponent(future)}`)).toEqual([]);

    const first = (await call('GET', '/api/audit?limit=2')).json();
    expect(first.entries).toHaveLength(2);
    expect(first.nextBefore).toBe(first.entries[1].id);
    const second = (await call('GET', `/api/audit?limit=2&before=${first.nextBefore}`)).json();
    expect(second.entries[0].id).toBeLessThan(first.nextBefore);
  });

  it('treats % and _ in the search as plain text', async () => {
    await createHost();
    expect(await entries('?q=%25')).toEqual([]);
    expect(await entries('?q=_')).toEqual([]);
  });

  it('is only readable when signed in', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(401);
  });
});

describe('undo', () => {
  it('undoes a host update and re-syncs Cloudflare', async () => {
    const host = await createHost();
    await call('PUT', `/api/hosts/${host.id}`, {
      subdomain: 'renamed',
      zoneId,
      service: 'http://10.0.0.5:8080',
    });
    expect(ingressHosts()).toContain(`renamed.${zoneName}`);

    const entry = await latest('host.update');
    const res = await call('POST', `/api/audit/${entry.id}/undo`);
    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result.undone).toMatchObject({ id: entry.id, undoable: false });
    expect(result.undone.undoneBy).toBe(result.entry.id);
    expect(result.entry).toMatchObject({ action: 'host.update', revertOf: entry.id });

    expect((await call('GET', `/api/hosts/${host.id}`)).json().hostname).toBe(`app.${zoneName}`);
    expect(ingressHosts()).toContain(`app.${zoneName}`);
    expect(ingressHosts()).not.toContain(`renamed.${zoneName}`);
    expect(cnames()).not.toContain(`renamed.${zoneName}`);

    // Twice is refused.
    const again = await call('POST', `/api/audit/${entry.id}/undo`);
    expect(again.statusCode).toBe(409);
  });

  it('undoes a creation by deleting the host', async () => {
    const host = await createHost();
    const entry = await latest('host.create');
    expect((await call('POST', `/api/audit/${entry.id}/undo`)).statusCode).toBe(200);
    expect((await call('GET', `/api/hosts/${host.id}`)).statusCode).toBe(404);
    expect(cnames()).not.toContain(host.hostname);
    expect((await latest('host.delete')).revertOf).toBe(entry.id);
  });

  it('undoes a deletion by publishing the host again, and the undo can be undone', async () => {
    const host = await createHost();
    await call('DELETE', `/api/hosts/${host.id}`);
    expect(cnames()).not.toContain(host.hostname);

    const deletion = await latest('host.delete');
    const res = await call('POST', `/api/audit/${deletion.id}/undo`);
    expect(res.statusCode).toBe(200);
    const list = (await call('GET', '/api/hosts')).json().hosts;
    expect(list.map((h: { hostname: string }) => h.hostname)).toEqual([host.hostname]);
    expect(cnames()).toContain(host.hostname);
    expect(ingressHosts()).toContain(host.hostname);

    // Redo: undoing the re-creation deletes it again.
    const recreated = res.json().entry as AuditEntry;
    expect(recreated).toMatchObject({ action: 'host.create', undoable: true });
    expect((await call('POST', `/api/audit/${recreated.id}/undo`)).statusCode).toBe(200);
    expect((await call('GET', '/api/hosts')).json().hosts).toEqual([]);
  });

  it('refuses when the host changed again since', async () => {
    const host = await createHost();
    const body = (service: string) => ({ subdomain: 'app', zoneId, service });
    await call('PUT', `/api/hosts/${host.id}`, body('http://10.0.0.6:8080'));
    const first = await latest('host.update');
    await call('PUT', `/api/hosts/${host.id}`, body('http://10.0.0.7:8080'));

    const res = await call('POST', `/api/audit/${first.id}/undo`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/changed again since/);
    expect((await call('GET', `/api/hosts/${host.id}`)).json().service).toBe(
      'http://10.0.0.7:8080',
    );
  });

  it('undoes maintenance mode', async () => {
    const host = await createHost();
    await call('PUT', `/api/hosts/${host.id}/maintenance`, { enabled: true });
    const entry = await latest('host.maintenance.on');
    expect((await call('POST', `/api/audit/${entry.id}/undo`)).statusCode).toBe(200);
    expect((await call('GET', `/api/hosts/${host.id}`)).json().maintenance.enabled).toBe(false);
    expect((await latest('host.maintenance.off')).revertOf).toBe(entry.id);
  });

  it('undoes settings toggles', async () => {
    await call('PUT', '/api/drift/settings', { autoRepair: true });
    const entry = await latest('drift.autorepair.on');
    expect((await call('POST', `/api/audit/${entry.id}/undo`)).statusCode).toBe(200);
    expect((await call('GET', '/api/drift')).json().autoRepair).toBe(false);
    const reverse = await latest('drift.autorepair.off');
    expect(reverse).toMatchObject({ revertOf: entry.id, undoable: true });
  });

  it('undoes a zone change', async () => {
    const other = t.mock.state.zones[1]!;
    await call('PATCH', `/api/zones/${other.id}`, { enabled: true });
    const entry = await latest('zone.enable');
    expect((await call('POST', `/api/audit/${entry.id}/undo`)).statusCode).toBe(200);
    const zones = (await call('GET', '/api/zones')).json().zones;
    expect(zones.find((z: { id: string }) => z.id === other.id).enabled).toBe(false);
  });

  it('undoes homepage settings', async () => {
    const before = (await call('GET', '/api/homepage/settings')).json();
    await call('PUT', '/api/homepage/settings', { ...before, title: 'My lab' });
    const entry = await latest('homepage.update');
    expect(entry.details?.changes).toEqual([
      { field: 'title', before: before.title, after: 'My lab' },
    ]);
    expect((await call('POST', `/api/audit/${entry.id}/undo`)).statusCode).toBe(200);
    expect((await call('GET', '/api/homepage/settings')).json().title).toBe(before.title);
  });

  it('refuses changes that cannot be undone', async () => {
    await call('POST', '/api/tokens', { name: 'x' });
    const entry = await latest('token.create');
    expect(entry.undoable).toBe(false);
    const res = await call('POST', `/api/audit/${entry.id}/undo`);
    expect(res.statusCode).toBe(409);
    expect((await call('POST', '/api/audit/99999/undo')).statusCode).toBe(404);
  });
});
