import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../src/lib/scrub.js';
import { isConnectedLine, parseCloudflaredLine } from '../src/services/cloudflared-log.js';
import { LogBuffer } from '../src/services/log-buffer.js';

describe('parseCloudflaredLine', () => {
  it('parses time, level and message', () => {
    expect(
      parseCloudflaredLine('2026-11-18T10:00:00Z INF Registered tunnel connection connIndex=0'),
    ).toEqual({
      time: '2026-11-18T10:00:00.000Z',
      level: 'info',
      message: 'Registered tunnel connection connIndex=0',
    });
  });

  it.each([
    ['DBG', 'debug'],
    ['INF', 'info'],
    ['WRN', 'warn'],
    ['ERR', 'error'],
    ['FTL', 'fatal'],
  ])('maps %s to %s', (raw, level) => {
    expect(parseCloudflaredLine(`2026-11-18T10:00:00Z ${raw} hello`).level).toBe(level);
  });

  it('keeps unknown lines as info', () => {
    const now = () => new Date('2026-01-01T00:00:00Z');
    expect(parseCloudflaredLine('panic: something odd', now)).toEqual({
      time: '2026-01-01T00:00:00.000Z',
      level: 'info',
      message: 'panic: something odd',
    });
  });

  it('detects connection registration', () => {
    expect(isConnectedLine('Registered tunnel connection connIndex=0 location=cdg01')).toBe(true);
    expect(isConnectedLine('Starting tunnel')).toBe(false);
  });
});

describe('scrubSecrets', () => {
  const runToken = Buffer.from(
    JSON.stringify({ a: 'acc', t: 'tun', s: 'c2VjcmV0c2VjcmV0c2VjcmV0' }),
  ).toString('base64');

  it('removes tunnel tokens (base64 JSON starting with eyJ)', () => {
    expect(runToken.startsWith('eyJ')).toBe(true);
    const out = scrubSecrets(`DBG raw ${runToken} end`);
    expect(out).toBe('DBG raw [REDACTED] end');
  });

  it('removes key=value secrets and bearer tokens', () => {
    expect(scrubSecrets('using token=abcdef123456 ok')).toBe('using token=[REDACTED] ok');
    expect(scrubSecrets('Authorization: Bearer abcdefgh12345678')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('removes 40-character API tokens', () => {
    const apiToken = 'A'.repeat(20) + 'b'.repeat(10) + '_-' + '1'.repeat(8);
    expect(apiToken).toHaveLength(40);
    expect(scrubSecrets(`token is ${apiToken}.`)).toBe('token is [REDACTED].');
  });

  it('removes explicitly known secrets', () => {
    expect(scrubSecrets('my secret is hunter2hunter2', ['hunter2hunter2'])).toBe(
      'my secret is [REDACTED]',
    );
  });

  it('leaves normal cloudflared output alone', () => {
    const line =
      'Registered tunnel connection connIndex=0 connection=1a2b3c4d-0000-4000-8000-000000000000 ip=198.41.192.7';
    expect(scrubSecrets(line)).toBe(line);
  });
});

describe('LogBuffer', () => {
  it('assigns increasing sequence numbers and caps its size', () => {
    const buf = new LogBuffer(3);
    for (let i = 1; i <= 5; i++) buf.push({ level: 'info', source: 'burrow', message: `m${i}` });
    expect(buf.size).toBe(3);
    expect(buf.recent(10).map((l) => l.seq)).toEqual([3, 4, 5]);
    expect(buf.recent(2).map((l) => l.message)).toEqual(['m4', 'm5']);
  });

  it('resumes after a given sequence number', () => {
    const buf = new LogBuffer(10);
    for (let i = 1; i <= 4; i++) buf.push({ level: 'info', source: 'burrow', message: `m${i}` });
    expect(buf.since(2).map((l) => l.seq)).toEqual([3, 4]);
    expect(buf.since(4)).toEqual([]);
  });

  it('emits every pushed line', () => {
    const buf = new LogBuffer(10);
    const seen: number[] = [];
    buf.on('line', (l) => seen.push(l.seq));
    buf.push({ level: 'warn', source: 'cloudflared', message: 'x' });
    expect(seen).toEqual([1]);
  });
});
