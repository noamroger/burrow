/**
 * Pure helpers for tunnel ingress rules. No I/O here: everything is unit tested.
 *
 * cloudflared evaluates ingress rules top to bottom and uses the first match,
 * so order matters:
 *   1. rules with a concrete hostname, alphabetically; for the same hostname,
 *      rules with a path come first (longest path first), then the path-less rule;
 *   2. wildcard hostnames (`*.example.com`), same ordering inside;
 *   3. hostname-less rules that only match a path (foreign rules, kept as-is);
 *   4. the mandatory catch-all (no hostname, no path), always last.
 */
import type { CfIngressRule, CfOriginRequest } from '../cloudflare/types.js';

/** The catch-all Burrow writes when the configuration has none. */
export const DEFAULT_CATCH_ALL: CfIngressRule = { service: 'http_status:404' };

/** What Burrow needs from a host to build its ingress rule. */
export interface IngressHost {
  hostname: string;
  path: string;
  service: string;
  noTlsVerify: boolean;
  httpHostHeader: string;
  originServerName: string;
  /** Other `originRequest` keys kept from an imported route. */
  originRequestExtra?: Record<string, unknown>;
}

/** Stable identity of a rule: `hostname|path`. */
export function ruleKey(hostname: string | undefined, path: string | undefined): string {
  return `${(hostname ?? '').toLowerCase()}|${path ?? ''}`;
}

/** Identity of an existing ingress rule. */
export function keyOfRule(rule: CfIngressRule): string {
  return ruleKey(rule.hostname, rule.path);
}

/** Build the ingress rule for a host. Empty options are omitted. */
export function buildIngressRule(host: IngressHost): CfIngressRule {
  const rule: CfIngressRule = { hostname: host.hostname, service: host.service };
  if (host.path) rule.path = host.path;
  const originRequest: CfOriginRequest = { ...(host.originRequestExtra ?? {}) };
  delete originRequest.noTLSVerify;
  delete originRequest.httpHostHeader;
  delete originRequest.originServerName;
  if (host.noTlsVerify) originRequest.noTLSVerify = true;
  if (host.httpHostHeader) originRequest.httpHostHeader = host.httpHostHeader;
  if (host.originServerName) originRequest.originServerName = host.originServerName;
  if (Object.keys(originRequest).length > 0) rule.originRequest = originRequest;
  return rule;
}

/** A catch-all matches every request: no hostname and no path. */
export function isCatchAll(rule: CfIngressRule): boolean {
  return !rule.hostname && !rule.path;
}

function group(rule: CfIngressRule): number {
  if (!rule.hostname) return 2;
  return rule.hostname.includes('*') ? 1 : 0;
}

function compareRules(a: CfIngressRule, b: CfIngressRule): number {
  const ga = group(a);
  const gb = group(b);
  if (ga !== gb) return ga - gb;
  if (ga === 2) return 0; // keep foreign path-only rules in their original order
  const ha = a.hostname!.toLowerCase();
  const hb = b.hostname!.toLowerCase();
  if (ha !== hb) return ha < hb ? -1 : 1;
  const pa = a.path ?? '';
  const pb = b.path ?? '';
  if (!pa !== !pb) return pa ? -1 : 1; // path-specific before path-less
  return pb.length - pa.length; // longer (more specific) path first
}

/**
 * Sort rules into evaluation order and make sure exactly one catch-all ends
 * the list. An existing catch-all is preserved; otherwise `http_status:404`.
 */
export function orderIngress(rules: CfIngressRule[]): CfIngressRule[] {
  const catchAlls = rules.filter(isCatchAll);
  const others = rules.filter((r) => !isCatchAll(r));
  const sorted = others
    .map((rule, index) => ({ rule, index }))
    .sort((x, y) => compareRules(x.rule, y.rule) || x.index - y.index)
    .map((x) => x.rule);
  const catchAll = catchAlls[catchAlls.length - 1] ?? DEFAULT_CATCH_ALL;
  return [...sorted, catchAll];
}

/**
 * Merge Burrow's desired rules into the live configuration.
 *
 * Rules whose key is in `ownedKeys` (rules Burrow wrote before) or matches a
 * desired rule are replaced; every other rule is a foreign rule and is kept
 * untouched.
 */
export function mergeIngress(
  current: CfIngressRule[],
  desired: CfIngressRule[],
  ownedKeys: Iterable<string>,
): CfIngressRule[] {
  const owned = new Set(ownedKeys);
  for (const rule of desired) owned.add(keyOfRule(rule));
  const foreign = current.filter((r) => isCatchAll(r) || !owned.has(keyOfRule(r)));
  return orderIngress([...foreign, ...desired]);
}

/** Drop fields Cloudflare may add or omit (empty `originRequest`, empty `path`). */
export function normalizeRule(rule: CfIngressRule): CfIngressRule {
  const out: CfIngressRule = { ...rule };
  if (!out.path) delete out.path;
  if (!out.hostname) delete out.hostname;
  if (out.originRequest && Object.keys(out.originRequest).length === 0) delete out.originRequest;
  return out;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Semantic equality of two ingress lists (order matters, key order does not). */
export function ingressEqual(a: CfIngressRule[], b: CfIngressRule[]): boolean {
  return stableStringify(a.map(normalizeRule)) === stableStringify(b.map(normalizeRule));
}
