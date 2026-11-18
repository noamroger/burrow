import { defineConfig } from 'drizzle-kit';

/** Drizzle Kit config: `pnpm db:generate` writes versioned SQL migrations to ./drizzle. */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
