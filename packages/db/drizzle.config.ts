import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config — used for `pnpm drizzle:generate` and `drizzle:studio`.
 *
 * Migrations live in ./migrations and are the source of truth applied via
 * Supabase MCP (see packages/db/migrations/README.md). drizzle-kit is used
 * here primarily for `studio` (visual DB browser) and ad-hoc migration
 * generation when iterating on schema.ts.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
