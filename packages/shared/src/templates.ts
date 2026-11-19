/**
 * Service templates: common self-hosted apps with the origin settings they
 * need behind Cloudflare Tunnel. Picking one in the host form (or setting the
 * `burrow.template` Docker label) prefills the service URL and the
 * `originRequest` options.
 *
 * Notes on WebSockets: cloudflared proxies WebSocket upgrades on every HTTP
 * route, no option is needed. Templates only say when an app relies on them
 * so the user knows it will work.
 */
import { z } from 'zod';

export const TEMPLATE_CATEGORIES = [
  'media',
  'home',
  'files',
  'infrastructure',
  'monitoring',
  'development',
  'remote',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const serviceTemplateSchema = z.object({
  /** Stable id, also used by the `burrow.template` Docker label, e.g. `jellyfin`. */
  id: z.string(),
  name: z.string(),
  category: z.enum(TEMPLATE_CATEGORIES),
  description: z.string(),
  /** Origin protocol: `http`, `https`, `ssh`, `rdp` or `tcp`. */
  scheme: z.enum(['http', 'https', 'ssh', 'rdp', 'tcp']),
  /** Default port of the app. */
  port: z.number().int().min(1).max(65535),
  /** Usual container / host name, used to prefill the service URL. */
  container: z.string(),
  /** Suggested subdomain. */
  subdomain: z.string(),
  options: z.object({
    noTLSVerify: z.boolean(),
    httpHostHeader: z.string(),
    originServerName: z.string(),
  }),
  /** The app uses WebSockets (live updates, consoles…). cloudflared handles them out of the box. */
  websockets: z.boolean(),
  /** Admin panels that should sit behind Cloudflare Access. */
  recommendAccess: z.boolean(),
  /** Browser-rendered terminal Cloudflare can show for this service (needs Access). */
  browserRendering: z.enum(['ssh', 'vnc']).nullable(),
  /** Things to configure in the app itself, shown in the form. */
  notes: z.array(z.string()),
});
export type ServiceTemplate = z.infer<typeof serviceTemplateSchema>;

/** GET /api/templates -> 200 */
export const serviceTemplateListSchema = z.object({ templates: z.array(serviceTemplateSchema) });
export type ServiceTemplateList = z.infer<typeof serviceTemplateListSchema>;

type TemplateDef = Omit<
  ServiceTemplate,
  'options' | 'websockets' | 'recommendAccess' | 'notes' | 'browserRendering'
> & {
  browserRendering?: 'ssh' | 'vnc' | null;
  options?: Partial<ServiceTemplate['options']>;
  websockets?: boolean;
  recommendAccess?: boolean;
  notes?: string[];
};

function define(def: TemplateDef): ServiceTemplate {
  return {
    ...def,
    options: {
      noTLSVerify: false,
      httpHostHeader: '',
      originServerName: '',
      ...def.options,
    },
    websockets: def.websockets ?? false,
    recommendAccess: def.recommendAccess ?? false,
    browserRendering: def.browserRendering ?? null,
    notes: def.notes ?? [],
  };
}

const SELF_SIGNED = 'It serves HTTPS with a self-signed certificate, so noTLSVerify is turned on.';

export const SERVICE_TEMPLATES: readonly ServiceTemplate[] = [
  /* ---- media ---- */
  define({
    id: 'jellyfin',
    name: 'Jellyfin',
    category: 'media',
    description: 'Media server for movies, shows and music.',
    scheme: 'http',
    port: 8096,
    container: 'jellyfin',
    subdomain: 'jellyfin',
    websockets: true,
    notes: [
      'Streaming video through Cloudflare is subject to its terms of service; prefer Access-protected or private use.',
    ],
  }),
  define({
    id: 'plex',
    name: 'Plex',
    category: 'media',
    description: 'Media server with apps for every device.',
    scheme: 'http',
    port: 32400,
    container: 'plex',
    subdomain: 'plex',
    websockets: true,
    notes: [
      'In Plex › Settings › Network, add https://<hostname>:443 to "Custom server access URLs".',
    ],
  }),
  define({
    id: 'jellyseerr',
    name: 'Jellyseerr / Overseerr',
    category: 'media',
    description: 'Request management for Jellyfin, Plex and the *arr apps.',
    scheme: 'http',
    port: 5055,
    container: 'jellyseerr',
    subdomain: 'requests',
  }),
  define({
    id: 'immich',
    name: 'Immich',
    category: 'media',
    description: 'Photo and video backup.',
    scheme: 'http',
    port: 2283,
    container: 'immich_server',
    subdomain: 'photos',
    websockets: true,
    notes: [
      'Cloudflare limits request bodies to 100 MB on the Free plan: large videos may fail to upload from the browser.',
    ],
  }),
  define({
    id: 'navidrome',
    name: 'Navidrome',
    category: 'media',
    description: 'Music streaming server (Subsonic compatible).',
    scheme: 'http',
    port: 4533,
    container: 'navidrome',
    subdomain: 'music',
  }),
  define({
    id: 'audiobookshelf',
    name: 'Audiobookshelf',
    category: 'media',
    description: 'Audiobook and podcast server.',
    scheme: 'http',
    port: 13378,
    container: 'audiobookshelf',
    subdomain: 'books',
    websockets: true,
  }),

  /* ---- home ---- */
  define({
    id: 'home-assistant',
    name: 'Home Assistant',
    category: 'home',
    description: 'Home automation.',
    scheme: 'http',
    port: 8123,
    container: 'homeassistant',
    subdomain: 'home',
    websockets: true,
    notes: [
      'Add "http: { use_x_forwarded_for: true, trusted_proxies: [<Burrow container IP or subnet>] }" to configuration.yaml, or Home Assistant answers 400 Bad Request.',
      'Mobile apps cannot pass Cloudflare Access: leave Access off and rely on Home Assistant login with 2FA.',
    ],
  }),
  define({
    id: 'node-red',
    name: 'Node-RED',
    category: 'home',
    description: 'Flow-based automation editor.',
    scheme: 'http',
    port: 1880,
    container: 'nodered',
    subdomain: 'nodered',
    websockets: true,
    recommendAccess: true,
  }),
  define({
    id: 'frigate',
    name: 'Frigate',
    category: 'home',
    description: 'NVR with object detection.',
    scheme: 'https',
    port: 8971,
    container: 'frigate',
    subdomain: 'nvr',
    options: { noTLSVerify: true },
    websockets: true,
    notes: [SELF_SIGNED],
  }),

  /* ---- files ---- */
  define({
    id: 'nextcloud',
    name: 'Nextcloud',
    category: 'files',
    description: 'Files, calendar and contacts.',
    scheme: 'http',
    port: 80,
    container: 'nextcloud',
    subdomain: 'cloud',
    notes: [
      "Add the hostname to 'trusted_domains' and set 'overwriteprotocol' => 'https' in config.php.",
      'Cloudflare limits request bodies to 100 MB on the Free plan: the desktop client uploads in chunks and is not affected.',
    ],
  }),
  define({
    id: 'vaultwarden',
    name: 'Vaultwarden',
    category: 'files',
    description: 'Bitwarden-compatible password manager.',
    scheme: 'http',
    port: 80,
    container: 'vaultwarden',
    subdomain: 'vault',
    websockets: true,
    notes: ['Set the DOMAIN environment variable to https://<hostname>.'],
  }),
  define({
    id: 'paperless-ngx',
    name: 'Paperless-ngx',
    category: 'files',
    description: 'Document management.',
    scheme: 'http',
    port: 8000,
    container: 'paperless',
    subdomain: 'paperless',
    websockets: true,
    notes: ['Set PAPERLESS_URL to https://<hostname>.'],
  }),
  define({
    id: 'syncthing',
    name: 'Syncthing (web UI)',
    category: 'files',
    description: 'File synchronisation dashboard.',
    scheme: 'http',
    port: 8384,
    container: 'syncthing',
    subdomain: 'syncthing',
    options: { httpHostHeader: 'localhost' },
    recommendAccess: true,
    notes: ['The web UI only accepts the "localhost" Host header unless host checks are disabled.'],
  }),

  /* ---- infrastructure ---- */
  define({
    id: 'proxmox',
    name: 'Proxmox VE',
    category: 'infrastructure',
    description: 'Virtualisation platform.',
    scheme: 'https',
    port: 8006,
    container: '192.168.1.2',
    subdomain: 'proxmox',
    options: { noTLSVerify: true },
    websockets: true,
    recommendAccess: true,
    notes: [SELF_SIGNED, 'The noVNC and xterm.js consoles work through the tunnel.'],
  }),
  define({
    id: 'portainer',
    name: 'Portainer',
    category: 'infrastructure',
    description: 'Docker management UI.',
    scheme: 'https',
    port: 9443,
    container: 'portainer',
    subdomain: 'portainer',
    options: { noTLSVerify: true },
    websockets: true,
    recommendAccess: true,
    notes: [SELF_SIGNED],
  }),
  define({
    id: 'synology-dsm',
    name: 'Synology DSM',
    category: 'infrastructure',
    description: 'Synology NAS administration.',
    scheme: 'https',
    port: 5001,
    container: '192.168.1.3',
    subdomain: 'nas',
    options: { noTLSVerify: true },
    recommendAccess: true,
    notes: [SELF_SIGNED],
  }),
  define({
    id: 'truenas',
    name: 'TrueNAS',
    category: 'infrastructure',
    description: 'TrueNAS administration.',
    scheme: 'https',
    port: 443,
    container: '192.168.1.4',
    subdomain: 'truenas',
    options: { noTLSVerify: true },
    websockets: true,
    recommendAccess: true,
    notes: [SELF_SIGNED],
  }),
  define({
    id: 'unraid',
    name: 'Unraid',
    category: 'infrastructure',
    description: 'Unraid administration.',
    scheme: 'http',
    port: 80,
    container: '192.168.1.5',
    subdomain: 'unraid',
    websockets: true,
    recommendAccess: true,
  }),
  define({
    id: 'adguard-home',
    name: 'AdGuard Home',
    category: 'infrastructure',
    description: 'Network-wide ad blocking.',
    scheme: 'http',
    port: 80,
    container: 'adguardhome',
    subdomain: 'adguard',
    recommendAccess: true,
  }),
  define({
    id: 'pihole',
    name: 'Pi-hole',
    category: 'infrastructure',
    description: 'Network-wide ad blocking.',
    scheme: 'http',
    port: 80,
    container: 'pihole',
    subdomain: 'pihole',
    recommendAccess: true,
  }),

  /* ---- monitoring ---- */
  define({
    id: 'grafana',
    name: 'Grafana',
    category: 'monitoring',
    description: 'Dashboards and alerting.',
    scheme: 'http',
    port: 3000,
    container: 'grafana',
    subdomain: 'grafana',
    websockets: true,
    notes: ['Set GF_SERVER_ROOT_URL to https://<hostname>.'],
  }),
  define({
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    category: 'monitoring',
    description: 'Uptime monitoring.',
    scheme: 'http',
    port: 3001,
    container: 'uptime-kuma',
    subdomain: 'status',
    websockets: true,
  }),

  /* ---- development ---- */
  define({
    id: 'gitea',
    name: 'Gitea / Forgejo',
    category: 'development',
    description: 'Git hosting.',
    scheme: 'http',
    port: 3000,
    container: 'gitea',
    subdomain: 'git',
    notes: [
      'Set ROOT_URL to https://<hostname>/. Git over SSH needs a separate SSH host (see the SSH template).',
    ],
  }),
  define({
    id: 'code-server',
    name: 'code-server',
    category: 'development',
    description: 'VS Code in the browser.',
    scheme: 'http',
    port: 8080,
    container: 'code-server',
    subdomain: 'code',
    websockets: true,
    recommendAccess: true,
  }),
  /* ---- remote access ---- */
  define({
    id: 'ssh',
    name: 'SSH server',
    category: 'remote',
    description: 'Shell access: a terminal in the browser, or ssh with cloudflared on the client.',
    scheme: 'ssh',
    port: 22,
    container: '192.168.1.10',
    subdomain: 'ssh',
    recommendAccess: true,
    browserRendering: 'ssh',
    notes: [
      'In the browser terminal, the part of the Access email before the @ must be a user on the server.',
      'The server must accept the curve25519-sha256 or ecdh-sha2-nistp256 key exchange (default on recent OpenSSH).',
    ],
  }),
  define({
    id: 'vnc',
    name: 'VNC desktop',
    category: 'remote',
    description: 'Remote desktop over VNC, rendered in the browser by Cloudflare.',
    scheme: 'tcp',
    port: 5900,
    container: '192.168.1.11',
    subdomain: 'vnc',
    recommendAccess: true,
    browserRendering: 'vnc',
  }),
  define({
    id: 'rdp',
    name: 'Windows Remote Desktop',
    category: 'remote',
    description: 'Remote Desktop through cloudflared on the client.',
    scheme: 'rdp',
    port: 3389,
    container: '192.168.1.12',
    subdomain: 'rdp',
    recommendAccess: true,
    notes: [
      'Users run "cloudflared access rdp" on their computer, then connect their RDP client to localhost:3389 (the command is shown on the host).',
      "Cloudflare's browser-based RDP needs a private network route and an Access target, which Burrow does not set up.",
    ],
  }),
];

export const TEMPLATE_IDS = SERVICE_TEMPLATES.map((t) => t.id);

/** Find a template by id (case-insensitive). */
export function findTemplate(id: string | null | undefined): ServiceTemplate | undefined {
  if (!id) return undefined;
  const key = id.trim().toLowerCase();
  return SERVICE_TEMPLATES.find((t) => t.id === key);
}

/** Template id accepted in host input: a known id, or null for none. */
export const templateIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => TEMPLATE_IDS.includes(v), 'Unknown template')
  .nullable();

/** The service URL a template suggests for an address (container name or IP). */
export function templateServiceUrl(
  template: ServiceTemplate,
  address = template.container,
): string {
  return `${template.scheme}://${address}:${template.port}`;
}
