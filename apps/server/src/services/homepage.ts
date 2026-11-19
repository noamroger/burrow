/**
 * Homepage: a dashboard of the exposed services, private (signed-in admin)
 * or public. When a public hostname is set, requests for that hostname reach
 * the homepage and nothing else (see `app.ts`).
 *
 * Icons are always served by Burrow itself (`/api/home/icons/:id`): remote
 * images (Dashboard Icons, URLs typed by the admin) are fetched once by the
 * server and cached on disk, so visitors never load third-party resources
 * and the strict Content-Security-Policy stays in place.
 */
import {
  DEFAULT_HOST_HOME,
  homepageSettingsSchema,
  hostHomeSchema,
  ICON_SLUG_RE,
  monogram,
  serviceProtocol,
  templateIconSlug,
  type HomeData,
  type HomeService,
  type HomepageSettings,
  type HostHome,
  findTemplate,
} from '@burrow/shared';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { proxyHosts, type ProxyHostRow } from '../db/schema.js';
import type { SettingsRepository } from '../db/settings.js';
import { errorMessage } from '../lib/errors.js';
import { diff, type ActorLike, type AuditService } from './audit.js';
import type { HealthService } from './health.js';

export const HOMEPAGE_SETTINGS_KEY = 'homepage.settings';

/** Dashboard Icons on jsDelivr: `<base>/svg/<name>.svg`, `<base>/png/<name>.png`. */
export const DEFAULT_ICON_BASE_URL = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons';

const ICON_MAX_BYTES = 512 * 1024;
/** A failed download is retried after this delay. */
const ICON_RETRY_MS = 10 * 60_000;

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};
const TYPE_OF_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

export interface IconFile {
  contentType: string;
  body: Buffer;
}

export interface HomepageServiceOptions {
  db: Db;
  settings: SettingsRepository;
  health: HealthService;
  audit: AuditService;
  logger: Logger;
  /** Where downloaded icons are cached. */
  cacheDir: string;
  fetch?: typeof fetch;
  iconBaseUrl?: string;
}

export class HomepageService {
  private cachedSettings: HomepageSettings | null = null;
  private readonly failures = new Map<string, number>();
  private readonly pending = new Map<string, Promise<IconFile | null>>();
  private readonly fetchFn: typeof fetch;
  private readonly iconBaseUrl: string;

  constructor(private readonly opts: HomepageServiceOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.iconBaseUrl = (opts.iconBaseUrl ?? DEFAULT_ICON_BASE_URL).replace(/\/+$/, '');
  }

  settings(): HomepageSettings {
    if (!this.cachedSettings) {
      const parsed = homepageSettingsSchema.safeParse(
        this.opts.settings.get<unknown>(HOMEPAGE_SETTINGS_KEY) ?? {},
      );
      this.cachedSettings = parsed.success ? parsed.data : homepageSettingsSchema.parse({});
    }
    return this.cachedSettings;
  }

  saveSettings(input: unknown, by: ActorLike): HomepageSettings {
    const before = this.settings();
    const settings = homepageSettingsSchema.parse(input);
    this.opts.settings.set(HOMEPAGE_SETTINGS_KEY, settings);
    this.cachedSettings = settings;
    const changes = diff(before, settings);
    if (changes.length > 0) {
      this.opts.audit.record(by, 'homepage.update', settings.enabled ? 'on' : 'off', {
        details: { changes },
        undo: { kind: 'homepage.settings', settings: before, expect: settings },
      });
    }
    return settings;
  }

  /** The hostname that serves the homepage alone, or null. */
  publicHostname(): string | null {
    const s = this.settings();
    return s.enabled && s.visibility === 'public' && s.publicHostname ? s.publicHostname : null;
  }

  /** The page data. Only public links: never the origin service URLs. */
  data(): HomeData {
    const s = this.settings();
    const groups = new Map<string, HomeService[]>();
    for (const row of this.listed()) {
      const home = homeOf(row);
      const title = home.title || findTemplate(row.template)?.name || defaultTitle(row);
      const source = this.iconSource(row, home);
      const service: HomeService = {
        id: row.id,
        title,
        description: home.description,
        url: publicUrl(row),
        icon: source ? `/api/home/icons/${row.id}?v=${hash(source).slice(0, 10)}` : null,
        monogram: monogram(title),
        state: s.showStatus ? this.state(row) : null,
      };
      const name = home.group || 'Services';
      groups.set(name, [...(groups.get(name) ?? []), service]);
    }
    return {
      title: s.title,
      subtitle: s.subtitle,
      showStatus: s.showStatus,
      groups: [...groups.entries()].map(([name, services]) => ({
        name,
        services: services.sort((a, b) => a.title.localeCompare(b.title)),
      })),
    };
  }

  /** Icon of a listed host, or null (the page shows the monogram). */
  async icon(hostId: number): Promise<IconFile | null> {
    const row = this.listed().find((r) => r.id === hostId);
    if (!row) return null;
    const source = this.iconSource(row, homeOf(row));
    if (!source) return null;
    if (source.startsWith('data:')) return decodeDataUrl(source);
    if (source.startsWith('slug:')) {
      const name = source.slice(5);
      return (
        (await this.remote(`${this.iconBaseUrl}/svg/${name}.svg`)) ??
        (await this.remote(`${this.iconBaseUrl}/png/${name}.png`))
      );
    }
    return this.remote(source);
  }

  /** Enabled hosts shown on the homepage, that a browser can open. */
  private listed(): ProxyHostRow[] {
    return this.opts.db
      .select()
      .from(proxyHosts)
      .orderBy(asc(proxyHosts.hostname), asc(proxyHosts.path))
      .all()
      .filter((r) => r.enabled && homeOf(r).visible && opensInBrowser(r));
  }

  private state(row: ProxyHostRow): HomeService['state'] {
    if (row.maintenanceEnabled) return 'maintenance';
    return this.opts.health.get(row.id).state;
  }

  /** `data:…`, `slug:<name>`, an http(s) URL, or null. */
  private iconSource(row: ProxyHostRow, home: HostHome): string | null {
    if (home.icon.startsWith('data:') || /^https?:\/\//i.test(home.icon)) return home.icon;
    if (ICON_SLUG_RE.test(home.icon)) return `slug:${home.icon}`;
    const slug = templateIconSlug(row.template);
    return slug ? `slug:${slug}` : null;
  }

  /** Download an image once and keep it on disk. */
  private async remote(url: string): Promise<IconFile | null> {
    const key = hash(url);
    const cached = this.readCache(key);
    if (cached) return cached;
    const failedAt = this.failures.get(key);
    if (failedAt && Date.now() - failedAt < ICON_RETRY_MS) return null;
    let job = this.pending.get(key);
    if (!job) {
      job = this.download(url, key).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    return job;
  }

  private async download(url: string, key: string): Promise<IconFile | null> {
    try {
      const res = await this.fetchFn(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'image/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const ext = IMAGE_TYPES[type] ?? extFromUrl(url);
      if (!ext) throw new Error(`not an image (${type || 'no content type'})`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0 || body.length > ICON_MAX_BYTES) {
        throw new Error(`unexpected size (${body.length} bytes)`);
      }
      mkdirSync(this.opts.cacheDir, { recursive: true });
      writeFileSync(join(this.opts.cacheDir, `${key}.${ext}`), body);
      this.failures.delete(key);
      return { contentType: TYPE_OF_EXT[ext]!, body };
    } catch (err) {
      this.failures.set(key, Date.now());
      this.opts.logger.debug({ url, err: errorMessage(err) }, 'homepage icon unavailable');
      return null;
    }
  }

  private readCache(key: string): IconFile | null {
    for (const [ext, contentType] of Object.entries(TYPE_OF_EXT)) {
      const file = join(this.opts.cacheDir, `${key}.${ext}`);
      if (existsSync(file)) return { contentType, body: readFileSync(file) };
    }
    return null;
  }
}

/** `grafana.example.com` → `Grafana`; an apex host keeps its hostname. */
function defaultTitle(row: ProxyHostRow): string {
  const name = row.subdomain === '@' ? row.hostname : row.subdomain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function homeOf(row: ProxyHostRow): HostHome {
  return hostHomeSchema.catch(DEFAULT_HOST_HOME).parse(row.home ?? {});
}

/** HTTP services, and SSH / VNC hosts with a browser terminal. */
function opensInBrowser(row: ProxyHostRow): boolean {
  const protocol = serviceProtocol(row.service);
  return protocol === 'http' || protocol === 'https' || row.accessBrowserRendering !== null;
}

function publicUrl(row: ProxyHostRow): string {
  // Ingress paths are regular expressions: link to their literal prefix.
  const prefix = row.path
    .replace(/^\^/, '')
    .split(/[\\^$.*+?()[\]{}|]/)[0]!
    .replace(/\/+$/, '');
  return `https://${row.hostname}${prefix.startsWith('/') ? prefix : prefix ? `/${prefix}` : ''}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function extFromUrl(url: string): string | null {
  const raw = /\.([a-z]{3,4})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  const ext = raw === 'jpeg' ? 'jpg' : raw;
  return ext && ext in TYPE_OF_EXT ? ext : null;
}

function decodeDataUrl(value: string): IconFile | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(value);
  if (!match || !IMAGE_TYPES[match[1]!.toLowerCase()]) return null;
  return {
    contentType: TYPE_OF_EXT[IMAGE_TYPES[match[1]!.toLowerCase()]!]!,
    body: Buffer.from(match[2]!, 'base64'),
  };
}
