/**
 * The pure half of the reconciler: compare what the user wants (SQLite) with
 * what exists on Cloudflare and return the list of actions that make them
 * match. No I/O, fully unit tested (see docs/architecture.md §6).
 */
import { DNS_OWNERSHIP_PREFIX, dnsOwnershipComment } from '@burrow/shared';
import type { CfDnsRecord, CfDnsRecordInput, CfIngressRule } from '../cloudflare/types.js';
import {
  buildIngressRule,
  ingressEqual,
  keyOfRule,
  mergeIngress,
  type IngressHost,
} from './ingress.js';

/** A proxy host as the planner sees it. */
export interface PlanHost extends IngressHost {
  id: number;
  zoneId: string;
  enabled: boolean;
}

/** A DNS record together with the zone it was listed from. */
export type ZonedDnsRecord = CfDnsRecord & { zoneId: string };

export interface ActualState {
  tunnelId: string;
  /** Live ingress rules of the tunnel. */
  ingress: CfIngressRule[];
  /** `hostname|path` keys of the rules Burrow wrote last time. */
  managedKeys: string[];
  /**
   * DNS records that matter: every record whose name is a host's hostname and
   * every record carrying the Burrow ownership comment. Records not listed
   * here are never touched.
   */
  dnsRecords: ZonedDnsRecord[];
  /** Zones whose DNS records could not be listed, with the reason. Hosts there get no DNS action. */
  unavailableZones?: Map<string, string>;
  /**
   * When set, only these hostnames (lower case) were looked up in DNS: other
   * hostnames get no DNS action (their records were simply not loaded).
   */
  dnsScope?: Set<string>;
  /**
   * Hostnames (lower case) published through *another* Burrow tunnel. Their
   * records are never deleted as orphans by this tunnel's plan: the other
   * tunnel's plan repoints them.
   */
  otherHostnames?: Set<string>;
}

export type PlannedAction =
  | { kind: 'ingress.update'; rules: CfIngressRule[] }
  | {
      kind: 'dns.create';
      zoneId: string;
      hostname: string;
      record: CfDnsRecordInput;
      hostIds: number[];
    }
  | {
      kind: 'dns.update';
      zoneId: string;
      recordId: string;
      hostname: string;
      record: CfDnsRecordInput;
      hostIds: number[];
    }
  | { kind: 'dns.delete'; zoneId: string; recordId: string; hostname: string; hostIds: number[] }
  | { kind: 'host.conflict'; hostname: string; hostIds: number[]; reason: string };

export interface Plan {
  actions: PlannedAction[];
  /** The ingress list that should be live after execution. */
  ingress: CfIngressRule[];
  /** Keys of the rules Burrow owns once the plan is applied. */
  managedKeys: string[];
  /** DNS record already correct for a hostname (no action needed). */
  dnsRecordIds: Map<string, string>;
  /** Hosts that cannot be synced, with the reason (conflicts, unavailable zones). */
  hostErrors: Map<number, { code: 'DNS_CONFLICT' | 'CLOUDFLARE_API_ERROR'; message: string }>;
}

/** The CNAME every published hostname must have. */
export function desiredDnsRecord(hostname: string, tunnelId: string): CfDnsRecordInput {
  return {
    type: 'CNAME',
    name: hostname,
    content: tunnelTarget(tunnelId),
    proxied: true,
    ttl: 1,
    comment: dnsOwnershipComment(tunnelId),
  };
}

/** True when Burrow created this record (any Burrow tunnel). */
export function isOwnedRecord(record: Pick<CfDnsRecord, 'comment'>): boolean {
  return (record.comment ?? '').startsWith(DNS_OWNERSHIP_PREFIX);
}

/** The CNAME target of a tunnel. */
export function tunnelTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

function recordMatches(record: CfDnsRecord, want: CfDnsRecordInput): boolean {
  return (
    record.type === want.type &&
    record.content.toLowerCase() === want.content.toLowerCase() &&
    record.proxied === want.proxied &&
    (record.comment ?? '') === want.comment
  );
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Compute the actions needed to make Cloudflare match the desired hosts.
 *
 * | Situation                               | Action                         |
 * |-----------------------------------------|--------------------------------|
 * | Ingress rule missing or different       | `ingress.update`               |
 * | CNAME missing                           | `dns.create`                   |
 * | CNAME ours but wrong target/settings    | `dns.update`                   |
 * | Record exists but not ours              | `host.conflict` (not touched)  |
 * | Rule / record ours but no enabled host  | removed (`ingress.update` / `dns.delete`) |
 * | Rule Burrow did not create              | kept untouched                 |
 */
export function plan(hosts: PlanHost[], actual: ActualState): Plan {
  const actions: PlannedAction[] = [];
  const hostErrors: Plan['hostErrors'] = new Map();
  const dnsRecordIds = new Map<string, string>();
  const unavailable = actual.unavailableZones ?? new Map<string, string>();
  const ourComment = dnsOwnershipComment(actual.tunnelId);

  const enabled = hosts.filter((h) => h.enabled);

  // Group enabled hosts by hostname: several paths share one DNS record.
  const byHostname = new Map<string, PlanHost[]>();
  for (const host of enabled) {
    const key = host.hostname.toLowerCase();
    byHostname.set(key, [...(byHostname.get(key) ?? []), host]);
  }

  const conflicted = new Set<string>();

  /* ---- DNS for desired hostnames ---- */
  for (const [hostname, group] of byHostname) {
    if (actual.dnsScope && !actual.dnsScope.has(hostname)) continue;
    const zoneId = group[0]!.zoneId;
    const hostIds = group.map((h) => h.id);
    const zoneError = unavailable.get(zoneId);
    if (zoneError !== undefined) {
      for (const id of hostIds) {
        hostErrors.set(id, { code: 'CLOUDFLARE_API_ERROR', message: zoneError });
      }
      continue;
    }

    const records = actual.dnsRecords.filter(
      (r) => r.zoneId === zoneId && sameName(r.name, hostname),
    );
    const foreign = records.filter((r) => !isOwnedRecord(r));
    const ours = records.filter(isOwnedRecord);
    const want = desiredDnsRecord(hostname, actual.tunnelId);

    if (foreign.length > 0) {
      const types = [...new Set(foreign.map((r) => r.type))].join(', ');
      const reason = `A DNS record (${types}) for ${hostname} already exists and was not created by Burrow. Remove it in the Cloudflare dashboard or pick another subdomain.`;
      conflicted.add(hostname);
      actions.push({ kind: 'host.conflict', hostname, hostIds, reason });
      for (const id of hostIds) hostErrors.set(id, { code: 'DNS_CONFLICT', message: reason });
      continue;
    }

    const [primary, ...duplicates] = ours;
    if (!primary) {
      actions.push({ kind: 'dns.create', zoneId, hostname, record: want, hostIds });
    } else if (!recordMatches(primary, want)) {
      actions.push({
        kind: 'dns.update',
        zoneId,
        recordId: primary.id,
        hostname,
        record: want,
        hostIds,
      });
    } else {
      dnsRecordIds.set(hostname, primary.id);
    }
    for (const dup of duplicates) {
      actions.push({ kind: 'dns.delete', zoneId, recordId: dup.id, hostname, hostIds: [] });
    }
  }

  /* ---- DNS orphans: records with *this* tunnel's comment and no enabled host ---- */
  for (const record of actual.dnsRecords) {
    const name = record.name.toLowerCase();
    if (byHostname.has(name)) continue;
    if (actual.otherHostnames?.has(name)) continue;
    if ((record.comment ?? '') !== ourComment) continue;
    if (unavailable.has(record.zoneId)) continue;
    const hostIds = hosts.filter((h) => !h.enabled && sameName(h.hostname, name)).map((h) => h.id);
    actions.push({
      kind: 'dns.delete',
      zoneId: record.zoneId,
      recordId: record.id,
      hostname: name,
      hostIds,
    });
  }

  /* ---- Ingress ---- */
  const desiredRules = enabled
    .filter((h) => !conflicted.has(h.hostname.toLowerCase()))
    .map(buildIngressRule);
  const ingress = mergeIngress(actual.ingress, desiredRules, actual.managedKeys);
  if (!ingressEqual(actual.ingress, ingress)) {
    // Put the ingress write first: the executor relies on this order.
    actions.unshift({ kind: 'ingress.update', rules: ingress });
  }

  return {
    actions,
    ingress,
    managedKeys: desiredRules.map(keyOfRule),
    dnsRecordIds,
    hostErrors,
  };
}
