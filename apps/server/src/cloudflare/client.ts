import type { Logger } from 'pino';
import { AppError } from '../lib/errors.js';
import { sleep } from '../lib/time.js';
import type {
  CfAccessApp,
  CfAccessAppInput,
  CfAccessPolicy,
  CfAccessPolicyInput,
  CfAccount,
  CfConnector,
  CfDnsRecord,
  CfDnsRecordInput,
  CfEnvelope,
  CfMessage,
  CfResultInfo,
  CfTokenVerify,
  CfTunnel,
  CfTunnelConfig,
  CfTunnelConfiguration,
  CfZone,
} from './types.js';

type Query = Record<string, string | number | boolean | undefined>;

export interface CloudflareClientOptions {
  token: string;
  /** API base, e.g. `https://api.cloudflare.com/client/v4`. */
  baseUrl: string;
  logger?: Logger;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retries on 429/5xx/network errors (default 3). */
  maxRetries?: number;
  /** First backoff delay in ms, doubled each retry (default 500). */
  retryBaseMs?: number;
  /** Per-request timeout in ms (default 20 s). */
  timeoutMs?: number;
}

/**
 * Error raised for any failed Cloudflare call. It is an {@link AppError} so
 * routes can return it directly; `httpStatus` and `cfErrors` keep the raw
 * details for callers that need them (e.g. detecting a deleted tunnel).
 */
export class CloudflareApiError extends AppError {
  constructor(
    code: 'CLOUDFLARE_TOKEN_INVALID' | 'CLOUDFLARE_PERMISSION_MISSING' | 'CLOUDFLARE_API_ERROR',
    message: string,
    public readonly httpStatus: number,
    public readonly cfErrors: CfMessage[] = [],
    public readonly endpoint = '',
  ) {
    super(code, message, code === 'CLOUDFLARE_API_ERROR' ? 502 : 400, {
      httpStatus,
      endpoint,
      errors: cfErrors,
    });
    this.name = 'CloudflareApiError';
  }

  get isNotFound(): boolean {
    return this.httpStatus === 404;
  }
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/**
 * A small typed wrapper around the Cloudflare REST API.
 *
 * - Unwraps the `{ success, errors, result }` envelope.
 * - Maps 401 to `CLOUDFLARE_TOKEN_INVALID` and 403 to `CLOUDFLARE_PERMISSION_MISSING`.
 * - Retries 429 and 5xx responses with exponential backoff (honours `Retry-After`).
 * - Never logs the token, request bodies or response bodies.
 */
export class CloudflareClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;

  constructor(opts: CloudflareClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /* ---------------------------------------------------------------- */
  /* Generic request helpers                                           */
  /* ---------------------------------------------------------------- */

  /** Perform a request and return the unwrapped envelope. */
  async requestEnvelope<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<CfEnvelope<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const endpoint = `${method} ${path}`;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json',
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt, null, endpoint, 'network error');
          continue;
        }
        throw new CloudflareApiError(
          'CLOUDFLARE_API_ERROR',
          `Could not reach the Cloudflare API (${err instanceof Error ? err.message : String(err)})`,
          0,
          [],
          endpoint,
        );
      }

      this.logger?.debug({ endpoint, status: res.status, attempt }, 'cloudflare api call');

      if (RETRYABLE(res.status) && attempt < this.maxRetries) {
        await res.body?.cancel().catch(() => undefined);
        await this.backoff(attempt, res.headers.get('retry-after'), endpoint, `HTTP ${res.status}`);
        continue;
      }

      let envelope: CfEnvelope<T> | undefined;
      try {
        envelope = (await res.json()) as CfEnvelope<T>;
      } catch {
        envelope = undefined;
      }

      if (res.ok && envelope?.success !== false && envelope) return envelope;
      throw this.toError(res.status, envelope?.errors ?? [], endpoint);
    }
  }

  /** Perform a request and return `result`. */
  async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    return (await this.requestEnvelope<T>(method, path, opts)).result;
  }

  /**
   * Run a query on the GraphQL Analytics API (`POST /graphql`). GraphQL
   * answers 200 with an `errors` list: authorization errors become
   * `CLOUDFLARE_PERMISSION_MISSING`, others `CLOUDFLARE_API_ERROR`.
   */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = (await this.requestEnvelope<unknown>('POST', '/graphql', {
      body: { query, variables },
    })) as unknown as {
      data?: T | null;
      errors?: Array<{ message: string; extensions?: { code?: string } }> | null;
    };
    const list = res.errors ?? [];
    if (list.length > 0 || !res.data) {
      const detail = list.map((e) => e.message).join('; ') || 'empty response';
      const denied = list.some((e) =>
        /authz|not authori[sz]ed|permission|access denied/i.test(
          `${e.extensions?.code ?? ''} ${e.message}`,
        ),
      );
      throw new CloudflareApiError(
        denied ? 'CLOUDFLARE_PERMISSION_MISSING' : 'CLOUDFLARE_API_ERROR',
        denied
          ? `The API token cannot read analytics. Add the "Zone › Analytics › Read" permission to it. (${detail})`
          : `Cloudflare Analytics API error: ${detail}`,
        200,
        list.map((e) => ({ code: 0, message: e.message })),
        'POST /graphql',
      );
    }
    return res.data;
  }

  /** Fetch every page of a paginated list endpoint. */
  async paginate<T>(path: string, query: Query = {}, perPage = 50): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const env = await this.requestEnvelope<T[]>('GET', path, {
        query: { ...query, page, per_page: perPage },
      });
      const result = env.result ?? [];
      items.push(...result);
      if (!hasMorePages(env.result_info, page, result.length, perPage)) break;
    }
    return items;
  }

  private async backoff(attempt: number, retryAfter: string | null, endpoint: string, why: string) {
    const fromHeader = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
    const delay = Math.min(Math.max(fromHeader, this.retryBaseMs * 2 ** attempt), 30_000);
    this.logger?.warn(
      { endpoint, attempt: attempt + 1, delayMs: delay },
      `cloudflare api ${why}, retrying`,
    );
    await sleep(delay);
  }

  private toError(status: number, cfErrors: CfMessage[], endpoint: string): CloudflareApiError {
    const detail = cfErrors.map((e) => `${e.message} (${e.code})`).join('; ');
    if (status === 401) {
      return new CloudflareApiError(
        'CLOUDFLARE_TOKEN_INVALID',
        'Cloudflare rejected the API token. Check that it is correct and still active.',
        status,
        cfErrors,
        endpoint,
      );
    }
    if (status === 403) {
      return new CloudflareApiError(
        'CLOUDFLARE_PERMISSION_MISSING',
        `The API token is missing a permission for ${endpoint}${detail ? `: ${detail}` : ''}`,
        status,
        cfErrors,
        endpoint,
      );
    }
    return new CloudflareApiError(
      'CLOUDFLARE_API_ERROR',
      `Cloudflare API error on ${endpoint} (HTTP ${status})${detail ? `: ${detail}` : ''}`,
      status,
      cfErrors,
      endpoint,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Tokens, accounts, zones                                           */
  /* ---------------------------------------------------------------- */

  /** Verify a user-owned API token. */
  verifyUserToken(): Promise<CfTokenVerify> {
    return this.request('GET', '/user/tokens/verify');
  }

  /** Verify an account-owned API token. */
  verifyAccountToken(accountId: string): Promise<CfTokenVerify> {
    return this.request('GET', `/accounts/${accountId}/tokens/verify`);
  }

  listAccounts(): Promise<CfAccount[]> {
    return this.paginate<CfAccount>('/accounts');
  }

  listZones(): Promise<CfZone[]> {
    return this.paginate<CfZone>('/zones');
  }

  /* ---------------------------------------------------------------- */
  /* Tunnels                                                           */
  /* ---------------------------------------------------------------- */

  listTunnels(accountId: string, query: { name?: string } = {}): Promise<CfTunnel[]> {
    return this.paginate<CfTunnel>(`/accounts/${accountId}/cfd_tunnel`, {
      is_deleted: false,
      name: query.name,
    });
  }

  /** Create a remotely managed tunnel (`config_src: cloudflare`). */
  createTunnel(accountId: string, name: string): Promise<CfTunnel> {
    return this.request('POST', `/accounts/${accountId}/cfd_tunnel`, {
      body: { name, config_src: 'cloudflare' },
    });
  }

  getTunnel(accountId: string, tunnelId: string): Promise<CfTunnel> {
    return this.request('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
  }

  /** The token `cloudflared tunnel run` needs. Never store or log it. */
  getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    return this.request('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
  }

  getTunnelConfiguration(accountId: string, tunnelId: string): Promise<CfTunnelConfiguration> {
    return this.request('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`);
  }

  /** Replace the whole tunnel configuration document. */
  putTunnelConfiguration(
    accountId: string,
    tunnelId: string,
    config: CfTunnelConfig,
  ): Promise<CfTunnelConfiguration> {
    return this.request('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      body: { config },
    });
  }

  /** Permanent. Cloudflare refuses while connectors are still connected. */
  deleteTunnel(accountId: string, tunnelId: string): Promise<CfTunnel> {
    return this.request('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
  }

  /** Remove stale connections (e.g. right after stopping cloudflared, before deleting). */
  cleanupTunnelConnections(accountId: string, tunnelId: string): Promise<unknown> {
    return this.request('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`);
  }

  listTunnelConnections(accountId: string, tunnelId: string): Promise<CfConnector[]> {
    return this.request('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`);
  }

  /* ---------------------------------------------------------------- */
  /* DNS                                                               */
  /* ---------------------------------------------------------------- */

  /** List DNS records, e.g. `{ 'name.exact': 'app.example.com' }`. */
  listDnsRecords(zoneId: string, query: Query = {}): Promise<CfDnsRecord[]> {
    return this.paginate<CfDnsRecord>(`/zones/${zoneId}/dns_records`, query, 100);
  }

  createDnsRecord(zoneId: string, record: CfDnsRecordInput): Promise<CfDnsRecord> {
    return this.request('POST', `/zones/${zoneId}/dns_records`, { body: record });
  }

  updateDnsRecord(
    zoneId: string,
    recordId: string,
    record: Partial<CfDnsRecordInput>,
  ): Promise<CfDnsRecord> {
    return this.request('PATCH', `/zones/${zoneId}/dns_records/${recordId}`, { body: record });
  }

  deleteDnsRecord(zoneId: string, recordId: string): Promise<{ id: string }> {
    return this.request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  }

  /* ---------------------------------------------------------------- */
  /* Access (Zero Trust): applications and reusable policies           */
  /* Permission: Account › Access: Apps and Policies › Edit            */
  /* ---------------------------------------------------------------- */

  listAccessApps(accountId: string): Promise<CfAccessApp[]> {
    return this.paginate<CfAccessApp>(`/accounts/${accountId}/access/apps`);
  }

  createAccessApp(accountId: string, app: CfAccessAppInput): Promise<CfAccessApp> {
    return this.request('POST', `/accounts/${accountId}/access/apps`, { body: app });
  }

  /** Replace an application (PUT needs the full body). */
  updateAccessApp(accountId: string, appId: string, app: CfAccessAppInput): Promise<CfAccessApp> {
    return this.request('PUT', `/accounts/${accountId}/access/apps/${appId}`, { body: app });
  }

  deleteAccessApp(accountId: string, appId: string): Promise<{ id: string }> {
    return this.request('DELETE', `/accounts/${accountId}/access/apps/${appId}`);
  }

  listAccessPolicies(accountId: string): Promise<CfAccessPolicy[]> {
    return this.paginate<CfAccessPolicy>(`/accounts/${accountId}/access/policies`);
  }

  createAccessPolicy(accountId: string, policy: CfAccessPolicyInput): Promise<CfAccessPolicy> {
    return this.request('POST', `/accounts/${accountId}/access/policies`, { body: policy });
  }

  updateAccessPolicy(
    accountId: string,
    policyId: string,
    policy: CfAccessPolicyInput,
  ): Promise<CfAccessPolicy> {
    return this.request('PUT', `/accounts/${accountId}/access/policies/${policyId}`, {
      body: policy,
    });
  }

  /** Fails while an application still uses the policy: delete the application first. */
  deleteAccessPolicy(accountId: string, policyId: string): Promise<{ id: string }> {
    return this.request('DELETE', `/accounts/${accountId}/access/policies/${policyId}`);
  }
}

function hasMorePages(
  info: CfResultInfo | undefined,
  page: number,
  got: number,
  perPage: number,
): boolean {
  if (info?.total_pages !== undefined) return page < info.total_pages;
  return got >= perPage;
}
