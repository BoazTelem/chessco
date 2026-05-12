import 'dotenv/config';
import { getGamesDb } from './db';

async function main() {
  const { client } = getGamesDb();
  try {
    const tables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name NOT LIKE 'games_2%'
        AND table_name <> 'games_default'
      ORDER BY table_name
    `;
    console.log('Core tables:');
    for (const t of tables) console.log('  ·', t.table_name);

    const partitionCount = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'games'
    `;
    console.log(`\nPartitions on 'games': ${partitionCount[0]?.n}`);

    const oldest = await client<{ partition_name: string }[]>`
      SELECT c.relname AS partition_name FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE p.relname = 'games'
      ORDER BY c.relname
      LIMIT 1
    `;
    const newest = await client<{ partition_name: string }[]>`
      SELECT c.relname AS partition_name FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE p.relname = 'games'
        AND c.relname <> 'games_default'
      ORDER BY c.relname DESC
      LIMIT 1
    `;
    console.log(`Range: ${oldest[0]?.partition_name} → ${newest[0]?.partition_name}`);

    const indexes = await client<{ tablename: string; indexname: string }[]>`
      SELECT tablename, indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('positions','games','moves','player_position_stats','player_opening_stats','style_features')
      ORDER BY tablename, indexname
    `;
    console.log('\nIndexes:');
    for (const i of indexes) console.log(`  · ${i.tablename}.${i.indexname}`);

    const applied = await client<{ id: string; applied_at: string }[]>`
      SELECT id, applied_at::text FROM games_corpus_migrations ORDER BY applied_at
    `;
    console.log('\nApplied migrations:');
    for (const m of applied) console.log(`  · ${m.id} @ ${m.applied_at}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exit(1);
});
