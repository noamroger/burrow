// Copies the committed SQL migrations next to the compiled server so that
// `dist/` can run on its own (this is what ends up in the Docker image).
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'drizzle');
const to = join(root, 'dist', 'drizzle');

if (!existsSync(from)) {
  console.error(`No migrations found in ${from}`);
  process.exit(1);
}
cpSync(from, to, { recursive: true });
console.log(`Copied migrations to ${to}`);
