/**
 * SQLite schema (Drizzle). After changing it, run `pnpm db:generate` to write
 * a new versioned migration into `apps/server/drizzle/` and commit it.
 *
 * Timestamps are ISO 8601 strings; booleans are stored as 0/1 integers.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamp = (name: string) =>
  text(name)
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

/** Admin accounts (a single one in V1). */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at'),
});

/** Server-side sessions. `id` is the SHA-256 of the cookie value, never the value itself. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Key/value settings. Values are JSON; secrets are encrypted before being stored. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** Cloudflare zones the admin allowed Burrow to publish into. */
export const zones = sqliteTable('zones', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
});

/** Desired state of every published service. */
export const proxyHosts = sqliteTable(
  'proxy_hosts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subdomain: text('subdomain').notNull(),
    zoneId: text('zone_id').notNull(),
    hostname: text('hostname').notNull(),
    service: text('service').notNull(),
    path: text('path').notNull().default(''),
    noTlsVerify: integer('no_tls_verify', { mode: 'boolean' }).notNull().default(false),
    httpHostHeader: text('http_host_header').notNull().default(''),
    originServerName: text('origin_server_name').notNull().default(''),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Cloudflare Access protection (one Access application per hostname, see docs/adr/0005). */
    accessEnabled: integer('access_enabled', { mode: 'boolean' }).notNull().default(false),
    accessEmails: text('access_emails', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    accessEmailDomains: text('access_email_domains', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    accessSessionDuration: text('access_session_duration').notNull().default('24h'),
    dnsRecordId: text('dns_record_id'),
    syncStatus: text('sync_status', { enum: ['pending', 'synced', 'error', 'drift'] })
      .notNull()
      .default('pending'),
    syncError: text('sync_error'),
    lastSyncedAt: text('last_synced_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at').$onUpdate(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex('proxy_hosts_hostname_path_idx').on(t.hostname, t.path),
    index('proxy_hosts_zone_idx').on(t.zoneId),
  ],
);

/** Who changed what. Never contains secrets. */
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id'),
  action: text('action').notNull(),
  target: text('target'),
  createdAt: timestamp('created_at'),
});

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ZoneRow = typeof zones.$inferSelect;
export type ProxyHostRow = typeof proxyHosts.$inferSelect;
export type NewProxyHostRow = typeof proxyHosts.$inferInsert;
