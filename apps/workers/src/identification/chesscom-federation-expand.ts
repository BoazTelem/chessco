/**
 * Chess.com federation-anchored handle expansion — sibling of the Lichess
 * variant at `federation-expand.ts`, but adapted to chess.com's per-handle
 * Pub API (no bulk endpoint).
 *
 * Why this exists: the Lichess version closed a similar gap and lifted
 * lichess fed-claim coverage from 3 to 8,204 (now: 1,324 matchable +
 * claimed handles). chess.com today has **0 fed-claims** on 14,884
 * matchable handles — every titled / 2200+ chess.com player who deserves
 * to be linked to their FIDE entry is currently unlinked.
 *
 * Strategy:
 *   1. Read FIDE+ICF players >= --min-rating (default 2000 — Premium tier)
 *   2. Generate up to --top-n handle hypotheses per player via hypothesize()
 *   3. Dedupe strongest-claim-wins (multiple FIDE Andersens → one claim)
 *   4. For each hypothesis:
 *        a. Skip if already a claimed chess.com platform_players row
 *           (idempotent — re-runs are safe)
 *        b. If known but unclaimed → cheap claim-only UPDATE (no API call)
 *        c. If unknown → GET /pub/player/{handle}
 *             404 → dead handle, skip
 *             200 → fetch /stats for ratings, sanity-check name match,
 *                   INSERT into platform_players with full metadata + claim
 *   5. Report per-100-FIDE-player progress + final summary
 *
 * Sanity check on insert: claim is only applied if chess.com's `name` field
 * trigram-matches the FIDE `name_normalized` (similarity > 0.5) OR the
 * country matches. Prevents claiming "magnus" for someone unrelated who
 * happens to have the handle.
 *
 * Throughput: ~200 ms per unknown hypothesis (one /pub/player + one /stats
 * if live). For FIDE 2000+ (~73k players × 10 hypotheses, ~50% already in
 * platform_players) → ~5-7 hours of continuous run. --country chunks let
 * the operator run in batches.
 *
 * Usage:
 *   pnpm --filter @chessco/workers identification:expand:chesscom --country US
 *   pnpm --filter @chessco/workers identification:expand:chesscom --min-rating 2200
 *   pnpm --filter @chessco/workers identification:expand:chesscom --limit 100 --dry-run
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getDb } from '../db';
import {
  ChesscomApiError,
  fetchPlayer,
  fetchPlayerStats,
  isoFromCountryUrl,
  type ChesscomPlayer,
  type ChesscomStats,
} from '../lib/chesscom-api';
import { hypothesizeHandles } from './hypothesize';

const DEFAULT_TOP_N = 10;
const DEFAULT_MIN_RATING = 2000;

interface CliArgs {
  limit: number | null;
  country: string | null;
  minRating: number;
  topN: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    limit: null,
    country: null,
    minRating: DEFAULT_MIN_RATING,
    topN: DEFAULT_TOP_N,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) out.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--country' && argv[i + 1]) out.country = argv[++i]!.toUpperCase();
    else if (a === '--min-rating' && argv[i + 1]) out.minRating = Number.parseInt(argv[++i]!, 10);
    else if (a === '--top-n' && argv[i + 1]) out.topN = Number.parseInt(argv[++i]!, 10);
    else if (a === '--dry-run') out.dryRun = true;
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

/** Strongest-claim-wins dedup across FIDE players who hypothesize the same
 *  handle. Mirrors federation-expand.ts logic. */
interface HandleClaim {
  handle: string;
  fedPlayerId: string;
  fedPlayerName: string;
  fedPlayerNameNormalized: string;
  fedCountry: string | null;
  fedRating: number;
}

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

interface ExistingChesscomRow {
  handle: string;
  has_claim: boolean;
}

/** Look up which hypotheses are already in chess.com platform_players AND
 *  whether they already carry a claim. Matches via handle_normalized for
 *  case-insensitive correctness. */
async function classifyKnown(
  sql: postgres.Sql,
  handles: string[],
): Promise<{ knownClaimed: Set<string>; knownUnclaimed: Set<string> }> {
  const knownClaimed = new Set<string>();
  const knownUnclaimed = new Set<string>();
  const CHUNK = 5000;
  for (let i = 0; i < handles.length; i += CHUNK) {
    const slice = handles.slice(i, i + CHUNK);
    const rows = await sql<ExistingChesscomRow[]>`
      SELECT handle_normalized AS handle,
             (claimed_federation_player_id IS NOT NULL) AS has_claim
      FROM platform_players
      WHERE platform = 'chess.com' AND handle_normalized = ANY(${slice}::text[])
    `;
    for (const r of rows) {
      if (r.has_claim) knownClaimed.add(r.handle.toLowerCase());
      else knownUnclaimed.add(r.handle.toLowerCase());
    }
  }
  return { knownClaimed, knownUnclaimed };
}

/** Apply claim metadata to chess.com handles we already know about but
 *  haven't linked to FIDE yet. Cheap — no API calls. */
async function applyClaimsToKnown(
  sql: postgres.Sql,
  claims: Map<string, HandleClaim>,
  known: Set<string>,
): Promise<number> {
  let touched = 0;
  const knownList = [...known];
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
      WHERE platform_players.platform = 'chess.com'
        AND platform_players.handle_normalized = src.handle
        AND platform_players.claimed_federation_player_id IS NULL
      RETURNING platform_players.handle
    `;
    touched += result.length;
  }
  return touched;
}

/** Trigram-style similarity (rough) — we offload to pg_trgm at insert
 *  time. This in-memory check is a coarse sanity guard before paying for
 *  the DB round-trip. */
function looseNameMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const an = a
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  const bn = b
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  if (an.length === 0 || bn.length === 0) return false;
  if (an === bn) return true;
  // Substring or one contains a meaningful token of the other.
  if (an.includes(bn) || bn.includes(an)) return true;
  const aTokens = an.split(/\s+/).filter((t) => t.length >= 3);
  const bTokens = bn.split(/\s+/).filter((t) => t.length >= 3);
  return aTokens.some((t) => bTokens.includes(t));
}

/** Insert a newly-discovered live chess.com handle with claim metadata
 *  and ratings/title from /pub/player + /stats. */
async function upsertDiscovered(
  sql: postgres.Sql,
  player: ChesscomPlayer,
  stats: ChesscomStats | null,
  claim: HandleClaim,
): Promise<void> {
  const handle = player.username.toLowerCase();
  const country = isoFromCountryUrl(player.country) ?? claim.fedCountry ?? null;
  const title = player.title ?? null;
  const ratingBullet = stats?.chess_bullet?.last?.rating ?? null;
  const ratingBlitz = stats?.chess_blitz?.last?.rating ?? null;
  const ratingRapid = stats?.chess_rapid?.last?.rating ?? null;
  // chess.com stats schema doesn't have a 'classical' bucket — rapid is the
  // longest standard time control. We leave rating_classical NULL.

  await sql`
    INSERT INTO platform_players (
      platform, handle, handle_normalized, country, title,
      rating_bullet, rating_blitz, rating_rapid, rating_classical,
      pulled_via, claimed_name, claimed_name_normalized,
      claimed_federation_player_id, claimed_federation_resolved_at,
      first_seen_at, last_seen_at
    ) VALUES (
      'chess.com', ${handle}, ${handle}, ${country}, ${title},
      ${ratingBullet}, ${ratingBlitz}, ${ratingRapid}, NULL,
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
      `[cc-fed-expand] platform=chess.com min-rating=${args.minRating} ` +
        `${args.country ? `country=${args.country} ` : ''}` +
        `${args.limit ? `limit=${args.limit} ` : ''}` +
        `top-n=${args.topN}` +
        `${args.dryRun ? ' DRY-RUN' : ''}`,
    );

    // 1. Read federation players
    const t0 = Date.now();
    const players = await readFederationPlayers(sql, args);
    console.log(
      `[cc-fed-expand] read ${fmt(players.length)} FIDE players in ${(
        (Date.now() - t0) /
        1000
      ).toFixed(1)}s`,
    );
    if (players.length === 0) {
      console.log('[cc-fed-expand] no players matched filter — exiting.');
      return;
    }

    // 2. Generate hypotheses (dedupe strongest-claim-wins)
    const claims = generateClaims(players, args.topN);
    console.log(
      `[cc-fed-expand] generated ${fmt(claims.size)} unique handle hypotheses ` +
        `(avg ${(claims.size / players.length).toFixed(1)} per player)`,
    );

    // 3. Classify hypotheses by existing platform_players state
    const allHandles = [...claims.keys()];
    const { knownClaimed, knownUnclaimed } = await classifyKnown(sql, allHandles);
    const toCheck = allHandles.filter((h) => !knownClaimed.has(h) && !knownUnclaimed.has(h));
    console.log(
      `[cc-fed-expand] ${fmt(knownClaimed.size)} already claimed, ` +
        `${fmt(knownUnclaimed.size)} known-unclaimed (claim-only update), ` +
        `${fmt(toCheck.length)} new to check via API`,
    );

    // 4. Cheap claim-only updates for known-unclaimed
    let claimUpdated = 0;
    if (!args.dryRun && knownUnclaimed.size > 0) {
      claimUpdated = await applyClaimsToKnown(sql, claims, knownUnclaimed);
      console.log(`[cc-fed-expand] claim-only update touched ${fmt(claimUpdated)} known rows`);
    }

    // 5. API-check unknown handles
    let liveDiscovered = 0;
    let inserted = 0;
    let skippedNameMismatch = 0;
    let errors = 0;
    let dead = 0;
    const apiT0 = Date.now();
    for (let i = 0; i < toCheck.length; i++) {
      const handle = toCheck[i]!;
      const claim = claims.get(handle);
      if (!claim) continue;

      let player: ChesscomPlayer | null;
      try {
        player = await fetchPlayer(handle);
      } catch (err) {
        errors++;
        if (err instanceof ChesscomApiError && err.status === 404) {
          dead++;
          continue;
        }
        if (errors % 50 === 0) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  ! ${handle}: ${msg.slice(0, 200)}`);
        }
        continue;
      }
      if (!player) {
        dead++;
        continue;
      }
      liveDiscovered++;

      // Sanity gate: chess.com `name` (if set) should at least loosely
      // resemble the FIDE name OR the country should match. Otherwise we
      // risk claiming "magnus" for someone unrelated.
      const ccCountry = isoFromCountryUrl(player.country);
      const countryMatches =
        ccCountry !== null && claim.fedCountry !== null && ccCountry === claim.fedCountry;
      const nameMatches = looseNameMatch(player.name, claim.fedPlayerName);
      if (!nameMatches && !countryMatches) {
        skippedNameMismatch++;
        continue;
      }

      let stats: ChesscomStats | null;
      try {
        stats = await fetchPlayerStats(handle);
      } catch (err) {
        if (!(err instanceof ChesscomApiError) || err.status !== 404) {
          // Treat stats-fetch errors as soft — still apply the claim with
          // null ratings.
          stats = null;
        } else {
          stats = null;
        }
      }

      if (!args.dryRun) {
        try {
          await upsertDiscovered(sql, player, stats, claim);
          inserted++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  ! upsert ${handle}: ${msg.slice(0, 200)}`);
        }
      }

      if ((i + 1) % 200 === 0 || i === toCheck.length - 1) {
        const elapsed = ((Date.now() - apiT0) / 1000).toFixed(1);
        console.log(
          `  · [${i + 1}/${fmt(toCheck.length)}] ` +
            `live=${fmt(liveDiscovered)} inserted=${fmt(inserted)} ` +
            `name_skip=${fmt(skippedNameMismatch)} dead=${fmt(dead)} ` +
            `errors=${fmt(errors)} (${elapsed}s)`,
        );
      }
    }

    const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
    const hitRate = toCheck.length > 0 ? (liveDiscovered / toCheck.length) * 100 : 0;
    console.log(`\n[cc-fed-expand] DONE in ${totalDt}s`);
    console.log(`  FIDE players read:                ${fmt(players.length)}`);
    console.log(`  unique hypotheses generated:      ${fmt(claims.size)}`);
    console.log(`  already claimed (skipped):        ${fmt(knownClaimed.size)}`);
    console.log(`  known-unclaimed → claim updated:  ${fmt(claimUpdated)}`);
    console.log(`  API-checked:                      ${fmt(toCheck.length)}`);
    console.log(
      `  live discovered:                  ${fmt(liveDiscovered)} (${hitRate.toFixed(2)}% of checked)`,
    );
    console.log(`  inserted with claim:              ${fmt(inserted)}`);
    console.log(`  skipped (name+country mismatch):  ${fmt(skippedNameMismatch)}`);
    console.log(`  dead handles (404):               ${fmt(dead)}`);
    console.log(`  transient errors:                 ${fmt(errors)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('chesscom-federation-expand worker failed:', err);
  process.exit(1);
});
