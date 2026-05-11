/**
 * @chessco/db — Drizzle schema, types, and DB client factory.
 *
 * The SQL in packages/db/migrations/ is the source of truth for the deployed
 * database; this package mirrors that schema in TypeScript for type-safe
 * queries from the app.
 */

export * as schema from './schema';
export * from './schema';
export { db } from './client';

export const schemaVersion = '0.1.0' as const;
