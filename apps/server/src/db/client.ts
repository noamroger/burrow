import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: Db;
  /** The underlying better-sqlite3 connection (for `close()` and health checks). */
  sqlite: Database.Database;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the migrations folder: `dist/drizzle` when running the build,
 * `apps/server/drizzle` when running from sources.
 */
export function findMigrationsFolder(): string {
  const candidates = [resolve(here, '../drizzle'), resolve(here, '../../drizzle')];
  const found = candidates.find((c) => existsSync(join(c, 'meta', '_journal.json')));
  if (!found) throw new Error(`Database migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

/**
 * Open (or create) the SQLite database and apply pending migrations.
 * @param file path to the database file, or `:memory:`
 */
export function openDatabase(file: string): DatabaseHandle {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: findMigrationsFolder() });
  return { db, sqlite };
}
