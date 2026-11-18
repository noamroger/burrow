/**
 * The Burrow API contract.
 *
 * Every request body and response shape exchanged between the server and the
 * web UI is defined here with zod. The server validates with these schemas and
 * the web client infers its types from them. Change the API here first.
 *
 * All routes are under `/api`. Mutating requests (POST, PUT, PATCH, DELETE)
 * from an authenticated session must send the `X-CSRF-Token` header with the
 * value returned by `GET /api/auth/me`.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Common                                                              */
/* ------------------------------------------------------------------ */

/** Error body returned by every failing endpoint (4xx/5xx). */
export const apiErrorSchema = z.object({
  error: z.object({
    /** Stable machine-readable code, e.g. `VALIDATION_ERROR`, `DNS_CONFLICT`. */
    code: z.string(),
    /** Human readable message, safe to display. Never contains secrets. */
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CSRF_INVALID',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'SETUP_ALREADY_DONE',
  'SETUP_REQUIRED',
  'CLOUDFLARE_NOT_CONFIGURED',
  'CLOUDFLARE_TOKEN_INVALID',
  'CLOUDFLARE_PERMISSION_MISSING',
  'CLOUDFLARE_API_ERROR',
  'DNS_CONFLICT',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/* ------------------------------------------------------------------ */
/* Setup & auth                                                        */
/* ------------------------------------------------------------------ */

/** GET /api/setup/status (public) */
export const setupStatusSchema = z.object({
  /** True once the admin account exists. */
  userCreated: z.boolean(),
  /** True once a valid Cloudflare token and account are saved. */
  cloudflareConfigured: z.boolean(),
  /** True once the tunnel exists. */
  tunnelReady: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256);

/** POST /api/setup/admin (public, only while no user exists) -> 201 MeResponse, sets session cookie */
export const createAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
});
export type CreateAdminInput = z.infer<typeof createAdminSchema>;

/** POST /api/auth/login (public, rate limited) -> 200 MeResponse, sets session cookie */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** POST /api/auth/logout -> 204 */

/** GET /api/auth/me -> 200 (401 when not logged in) */
export const meResponseSchema = z.object({
  user: z.object({ id: z.number().int(), email: z.string() }),
  csrfToken: z.string(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** POST /api/auth/password -> 204 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/* ------------------------------------------------------------------ */
/* Cloudflare settings                                                 */
/* ------------------------------------------------------------------ */

/** PUT /api/cloudflare/token -> 200 CloudflareSettings. Verifies the token before saving. */
export const saveTokenSchema = z.object({
  token: z.string().trim().min(20).max(200),
  /** Required only when the token can see more than one account. */
  accountId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
});
export type SaveTokenInput = z.infer<typeof saveTokenSchema>;

export const permissionCheckSchema = z.object({
  /** e.g. "Account › Cloudflare Tunnel › Edit" */
  name: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
});
export type PermissionCheck = z.infer<typeof permissionCheckSchema>;

/** GET /api/cloudflare -> 200. The token itself is never returned. */
export const cloudflareSettingsSchema = z.object({
  configured: z.boolean(),
  /** Last 4 characters of the token, for display only. */
  tokenHint: z.string().nullable(),
  account: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Accounts visible with the token, when the user must choose one. */
  availableAccounts: z.array(z.object({ id: z.string(), name: z.string() })),
  permissions: z.array(permissionCheckSchema),
});
export type CloudflareSettings = z.infer<typeof cloudflareSettingsSchema>;

/** DELETE /api/cloudflare/token -> 204. Stops cloudflared, forgets the token. Hosts stay in DB. */

/* ------------------------------------------------------------------ */
/* Zones                                                               */
/* ------------------------------------------------------------------ */

export const zoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Whether the admin allowed Burrow to publish hosts in this zone. */
  enabled: z.boolean(),
  /** Number of proxy hosts in this zone. */
  hostCount: z.number().int(),
});
export type Zone = z.infer<typeof zoneSchema>;

/** GET /api/zones -> 200 { zones } (fetched live from Cloudflare, merged with local `enabled`) */
export const zoneListSchema = z.object({ zones: z.array(zoneSchema) });
export type ZoneList = z.infer<typeof zoneListSchema>;

/** PATCH /api/zones/:id -> 200 Zone. Cannot disable a zone that still has hosts (409). */
export const updateZoneSchema = z.object({ enabled: z.boolean() });
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;

/* ------------------------------------------------------------------ */
/* Tunnel                                                              */
/* ------------------------------------------------------------------ */

export const SUPERVISOR_STATES = ['stopped', 'starting', 'running', 'backoff', 'disabled'] as const;
export const supervisorStateSchema = z.enum(SUPERVISOR_STATES);
export type SupervisorState = z.infer<typeof supervisorStateSchema>;

export const TUNNEL_STATUSES = ['inactive', 'degraded', 'healthy', 'down', 'unknown'] as const;
export const tunnelStatusSchema = z.enum(TUNNEL_STATUSES);
export type TunnelStatus = z.infer<typeof tunnelStatusSchema>;

export const connectorSchema = z.object({
  id: z.string(),
  version: z.string(),
  arch: z.string(),
  runAt: z.string().nullable(),
  connections: z.array(
    z.object({
      colo: z.string(),
      openedAt: z.string(),
      originIp: z.string(),
    }),
  ),
});
export type Connector = z.infer<typeof connectorSchema>;

/** GET /api/tunnel -> 200 */
export const tunnelInfoSchema = z.object({
  tunnel: z
    .object({
      id: z.string(),
      name: z.string(),
      status: tunnelStatusSchema,
      createdAt: z.string(),
    })
    .nullable(),
  connectors: z.array(connectorSchema),
  supervisor: z.object({
    state: supervisorStateSchema,
    pid: z.number().int().nullable(),
    restarts: z.number().int(),
    startedAt: z.string().nullable(),
    lastExitCode: z.number().int().nullable(),
    nextRetryAt: z.string().nullable(),
    cloudflaredVersion: z.string().nullable(),
  }),
});
export type TunnelInfo = z.infer<typeof tunnelInfoSchema>;

/** POST /api/tunnel/restart -> 202. POST /api/tunnel/stop -> 202. POST /api/tunnel/start -> 202. */

/* ------------------------------------------------------------------ */
/* Proxy hosts                                                         */
/* ------------------------------------------------------------------ */

/** DNS label: letters, digits, hyphens; `@` means the zone apex. */
export const subdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(@|(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)$/,
    'Use letters, digits and hyphens (or @ for the zone apex)',
  );

/** Origin URL reachable from the Burrow container. */
export const serviceUrlSchema = z
  .string()
  .trim()
  .regex(
    /^(https?|tcp|ssh|rdp|unix|unix\+tls|smb):\/\/\S+$/,
    'Use a URL like http://192.168.1.20:8080 or http://my-container:3000',
  )
  .max(2048);

/** Path regex as understood by cloudflared, e.g. `^/api`. Empty = all paths. */
export const ingressPathSchema = z.string().trim().max(512);

export const proxyHostInputSchema = z.object({
  subdomain: subdomainSchema,
  zoneId: z.string().regex(/^[a-f0-9]{32}$/),
  service: serviceUrlSchema,
  path: ingressPathSchema.optional().default(''),
  enabled: z.boolean().optional().default(true),
  options: z
    .object({
      noTLSVerify: z.boolean().optional().default(false),
      httpHostHeader: z.string().trim().max(255).optional().default(''),
      originServerName: z.string().trim().max(255).optional().default(''),
    })
    .optional()
    .default({}),
});
/** POST /api/hosts body. PUT /api/hosts/:id body (full replace). */
export type ProxyHostInput = z.input<typeof proxyHostInputSchema>;
export type ProxyHostParsedInput = z.output<typeof proxyHostInputSchema>;

export const SYNC_STATUSES = ['pending', 'synced', 'error', 'drift'] as const;
export const syncStatusSchema = z.enum(SYNC_STATUSES);
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const HEALTH_STATES = ['up', 'down', 'unknown'] as const;
export const healthStateSchema = z.enum(HEALTH_STATES);
export type HealthState = z.infer<typeof healthStateSchema>;

export const originHealthSchema = z.object({
  state: healthStateSchema,
  /** HTTP status code from the origin, when applicable. */
  statusCode: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type OriginHealth = z.infer<typeof originHealthSchema>;

export const proxyHostSchema = z.object({
  id: z.number().int(),
  subdomain: z.string(),
  zoneId: z.string(),
  zoneName: z.string(),
  /** Fully qualified hostname, e.g. `app.example.com`. */
  hostname: z.string(),
  service: z.string(),
  path: z.string(),
  enabled: z.boolean(),
  options: z.object({
    noTLSVerify: z.boolean(),
    httpHostHeader: z.string(),
    originServerName: z.string(),
  }),
  sync: z.object({
    status: syncStatusSchema,
    error: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
  }),
  health: originHealthSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProxyHost = z.infer<typeof proxyHostSchema>;

/** GET /api/hosts -> 200 */
export const proxyHostListSchema = z.object({ hosts: z.array(proxyHostSchema) });
export type ProxyHostList = z.infer<typeof proxyHostListSchema>;

/**
 * GET    /api/hosts/:id          -> 200 ProxyHost
 * POST   /api/hosts              -> 201 ProxyHost   (409 DNS_CONFLICT / CONFLICT)
 * PUT    /api/hosts/:id          -> 200 ProxyHost
 * DELETE /api/hosts/:id          -> 204
 * POST   /api/hosts/:id/check    -> 200 OriginHealth (probe now)
 */

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

export const syncActionSchema = z.object({
  kind: z.enum([
    'ingress.update',
    'dns.create',
    'dns.update',
    'dns.delete',
    'tunnel.create',
    'host.conflict',
  ]),
  target: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
});
export type SyncAction = z.infer<typeof syncActionSchema>;

/** POST /api/sync -> 200, GET /api/sync -> 200 (last result, or null fields) */
export const syncResultSchema = z.object({
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  ok: z.boolean(),
  actions: z.array(syncActionSchema),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

/* ------------------------------------------------------------------ */
/* Logs (cloudflared)                                                  */
/* ------------------------------------------------------------------ */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const logLineSchema = z.object({
  /** Monotonic sequence number, used to resume an SSE stream (`Last-Event-ID`). */
  seq: z.number().int(),
  time: z.string(),
  level: logLevelSchema,
  source: z.enum(['cloudflared', 'burrow']),
  message: z.string(),
});
export type LogLine = z.infer<typeof logLineSchema>;

/**
 * GET /api/logs?limit=500     -> 200 { lines: LogLine[] } (most recent last)
 * GET /api/logs/stream        -> text/event-stream; each event: `id: <seq>`, `event: log`, `data: <LogLine JSON>`.
 *                                Also `event: state` with `data: TunnelInfo['supervisor']` on supervisor state changes.
 */
export const logListSchema = z.object({ lines: z.array(logLineSchema) });
export type LogList = z.infer<typeof logListSchema>;

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

/** GET /api/health (public, used by Docker HEALTHCHECK) -> 200 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Build the FQDN for a subdomain in a zone (`@` = apex). */
export function buildHostname(subdomain: string, zoneName: string): string {
  const s = subdomain.trim().toLowerCase();
  return s === '@' || s === '' ? zoneName.toLowerCase() : `${s}.${zoneName.toLowerCase()}`;
}

/** The comment Burrow writes on DNS records it owns. */
export function dnsOwnershipComment(tunnelId: string): string {
  return `managed-by:burrow tunnel:${tunnelId}`;
}
export const DNS_OWNERSHIP_PREFIX = 'managed-by:burrow';

/** Least-privilege token permissions, shown in the UI and in the README. */
export const REQUIRED_TOKEN_PERMISSIONS = [
  {
    scope: 'Account',
    group: 'Cloudflare Tunnel',
    level: 'Edit',
    why: 'Create the tunnel and update its routes',
  },
  {
    scope: 'Account',
    group: 'Account Settings',
    level: 'Read',
    why: 'Find the account that owns the tunnel',
  },
  {
    scope: 'Zone',
    group: 'DNS',
    level: 'Edit',
    why: 'Create the CNAME record for each host',
  },
  { scope: 'Zone', group: 'Zone', level: 'Read', why: 'List your domains' },
] as const;
