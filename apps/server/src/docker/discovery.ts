/**
 * Docker auto-discovery: containers with a `burrow.host` label are published
 * automatically, and unpublished when the container (or the label) goes away.
 *
 * Off by default. Burrow only reads from Docker (`GET /containers/json`).
 * Hosts it creates are marked `source = docker` and can only be changed
 * through the labels. A stopped container keeps its host (the health check
 * shows it down); a removed container loses it.
 */
import {
  proxyHostInputSchema,
  subdomainSchema,
  type DockerContainerInfo,
  type DockerStatus,
  type ProxyHostParsedInput,
} from '@burrow/shared';
import { eq } from 'drizzle-orm';
import { hostname as osHostname } from 'node:os';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { Db } from '../db/client.js';
import { proxyHosts, zones, type ProxyHostRow } from '../db/schema.js';
import type { SettingsRepository } from '../db/settings.js';
import { errorMessage } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import type { HostService } from '../services/hosts.js';
import type { TunnelService } from '../services/tunnel.js';
import type { DockerApi, DockerContainer } from './client.js';
import { containerName, parseLabels, type LabelSpec } from './labels.js';

export const DOCKER_SETTINGS_KEY = 'docker.discovery';

/** After a failed publish, wait this long before trying the same labels again. */
const RETRY_AFTER_MS = 10 * 60_000;

export interface DockerDiscoveryOptions {
  db: Db;
  settings: SettingsRepository;
  hosts: HostService;
  tunnels: TunnelService;
  client: DockerApi;
  endpoint: string;
  intervalSeconds: number;
  logger: Logger;
  /** This container's hostname (its short id when running in Docker). */
  selfHostname?: string;
  isCloudflareConfigured: () => boolean;
}

interface Desired {
  container: DockerContainer;
  name: string;
  spec: LabelSpec;
  input: ProxyHostParsedInput;
}

const keyOf = (hostname: string, path: string) => `${hostname.toLowerCase()}|${path}`;

/** The fields a label change can affect, to detect updates. */
function signature(i: {
  hostname: string;
  path: string;
  service: string;
  tunnelId: number | null | undefined;
  noTlsVerify: boolean;
  httpHostHeader: string;
  originServerName: string;
  accessEnabled: boolean;
  accessEmails: string[];
  accessEmailDomains: string[];
  accessSessionDuration: string;
  accessBrowserRendering: string | null;
  template: string | null;
}): string {
  return JSON.stringify([
    i.hostname,
    i.path,
    i.service,
    i.tunnelId ?? null,
    i.noTlsVerify,
    i.httpHostHeader,
    i.originServerName,
    i.accessEnabled,
    [...i.accessEmails].sort(),
    [...i.accessEmailDomains].sort(),
    i.accessEnabled ? i.accessSessionDuration : '',
    i.accessBrowserRendering ?? null,
    i.template,
  ]);
}

function inputSignature(d: Desired, row?: ProxyHostRow): string {
  return signature({
    hostname: d.spec.hostname,
    path: d.input.path,
    service: d.input.service,
    // No burrow.tunnel label: whatever tunnel the host is on is fine.
    tunnelId: d.input.tunnelId ?? row?.tunnelId,
    noTlsVerify: d.input.options.noTLSVerify,
    httpHostHeader: d.input.options.httpHostHeader,
    originServerName: d.input.options.originServerName,
    accessEnabled: d.input.access.enabled,
    accessEmails: d.input.access.emails,
    accessEmailDomains: d.input.access.emailDomains,
    accessSessionDuration: d.input.access.sessionDuration,
    accessBrowserRendering: d.input.access.browserRendering,
    template: d.input.template,
  });
}

function rowSignature(row: ProxyHostRow): string {
  return signature({ ...row, hostname: row.hostname });
}

export class DockerDiscoveryService {
  private running: Promise<DockerStatus> | null = null;
  private lastScanAt: string | null = null;
  private reachable: boolean | null = null;
  private error: string | null = null;
  private containers: DockerContainerInfo[] = [];
  private readonly failures = new Map<string, { signature: string; at: number; message: string }>();

  constructor(private readonly opts: DockerDiscoveryOptions) {}

  isEnabled(): boolean {
    return this.opts.settings.get<{ enabled: boolean }>(DOCKER_SETTINGS_KEY)?.enabled ?? false;
  }

  status(): DockerStatus {
    return {
      enabled: this.isEnabled(),
      endpoint: this.opts.endpoint,
      reachable: this.reachable,
      error: this.error,
      lastScanAt: this.lastScanAt,
      intervalSeconds: this.opts.intervalSeconds,
      containers: this.containers,
    };
  }

  /** Turn discovery on or off. Turning it off keeps the hosts already published. */
  async setEnabled(enabled: boolean): Promise<DockerStatus> {
    this.opts.settings.set(DOCKER_SETTINGS_KEY, { enabled });
    if (!enabled) {
      this.reachable = null;
      this.error = null;
      this.containers = [];
      return this.status();
    }
    return this.scan();
  }

  /** Scan now (one scan at a time). Never throws: errors end up in the status. */
  scan(): Promise<DockerStatus> {
    if (!this.isEnabled()) return Promise.resolve(this.status());
    this.running ??= this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async execute(): Promise<DockerStatus> {
    let list: DockerContainer[];
    try {
      list = await this.opts.client.listContainers();
      this.reachable = true;
      this.error = null;
    } catch (err) {
      this.reachable = false;
      this.error = errorMessage(err);
      this.lastScanAt = nowIso();
      this.opts.logger.warn({ err: this.error }, 'docker scan failed');
      return this.status();
    }

    const self = this.opts.selfHostname
      ? list.find((c) => c.Id.startsWith(this.opts.selfHostname!))
      : undefined;
    const selfNetworks = self ? new Set(Object.keys(self.NetworkSettings?.Networks ?? {})) : null;

    const infos: DockerContainerInfo[] = [];
    const desired = new Map<string, Desired>();
    /** Keys claimed by a container, even with invalid labels: their hosts are kept. */
    const claimed = new Set<string>();

    for (const c of list) {
      const parsed = parseLabels(c, selfNetworks);
      if (parsed.kind === 'none') continue;
      const name = containerName(c);
      const info: DockerContainerInfo = {
        id: c.Id.slice(0, 12),
        name,
        image: c.Image,
        state: c.State,
        hostname: null,
        path: '',
        service: null,
        status: 'pending',
        message: null,
        hostId: null,
      };
      infos.push(info);
      if (parsed.kind === 'ignored') {
        info.status = 'ignored';
        info.message = parsed.reason;
        continue;
      }
      if (parsed.kind === 'error') {
        info.hostname = parsed.hostname;
        info.path = parsed.path;
        info.status = 'error';
        info.message = parsed.message;
        if (parsed.hostname) claimed.add(keyOf(parsed.hostname, parsed.path));
        continue;
      }
      const { spec } = parsed;
      info.hostname = spec.hostname;
      info.path = spec.path;
      info.service = spec.service;
      const key = keyOf(spec.hostname, spec.path);
      claimed.add(key);
      if (desired.has(key)) {
        info.status = 'error';
        info.message = `The container "${desired.get(key)!.name}" already uses this hostname.`;
        continue;
      }
      try {
        desired.set(key, { container: c, name, spec, input: this.toInput(spec) });
      } catch (err) {
        info.status = 'error';
        info.message = err instanceof ZodError ? zodMessage(err) : errorMessage(err);
      }
    }

    const byKey = new Map(
      infos.filter((i) => i.hostname).map((i) => [keyOf(i.hostname!, i.path), i]),
    );
    if (this.opts.isCloudflareConfigured()) {
      await this.apply(desired, claimed, byKey);
    } else {
      for (const d of desired.values()) {
        const info = byKey.get(keyOf(d.spec.hostname, d.spec.path))!;
        if (info.status === 'pending') info.message = 'Waiting for the Cloudflare token.';
      }
    }

    this.containers = infos.sort((a, b) => a.name.localeCompare(b.name));
    this.lastScanAt = nowIso();
    return this.status();
  }

  /** Create, update and delete Docker hosts to match the labels. */
  private async apply(
    desired: Map<string, Desired>,
    claimed: Set<string>,
    infos: Map<string, DockerContainerInfo>,
  ): Promise<void> {
    const { db, hosts, logger } = this.opts;
    const rows = db.select().from(proxyHosts).all();
    const rowsByKey = new Map(rows.map((r) => [keyOf(r.hostname, r.path), r]));

    for (const [key, d] of desired) {
      const info = infos.get(key)!;
      const row = rowsByKey.get(key);
      if (row && row.source !== 'docker') {
        info.status = 'error';
        info.hostId = row.id;
        info.message =
          'This hostname is already published manually in Burrow. Delete that host first.';
        continue;
      }
      const sig = inputSignature(d, row);
      if (row && rowSignature(row) === sig && row.sourceRef === d.name) {
        this.failures.delete(key);
        info.hostId = row.id;
        info.status = row.syncStatus === 'error' ? 'error' : 'published';
        info.message = row.syncStatus === 'error' ? row.syncError : null;
        continue;
      }
      const failed = this.failures.get(key);
      if (failed && failed.signature === sig && Date.now() - failed.at < RETRY_AFTER_MS) {
        info.status = 'error';
        info.hostId = row?.id ?? null;
        info.message = failed.message;
        continue;
      }
      try {
        const origin = { source: 'docker' as const, ref: d.name };
        const host = row
          ? await hosts.update(row.id, d.input, null, origin)
          : await hosts.create(d.input, null, origin);
        this.failures.delete(key);
        info.hostId = host.id;
        info.status = host.sync.status === 'error' ? 'error' : 'published';
        info.message = host.sync.error;
        logger.info(
          { hostname: d.spec.hostname, container: d.name },
          row ? 'docker host updated' : 'docker host published',
        );
      } catch (err) {
        const message = errorMessage(err);
        this.failures.set(key, { signature: sig, at: Date.now(), message });
        info.status = 'error';
        info.hostId = row?.id ?? null;
        info.message = message;
        logger.warn(
          { hostname: d.spec.hostname, container: d.name, err: message },
          'docker host failed',
        );
      }
    }

    // Hosts whose container is gone or no longer has the label.
    for (const row of rows) {
      const key = keyOf(row.hostname, row.path);
      if (row.source !== 'docker' || claimed.has(key)) continue;
      try {
        await hosts.remove(row.id, null, { source: 'docker', ref: row.sourceRef });
        this.failures.delete(key);
        logger.info({ hostname: row.hostname, container: row.sourceRef }, 'docker host removed');
      } catch (err) {
        logger.warn(
          { hostname: row.hostname, err: errorMessage(err) },
          'could not remove docker host',
        );
      }
    }
  }

  /** Labels → host input, resolving the zone and tunnel. Throws on invalid input. */
  private toInput(spec: LabelSpec): ProxyHostParsedInput {
    const enabledZones = this.opts.db
      .select()
      .from(zones)
      .where(eq(zones.enabled, true))
      .all()
      .sort((a, b) => b.name.length - a.name.length);
    const zone = enabledZones.find(
      (z) => spec.hostname === z.name || spec.hostname.endsWith(`.${z.name}`),
    );
    if (!zone) {
      throw new Error(
        `No enabled zone matches ${spec.hostname}. Enable its domain in Settings › Zones.`,
      );
    }
    const subdomain =
      spec.hostname === zone.name ? '@' : spec.hostname.slice(0, -zone.name.length - 1);
    if (!subdomainSchema.safeParse(subdomain).success) {
      throw new Error(`"${spec.hostname}" is not a valid hostname.`);
    }
    let tunnelId: number | undefined;
    if (spec.tunnel) {
      const tunnel = this.opts.tunnels.list().find((t) => t.name === spec.tunnel);
      if (!tunnel) throw new Error(`No tunnel named "${spec.tunnel}" in Burrow.`);
      tunnelId = tunnel.id;
    }
    return proxyHostInputSchema.parse({
      subdomain,
      zoneId: zone.id,
      ...(tunnelId !== undefined ? { tunnelId } : {}),
      service: spec.service,
      path: spec.path,
      enabled: true,
      options: {
        noTLSVerify: spec.noTLSVerify,
        httpHostHeader: spec.httpHostHeader,
        originServerName: spec.originServerName,
      },
      access: spec.access,
      template: spec.template,
    });
  }
}

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
    .join('; ');
}

/** Default self id: the container hostname is its short id unless `hostname:` is set. */
export function defaultSelfHostname(): string {
  return osHostname();
}
