import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/lib/secretbox.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'burrow-box-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('SecretBox', () => {
  it('round-trips and uses a fresh IV every time', () => {
    const box = SecretBox.fromPassphrase('x'.repeat(32));
    const a = box.encrypt('my cloudflare token');
    const b = box.encrypt('my cloudflare token');
    expect(a).not.toBe(b);
    expect(a).not.toContain('my cloudflare token');
    expect(a.startsWith('v1:')).toBe(true);
    expect(box.decrypt(a)).toBe('my cloudflare token');
  });

  it('derives the same key from the same BURROW_SECRET', () => {
    const encrypted = SecretBox.fromPassphrase('s'.repeat(40)).encrypt('hello');
    expect(SecretBox.fromPassphrase('s'.repeat(40)).decrypt(encrypted)).toBe('hello');
  });

  it('fails with a wrong key', () => {
    const encrypted = SecretBox.fromPassphrase('a'.repeat(32)).encrypt('hello');
    expect(() => SecretBox.fromPassphrase('b'.repeat(32)).decrypt(encrypted)).toThrow(/decrypt/);
  });

  it('detects tampering', () => {
    const box = SecretBox.fromPassphrase('a'.repeat(32));
    const [v, iv, tag, data] = box.encrypt('hello').split(':');
    const flipped = Buffer.from(data!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => box.decrypt([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
    expect(() => box.decrypt('garbage')).toThrow(/format/);
  });

  it('generates and persists a 0600 key file when no secret is given', () => {
    const dir = tmp();
    const box = SecretBox.load(dir);
    const file = join(dir, '.secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(file, 'utf8'), 'base64')).toHaveLength(32);
    const encrypted = box.encrypt('persisted');
    expect(SecretBox.load(dir).decrypt(encrypted)).toBe('persisted');
  });

  it('prefers BURROW_SECRET over the key file', () => {
    const dir = tmp();
    const encrypted = SecretBox.load(dir, 'p'.repeat(32)).encrypt('x');
    expect(() => SecretBox.load(dir).decrypt(encrypted)).toThrow();
    expect(SecretBox.load(dir, 'p'.repeat(32)).decrypt(encrypted)).toBe('x');
  });
});
