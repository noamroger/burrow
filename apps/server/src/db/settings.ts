import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { settings } from './schema.js';

/** Known settings keys. */
export const SettingKeys = {
  cloudflareToken: 'cloudflare.token',
  cloudflareAccountId: 'cloudflare.account_id',
  cloudflareAccountName: 'cloudflare.account_name',
  cloudflarePermissions: 'cloudflare.permissions',
  /**
   * Name of the default tunnel while it is being created. Tunnels themselves
   * live in the `tunnels` table (the old `tunnel.id` / `tunnel.managed_ingress`
   * keys are migrated there by 0002_tunnels.sql).
   */
  tunnelName: 'tunnel.name',
  /** Hostnames this Burrow instance created a Cloudflare Access application for. */
  managedAccess: 'access.managed_hostnames',
} as const;

/** Typed JSON key/value store on top of the `settings` table. */
export class SettingsRepository {
  constructor(private readonly db: Db) {}

  get<T>(key: string): T | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    const json = JSON.stringify(value);
    this.db
      .insert(settings)
      .values({ key, value: json })
      .onConflictDoUpdate({ target: settings.key, set: { value: json } })
      .run();
  }

  delete(...keys: string[]): void {
    for (const key of keys) this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}
