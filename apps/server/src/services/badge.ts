/**
 * The public status badge, drawn as a standalone SVG.
 *
 * Design: a strip of "soil" (Burrow's dark brown) with the burrow entrance on
 * the left, whose lamp takes the status colour; the status and the 30-day
 * uptime in monospace; a row of twelve hourly bars (the last 12 hours) that
 * rise like grass from the ground; and a clay base line under everything,
 * the layer of earth the tunnel is dug in. `chalk` is the light variant.
 *
 * Every text uses `textLength`, so the layout is exact whatever monospace
 * font the viewer has.
 */

export interface BadgeData {
  label: string;
  state: 'up' | 'down' | 'unknown';
  /** 30-day uptime (0 to 1), null without data. */
  uptime: number | null;
  /** Hourly uptime of the last 12 hours, oldest first; null = no probe. */
  hours: Array<number | null>;
  theme: 'soil' | 'chalk';
}

const THEMES = {
  soil: {
    left: '#2a1f18',
    right: '#3b2c22',
    text: '#e9dfd5',
    muted: '#a8988a',
    hole: '#120b07',
    empty: '#5a4a3f',
    border: null as string | null,
    up: '#8cc79a',
    warn: '#e0a648',
    down: '#ec7b73',
  },
  chalk: {
    left: '#faf7f3',
    right: '#f3ede6',
    text: '#2a1f18',
    muted: '#6f6157',
    hole: '#2a1f18',
    empty: '#d8cbbd',
    border: '#e4dace' as string | null,
    up: '#3f7d4e',
    warn: '#a86a12',
    down: '#b4322f',
  },
};

const CLAY = '#b5562f';
const FONT =
  "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";
/** Advance of one character at 11px in a monospace font (0.6 em). */
const CHAR = 6.6;
const H = 28;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `0.99987` -> `99.99%`, `1` -> `100%`. */
export function formatUptime(uptime: number | null): string {
  if (uptime === null) return 'no data';
  const pct = Math.floor(uptime * 10_000) / 100;
  return `${pct.toFixed(2).replace(/\.?0+$/, '')}%`;
}

function text(x: number, value: string, fill: string, weight = 400): string {
  const width = (value.length * CHAR).toFixed(1);
  return `<text x="${x.toFixed(1)}" y="18" fill="${fill}" font-family="${FONT}" font-size="11" font-weight="${weight}" textLength="${width}" lengthAdjust="spacingAndGlyphs">${escapeXml(value)}</text>`;
}

/** Render the badge. Pure: unit tested. */
export function renderBadge(data: BadgeData): string {
  const c = THEMES[data.theme];
  const label = data.label.length > 40 ? `${data.label.slice(0, 39)}…` : data.label;
  const stateColor = data.state === 'up' ? c.up : data.state === 'down' ? c.down : c.muted;
  // Unknown with no history: only "no data", not "n/a no data".
  const status = data.state === 'unknown' ? (data.uptime === null ? '' : 'n/a') : data.state;
  const uptime = formatUptime(data.uptime);

  const leftW = Math.round(30 + label.length * CHAR + 10);
  const statusX = leftW + 10;
  const uptimeX = status ? statusX + status.length * CHAR + 7 : statusX;
  const stripX = Math.round(uptimeX + uptime.length * CHAR + 10);
  const BAR = 3;
  const GAP = 1.5;
  const stripW = data.hours.length * (BAR + GAP) - GAP;
  const width = Math.round(stripX + stripW + 10);

  const bars = data.hours
    .map((h, i) => {
      const x = (stripX + i * (BAR + GAP)).toFixed(1);
      if (h === null)
        return `<rect x="${x}" y="19" width="${BAR}" height="3" rx="0.5" fill="${c.empty}"/>`;
      const height = Math.max(4, Math.round(5 + h * 9));
      const fill = h >= 0.999 ? c.up : h >= 0.9 ? c.warn : c.down;
      return `<rect x="${x}" y="${22 - height}" width="${BAR}" height="${height}" rx="0.5" fill="${fill}"/>`;
    })
    .join('');

  const title = `${data.label}: ${status || 'unknown'}, ${uptime} uptime over 30 days`;
  // Burrow entrance: mound arch, dark hole, lamp in the status colour.
  const glyph =
    `<path d="M9 22v-5.5a6 6 0 0 1 12 0V22z" fill="${CLAY}"/>` +
    `<path d="M11.5 22v-5a3.5 3.5 0 0 1 7 0v5z" fill="${c.hole}"/>` +
    `<circle cx="15" cy="18.6" r="1.6" fill="${stateColor}"/>` +
    `<circle cx="15" cy="18.6" r="3.2" fill="${stateColor}" opacity="0.18"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<clipPath id="r"><rect width="${width}" height="${H}" rx="5"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${width}" height="${H}" fill="${c.right}"/>`,
    `<rect width="${leftW}" height="${H}" fill="${c.left}"/>`,
    c.border
      ? `<rect x="0.5" y="0.5" width="${width - 1}" height="${H - 1}" rx="4.5" fill="none" stroke="${c.border}"/>`
      : '',
    `<rect y="${H - 3}" width="${width}" height="3" fill="${CLAY}"/>`,
    `<rect x="${leftW}" y="${H - 3}" width="${width - leftW}" height="1" fill="#000" opacity="0.12"/>`,
    `</g>`,
    glyph,
    text(30, label, c.text, 500),
    status ? text(statusX, status, stateColor, 700) : '',
    text(uptimeX, uptime, c.text),
    bars,
    `</svg>`,
  ].join('');
}
