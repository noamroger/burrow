import type { SupervisorState, TunnelInfo } from '@burrow/shared';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Logger } from 'pino';
import { errorMessage } from '../lib/errors.js';
import { scrubSecrets } from '../lib/scrub.js';
import { isConnectedLine, parseCloudflaredLine } from './cloudflared-log.js';
import type { LogBuffer } from './log-buffer.js';

export type SupervisorStatus = TunnelInfo['supervisor'];

export interface SupervisorOptions {
  /** Path to the cloudflared binary (or a fake script in tests). */
  binaryPath: string;
  /** Returns the tunnel run token; called before every start. */
  getToken: () => Promise<string>;
  logs: LogBuffer;
  logger: Logger;
  /** `host:port` for cloudflared's metrics / readiness server. */
  metricsAddress?: string;
  /** Extra environment variables for the child (tests use this to steer the fake binary). */
  env?: Record<string, string>;
  /** Extra secrets to scrub from output (the API token, for instance). */
  knownSecrets?: () => string[];
  backoff?: { initialMs?: number; maxMs?: number; resetAfterMs?: number };
  /** Time to wait after SIGTERM before SIGKILL (default 10 s). */
  killTimeoutMs?: number;
}

/** Environment variables that must never reach the child process. */
const PRIVATE_ENV = ['BURROW_SECRET'];

/**
 * Runs `cloudflared tunnel run` as a child process and keeps it alive.
 *
 * ```
 * stopped ─start()→ starting ─"Registered tunnel connection"→ running
 *    ▲                 │ exit                                    │ exit
 *    └──── stop() ──── backoff (1s, 2s, 4s … 60s; reset after 5 min healthy)
 * ```
 * `disabled` means Cloudflare is not configured, so there is nothing to run.
 *
 * Events: `state` (SupervisorStatus) on every state change.
 */
export class Supervisor extends EventEmitter<{ state: [SupervisorStatus] }> {
  private state: SupervisorState = 'disabled';
  private child: ChildProcess | null = null;
  private wanted = false;
  private attempt = 0;
  private restarts = 0;
  private startedAt: string | null = null;
  private lastExitCode: number | null = null;
  private nextRetryAt: string | null = null;
  private version: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private exitWaiters: Array<() => void> = [];
  private currentToken: string | null = null;
  /** Incremented on every start/stop so stale async work can detect it was superseded. */
  private generation = 0;

  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly resetAfterMs: number;
  private readonly killTimeoutMs: number;

  constructor(private readonly opts: SupervisorOptions) {
    super();
    this.initialMs = opts.backoff?.initialMs ?? 1_000;
    this.maxMs = opts.backoff?.maxMs ?? 60_000;
    this.resetAfterMs = opts.backoff?.resetAfterMs ?? 5 * 60_000;
    this.killTimeoutMs = opts.killTimeoutMs ?? 10_000;
  }

  /** Current status, as returned by `GET /api/tunnel`. */
  status(): SupervisorStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      startedAt: this.startedAt,
      lastExitCode: this.lastExitCode,
      nextRetryAt: this.nextRetryAt,
      cloudflaredVersion: this.version,
    };
  }

  /** Run `cloudflared --version` and remember the result. Never throws. */
  async detectVersion(): Promise<string | null> {
    this.version = await new Promise<string | null>((resolve) => {
      execFile(this.opts.binaryPath, ['--version'], { timeout: 5_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /version\s+(\S+)/i.exec(stdout);
        resolve(m ? m[1]! : stdout.trim() || null);
      });
    });
    return this.version;
  }

  /** Start cloudflared (no-op if it is already running or starting). */
  async start(): Promise<void> {
    if (this.wanted && (this.child || this.state === 'starting' || this.state === 'backoff'))
      return;
    this.wanted = true;
    this.attempt = 0;
    this.generation++;
    await this.spawnChild(this.generation);
  }

  /** Stop cloudflared: SIGTERM, then SIGKILL after the kill timeout. */
  async stop(nextState: 'stopped' | 'disabled' = 'stopped'): Promise<void> {
    this.wanted = false;
    this.generation++;
    this.clearTimers();
    this.nextRetryAt = null;
    await this.killChild();
    this.setState(nextState);
  }

  /** Stop then start again (used when the token or the tunnel changes). */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Mark as disabled (Cloudflare not configured) and stop any running process. */
  disable(): Promise<void> {
    return this.stop('disabled');
  }

  private setState(state: SupervisorState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', this.status());
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.opts.logs.push({ level, message, source: 'burrow' });
    this.opts.logger[level](message);
  }

  private scrub(text: string): string {
    const known = [...(this.opts.knownSecrets?.() ?? [])];
    if (this.currentToken) known.push(this.currentToken);
    return scrubSecrets(text, known);
  }

  private async spawnChild(generation: number): Promise<void> {
    this.nextRetryAt = null;
    this.setState('starting');

    let token: string;
    try {
      token = await this.opts.getToken();
    } catch (err) {
      if (generation !== this.generation) return;
      this.log('error', `Could not get the tunnel token: ${this.scrub(errorMessage(err))}`);
      this.scheduleRestart(generation);
      return;
    }
    if (generation !== this.generation) return;
    this.currentToken = token;

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env, TUNNEL_TOKEN: token };
    for (const key of PRIVATE_ENV) delete env[key];

    const args = [
      'tunnel',
      '--no-autoupdate',
      '--metrics',
      this.opts.metricsAddress ?? '127.0.0.1:20241',
      'run',
    ];
    this.log(
      'info',
      `Starting cloudflared${this.attempt > 0 ? ` (attempt ${this.attempt + 1})` : ''}`,
    );

    const child = spawn(this.opts.binaryPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.emit('state', this.status());

    const onLine = (raw: string) => {
      if (!raw.trim()) return;
      const parsed = parseCloudflaredLine(this.scrub(raw));
      this.opts.logs.push({ ...parsed, source: 'cloudflared' });
      // Mirror to the process log so `docker logs` shows the tunnel too.
      const pinoLevel = parsed.level === 'fatal' ? 'error' : parsed.level;
      this.opts.logger[pinoLevel]({ source: 'cloudflared' }, parsed.message);
      if (this.child === child && this.state === 'starting' && isConnectedLine(parsed.message)) {
        this.setState('running');
        this.healthyTimer = setTimeout(() => {
          this.attempt = 0;
        }, this.resetAfterMs);
        this.healthyTimer.unref();
      }
    };
    createInterface({ input: child.stdout! }).on('line', onLine);
    createInterface({ input: child.stderr! }).on('line', onLine);

    let exited = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (exited) return;
      exited = true;
      if (this.child === child) this.child = null;
      this.lastExitCode = code;
      if (this.healthyTimer) clearTimeout(this.healthyTimer);
      this.healthyTimer = null;
      const waiters = this.exitWaiters;
      this.exitWaiters = [];
      waiters.forEach((w) => w());

      if (error) this.log('error', `Could not run ${this.opts.binaryPath}: ${error.message}`);
      else
        this.log(
          this.wanted ? 'warn' : 'info',
          `cloudflared exited (${signal ? `signal ${signal}` : `code ${code}`})`,
        );

      if (this.wanted && generation === this.generation) this.scheduleRestart(generation);
    };
    child.on('exit', (code, signal) => onExit(code, signal));
    child.on('error', (err) => onExit(null, null, err));
  }

  private scheduleRestart(generation: number): void {
    const delay = Math.min(this.initialMs * 2 ** this.attempt, this.maxMs);
    this.attempt++;
    this.restarts++;
    this.nextRetryAt = new Date(Date.now() + delay).toISOString();
    this.setState('backoff');
    this.log('info', `Restarting cloudflared in ${Math.round(delay / 100) / 10}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && generation === this.generation) void this.spawnChild(generation);
    }, delay);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.retryTimer = null;
    this.healthyTimer = null;
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        this.log(
          'warn',
          `cloudflared did not stop within ${this.killTimeoutMs / 1000}s, killing it`,
        );
        child.kill('SIGKILL');
      }
    }, this.killTimeoutMs);
    await exited;
    clearTimeout(timer);
  }
}
