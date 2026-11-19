/**
 * The pure half of Cloudflare Access reconciliation: compare the protection
 * the user wants (SQLite) with the Access applications and reusable policies
 * that exist on Cloudflare, and return the actions that make them match.
 * No I/O, fully unit tested. See docs/adr/0005-cloudflare-access.md.
 *
 * Model: one self-hosted Access application per protected hostname, linked to
 * one reusable "allow" policy listing the allowed emails and email domains.
 * Both are named `[Burrow] <hostname>`.
 */
import {
  ACCESS_OWNERSHIP_PREFIX,
  ACCESS_SESSION_DURATIONS,
  accessResourceName,
} from '@burrow/shared';
import type {
  CfAccessApp,
  CfAccessAppInput,
  CfAccessPolicy,
  CfAccessPolicyInput,
  CfAccessRule,
} from '../cloudflare/types.js';

/** A proxy host as the Access planner sees it. */
export interface AccessHost {
  id: number;
  hostname: string;
  enabled: boolean;
  accessEnabled: boolean;
  accessEmails: string[];
  accessEmailDomains: string[];
  accessSessionDuration: string;
}

/** The protection wanted for one hostname (all its paths share it). */
export interface AccessDesired {
  hostname: string;
  emails: string[];
  emailDomains: string[];
  sessionDuration: string;
  hostIds: number[];
}

export type AccessAction =
  | {
      kind: 'access.create';
      hostname: string;
      app: Omit<CfAccessAppInput, 'policies'>;
      policy: CfAccessPolicyInput;
      /** A Burrow policy for this hostname left over from an earlier failed run: reuse it. */
      existingPolicyId: string | null;
      /** True when the existing policy's rules must be rewritten. */
      policyChanged: boolean;
      hostIds: number[];
    }
  | {
      kind: 'access.update';
      hostname: string;
      appId: string;
      app: Omit<CfAccessAppInput, 'policies'>;
      /** Rewrite the application (settings differ or the policy is not linked). */
      appChanged: boolean;
      policy: CfAccessPolicyInput;
      /** Burrow's policy for this hostname, or null when it must be created. */
      policyId: string | null;
      policyChanged: boolean;
      hostIds: number[];
    }
  | {
      kind: 'access.delete';
      hostname: string;
      /** Null when only orphan policies are left. */
      appId: string | null;
      policyIds: string[];
    }
  | { kind: 'access.conflict'; hostname: string; reason: string; hostIds: number[] };

export interface AccessPlan {
  /** Creates and updates. Run them before the tunnel route and DNS are published. */
  ensure: AccessAction[];
  /** Deletions. Run them after the tunnel route and DNS are removed. */
  remove: AccessAction[];
  /** Hostnames that must not be published (protection wanted but not possible). */
  conflicts: Map<string, string>;
}

const lc = (s: string) => s.toLowerCase();
const sorted = (xs: Iterable<string>) => [...new Set([...xs].map(lc))].sort();

/** True when Burrow created this application or policy (by name). */
export function isOwnedAccessResource(resource: { name?: string | null }): boolean {
  return (resource.name ?? '').startsWith(ACCESS_OWNERSHIP_PREFIX);
}

/** Shortest of two Cloudflare durations from the supported list (the safer choice). */
function shorterDuration(a: string, b: string): string {
  const order = ACCESS_SESSION_DURATIONS as readonly string[];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia === -1) return b;
  if (ib === -1) return a;
  return ia <= ib ? a : b;
}

/**
 * Group protected, enabled hosts by hostname. Access applies to a whole
 * hostname, so hosts sharing it (different paths) merge their allow lists,
 * and the shortest session duration wins.
 */
export function desiredAccess(hosts: AccessHost[]): Map<string, AccessDesired> {
  const out = new Map<string, AccessDesired>();
  for (const h of hosts) {
    if (!h.enabled || !h.accessEnabled) continue;
    const key = lc(h.hostname);
    const prev = out.get(key);
    if (!prev) {
      out.set(key, {
        hostname: key,
        emails: sorted(h.accessEmails),
        emailDomains: sorted(h.accessEmailDomains),
        sessionDuration: h.accessSessionDuration,
        hostIds: [h.id],
      });
      continue;
    }
    prev.emails = sorted([...prev.emails, ...h.accessEmails]);
    prev.emailDomains = sorted([...prev.emailDomains, ...h.accessEmailDomains]);
    prev.sessionDuration = shorterDuration(prev.sessionDuration, h.accessSessionDuration);
    prev.hostIds.push(h.id);
  }
  return out;
}

/** The policy body for a hostname. */
export function desiredPolicy(d: AccessDesired): CfAccessPolicyInput {
  return {
    name: accessResourceName(d.hostname),
    decision: 'allow',
    include: [
      ...d.emails.map((email) => ({ email: { email } })),
      ...d.emailDomains.map((domain) => ({ email_domain: { domain } })),
    ],
    exclude: [],
    require: [],
  };
}

/** The application body for a hostname (policies are added by the executor). */
export function desiredApp(d: AccessDesired): Omit<CfAccessAppInput, 'policies'> {
  return {
    name: accessResourceName(d.hostname),
    type: 'self_hosted',
    domain: d.hostname,
    destinations: [{ type: 'public', uri: d.hostname }],
    session_duration: d.sessionDuration,
    app_launcher_visible: false,
  };
}

/** Hostnames (no path) an application covers exactly. Path-scoped destinations are ignored. */
export function appHostnames(app: CfAccessApp): string[] {
  const uris = [app.domain ?? '', ...(app.destinations ?? []).map((d) => d.uri ?? '')];
  const out = new Set<string>();
  for (const raw of uris) {
    const uri = lc(raw.trim()).replace(/\/+$/, '');
    if (uri && !uri.includes('/')) out.add(uri);
  }
  return [...out];
}

/** Canonical form of an include list, to compare the live policy with the wanted one. */
function ruleKeys(rules: CfAccessRule[] | undefined): string[] {
  return (rules ?? [])
    .map((r) => {
      const rule = r as { email?: { email?: string }; email_domain?: { domain?: string } };
      if (rule.email?.email) return `email:${lc(rule.email.email)}`;
      if (rule.email_domain?.domain) return `domain:${lc(rule.email_domain.domain)}`;
      return `other:${JSON.stringify(r)}`;
    })
    .sort();
}

function policyMatches(live: CfAccessPolicy, want: CfAccessPolicyInput): boolean {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return (
    live.decision === want.decision &&
    same(ruleKeys(live.include), ruleKeys(want.include)) &&
    ruleKeys(live.exclude).length === 0 &&
    ruleKeys(live.require).length === 0
  );
}

function appMatches(
  live: CfAccessApp,
  want: Omit<CfAccessAppInput, 'policies'>,
  policyId: string,
): boolean {
  const linked = live.policies ?? [];
  return (
    live.type === want.type &&
    lc(live.domain ?? '') === want.domain &&
    (live.session_duration ?? '24h') === want.session_duration &&
    linked.length === 1 &&
    linked[0]!.id === policyId
  );
}

export interface AccessActual {
  apps: CfAccessApp[];
  policies: CfAccessPolicy[];
}

export interface PlanAccessOptions {
  /** Hostnames this Burrow instance created Access applications for. Only those are ever deleted. */
  managed: Iterable<string>;
  /** When set, only these hostnames are looked at (targeted sync). */
  scope?: Set<string>;
}

/**
 * Compute the Access actions for the wanted protections.
 *
 * | Situation                                             | Action                     |
 * |-------------------------------------------------------|----------------------------|
 * | Protected hostname, no application                    | `access.create`            |
 * | Burrow application differs (session, policy, rules)   | `access.update`            |
 * | Application on the hostname not created by Burrow    | `access.conflict` (kept)   |
 * | Burrow application, hostname no longer protected      | `access.delete`            |
 * | Burrow policy linked to no application (full run)     | `access.delete` (policy)   |
 * | Anything else                                         | untouched                  |
 */
export function planAccess(
  wanted: Map<string, AccessDesired>,
  actual: AccessActual,
  opts: PlanAccessOptions,
): AccessPlan {
  const managed = new Set([...opts.managed].map(lc));
  const inScope = (h: string) => !opts.scope || opts.scope.has(h);
  const ensure: AccessAction[] = [];
  const remove: AccessAction[] = [];
  const conflicts = new Map<string, string>();

  const policiesById = new Map(actual.policies.map((p) => [p.id, p]));
  const ownedPolicyByName = new Map<string, CfAccessPolicy>();
  for (const p of actual.policies) {
    if (isOwnedAccessResource(p) && !ownedPolicyByName.has(p.name))
      ownedPolicyByName.set(p.name, p);
  }

  // Applications by exact hostname.
  const appsByHost = new Map<string, CfAccessApp[]>();
  for (const app of actual.apps) {
    for (const h of appHostnames(app)) appsByHost.set(h, [...(appsByHost.get(h) ?? []), app]);
  }

  /** Burrow policies linked to an application (by link, else by name). */
  const ownedPoliciesOf = (app: CfAccessApp, hostname: string): CfAccessPolicy[] => {
    const linked = (app.policies ?? [])
      .map((l) => policiesById.get(l.id))
      .filter((p): p is CfAccessPolicy => !!p && isOwnedAccessResource(p));
    if (linked.length > 0) return linked;
    const byName = ownedPolicyByName.get(accessResourceName(hostname));
    return byName ? [byName] : [];
  };

  const usedPolicyIds = new Set<string>();
  const keptAppIds = new Set<string>();

  /* ---- Wanted hostnames ---- */
  for (const [hostname, d] of wanted) {
    if (!inScope(hostname)) continue;
    const apps = appsByHost.get(hostname) ?? [];
    const foreign = apps.filter((a) => !isOwnedAccessResource(a));
    const ours = apps.filter(isOwnedAccessResource);
    for (const a of ours) keptAppIds.add(a.id);
    if (foreign.length > 0) {
      const names = foreign.map((a) => `"${a.name}"`).join(', ');
      const reason = `${hostname} is already covered by the Cloudflare Access application ${names}, which Burrow did not create. Remove it in Zero Trust › Access › Applications, or turn off protection on this host.`;
      conflicts.set(hostname, reason);
      ensure.push({ kind: 'access.conflict', hostname, reason, hostIds: d.hostIds });
      for (const a of ours) for (const p of ownedPoliciesOf(a, hostname)) usedPolicyIds.add(p.id);
      continue;
    }

    const policy = desiredPolicy(d);
    const app = desiredApp(d);
    const [primary, ...duplicates] = ours;

    if (!primary) {
      const existing = ownedPolicyByName.get(policy.name) ?? null;
      if (existing) usedPolicyIds.add(existing.id);
      ensure.push({
        kind: 'access.create',
        hostname,
        app,
        policy,
        existingPolicyId: existing?.id ?? null,
        policyChanged: existing ? !policyMatches(existing, policy) : false,
        hostIds: d.hostIds,
      });
      continue;
    }

    const owned = ownedPoliciesOf(primary, hostname);
    const live = owned[0] ?? null;
    for (const p of owned) usedPolicyIds.add(p.id);
    const policyChanged = live ? !policyMatches(live, policy) : true;
    const appChanged = !live || !appMatches(primary, app, live.id);
    if (policyChanged || appChanged) {
      ensure.push({
        kind: 'access.update',
        hostname,
        appId: primary.id,
        app,
        appChanged,
        policy,
        policyId: live?.id ?? null,
        policyChanged,
        hostIds: d.hostIds,
      });
    }
    for (const dup of duplicates) {
      remove.push({ kind: 'access.delete', hostname, appId: dup.id, policyIds: [] });
    }
  }

  /* ---- Burrow applications whose hostname is no longer protected ---- */
  for (const app of actual.apps) {
    if (!isOwnedAccessResource(app) || keptAppIds.has(app.id)) continue;
    const hostnames = appHostnames(app);
    const hostname = hostnames[0] ?? lc(app.domain ?? app.name);
    if (!hostnames.some((h) => managed.has(h) && inScope(h))) continue;
    if (hostnames.some((h) => wanted.has(h))) continue;
    const policyIds = ownedPoliciesOf(app, hostname)
      .map((p) => p.id)
      .filter((id) => !usedPolicyIds.has(id));
    for (const id of policyIds) usedPolicyIds.add(id);
    remove.push({ kind: 'access.delete', hostname, appId: app.id, policyIds });
  }

  /* ---- Orphan Burrow policies (full run only) ---- */
  if (!opts.scope) {
    const linkedAnywhere = new Set(actual.apps.flatMap((a) => (a.policies ?? []).map((l) => l.id)));
    for (const p of actual.policies) {
      if (!isOwnedAccessResource(p) || usedPolicyIds.has(p.id) || linkedAnywhere.has(p.id))
        continue;
      if ((p.app_count ?? 0) > 0) continue;
      const hostname = p.name.slice(ACCESS_OWNERSHIP_PREFIX.length);
      if (!managed.has(hostname) || wanted.has(hostname)) continue;
      remove.push({ kind: 'access.delete', hostname, appId: null, policyIds: [p.id] });
    }
  }

  return { ensure, remove, conflicts };
}
