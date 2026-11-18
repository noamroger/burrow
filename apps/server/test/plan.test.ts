import { dnsOwnershipComment } from '@burrow/shared';
import { describe, expect, it } from 'vitest';
import type { CfIngressRule } from '../src/cloudflare/types.js';
import {
  desiredDnsRecord,
  isOwnedRecord,
  plan,
  type ActualState,
  type PlanHost,
  type ZonedDnsRecord,
} from '../src/services/plan.js';

const TUNNEL = '11111111-2222-3333-4444-555555555555';
const OLD_TUNNEL = '99999999-8888-7777-6666-555555555555';
const ZONE = 'a'.repeat(32);
const ZONE2 = 'b'.repeat(32);
const TARGET = `${TUNNEL}.cfargotunnel.com`;
const OURS = dnsOwnershipComment(TUNNEL);

let nextId = 1;
const host = (hostname: string, extra: Partial<PlanHost> = {}): PlanHost => ({
  id: nextId++,
  zoneId: ZONE,
  hostname,
  path: '',
  service: 'http://svc:80',
  noTlsVerify: false,
  httpHostHeader: '',
  originServerName: '',
  enabled: true,
  ...extra,
});

const cname = (name: string, extra: Partial<ZonedDnsRecord> = {}): ZonedDnsRecord => ({
  id: `rec-${name}-${nextId++}`,
  zoneId: ZONE,
  type: 'CNAME',
  name,
  content: TARGET,
  proxied: true,
  ttl: 1,
  comment: OURS,
  ...extra,
});

const synced = (hosts: PlanHost[]): CfIngressRule[] => [
  ...hosts.map((h) => ({ hostname: h.hostname, service: h.service })),
  { service: 'http_status:404' },
];

const actual = (over: Partial<ActualState> = {}): ActualState => ({
  tunnelId: TUNNEL,
  ingress: [],
  managedKeys: [],
  dnsRecords: [],
  ...over,
});

const kinds = (p: ReturnType<typeof plan>) => p.actions.map((a) => a.kind);

describe('plan(): reconciliation table', () => {
  it('everything in sync -> no actions', () => {
    const h = host('app.example.com');
    const rec = cname('app.example.com');
    const p = plan(
      [h],
      actual({ ingress: synced([h]), managedKeys: ['app.example.com|'], dnsRecords: [rec] }),
    );
    expect(p.actions).toEqual([]);
    expect(p.dnsRecordIds.get('app.example.com')).toBe(rec.id);
    expect(p.hostErrors.size).toBe(0);
  });

  it('ingress rule missing -> ingress.update with the rule before the catch-all', () => {
    const h = host('app.example.com');
    const p = plan([h], actual({ dnsRecords: [cname('app.example.com')] }));
    expect(kinds(p)).toEqual(['ingress.update']);
    expect(p.ingress).toEqual(synced([h]));
    expect(p.managedKeys).toEqual(['app.example.com|']);
  });

  it('ingress rule different -> ingress.update', () => {
    const h = host('app.example.com', { service: 'http://new:80' });
    const p = plan(
      [h],
      actual({
        ingress: [
          { hostname: 'app.example.com', service: 'http://old:80' },
          { service: 'http_status:404' },
        ],
        managedKeys: ['app.example.com|'],
        dnsRecords: [cname('app.example.com')],
      }),
    );
    expect(kinds(p)).toEqual(['ingress.update']);
    expect(p.ingress[0]).toEqual({ hostname: 'app.example.com', service: 'http://new:80' });
  });

  it('CNAME missing -> dns.create (proxied, ttl 1, ownership comment)', () => {
    const h = host('app.example.com');
    const p = plan([h], actual({ ingress: synced([h]), managedKeys: ['app.example.com|'] }));
    expect(p.actions).toEqual([
      {
        kind: 'dns.create',
        zoneId: ZONE,
        hostname: 'app.example.com',
        record: {
          type: 'CNAME',
          name: 'app.example.com',
          content: TARGET,
          proxied: true,
          ttl: 1,
          comment: OURS,
        },
        hostIds: [h.id],
      },
    ]);
  });

  it('CNAME ours but wrong target -> dns.update', () => {
    const h = host('app.example.com');
    const rec = cname('app.example.com', { content: 'elsewhere.cfargotunnel.com' });
    const p = plan(
      [h],
      actual({ ingress: synced([h]), managedKeys: ['app.example.com|'], dnsRecords: [rec] }),
    );
    expect(p.actions).toEqual([
      {
        kind: 'dns.update',
        zoneId: ZONE,
        recordId: rec.id,
        hostname: 'app.example.com',
        record: desiredDnsRecord('app.example.com', TUNNEL),
        hostIds: [h.id],
      },
    ]);
  });

  it('CNAME ours but not proxied -> dns.update', () => {
    const h = host('app.example.com');
    const p = plan(
      [h],
      actual({
        ingress: synced([h]),
        managedKeys: ['app.example.com|'],
        dnsRecords: [cname('app.example.com', { proxied: false })],
      }),
    );
    expect(kinds(p)).toEqual(['dns.update']);
  });

  it('record exists but not ours -> host.conflict, nothing touched, no ingress rule', () => {
    const h = host('app.example.com');
    const foreign = cname('app.example.com', {
      type: 'A',
      content: '192.0.2.1',
      comment: 'made by hand',
    });
    const p = plan(
      [h],
      actual({ ingress: [{ service: 'http_status:404' }], dnsRecords: [foreign] }),
    );
    expect(kinds(p)).toEqual(['host.conflict']);
    expect(p.hostErrors.get(h.id)?.code).toBe('DNS_CONFLICT');
    expect(p.ingress).toEqual([{ service: 'http_status:404' }]);
    expect(p.managedKeys).toEqual([]);
  });

  it('a conflicted host loses a rule Burrow wrote earlier', () => {
    const h = host('app.example.com');
    const p = plan(
      [h],
      actual({
        ingress: synced([h]),
        managedKeys: ['app.example.com|'],
        dnsRecords: [cname('app.example.com', { comment: null })],
      }),
    );
    expect(kinds(p)).toEqual(['ingress.update', 'host.conflict']);
    expect(p.ingress).toEqual([{ service: 'http_status:404' }]);
  });

  it('orphan ingress rule (ours, no host) -> removed', () => {
    const p = plan(
      [],
      actual({
        ingress: [
          { hostname: 'gone.example.com', service: 'http://x' },
          { service: 'http_status:404' },
        ],
        managedKeys: ['gone.example.com|'],
      }),
    );
    expect(kinds(p)).toEqual(['ingress.update']);
    expect(p.ingress).toEqual([{ service: 'http_status:404' }]);
  });

  it('orphan CNAME with this tunnel comment -> dns.delete', () => {
    const rec = cname('gone.example.com');
    const p = plan([], actual({ ingress: [{ service: 'http_status:404' }], dnsRecords: [rec] }));
    expect(p.actions).toEqual([
      {
        kind: 'dns.delete',
        zoneId: ZONE,
        recordId: rec.id,
        hostname: 'gone.example.com',
        hostIds: [],
      },
    ]);
  });

  it('never deletes records owned by another Burrow tunnel or nobody', () => {
    const p = plan(
      [],
      actual({
        ingress: [{ service: 'http_status:404' }],
        dnsRecords: [
          cname('other.example.com', { comment: dnsOwnershipComment(OLD_TUNNEL) }),
          cname('manual.example.com', { comment: 'hand made' }),
          cname('nocomment.example.com', { comment: null }),
        ],
      }),
    );
    expect(p.actions).toEqual([]);
  });

  it('foreign ingress rules are kept untouched', () => {
    const h = host('app.example.com');
    const foreign = { hostname: 'manual.example.com', service: 'ssh://10.0.0.5:22' };
    const p = plan(
      [h],
      actual({
        ingress: [foreign, { service: 'http_status:404' }],
        dnsRecords: [cname('app.example.com')],
      }),
    );
    expect(p.ingress).toEqual([
      { hostname: 'app.example.com', service: 'http://svc:80' },
      foreign,
      { service: 'http_status:404' },
    ]);
    expect(p.managedKeys).toEqual(['app.example.com|']);
  });

  it('tunnel recreated: empty ingress and records pointing at the old tunnel -> rewrite everything', () => {
    const a = host('a.example.com');
    const b = host('b.example.com');
    const old = (name: string) =>
      cname(name, {
        content: `${OLD_TUNNEL}.cfargotunnel.com`,
        comment: dnsOwnershipComment(OLD_TUNNEL),
      });
    const p = plan(
      [a, b],
      actual({
        ingress: [],
        managedKeys: [],
        dnsRecords: [old('a.example.com'), old('b.example.com')],
      }),
    );
    expect(kinds(p)).toEqual(['ingress.update', 'dns.update', 'dns.update']);
    expect(p.ingress).toEqual(synced([a, b]));
  });

  it('disabled host -> its rule and record are removed, attributed to the host', () => {
    const h = host('app.example.com', { enabled: false });
    const rec = cname('app.example.com');
    const p = plan(
      [h],
      actual({ ingress: synced([h]), managedKeys: ['app.example.com|'], dnsRecords: [rec] }),
    );
    expect(kinds(p)).toEqual(['ingress.update', 'dns.delete']);
    expect(p.actions[1]).toMatchObject({ kind: 'dns.delete', recordId: rec.id, hostIds: [h.id] });
    expect(p.ingress).toEqual([{ service: 'http_status:404' }]);
  });

  it('several paths on one hostname share a single CNAME', () => {
    const root = host('app.example.com');
    const api = host('app.example.com', { path: '^/api', service: 'http://api:80' });
    const p = plan([root, api], actual());
    expect(kinds(p)).toEqual(['ingress.update', 'dns.create']);
    expect(p.actions[1]).toMatchObject({ hostIds: [root.id, api.id] });
    expect(p.ingress.map((r) => r.path ?? '')).toEqual(['^/api', '', '']);
  });

  it('duplicate Burrow records for one hostname -> extra ones deleted', () => {
    const h = host('app.example.com');
    const first = cname('app.example.com');
    const dup = cname('app.example.com');
    const p = plan(
      [h],
      actual({ ingress: synced([h]), managedKeys: ['app.example.com|'], dnsRecords: [first, dup] }),
    );
    expect(p.actions).toEqual([
      {
        kind: 'dns.delete',
        zoneId: ZONE,
        recordId: dup.id,
        hostname: 'app.example.com',
        hostIds: [],
      },
    ]);
  });

  it('unavailable zone -> hosts there get an error and no DNS action, ingress stays desired', () => {
    const h = host('app.example.org', { zoneId: ZONE2 });
    const p = plan(
      [h],
      actual({ unavailableZones: new Map([[ZONE2, 'Could not read DNS records']]) }),
    );
    expect(kinds(p)).toEqual(['ingress.update']);
    expect(p.hostErrors.get(h.id)).toEqual({
      code: 'CLOUDFLARE_API_ERROR',
      message: 'Could not read DNS records',
    });
    expect(p.ingress[0]).toMatchObject({ hostname: 'app.example.org' });
  });

  it('scoped run: hostnames outside the DNS scope get no DNS action', () => {
    const a = host('a.example.com');
    const b = host('b.example.com');
    const p = plan(
      [a, b],
      actual({
        ingress: synced([a, b]),
        managedKeys: ['a.example.com|', 'b.example.com|'],
        dnsScope: new Set(['a.example.com']),
      }),
    );
    expect(p.actions).toEqual([
      expect.objectContaining({ kind: 'dns.create', hostname: 'a.example.com' }),
    ]);
  });

  it('hostname comparison is case-insensitive', () => {
    const h = host('app.example.com');
    const p = plan(
      [h],
      actual({
        ingress: synced([h]),
        managedKeys: ['app.example.com|'],
        dnsRecords: [cname('App.Example.com')],
      }),
    );
    expect(p.actions).toEqual([]);
  });
});

describe('isOwnedRecord', () => {
  it('recognises the managed-by:burrow prefix only', () => {
    expect(isOwnedRecord({ comment: OURS })).toBe(true);
    expect(isOwnedRecord({ comment: dnsOwnershipComment(OLD_TUNNEL) })).toBe(true);
    expect(isOwnedRecord({ comment: 'not managed-by:burrow' })).toBe(false);
    expect(isOwnedRecord({ comment: null })).toBe(false);
  });
});
