import type { Connector, TunnelInfo, TunnelStatus } from '@burrow/shared';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { CloudflareApiError } from '../cloudflare/client.js';
import type { CfTunnel } from '../cloudflare/types.js';
import { SettingKeys, type SettingsRepository } from '../db/settings.js';
import type { CloudflareService } from './cloudflare.js';

export interface EnsureTunnelResult {
  tunnel: CfTunnel;
  /** True when the tunnel id differs from the one stored before (new or recreated tunnel). */
  changed: boolean;
}

/**
 * Makes sure Burrow's remotely managed tunnel exists and hands out its run token.
 *
 * Events: `changed` (tunnel) when a new tunnel was created or adopted,
 * e.g. because the previous one was deleted in the dashboard.
 */
export class TunnelService extends EventEmitter<{ changed: [CfTunnel] }> {
  private inflight: Promise<EnsureTunnelResult> | null = null;

  constructor(
    private readonly settings: SettingsRepository,
    private readonly cloudflare: CloudflareService,
    private readonly logger: Logger,
  ) {
    super();
  }

  /** Id and name stored locally, without calling the API. */
  stored(): { id: string; name: string } | null {
    const id = this.settings.get<string>(SettingKeys.tunnelId);
    if (!id) return null;
    return { id, name: this.settings.get<string>(SettingKeys.tunnelName) ?? id };
  }

  /**
   * Find the tunnel stored in settings, or create `burrow-<6 hex>` with
   * `config_src: cloudflare`. Recreates it if it was deleted on Cloudflare.
   * Concurrent callers share the same in-flight call.
   */
  ensureTunnel(): Promise<EnsureTunnelResult> {
    this.inflight ??= this.doEnsure().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doEnsure(): Promise<EnsureTunnelResult> {
    const { client, accountId } = this.cloudflare.getContext();
    const storedId = this.settings.get<string>(SettingKeys.tunnelId);

    if (storedId) {
      try {
        const tunnel = await client.getTunnel(accountId, storedId);
        if (!tunnel.deleted_at) return { tunnel, changed: false };
      } catch (err) {
        if (!(err instanceof CloudflareApiError && err.isNotFound)) throw err;
      }
      this.logger.warn(
        { tunnelId: storedId },
        'tunnel no longer exists on Cloudflare, creating a new one',
      );
      this.settings.delete(
        SettingKeys.tunnelId,
        SettingKeys.tunnelName,
        SettingKeys.managedIngress,
      );
    }

    const name =
      this.settings.get<string>(SettingKeys.tunnelName) ??
      `burrow-${randomBytes(3).toString('hex')}`;
    const existing = (await client.listTunnels(accountId, { name })).find(
      (t) => t.name === name && !t.deleted_at,
    );
    const tunnel = existing ?? (await client.createTunnel(accountId, name));
    this.settings.set(SettingKeys.tunnelId, tunnel.id);
    this.settings.set(SettingKeys.tunnelName, tunnel.name);
    this.logger.info(
      { tunnelId: tunnel.id, name: tunnel.name },
      existing ? 'tunnel adopted' : 'tunnel created',
    );
    this.emit('changed', tunnel);
    return { tunnel, changed: true };
  }

  /** The run token for cloudflared. Ensures the tunnel first. Never stored. */
  async getRunToken(): Promise<string> {
    const { tunnel } = await this.ensureTunnel();
    const { client, accountId } = this.cloudflare.getContext();
    return client.getTunnelToken(accountId, tunnel.id);
  }

  /** Tunnel details and connectors for `GET /api/tunnel` (without the supervisor part). */
  async info(): Promise<Omit<TunnelInfo, 'supervisor'>> {
    const stored = this.stored();
    if (!stored || !this.cloudflare.isConfigured()) return { tunnel: null, connectors: [] };
    const { client, accountId } = this.cloudflare.getContext();
    try {
      const [tunnel, connectors] = await Promise.all([
        client.getTunnel(accountId, stored.id),
        client.listTunnelConnections(accountId, stored.id),
      ]);
      return {
        tunnel: {
          id: tunnel.id,
          name: tunnel.name,
          status: toTunnelStatus(tunnel.status),
          createdAt: tunnel.created_at,
        },
        connectors: connectors.map((c): Connector => ({
          id: c.id,
          version: c.version,
          arch: c.arch,
          runAt: c.run_at ?? null,
          connections: (c.conns ?? []).map((conn) => ({
            colo: conn.colo_name,
            openedAt: conn.opened_at,
            originIp: conn.origin_ip,
          })),
        })),
      };
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : err },
        'could not fetch tunnel details',
      );
      return {
        tunnel: { id: stored.id, name: stored.name, status: 'unknown', createdAt: '' },
        connectors: [],
      };
    }
  }
}

function toTunnelStatus(status: string): TunnelStatus {
  return (['inactive', 'degraded', 'healthy', 'down'] as const).includes(status as never)
    ? (status as TunnelStatus)
    : 'unknown';
}
