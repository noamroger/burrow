import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Fastify's `trustProxy` accepts a boolean, a hop count, or a list of
 * addresses/CIDRs. We accept the same from a single string.
 */
const trustProxy = z
  .string()
  .trim()
  .transform((v): boolean | number | string => {
    if (v === '' || v === 'false' || v === '0') return false;
    if (v === 'true') return true;
    if (/^\d+$/.test(v)) return Number(v);
    return v;
  });

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATA_DIR: z.string().min(1).default('/data'),
  BURROW_SECRET: z
    .string()
    .min(32, 'BURROW_SECRET must be at least 32 characters')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  CLOUDFLARED_PATH: z.string().min(1).default('cloudflared'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BURROW_SECURE_COOKIES: z.enum(['auto', 'true', 'false']).default('auto'),
  TRUST_PROXY: trustProxy.default('false'),
  CLOUDFLARE_API_BASE: z
    .string()
    .url()
    .default('https://api.cloudflare.com/client/v4')
    .transform((v) => v.replace(/\/+$/, '')),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  HEALTHCHECK_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),
  /** Where local backups are written. Default: `<DATA_DIR>/backups`. */
  BACKUP_DIR: z.string().optional(),
  WEB_DIST_DIR: z.string().min(1).default(resolve(here, '../../web/dist')),
  /** Docker API used by auto-discovery (unix socket or tcp:// socket proxy). */
  DOCKER_HOST: z.string().min(1).default('unix:///var/run/docker.sock'),
  DOCKER_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
  /** Address cloudflared exposes its metrics and `/ready` endpoint on. */
  CLOUDFLARED_METRICS: z.string().min(1).default('127.0.0.1:20241'),
  NODE_ENV: z.string().default('production'),
});

/** Raw (string) shape accepted from the environment. */
export type ConfigInput = Partial<Record<keyof z.input<typeof configSchema>, string>>;

/** Validated runtime configuration. */
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  secret: string | undefined;
  cloudflaredPath: string;
  cloudflaredMetrics: string;
  logLevel: z.infer<typeof configSchema>['LOG_LEVEL'];
  secureCookies: 'auto' | 'true' | 'false';
  trustProxy: boolean | number | string;
  cloudflareApiBase: string;
  reconcileIntervalSeconds: number;
  healthcheckIntervalSeconds: number;
  backupDir: string;
  dockerHost: string;
  dockerScanIntervalSeconds: number;
  webDistDir: string;
  isProduction: boolean;
}

/**
 * Parse and validate configuration from environment variables.
 * Throws a readable error listing every invalid variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv | ConfigInput = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  return {
    port: c.PORT,
    host: c.HOST,
    dataDir: resolve(c.DATA_DIR),
    secret: c.BURROW_SECRET,
    cloudflaredPath: c.CLOUDFLARED_PATH,
    cloudflaredMetrics: c.CLOUDFLARED_METRICS,
    logLevel: c.LOG_LEVEL,
    secureCookies: c.BURROW_SECURE_COOKIES,
    trustProxy: c.TRUST_PROXY,
    cloudflareApiBase: c.CLOUDFLARE_API_BASE,
    reconcileIntervalSeconds: c.RECONCILE_INTERVAL_SECONDS,
    healthcheckIntervalSeconds: c.HEALTHCHECK_INTERVAL_SECONDS,
    backupDir: resolve(c.BACKUP_DIR || join(c.DATA_DIR, 'backups')),
    dockerHost: c.DOCKER_HOST,
    dockerScanIntervalSeconds: c.DOCKER_SCAN_INTERVAL_SECONDS,
    webDistDir: resolve(c.WEB_DIST_DIR),
    isProduction: c.NODE_ENV === 'production',
  };
}
