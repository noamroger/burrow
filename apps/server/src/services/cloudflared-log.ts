import type { LogLevel } from '@burrow/shared';

const LEVELS: Record<string, LogLevel> = {
  DBG: 'debug',
  INF: 'info',
  WRN: 'warn',
  ERR: 'error',
  FTL: 'fatal',
  PNC: 'fatal',
};

const LINE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+([A-Z]{3})\s+(.*)$/;

/** A cloudflared log line split into its parts. */
export interface ParsedLogLine {
  time: string;
  level: LogLevel;
  message: string;
}

/**
 * Parse one cloudflared output line, e.g.
 * `2026-11-18T10:00:00Z INF Registered tunnel connection connIndex=0 ...`.
 * Lines that do not follow the format are kept as `info` messages.
 */
export function parseCloudflaredLine(
  raw: string,
  now: () => Date = () => new Date(),
): ParsedLogLine {
  const line = raw.replace(/\s+$/, '');
  const m = LINE_RE.exec(line);
  if (m) {
    const date = new Date(m[1]!);
    return {
      time: Number.isNaN(date.getTime()) ? now().toISOString() : date.toISOString(),
      level: LEVELS[m[2]!] ?? 'info',
      message: m[3]!,
    };
  }
  return { time: now().toISOString(), level: 'info', message: line };
}

/** True when the line means a connection to the Cloudflare edge is up. */
export function isConnectedLine(message: string): boolean {
  return message.includes('Registered tunnel connection');
}
