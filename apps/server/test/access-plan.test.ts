import { describe, expect, it } from 'vitest';
import type { CfAccessApp, CfAccessPolicy } from '../src/cloudflare/types.js';
import {
  appHostnames,
  desiredAccess,
  desiredPolicy,
  planAccess,
  type AccessHost,
} from '../src/services/access-plan.js';

let nextId = 1;
const host = (overrides: Partial<AccessHost> = {}): AccessHost => ({
  id: nextId++,
  hostname: 'nas.example.com',
  enabled: true,
  accessEnabled: true,
  accessEmails: ['me@example.com'],
  accessEmailDomains: [],
  accessSessionDuration: '24h',
  ...overrides,
});

const policy = (hostname: string, emails = ['me@example.com']): CfAccessPolicy => ({
  id: `pol-${hostname}`,
  name: `[Burrow] ${hostname}`,
  decision: 'allow',
  include: emails.map((email) => ({ email: { email } })),
  exclude: [],
  require: [],
});

const app = (hostname: string, overrides: Partial<CfAccessApp> = {}): CfAccessApp => ({
  id: `app-${hostname}`,
  name: `[Burrow] ${hostname}`,
  type: 'self_hosted',
  domain: hostname,
  destinations: [{ type: 'public', uri: hostname }],
  session_duration: '24h',
  policies: [{ id: `pol-${hostname}`, precedence: 1 }],
  ...overrides,
});

describe('desiredAccess', () => {
  it('ignores disabled and unprotected hosts', () => {
    const wanted = desiredAccess([
      host({ enabled: false }),
      host({ hostname: 'a.example.com', accessEnabled: false }),
    ]);
    expect(wanted.size).toBe(0);
  });

  it('merges hosts sharing a hostname: union of rules, shortest session', () => {
    const a = host({ accessEmails: ['B@example.com'], accessSessionDuration: '168h' });
    const b = host({
      accessEmails: ['a@example.com', 'b@example.com'],
      accessEmailDomains: ['family.example'],
      accessSessionDuration: '6h',
    });
    const d = desiredAccess([a, b]).get('nas.example.com')!;
    expect(d.emails).toEqual(['a@example.com', 'b@example.com']);
    expect(d.emailDomains).toEqual(['family.example']);
    expect(d.sessionDuration).toBe('6h');
    expect(d.hostIds).toEqual([a.id, b.id]);
    expect(desiredPolicy(d).include).toEqual([
      { email: { email: 'a@example.com' } },
      { email: { email: 'b@example.com' } },
      { email_domain: { domain: 'family.example' } },
    ]);
  });
});

describe('appHostnames', () => {
  it('returns exact hostnames only, ignoring path-scoped destinations', () => {
    expect(
      appHostnames({
        id: 'x',
        name: 'x',
        type: 'self_hosted',
        domain: 'App.Example.com/',
        destinations: [
          { type: 'public', uri: 'app.example.com/admin' },
          { type: 'public', uri: 'other.example.com' },
          { type: 'private', hostname: 'intranet' },
        ],
      }).sort(),
    ).toEqual(['app.example.com', 'other.example.com']);
  });
});

describe('planAccess', () => {
  const wanted = (...hosts: AccessHost[]) => desiredAccess(hosts);

  it('creates the policy and app for a new protected hostname', () => {
    const p = planAccess(wanted(host()), { apps: [], policies: [] }, { managed: [] });
    expect(p.ensure).toEqual([
      expect.objectContaining({
        kind: 'access.create',
        hostname: 'nas.example.com',
        existingPolicyId: null,
        app: expect.objectContaining({ domain: 'nas.example.com', session_duration: '24h' }),
      }),
    ]);
    expect(p.remove).toEqual([]);
  });

  it('reuses a leftover Burrow policy when the app is missing', () => {
    const leftover = policy('nas.example.com', ['old@example.com']);
    const p = planAccess(wanted(host()), { apps: [], policies: [leftover] }, { managed: [] });
    expect(p.ensure[0]).toMatchObject({
      kind: 'access.create',
      existingPolicyId: leftover.id,
      policyChanged: true,
    });
  });

  it('does nothing when everything matches', () => {
    const p = planAccess(
      wanted(host()),
      { apps: [app('nas.example.com')], policies: [policy('nas.example.com')] },
      { managed: ['nas.example.com'] },
    );
    expect(p.ensure).toEqual([]);
    expect(p.remove).toEqual([]);
  });

  it('updates the policy only when the rules drifted', () => {
    const p = planAccess(
      wanted(host()),
      {
        apps: [app('nas.example.com')],
        policies: [policy('nas.example.com', ['intruder@example.com'])],
      },
      { managed: ['nas.example.com'] },
    );
    expect(p.ensure).toEqual([
      expect.objectContaining({ kind: 'access.update', policyChanged: true, appChanged: false }),
    ]);
  });

  it('treats an extra policy rule (e.g. "everyone") as drift', () => {
    const drifted = { ...policy('nas.example.com'), require: [{ everyone: {} }] };
    const p = planAccess(
      wanted(host()),
      { apps: [app('nas.example.com')], policies: [drifted] },
      { managed: [] },
    );
    expect(p.ensure[0]).toMatchObject({ kind: 'access.update', policyChanged: true });
  });

  it('updates the app when the session or the policy link differs', () => {
    const p = planAccess(
      wanted(host({ accessSessionDuration: '30m' })),
      {
        apps: [app('nas.example.com', { policies: [] })],
        policies: [policy('nas.example.com')],
      },
      { managed: [] },
    );
    expect(p.ensure[0]).toMatchObject({
      kind: 'access.update',
      appChanged: true,
      policyChanged: false,
      policyId: 'pol-nas.example.com',
    });
  });

  it('reports a conflict and touches nothing when a foreign app covers the hostname', () => {
    const foreign = app('nas.example.com', { id: 'theirs', name: 'My NAS', policies: [] });
    const p = planAccess(wanted(host()), { apps: [foreign], policies: [] }, { managed: [] });
    expect(p.ensure).toEqual([
      expect.objectContaining({ kind: 'access.conflict', hostname: 'nas.example.com' }),
    ]);
    expect(p.conflicts.get('nas.example.com')).toContain('"My NAS"');
    expect(p.remove).toEqual([]);
  });

  it('deletes Burrow apps it manages that are no longer wanted, with their policy', () => {
    const p = planAccess(
      wanted(),
      { apps: [app('old.example.com')], policies: [policy('old.example.com')] },
      { managed: ['old.example.com'] },
    );
    expect(p.remove).toEqual([
      {
        kind: 'access.delete',
        hostname: 'old.example.com',
        appId: 'app-old.example.com',
        policyIds: ['pol-old.example.com'],
      },
    ]);
  });

  it('never deletes Burrow-named apps this instance does not manage', () => {
    const p = planAccess(
      wanted(),
      {
        apps: [app('other-instance.example.com')],
        policies: [policy('other-instance.example.com')],
      },
      { managed: [] },
    );
    expect(p.remove).toEqual([]);
  });

  it('never deletes foreign apps, even on managed hostnames', () => {
    const foreign = app('old.example.com', { name: 'Hand made' });
    const p = planAccess(
      wanted(),
      { apps: [foreign], policies: [] },
      { managed: ['old.example.com'] },
    );
    expect(p.remove).toEqual([]);
  });

  it('respects the scope of a targeted sync', () => {
    const p = planAccess(
      wanted(host({ hostname: 'new.example.com' })),
      { apps: [app('old.example.com')], policies: [policy('old.example.com')] },
      { managed: ['old.example.com'], scope: new Set(['elsewhere.example.com']) },
    );
    expect(p.ensure).toEqual([]);
    expect(p.remove).toEqual([]);
  });

  it('removes duplicate Burrow apps for one hostname and orphan policies on a full run', () => {
    const dup = app('nas.example.com', { id: 'dup', policies: [] });
    const orphan = policy('gone.example.com');
    const p = planAccess(
      wanted(host()),
      { apps: [app('nas.example.com'), dup], policies: [policy('nas.example.com'), orphan] },
      { managed: ['nas.example.com', 'gone.example.com'] },
    );
    expect(p.remove).toEqual([
      { kind: 'access.delete', hostname: 'nas.example.com', appId: 'dup', policyIds: [] },
      {
        kind: 'access.delete',
        hostname: 'gone.example.com',
        appId: null,
        policyIds: ['pol-gone.example.com'],
      },
    ]);
  });
});
