/**
 * Maintenance pages. A host in maintenance mode is routed to Burrow's small
 * maintenance server, which answers every request with this page (HTTP 503).
 *
 * The rendering is shared: the server serves it, the web UI previews it.
 *
 * Two modes:
 * - `simple`: title, message, colours, logo, all escaped;
 * - `html`: a complete HTML document written by the admin, served as is.
 *
 * Both accept the placeholders `{{hostname}}`, `{{until}}` (readable end
 * time, empty when unknown) and `{{until_iso}}`.
 */
import { z } from 'zod';

/** CSS colour: #rgb, #rrggbb, #rrggbbaa. */
const colorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, 'Use a colour like #1f2937');

/** Logo: an https/http URL, or an uploaded image as a data URL (max ~300 KB). */
const logoSchema = z
  .string()
  .trim()
  .max(400_000, 'The logo is too large (300 KB max)')
  .refine(
    (v) =>
      v === '' ||
      /^https?:\/\/\S+$/i.test(v) ||
      /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(v),
    'Use an image URL (https://…) or upload an image',
  );

export const MAINTENANCE_MODES = ['simple', 'html'] as const;

export const maintenancePageSchema = z.object({
  mode: z.enum(MAINTENANCE_MODES).default('simple'),
  title: z.string().trim().max(200).default('Down for maintenance'),
  message: z
    .string()
    .trim()
    .max(4000)
    .default("We're making a few improvements. We'll be back shortly."),
  accentColor: colorSchema.default('#b5562f'),
  backgroundColor: colorSchema.default('#faf7f3'),
  textColor: colorSchema.default('#2a1f18'),
  logoUrl: logoSchema.default(''),
  /** Show the hostname under the title. */
  showHostname: z.boolean().default(true),
  /** Full HTML document, used in `html` mode. */
  html: z.string().max(200_000).default(''),
});
export type MaintenancePage = z.output<typeof maintenancePageSchema>;
export type MaintenancePageInput = z.input<typeof maintenancePageSchema>;

export const DEFAULT_MAINTENANCE_PAGE: MaintenancePage = maintenancePageSchema.parse({});

/** Maintenance state of a host. */
export const hostMaintenanceSchema = z.object({
  enabled: z.boolean(),
  /** Expected end, shown on the page and sent as Retry-After. */
  until: z.string().nullable(),
  /** Page for this host only; null = the default page from Settings. */
  page: maintenancePageSchema.nullable(),
});
export type HostMaintenance = z.infer<typeof hostMaintenanceSchema>;

/** PUT /api/hosts/:id/maintenance -> 200 ProxyHost */
export const hostMaintenanceInputSchema = z.object({
  enabled: z.boolean(),
  until: z.string().datetime({ offset: true }).nullable().optional().default(null),
  page: maintenancePageSchema.nullable().optional().default(null),
});
export type HostMaintenanceInput = z.input<typeof hostMaintenanceInputSchema>;

export interface MaintenanceVars {
  hostname: string;
  /** ISO time, or null. */
  until: string | null;
  /** Formats `until` for humans (server: UTC string; browser: local time). */
  formatUntil?: (iso: string) => string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{\{\s*(hostname|until|until_iso)\s*\}\}/g,
    (_m, k: string) => vars[k] ?? '',
  );
}

function defaultFormat(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
        timeZoneName: 'short',
      });
}

/** Render a page to a complete HTML document. */
export function renderMaintenancePage(page: MaintenancePage, vars: MaintenanceVars): string {
  const untilText = vars.until ? (vars.formatUntil ?? defaultFormat)(vars.until) : '';
  if (page.mode === 'html' && page.html.trim()) {
    return fill(page.html, {
      hostname: escapeHtml(vars.hostname),
      until: escapeHtml(untilText),
      until_iso: escapeHtml(vars.until ?? ''),
    });
  }
  const text = (s: string) =>
    escapeHtml(fill(s, { hostname: vars.hostname, until: untilText, until_iso: vars.until ?? '' }));
  const message = text(page.message)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  const logo = page.logoUrl ? `<img class="logo" src="${escapeHtml(page.logoUrl)}" alt="">` : '';
  const host = page.showHostname ? `<p class="host">${escapeHtml(vars.hostname)}</p>` : '';
  const until = untilText
    ? `<p class="until"><span>Expected back</span> ${escapeHtml(untilText)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${text(page.title)}</title>
<style>
  :root { --bg: ${page.backgroundColor}; --fg: ${page.textColor}; --accent: ${page.accentColor}; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { width: 100%; max-width: 34rem; }
  .bar { width: 48px; height: 4px; border-radius: 2px; background: var(--accent); margin-bottom: 28px; }
  .logo { display: block; max-height: 56px; max-width: 220px; margin-bottom: 28px; }
  h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); line-height: 1.2; margin: 0 0 6px; letter-spacing: -0.01em; }
  .host { margin: 0 0 22px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; opacity: 0.6; }
  .msg p { margin: 0 0 12px; opacity: 0.85; }
  .until { margin-top: 26px; padding-top: 16px; border-top: 1px solid color-mix(in srgb, var(--fg) 15%, transparent); font-size: 0.95rem; }
  .until span { color: var(--accent); font-weight: 600; margin-right: 6px; }
</style>
</head>
<body>
<main>
${logo || '<div class="bar"></div>'}
<h1>${text(page.title)}</h1>
${host}
<div class="msg">${message}</div>
${until}
</main>
</body>
</html>
`;
}
