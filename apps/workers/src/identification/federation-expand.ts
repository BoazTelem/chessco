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
import { fetchLichessUserBulk } from '../lib/lichess-api';
import { hypothesizeHandles } from './hypothesize';

const LICHESS_MAX_PER_REQUEST = 300;
const DEFAULT_TOP_N = 10;
const DEFAULT_MIN_RATING = 1400;
const DEFAULT_BATCH_SIZE = 300;

interface CliArgs {
  limit: number | null;
  country: string | null;
  minRating: number;
  topN: number;
  batchSize: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    limit: null,
    country: null,
    minRating: DEFAULT_MIN_RATING,
    topN: DEFAULT_TOP_N,
    batchSize: DEFAULT_BATCH_SIZE,
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

/** For each known handle, apply the federation claim metadata via a
 *  COALESCE update — only fills fields that are currently NULL, so existing
 *  claims (e.g. self_oauth links) are never overwritten. Batched at 1000
 *  handles per UPDATE (4 cols × 1000 rows = 4k params, safely under cap).
 *  Returns the count of affected rows (those that actually had a NULL
 *  claim_federation_player_id at update time). */
async function applyClaimsToKnown(
  sql: postgres.Sql,
  claims: Map<string, HandleClaim>,
  known: Set<string>,
): Promise<number> {
  let touched = 0;
  const knownList = [...known];
  // 1000-row chunks: well under the jsonb_to_recordset practical limit and
  // gives clean progress granularity.
  const CHUNK = 1000;
  for (let i = 0; i < knownList.length; i += CHUNK) {
    const slice = knownList.slice(i, i + CHUNK);
    const payload: Array<{
      handle: string;
      claimed_name: string;
      claimed_name_normalized: string;
      claimed_federation_player_id: string;
    }> = [];
    for (const handle of slice) {
      const c = claims.get(handle);
      if (!c) continue;
      payload.push({
        handle,
        claimed_name: c.fedPlayerName,
        claimed_name_normalized: c.fedPlayerNameNormalized,
        claimed_federation_player_id: c.fedPlayerId,
      });
    }
    if (payload.length === 0) continue;
    const result = await sql<{ handle: string }[]>`
      UPDATE platform_players SET
        claimed_name = COALESCE(platform_players.claimed_name, src.claimed_name),
        claimed_name_normalized = COALESCE(
          platform_players.claimed_name_normalized,
          src.claimed_name_normalized
        ),
        claimed_federation_player_id = COALESCE(
          platform_players.claimed_federation_player_id,
          src.claimed_federation_player_id
        ),
        claimed_federation_resolved_at = COALESCE(
          platform_players.claimed_federation_resolved_at, NOW()
        ),
        last_seen_at = NOW()
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
        AS src(handle text, claimed_name text, claimed_name_normalized text, claimed_federation_player_id uuid)
      WHERE platform_players.platform = 'lichess'
        AND platform_players.handle_normalized = src.handle
        AND platform_players.claimed_federation_player_id IS NULL
      RETURNING platform_players.handle
    `;
    touched += result.length;
  }
  return touched;
}

/** Return the subset of `handles` that already exist in platform_players
 *  (lichess). Matches via `handle_normalized` (the canonical lowercase
 *  mirror) so legacy mixed-case rows aren't treated as "unknown" and then
 *  inserted as a duplicate row, and so the strongest-claim UPDATE below
 *  can reach them too. */
async function dropAlreadyKnown(sql: postgres.Sql, handles: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  // Chunk to stay under the 65k param cap; 5000 per round is comfy.
  const CHUNK = 5000;
  for (let i = 0; i < handles.length; i += CHUNK) {
    const slice = handles.slice(i, i + CHUNK);
    const rows = await sql<{ handle_normalized: string }[]>`
      SELECT handle_normalized FROM platform_players
      WHERE platform = 'lichess' AND handle_normalized = ANY(${slice}::text[])
    `;
    for (const r of rows) known.add(r.handle_normalized.toLowerCase());
  }
  return known;
}

/** Bulk-check a batch of up to 300 handles against Lichess via the shared
 *  rate-limited client. Dead/banned/closed handles are simply omitted from
 *  the response. The shared client handles 1.5s anon / 250ms authed
 *  throttle + 429/5xx exponential backoff retry — the bulk 1800+ run hit
 *  20 trailing 429s with the previous direct-fetch implementation. */
async function fetchLichessUsers(handles: string[]): Promise<LichessUserResponse[]> {
  return fetchLichessUserBulk<LichessUserResponse>(handles);
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

    // 3. Split into already-known (in platform_players) vs new hypotheses.
    //    Known handles still need the federation claim metadata applied —
    //    skipping them entirely (the previous behaviour) meant titled / country
    //    rows discovered earlier never got their claimed_federation_player_id
    //    set, so they couldn't be promoted to the T1 tier or surfaced via
    //    name-anchored search. We do a cheap claim-only upsert against them
    //    here (no API call needed; we already have their rating/title data).
    const allHandles = [...claims.keys()];
    const known = await dropAlreadyKnown(sql, allHandles);
    const toCheck = allHandles.filter((h) => !known.has(h));
    console.log(
      `[fed-expand] ${fmt(known.size)} already in platform_players (claim-only update); ` +
        `${fmt(toCheck.length)} new hypotheses to check via API`,
    );

    let claimUpdated = 0;
    if (!args.dryRun && known.size > 0) {
      claimUpdated = await applyClaimsToKnown(sql, claims, known);
      console.log(
        `[fed-expand] claim-only update touched ${fmt(claimUpdated)} known rows ` +
          `(rows where claimed_federation_player_id was NULL)`,
      );
    }

    if (toCheck.length === 0) {
      console.log('[fed-expand] no new hypotheses to API-check — exiting.');
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
    // Throttling + 429/5xx retry are handled inside fetchLichessUserBulk;
    // we just iterate the batches.
    for (const batch of batches) {
      batchIdx++;

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
    console.log(`  already known: ${fmt(known.size)} (${fmt(claimUpdated)} claim-only updates)`);
    console.log(`  checked via API: ${fmt(toCheck.length)} in ${fmt(batches.length)} batches`);
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
