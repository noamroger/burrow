/**
 * Run the fake Cloudflare API for local development and end-to-end checks:
 *
 *   pnpm --filter @burrow/server mock:cf
 *
 * Then start Burrow with
 *   CLOUDFLARE_API_BASE=http://localhost:8787/client/v4
 *   CLOUDFLARED_PATH=apps/server/test/fixtures/fake-cloudflared.sh
 * and paste any token of 20+ characters in the UI.
 *
 * MOCK_CF_PORT (default 8787) and MOCK_CF_HOST (default 127.0.0.1; use
 * 0.0.0.0 when a container must reach it) change where it listens.
 */
import { MOCK_ACCOUNT_ID, MOCK_ZONES, MockCloudflare } from '../mock/cloudflare.js';

const port = Number(process.env.MOCK_CF_PORT ?? 8787);
const host = process.env.MOCK_CF_HOST ?? '127.0.0.1';
const mock = new MockCloudflare();
const url = await mock.listen(port, host);

console.log(`Mock Cloudflare API listening on ${url}`);
console.log(`  account: ${MOCK_ACCOUNT_ID} (Mock Account)`);
for (const z of MOCK_ZONES) console.log(`  zone:    ${z.id} (${z.name})`);
console.log('  any token of 20+ characters works; tokens containing "invalid" are rejected');

const stop = () => {
  void mock.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
