import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiRequestError } from './client';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ApiClient', () => {
  it('sends the CSRF token on mutating requests only', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { ok: true }));
    const client = new ApiClient({ fetch });
    client.setCsrfToken('csrf-123');

    await client.get('/hosts');
    await client.post('/sync');
    await client.delete('/hosts/1');

    const headers = fetch.mock.calls.map(
      ([, init]) => (init?.headers ?? {}) as Record<string, string>,
    );
    expect(headers[0]!['X-CSRF-Token']).toBeUndefined();
    expect(headers[1]!['X-CSRF-Token']).toBe('csrf-123');
    expect(headers[2]!['X-CSRF-Token']).toBe('csrf-123');
    expect(fetch.mock.calls[0]![0]).toBe('/api/hosts');
    expect(fetch.mock.calls[1]![1]?.credentials).toBe('same-origin');
  });

  it('calls the unauthorized listener on 401 and clears the token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json(401, { error: { code: 'UNAUTHORIZED', message: 'Not logged in' } }),
    );
    const client = new ApiClient({ fetch });
    client.setCsrfToken('csrf-123');
    const listener = vi.fn();
    client.onUnauthorized(listener);

    await expect(client.get('/hosts')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(client.getCsrfToken()).toBeNull();
  });

  it('does not redirect when the caller opts out (login, me)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json(401, { error: { code: 'UNAUTHORIZED', message: 'Wrong password' } }),
    );
    const client = new ApiClient({ fetch });
    const listener = vi.fn();
    client.onUnauthorized(listener);

    await expect(
      client.post('/auth/login', {}, undefined, { skipAuthRedirect: true }),
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(listener).not.toHaveBeenCalled();
  });

  it('refreshes the CSRF token and retries once on CSRF_INVALID', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(403, { error: { code: 'CSRF_INVALID', message: 'Bad token' } }))
      .mockResolvedValueOnce(json(200, { user: { id: 1, email: 'a@b.c' }, csrfToken: 'fresh' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient({ fetch });
    client.setCsrfToken('stale');

    await client.delete('/hosts/1');

    expect(fetch).toHaveBeenCalledTimes(3);
    expect((fetch.mock.calls[2]![1]?.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'fresh',
    );
  });

  it('maps API error bodies and network failures', async () => {
    const client = new ApiClient({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          json(409, { error: { code: 'DNS_CONFLICT', message: 'Record exists' } }),
        )
        .mockRejectedValueOnce(new TypeError('Failed to fetch')),
    });
    await expect(client.post('/hosts', {})).rejects.toMatchObject({
      status: 409,
      code: 'DNS_CONFLICT',
      message: 'Record exists',
    });
    await expect(client.get('/hosts')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});
