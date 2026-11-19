/**
 * The OpenAPI 3 description of the Burrow REST API, generated from the zod
 * schemas of `@burrow/shared` (the same ones the server validates with), so
 * the documentation cannot drift from the code.
 *
 * Served as JSON at `/api/openapi.json` and browsable at `/api/docs`.
 */
import * as s from '@burrow/shared';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Operation {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: ZodTypeAny;
  query?: Record<string, { schema: ZodTypeAny; description: string }>;
  /** Response schema for the success status; `null` = no body. */
  response?: ZodTypeAny | null;
  status?: number;
  /** Public routes need no session or token. */
  public?: boolean;
}

const id = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } } as const;

const ops: Operation[] = [
  /* ---- setup & auth ---- */
  {
    method: 'get',
    path: '/api/setup/status',
    tag: 'Auth',
    summary: 'Setup progress',
    response: s.setupStatusSchema,
    public: true,
  },
  {
    method: 'post',
    path: '/api/setup/admin',
    tag: 'Auth',
    summary: 'Create the admin account (only while none exists)',
    body: s.createAdminSchema,
    response: s.meResponseSchema,
    status: 201,
    public: true,
  },
  {
    method: 'post',
    path: '/api/auth/login',
    tag: 'Auth',
    summary: 'Sign in (sets the session cookie, rate limited)',
    body: s.loginSchema,
    response: s.meResponseSchema,
    public: true,
  },
  {
    method: 'post',
    path: '/api/auth/logout',
    tag: 'Auth',
    summary: 'Sign out',
    response: null,
    status: 204,
  },
  {
    method: 'get',
    path: '/api/auth/me',
    tag: 'Auth',
    summary: 'Current user and CSRF token',
    response: s.meResponseSchema,
  },
  {
    method: 'post',
    path: '/api/auth/password',
    tag: 'Auth',
    summary: 'Change the password (browser session only)',
    body: s.changePasswordSchema,
    response: null,
    status: 204,
  },
  /* ---- API tokens ---- */
  {
    method: 'get',
    path: '/api/tokens',
    tag: 'API tokens',
    summary: 'List API tokens (browser session only)',
    response: s.apiTokenListSchema,
  },
  {
    method: 'post',
    path: '/api/tokens',
    tag: 'API tokens',
    summary: 'Create an API token (browser session only)',
    description: 'The full token is in this response only. Burrow stores a hash.',
    body: s.createApiTokenSchema,
    response: s.createdApiTokenSchema,
    status: 201,
  },
  {
    method: 'delete',
    path: '/api/tokens/{id}',
    tag: 'API tokens',
    summary: 'Revoke an API token (browser session only)',
    response: null,
    status: 204,
  },
  /* ---- Cloudflare ---- */
  {
    method: 'get',
    path: '/api/cloudflare',
    tag: 'Cloudflare',
    summary: 'Token status, account and permission checks (never the token)',
    response: s.cloudflareSettingsSchema,
  },
  {
    method: 'put',
    path: '/api/cloudflare/token',
    tag: 'Cloudflare',
    summary: 'Verify and save a Cloudflare API token',
    body: s.saveTokenSchema,
    response: s.cloudflareSettingsSchema,
  },
  {
    method: 'delete',
    path: '/api/cloudflare/token',
    tag: 'Cloudflare',
    summary: 'Forget the token and stop cloudflared (hosts are kept)',
    response: null,
    status: 204,
  },
  {
    method: 'get',
    path: '/api/zones',
    tag: 'Cloudflare',
    summary: 'Zones visible with the token, and which ones Burrow may use',
    response: s.zoneListSchema,
  },
  {
    method: 'patch',
    path: '/api/zones/{id}',
    tag: 'Cloudflare',
    summary: 'Enable or disable a zone',
    body: s.updateZoneSchema,
    response: s.zoneSchema,
  },
  /* ---- hosts ---- */
  {
    method: 'get',
    path: '/api/hosts',
    tag: 'Proxy hosts',
    summary: 'List proxy hosts',
    response: s.proxyHostListSchema,
  },
  {
    method: 'post',
    path: '/api/hosts',
    tag: 'Proxy hosts',
    summary: 'Create and publish a proxy host',
    description:
      'All or nothing: 409 `DNS_CONFLICT` when a DNS record not created by Burrow exists.',
    body: s.proxyHostInputSchema,
    response: s.proxyHostSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/hosts/{id}',
    tag: 'Proxy hosts',
    summary: 'Get a proxy host',
    response: s.proxyHostSchema,
  },
  {
    method: 'put',
    path: '/api/hosts/{id}',
    tag: 'Proxy hosts',
    summary: 'Replace a proxy host',
    body: s.proxyHostInputSchema,
    response: s.proxyHostSchema,
  },
  {
    method: 'delete',
    path: '/api/hosts/{id}',
    tag: 'Proxy hosts',
    summary: 'Delete and unpublish a proxy host',
    response: null,
    status: 204,
  },
  {
    method: 'post',
    path: '/api/hosts/{id}/check',
    tag: 'Proxy hosts',
    summary: 'Probe the origin now',
    response: s.originHealthSchema,
  },
  /* ---- tunnels ---- */
  {
    method: 'get',
    path: '/api/tunnels',
    tag: 'Tunnels',
    summary: 'List tunnels',
    response: s.tunnelListSchema,
  },
  {
    method: 'post',
    path: '/api/tunnels',
    tag: 'Tunnels',
    summary: 'Create a remotely managed tunnel',
    body: s.createTunnelSchema,
    response: s.tunnelSummarySchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/tunnels/available',
    tag: 'Tunnels',
    summary: 'Tunnels of the account that Burrow does not manage yet',
    response: s.availableTunnelListSchema,
  },
  {
    method: 'post',
    path: '/api/tunnels/import',
    tag: 'Tunnels',
    summary: 'Import an existing tunnel and, optionally, its routes',
    body: s.importTunnelSchema,
    response: s.importTunnelResultSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/tunnels/{id}',
    tag: 'Tunnels',
    summary: 'Tunnel status, connectors and cloudflared state',
    response: s.tunnelInfoSchema,
  },
  {
    method: 'patch',
    path: '/api/tunnels/{id}',
    tag: 'Tunnels',
    summary: 'Change "run connector" or make the tunnel the default one',
    body: s.updateTunnelSchema,
    response: s.tunnelSummarySchema,
  },
  {
    method: 'delete',
    path: '/api/tunnels/{id}',
    tag: 'Tunnels',
    summary: 'Remove a tunnel without hosts',
    description:
      'Stops its connector and removes what Burrow wrote on it. Tunnels Burrow created are also deleted on Cloudflare unless `deleteOnCloudflare=false`.',
    query: {
      deleteOnCloudflare: {
        schema: z.enum(['true', 'false']),
        description: 'Also delete the tunnel in the Cloudflare account',
      },
    },
    response: null,
    status: 204,
  },
  ...(['start', 'stop', 'restart'] as const).map((action): Operation => ({
    method: 'post',
    path: `/api/tunnels/{id}/${action}`,
    tag: 'Tunnels',
    summary: `${action[0]!.toUpperCase()}${action.slice(1)} the tunnel's cloudflared`,
    response: s.supervisorStatusSchema,
    status: 202,
  })),
  {
    method: 'get',
    path: '/api/tunnel',
    tag: 'Tunnels',
    summary: 'Default tunnel status (v0.1 route)',
    response: s.tunnelInfoSchema,
  },
  /* ---- sync & logs ---- */
  {
    method: 'get',
    path: '/api/sync',
    tag: 'Sync',
    summary: 'Result of the last synchronisation',
    response: s.syncResultSchema,
  },
  {
    method: 'post',
    path: '/api/sync',
    tag: 'Sync',
    summary: 'Make Cloudflare match Burrow now',
    response: s.syncResultSchema,
  },
  {
    method: 'get',
    path: '/api/logs',
    tag: 'Logs',
    summary: 'Recent cloudflared and Burrow log lines',
    query: {
      limit: { schema: z.number().int().min(1).max(2000), description: 'Lines (default 500)' },
    },
    response: s.logListSchema,
  },
  {
    method: 'get',
    path: '/api/logs/stream',
    tag: 'Logs',
    summary: 'Live log stream (Server-Sent Events)',
    description:
      '`event: log` with a LogLine, `event: state` with a supervisor status and its `tunnelId`. Resume with `Last-Event-ID`.',
  },
  /* ---- drift ---- */
  {
    method: 'get',
    path: '/api/drift',
    tag: 'Drift',
    summary: 'Last comparison between Cloudflare and Burrow',
    response: s.driftReportSchema,
  },
  {
    method: 'post',
    path: '/api/drift/check',
    tag: 'Drift',
    summary: 'Compare Cloudflare with Burrow now (writes nothing)',
    response: s.driftReportSchema,
  },
  {
    method: 'post',
    path: '/api/drift/resolve',
    tag: 'Drift',
    summary: 'Revert the differences, or keep the Cloudflare version where possible',
    body: s.resolveDriftSchema,
    response: s.driftReportSchema,
  },
  {
    method: 'put',
    path: '/api/drift/settings',
    tag: 'Drift',
    summary: 'Turn automatic repair on or off',
    body: s.driftSettingsSchema,
    response: s.driftReportSchema,
  },
  /* ---- backups ---- */
  {
    method: 'get',
    path: '/api/backups',
    tag: 'Backups',
    summary: 'Backup settings, last run and the files at the destination',
    response: s.backupStatusSchema,
  },
  {
    method: 'put',
    path: '/api/backups/settings',
    tag: 'Backups',
    summary: 'Set the schedule, retention and destination (local or S3/R2)',
    description: 'Omit `s3.secretAccessKey` to keep the saved secret.',
    body: s.backupSettingsInputSchema,
    response: s.backupStatusSchema,
  },
  {
    method: 'post',
    path: '/api/backups',
    tag: 'Backups',
    summary: 'Back up now',
    description: 'Always 200: `ok` and `error` say whether it worked.',
    response: s.backupRunSchema,
  },
  {
    method: 'get',
    path: '/api/backups/{name}',
    tag: 'Backups',
    summary: 'Download a backup (gzipped SQLite database)',
    description: 'Responds with `application/gzip`.',
  },
  /* ---- config ---- */
  {
    method: 'get',
    path: '/api/config/export',
    tag: 'Configuration',
    summary: 'Export zones, tunnels and hosts as JSON (no secrets)',
    response: s.configDocumentSchema,
  },
  {
    method: 'post',
    path: '/api/config/import',
    tag: 'Configuration',
    summary: 'Import a configuration document (merge or replace, optional dry run)',
    body: s.configImportSchema,
    response: s.configImportReportSchema,
  },
  /* ---- health ---- */
  {
    method: 'get',
    path: '/api/health',
    tag: 'Health',
    summary: 'Liveness (used by the Docker healthcheck)',
    response: s.healthResponseSchema,
    public: true,
  },
];

function schema(zod: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(zod, { target: 'openApi3', $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

/** Build the OpenAPI document. */
export function buildOpenApi(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const errorResponse = {
    description: 'Error',
    content: { 'application/json': { schema: schema(s.apiErrorSchema) } },
  };
  for (const op of ops) {
    const parameters: unknown[] = [];
    if (op.path.includes('{id}')) parameters.push(id);
    if (op.path.includes('{name}')) {
      parameters.push({ name: 'name', in: 'path', required: true, schema: { type: 'string' } });
    }
    for (const [name, q] of Object.entries(op.query ?? {})) {
      parameters.push({
        name,
        in: 'query',
        required: false,
        description: q.description,
        schema: schema(q.schema),
      });
    }
    const status = String(op.status ?? 200);
    const success =
      op.response === null || op.response === undefined
        ? {
            description: op.response === undefined ? 'See description' : 'Success, no content',
          }
        : {
            description: 'Success',
            content: { 'application/json': { schema: schema(op.response) } },
          };
    paths[op.path] ??= {};
    paths[op.path]![op.method] = {
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schema(op.body) } },
            },
          }
        : {}),
      responses: { [status]: success, default: errorResponse },
      ...(op.public ? { security: [] } : {}),
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Burrow API',
      version,
      description: [
        'REST API of Burrow, the web UI for Cloudflare Tunnel. Everything the web UI does goes through it.',
        '',
        '**Authentication**: create an API token in *Settings › API tokens* and send it as',
        '`Authorization: Bearer burrow_…`. Requests with a token need no CSRF header.',
        'The web UI uses a session cookie instead; mutating requests then need the',
        '`X-CSRF-Token` header returned by `GET /api/auth/me`.',
        '',
        'Errors always look like `{ "error": { "code": "DNS_CONFLICT", "message": "…" } }`.',
      ].join('\n'),
      license: { name: 'MIT', url: 'https://github.com/noamroger/burrow/blob/main/LICENSE' },
    },
    servers: [{ url: '/' }],
    tags: [...new Set(ops.map((o) => o.tag))].map((name) => ({ name })),
    components: {
      securitySchemes: {
        apiToken: { type: 'http', scheme: 'bearer', description: 'Burrow API token' },
        session: { type: 'apiKey', in: 'cookie', name: 'burrow_session' },
      },
    },
    security: [{ apiToken: [] }, { session: [] }],
    paths,
  };
}
