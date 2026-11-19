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
import { templateIdSchema } from './templates.js';

export * from './templates.js';

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
  'ACCESS_CONFLICT',
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
  /** Optional permissions only unlock a feature (e.g. Cloudflare Access); saving works without them. */
  optional: z.boolean().optional(),
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

export const supervisorStatusSchema = z.object({
  state: supervisorStateSchema,
  pid: z.number().int().nullable(),
  restarts: z.number().int(),
  startedAt: z.string().nullable(),
  lastExitCode: z.number().int().nullable(),
  nextRetryAt: z.string().nullable(),
  cloudflaredVersion: z.string().nullable(),
});
export type SupervisorStatus = z.infer<typeof supervisorStatusSchema>;

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
  supervisor: supervisorStatusSchema,
});
export type TunnelInfo = z.infer<typeof tunnelInfoSchema>;

/**
 * GET  /api/tunnel                 -> 200 TunnelInfo of the default tunnel (kept for scripts).
 * POST /api/tunnel/restart|stop|start -> 202, on the default tunnel.
 */

/* ---- Several tunnels ---- */

export const TUNNEL_ORIGINS = ['created', 'imported'] as const;
export const tunnelOriginSchema = z.enum(TUNNEL_ORIGINS);
export type TunnelOrigin = z.infer<typeof tunnelOriginSchema>;

/** A tunnel known to Burrow. `id` is Burrow's id; `cfId` is the Cloudflare tunnel UUID. */
export const tunnelSummarySchema = z.object({
  id: z.number().int(),
  cfId: z.string(),
  name: z.string(),
  /** `created` by Burrow, or `imported` from the account. */
  origin: tunnelOriginSchema,
  /** Whether Burrow runs cloudflared for this tunnel (off when it runs elsewhere). */
  runConnector: z.boolean(),
  /** New hosts go to the default tunnel unless another one is chosen. */
  isDefault: z.boolean(),
  hostCount: z.number().int(),
  status: tunnelStatusSchema,
  supervisor: supervisorStatusSchema,
});
export type TunnelSummary = z.infer<typeof tunnelSummarySchema>;

/** GET /api/tunnels -> 200 */
export const tunnelListSchema = z.object({ tunnels: z.array(tunnelSummarySchema) });
export type TunnelList = z.infer<typeof tunnelListSchema>;

/** Cloudflare tunnel names: letters, digits, dots, dashes and underscores. */
export const tunnelNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'Use letters, digits, dots, dashes or underscores');

/** POST /api/tunnels -> 201 TunnelSummary. Creates a remotely managed tunnel. */
export const createTunnelSchema = z.object({
  name: tunnelNameSchema,
  runConnector: z.boolean().optional().default(true),
});
export type CreateTunnelInput = z.input<typeof createTunnelSchema>;

/** PATCH /api/tunnels/:id -> 200 TunnelSummary */
export const updateTunnelSchema = z.object({
  runConnector: z.boolean().optional(),
  /** Only `true` is accepted: make this tunnel the default one. */
  isDefault: z.literal(true).optional(),
});
export type UpdateTunnelInput = z.infer<typeof updateTunnelSchema>;

/** A tunnel of the account that Burrow does not manage yet. */
export const availableTunnelSchema = z.object({
  cfId: z.string(),
  name: z.string(),
  status: tunnelStatusSchema,
  createdAt: z.string(),
  /** `cloudflare` = remotely managed (importable); `local` = config file on the connector. */
  configSrc: z.enum(['cloudflare', 'local']),
  /** Public hostname routes in its configuration (null when it could not be read). */
  routeCount: z.number().int().nullable(),
});
export type AvailableTunnel = z.infer<typeof availableTunnelSchema>;

/** GET /api/tunnels/available -> 200 */
export const availableTunnelListSchema = z.object({ tunnels: z.array(availableTunnelSchema) });
export type AvailableTunnelList = z.infer<typeof availableTunnelListSchema>;

/** POST /api/tunnels/import -> 201 ImportTunnelResult */
export const importTunnelSchema = z.object({
  cfId: z.string().uuid(),
  /** Run cloudflared for it in Burrow. Turn off if a connector already runs elsewhere. */
  runConnector: z.boolean().optional().default(false),
  /** Turn its public hostname routes into Burrow proxy hosts. */
  importRoutes: z.boolean().optional().default(true),
});
export type ImportTunnelInput = z.input<typeof importTunnelSchema>;

export const importedRouteSchema = z.object({
  hostname: z.string(),
  path: z.string(),
  service: z.string(),
  /** Set when the route was not imported (it stays on the tunnel, untouched). */
  skipped: z.string().nullable(),
});
export type ImportedRoute = z.infer<typeof importedRouteSchema>;

export const importTunnelResultSchema = z.object({
  tunnel: tunnelSummarySchema,
  routes: z.array(importedRouteSchema),
});
export type ImportTunnelResult = z.infer<typeof importTunnelResultSchema>;

/**
 * GET    /api/tunnels/:id                      -> 200 TunnelInfo
 * DELETE /api/tunnels/:id?deleteOnCloudflare=  -> 204 (409 while hosts use it, or for the default tunnel)
 * POST   /api/tunnels/:id/start|stop|restart   -> 202 supervisor status
 */

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

/* ---- Cloudflare Access (Zero Trust) ---- */

/** Session lengths offered for Access-protected hosts (Cloudflare duration strings). */
export const ACCESS_SESSION_DURATIONS = ['30m', '6h', '12h', '24h', '168h', '720h'] as const;
export const accessSessionDurationSchema = z.enum(ACCESS_SESSION_DURATIONS);
export type AccessSessionDuration = z.infer<typeof accessSessionDurationSchema>;

/** Maximum number of emails + email domains on one host. */
export const ACCESS_MAX_RULES = 50;

const accessEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254);

/** An email domain such as `example.com` (a leading `@` is accepted and removed). */
const accessEmailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^@?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'Enter a domain such as example.com',
  )
  .transform((d) => d.replace(/^@/, ''));

/**
 * Cloudflare Access protection for a host. When enabled, visitors must sign
 * in (one-time PIN by email, or any identity provider set up in Zero Trust)
 * and match one of the allowed emails or email domains.
 */
export const accessSettingsInputSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    emails: z.array(accessEmailSchema).optional().default([]),
    emailDomains: z.array(accessEmailDomainSchema).optional().default([]),
    sessionDuration: accessSessionDurationSchema.optional().default('24h'),
  })
  .superRefine((value, ctx) => {
    const total = value.emails.length + value.emailDomains.length;
    if (value.enabled && total === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emails'],
        message: 'Add at least one allowed email or email domain',
      });
    }
    if (total > ACCESS_MAX_RULES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emails'],
        message: `Use at most ${ACCESS_MAX_RULES} emails and domains in total`,
      });
    }
  });
export type AccessSettingsInput = z.input<typeof accessSettingsInputSchema>;

export const accessSettingsSchema = z.object({
  enabled: z.boolean(),
  emails: z.array(z.string()),
  emailDomains: z.array(z.string()),
  sessionDuration: accessSessionDurationSchema,
});
export type AccessSettings = z.infer<typeof accessSettingsSchema>;

export const proxyHostInputSchema = z.object({
  subdomain: subdomainSchema,
  /** Tunnel to publish through (Burrow id). Defaults to the default tunnel; kept on update when omitted. */
  tunnelId: z.number().int().positive().optional(),
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
  /** Cloudflare Access protection. Applies to the whole hostname (every path). */
  access: accessSettingsInputSchema.optional().default({}),
  /** Service template the host was made from (see GET /api/templates), or null. */
  template: templateIdSchema.optional().default(null),
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
  tunnelId: z.number().int().nullable(),
  tunnelName: z.string().nullable(),
  /** Fully qualified hostname, e.g. `app.example.com`. */
  hostname: z.string(),
  service: z.string(),
  path: z.string(),
  enabled: z.boolean(),
  options: z.object({
    noTLSVerify: z.boolean(),
    httpHostHeader: z.string(),
    originServerName: z.string(),
    /** Other `originRequest` settings kept from an imported route (not editable in the UI). */
    extra: z.record(z.unknown()),
  }),
  access: accessSettingsSchema,
  /** Service template the host was made from, or null. */
  template: z.string().nullable(),
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
 * POST   /api/hosts              -> 201 ProxyHost   (409 DNS_CONFLICT / ACCESS_CONFLICT / CONFLICT)
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
    'access.create',
    'access.update',
    'access.delete',
    'access.conflict',
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
/* Drift detection                                                     */
/* ------------------------------------------------------------------ */

export const DRIFT_KINDS = [
  /** A route Burrow wrote was edited in the dashboard (service, options, path…). */
  'ingress.changed',
  /** A route Burrow publishes is gone. */
  'ingress.missing',
  /** A route Burrow wrote is still there although no host wants it. */
  'ingress.extra',
  /** The CNAME of a host is gone. */
  'dns.missing',
  /** Burrow's CNAME points elsewhere or lost its proxy. */
  'dns.changed',
  /** A record Burrow created is left over (duplicate or orphan). */
  'dns.extra',
  /** Someone replaced Burrow's record with their own. */
  'dns.conflict',
  'access.missing',
  'access.changed',
  'access.extra',
  'access.conflict',
  /** The tunnel itself was deleted. */
  'tunnel.missing',
] as const;
export const driftKindSchema = z.enum(DRIFT_KINDS);
export type DriftKind = z.infer<typeof driftKindSchema>;

export const driftItemSchema = z.object({
  kind: driftKindSchema,
  /** Hostname (or tunnel name for tunnel-wide differences). */
  target: z.string(),
  /** Tunnel concerned, when relevant. */
  tunnel: z.string().nullable(),
  /** Hosts concerned. */
  hostIds: z.array(z.number().int()),
  /** What differs, in plain words. */
  detail: z.string(),
  /**
   * True when Burrow can keep the Cloudflare version by updating the host
   * (a changed route, or a removed route / record: the host is disabled).
   * Other differences can only be reverted.
   */
  keepable: z.boolean(),
});
export type DriftItem = z.infer<typeof driftItemSchema>;

/** GET /api/drift -> 200. POST /api/drift/check -> 200 (check now). */
export const driftReportSchema = z.object({
  checkedAt: z.string().nullable(),
  /** When on, differences are reverted automatically at every check. */
  autoRepair: z.boolean(),
  /** Seconds between scheduled checks; 0 when they are off. */
  intervalSeconds: z.number().int().nonnegative(),
  items: z.array(driftItemSchema),
  /** Set when the check itself failed (Cloudflare unreachable…). */
  error: z.string().nullable(),
});
export type DriftReport = z.infer<typeof driftReportSchema>;

/**
 * POST /api/drift/resolve -> 200 DriftReport (after a new check).
 * `revert`: make Cloudflare match Burrow again (a full sync).
 * `keep`: update Burrow's hosts with the Cloudflare changes it can keep, then sync.
 */
export const resolveDriftSchema = z.object({ strategy: z.enum(['revert', 'keep']) });
export type ResolveDriftInput = z.infer<typeof resolveDriftSchema>;

/** PUT /api/drift/settings -> 200 DriftReport */
export const driftSettingsSchema = z.object({ autoRepair: z.boolean() });
export type DriftSettings = z.infer<typeof driftSettingsSchema>;

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

/** Object key prefix: letters, digits, `-`, `_`, `.` and `/` (no leading slash). */
const backupPrefixSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^(?:[A-Za-z0-9._-]+\/)*$/, 'Use letters, digits, - _ . and end with /, e.g. burrow/');

/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2…). For R2
 * the endpoint is `https://<account id>.r2.cloudflarestorage.com`, region `auto`.
 */
export const backupS3Schema = z.object({
  endpoint: z.string().trim().url().max(500),
  region: z.string().trim().min(1).max(50).default('auto'),
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid bucket name'),
  prefix: backupPrefixSchema.default('burrow/'),
  accessKeyId: z.string().trim().min(1).max(200),
  /** Write-only. Omit it to keep the saved secret. */
  secretAccessKey: z.string().min(1).max(500).optional(),
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. */
  forcePathStyle: z.boolean().default(true),
});
export type BackupS3Input = z.infer<typeof backupS3Schema>;

/** PUT /api/backups/settings -> 200 BackupStatus */
export const backupSettingsInputSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30),
  /** How many backups to keep at the destination; older ones are deleted. */
  retention: z.number().int().min(1).max(365),
  destination: z.enum(['local', 's3']),
  s3: backupS3Schema.nullable().default(null),
});
export type BackupSettingsInput = z.input<typeof backupSettingsInputSchema>;

export const backupFileSchema = z.object({
  name: z.string(),
  size: z.number().int(),
  createdAt: z.string(),
});
export type BackupFile = z.infer<typeof backupFileSchema>;

export const backupRunSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  /** File name when it worked. */
  name: z.string().nullable(),
  error: z.string().nullable(),
});
export type BackupRun = z.infer<typeof backupRunSchema>;

/** GET /api/backups -> 200 */
export const backupStatusSchema = z.object({
  settings: backupSettingsInputSchema.extend({
    s3: backupS3Schema
      .omit({ secretAccessKey: true })
      .extend({ hasSecret: z.boolean() })
      .nullable(),
  }),
  /** Where local backups go (`BACKUP_DIR`, default `<DATA_DIR>/backups`). */
  localDir: z.string(),
  lastRun: backupRunSchema.nullable(),
  nextRunAt: z.string().nullable(),
  files: z.array(backupFileSchema),
  /** Set when the destination could not be listed. */
  listError: z.string().nullable(),
});
export type BackupStatus = z.infer<typeof backupStatusSchema>;

/* ------------------------------------------------------------------ */
/* API tokens                                                          */
/* ------------------------------------------------------------------ */

/** Prefix of every Burrow API token, e.g. `burrow_3q2…`. */
export const API_TOKEN_PREFIX = 'burrow_';

export const apiTokenSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** First characters of the token, to recognise it. The token itself is shown once. */
  hint: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

/** GET /api/tokens -> 200 */
export const apiTokenListSchema = z.object({ tokens: z.array(apiTokenSchema) });
export type ApiTokenList = z.infer<typeof apiTokenListSchema>;

/** POST /api/tokens -> 201 CreatedApiToken (session only). DELETE /api/tokens/:id -> 204. */
export const createApiTokenSchema = z.object({ name: z.string().trim().min(1).max(64) });
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;

export const createdApiTokenSchema = apiTokenSchema.extend({
  /** The full token. Shown only in this response: Burrow stores a hash. */
  token: z.string(),
});
export type CreatedApiToken = z.infer<typeof createdApiTokenSchema>;

/* ------------------------------------------------------------------ */
/* Configuration export / import                                       */
/* ------------------------------------------------------------------ */

export const CONFIG_FORMAT_VERSION = 1;

/** One proxy host in an exported configuration. No ids: hosts are matched by hostname + path. */
export const configHostSchema = z.object({
  subdomain: subdomainSchema,
  /** Zone name, e.g. `example.com` (zone ids differ between accounts). */
  zone: z.string().trim().toLowerCase().min(1),
  /** Tunnel name. Missing or unknown: the default tunnel. */
  tunnel: z.string().optional(),
  service: serviceUrlSchema,
  path: ingressPathSchema.optional().default(''),
  enabled: z.boolean().optional().default(true),
  options: z
    .object({
      noTLSVerify: z.boolean().optional().default(false),
      httpHostHeader: z.string().trim().max(255).optional().default(''),
      originServerName: z.string().trim().max(255).optional().default(''),
      extra: z.record(z.unknown()).optional().default({}),
    })
    .optional()
    .default({}),
  access: accessSettingsInputSchema.optional().default({}),
  template: z.string().trim().toLowerCase().nullable().optional().default(null),
});
export type ConfigHost = z.input<typeof configHostSchema>;

export const configTunnelSchema = z.object({
  name: tunnelNameSchema,
  /** Cloudflare tunnel UUID, used to find the same tunnel in the same account. */
  cfId: z.string().uuid().optional(),
  origin: tunnelOriginSchema.optional().default('created'),
  runConnector: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
});

/**
 * GET /api/config/export -> 200 ConfigDocument (attachment). Never contains
 * secrets: no API token, no password, no session.
 */
export const configDocumentSchema = z
  .object({
    burrow: z.literal(CONFIG_FORMAT_VERSION),
    exportedAt: z.string().optional(),
    /** Burrow version that wrote the file (informative). */
    version: z.string().optional(),
    zones: z.array(z.string().trim().toLowerCase()).optional().default([]),
    tunnels: z.array(configTunnelSchema).optional().default([]),
    hosts: z.array(configHostSchema).max(2000),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    doc.hosts.forEach((h, i) => {
      const key = `${buildHostname(h.subdomain, h.zone)}|${h.path}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hosts', i],
          message: `Duplicate host ${buildHostname(h.subdomain, h.zone)}${h.path ? ` (path ${h.path})` : ''}`,
        });
      }
      seen.add(key);
    });
  });
export type ConfigDocument = z.input<typeof configDocumentSchema>;
export type ParsedConfigDocument = z.output<typeof configDocumentSchema>;

/** POST /api/config/import -> 200 ConfigImportReport */
export const configImportSchema = z.object({
  config: configDocumentSchema,
  /** `merge` adds and updates; `replace` also deletes hosts missing from the file. */
  mode: z.enum(['merge', 'replace']).optional().default('merge'),
  /** Only report what would change. */
  dryRun: z.boolean().optional().default(false),
});
export type ConfigImportInput = z.input<typeof configImportSchema>;

export const configImportReportSchema = z.object({
  dryRun: z.boolean(),
  hosts: z.object({
    created: z.array(z.string()),
    updated: z.array(z.string()),
    unchanged: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  zonesEnabled: z.array(z.string()),
  tunnelsCreated: z.array(z.string()),
  tunnelsImported: z.array(z.string()),
  /** Things that could not be applied as written (missing zone, unknown tunnel…). */
  warnings: z.array(z.string()),
  /** Result of the sync that followed (null on a dry run). */
  sync: syncResultSchema.nullable(),
});
export type ConfigImportReport = z.infer<typeof configImportReportSchema>;

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
  /** Name of the tunnel a cloudflared line comes from (several tunnels can run at once). */
  tunnel: z.string().optional(),
});
export type LogLine = z.infer<typeof logLineSchema>;

/**
 * GET /api/logs?limit=500     -> 200 { lines: LogLine[] } (most recent last)
 * GET /api/logs/stream        -> text/event-stream; each event: `id: <seq>`, `event: log`, `data: <LogLine JSON>`.
 *                                Also `event: state` with `data: SupervisorStatus & { tunnelId }` when a cloudflared changes state.
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

/** Prefix of the names Burrow gives to the Access applications and policies it owns. */
export const ACCESS_OWNERSHIP_PREFIX = '[Burrow] ';

/** Name of the Access application and policy Burrow creates for a hostname. */
export function accessResourceName(hostname: string): string {
  return `${ACCESS_OWNERSHIP_PREFIX}${hostname.toLowerCase()}`;
}

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
  {
    scope: 'Account',
    group: 'Access: Apps and Policies',
    level: 'Edit',
    why: 'Protect private hosts with Cloudflare Access (sign-in required)',
    optional: true,
  },
] as const;
