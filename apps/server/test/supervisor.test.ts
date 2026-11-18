import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { LogBuffer } from '../src/services/log-buffer.js';
import {
  Supervisor,
  type SupervisorOptions,
  type SupervisorStatus,
} from '../src/services/supervisor.js';
import { FAKE_CLOUDFLARED, waitFor } from './helpers.js';

const RUN_TOKEN = Buffer.from(
  JSON.stringify({ a: 'acc', t: 'tunnel', s: 'c3VwZXItc2VjcmV0LXR1bm5lbC1zZWNyZXQ=' }),
).toString('base64');

const supervisors: Supervisor[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function make(opts: Partial<SupervisorOptions> = {}) {
  const logs = new LogBuffer(2000);
  const states: SupervisorStatus['state'][] = [];
  const sup = new Supervisor({
    binaryPath: FAKE_CLOUDFLARED,
    getToken: async () => RUN_TOKEN,
    logs,
    logger: pino({ level: 'silent' }),
    backoff: { initialMs: 50, maxMs: 400, resetAfterMs: 10_000 },
    killTimeoutMs: 500,
    ...opts,
  });
  sup.on('state', (s) => states.push(s.state));
  supervisors.push(sup);
  return { sup, logs, states };
}

describe('Supervisor', () => {
  it('detects the cloudflared version', async () => {
    const { sup } = make();
    expect(await sup.detectVersion()).toBe('2026.11.0');
    expect(sup.status().cloudflaredVersion).toBe('2026.11.0');
  });

  it('returns null for a missing binary', async () => {
    const { sup } = make({ binaryPath: '/nonexistent/cloudflared' });
    expect(await sup.detectVersion()).toBeNull();
  });

  it('starts, becomes running on "Registered tunnel connection", then stops gracefully', async () => {
    const { sup, logs, states } = make();
    await sup.start();
    expect(sup.status().pid).toEqual(expect.any(Number));
    await waitFor(() => sup.status().state === 'running');
    expect(states).toEqual(['starting', 'starting', 'running']);
    expect(
      logs
        .recent()
        .some(
          (l) =>
            l.source === 'cloudflared' &&
            l.level === 'info' &&
            l.message.startsWith('Registered tunnel connection'),
        ),
    ).toBe(true);

    await sup.stop();
    expect(sup.status()).toMatchObject({ state: 'stopped', pid: null, lastExitCode: 0 });
    expect(logs.recent().some((l) => l.message.includes('graceful shutdown'))).toBe(true);
  });

  it('passes the token through the environment, not argv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-sup-'));
    dirs.push(dir);
    const script = join(dir, 'print-env.sh');
    writeFileSync(
      script,
      '#!/bin/sh\necho "args: $*"\necho "has token: ${TUNNEL_TOKEN:+yes}"\necho "secret: ${BURROW_SECRET:-none}"\nexit 0\n',
      { mode: 0o755 },
    );
    process.env.BURROW_SECRET = 'should-not-leak-to-the-child-process';
    try {
      const { sup, logs } = make({ binaryPath: script });
      await sup.start();
      await waitFor(() => logs.recent().some((l) => l.message.startsWith('secret:')));
      const text = logs
        .recent()
        .map((l) => l.message)
        .join('\n');
      expect(text).toContain('args: tunnel --no-autoupdate --metrics 127.0.0.1:20241 run');
      expect(text).toContain('has token: yes');
      expect(text).toContain('secret: none');
      expect(text).not.toContain(RUN_TOKEN);
    } finally {
      delete process.env.BURROW_SECRET;
    }
  });

  it('restarts with exponential backoff after crashes, and recovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-sup-'));
    dirs.push(dir);
    const crashFile = join(dir, 'crash');
    writeFileSync(crashFile, '');
    const { sup, logs } = make({ env: { FAKE_CLOUDFLARED_CRASH_FILE: crashFile } });
    const delays: number[] = [];
    sup.on('state', (s) => {
      if (s.state === 'backoff' && s.nextRetryAt)
        delays.push(Date.parse(s.nextRetryAt) - Date.now());
    });

    await sup.start();
    await waitFor(() => sup.status().restarts >= 3);
    expect(sup.status().lastExitCode).toBe(1);
    expect(logs.recent().some((l) => l.level === 'fatal')).toBe(true);
    // 50ms, 100ms, 200ms...: each delay roughly doubles.
    expect(delays[1]!).toBeGreaterThan(delays[0]! * 1.5);
    expect(delays[2]!).toBeGreaterThan(delays[1]! * 1.5);

    rmSync(crashFile);
    await waitFor(() => sup.status().state === 'running', 5000);
    expect(sup.status().nextRetryAt).toBeNull();
  });

  it('caps the backoff delay', async () => {
    const { sup } = make({
      env: { FAKE_CLOUDFLARED_CRASH: '1' },
      backoff: { initialMs: 20, maxMs: 60 },
    });
    const delays: number[] = [];
    sup.on('state', (s) => {
      if (s.state === 'backoff' && s.nextRetryAt)
        delays.push(Date.parse(s.nextRetryAt) - Date.now());
    });
    await sup.start();
    await waitFor(() => sup.status().restarts >= 5);
    expect(Math.max(...delays)).toBeLessThanOrEqual(70);
  });

  it('backs off when the token cannot be fetched', async () => {
    let calls = 0;
    const { sup, logs } = make({
      getToken: async () => {
        calls++;
        if (calls < 3) throw new Error('Cloudflare is down');
        return RUN_TOKEN;
      },
    });
    await sup.start();
    await waitFor(() => sup.status().state === 'running', 5000);
    expect(calls).toBe(3);
    expect(
      logs.recent().filter((l) => l.message.includes('Could not get the tunnel token')),
    ).toHaveLength(2);
  });

  it('kills cloudflared with SIGKILL when it ignores SIGTERM', async () => {
    const { sup, logs } = make({ env: { FAKE_CLOUDFLARED_IGNORE_TERM: '1' }, killTimeoutMs: 300 });
    await sup.start();
    await waitFor(() => sup.status().state === 'running');
    const started = Date.now();
    await sup.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(sup.status().state).toBe('stopped');
    expect(logs.recent().some((l) => l.message.includes('killing it'))).toBe(true);
  });

  it('scrubs the tunnel token and known secrets from cloudflared output', async () => {
    const { sup, logs } = make({
      env: { FAKE_CLOUDFLARED_LEAK_TOKEN: '1' },
      knownSecrets: () => ['api-token-value-123456'],
    });
    await sup.start();
    await waitFor(() => sup.status().state === 'running');
    const all = logs
      .recent()
      .map((l) => l.message)
      .join('\n');
    expect(all).not.toContain(RUN_TOKEN);
    expect(all).toContain('[REDACTED]');
  });

  it('reports a missing binary and retries', async () => {
    const { sup, logs } = make({ binaryPath: '/nonexistent/cloudflared' });
    await sup.start();
    await waitFor(() => sup.status().restarts >= 1);
    expect(
      logs.recent().some((l) => l.message.includes('Could not run /nonexistent/cloudflared')),
    ).toBe(true);
  });

  it('restart() replaces the process', async () => {
    const { sup } = make();
    await sup.start();
    await waitFor(() => sup.status().state === 'running');
    const pid = sup.status().pid;
    await sup.restart();
    await waitFor(() => sup.status().state === 'running');
    expect(sup.status().pid).not.toBe(pid);
  });

  it('disable() sets the disabled state', async () => {
    const { sup } = make();
    await sup.start();
    await sup.disable();
    expect(sup.status().state).toBe('disabled');
  });
});
