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
