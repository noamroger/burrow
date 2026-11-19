import {
  backupSettingsInputSchema,
  type BackupFile,
  type BackupRun,
  type BackupStatus,
} from '@burrow/shared';
import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { Logger } from 'pino';
import type { SettingsRepository } from '../db/settings.js';
import { SettingKeys } from '../db/settings.js';
import { errorMessage, errors } from '../lib/errors.js';
import type { SecretBox } from '../lib/secretbox.js';
import { S3Storage } from './s3.js';

const gzipAsync = promisify(gzip);

/** `burrow-20261119-031500.db.gz` */
const FILE_RE = /^burrow-\d{8}-\d{6}\.db\.gz$/;

/** Saved settings: the S3 secret is stored encrypted. */
interface StoredSettings {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  destination: 'local' | 's3';
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretEnc: string | null;
    forcePathStyle: boolean;
  } | null;
}

const DEFAULTS: StoredSettings = {
  enabled: false,
  intervalHours: 24,
  retention: 7,
  destination: 'local',
  s3: null,
};

export interface BackupServiceOptions {
  sqlite: Database.Database;
  settings: SettingsRepository;
  box: SecretBox;
  localDir: string;
  logger: Logger;
  fetch?: typeof fetch;
}

/** Where backups go: a directory, or a bucket. */
interface Destination {
  put(name: string, data: Buffer): Promise<void>;
  list(): Promise<BackupFile[]>;
  read(name: string): Promise<Buffer>;
  remove(name: string): Promise<void>;
}

/**
 * Scheduled copies of the SQLite database (an online, consistent snapshot via
 * the SQLite backup API, gzipped), to a local directory or an S3-compatible
 * bucket such as Cloudflare R2, keeping the last `retention` files.
 *
 * A backup holds the Cloudflare token encrypted with the instance key
 * (`/data/.secret` or `BURROW_SECRET`): keep that key to restore it elsewhere.
 *
 * Events `completed` / `failed` (run): the hook for notifications.
 */
export class BackupService extends EventEmitter<{ completed: [BackupRun]; failed: [BackupRun] }> {
  private running: Promise<BackupRun> | null = null;

  constructor(private readonly opts: BackupServiceOptions) {
    super();
  }

  private stored(): StoredSettings {
    return { ...DEFAULTS, ...this.opts.settings.get<StoredSettings>(SettingKeys.backupSettings) };
  }

  lastRun(): BackupRun | null {
    return this.opts.settings.get<BackupRun>(SettingKeys.backupLastRun) ?? null;
  }

  /** When the next scheduled backup is due, or null when they are off. */
  nextRunAt(): string | null {
    const due = this.dueAt();
    return due === null ? null : new Date(Math.max(due, Date.now())).toISOString();
  }

  /** Epoch ms of the next scheduled run; a failed run is retried within the hour. */
  private dueAt(): number | null {
    const s = this.stored();
    if (!s.enabled) return null;
    const last = this.lastRun();
    if (!last) return 0;
    const hours = last.ok ? s.intervalHours : Math.min(1, s.intervalHours);
    return Date.parse(last.at) + hours * 3_600_000;
  }

  async status(): Promise<BackupStatus> {
    const s = this.stored();
    let files: BackupFile[] = [];
    let listError: string | null = null;
    try {
      files = await this.destination(s).list();
    } catch (err) {
      listError = errorMessage(err);
    }
    return {
      settings: {
        enabled: s.enabled,
        intervalHours: s.intervalHours,
        retention: s.retention,
        destination: s.destination,
        s3: s.s3
          ? {
              endpoint: s.s3.endpoint,
              region: s.s3.region,
              bucket: s.s3.bucket,
              prefix: s.s3.prefix,
              accessKeyId: s.s3.accessKeyId,
              forcePathStyle: s.s3.forcePathStyle,
              hasSecret: s.s3.secretEnc !== null,
            }
          : null,
      },
      localDir: this.opts.localDir,
      lastRun: this.lastRun(),
      nextRunAt: this.nextRunAt(),
      files,
      listError,
    };
  }

  /** Validate and save. A missing S3 secret keeps the saved one. */
  save(body: unknown): void {
    const input = backupSettingsInputSchema.parse(body);
    const before = this.stored();
    let s3: StoredSettings['s3'] = null;
    if (input.s3) {
      const { secretAccessKey, ...rest } = input.s3;
      s3 = {
        ...rest,
        secretEnc: secretAccessKey
          ? this.opts.box.encrypt(secretAccessKey)
          : (before.s3?.secretEnc ?? null),
      };
    }
    if (input.destination === 's3' && (!s3 || !s3.secretEnc)) {
      throw errors.validation('S3 storage needs an endpoint, a bucket and access keys.');
    }
    const next: StoredSettings = {
      enabled: input.enabled,
      intervalHours: input.intervalHours,
      retention: input.retention,
      destination: input.destination,
      s3,
    };
    this.opts.settings.set(SettingKeys.backupSettings, next);
  }

  /** Called by the scheduler every few minutes: back up when one is due. */
  async runIfDue(now = Date.now()): Promise<BackupRun | null> {
    const due = this.dueAt();
    if (due === null || due > now) return null;
    return this.run();
  }

  /** Back up now (one at a time). Never throws: the result says what happened. */
  run(): Promise<BackupRun> {
    this.running ??= this.doRun().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async read(name: string): Promise<Buffer> {
    if (!FILE_RE.test(name)) throw errors.notFound('Backup');
    try {
      return await this.destination(this.stored()).read(name);
    } catch (err) {
      this.opts.logger.debug({ err: errorMessage(err), name }, 'backup read failed');
      throw errors.notFound('Backup');
    }
  }

  private async doRun(): Promise<BackupRun> {
    const s = this.stored();
    const at = new Date();
    const name = `burrow-${stamp(at)}.db.gz`;
    const tmp = join(this.opts.localDir, `.${name}.tmp`);
    let run: BackupRun;
    try {
      await mkdir(this.opts.localDir, { recursive: true });
      await this.opts.sqlite.backup(tmp);
      const data = await gzipAsync(await readFile(tmp));
      const dest = this.destination(s);
      await dest.put(name, data);
      await this.prune(dest, s.retention);
      run = { at: at.toISOString(), ok: true, name, error: null };
      this.opts.logger.info({ name, size: data.byteLength, to: s.destination }, 'backup done');
      this.emit('completed', run);
    } catch (err) {
      run = { at: at.toISOString(), ok: false, name: null, error: errorMessage(err) };
      this.opts.logger.warn({ err: run.error, to: s.destination }, 'backup failed');
      this.emit('failed', run);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
    this.opts.settings.set(SettingKeys.backupLastRun, run);
    return run;
  }

  private async prune(dest: Destination, keep: number): Promise<void> {
    const files = await dest.list();
    for (const f of files.slice(keep)) await dest.remove(f.name);
  }

  private destination(s: StoredSettings): Destination {
    if (s.destination === 's3') {
      if (!s.s3?.secretEnc) throw new Error('S3 storage is not configured.');
      const cfg = s.s3;
      const storage = new S3Storage({
        endpoint: cfg.endpoint,
        region: cfg.region,
        bucket: cfg.bucket,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: this.opts.box.decrypt(cfg.secretEnc!),
        forcePathStyle: cfg.forcePathStyle,
        fetch: this.opts.fetch,
      });
      return {
        put: (name, data) => storage.put(cfg.prefix + name, data, 'application/gzip'),
        read: (name) => storage.get(cfg.prefix + name),
        remove: (name) => storage.delete(cfg.prefix + name),
        list: async () =>
          newestFirst(
            (await storage.list(cfg.prefix))
              .map((o) => ({ ...o, name: o.key.slice(cfg.prefix.length) }))
              .filter((o) => FILE_RE.test(o.name))
              .map((o) => ({ name: o.name, size: o.size, createdAt: fromName(o.name) })),
          ),
      };
    }
    const dir = this.opts.localDir;
    return {
      put: async (name, data) => {
        await writeFile(join(dir, name), data, { mode: 0o600 });
      },
      read: (name) => readFile(join(dir, name)),
      remove: (name) => unlink(join(dir, name)),
      list: async () => {
        const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return [] as string[];
          throw err;
        });
        const files = await Promise.all(
          names
            .filter((n) => FILE_RE.test(n))
            .map(async (n) => ({
              name: n,
              size: (await stat(join(dir, n))).size,
              createdAt: fromName(n),
            })),
        );
        return newestFirst(files);
      },
    };
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** UTC `YYYYMMDD-HHmmss`. */
function stamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function fromName(name: string): string {
  const m = /^burrow-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)!;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

function newestFirst(files: BackupFile[]): BackupFile[] {
  return files.sort((a, b) => b.name.localeCompare(a.name));
}
