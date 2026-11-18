import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiError, CloudflareClient } from '../src/cloudflare/client.js';

const TOKEN = 'secret-token-0123456789abcdefghij';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const ok = (result: unknown, result_info?: unknown) =>
  json(200, { success: true, errors: [], messages: [], result, result_info });
const fail = (status: number, code = 1000, message = 'nope') =>
  json(status, { success: false, errors: [{ code, message }], messages: [], result: null });

function client(fetchImpl: typeof fetch) {
  return new CloudflareClient({
    token: TOKEN,
    baseUrl: 'https://api.test/client/v4/',
    fetch: fetchImpl,
    retryBaseMs: 1,
  });
}

describe('CloudflareClient', () => {
  it('sends the bearer token and unwraps the envelope', async () => {
    const f = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      ok({ id: 'x', status: 'active' }),
    );
    const res = await client(f as typeof fetch).verifyUserToken();
    expect(res).toEqual({ id: 'x', status: 'active' });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe('https://api.test/client/v4/user/tokens/verify');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps 401 to CLOUDFLARE_TOKEN_INVALID and 403 to CLOUDFLARE_PERMISSION_MISSING', async () => {
    await expect(
      client((async () => fail(401)) as typeof fetch).listAccounts(),
    ).rejects.toMatchObject({
      code: 'CLOUDFLARE_TOKEN_INVALID',
      httpStatus: 401,
    });
    await expect(
      client((async () => fail(403, 10000, 'Authentication error')) as typeof fetch).listZones(),
    ).rejects.toMatchObject({
      code: 'CLOUDFLARE_PERMISSION_MISSING',
    });
  });

  it('maps other failures to CLOUDFLARE_API_ERROR and keeps Cloudflare messages', async () => {
    const err = await client((async () =>
      fail(400, 81053, 'Record already exists')) as typeof fetch)
      .createDnsRecord('z', {
        type: 'CNAME',
        name: 'a',
        content: 'b',
        proxied: true,
        ttl: 1,
        comment: 'c',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).code).toBe('CLOUDFLARE_API_ERROR');
    expect((err as CloudflareApiError).message).toContain('Record already exists (81053)');
  });

  it('treats success:false with HTTP 200 as an error', async () => {
    await expect(
      client((async () =>
        json(200, {
          success: false,
          errors: [{ code: 1, message: 'bad' }],
          result: null,
        })) as typeof fetch).listAccounts(),
    ).rejects.toBeInstanceOf(CloudflareApiError);
  });

  it('retries 429 and 5xx, then succeeds', async () => {
    const responses = [fail(429), fail(502), ok([{ id: 'a', name: 'A' }])];
    const f = vi.fn(async () => responses.shift()!);
    expect(await client(f as typeof fetch).listAccounts()).toEqual([{ id: 'a', name: 'A' }]);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retry budget', async () => {
    const f = vi.fn(async () => fail(503));
    await expect(client(f as typeof fetch).listAccounts()).rejects.toMatchObject({
      code: 'CLOUDFLARE_API_ERROR',
      httpStatus: 503,
    });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('does not retry 4xx', async () => {
    const f = vi.fn(async () => fail(404, 7003, 'not found'));
    const err = await client(f as typeof fetch)
      .getTunnel('acc', 'tun')
      .catch((e: unknown) => e);
    expect((err as CloudflareApiError).isNotFound).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('retries network errors and never leaks the token in error messages', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = (await client(f as typeof fetch)
      .listAccounts()
      .catch((e: unknown) => e)) as CloudflareApiError;
    expect(f).toHaveBeenCalledTimes(4);
    expect(err.message).toContain('Could not reach the Cloudflare API');
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(TOKEN);
  });

  it('follows pagination using result_info.total_pages', async () => {
    const f = vi.fn(async (url: URL | RequestInfo) => {
      const page = Number(new URL(String(url)).searchParams.get('page'));
      return ok([{ id: `z${page}`, name: `zone${page}` }], { page, per_page: 1, total_pages: 3 });
    });
    const zones = await client(f as typeof fetch).listZones();
    expect(zones.map((z) => z.id)).toEqual(['z1', 'z2', 'z3']);
  });

  it('sends JSON bodies for writes', async () => {
    const f = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      ok({ tunnel_id: 't', version: 2, config: {} }),
    );
    await client(f as typeof fetch).putTunnelConfiguration('acc', 't', {
      ingress: [{ service: 'http_status:404' }],
    });
    const init = f.mock.calls[0]![1]!;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      config: { ingress: [{ service: 'http_status:404' }] },
    });
  });
});
