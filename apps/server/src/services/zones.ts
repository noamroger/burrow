import type { Zone } from '@burrow/shared';
import { count, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { proxyHosts, zones } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import type { CloudflareService } from './cloudflare.js';

/**
 * Zones come live from Cloudflare; the local `zones` table only remembers
 * which ones the admin enabled (and their names, for display when offline).
 */
export class ZoneService {
  constructor(
    private readonly db: Db,
    private readonly cloudflare: CloudflareService,
  ) {}

  private hostCounts(): Map<string, number> {
    const rows = this.db
      .select({ zoneId: proxyHosts.zoneId, n: count() })
      .from(proxyHosts)
      .groupBy(proxyHosts.zoneId)
      .all();
    return new Map(rows.map((r) => [r.zoneId, r.n]));
  }

  /** Live zones merged with the local `enabled` flag. Refreshes stored names. */
  async list(): Promise<Zone[]> {
    const live = await this.cloudflare.listZones();
    const local = new Map(
      this.db
        .select()
        .from(zones)
        .all()
        .map((z) => [z.id, z]),
    );
    const counts = this.hostCounts();
    for (const z of live) {
      const known = local.get(z.id);
      if (known && known.name !== z.name) {
        this.db.update(zones).set({ name: z.name }).where(eq(zones.id, z.id)).run();
      }
    }
    return live
      .map((z) => ({
        id: z.id,
        name: z.name,
        enabled: local.get(z.id)?.enabled ?? false,
        hostCount: counts.get(z.id) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Enable or disable a zone. A zone that still has hosts cannot be disabled. */
  async update(id: string, enabled: boolean): Promise<Zone> {
    const hostCount = this.hostCounts().get(id) ?? 0;
    if (!enabled && hostCount > 0) {
      throw errors.conflict(`This zone still has ${hostCount} proxy host(s). Delete them first.`);
    }
    const live = (await this.cloudflare.listZones()).find((z) => z.id === id);
    const known = this.db.select().from(zones).where(eq(zones.id, id)).get();
    if (!live && !known) throw errors.notFound('Zone');
    const name = live?.name ?? known!.name;
    this.db
      .insert(zones)
      .values({ id, name, enabled })
      .onConflictDoUpdate({ target: zones.id, set: { name, enabled } })
      .run();
    return { id, name, enabled, hostCount };
  }

  /** A locally known zone, or undefined. */
  getLocal(id: string) {
    return this.db.select().from(zones).where(eq(zones.id, id)).get();
  }
}
