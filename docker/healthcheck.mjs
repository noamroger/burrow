/* global process, fetch, AbortSignal */
// Docker HEALTHCHECK probe. The image has no curl or wget on purpose, so we
// use Node's built-in fetch. Exits 0 when GET /api/health answers 2xx.
const port = process.env.PORT || '8080';
const url = `http://127.0.0.1:${port}/api/health`;

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
