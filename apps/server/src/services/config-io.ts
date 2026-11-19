import {
  accessSessionDurationSchema,
  findTemplate,
  buildHostname,
  CONFIG_FORMAT_VERSION,
  type ConfigDocument,
  type ConfigImportReport,
  type ParsedConfigDocument,
} from '@burrow/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { proxyHosts, zones, type ProxyHostRow, type TunnelRow } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import type { CloudflareService } from './cloudflare.js';
import type { Reconciler } from './reconciler.js';
import type { TunnelService } from './tunnel.js';

export interface ConfigServiceOptions {
  db: Db;
  cloudflare: CloudflareService;
  tunnels: TunnelService;
  reconciler: Reconciler;
  logger: Logger;
  version: string;
}

/** The host columns an import compares and writes. */
type HostValues = Pick<
  ProxyHostRow,
  | 'subdomain'
  | 'zoneId'
  | 'hostname'
  | 'service'
  | 'path'
  | 'tunnelId'
  | 'enabled'
  | 'noTlsVerify'
  | 'httpHostHeader'
  | 'originServerName'
  | 'originRequestExtra'
  | 'accessEnabled'
  | 'accessEmails'
  | 'accessEmailDomains'
  | 'accessSessionDuration'
  | 'template'
>;

/** JSON with sorted object keys, to compare values regardless of key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Export the desired state (zones, tunnels, hosts) as a portable JSON
 * document, and import such a document back, in the same instance or in
 * another one. Zones and tunnels are referenced by name, so a file also works
 * with another Cloudflare account that has the same domains.
 *
 * The document never contains secrets.
 */
export class ConfigService {
  constructor(private readonly opts: ConfigServiceOptions) {}

  export(): ParsedConfigDocument {
    const { db } = this.opts;
    const zoneNames = new Map(
      db
        .select()
        .from(zones)
        .all()
        .map((z) => [z.id, z.name]),
    );
    const tunnels = this.opts.tunnels.list();
    const tunnelNames = new Map(tunnels.map((t) => [t.id, t.name]));
    const hosts = db.select().from(proxyHosts).all();
    return {
      burrow: CONFIG_FORMAT_VERSION,
      exportedAt: nowIso(),
      version: this.opts.version,
      zones: db
        .select()
        .from(zones)
        .where(eq(zones.enabled, true))
        .all()
        .map((z) => z.name)
        .sort(),
      tunnels: tunnels.map((t) => ({
        name: t.name,
        cfId: t.cfId,
        origin: t.origin,
        runConnector: t.runConnector,
        isDefault: t.isDefault,
      })),
      // Hosts from Docker labels are recreated by the labels, not by a file.
      hosts: hosts
        .filter((h) => h.source !== 'docker')
        .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.path.localeCompare(b.path))
        .map((h) => {
          const zone =
            zoneNames.get(h.zoneId) ??
            (h.subdomain === '@' ? h.hostname : h.hostname.slice(h.subdomain.length + 1));
          return {
            subdomain: h.subdomain,
            zone,
            ...(h.tunnelId !== null && tunnelNames.has(h.tunnelId)
              ? { tunnel: tunnelNames.get(h.tunnelId)! }
              : {}),
            service: h.service,
            path: h.path,
            enabled: h.enabled,
            options: {
              noTLSVerify: h.noTlsVerify,
              httpHostHeader: h.httpHostHeader,
              originServerName: h.originServerName,
              extra: h.originRequestExtra,
            },
            access: {
              enabled: h.accessEnabled,
              emails: h.accessEmails,
              emailDomains: h.accessEmailDomains,
              sessionDuration: accessSessionDurationSchema
                .catch('24h')
                .parse(h.accessSessionDuration),
            },
            template: h.template,
          };
        }),
    };
  }

  /**
   * Apply a document. `merge` creates and updates hosts; `replace` also
   * deletes hosts that are not in the document. With `dryRun`, nothing is
   * written: the report says what would change. A full sync follows.
   */
  async import(
    doc: ParsedConfigDocument,
    mode: 'merge' | 'replace',
    dryRun: boolean,
  ): Promise<ConfigImportReport> {
    const { db, tunnels } = this.opts;
    const report: ConfigImportReport = {
      dryRun,
      hosts: { created: [], updated: [], unchanged: [], removed: [] },
      zonesEnabled: [],
      tunnelsCreated: [],
      tunnelsImported: [],
      warnings: [],
      sync: null,
    };

    /* ---- zones: by name, among the zones the token can see ---- */
    const live = await this.opts.cloudflare.listZones();
    const liveByName = new Map(live.map((z) => [z.name.toLowerCase(), z]));
    const local = new Map(
      db
        .select()
        .from(zones)
        .all()
        .map((z) => [z.id, z]),
    );
    const wantedZones = new Set([...doc.zones, ...doc.hosts.map((h) => h.zone)]);
    const zoneIds = new Map<string, string>();
    for (const name of [...wantedZones].sort()) {
      const zone = liveByName.get(name);
      if (!zone) {
        report.warnings.push(
          `The domain ${name} is not in this Cloudflare account: its hosts were skipped.`,
        );
        continue;
      }
      zoneIds.set(name, zone.id);
      if (!local.get(zone.id)?.enabled) {
        report.zonesEnabled.push(zone.name);
        if (!dryRun) {
          db.insert(zones)
            .values({ id: zone.id, name: zone.name, enabled: true })
            .onConflictDoUpdate({ target: zones.id, set: { enabled: true, name: zone.name } })
            .run();
        }
      }
    }

    /* ---- tunnels: by Cloudflare id, then by name ---- */
    if (!dryRun) await tunnels.ensureDefault();
    const tunnelIds = new Map<string, number | null>();
    for (const t of doc.tunnels) {
      const known = tunnels.list();
      let row: TunnelRow | undefined =
        (t.cfId ? known.find((k) => k.cfId === t.cfId) : undefined) ??
        known.find((k) => k.name === t.name);
      if (!row) {
        const available = await tunnels.listAvailable().catch(() => []);
        const existing =
          (t.cfId ? available.find((a) => a.cfId === t.cfId) : undefined) ??
          available.find((a) => a.name === t.name);
        try {
          if (existing && existing.configSrc === 'cloudflare') {
            report.tunnelsImported.push(t.name);
            if (!dryRun) row = (await tunnels.import(existing.cfId, t.runConnector)).row;
          } else if (existing) {
            report.warnings.push(
              `The tunnel ${t.name} is locally managed and cannot be imported: its hosts go to the default tunnel.`,
            );
          } else {
            report.tunnelsCreated.push(t.name);
            if (!dryRun) {
              row = await tunnels.create({ name: t.name, runConnector: t.runConnector });
            }
          }
        } catch (err) {
          report.warnings.push(
            `The tunnel ${t.name} could not be set up (${errorMessage(err)}): its hosts go to the default tunnel.`,
          );
        }
      }
      tunnelIds.set(t.name, row?.id ?? null);
    }
    const defaultId = tunnels.getDefault()?.id ?? null;
    const tunnelFor = (name: string | undefined): number | null => {
      if (!name) return defaultId;
      if (tunnelIds.has(name)) return tunnelIds.get(name) ?? defaultId;
      const row = tunnels.list().find((t) => t.name === name);
      if (row) return row.id;
      report.warnings.push(`Unknown tunnel ${name}: its hosts go to the default tunnel.`);
      tunnelIds.set(name, null);
      return defaultId;
    };

    /* ---- hosts: by hostname + path ---- */
    const existing = new Map(
      db
        .select()
        .from(proxyHosts)
        .all()
        .map((h) => [`${h.hostname}|${h.path}`, h]),
    );
    const seen = new Set<string>();
    for (const h of doc.hosts) {
      const zoneId = zoneIds.get(h.zone);
      if (!zoneId) continue;
      const hostname = buildHostname(h.subdomain, h.zone);
      const key = `${hostname}|${h.path}`;
      const label = `${hostname}${h.path ? ` ${h.path}` : ''}`;
      seen.add(key);
      const values: HostValues = {
        subdomain: h.subdomain,
        zoneId,
        hostname,
        service: h.service,
        path: h.path,
        tunnelId: tunnelFor(h.tunnel),
        enabled: h.enabled,
        noTlsVerify: h.options.noTLSVerify,
        httpHostHeader: h.options.httpHostHeader,
        originServerName: h.options.originServerName,
        originRequestExtra: h.options.extra,
        accessEnabled: h.access.enabled,
        accessEmails: [...new Set(h.access.emails)],
        accessEmailDomains: [...new Set(h.access.emailDomains)],
        accessSessionDuration: h.access.sessionDuration,
        template: findTemplate(h.template)?.id ?? null,
      };
      const before = existing.get(key);
      if (before?.source === 'docker') {
        report.warnings.push(
          `${label} is managed by the Docker labels of "${before.sourceRef ?? '?'}": left unchanged.`,
        );
        continue;
      }
      if (!before) {
        report.hosts.created.push(label);
        if (!dryRun)
          db.insert(proxyHosts)
            .values({ ...values, syncStatus: 'pending' })
            .run();
        continue;
      }
      const changed = (Object.keys(values) as Array<keyof HostValues>).some((k) =>
        typeof values[k] === 'object' && values[k] !== null
          ? stable(values[k]) !== stable(before[k])
          : values[k] !== before[k],
      );
      if (!changed) {
        report.hosts.unchanged.push(label);
        continue;
      }
      report.hosts.updated.push(label);
      if (!dryRun) {
        db.update(proxyHosts)
          .set({ ...values, syncStatus: 'pending', updatedAt: nowIso() })
          .where(eq(proxyHosts.id, before.id))
          .run();
      }
    }

    if (mode === 'replace') {
      const gone = [...existing.entries()]
        .filter(([key, h]) => !seen.has(key) && h.source !== 'docker')
        .map(([, h]) => h);
      report.hosts.removed = gone.map((h) => `${h.hostname}${h.path ? ` ${h.path}` : ''}`);
      if (!dryRun && gone.length > 0) {
        db.delete(proxyHosts)
          .where(
            inArray(
              proxyHosts.id,
              gone.map((h) => h.id),
            ),
          )
          .run();
      }
    }

    if (!dryRun) {
      // Apply the default flag and connector settings of matched tunnels.
      for (const t of doc.tunnels) {
        const id = tunnelIds.get(t.name);
        if (!id) continue;
        const row = tunnels.find(id);
        if (!row) continue;
        if (row.runConnector !== t.runConnector || (t.isDefault && !row.isDefault)) {
          tunnels.update(id, {
            runConnector: t.runConnector,
            ...(t.isDefault && !row.isDefault ? { isDefault: true as const } : {}),
          });
        }
      }
      try {
        report.sync = (await this.opts.reconciler.sync()).result;
      } catch (err) {
        report.warnings.push(`Saved, but the sync failed: ${errorMessage(err)}`);
      }
      this.opts.logger.info(
        {
          mode,
          created: report.hosts.created.length,
          updated: report.hosts.updated.length,
          removed: report.hosts.removed.length,
        },
        'configuration imported',
      );
    }
    return report;
  }
}

export type { ConfigDocument };
