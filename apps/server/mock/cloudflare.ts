/**
 * An in-memory fake of the Cloudflare API endpoints Burrow uses.
 *
 * Used by the test suite and by `pnpm --filter @burrow/server mock:cf`, so the
 * whole app can run locally (or in the Docker image) without a Cloudflare
 * account. It mimics the v4 envelope, pagination and the error codes Burrow
 * relies on; it is not a full emulator.
 *
 * Tokens: any token of 20+ characters is accepted, except tokens containing
 * `invalid` (401) or `noperm` (403 on tunnel endpoints).
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

export interface MockState {
  accounts: Array<{ id: string; name: string }>;
  zones: MockZone[];
  tunnels: MockTunnel[];
  dns: MockDnsRecord[];
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
