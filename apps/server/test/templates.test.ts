import {
  findTemplate,
  SERVICE_TEMPLATES,
  serviceUrlSchema,
  templateServiceUrl,
} from '@burrow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiFor, createTestApp, setupConfigured, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('service templates', () => {
  it('have unique ids and valid suggested service URLs', () => {
    const ids = SERVICE_TEMPLATES.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of SERVICE_TEMPLATES) {
      expect(serviceUrlSchema.safeParse(templateServiceUrl(template)).success).toBe(true);
    }
    expect(findTemplate('Proxmox')?.options.noTLSVerify).toBe(true);
    expect(findTemplate('nope')).toBeUndefined();
  });

  it('are listed by the API', async () => {
    const s = await setupConfigured(t);
    const res = await apiFor(t, s)('GET', '/api/templates');
    expect(res.statusCode).toBe(200);
    expect(res.json().templates.map((x: { id: string }) => x.id)).toContain('home-assistant');
  });

  it('are remembered on hosts, exported and validated', async () => {
    const s = await setupConfigured(t);
    const call = apiFor(t, s);
    const proxmox = findTemplate('proxmox')!;
    const res = await call('POST', '/api/hosts', {
      subdomain: 'pve',
      zoneId: s.zoneId,
      service: templateServiceUrl(proxmox),
      options: { noTLSVerify: true },
      template: 'proxmox',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().template).toBe('proxmox');

    const exported = (await call('GET', '/api/config/export')).json();
    expect(exported.hosts[0].template).toBe('proxmox');

    const bad = await call('POST', '/api/hosts', {
      subdomain: 'x',
      zoneId: s.zoneId,
      service: 'http://x:1',
      template: 'not-a-template',
    });
    expect(bad.statusCode).toBe(400);
  });
});
