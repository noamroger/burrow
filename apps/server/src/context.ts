import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { openDatabase, type Db } from './db/client.js';
import { SettingsRepository } from './db/settings.js';
import { errorMessage } from './lib/errors.js';
import { SecretBox } from './lib/secretbox.js';
import { AuditService } from './services/audit.js';
import { AuthService } from './services/auth.js';
import { CloudflareService } from './services/cloudflare.js';
import { HealthService } from './services/health.js';
import { HostService } from './services/hosts.js';
import { LogBuffer } from './services/log-buffer.js';
import { Reconciler } from './services/reconciler.js';
import { Supervisor, type SupervisorOptions } from './services/supervisor.js';
import { TunnelService } from './services/tunnel.js';
import { ZoneService } from './services/zones.js';
import type Database from 'better-sqlite3';

/** Everything the HTTP layer needs. Built once by {@link createContext}. */
export interface AppContext {
  config: Config;
  logger: Logger;
  version: string;
  startedAt: number;
  db: Db;
  sqlite: Database.Database;
  settings: SettingsRepository;
  auth: AuthService;
  audit: AuditService;
  cloudflare: CloudflareService;
  tunnels: TunnelService;
  logs: LogBuffer;
  supervisor: Supervisor;
  reconciler: Reconciler;
  health: HealthService;
  hosts: HostService;
  zones: ZoneService;
  lifecycle: Lifecycle;
}

/** Test seams: everything here has a sensible production default. */
export interface ContextOverrides {
  fetch?: typeof fetch;
  cloudflareRetryBaseMs?: number;
  supervisor?: Partial<Pick<SupervisorOptions, 'env' | 'backoff' | 'killTimeoutMs'>>;
  healthTimeoutMs?: number;
}

/** Version from package.json (works from both `src/` and `dist/`). */
export function readVersion(): string {
  if (process.env.BURROW_VERSION) return process.env.BURROW_VERSION;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Open the database and wire every service together. Starts nothing. */
export function createContext(
  config: Config,
  logger: Logger,
  overrides: ContextOverrides = {},
): AppContext {
  const { db, sqlite } = openDatabase(join(config.dataDir, 'burrow.db'));
  const settings = new SettingsRepository(db);
  const box = SecretBox.load(config.dataDir, config.secret);
  const audit = new AuditService(db);
  const auth = new AuthService(db);
  const cloudflare = new CloudflareService({
    settings,
    box,
    apiBase: config.cloudflareApiBase,
    logger: logger.child({ component: 'cloudflare' }),
    fetch: overrides.fetch,
    retryBaseMs: overrides.cloudflareRetryBaseMs,
  });
  const tunnels = new TunnelService(settings, cloudflare, logger.child({ component: 'tunnel' }));
  const logs = new LogBuffer(2000);
  const supervisor = new Supervisor({
    binaryPath: config.cloudflaredPath,
    metricsAddress: config.cloudflaredMetrics,
    getToken: () => tunnels.getRunToken(),
    knownSecrets: () => cloudflare.knownSecrets(),
    logs,
    logger: logger.child({ component: 'supervisor' }),
    ...overrides.supervisor,
  });
  const reconciler = new Reconciler({
    db,
    settings,
    cloudflare,
    tunnels,
    logger: logger.child({ component: 'reconciler' }),
  });
  const health = new HealthService(overrides.healthTimeoutMs ?? 5_000);
  const hosts = new HostService({ db, reconciler, cloudflare, health, audit, logger });
  const zones = new ZoneService(db, cloudflare);

  const ctx = {
    config,
    logger,
    version: readVersion(),
    startedAt: Date.now(),
    db,
    sqlite,
    settings,
    auth,
    audit,
    cloudflare,
    tunnels,
    logs,
    supervisor,
    reconciler,
    health,
    hosts,
    zones,
  } as Omit<AppContext, 'lifecycle'> as AppContext;
  ctx.lifecycle = new Lifecycle(ctx);
  return ctx;
}

/**
 * Background work: cloudflared, periodic reconciliation and health probes,
 * and what happens when the Cloudflare token is saved or removed.
 */
export class Lifecycle {
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly ctx: AppContext) {
    ctx.tunnels.on('changed', () => {
      // A new tunnel means a new run token: restart a running cloudflared.
      if (ctx.supervisor.status().state === 'running') void ctx.supervisor.restart();
    });
  }

  /** Called once after the HTTP server listens. Never throws. */
  async start(): Promise<void> {
    const { ctx } = this;
    const version = await ctx.supervisor.detectVersion();
    if (version) ctx.logger.info({ version }, 'cloudflared found');
    else
      ctx.logger.warn(
        { path: ctx.config.cloudflaredPath },
        'cloudflared binary not found or not runnable',
      );

    if (ctx.cloudflare.isConfigured()) {
      void ctx.supervisor.start();
      void this.reconcile('startup');
    } else {
      await ctx.supervisor.disable();
    }

    if (ctx.config.reconcileIntervalSeconds > 0) {
      this.every(ctx.config.reconcileIntervalSeconds, () => this.reconcile('periodic'));
    }
    if (ctx.config.healthcheckIntervalSeconds > 0) {
      this.every(ctx.config.healthcheckIntervalSeconds, () => ctx.hosts.checkAll());
      void ctx.hosts.checkAll().catch(() => undefined);
    }
  }

  /** Stop timers and cloudflared (graceful shutdown). */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.ctx.supervisor.stop();
  }

  /** After a token was saved: make sure the tunnel exists, (re)start cloudflared, reconcile. */
  async onCloudflareConfigured(): Promise<void> {
    await this.ctx.tunnels.ensureTunnel();
    await this.ctx.supervisor.restart();
    void this.reconcile('token saved');
  }

  /** After the token was removed: stop cloudflared, nothing else to run. */
  async onCloudflareRemoved(): Promise<void> {
    await this.ctx.supervisor.disable();
  }

  /** Full reconciliation that only logs failures. */
  async reconcile(reason: string): Promise<void> {
    if (!this.ctx.cloudflare.isConfigured()) return;
    try {
      const { result } = await this.ctx.reconciler.sync();
      if (!result.ok) this.ctx.logger.warn({ reason }, 'reconciliation finished with errors');
    } catch (err) {
      this.ctx.logger.warn({ reason, err: errorMessage(err) }, 'reconciliation failed');
    }
  }

  private every(seconds: number, fn: () => Promise<unknown>): void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      fn()
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, seconds * 1000);
    timer.unref();
    this.timers.push(timer);
  }
}
