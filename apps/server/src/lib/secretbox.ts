import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_SALT = 'burrow/secretbox/v1';
const HKDF_INFO = 'burrow settings encryption key';

/**
 * Authenticated encryption for secrets stored in SQLite (AES-256-GCM).
 *
 * Ciphertext format: `v1:<iv base64>:<tag base64>:<ciphertext base64>`.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /** Build a box from a raw 32-byte key. */
  static fromKey(key: Buffer): SecretBox {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    return new SecretBox(key);
  }

  /** Derive the key from a passphrase (`BURROW_SECRET`) with HKDF-SHA256. */
  static fromPassphrase(passphrase: string): SecretBox {
    const key = Buffer.from(hkdfSync('sha256', passphrase, HKDF_SALT, HKDF_INFO, 32));
    return new SecretBox(key);
  }

  /**
   * Use `BURROW_SECRET` when provided, otherwise a random key generated once
   * and persisted to `<dataDir>/.secret` with mode 0600.
   */
  static load(dataDir: string, passphrase?: string): SecretBox {
    if (passphrase) return SecretBox.fromPassphrase(passphrase);
    const file = join(dataDir, '.secret');
    if (existsSync(file)) {
      const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
      return SecretBox.fromKey(key);
    }
    mkdirSync(dirname(file), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return SecretBox.fromKey(key);
  }

  /** Encrypt a UTF-8 string. Each call uses a fresh random IV. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(
      ':',
    );
  }

  /** Decrypt a value produced by {@link encrypt}. Throws if it was tampered with or the key differs. */
  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split(':');
    if (version !== VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
      throw new Error('Unsupported secret format');
    }
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Corrupted secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error(
        'Unable to decrypt a stored secret. Was BURROW_SECRET or /data/.secret changed?',
      );
    }
  }
}
