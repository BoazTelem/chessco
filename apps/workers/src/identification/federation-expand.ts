/**
 * Federation-anchored handle expansion — generates online-handle hypotheses
 * from FIDE-rated tournament players, bulk-checks existence on Lichess, and
 * inserts the live ones into Supabase `platform_players` with claim metadata.
 *
 * v1 supports Lichess only because /api/users accepts 300 comma-separated
 * handles per POST and returns live profiles in a single round-trip. The
 * chess.com /pub/player endpoint is per-handle and rate-limited, which makes
 * bulk expansion impractical without a separate slower mode — queued.
 *
 * Why this exists: the chess.com platform_players directory has ~106k
 * handles, all from prior titled / country crawls. There are ~553k FIDE-
 * rated 1400+ tournament players. Generating ~10 plausible handles per
 * player produces a candidate pool of ~5M; most are dead, but the live
 * ones we discover are tournament-active by definition — exactly the
 * audience the matcher needs to recognize.
 *
 * Usage:
 *   pnpm --filter @chessco/workers identification:expand --limit 1000
 *   pnpm --filter @chessco/workers identification:expand --country NOR
 *   pnpm --filter @chessco/workers identification:expand --min-rating 1800
 *   pnpm --filter @chessco/workers identification:expand --top-n 10 --batch-size 300
 *   pnpm --filter @chessco/workers identification:expand --dry-run
 *
 * Output: per-batch progress + final summary (FIDE players read, hypotheses
 * generated, deduplicated, batches sent, live handles discovered, rows
 * upserted). Idempotent — re-running with the same args updates existing
 * platform_players rows but doesn't duplicate them.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getDb } from '../db';
import { hypothesizeHandles } from './hypothesize';

const LICHESS_USERS_URL = 'https://lichess.org/api/users';
const LICHESS_MAX_PER_REQUEST = 300;
const DEFAULT_TOP_N = 10;
const DEFAULT_MIN_RATING = 1400;
const DEFAULT_BATCH_SIZE = 300;
const DEFAULT_REQUEST_GAP_MS = 1000; // 1 req/s for politeness; Lichess unauth ceiling is much higher

interface CliArgs {
  limit: number | null;
  country: string | null;
  minRating: number;
  topN: number;
  batchSize: number;
  requestGapMs: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    limit: null,
    country: null,
    minRating: DEFAULT_MIN_RATING,
    topN: DEFAULT_TOP_N,
    batchSize: DEFAULT_BATCH_SIZE,
    requestGapMs: DEFAULT_REQUEST_GAP_MS,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) out.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--country' && argv[i + 1]) out.country = argv[++i]!.toUpperCase();
    else if (a === '--min-rating' && argv[i + 1]) out.minRating = Number.parseInt(argv[++i]!, 10);
    else if (a === '--top-n' && argv[i + 1]) out.topN = Number.parseInt(argv[++i]!, 10);
    else if (a === '--batch-size' && argv[i + 1]) {
      out.batchSize = Number.parseInt(argv[++i]!, 10);
      if (out.batchSize > LICHESS_MAX_PER_REQUEST) {
        throw new Error(`--batch-size cannot exceed Lichess limit of ${LICHESS_MAX_PER_REQUEST}`);
      }
    } else if (a === '--rate-ms' && argv[i + 1]) {
      out.requestGapMs = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

interface FedPlayer {
  id: string;
  name: string;
  name_normalized: string;
  country: string | null;
  birth_year: number | null;
  rating_standard: number | null;
}

interface LichessUserResponse {
  id: string;
  username: string;
  title?: string;
  closed?: boolean;
  tosViolation?: boolean;
  profile?: {
    country?: string;
  };
  perfs?: Record<string, { rating?: number } | undefined>;
}

/** Read FIDE+ICF players matching the filter. Streams via cursor would be
 *  nicer for huge --limit values, but the largest case (all 553k 1400+
 *  players) is still fine in memory at ~150 bytes per row = ~85 MB. */
async function readFederationPlayers(sql: postgres.Sql, args: CliArgs): Promise<FedPlayer[]> {
  if (args.country && args.limit) {
    return sql<FedPlayer[]>`
      SELECT id::text, name, name_normalized, country, birth_year, rating_standard
      FROM federation_players
      WHERE rating_standard >= ${args.minRating} AND country = ${args.country}
      ORDER BY rating_standard DESC NULLS LAST
      LIMIT ${args.limit}
    `;
  }
  if (args.country) {
    return sql<FedPlayer[]>`
      SELECT id::text, name, name_normalized, country, birth_year, rating_standard
      FROM federation_players
      WHERE rating_standard >= ${args.minRating} AND country = ${args.country}
      ORDER BY rating_standard DESC NULLS LAST
    `;
  }
  if (args.limit) {
    return sql<FedPlayer[]>`
      SELECT id::text, name, name_normalized, country, birth_year, rating_standard
      FROM federation_players
      WHERE rating_standard >= ${args.minRating}
      ORDER BY rating_standard DESC NULLS LAST
      LIMIT ${args.limit}
    `;
  }
  return sql<FedPlayer[]>`
    SELECT id::text, name, name_normalized, country, birth_year, rating_standard
    FROM federation_players
    WHERE rating_standard >= ${args.minRating}
    ORDER BY rating_standard DESC NULLS LAST
  `;
}

/** For each FIDE player, generate hypotheses and emit (handle → claim) edges.
 *  Multiple FIDE players may share a hypothesis (e.g. two "Andersen"s both
 *  produce "andersen"); we keep all edges and pick the strongest claim
 *  (highest rating_standard) when a live handle is discovered. */
interface HandleClaim {
  handle: string;
  // The strongest claim wins: pick the FIDE player with highest rating
  // among everyone who hypothesised this handle.
  fedPlayerId: string;
  fedPlayerName: string;
  fedPlayerNameNormalized: string;
  fedCountry: string | null;
  fedRating: number; // for tie-breaking
}

function generateClaims(players: FedPlayer[], topN: number): Map<string, HandleClaim> {
  const claims = new Map<string, HandleClaim>();
  for (const p of players) {
    const hyps = hypothesizeHandles({
      name: p.name,
      country: p.country,
      birth_year: p.birth_year,
    }).slice(0, topN);

    for (const h of hyps) {
      const handle = h.handle.toLowerCase();
      const existing = claims.get(handle);
      const candidate: HandleClaim = {
        handle,
        fedPlayerId: p.id,
        fedPlayerName: p.name,
        fedPlayerNameNormalized: p.name_normalized,
        fedCountry: p.country,
        fedRating: p.rating_standard ?? 0,
      };
      if (!existing || candidate.fedRating > existing.fedRating) {
        claims.set(handle, candidate);
      }
    }
  }
  return claims;
}

/** Filter out handles already known in platform_players (lichess). Reading
 *  them once with a single IN-list is faster than per-handle lookups. */
async function dropAlreadyKnown(sql: postgres.Sql, handles: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  // Chunk to stay under the 65k param cap; 5000 per round is comfy.
  const CHUNK = 5000;
  for (let i = 0; i < handles.length; i += CHUNK) {
    const slice = handles.slice(i, i + CHUNK);
    const rows = await sql<{ handle: string }[]>`
      SELECT handle FROM platform_players
      WHERE platform = 'lichess' AND handle = ANY(${slice}::text[])
    `;
    for (const r of rows) known.add(r.handle.toLowerCase());
  }
  return known;
}

/** POST a batch of up to 300 handles to lichess /api/users. Returns the
 *  list of live profiles (dead handles are simply omitted by the API). */
async function fetchLichessUsers(handles: string[]): Promise<LichessUserResponse[]> {
  const body = handles.join(',');
  const res = await fetch(LICHESS_USERS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      Accept: 'application/json',
      'User-Agent': 'chessco-worker/0.1 (+https://chessco.org)',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`lichess /api/users ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as LichessUserResponse[];
}

/** Upsert a discovered live handle into platform_players with the federation
 *  claim. Idempotent. If a row already exists with a *different* claim, we
 *  keep the existing claim (first one wins) but refresh the rating + title
 *  snapshot so the cached pool stays current. */
async function upsertHandle(
  sql: postgres.Sql,
  profile: LichessUserResponse,
  claim: HandleClaim,
): Promise<void> {
  const handle = profile.username.toLowerCase();
  const country = profile.profile?.country ?? claim.fedCountry ?? null;
  const title = profile.title ?? null;
  const ratingBullet = profile.perfs?.bullet?.rating ?? null;
  const ratingBlitz = profile.perfs?.blitz?.rating ?? null;
  const ratingRapid = profile.perfs?.rapid?.rating ?? null;
  const ratingClassical = profile.perfs?.classical?.rating ?? null;

  await sql`
    INSERT INTO platform_players (
      platform, handle, handle_normalized, country, title,
      rating_bullet, rating_blitz, rating_rapid, rating_classical,
      pulled_via, claimed_name, claimed_name_normalized,
      claimed_federation_player_id, claimed_federation_resolved_at,
      first_seen_at, last_seen_at
    ) VALUES (
      'lichess', ${handle}, ${handle}, ${country}, ${title},
      ${ratingBullet}, ${ratingBlitz}, ${ratingRapid}, ${ratingClassical},
      'federation-expand', ${claim.fedPlayerName}, ${claim.fedPlayerNameNormalized},
      ${claim.fedPlayerId}::uuid, NOW(),
      NOW(), NOW()
    )
    ON CONFLICT (platform, handle) DO UPDATE SET
      country = COALESCE(platform_players.country, EXCLUDED.country),
      title = COALESCE(EXCLUDED.title, platform_players.title),
      rating_bullet = COALESCE(EXCLUDED.rating_bullet, platform_players.rating_bullet),
      rating_blitz = COALESCE(EXCLUDED.rating_blitz, platform_players.rating_blitz),
      rating_rapid = COALESCE(EXCLUDED.rating_rapid, platform_players.rating_rapid),
      rating_classical = COALESCE(EXCLUDED.rating_classical, platform_players.rating_classical),
      claimed_name = COALESCE(platform_players.claimed_name, EXCLUDED.claimed_name),
      claimed_name_normalized = COALESCE(platform_players.claimed_name_normalized, EXCLUDED.claimed_name_normalized),
      claimed_federation_player_id = COALESCE(platform_players.claimed_federation_player_id, EXCLUDED.claimed_federation_player_id),
      claimed_federation_resolved_at = COALESCE(platform_players.claimed_federation_resolved_at, EXCLUDED.claimed_federation_resolved_at),
      last_seen_at = NOW()
  `;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { client: sql } = getDb();

  try {
    console.log(
      `[fed-expand] platform=lichess min-rating=${args.minRating} ` +
        `${args.country ? `country=${args.country} ` : ''}` +
        `${args.limit ? `limit=${args.limit} ` : ''}` +
        `top-n=${args.topN} batch-size=${args.batchSize}` +
        `${args.dryRun ? ' DRY-RUN' : ''}`,
    );

    // 1. Read federation players
    const t0 = Date.now();
    const players = await readFederationPlayers(sql, args);
    console.log(
      `[fed-expand] read ${fmt(players.length)} federation players in ${(
        (Date.now() - t0) /
        1000
      ).toFixed(1)}s`,
    );
    if (players.length === 0) {
      console.log('[fed-expand] no players matched filter — exiting.');
      return;
    }

    // 2. Generate hypotheses + dedupe → one strongest claim per handle
    const claims = generateClaims(players, args.topN);
    console.log(
      `[fed-expand] generated ${fmt(claims.size)} unique handle hypotheses ` +
        `(avg ${(claims.size / players.length).toFixed(1)} per player)`,
    );

    // 3. Drop handles already in platform_players
    const allHandles = [...claims.keys()];
    const known = await dropAlreadyKnown(sql, allHandles);
    const toCheck = allHandles.filter((h) => !known.has(h));
    console.log(
      `[fed-expand] ${fmt(known.size)} already in platform_players; ` +
        `${fmt(toCheck.length)} new hypotheses to check`,
    );
    if (toCheck.length === 0) {
      console.log('[fed-expand] nothing new to check — exiting.');
      return;
    }

    // 4. Batch-check via Lichess /api/users
    const batches: string[][] = [];
    for (let i = 0; i < toCheck.length; i += args.batchSize) {
      batches.push(toCheck.slice(i, i + args.batchSize));
    }
    console.log(
      `[fed-expand] checking in ${fmt(batches.length)} batches of up to ${args.batchSize}`,
    );

    let live = 0;
    let upserted = 0;
    let batchIdx = 0;
    const lastSeen = { ts: 0 };
    for (const batch of batches) {
      batchIdx++;
      // Politeness gap
      const wait = args.requestGapMs - (Date.now() - lastSeen.ts);
      if (wait > 0) await sleep(wait);
      lastSeen.ts = Date.now();

      let profiles: LichessUserResponse[];
      try {
        profiles = await fetchLichessUsers(batch);
      } catch (err) {
        console.warn(
          `  ! batch ${batchIdx}/${batches.length} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      live += profiles.length;

      if (!args.dryRun) {
        for (const p of profiles) {
          if (p.closed || p.tosViolation) continue;
          const handle = p.username.toLowerCase();
          const claim = claims.get(handle);
          if (!claim) continue;
          try {
            await upsertHandle(sql, p, claim);
            upserted++;
          } catch (err) {
            console.warn(
              `  ! upsert ${handle}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      if (batchIdx % 5 === 0 || batchIdx === batches.length) {
        console.log(
          `  · batch ${batchIdx}/${batches.length}: ` +
            `live=${fmt(profiles.length)}/${fmt(batch.length)} ` +
            `(cumulative live=${fmt(live)}, upserted=${fmt(upserted)})`,
        );
      }
    }

    const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[fed-expand] DONE in ${totalDt}s`);
    console.log(`  fed players read: ${fmt(players.length)}`);
    console.log(`  unique hypotheses: ${fmt(claims.size)}`);
    console.log(`  already known: ${fmt(known.size)}`);
    console.log(`  checked: ${fmt(toCheck.length)} in ${fmt(batches.length)} batches`);
    console.log(`  live discovered: ${fmt(live)}`);
    console.log(`  upserted into platform_players: ${fmt(upserted)}`);
    console.log(
      `  hit rate: ${toCheck.length > 0 ? ((live / toCheck.length) * 100).toFixed(2) : '0'}%`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('federation-expand worker failed:', err);
  process.exit(1);
});
