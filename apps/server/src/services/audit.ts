import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

/** Append-only audit trail of mutations. Never pass secrets as `target`. */
export class AuditService {
  constructor(private readonly db: Db) {}

  record(userId: number | null, action: string, target?: string): void {
    this.db
      .insert(auditLog)
      .values({ userId, action, target: target ?? null })
      .run();
  }
}
