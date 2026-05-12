import 'dotenv/config';
import { getGamesDb } from './db';

async function main() {
  const { client } = getGamesDb();
  try {
    const tables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('handles', 'lichess_dump_runs')
      ORDER BY table_name
    `;
    console.log(
      '0002 tables present:',
      tables.map((t) => t.table_name),
    );

    const ext = await client<{ extname: string }[]>`
      SELECT extname FROM pg_extension
      WHERE extname IN ('pg_trgm', 'pgcrypto', 'pg_stat_statements')
      ORDER BY extname
    `;
    console.log(
      'extensions present  :',
      ext.map((e) => e.extname),
    );

    const applied = await client<{ id: string }[]>`
      SELECT id FROM games_corpus_migrations ORDER BY id
    `;
    console.log(
      'applied migrations  :',
      applied.map((m) => m.id),
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('state check failed:', err);
  process.exit(1);
});
