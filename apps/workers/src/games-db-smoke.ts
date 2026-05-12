import 'dotenv/config';
import { getGamesDb } from './db';

async function main() {
  const { client } = getGamesDb();
  try {
    const t0 = Date.now();
    const version = await client`SELECT version()`;
    const ping = Date.now() - t0;
    const ssl = await client`SELECT ssl AS ssl_in_use FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
    const ext = await client`
      SELECT extname FROM pg_extension
      WHERE extname IN ('pgcrypto', 'pg_stat_statements')
      ORDER BY extname
    `;
    const who = await client`SELECT current_user, current_database()`;

    console.log('--- Cloud SQL chessco-games smoke test ---');
    console.log('version       :', version[0]?.version);
    console.log('user/db       :', who[0]);
    console.log('ssl_in_use    :', ssl[0]?.ssl_in_use);
    console.log('extensions    :', ext.map((r) => (r as { extname: string }).extname).join(', '));
    console.log('SELECT latency:', ping, 'ms');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('smoke test failed:', err);
  process.exit(1);
});
