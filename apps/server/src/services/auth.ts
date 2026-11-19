import { hash, verify } from '@node-rs/argon2';
import { count, eq, and, ne, lt } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import { sessions, users, type SessionRow, type UserRow } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

/** argon2id parameters (OWASP recommendation: m=19 MiB, t=2, p=1). */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Sliding expiry: extend the session when less than this remains. */
const RENEW_WHEN_REMAINING_MS = 6 * 24 * 60 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface NewSession {
  /** Value for the session cookie. Only its SHA-256 is stored. */
  cookieValue: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface AuthenticatedSession {
  user: Pick<UserRow, 'id' | 'email'>;
  session: SessionRow;
  /** How the request authenticated: a browser session cookie or an API token. */
  via?: 'session' | 'token';
  /** Name of the API token, when `via` is `token` (for the audit log). */
  tokenName?: string;
  /** Set when the expiry was extended and the cookie should be re-sent. */
  renewedUntil?: Date;
}

/**
 * Admin accounts and server-side sessions.
 * Passwords are hashed with argon2id; session ids are random 32-byte values
 * stored hashed, so a leaked database does not leak live sessions.
 */
export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly db: Db) {}

  /** True once the admin account exists (the setup lock). */
  hasUser(): boolean {
    const row = this.db.select({ n: count() }).from(users).get();
    return (row?.n ?? 0) > 0;
  }

  /** Create the first admin. Fails with `SETUP_ALREADY_DONE` if any user exists. */
  async createAdmin(email: string, password: string): Promise<UserRow> {
    if (this.hasUser()) throw new AppError('SETUP_ALREADY_DONE', 'Setup is already complete.', 409);
    const passwordHash = await hash(password, ARGON2_OPTIONS);
    // Re-check inside a transaction: two concurrent setups must not both win.
    return this.db.transaction((tx) => {
      const n = tx.select({ n: count() }).from(users).get()?.n ?? 0;
      if (n > 0) throw new AppError('SETUP_ALREADY_DONE', 'Setup is already complete.', 409);
      return tx.insert(users).values({ email, passwordHash }).returning().get();
    });
  }

  /** Check credentials. Same error and similar timing whether the email exists or not. */
  async login(email: string, password: string): Promise<UserRow> {
    const user = this.db.select().from(users).where(eq(users.email, email)).get();
    if (!user) {
      this.dummyHash ??= hash(randomToken(), ARGON2_OPTIONS);
      await verify(await this.dummyHash, password).catch(() => false);
      throw new AppError('UNAUTHORIZED', 'Invalid email or password.', 401);
    }
    const ok = await verify(user.passwordHash, password).catch(() => false);
    if (!ok) throw new AppError('UNAUTHORIZED', 'Invalid email or password.', 401);
    return user;
  }

  /** Start a new session for a user. */
  createSession(userId: number): NewSession {
    const cookieValue = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    this.db
      .insert(sessions)
      .values({ id: sha256(cookieValue), userId, csrfToken, expiresAt: expiresAt.toISOString() })
      .run();
    this.db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())).run();
    return { cookieValue, csrfToken, expiresAt };
  }

  /** Resolve a session cookie. Expired or unknown sessions return null. */
  getSession(cookieValue: string | undefined): AuthenticatedSession | null {
    if (!cookieValue) return null;
    const id = sha256(cookieValue);
    const row = this.db
      .select({ session: sessions, user: { id: users.id, email: users.email } })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .get();
    if (!row) return null;
    const expires = new Date(row.session.expiresAt).getTime();
    const now = Date.now();
    if (expires <= now) {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      return null;
    }
    if (expires - now < RENEW_WHEN_REMAINING_MS) {
      const renewedUntil = new Date(now + SESSION_TTL_MS);
      this.db
        .update(sessions)
        .set({ expiresAt: renewedUntil.toISOString() })
        .where(eq(sessions.id, id))
        .run();
      return { ...row, renewedUntil };
    }
    return row;
  }

  /** End a session (logout). */
  deleteSession(cookieValue: string | undefined): void {
    if (!cookieValue) return;
    this.db
      .delete(sessions)
      .where(eq(sessions.id, sha256(cookieValue)))
      .run();
  }

  /** A user by id (after a second factor). */
  findUser(userId: number): UserRow {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
    return user;
  }

  /** Check the password of a signed-in user (to confirm a sensitive change). */
  async confirmPassword(userId: number, password: string): Promise<void> {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
    const ok = await verify(user.passwordHash, password).catch(() => false);
    if (!ok) throw new AppError('VALIDATION_ERROR', 'The password is incorrect.', 400);
  }

  /**
   * Set a new password without the current one (the `burrow-reset-password`
   * script) and sign out every session.
   */
  async resetPassword(userId: number, next: string): Promise<void> {
    const passwordHash = await hash(next, ARGON2_OPTIONS);
    this.db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
    this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }

  /** Change a password and revoke every other session of the user. */
  async changePassword(
    userId: number,
    current: string,
    next: string,
    keepSessionId: string,
  ): Promise<void> {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
    const ok = await verify(user.passwordHash, current).catch(() => false);
    if (!ok) throw new AppError('VALIDATION_ERROR', 'The current password is incorrect.', 400);
    const passwordHash = await hash(next, ARGON2_OPTIONS);
    this.db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
    this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
      .run();
  }
}
