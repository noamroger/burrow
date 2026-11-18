/**
 * Secret scrubbing for anything that ends up in logs (pino output and the
 * cloudflared log buffer shown in the UI).
 */

const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Tunnel run tokens and JWTs are base64-encoded JSON: they start with "eyJ".
  /eyJ[A-Za-z0-9+/_=-]{16,}(?:\.[A-Za-z0-9+/_=-]+)*/g,
  // "Authorization: Bearer xxx"
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value / key: value pairs whose key looks secret.
  /((?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',&]{6,}/gi,
  // Cloudflare API tokens: 40 url-safe characters.
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/g,
];

/**
 * Replace secret-looking substrings with `[REDACTED]`.
 * @param input text to clean
 * @param known exact secret values to remove as well (e.g. the current token)
 */
export function scrubSecrets(input: string, known: readonly string[] = []): string {
  let out = input;
  for (const secret of known) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix?: unknown) =>
      typeof prefix === 'string' && match.startsWith(prefix) && prefix !== match
        ? `${prefix}${REDACTED}`
        : REDACTED,
    );
  }
  return out;
}
