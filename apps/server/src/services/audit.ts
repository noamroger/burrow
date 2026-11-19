import type { AuditChange, AuditDetails, AuditEntry, AuditPage, AuditQuery } from '@burrow/shared';
import { auditQuerySchema } from '@burrow/shared';
import { and, desc, eq, gte, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db/client.js';
import { auditLog, users, type AuditRow } from '../db/schema.js';
import { nowIso } from '../lib/time.js';
import type { UndoSpec } from './undo-spec.js';

/** Who made a change. */
export interface Actor {
  userId: number | null;
  /** As shown in the log: an email, `API token "ci"`, `Docker discovery`, `System`. */
  label: string;
  ip?: string | null;
}

/** An actor, a user id (resolved to its email), or null for Burrow itself. */
export type ActorLike = Actor | number | null;

export const SYSTEM: Actor = { userId: null, label: 'System' };
export const DOCKER_DISCOVERY: Actor = { userId: null, label: 'Docker discovery' };

export interface RecordOptions {
  details?: AuditDetails | null;
  undo?: UndoSpec | null;
  /** This entry undoes that one. */
  revertOf?: number;
}

/** Stable JSON (sorted keys), to compare snapshots. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/**
 * Fields that differ between two snapshots, as dotted paths. Arrays are
 * compared as a whole.
 */
export function diff(before: unknown, after: unknown, prefix = ''): AuditChange[] {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diff(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  if (stableJson(before) === stableJson(after)) return [];
  return [{ field: prefix || 'value', before: before ?? null, after: after ?? null }];
}

/** Escape `%` and `_` for LIKE. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Append-only trail of changes: who (admin, API token, Docker discovery,
 * Burrow itself), what, when, from which IP, the fields that changed, and how
 * to undo it when that is safe. Never pass secrets in a target or details.
 */
export class AuditService {
  /** Set while an undo runs: entries written meanwhile are marked as its result. */
  private readonly reverting = new AsyncLocalStorage<{ revertOf: number; ids: number[] }>();

  constructor(private readonly db: Db) {}

  /**
   * Run `fn` as the undo of entry `revertOf`: every entry it writes (even
   * from deep inside a service) gets `revertOf`. Returns the ids written.
   */
  async asRevertOf<T>(
    revertOf: number,
    fn: () => Promise<T>,
  ): Promise<{ result: T; ids: number[] }> {
    const store = { revertOf, ids: [] as number[] };
    const result = await this.reverting.run(store, fn);
    return { result, ids: store.ids };
  }

  private resolve(by: ActorLike): Actor {
    if (by === null) return SYSTEM;
    if (typeof by === 'number') {
      const user = this.db.select({ email: users.email }).from(users).where(eq(users.id, by)).get();
      return { userId: by, label: user?.email ?? `user #${by}` };
    }
    return by;
  }

  /** Write an entry. Returns its id. */
  record(by: ActorLike, action: string, target?: string | null, opts: RecordOptions = {}): number {
    const actor = this.resolve(by);
    const row = this.db
      .insert(auditLog)
      .values({
        userId: actor.userId,
        actor: actor.label,
        ip: actor.ip ?? null,
        category: action.split('.')[0] ?? action,
        action,
        target: target ?? null,
        details: opts.details && Object.keys(opts.details).length > 0 ? opts.details : null,
        undo: opts.undo ?? null,
        revertOf: opts.revertOf ?? this.reverting.getStore()?.revertOf ?? null,
      })
      .returning({ id: auditLog.id })
      .get();
    this.reverting.getStore()?.ids.push(row.id);
    return row.id;
  }

  row(id: number): AuditRow | undefined {
    return this.db.select().from(auditLog).where(eq(auditLog.id, id)).get();
  }

  /** Mark an entry as undone by another one. */
  markUndone(id: number, byEntryId: number): void {
    this.db
      .update(auditLog)
      .set({ undoneAt: nowIso(), undoneById: byEntryId })
      .where(eq(auditLog.id, id))
      .run();
  }

  toApi(row: AuditRow): AuditEntry {
    return {
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      category: row.category,
      target: row.target,
      actor: { label: row.actor, userId: row.userId, ip: row.ip },
      details: row.details ?? null,
      undoable: row.undo !== null && row.undoneAt === null,
      undoneAt: row.undoneAt,
      undoneBy: row.undoneById,
      revertOf: row.revertOf,
    };
  }

  /** A page of entries, newest first. */
  list(raw: AuditQuery = {}): AuditPage {
    const query = auditQuerySchema.parse(raw);
    const where: (SQL | undefined)[] = [];
    if (query.category) where.push(eq(auditLog.category, query.category));
    if (query.q) {
      const pattern = `%${likeEscape(query.q)}%`;
      const like = (col: AnySQLiteColumn) => sql`${col} LIKE ${pattern} ESCAPE '\\'`;
      where.push(
        or(like(auditLog.action), like(auditLog.target), like(auditLog.actor), like(auditLog.ip)),
      );
    }
    if (query.undoable === 'true') where.push(isNotNull(auditLog.undo), isNull(auditLog.undoneAt));
    if (query.from) where.push(gte(auditLog.createdAt, new Date(query.from).toISOString()));
    if (query.to) where.push(lte(auditLog.createdAt, new Date(query.to).toISOString()));
    if (query.before) where.push(lt(auditLog.id, query.before));

    const rows = this.db
      .select()
      .from(auditLog)
      .where(and(...where))
      .orderBy(desc(auditLog.id))
      .limit(query.limit + 1)
      .all();
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      entries: page.map((r) => this.toApi(r)),
      nextBefore: more ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
