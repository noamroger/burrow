/**
 * Audit log: who changed what and when, with an undo for the changes that
 * can be reversed safely.
 */
import { z } from 'zod';

/** Categories used by the filters (first segment of an action). */
export const AUDIT_CATEGORIES = [
  'host',
  'tunnel',
  'zone',
  'cloudflare',
  'sync',
  'drift',
  'docker',
  'maintenance',
  'homepage',
  'badge',
  'notification',
  'backup',
  'config',
  'token',
  'auth',
  'setup',
] as const;
export const auditCategorySchema = z.enum(AUDIT_CATEGORIES);
export type AuditCategory = z.infer<typeof auditCategorySchema>;

/** One field that changed, as a dotted path (`access.emails`). */
export const auditChangeSchema = z.object({
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
export type AuditChange = z.infer<typeof auditChangeSchema>;

/** What changed. Never holds secrets. */
export const auditDetailsSchema = z.object({
  changes: z.array(auditChangeSchema).optional(),
  /** Free text, e.g. "recovery code" for a sign-in. */
  note: z.string().optional(),
});
export type AuditDetails = z.infer<typeof auditDetailsSchema>;

export const auditEntrySchema = z.object({
  id: z.number().int(),
  createdAt: z.string(),
  action: z.string(),
  category: z.string(),
  /** What was changed, e.g. a hostname or a tunnel name. */
  target: z.string().nullable(),
  actor: z.object({
    /** Email, `API token "name"`, `Docker discovery`, `System`… */
    label: z.string(),
    userId: z.number().int().nullable(),
    ip: z.string().nullable(),
  }),
  details: auditDetailsSchema.nullable(),
  /** True when the change can be undone (not undone yet, a reversible action). */
  undoable: z.boolean(),
  undoneAt: z.string().nullable(),
  /** Id of the entry that undid this one. */
  undoneBy: z.number().int().nullable(),
  /** On an undo entry: the id of the change it reversed. */
  revertOf: z.number().int().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** GET /api/audit query. Newest first; pass `before` = the last id to page. */
export const auditQuerySchema = z.object({
  category: auditCategorySchema.optional(),
  /** Text searched in the action, the target and the actor. */
  q: z.string().trim().max(200).optional(),
  /** Only changes that can still be undone. */
  undoable: z.enum(['true', 'false']).optional(),
  /** ISO 8601 bounds. */
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.input<typeof auditQuerySchema>;

/** GET /api/audit -> 200 */
export const auditPageSchema = z.object({
  entries: z.array(auditEntrySchema),
  /** Pass as `before` to get the next page; null on the last page. */
  nextBefore: z.number().int().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

/** POST /api/audit/:id/undo -> 200: the reversed entry and the new undo entry. */
export const auditUndoResultSchema = z.object({
  undone: auditEntrySchema,
  entry: auditEntrySchema,
});
export type AuditUndoResult = z.infer<typeof auditUndoResultSchema>;
