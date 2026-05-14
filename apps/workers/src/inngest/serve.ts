/**
 * HTTP entry point for Inngest scheduled functions.
 *
 * Deployment target: Cloud Run service running this Node process. Inngest
 * Cloud pings `/api/inngest` to register and execute functions. Long-running
 * federation ingests (FIDE ~10min, USCF Playwright ~3min) run inside this
 * process, so the Cloud Run service has min-instances=0 and request-timeout
 * = 60 min (job-style usage).
 *
 *   pnpm --filter @chessco/workers inngest:dev    # local dev (uses Inngest Dev Server)
 *   pnpm --filter @chessco/workers inngest:serve  # production
 */
import 'dotenv/config';
import http from 'node:http';
import { serve } from 'inngest/node';
import { inngest } from './client.js';
import { accountFingerprintFunctions } from './account-fingerprint.js';
import { corpusCountsHourly } from './corpus-counts.js';
import { crawlRefreshFunctions } from './crawl-refresh.js';
import { crawlerWatchdog } from './crawler-watchdog.js';
import { federationFunctions } from './federations.js';
import { prepareReportsPoll } from './prepare-reports.js';

const PORT = parseInt(process.env.PORT ?? '3030', 10);

const handler = serve({
  client: inngest,
  functions: [
    ...federationFunctions,
    ...crawlRefreshFunctions,
    ...accountFingerprintFunctions,
    corpusCountsHourly,
    crawlerWatchdog,
    prepareReportsPoll,
  ],
});

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'chessco-workers-inngest' }));
    return;
  }
  if (req.url?.startsWith('/api/inngest')) {
    handler(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  console.log(`[inngest] serving on :${PORT}/api/inngest`);
  console.log(`[inngest] registered functions:`);
  for (const fn of [
    ...federationFunctions,
    ...crawlRefreshFunctions,
    ...accountFingerprintFunctions,
    corpusCountsHourly,
    crawlerWatchdog,
    prepareReportsPoll,
  ]) {
    console.log(`  - ${fn.id()}`);
  }
});
