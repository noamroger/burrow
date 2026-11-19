import Database from 'better-sqlite3';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockS3 } from '../mock/s3.js';
import { apiFor, createTestApp, setupAdmin, type ApiCall, type TestApp } from './helpers.js';

let t: TestApp;
let api: ApiCall;
let s3: MockS3;

beforeEach(async () => {
  t = await createTestApp();
  api = apiFor(t, await setupAdmin(t.app));
  s3 = new MockS3();
  await s3.listen();
});
afterEach(async () => {
  await t.close();
  await s3.close();
});

const local = {
  enabled: true,
  intervalHours: 24,
  retention: 2,
  destination: 'local',
  s3: null,
};

/** The tables of a gzipped backup, opened as a database. */
function tablesOf(gz: Buffer): string[] {
  const file = join(t.dataDir, 'restored.db');
  writeFileSync(file, gunzipSync(gz));
  const db = new Database(file, { readonly: true });
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => (r as { name: string }).name);
  db.close();
  return names;
}

describe('backups', () => {
  it('is off by default and lists nothing', async () => {
    const status = (await api('GET', '/api/backups')).json();
    expect(status).toMatchObject({
      settings: { enabled: false, destination: 'local' },
      lastRun: null,
      nextRunAt: null,
      files: [],
      listError: null,
    });
    expect(status.localDir).toBe(join(t.dataDir, 'backups'));
    expect(await t.ctx.backups.runIfDue()).toBeNull();
  });

  it('backs up to the local directory, keeps `retention` files and serves them', async () => {
    expect((await api('PUT', '/api/backups/settings', local)).statusCode).toBe(200);
    // Enabled and never run: due now.
    const first = await t.ctx.backups.runIfDue();
    expect(first).toMatchObject({ ok: true, error: null });
    expect(first!.name).toMatch(/^burrow-\d{8}-\d{6}\.db\.gz$/);
    // Not due again before the interval.
    expect(await t.ctx.backups.runIfDue()).toBeNull();
    expect(await t.ctx.backups.runIfDue(Date.now() + 25 * 3_600_000)).not.toBeNull();

    // Older files beyond the retention are deleted.
    const dir = join(t.dataDir, 'backups');
    writeFileSync(join(dir, 'burrow-20200101-000000.db.gz'), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'not a backup');
    await new Promise((r) => setTimeout(r, 1100));
    const run = (await api('POST', '/api/backups')).json();
    expect(run.ok).toBe(true);
    const status = (await api('GET', '/api/backups')).json();
    expect(status.files).toHaveLength(2);
    expect(status.files[0].name).toBe(run.name);
    expect(existsSync(join(dir, 'burrow-20200101-000000.db.gz'))).toBe(false);
    expect(readdirSync(dir)).toContain('notes.txt');
    expect(status.lastRun).toMatchObject({ ok: true, name: run.name });

    const download = await api('GET', `/api/backups/${run.name}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/gzip');
    expect(tablesOf(download.rawPayload)).toEqual(
      expect.arrayContaining(['proxy_hosts', 'tunnels', 'settings', 'users']),
    );
    expect((await api('GET', '/api/backups/..%2Fburrow.db')).statusCode).toBe(404);
  });

  it('backs up to S3-compatible storage (R2) without ever returning the secret', async () => {
    const settings = {
      ...local,
      retention: 1,
      destination: 's3',
      s3: {
        endpoint: s3.url,
        region: 'auto',
        bucket: 'backups',
        prefix: 'burrow/',
        accessKeyId: 'AKIDTEST',
        secretAccessKey: 'very-secret-key',
        forcePathStyle: true,
      },
    };
    const saved = await api('PUT', '/api/backups/settings', settings);
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('very-secret-key');
    expect(saved.json().settings.s3).toMatchObject({ hasSecret: true, bucket: 'backups' });

    const run = (await api('POST', '/api/backups')).json();
    expect(run).toMatchObject({ ok: true });
    const key = `burrow/${run.name}`;
    expect(s3.objects.has(key)).toBe(true);
    expect(tablesOf(s3.objects.get(key)!)).toContain('proxy_hosts');

    // Retention applies to the bucket too.
    s3.objects.set('burrow/burrow-20200101-000000.db.gz', Buffer.from('old'));
    s3.objects.set('burrow/burrow-20200102-000000.db.gz', Buffer.from('old'));
    s3.objects.set('other/burrow-20200101-000000.db.gz', Buffer.from('not ours'));
    const second = (await api('POST', '/api/backups')).json();
    const latest = `burrow/${second.name}`;
    expect([...s3.objects.keys()].sort()).toEqual([latest, 'other/burrow-20200101-000000.db.gz']);

    const status = (await api('GET', '/api/backups')).json();
    expect(status.files.map((f: { name: string }) => f.name)).toEqual([second.name]);
    const download = await api('GET', `/api/backups/${second.name}`);
    expect(download.rawPayload.equals(s3.objects.get(latest)!)).toBe(true);

    // Saving without the secret keeps it.
    const { secretAccessKey: _, ...withoutSecret } = settings.s3;
    await api('PUT', '/api/backups/settings', { ...settings, s3: withoutSecret });
    expect((await api('POST', '/api/backups')).json().ok).toBe(true);
  });

  it('reports a failed upload and refuses S3 without keys', async () => {
    const res = await api('PUT', '/api/backups/settings', { ...local, destination: 's3' });
    expect(res.statusCode).toBe(400);

    await api('PUT', '/api/backups/settings', {
      ...local,
      destination: 's3',
      s3: {
        endpoint: s3.url,
        bucket: 'backups',
        accessKeyId: 'WRONGKEY',
        secretAccessKey: 'x',
      },
    });
    const failed = (await api('POST', '/api/backups')).json();
    expect(failed).toMatchObject({ ok: false, name: null });
    expect(failed.error).toContain('403');
    const status = (await api('GET', '/api/backups')).json();
    expect(status.lastRun.ok).toBe(false);
    expect(status.listError).toContain('InvalidAccessKeyId');
    // No temporary file left behind.
    expect(readdirSync(join(t.dataDir, 'backups'))).toEqual([]);
  });
});
