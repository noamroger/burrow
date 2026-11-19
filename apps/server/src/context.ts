import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { openDatabase, type Db } from './db/client.js';
import { SettingsRepository } from './db/settings.js';
import { errorMessage } from './lib/errors.js';
import { SecretBox } from './lib/secretbox.js';
import { ApiTokenService } from './services/api-tokens.js';
import { AuditService } from './services/audit.js';
import { AuthService } from './services/auth.js';
import { CloudflareService } from './services/cloudflare.js';
import { ConfigService } from './services/config-io.js';
import { BackupService } from './backup/service.js';
import { DockerClient, type DockerApi } from './docker/client.js';
import { defaultSelfHostname, DockerDiscoveryService } from './docker/discovery.js';
import { DriftService } from './services/drift.js';
import { HealthService } from './services/health.js';
import { HostService } from './services/hosts.js';
import { LogBuffer } from './services/log-buffer.js';
import { Reconciler } from './services/reconciler.js';
import type { SupervisorOptions } from './services/supervisor.js';
import { SupervisorPool } from './services/supervisors.js';
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
  apiTokens: ApiTokenService;
  audit: AuditService;
  cloudflare: CloudflareService;
  tunnels: TunnelService;
  logs: LogBuffer;
  supervisors: SupervisorPool;
  reconciler: Reconciler;
  health: HealthService;
  hosts: HostService;
  zones: ZoneService;
  /** Configuration export / import . */
  configIo: ConfigService;
  drift: DriftService;
  backups: BackupService;
  docker: DockerDiscoveryService;
  lifecycle: Lifecycle;
}

/** Test seams: everything here has a sensible production default. */
export interface ContextOverrides {
  fetch?: typeof fetch;
  cloudflareRetryBaseMs?: number;
  supervisor?: Partial<Pick<SupervisorOptions, 'env' | 'backoff' | 'killTimeoutMs'>>;
  healthTimeoutMs?: number;
  /** Fake Docker API for discovery tests. */
  docker?: DockerApi;
  dockerSelfHostname?: string;
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
  const tunnels = new TunnelService({
    db,
    settings,
    cloudflare,
    logger: logger.child({ component: 'tunnel' }),
  });
  const logs = new LogBuffer(2000);
  const supervisors = new SupervisorPool({
    binaryPath: config.cloudflaredPath,
    metricsAddress: config.cloudflaredMetrics,
    tunnels,
    knownSecrets: () => cloudflare.knownSecrets(),
    logs,
    logger: logger.child({ component: 'supervisor' }),
    overrides: overrides.supervisor,
  });
  const reconciler = new Reconciler({
    db,
    settings,
    cloudflare,
    tunnels,
    logger: logger.child({ component: 'reconciler' }),
  });
  const health = new HealthService(overrides.healthTimeoutMs ?? 5_000);
  const hosts = new HostService({ db, reconciler, cloudflare, health, audit, tunnels, logger });
  const zones = new ZoneService(db, cloudflare);
  const version = readVersion();
  const configIo = new ConfigService({
    db,
    cloudflare,
    tunnels,
    reconciler,
    logger: logger.child({ component: 'config' }),
    version,
  });

  const ctx = {
    config,
    logger,
    version,
    startedAt: Date.now(),
    db,
    sqlite,
    settings,
    auth,
    apiTokens: new ApiTokenService(db, box),
    audit,
    cloudflare,
    tunnels,
    logs,
    supervisors,
    reconciler,
    health,
    hosts,
    zones,
    configIo,
    drift: new DriftService({
      db,
      settings,
      reconciler,
      logger: logger.child({ component: 'drift' }),
      intervalSeconds: config.reconcileIntervalSeconds,
    }),
    backups: new BackupService({
      sqlite,
      settings,
      box,
      localDir: config.backupDir,
      logger: logger.child({ component: 'backup' }),
      fetch: overrides.fetch,
    }),
    docker: new DockerDiscoveryService({
      db,
      settings,
      hosts,
      tunnels,
      client: overrides.docker ?? new DockerClient(config.dockerHost),
      endpoint: config.dockerHost,
      intervalSeconds: config.dockerScanIntervalSeconds,
      logger: logger.child({ component: 'docker' }),
      selfHostname: overrides.dockerSelfHostname ?? defaultSelfHostname(),
      isCloudflareConfigured: () => cloudflare.isConfigured(),
    }),
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
    ctx.tunnels.on('changed', (row) => {
      // A new tunnel means a new run token: restart a running cloudflared.
      if (ctx.supervisors.status(row.id).state === 'running') {
        void ctx.supervisors.restartIfRunning(row.id);
      }
    });
    // Tunnels added, removed, or "run connector" toggled: match the processes.
    ctx.tunnels.on('listChanged', () => {
      void ctx.supervisors.sync();
    });
  }

  /** Called once after the HTTP server listens. Never throws. */
  async start(): Promise<void> {
    const { ctx } = this;
    const version = await ctx.supervisors.detectVersion();
    if (version) ctx.logger.info({ version }, 'cloudflared found');
    else
      ctx.logger.warn(
        { path: ctx.config.cloudflaredPath },
        'cloudflared binary not found or not runnable',
      );

    if (ctx.cloudflare.isConfigured()) {
      void this.boot();
    } else {
      await ctx.supervisors.disable();
    }

    if (ctx.config.reconcileIntervalSeconds > 0) {
      this.every(ctx.config.reconcileIntervalSeconds, () => this.checkDrift());
    }
    // Docker discovery (does nothing while turned off).
    this.every(ctx.config.dockerScanIntervalSeconds, () => ctx.docker.scan());
    void ctx.docker.scan();
    // Backups: check every 5 minutes whether one is due (the schedule is in hours).
    this.every(300, () => ctx.backups.runIfDue());
    if (ctx.config.healthcheckIntervalSeconds > 0) {
      this.every(ctx.config.healthcheckIntervalSeconds, () => ctx.hosts.checkAll());
      void ctx.hosts.checkAll().catch(() => undefined);
    }
  }

  /** Stop timers and cloudflared (graceful shutdown). */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.ctx.supervisors.stopAll();
  }

  /** Startup with a token: ensure the default tunnel, start the connectors, reconcile. */
  private async boot(): Promise<void> {
    try {
      await this.ctx.tunnels.ensureDefault();
    } catch (err) {
      this.ctx.logger.warn({ err: errorMessage(err) }, 'could not check the default tunnel');
    }
    await this.ctx.supervisors.enable();
    await this.checkDrift();
  }

  /**
   * After a token was saved: forget the tunnels of the previous account if it
   * changed, make sure the default tunnel exists, (re)start cloudflared, reconcile.
   */
  async onCloudflareConfigured(accountChanged = false): Promise<void> {
    if (accountChanged) {
      await this.ctx.supervisors.disable();
      this.ctx.tunnels.forgetAll();
    }
    await this.ctx.tunnels.ensureDefault();
    await this.ctx.supervisors.restartAll();
    void this.reconcile('token saved');
  }

  /** After the token was removed: stop cloudflared, nothing else to run. */
  async onCloudflareRemoved(): Promise<void> {
    await this.ctx.supervisors.disable();
  }

  /**
   * Scheduled check: compare Cloudflare with Burrow and alert on drift, or
   * repair it right away when auto-repair is on. Never throws.
   */
  async checkDrift(): Promise<void> {
    if (!this.ctx.cloudflare.isConfigured()) return;
    await this.ctx.drift.scheduled().catch((err: unknown) => {
      this.ctx.logger.warn({ err: errorMessage(err) }, 'drift check failed');
    });
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
