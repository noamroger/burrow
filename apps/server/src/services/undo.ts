import {
  hostMaintenanceInputSchema,
  proxyHostInputSchema,
  type AuditUndoResult,
  type ProxyHostInput,
} from '@burrow/shared';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { proxyHosts } from '../db/schema.js';
import { AppError, errors } from '../lib/errors.js';
import type { DockerDiscoveryService } from '../docker/discovery.js';
import { stableJson, type ActorLike, type AuditService } from './audit.js';
import type { DriftService } from './drift.js';
import type { HomepageService } from './homepage.js';
import type { HostService } from './hosts.js';
import type { MaintenanceService } from './maintenance.js';
import type { Reconciler } from './reconciler.js';
import type { TunnelService } from './tunnel.js';
import type { UndoSpec } from './undo-spec.js';
import type { ZoneService } from './zones.js';

export interface UndoServiceOptions {
  db: Db;
  audit: AuditService;
  hosts: HostService;
  maintenance: MaintenanceService;
  zones: ZoneService;
  docker: DockerDiscoveryService;
  drift: DriftService;
  homepage: HomepageService;
  tunnels: TunnelService;
  reconciler: Reconciler;
  logger: Logger;
}

const changedSince = () =>
  errors.conflict('This was changed again since. Undo the newer change first, or edit it by hand.');

/** An expiry already in the past cannot be put back: drop it on restore. */
function withoutPastExpiry(input: ProxyHostInput): ProxyHostInput {
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    const { expiresAt: _gone, ...rest } = input;
    return rest;
  }
  return input;
}

/**
 * Reverses audited changes. Every undo goes through the same services as the
 * UI (so Cloudflare is re-synced, Access apps and DNS records follow), and is
 * written to the audit log as new entries linked to the change they reverse.
 *
 * An undo is refused when the state is no longer the one the change left
 * behind: it never overwrites a newer change.
 */
export class UndoService {
  constructor(private readonly opts: UndoServiceOptions) {}

  async undo(entryId: number, by: ActorLike): Promise<AuditUndoResult> {
    const { audit } = this.opts;
    const row = audit.row(entryId);
    if (!row) throw errors.notFound('Audit entry');
    if (row.undoneAt) throw errors.conflict('This change was already undone.');
    if (!row.undo) throw errors.conflict('This change cannot be undone automatically.');
    const spec = row.undo;

    const { ids } = await audit.asRevertOf(entryId, async () => {
      await this.apply(spec, by, row.action, row.target);
    });
    // Services that found nothing to change write no entry: record the undo itself.
    const firstId =
      ids[0] ?? audit.record(by, `${row.category}.undo`, row.target, { revertOf: entryId });
    audit.markUndone(entryId, firstId);
    this.opts.logger.info({ entryId, action: row.action }, 'change undone');
    return { undone: audit.toApi(audit.row(entryId)!), entry: audit.toApi(audit.row(firstId)!) };
  }

  private hostRow(id: number) {
    return this.opts.db.select().from(proxyHosts).where(eq(proxyHosts.id, id)).get();
  }

  private async apply(
    spec: UndoSpec,
    by: ActorLike,
    action: string,
    target: string | null,
  ): Promise<void> {
    const o = this.opts;
    switch (spec.kind) {
      case 'host.delete': {
        const host = this.hostRow(spec.hostId);
        if (!host) throw errors.conflict('This host was already deleted.');
        if (stableJson(o.hosts.toInput(host)) !== stableJson(spec.expect)) throw changedSince();
        await o.hosts.remove(spec.hostId, by);
        return;
      }
      case 'host.restore': {
        const host = this.hostRow(spec.hostId);
        if (!host) throw errors.conflict('This host was deleted since.');
        if (stableJson(o.hosts.toInput(host)) !== stableJson(spec.expect)) throw changedSince();
        const input = proxyHostInputSchema.parse(withoutPastExpiry(spec.input));
        await o.hosts.update(spec.hostId, input, by);
        return;
      }
      case 'host.recreate': {
        if (spec.input.expiresAt && Date.parse(spec.input.expiresAt) <= Date.now()) {
          throw errors.conflict('This temporary host would already have expired.');
        }
        const input = proxyHostInputSchema.parse(spec.input);
        const created = await o.hosts.create(input, by);
        if (Object.keys(spec.extra).length > 0) {
          // Options kept from an imported route (connectTimeout…), not part of the form.
          o.db
            .update(proxyHosts)
            .set({ originRequestExtra: spec.extra })
            .where(eq(proxyHosts.id, created.id))
            .run();
          await o.reconciler
            .sync({ scope: [{ zoneId: created.zoneId, hostname: created.hostname }] })
            .catch(() => undefined);
        }
        return;
      }
      case 'host.maintenance': {
        const host = this.hostRow(spec.hostId);
        if (!host) throw errors.conflict('This host was deleted since.');
        if (host.maintenanceEnabled !== spec.expect) throw changedSince();
        const input = hostMaintenanceInputSchema.parse(spec.input);
        if (input.until && Date.parse(input.until) <= Date.now()) input.until = null;
        await o.maintenance.setHost(spec.hostId, input, by);
        return;
      }
      case 'zone.enabled': {
        const zone = o.zones.getLocal(spec.zoneId);
        if ((zone?.enabled ?? false) === spec.enabled) throw changedSince();
        await o.zones.update(spec.zoneId, spec.enabled);
        o.audit.record(by, spec.enabled ? 'zone.enable' : 'zone.disable', target, {
          undo: { kind: 'zone.enabled', zoneId: spec.zoneId, enabled: !spec.enabled },
        });
        return;
      }
      case 'docker.enabled': {
        if (o.docker.status().enabled === spec.enabled) throw changedSince();
        await o.docker.setEnabled(spec.enabled);
        o.audit.record(by, spec.enabled ? 'docker.discovery.on' : 'docker.discovery.off', null, {
          undo: { kind: 'docker.enabled', enabled: !spec.enabled },
        });
        return;
      }
      case 'drift.autoRepair': {
        if (o.drift.autoRepair() === spec.enabled) throw changedSince();
        o.drift.setAutoRepair(spec.enabled);
        o.audit.record(by, spec.enabled ? 'drift.autorepair.on' : 'drift.autorepair.off', null, {
          undo: { kind: 'drift.autoRepair', enabled: !spec.enabled },
        });
        return;
      }
      case 'homepage.settings': {
        if (stableJson(o.homepage.settings()) !== stableJson(spec.expect)) throw changedSince();
        o.homepage.saveSettings(spec.settings, by);
        return;
      }
      case 'maintenance.page': {
        if (stableJson(o.maintenance.defaultPage()) !== stableJson(spec.expect)) {
          throw changedSince();
        }
        o.maintenance.saveDefaultPage(spec.page, by);
        return;
      }
      case 'tunnel.update': {
        const tunnel = o.tunnels.find(spec.tunnelId);
        if (!tunnel) throw errors.conflict('This tunnel was removed since.');
        const currentDefault = o.tunnels.getDefault()?.id ?? null;
        if (
          tunnel.runConnector !== spec.expect.runConnector ||
          currentDefault !== spec.expect.defaultTunnelId
        ) {
          throw changedSince();
        }
        if (spec.defaultTunnelId !== null && spec.defaultTunnelId !== currentDefault) {
          if (!o.tunnels.find(spec.defaultTunnelId)) {
            throw errors.conflict('The previous default tunnel was removed since.');
          }
          o.tunnels.update(spec.defaultTunnelId, { isDefault: true });
        }
        if (tunnel.runConnector !== spec.runConnector) {
          o.tunnels.update(spec.tunnelId, { runConnector: spec.runConnector });
        }
        o.audit.record(by, 'tunnel.update', target, {
          undo: {
            kind: 'tunnel.update',
            tunnelId: spec.tunnelId,
            runConnector: spec.expect.runConnector,
            defaultTunnelId: spec.expect.defaultTunnelId,
            expect: { runConnector: spec.runConnector, defaultTunnelId: spec.defaultTunnelId },
          },
        });
        return;
      }
      default: {
        const unknown: never = spec;
        throw new AppError(
          'CONFLICT',
          `Unknown undo for ${action}: ${JSON.stringify(unknown)}`,
          409,
        );
      }
    }
  }
}
