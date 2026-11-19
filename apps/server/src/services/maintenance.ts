/**
 * Maintenance mode.
 *
 * Turning it on for a host rewrites the host's tunnel route to point at
 * Burrow's maintenance server (MAINTENANCE_ORIGIN, a small HTTP listener
 * separate from the admin UI), which answers every request for that
 * hostname with the maintenance page and HTTP 503. Cloudflare Access stays in
 * front of protected hosts. Turning it off restores the route.
 *
 * The maintenance listener serves nothing but these pages: it knows no
 * session, no API, and is bound to 127.0.0.1 by default (cloudflared runs in
 * the same container).
 */
import {
  DEFAULT_MAINTENANCE_PAGE,
  maintenancePageSchema,
  renderMaintenancePage,
  type HostMaintenanceInput,
  type MaintenancePage,
  type ProxyHost,
  hostMaintenanceInputSchema,
} from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { proxyHosts } from '../db/schema.js';
import type { SettingsRepository } from '../db/settings.js';
import { errorMessage } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import type { AuditService } from './audit.js';
import type { CloudflareService } from './cloudflare.js';
import type { HostService } from './hosts.js';
import type { Reconciler } from './reconciler.js';

export const MAINTENANCE_PAGE_KEY = 'maintenance.page';

export interface MaintenanceServiceOptions {
  db: Db;
  settings: SettingsRepository;
  hosts: HostService;
  reconciler: Reconciler;
  cloudflare: CloudflareService;
  audit: AuditService;
  logger: Logger;
  port: number;
  listen: string;
  origin: string;
}

export interface MaintenanceResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Strict policy for the built-in design: no scripts, images from anywhere. */
const SIMPLE_CSP =
  "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export class MaintenanceService {
  private server: Server | null = null;

  constructor(private readonly opts: MaintenanceServiceOptions) {}

  /** URL cloudflared reaches the maintenance server on. */
  get origin(): string {
    return this.opts.origin;
  }

  /** The default page (Settings › Maintenance page). */
  defaultPage(): MaintenancePage {
    const stored = this.opts.settings.get<unknown>(MAINTENANCE_PAGE_KEY);
    const parsed = maintenancePageSchema.safeParse(stored ?? {});
    return parsed.success ? parsed.data : DEFAULT_MAINTENANCE_PAGE;
  }

  saveDefaultPage(input: unknown, userId: number | null): MaintenancePage {
    const page = maintenancePageSchema.parse(input);
    this.opts.settings.set(MAINTENANCE_PAGE_KEY, page);
    this.opts.audit.record(userId, 'maintenance.page');
    return page;
  }

  /** Turn maintenance on or off for a host (also allowed on Docker hosts). */
  async setHost(id: number, raw: HostMaintenanceInput, userId: number | null): Promise<ProxyHost> {
    const input = hostMaintenanceInputSchema.parse(raw);
    const row = this.opts.hosts.getRow(id);
    this.opts.db
      .update(proxyHosts)
      .set({
        maintenanceEnabled: input.enabled,
        maintenanceUntil: input.enabled && input.until ? new Date(input.until).toISOString() : null,
        maintenancePage: input.page,
        syncStatus: 'pending',
        updatedAt: nowIso(),
      })
      .where(eq(proxyHosts.id, id))
      .run();
    this.opts.audit.record(
      userId,
      input.enabled ? 'host.maintenance.on' : 'host.maintenance.off',
      row.hostname + row.path,
    );
    if (row.maintenanceEnabled !== input.enabled && this.opts.cloudflare.isConfigured()) {
      const outcome = await this.opts.reconciler.sync({
        scope: [{ zoneId: row.zoneId, hostname: row.hostname }],
      });
      const result = outcome.hosts.get(id);
      if (result && !result.ok && result.error) {
        // Put the previous state back: the route was not switched.
        this.opts.db
          .update(proxyHosts)
          .set({
            maintenanceEnabled: row.maintenanceEnabled,
            maintenanceUntil: row.maintenanceUntil,
            maintenancePage: row.maintenancePage,
          })
          .where(eq(proxyHosts.id, id))
          .run();
        await this.opts.reconciler.sync({
          scope: [{ zoneId: row.zoneId, hostname: row.hostname }],
        });
        throw result.error;
      }
    }
    return this.opts.hosts.get(id);
  }

  /** Build the response for a request that reached the maintenance server. */
  respond(hostHeader: string | undefined): MaintenanceResponse {
    const hostname = (hostHeader ?? '').toLowerCase().replace(/:\d+$/, '').trim();
    const row = hostname
      ? this.opts.db
          .select()
          .from(proxyHosts)
          .where(eq(proxyHosts.hostname, hostname))
          .all()
          .find((r) => r.maintenanceEnabled)
      : undefined;
    const page = row?.maintenancePage
      ? (maintenancePageSchema.safeParse(row.maintenancePage).data ?? this.defaultPage())
      : this.defaultPage();
    const until = row?.maintenanceUntil ?? null;
    const remaining = until ? Math.ceil((Date.parse(until) - Date.now()) / 1000) : 0;
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'retry-after': String(remaining > 0 ? remaining : 300),
      'x-content-type-options': 'nosniff',
    };
    if (page.mode !== 'html') headers['content-security-policy'] = SIMPLE_CSP;
    return {
      status: 503,
      headers,
      body: renderMaintenancePage(page, { hostname: hostname || 'this site', until }),
    };
  }

  /** Start the maintenance listener. Never throws. */
  async start(): Promise<void> {
    if (this.opts.port === 0 || this.server) return;
    const server = createServer((req, res) => {
      try {
        const r = this.respond(req.headers.host);
        res.writeHead(r.status, r.headers);
        res.end(req.method === 'HEAD' ? undefined : r.body);
      } catch (err) {
        this.opts.logger.warn({ err: errorMessage(err) }, 'maintenance page failed');
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('Down for maintenance');
      }
    });
    await new Promise<void>((resolve) => {
      server.once('error', (err) => {
        this.opts.logger.warn(
          { err: errorMessage(err), port: this.opts.port },
          'maintenance server could not start',
        );
        resolve();
      });
      server.listen(this.opts.port, this.opts.listen, () => {
        this.server = server;
        this.opts.logger.info(
          { address: `${this.opts.listen}:${this.address()}` },
          'maintenance server listening',
        );
        resolve();
      });
    });
  }

  /** The port actually bound (useful when MAINTENANCE_PORT is random in tests). */
  address(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}
