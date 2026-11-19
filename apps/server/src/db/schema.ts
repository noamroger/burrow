/**
 * SQLite schema (Drizzle). After changing it, run `pnpm db:generate` to write
 * a new versioned migration into `apps/server/drizzle/` and commit it.
 *
 * Timestamps are ISO 8601 strings; booleans are stored as 0/1 integers.
 */
import type { MaintenancePage } from '@burrow/shared';
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

/** Personal API tokens for scripts. Only a keyed hash (HMAC-SHA256) of a token is stored. */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters of the token, for display. */
    hint: text('hint').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    lastUsedAt: text('last_used_at'),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
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

/**
 * Tunnels Burrow manages: the one it created at setup, others created from the
 * UI, and existing tunnels imported from the account.
 */
export const tunnels = sqliteTable('tunnels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Cloudflare tunnel UUID. Changes if Burrow has to recreate a deleted tunnel. */
  cfId: text('cf_id').notNull().unique(),
  name: text('name').notNull(),
  origin: text('origin', { enum: ['created', 'imported'] })
    .notNull()
    .default('created'),
  /** Run cloudflared for this tunnel inside the container. */
  runConnector: integer('run_connector', { mode: 'boolean' }).notNull().default(true),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  /** Ingress rules Burrow wrote on this tunnel, as `hostname|path` keys, so orphans can be recognised. */
  managedIngress: text('managed_ingress', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  createdAt: timestamp('created_at'),
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
    /** Tunnel the host is published through. NULL means "the default tunnel" (assigned on next sync). */
    tunnelId: integer('tunnel_id').references(() => tunnels.id, { onDelete: 'set null' }),
    /** Extra `originRequest` keys kept from an imported route (connectTimeout, http2Origin…). */
    originRequestExtra: text('origin_request_extra', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
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
    /** Service template the host was made from (`jellyfin`, `proxmox`…), for display. */
    template: text('template'),
    /** `docker` when the host is managed by container labels. */
    source: text('source', { enum: ['manual', 'docker'] })
      .notNull()
      .default('manual'),
    /** For Docker hosts: the container name. */
    sourceRef: text('source_ref'),
    /** Temporary host: removed automatically after this time (ISO 8601). */
    expiresAt: text('expires_at'),
    /** Maintenance mode: the route points at Burrow's maintenance server. */
    maintenanceEnabled: integer('maintenance_enabled', { mode: 'boolean' })
      .notNull()
      .default(false),
    maintenanceUntil: text('maintenance_until'),
    /** Page for this host only (MaintenancePage JSON); null = default page. */
    maintenancePage: text('maintenance_page', { mode: 'json' }).$type<MaintenancePage | null>(),
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
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type ZoneRow = typeof zones.$inferSelect;
export type TunnelRow = typeof tunnels.$inferSelect;
export type ProxyHostRow = typeof proxyHosts.$inferSelect;
export type NewProxyHostRow = typeof proxyHosts.$inferInsert;
