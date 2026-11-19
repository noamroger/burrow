import { API_TOKEN_PREFIX, type ApiToken, type CreatedApiToken } from '@burrow/shared';
import { and, desc, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';
import { apiTokens, users, type ApiTokenRow } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import type { AuthenticatedSession } from './auth.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Do not write `last_used_at` more than once a minute per token. */
const TOUCH_EVERY_MS = 60_000;

/**
 * Personal API tokens: `Authorization: Bearer burrow_…` instead of a session
 * cookie, for scripts and automation. A token acts as its owner, does not
 * need the CSRF header (it is not sent automatically by browsers), and cannot
 * manage tokens or change the password.
 */
export class ApiTokenService {
  constructor(private readonly db: Db) {}

  list(userId: number): ApiToken[] {
    return this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .orderBy(desc(apiTokens.createdAt))
      .all()
      .map(toApi);
  }

  create(userId: number, name: string): CreatedApiToken {
    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const row = this.db
      .insert(apiTokens)
      .values({
        userId,
        name,
        hint: token.slice(0, API_TOKEN_PREFIX.length + 4),
        tokenHash: sha256(token),
      })
      .returning()
      .get();
    return { ...toApi(row), token };
  }

  remove(userId: number, id: number): ApiTokenRow {
    const row = this.db
      .delete(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
      .returning()
      .get();
    if (!row) throw errors.notFound('API token');
    return row;
  }

  /** Resolve an `Authorization` header to its user, or null. */
  authenticate(header: string | undefined): AuthenticatedSession | null {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    const token = match?.[1];
    if (!token?.startsWith(API_TOKEN_PREFIX)) return null;
    const row = this.db
      .select({ token: apiTokens, user: { id: users.id, email: users.email } })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(eq(apiTokens.tokenHash, sha256(token)))
      .get();
    if (!row) return null;
    const now = nowIso();
    if (
      !row.token.lastUsedAt ||
      Date.parse(now) - Date.parse(row.token.lastUsedAt) > TOUCH_EVERY_MS
    ) {
      this.db
        .update(apiTokens)
        .set({ lastUsedAt: now })
        .where(eq(apiTokens.id, row.token.id))
        .run();
    }
    return {
      user: row.user,
      via: 'token',
      session: {
        id: `token:${row.token.id}`,
        userId: row.user.id,
        csrfToken: '',
        expiresAt: '9999-12-31T23:59:59.999Z',
        createdAt: row.token.createdAt,
      },
    };
  }
}

function toApi(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
