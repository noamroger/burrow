/**
 * Homepage: a small dashboard of the exposed services (icon, name,
 * description, status), optionally public.
 *
 * The data the page receives never contains origin service URLs, only the
 * public `https://hostname/path` links.
 */
import { z } from 'zod';

/** Dashboard Icons (github.com/homarr-labs/dashboard-icons) name, e.g. `jellyfin`. */
export const ICON_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Icon of a service on the homepage:
 * - `''`: automatic (the template's icon, otherwise the first letters);
 * - a Dashboard Icons name, e.g. `jellyfin`;
 * - an image URL (`https://…`, fetched and cached by Burrow);
 * - an uploaded image as a data URL (max ~150 KB).
 */
export const homeIconSchema = z
  .string()
  .trim()
  .max(200_000, 'The icon is too large (150 KB max)')
  .refine(
    (v) =>
      v === '' ||
      (ICON_SLUG_RE.test(v) && v.length <= 80) ||
      (/^https?:\/\/\S+$/i.test(v) && v.length <= 2048) ||
      /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon);base64,[a-z0-9+/=]+$/i.test(v),
    'Use an icon name (jellyfin), an image URL (https://…) or upload an image',
  );

/** How a host appears on the homepage. Part of the host input (omitted on update: unchanged). */
export const hostHomeSchema = z.object({
  /** Listed on the homepage. */
  visible: z.boolean().default(true),
  /** Name shown on the tile; empty = the template name, else the hostname. */
  title: z.string().trim().max(60).default(''),
  description: z.string().trim().max(140).default(''),
  icon: homeIconSchema.default(''),
  /** Section of the homepage; empty = "Services". */
  group: z.string().trim().max(40).default(''),
});
export type HostHome = z.infer<typeof hostHomeSchema>;
export type HostHomeInput = z.input<typeof hostHomeSchema>;

export const DEFAULT_HOST_HOME: HostHome = hostHomeSchema.parse({});

export const HOMEPAGE_VISIBILITIES = ['private', 'public'] as const;

const publicHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine(
    (v) => v === '' || /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v),
    'Use a hostname like home.example.com',
  );

/** GET / PUT /api/homepage/settings */
export const homepageSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** `private`: only for the signed-in admin. `public`: anyone with the link. */
    visibility: z.enum(HOMEPAGE_VISIBILITIES).default('private'),
    title: z.string().trim().min(1, 'Give the page a title').max(60).default('Home'),
    subtitle: z.string().trim().max(140).default(''),
    /** Show whether each service is up (from the health checks). */
    showStatus: z.boolean().default(true),
    /**
     * Hostname that serves the homepage alone (e.g. `home.example.com`,
     * published with a host pointing at Burrow itself). Requests carrying it
     * reach the homepage and nothing else: no admin UI, no API.
     */
    publicHostname: publicHostnameSchema.default(''),
  })
  .superRefine((s, ctx) => {
    if (s.publicHostname && s.visibility !== 'public') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publicHostname'],
        message: 'A public hostname needs a public homepage',
      });
    }
  });
export type HomepageSettings = z.infer<typeof homepageSettingsSchema>;
export type HomepageSettingsInput = z.input<typeof homepageSettingsSchema>;

export const HOME_SERVICE_STATES = ['up', 'down', 'unknown', 'maintenance'] as const;

export const homeServiceSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  /** Public link: `https://hostname/path`. */
  url: z.string(),
  /** Same-origin icon URL, or null to show the monogram. */
  icon: z.string().nullable(),
  /** One or two letters, used when there is no icon (or it fails to load). */
  monogram: z.string(),
  /** Null when statuses are hidden. */
  state: z.enum(HOME_SERVICE_STATES).nullable(),
});
export type HomeService = z.infer<typeof homeServiceSchema>;

/** GET /api/home (public when the homepage is public). */
export const homeDataSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  showStatus: z.boolean(),
  groups: z.array(z.object({ name: z.string(), services: z.array(homeServiceSchema) })),
});
export type HomeData = z.infer<typeof homeDataSchema>;

/** Icon names of Dashboard Icons for the service templates, when they differ from the id. */
export const TEMPLATE_ICON_SLUGS: Record<string, string | null> = {
  pihole: 'pi-hole',
  'synology-dsm': 'synology',
  ssh: null,
  vnc: null,
  rdp: null,
};

/** Dashboard Icons name for a template id, or null (no icon). */
export function templateIconSlug(templateId: string | null): string | null {
  if (!templateId) return null;
  if (templateId in TEMPLATE_ICON_SLUGS) return TEMPLATE_ICON_SLUGS[templateId] ?? null;
  return ICON_SLUG_RE.test(templateId) ? templateId : null;
}

/** First letters of a name: `Home Assistant` → `HA`, `jellyfin` → `J`, `app.example.com` → `A`. */
export function monogram(name: string): string {
  const words = (name.includes(' ') ? name : (name.split('.')[0] ?? name))
    .split(/[\s_-]+/)
    .filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0]?.slice(0, 1) ?? '?');
  return letters.toUpperCase();
}
