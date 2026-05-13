/**
 * Registry of (platform, region) → Cloud Run job env-var prefix.
 *
 * Env-var convention follows existing USCF pattern in
 * cloud-run-jobs.ts: `${PREFIX}_PROJECT_ID`, `${PREFIX}_REGION`,
 * `${PREFIX}_JOB_NAME`. Missing values cause the watchdog to skip
 * that region (graceful degradation — only the regions you've
 * provisioned actually get dispatched).
 *
 * Add a new region: drop a new entry here AND set the three env vars
 * in the inngest:serve process. No code changes needed beyond this
 * registry.
 */
export type CrawlerRegion = {
  /** Stable id used as worker_id in chesscom_crawl_runs / lichess_crawl_runs. */
  workerId: string;
  /** Prefix for cloudRunJobFromEnv lookup. */
  envPrefix: string;
};

export const CHESSCOM_REGIONS: CrawlerRegion[] = [
  { workerId: 'cloud-us', envPrefix: 'CHESSCOM_CRAWL_US' },
  { workerId: 'cloud-eu', envPrefix: 'CHESSCOM_CRAWL_EU' },
  { workerId: 'cloud-asia', envPrefix: 'CHESSCOM_CRAWL_ASIA' },
  { workerId: 'cloud-au', envPrefix: 'CHESSCOM_CRAWL_AU' },
];

export const LICHESS_REGIONS: CrawlerRegion[] = [
  { workerId: 'cloud-us', envPrefix: 'LICHESS_CRAWL_US' },
  { workerId: 'cloud-eu', envPrefix: 'LICHESS_CRAWL_EU' },
];
