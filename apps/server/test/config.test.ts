import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      dataDir: '/data',
      secret: undefined,
      cloudflaredPath: 'cloudflared',
      logLevel: 'info',
      secureCookies: 'auto',
      trustProxy: false,
      cloudflareApiBase: 'https://api.cloudflare.com/client/v4',
      reconcileIntervalSeconds: 300,
      healthcheckIntervalSeconds: 60,
    });
  });

  it('parses TRUST_PROXY forms and trims the API base', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toBe('10.0.0.0/8');
    expect(
      loadConfig({ CLOUDFLARE_API_BASE: 'http://localhost:8787/client/v4/' }).cloudflareApiBase,
    ).toBe('http://localhost:8787/client/v4');
  });

  it('rejects a short BURROW_SECRET and invalid values with a readable message', () => {
    expect(() => loadConfig({ BURROW_SECRET: 'short' })).toThrow(
      /BURROW_SECRET: BURROW_SECRET must be at least 32/,
    );
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ BURROW_SECURE_COOKIES: 'maybe' })).toThrow(/BURROW_SECURE_COOKIES/);
  });

  it('treats an empty BURROW_SECRET as unset', () => {
    expect(loadConfig({ BURROW_SECRET: '' }).secret).toBeUndefined();
  });
});
