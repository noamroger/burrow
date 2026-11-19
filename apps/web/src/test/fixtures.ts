import type { LogLine, ProxyHost, Zone } from '@burrow/shared';

export const ZONE_ID = 'a'.repeat(32);

export const zones: Zone[] = [
  { id: ZONE_ID, name: 'example.com', enabled: true, hostCount: 1 },
  { id: 'b'.repeat(32), name: 'homelab.dev', enabled: true, hostCount: 0 },
];

export function makeHost(overrides: Partial<ProxyHost> = {}): ProxyHost {
  return {
    id: 1,
    subdomain: 'nas',
    zoneId: ZONE_ID,
    zoneName: 'example.com',
    tunnelId: 1,
    tunnelName: 'burrow-abc123',
    hostname: 'nas.example.com',
    service: 'http://192.168.1.20:5000',
    path: '',
    enabled: true,
    options: { noTLSVerify: false, httpHostHeader: '', originServerName: '', extra: {} },
    access: {
      enabled: false,
      emails: [],
      emailDomains: [],
      sessionDuration: '24h',
      browserRendering: null,
    },
    template: null,
    source: 'manual',
    sourceRef: null,
    expiresAt: null,
    maintenance: { enabled: false, until: null, page: null },
    sync: { status: 'synced', error: null, lastSyncedAt: '2026-11-18T10:00:00.000Z' },
    health: {
      state: 'up',
      statusCode: 200,
      latencyMs: 12,
      error: null,
      checkedAt: '2026-11-18T10:00:00.000Z',
    },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
    ...overrides,
  };
}

export function makeLog(seq: number, level: LogLine['level'], message: string): LogLine {
  return { seq, level, message, source: 'cloudflared', time: '2026-11-18T10:00:00.000Z' };
}
