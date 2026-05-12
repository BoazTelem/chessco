import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGamesDb } from './db';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../../../packages/db/migrations/games-corpus');

async function main() {
  const { client } = getGamesDb();
  try {
    await client`
      CREATE TABLE IF NOT EXISTS games_corpus_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT NOW()
      )
    `;

    const applied = new Set(
      (await client<{ id: string }[]>`SELECT id FROM games_corpus_migrations`).map((r) => r.id),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    if (files.length === 0) {
      console.log('No migration files found in', MIGRATIONS_DIR);
      return;
    }

    for (const file of files) {
      const id = file.replace(/\.sql$/, '');
      if (applied.has(id)) {
        console.log(`✓ ${id} (already applied)`);
        continue;
      }
      console.log(`→ applying ${id}…`);
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const t0 = Date.now();
      await client.unsafe(sql);
      const dur = Date.now() - t0;
      console.log(`  applied in ${dur}ms`);
    }

    console.log('All games-corpus migrations applied.');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('games-db migration failed:', err);
  process.exit(1);
});
