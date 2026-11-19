import { describe, expect, it } from 'vitest';
import type { CfIngressRule } from '../src/cloudflare/types.js';
import {
  buildIngressRule,
  DEFAULT_CATCH_ALL,
  ingressEqual,
  keyOfRule,
  mergeIngress,
  orderIngress,
} from '../src/services/ingress.js';

const host = (hostname: string, path = '', service = 'http://svc:80') => ({
  hostname,
  path,
  service,
  noTlsVerify: false,
  httpHostHeader: '',
  originServerName: '',
});

describe('buildIngressRule', () => {
  it('keeps extra originRequest keys of an imported route, flags win', () => {
    expect(
      buildIngressRule({
        ...host('a.example.com'),
        noTlsVerify: false,
        originRequestExtra: { connectTimeout: '30s', noTLSVerify: true },
      }),
    ).toEqual({
      hostname: 'a.example.com',
      service: 'http://svc:80',
      originRequest: { connectTimeout: '30s' },
    });
  });

  it('omits empty path and options', () => {
    expect(buildIngressRule(host('a.example.com'))).toEqual({
      hostname: 'a.example.com',
      service: 'http://svc:80',
    });
  });

  it('maps every option to originRequest', () => {
    const rule = buildIngressRule({
      ...host('a.example.com', '^/api'),
      noTlsVerify: true,
      httpHostHeader: 'internal.lan',
      originServerName: 'origin.lan',
    });
    expect(rule).toEqual({
      hostname: 'a.example.com',
      service: 'http://svc:80',
      path: '^/api',
      originRequest: {
        noTLSVerify: true,
        httpHostHeader: 'internal.lan',
        originServerName: 'origin.lan',
      },
    });
  });
});

describe('orderIngress', () => {
  it('adds the http_status:404 catch-all when missing', () => {
    expect(orderIngress([])).toEqual([DEFAULT_CATCH_ALL]);
    const out = orderIngress([{ hostname: 'a.example.com', service: 'http://a' }]);
    expect(out.at(-1)).toEqual({ service: 'http_status:404' });
  });

  it('keeps an existing catch-all, once, at the end', () => {
    const out = orderIngress([
      { service: 'http_status:503' },
      { hostname: 'b.example.com', service: 'http://b' },
      { service: 'http_status:404' },
    ]);
    expect(out).toEqual([
      { hostname: 'b.example.com', service: 'http://b' },
      { service: 'http_status:404' },
    ]);
  });

  it('puts path-specific rules before the path-less rule of the same hostname', () => {
    const out = orderIngress([
      { hostname: 'a.example.com', service: 'http://root' },
      { hostname: 'a.example.com', path: '^/api', service: 'http://api' },
      { hostname: 'a.example.com', path: '^/api/v2/admin', service: 'http://admin' },
    ]);
    expect(out.map((r) => r.service)).toEqual([
      'http://admin',
      'http://api',
      'http://root',
      'http_status:404',
    ]);
  });

  it('sorts by hostname and puts wildcards after concrete hostnames', () => {
    const out = orderIngress([
      { hostname: '*.example.com', service: 'http://wild' },
      { hostname: 'z.example.com', service: 'http://z' },
      { hostname: 'a.example.com', service: 'http://a' },
    ]);
    expect(out.map((r) => r.hostname ?? '')).toEqual([
      'a.example.com',
      'z.example.com',
      '*.example.com',
      '',
    ]);
  });

  it('keeps hostname-less path rules after hostname rules, in original order', () => {
    const out = orderIngress([
      { path: '^/two', service: 'http://two' },
      { hostname: 'a.example.com', service: 'http://a' },
      { path: '^/one', service: 'http://one' },
    ]);
    expect(out.map((r) => r.service)).toEqual([
      'http://a',
      'http://two',
      'http://one',
      'http_status:404',
    ]);
  });
});

describe('mergeIngress', () => {
  const foreign: CfIngressRule = { hostname: 'manual.example.com', service: 'http://manual' };

  it('preserves foreign rules and replaces owned ones', () => {
    const current: CfIngressRule[] = [
      { hostname: 'app.example.com', service: 'http://old' },
      foreign,
      { service: 'http_status:404' },
    ];
    const desired = [buildIngressRule(host('app.example.com', '', 'http://new'))];
    const out = mergeIngress(current, desired, [keyOfRule(current[0]!)]);
    expect(out).toEqual([
      { hostname: 'app.example.com', service: 'http://new' },
      foreign,
      { service: 'http_status:404' },
    ]);
  });

  it('drops owned rules that are no longer desired (orphans)', () => {
    const current: CfIngressRule[] = [
      { hostname: 'gone.example.com', service: 'http://x' },
      foreign,
    ];
    const out = mergeIngress(current, [], ['gone.example.com|']);
    expect(out).toEqual([foreign, { service: 'http_status:404' }]);
  });

  it('takes over a foreign rule with exactly the same hostname and path', () => {
    const out = mergeIngress(
      [foreign],
      [buildIngressRule(host('manual.example.com', '', 'http://burrow'))],
      [],
    );
    expect(out).toEqual([
      { hostname: 'manual.example.com', service: 'http://burrow' },
      { service: 'http_status:404' },
    ]);
  });

  it('keeps a foreign rule on the same hostname but another path', () => {
    const foreignPath: CfIngressRule = {
      hostname: 'app.example.com',
      path: '^/legacy',
      service: 'http://legacy',
    };
    const out = mergeIngress([foreignPath], [buildIngressRule(host('app.example.com'))], []);
    expect(out).toEqual([
      foreignPath,
      { hostname: 'app.example.com', service: 'http://svc:80' },
      { service: 'http_status:404' },
    ]);
  });
});

describe('ingressEqual', () => {
  it('ignores key order, empty originRequest and empty path', () => {
    expect(
      ingressEqual(
        [{ service: 'http://a', hostname: 'a.example.com', originRequest: {}, path: '' }],
        [{ hostname: 'a.example.com', service: 'http://a' }],
      ),
    ).toBe(true);
  });

  it('detects different order and different values', () => {
    const a = { hostname: 'a.example.com', service: 'http://a' };
    const b = { hostname: 'b.example.com', service: 'http://b' };
    expect(ingressEqual([a, b], [b, a])).toBe(false);
    expect(ingressEqual([a], [{ ...a, service: 'http://other' }])).toBe(false);
  });
});
