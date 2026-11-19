/**
 * An in-memory fake of the Cloudflare API endpoints Burrow uses.
 *
 * Used by the test suite and by `pnpm --filter @burrow/server mock:cf`, so the
 * whole app can run locally (or in the Docker image) without a Cloudflare
 * account. It mimics the v4 envelope, pagination and the error codes Burrow
 * relies on; it is not a full emulator.
 *
 * Tokens: any token of 20+ characters is accepted, except tokens containing
 * `invalid` (401), `noperm` (403 on tunnel endpoints), `noaccess` (403 on
 * Access endpoints) or `noanalytics` (GraphQL authorization error).
 *
 * `POST /graphql` answers the few Analytics queries Burrow sends with
 * deterministic, made-up traffic (a daily wave per hostname).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockZone {
  id: string;
  name: string;
}
export interface MockDnsRecord {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string | null;
}
export interface MockTunnel {
  id: string;
  name: string;
  status: 'inactive' | 'degraded' | 'healthy' | 'down';
  config_src: 'cloudflare' | 'local';
  created_at: string;
  deleted_at: string | null;
  config: { ingress?: Array<Record<string, unknown>>; [k: string]: unknown } | null;
  version: number;
}

export interface MockAccessPolicy {
  id: string;
  name: string;
  decision: string;
  include: Array<Record<string, unknown>>;
  exclude: Array<Record<string, unknown>>;
  require: Array<Record<string, unknown>>;
}
export interface MockAccessApp {
  id: string;
  aud: string;
  name: string;
  type: string;
  domain: string;
  destinations: Array<{ type: string; uri?: string }>;
  session_duration: string;
  app_launcher_visible: boolean;
  /** Linked reusable policy ids, in precedence order. */
  policyIds: string[];
}

export interface MockState {
  accounts: Array<{ id: string; name: string }>;
  zones: MockZone[];
  tunnels: MockTunnel[];
  dns: MockDnsRecord[];
  accessApps: MockAccessApp[];
  accessPolicies: MockAccessPolicy[];
  requests: Array<{ method: string; path: string }>;
}

interface Failure {
  method: string;
  pattern: RegExp;
  status: number;
  times: number;
  message: string;
}

const hex32 = (seed: string) => createHash('md5').update(seed).digest('hex');

export const MOCK_ACCOUNT_ID = hex32('account-1');
export const MOCK_ZONES: MockZone[] = [
  { id: hex32('zone-example.com'), name: 'example.com' },
  { id: hex32('zone-example.org'), name: 'example.org' },
];

export function initialState(): MockState {
  return {
    accounts: [{ id: MOCK_ACCOUNT_ID, name: 'Mock Account' }],
    zones: MOCK_ZONES.map((z) => ({ ...z })),
    tunnels: [],
    dns: [],
    accessApps: [],
    accessPolicies: [],
    requests: [],
  };
}

export class MockCloudflare {
  readonly state: MockState = initialState();
  private server: Server | null = null;
  private failures: Failure[] = [];

  /** Base URL to use as CLOUDFLARE_API_BASE (available after `listen`). */
  url = '';

  /** Make the next `times` matching requests fail with `status`. */
  failNext(
    method: string,
    pattern: RegExp,
    status: number,
    times = 1,
    message = 'Simulated failure',
  ): void {
    this.failures.push({ method, pattern, status, times, message });
  }

  /** Add a DNS record directly (e.g. a foreign record to test conflicts). */
  addDnsRecord(record: Partial<MockDnsRecord> & { zone_id: string; name: string }): MockDnsRecord {
    const full: MockDnsRecord = {
      id: hex32(randomUUID()),
      type: 'A',
      content: '192.0.2.1',
      proxied: false,
      ttl: 1,
      comment: null,
      ...record,
    };
    this.state.dns.push(full);
    return full;
  }

  /** Add a tunnel directly (e.g. an existing tunnel to import). */
  addTunnel(tunnel: Partial<MockTunnel> & { name: string }): MockTunnel {
    const full: MockTunnel = {
      id: randomUUID(),
      status: 'healthy',
      config_src: 'cloudflare',
      created_at: new Date().toISOString(),
      deleted_at: null,
      config: null,
      version: 1,
      ...tunnel,
    };
    this.state.tunnels.push(full);
    return full;
  }

  /** Add an Access application directly (e.g. a foreign one to test conflicts). */
  addAccessApp(app: Partial<MockAccessApp> & { name: string; domain: string }): MockAccessApp {
    const full: MockAccessApp = {
      id: randomUUID(),
      aud: hex32(randomUUID()) + hex32(randomUUID()),
      type: 'self_hosted',
      destinations: [{ type: 'public', uri: app.domain }],
      session_duration: '24h',
      app_launcher_visible: true,
      policyIds: [],
      ...app,
    };
    this.state.accessApps.push(full);
    return full;
  }

  reset(): void {
    Object.assign(this.state, initialState());
    this.failures = [];
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        send(res, 500, envelope(null, false, [{ code: 10000, message: String(err) }]));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address() as AddressInfo;
    this.url = `http://${host}:${addr.port}/client/v4`;
    return this.url;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const method = req.method ?? 'GET';
    this.state.requests.push({ method, path });

    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (token.length < 20 || token.includes('invalid')) {
      return send(res, 401, envelope(null, false, [{ code: 1000, message: 'Invalid API Token' }]));
    }

    const failure = this.failures.find(
      (f) => f.method === method && f.pattern.test(path) && f.times > 0,
    );
    if (failure) {
      failure.times--;
      this.failures = this.failures.filter((f) => f.times > 0);
      return send(
        res,
        failure.status,
        envelope(null, false, [{ code: 10001, message: failure.message }]),
      );
    }

    const body = method === 'GET' || method === 'DELETE' ? undefined : await readJson(req);
    const q = url.searchParams;
    const s = this.state;
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/user/tokens/verify') {
      if (token.includes('account')) {
        return send(
          res,
          401,
          envelope(null, false, [{ code: 1000, message: 'Invalid API Token' }]),
        );
      }
      return send(res, 200, envelope({ id: hex32(token), status: 'active' }));
    }
    if (method === 'GET' && (m = /^\/accounts\/([^/]+)\/tokens\/verify$/.exec(path))) {
      if (!s.accounts.some((a) => a.id === m![1])) return notFound(res);
      return send(res, 200, envelope({ id: hex32(token), status: 'active' }));
    }
    if (method === 'GET' && path === '/accounts') return paginate(res, s.accounts, q);
    if (method === 'GET' && path === '/zones') {
      return paginate(
        res,
        s.zones.map((z) => ({ ...z, status: 'active', account: s.accounts[0] })),
        q,
      );
    }

    /* ---------------- analytics (GraphQL) ---------------- */
    if (method === 'POST' && path === '/graphql') {
      return send(res, 200, mockAnalytics(token, body as GraphqlBody | undefined, s.zones));
    }

    /* ---------------- tunnels ---------------- */
    if (
      (m =
        /^\/accounts\/([^/]+)\/cfd_tunnel(?:\/([^/]+))?(?:\/(token|configurations|connections))?$/.exec(
          path,
        ))
    ) {
      const [, accountId, tunnelId, sub] = m;
      if (!s.accounts.some((a) => a.id === accountId)) return notFound(res);
      if (token.includes('noperm')) {
        return send(
          res,
          403,
          envelope(null, false, [{ code: 10000, message: 'Authentication error' }]),
        );
      }
      if (!tunnelId) {
        if (method === 'GET') {
          let list = s.tunnels;
          if (q.get('is_deleted') === 'false') list = list.filter((t) => !t.deleted_at);
          if (q.get('name')) list = list.filter((t) => t.name === q.get('name'));
          return paginate(res, list.map(publicTunnel), q);
        }
        if (method === 'POST') {
          const b = body as { name?: string; config_src?: 'cloudflare' | 'local' };
          if (!b?.name) return badRequest(res, 'name is required');
          if (s.tunnels.some((t) => t.name === b.name && !t.deleted_at)) {
            return badRequest(res, 'tunnel with name already exists', 1013);
          }
          const tunnel: MockTunnel = {
            id: randomUUID(),
            name: b.name,
            status: 'inactive',
            config_src: b.config_src ?? 'local',
            created_at: new Date().toISOString(),
            deleted_at: null,
            config: null,
            version: 0,
          };
          s.tunnels.push(tunnel);
          return send(res, 200, envelope(publicTunnel(tunnel)));
        }
      }
      const tunnel = s.tunnels.find((t) => t.id === tunnelId && !t.deleted_at);
      if (!tunnel) return notFound(res, 'Tunnel not found');
      if (!sub) {
        if (method === 'GET') return send(res, 200, envelope(publicTunnel(tunnel)));
        if (method === 'DELETE') {
          tunnel.deleted_at = new Date().toISOString();
          return send(res, 200, envelope(publicTunnel(tunnel)));
        }
      }
      if (sub === 'token' && method === 'GET') {
        const runToken = Buffer.from(
          JSON.stringify({ a: accountId, t: tunnel.id, s: randomBytes(32).toString('base64') }),
        ).toString('base64');
        return send(res, 200, envelope(runToken));
      }
      if (sub === 'configurations') {
        if (method === 'GET') {
          return send(
            res,
            200,
            envelope({
              tunnel_id: tunnel.id,
              version: tunnel.version,
              config: tunnel.config,
              source: 'cloudflare',
            }),
          );
        }
        if (method === 'PUT') {
          const config = (body as { config?: MockTunnel['config'] })?.config;
          const ingress = config?.ingress ?? [];
          const last = ingress[ingress.length - 1];
          if (ingress.length > 0 && (!last || last.hostname || last.path)) {
            return badRequest(
              res,
              'The last ingress rule must match all URLs (no hostname or path)',
              1056,
            );
          }
          tunnel.config = config ?? null;
          tunnel.version++;
          return send(
            res,
            200,
            envelope({
              tunnel_id: tunnel.id,
              version: tunnel.version,
              config: tunnel.config,
              source: 'cloudflare',
            }),
          );
        }
      }
      if (sub === 'connections' && method === 'DELETE') {
        return send(res, 200, envelope(null));
      }
      if (sub === 'connections' && method === 'GET') {
        return send(
          res,
          200,
          envelope([
            {
              id: hex32(`connector-${tunnel.id}`),
              arch: 'linux_amd64',
              version: '2026.11.0',
              run_at: tunnel.created_at,
              config_version: tunnel.version,
              conns: [
                {
                  colo_name: 'cdg01',
                  opened_at: tunnel.created_at,
                  origin_ip: '203.0.113.10',
                  client_version: '2026.11.0',
                },
              ],
            },
          ]),
        );
      }
    }

    /* ---------------- Access (Zero Trust) ---------------- */
    if ((m = /^\/accounts\/([^/]+)\/access\/(apps|policies)(?:\/([^/]+))?$/.exec(path))) {
      const [, accountId, kind, id] = m;
      if (!s.accounts.some((a) => a.id === accountId)) return notFound(res);
      if (token.includes('noaccess')) {
        return send(
          res,
          403,
          envelope(null, false, [{ code: 10000, message: 'Authentication error' }]),
        );
      }
      return kind === 'apps'
        ? this.handleAccessApps(res, method, id, body, q)
        : this.handleAccessPolicies(res, method, id, body, q);
    }

    /* ---------------- DNS ---------------- */
    if ((m = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path))) {
      const [, zoneId, recordId] = m;
      const zone = s.zones.find((z) => z.id === zoneId);
      if (!zone) return notFound(res, 'Zone not found');
      if (!recordId && method === 'GET') {
        let list = s.dns.filter((r) => r.zone_id === zoneId);
        if (q.get('type')) list = list.filter((r) => r.type === q.get('type'));
        if (q.get('name.exact'))
          list = list.filter((r) => r.name === q.get('name.exact')!.toLowerCase());
        if (q.get('name')) list = list.filter((r) => r.name === q.get('name')!.toLowerCase());
        if (q.get('comment.startswith')) {
          list = list.filter((r) => (r.comment ?? '').startsWith(q.get('comment.startswith')!));
        }
        return paginate(res, list, q);
      }
      if (!recordId && method === 'POST') {
        const b = body as Partial<MockDnsRecord>;
        if (!b?.name || !b.type || !b.content)
          return badRequest(res, 'type, name and content are required', 9005);
        const name = b.name.toLowerCase();
        if (s.dns.some((r) => r.zone_id === zoneId && r.name === name)) {
          return badRequest(
            res,
            'An A, AAAA, or CNAME record with that host already exists.',
            81053,
          );
        }
        const record = this.addDnsRecord({
          zone_id: zoneId!,
          name,
          type: b.type,
          content: b.content,
          proxied: b.proxied ?? false,
          ttl: b.ttl ?? 1,
          comment: b.comment ?? null,
        });
        return send(res, 200, envelope(record));
      }
      const record = s.dns.find((r) => r.id === recordId && r.zone_id === zoneId);
      if (!record) return notFound(res, 'Record not found');
      if (method === 'PATCH') {
        Object.assign(record, body as Partial<MockDnsRecord>, {
          id: record.id,
          zone_id: record.zone_id,
        });
        record.name = record.name.toLowerCase();
        return send(res, 200, envelope(record));
      }
      if (method === 'DELETE') {
        s.dns = s.dns.filter((r) => r !== record);
        return send(res, 200, envelope({ id: record.id }));
      }
    }

    return notFound(res, `No mock for ${method} ${path}`);
  }

  private handleAccessApps(
    res: ServerResponse,
    method: string,
    id: string | undefined,
    body: unknown,
    q: URLSearchParams,
  ): void {
    const s = this.state;
    const render = (a: MockAccessApp) => publicAccessApp(a, s.accessPolicies);
    if (!id && method === 'GET') return paginate(res, s.accessApps.map(render), q);

    const parse = (): Omit<MockAccessApp, 'id' | 'aud'> | string => {
      const b = body as Partial<MockAccessApp> & {
        policies?: Array<string | { id: string; precedence?: number }>;
      };
      if (!b?.domain || !b.type) return 'domain and type are required';
      const links = (b.policies ?? [])
        .map((p) => (typeof p === 'string' ? { id: p, precedence: 0 } : p))
        .sort((x, y) => (x.precedence ?? 0) - (y.precedence ?? 0));
      if (links.some((l) => !s.accessPolicies.some((p) => p.id === l.id))) {
        return 'policy not found';
      }
      return {
        name: b.name ?? b.domain,
        type: b.type,
        domain: b.domain,
        destinations: b.destinations ?? [{ type: 'public', uri: b.domain }],
        session_duration: b.session_duration ?? '24h',
        app_launcher_visible: b.app_launcher_visible ?? true,
        policyIds: links.map((l) => l.id),
      };
    };

    if (!id && method === 'POST') {
      const parsed = parse();
      if (typeof parsed === 'string') return badRequest(res, parsed, 12130);
      const domain = parsed.domain.toLowerCase();
      if (s.accessApps.some((a) => a.domain.toLowerCase() === domain)) {
        return badRequest(res, 'access.api.error.conflict: application already exists', 12130);
      }
      return send(res, 200, envelope(render(this.addAccessApp(parsed))));
    }
    const app = s.accessApps.find((a) => a.id === id);
    if (!app) return notFound(res, 'Access application not found');
    if (method === 'GET') return send(res, 200, envelope(render(app)));
    if (method === 'PUT') {
      const parsed = parse();
      if (typeof parsed === 'string') return badRequest(res, parsed, 12130);
      Object.assign(app, parsed);
      return send(res, 200, envelope(render(app)));
    }
    if (method === 'DELETE') {
      s.accessApps = s.accessApps.filter((a) => a !== app);
      return send(res, 200, envelope({ id: app.id }));
    }
    return notFound(res);
  }

  private handleAccessPolicies(
    res: ServerResponse,
    method: string,
    id: string | undefined,
    body: unknown,
    q: URLSearchParams,
  ): void {
    const s = this.state;
    const appCount = (p: MockAccessPolicy) =>
      s.accessApps.filter((a) => a.policyIds.includes(p.id)).length;
    const render = (p: MockAccessPolicy) => ({ ...p, app_count: appCount(p), reusable: true });
    if (!id && method === 'GET') return paginate(res, s.accessPolicies.map(render), q);

    const parse = (): Omit<MockAccessPolicy, 'id'> | string => {
      const b = body as Partial<MockAccessPolicy>;
      if (!b?.name || !b.decision) return 'name and decision are required';
      if (!Array.isArray(b.include) || b.include.length === 0) return 'include is required';
      return {
        name: b.name,
        decision: b.decision,
        include: b.include,
        exclude: b.exclude ?? [],
        require: b.require ?? [],
      };
    };

    if (!id && method === 'POST') {
      const parsed = parse();
      if (typeof parsed === 'string') return badRequest(res, parsed, 12130);
      const policy: MockAccessPolicy = { id: randomUUID(), ...parsed };
      s.accessPolicies.push(policy);
      return send(res, 200, envelope(render(policy)));
    }
    const policy = s.accessPolicies.find((p) => p.id === id);
    if (!policy) return notFound(res, 'Access policy not found');
    if (method === 'GET') return send(res, 200, envelope(render(policy)));
    if (method === 'PUT') {
      const parsed = parse();
      if (typeof parsed === 'string') return badRequest(res, parsed, 12130);
      Object.assign(policy, parsed);
      return send(res, 200, envelope(render(policy)));
    }
    if (method === 'DELETE') {
      if (appCount(policy) > 0) {
        return badRequest(res, 'policy is still used by an application', 12130);
      }
      s.accessPolicies = s.accessPolicies.filter((p) => p !== policy);
      return send(res, 200, envelope({ id: policy.id }));
    }
    return notFound(res);
  }
}

function publicAccessApp(app: MockAccessApp, policies: MockAccessPolicy[]) {
  const { policyIds, ...rest } = app;
  return {
    ...rest,
    policies: policyIds.map((id, i) => {
      const p = policies.find((x) => x.id === id);
      return { ...(p ?? { id }), precedence: i + 1 };
    }),
  };
}

function publicTunnel(t: MockTunnel) {
  const { config: _c, version: _v, ...rest } = t;
  return { ...rest, connections: [], conns_active_at: null, conns_inactive_at: null };
}

function envelope(
  result: unknown,
  success = true,
  errors: Array<{ code: number; message: string }> = [],
) {
  return { success, errors, messages: [], result };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse, message = 'Not found'): void {
  send(res, 404, envelope(null, false, [{ code: 7003, message }]));
}

function badRequest(res: ServerResponse, message: string, code = 1001): void {
  send(res, 400, envelope(null, false, [{ code, message }]));
}

function paginate<T>(res: ServerResponse, items: T[], q: URLSearchParams): void {
  const perPage = Math.max(1, Number(q.get('per_page') ?? 20));
  const page = Math.max(1, Number(q.get('page') ?? 1));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  send(res, 200, {
    ...envelope(slice),
    result_info: {
      page,
      per_page: perPage,
      count: slice.length,
      total_count: items.length,
      total_pages: Math.max(1, Math.ceil(items.length / perPage)),
    },
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

interface GraphqlBody {
  query?: string;
  variables?: { zoneTag?: string; start?: string; end?: string };
}

/** Requests of a hostname during one hour: stable for a given name and hour. */
function hourlyRequests(host: string, hour: number): number {
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const base = 20 + (h % 60);
  const wave = Math.sin(((hour % 24) / 24) * Math.PI * 2);
  return Math.max(0, Math.round(base * (1 + 0.6 * wave)));
}

/** Fake answers to the GraphQL Analytics queries of Burrow (see services/traffic.ts). */
function mockAnalytics(token: string, body: GraphqlBody | undefined, zones: MockZone[]) {
  if (token.includes('noanalytics')) {
    return {
      data: null,
      errors: [{ message: 'not authorized for that zone', extensions: { code: 'authz' } }],
    };
  }
  const query = body?.query ?? '';
  const v = body?.variables ?? {};
  if (!zones.some((z) => z.id === v.zoneTag))
    return { data: { viewer: { zones: [] } }, errors: null };
  const HOUR = 3_600_000;
  const start = Math.floor(Date.parse(v.start ?? '') / HOUR);
  const end = Math.ceil(Date.parse(v.end ?? '') / HOUR);
  const total = (host: string) => {
    let n = 0;
    for (let hr = start; hr < end; hr++) n += hourlyRequests(host, hr);
    return n;
  };
  const zone: Record<string, unknown[]> = {};
  const host = /clientRequestHTTPHost:\s*"([^"]+)"/.exec(query)?.[1];
  if (host && /series:/.test(query)) {
    const daily = /ts:\s*date\b/.test(query);
    const groups = new Map<string, number>();
    for (let hr = start; hr < end; hr++) {
      const iso = new Date(hr * HOUR).toISOString();
      const key = daily ? iso.slice(0, 10) : `${iso.slice(0, 13)}:00:00Z`;
      groups.set(key, (groups.get(key) ?? 0) + hourlyRequests(host, hr));
    }
    zone.series = [...groups].map(([ts, count]) => ({
      count,
      sum: { edgeResponseBytes: count * 24_000, visits: Math.round(count * 0.3) },
      dimensions: { ts },
    }));
    const n = total(host);
    zone.statuses = [
      [200, 0.86],
      [304, 0.07],
      [404, 0.05],
      [502, 0.02],
    ].map(([status, share]) => ({
      count: Math.round(n * share!),
      dimensions: { edgeResponseStatus: status },
    }));
    zone.countries = [
      ['FR', 0.52],
      ['US', 0.2],
      ['DE', 0.12],
      ['GB', 0.08],
      ['CA', 0.04],
    ].map(([country, share]) => ({
      count: Math.round(n * (share as number)),
      dimensions: { clientCountryName: country },
    }));
  }
  const list = /clientRequestHTTPHost_in:\s*(\[[^\]]*\])/.exec(query)?.[1];
  if (list) {
    zone.hosts = (JSON.parse(list) as string[]).map((name) => {
      const count = total(name);
      return {
        count,
        sum: { edgeResponseBytes: count * 24_000 },
        dimensions: { clientRequestHTTPHost: name },
      };
    });
  }
  if (Object.keys(zone).length === 0) zone.httpRequestsAdaptiveGroups = [{ count: 1 }];
  return { data: { viewer: { zones: [zone] } }, errors: null };
}
