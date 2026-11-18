import type { OriginHealth } from '@burrow/shared';
import { connect } from 'node:net';
import { Agent, request } from 'undici';
import { errorMessage } from '../lib/errors.js';

/** What a probe needs to know about a host. */
export interface ProbeTarget {
  service: string;
  noTlsVerify: boolean;
  httpHostHeader: string;
  originServerName: string;
}

export const UNKNOWN_HEALTH: OriginHealth = {
  state: 'unknown',
  statusCode: null,
  latencyMs: null,
  error: null,
  checkedAt: null,
};

const DEFAULT_PORTS: Record<string, number> = { ssh: 22, rdp: 3389, smb: 445 };

/** Turn low-level network errors into something a homelab user can act on. */
export function describeProbeError(err: unknown, timeoutMs: number): string {
  const e = err as { code?: string; cause?: { code?: string; message?: string }; name?: string };
  const code = e?.code ?? e?.cause?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return 'Connection refused: is the service running and listening on this port?';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Host not found: check the hostname (containers must share a Docker network with Burrow)';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Host unreachable from the Burrow container';
    case 'ECONNRESET':
      return 'Connection reset by the origin';
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'ETIMEDOUT':
      return `Timed out after ${timeoutMs / 1000}s`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'CERT_HAS_EXPIRED':
      return `TLS certificate rejected (${code}). Enable "No TLS Verify" for self-signed certificates.`;
  }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
    return `Timed out after ${timeoutMs / 1000}s`;
  return errorMessage(err);
}

async function probeHttp(target: ProbeTarget, timeoutMs: number): Promise<{ statusCode: number }> {
  const agent = new Agent({
    connect: {
      rejectUnauthorized: !target.noTlsVerify,
      servername: target.originServerName || undefined,
      timeout: timeoutMs,
    },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const headers: Record<string, string> = { 'user-agent': 'Burrow-HealthCheck/1' };
  if (target.httpHostHeader) headers.host = target.httpHostHeader;
  const send = async (method: 'HEAD' | 'GET') => {
    const res = await request(target.service, {
      method,
      headers,
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body.dump().catch(() => undefined);
    return res.statusCode;
  };
  try {
    let statusCode = await send('HEAD');
    if (statusCode === 405 || statusCode === 501) statusCode = await send('GET');
    return { statusCode };
  } finally {
    await agent.close().catch(() => undefined);
  }
}

function probeTcp(url: URL, timeoutMs: number): Promise<void> {
  const port = Number(url.port) || DEFAULT_PORTS[url.protocol.replace(':', '')];
  if (!port) return Promise.reject(new Error('No port in the service URL'));
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port,
      timeout: timeoutMs,
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    socket.once('error', reject);
  });
}

/**
 * Probe a host's origin from inside the container, i.e. through exactly the
 * network path cloudflared uses. HTTP(S): `HEAD`, falling back to `GET` when
 * the method is not allowed. TCP-like schemes: a TCP connect. Any HTTP
 * response (even 5xx) counts as reachable.
 */
export async function probeOrigin(target: ProbeTarget, timeoutMs = 5_000): Promise<OriginHealth> {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  let url: URL;
  try {
    url = new URL(target.service);
  } catch {
    return { ...UNKNOWN_HEALTH, state: 'down', error: 'Invalid service URL', checkedAt };
  }
  const scheme = url.protocol.replace(':', '');
  try {
    if (scheme === 'http' || scheme === 'https') {
      const { statusCode } = await probeHttp(target, timeoutMs);
      return {
        state: 'up',
        statusCode,
        latencyMs: Math.round(performance.now() - started),
        error: null,
        checkedAt,
      };
    }
    if (scheme.startsWith('unix')) {
      return { ...UNKNOWN_HEALTH, error: 'Unix sockets are not probed', checkedAt };
    }
    await probeTcp(url, timeoutMs);
    return {
      state: 'up',
      statusCode: null,
      latencyMs: Math.round(performance.now() - started),
      error: null,
      checkedAt,
    };
  } catch (err) {
    return {
      state: 'down',
      statusCode: null,
      latencyMs: null,
      error: describeProbeError(err, timeoutMs),
      checkedAt,
    };
  }
}

/** Caches the last probe result of each host (in memory only). */
export class HealthService {
  private readonly cache = new Map<number, OriginHealth>();

  constructor(private readonly timeoutMs = 5_000) {}

  get(hostId: number): OriginHealth {
    return this.cache.get(hostId) ?? UNKNOWN_HEALTH;
  }

  /** Probe one host now and cache the result. */
  async check(hostId: number, target: ProbeTarget): Promise<OriginHealth> {
    const result = await probeOrigin(target, this.timeoutMs);
    this.cache.set(hostId, result);
    return result;
  }

  /** Probe several hosts, a few at a time. */
  async checkAll(hosts: Array<ProbeTarget & { id: number }>, concurrency = 8): Promise<void> {
    const queue = [...hosts];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let h = queue.shift(); h; h = queue.shift()) await this.check(h.id, h);
    });
    await Promise.all(workers);
  }

  forget(hostId: number): void {
    this.cache.delete(hostId);
  }
}
