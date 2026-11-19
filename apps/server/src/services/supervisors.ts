import type { SupervisorStatus } from '@burrow/shared';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { TunnelRow } from '../db/schema.js';
import type { LogBuffer } from './log-buffer.js';
import { Supervisor, type SupervisorOptions } from './supervisor.js';
import type { TunnelService } from './tunnel.js';

export interface SupervisorPoolOptions {
  binaryPath: string;
  /** `host:port` of the default tunnel's metrics server; other tunnels use the next ports. */
  metricsAddress: string;
  tunnels: TunnelService;
  logs: LogBuffer;
  logger: Logger;
  knownSecrets: () => string[];
  /** Test seams forwarded to every {@link Supervisor}. */
  overrides?: Partial<Pick<SupervisorOptions, 'env' | 'backoff' | 'killTimeoutMs'>>;
}

const DISABLED: SupervisorStatus = {
  state: 'disabled',
  pid: null,
  restarts: 0,
  startedAt: null,
  lastExitCode: null,
  nextRetryAt: null,
  cloudflaredVersion: null,
};

/**
 * One {@link Supervisor} (one cloudflared process) per tunnel that has
 * `runConnector` on. {@link sync} adds, starts, stops and removes processes so
 * they match the `tunnels` table.
 *
 * Events: `state` (tunnel id, status) whenever any supervisor changes state.
 */
export class SupervisorPool extends EventEmitter<{ state: [number, SupervisorStatus] }> {
  private readonly pool = new Map<number, Supervisor>();
  private readonly ports = new Map<number, number>();
  /** Tunnel names for log labels, cached so late output never touches the database. */
  private readonly names = new Map<number, string>();
  private version: string | null = null;
  private enabled = false;

  constructor(private readonly opts: SupervisorPoolOptions) {
    super();
    this.setMaxListeners(0);
  }

  /** Run `cloudflared --version` once. Never throws. */
  async detectVersion(): Promise<string | null> {
    const probe = this.create(0, () => undefined);
    this.version = await probe.detectVersion();
    for (const s of this.pool.values()) s.setVersion(this.version);
    return this.version;
  }

  /** Status of one tunnel's cloudflared (disabled when Burrow does not run it). */
  status(tunnelId: number): SupervisorStatus {
    const s = this.pool.get(tunnelId);
    return s ? s.status() : { ...DISABLED, cloudflaredVersion: this.version };
  }

  /** Status of the default tunnel's cloudflared. */
  defaultStatus(): SupervisorStatus {
    const row = this.opts.tunnels.getDefault();
    return row ? this.status(row.id) : { ...DISABLED, cloudflaredVersion: this.version };
  }

  get(tunnelId: number): Supervisor | undefined {
    return this.pool.get(tunnelId);
  }

  /** Allow processes to run (Cloudflare configured) and match the tunnel list. */
  async enable(): Promise<void> {
    this.enabled = true;
    await this.sync();
  }

  /** Stop every process and mark them disabled (no token). */
  async disable(): Promise<void> {
    this.enabled = false;
    await Promise.all([...this.pool.values()].map((s) => s.disable()));
  }

  /** Stop everything (shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.pool.values()].map((s) => s.stop()));
  }

  /** Restart one tunnel's cloudflared if it runs (its token changed). */
  async restartIfRunning(tunnelId: number): Promise<void> {
    const s = this.pool.get(tunnelId);
    if (s && s.status().state !== 'stopped' && s.status().state !== 'disabled') await s.restart();
  }

  /** Restart every process that should run. */
  async restartAll(): Promise<void> {
    this.enabled = true;
    await this.sync();
    await Promise.all(
      this.wanted().map((row) => this.pool.get(row.id)?.restart() ?? Promise.resolve()),
    );
  }

  /**
   * Match the processes to the tunnel list: start a supervisor for every
   * tunnel that wants a connector, stop and drop the others.
   */
  async sync(): Promise<void> {
    const wanted = this.enabled ? this.wanted() : [];
    for (const row of this.opts.tunnels.list()) this.names.set(row.id, row.name);
    const ids = new Set(wanted.map((r) => r.id));
    for (const [id, s] of this.pool) {
      if (ids.has(id)) continue;
      this.pool.delete(id);
      await s.disable();
      s.removeAllListeners();
    }
    for (const row of wanted) {
      if (this.pool.has(row.id)) continue;
      const s = this.create(row.id, () => this.names.get(row.id));
      s.setVersion(this.version);
      s.on('state', (status) => this.emit('state', row.id, status));
      this.pool.set(row.id, s);
      void s.start();
    }
  }

  private wanted(): TunnelRow[] {
    return this.opts.tunnels.list().filter((r) => r.runConnector);
  }

  private create(tunnelId: number, label: () => string | undefined): Supervisor {
    return new Supervisor({
      binaryPath: this.opts.binaryPath,
      metricsAddress: this.metricsFor(tunnelId),
      getToken: () => this.opts.tunnels.getRunToken(tunnelId),
      knownSecrets: this.opts.knownSecrets,
      logs: this.opts.logs,
      logger: this.opts.logger,
      label,
      ...this.opts.overrides,
    });
  }

  /** The default tunnel keeps the configured address; others get the next free ports. */
  private metricsFor(tunnelId: number): string {
    const m = /^(.*):(\d+)$/.exec(this.opts.metricsAddress);
    if (!m) return this.opts.metricsAddress;
    const [, host, portText] = m;
    const base = Number(portText);
    if (base === 0) return this.opts.metricsAddress;
    const row = this.opts.tunnels.find(tunnelId);
    if (!row || row.isDefault) return this.opts.metricsAddress;
    let offset = this.ports.get(tunnelId);
    if (offset === undefined) {
      const used = new Set(this.ports.values());
      offset = 1;
      while (used.has(offset)) offset++;
      this.ports.set(tunnelId, offset);
    }
    return `${host}:${base + offset}`;
  }
}
