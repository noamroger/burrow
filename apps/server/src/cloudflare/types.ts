/**
 * Subset of the Cloudflare API v4 types Burrow uses.
 * See docs/cloudflare-api.md for the endpoints and the date they were checked.
 */

export interface CfMessage {
  code: number;
  message: string;
}

/** Every Cloudflare API response is wrapped in this envelope. */
export interface CfEnvelope<T> {
  success: boolean;
  errors: CfMessage[];
  messages: CfMessage[];
  result: T;
  result_info?: CfResultInfo;
}

export interface CfResultInfo {
  page?: number;
  per_page?: number;
  count?: number;
  total_count?: number;
  total_pages?: number;
}

export interface CfTokenVerify {
  id: string;
  status: 'active' | 'disabled' | 'expired' | string;
  expires_on?: string;
}

export interface CfAccount {
  id: string;
  name: string;
}

export interface CfZone {
  id: string;
  name: string;
  status?: string;
  account?: { id: string; name: string };
}

export type CfTunnelStatus = 'inactive' | 'degraded' | 'healthy' | 'down';

export interface CfTunnel {
  id: string;
  name: string;
  status: CfTunnelStatus;
  config_src?: 'local' | 'cloudflare';
  created_at: string;
  deleted_at?: string | null;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
}

/** Per-rule origin settings understood by cloudflared. */
export interface CfOriginRequest {
  noTLSVerify?: boolean;
  httpHostHeader?: string;
  originServerName?: string;
  [key: string]: unknown;
}

/** One ingress rule of a remotely managed tunnel. */
export interface CfIngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: CfOriginRequest;
  [key: string]: unknown;
}

export interface CfTunnelConfig {
  ingress?: CfIngressRule[];
  originRequest?: CfOriginRequest;
  [key: string]: unknown;
}

export interface CfTunnelConfiguration {
  tunnel_id: string;
  version: number;
  config: CfTunnelConfig | null;
  source?: string;
}

export interface CfConnection {
  colo_name: string;
  opened_at: string;
  origin_ip: string;
  client_version?: string;
  id?: string;
}

export interface CfConnector {
  id: string;
  arch: string;
  version: string;
  run_at?: string | null;
  config_version?: number;
  conns: CfConnection[];
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
  zone_id?: string;
}

export interface CfDnsRecordInput {
  type: 'CNAME';
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string;
}

/* ---- Cloudflare Access (Zero Trust) ---- */

/** One rule of an Access policy, e.g. `{ email: { email } }` or `{ email_domain: { domain } }`. */
export type CfAccessRule =
  { email: { email: string } } | { email_domain: { domain: string } } | Record<string, unknown>;

/** A reusable Access policy (`/accounts/{id}/access/policies`). */
export interface CfAccessPolicy {
  id: string;
  name: string;
  decision: 'allow' | 'deny' | 'non_identity' | 'bypass' | string;
  include: CfAccessRule[];
  exclude?: CfAccessRule[];
  require?: CfAccessRule[];
  session_duration?: string;
  app_count?: number;
  reusable?: boolean;
}

export interface CfAccessPolicyInput {
  name: string;
  decision: 'allow';
  include: CfAccessRule[];
  exclude: CfAccessRule[];
  require: CfAccessRule[];
}

export interface CfAccessDestination {
  type: 'public' | 'private' | string;
  uri?: string;
  [key: string]: unknown;
}

/** An Access application (`/accounts/{id}/access/apps`). Only the fields Burrow reads. */
export interface CfAccessApp {
  id: string;
  name: string;
  type: string;
  domain?: string;
  destinations?: CfAccessDestination[];
  session_duration?: string;
  aud?: string;
  policies?: Array<{ id: string; precedence?: number; name?: string }>;
}

/** Body Burrow sends to create or replace a self-hosted application. */
export interface CfAccessAppInput {
  name: string;
  type: 'self_hosted' | 'ssh' | 'vnc';
  domain: string;
  destinations: Array<{ type: 'public'; uri: string }>;
  session_duration: string;
  app_launcher_visible: boolean;
  policies: Array<{ id: string; precedence: number }>;
}
