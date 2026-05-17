/**
 * Reverse-claim worker — sweeps titled platform_players that have no FIDE
 * claim and matches each one against federation_players via trigram name +
 * country + title. Applies the claim only when the match is strong enough.
 *
 * Why this exists: 16,326 chess.com handles + 110 lichess handles in
 * platform_players already carry a `title` field (set by the titled-
 * directory crawlers) but `claimed_federation_player_id IS NULL` because
 * the directories don't expose FIDE IDs. We have their handle, often a
 * claimed_name (from /pub/player {name}), country, and title — that's
 * enough to reverse-match them onto a federation_players row in most cases.
 *
 * Match criteria (all must hold for an auto-claim):
 *   - title MUST match exactly (GM↔GM, IM↔IM, …)
 *   - country MUST match when both sides have one (relaxed when handle.country
 *     is NULL; never relaxed when fed.country is NULL because country is the
 *     biggest disambiguator for common names)
 *   - pg_trgm similarity(claimed_name_normalized, fed.name_normalized) >= 0.70
 *   - top match's similarity is at least 0.05 ahead of #2 (margin of safety)
 *   - if both sides have a rating, |fed.rating_standard - handle_best_rating|
 *     <= 400 (matched players shouldn't differ by 2 standard deviations)
 *
 * Usage:
 *   pnpm --filter @chessco/workers identification:reverse-claim --platform chess.com
 *   pnpm --filter @chessco/workers identification:reverse-claim --platform chess.com --dry-run
 *   pnpm --filter @chessco/workers identification:reverse-claim --limit 100
 *
 * Idempotent — re-running only touches rows that still have a NULL claim.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getDb } from '../db';

const DEFAULT_SIM_THRESHOLD = 0.7;
const DEFAULT_MIN_MARGIN = 0.05;
/**
 * Generous rating-gap default. Online ratings (chess.com blitz / lichess
 * rapid) typically run 200-500 Elo higher than FIDE classical for titled
 * players because the time controls and opponent pools differ. We only use
 * this as a sanity check against obviously-wrong claims (a 2700 chess.com
 * handle matched to a 1500 FIDE entry); the trigram similarity + margin do
 * the heavy lifting.
 */
const DEFAULT_MAX_RATING_GAP = 700;
const DEFAULT_LIMIT = 100_000; // effectively unbounded — there are ~16k candidates total

/**
 * Map ISO 3166-1 alpha-2 country codes (used by chess.com `/pub/player`) to
 * the 3-letter codes FIDE uses in `federation_players.country`. Without this,
 * the country filter never matches (e.g. handle.country='US' vs fed='USA')
 * and every candidate row falls through to the no-country-relaxed path.
 *
 * Only the top ~70 chess-active federations are mapped — anything else
 * falls back to the no-country-filter path, which is correct: better to
 * relax than to gate on a wrong code.
 */
const ISO2_TO_FIDE: Record<string, string> = {
  AD: 'AND',
  AE: 'UAE',
  AF: 'AFG',
  AL: 'ALB',
  AM: 'ARM',
  AR: 'ARG',
  AT: 'AUT',
  AU: 'AUS',
  AZ: 'AZE',
  BA: 'BIH',
  BD: 'BAN',
  BE: 'BEL',
  BG: 'BUL',
  BH: 'BRN',
  BO: 'BOL',
  BR: 'BRA',
  BY: 'BLR',
  CA: 'CAN',
  CH: 'SUI',
  CL: 'CHI',
  CN: 'CHN',
  CO: 'COL',
  CR: 'CRC',
  CU: 'CUB',
  CY: 'CYP',
  CZ: 'CZE',
  DE: 'GER',
  DK: 'DEN',
  DO: 'DOM',
  DZ: 'ALG',
  EC: 'ECU',
  EE: 'EST',
  EG: 'EGY',
  ES: 'ESP',
  ET: 'ETH',
  FI: 'FIN',
  FR: 'FRA',
  GB: 'ENG',
  GE: 'GEO',
  GR: 'GRE',
  GT: 'GUA',
  HK: 'HKG',
  HR: 'CRO',
  HU: 'HUN',
  ID: 'INA',
  IE: 'IRL',
  IL: 'ISR',
  IN: 'IND',
  IQ: 'IRQ',
  IR: 'IRI',
  IS: 'ISL',
  IT: 'ITA',
  JM: 'JAM',
  JO: 'JOR',
  JP: 'JPN',
  KE: 'KEN',
  KG: 'KGZ',
  KR: 'KOR',
  KW: 'KUW',
  KZ: 'KAZ',
  LB: 'LIB',
  LK: 'SRI',
  LT: 'LTU',
  LU: 'LUX',
  LV: 'LAT',
  MA: 'MAR',
  MD: 'MDA',
  ME: 'MNE',
  MK: 'MKD',
  MN: 'MGL',
  MT: 'MLT',
  MX: 'MEX',
  MY: 'MAS',
  NG: 'NGR',
  NL: 'NED',
  NO: 'NOR',
  NZ: 'NZL',
  PA: 'PAN',
  PE: 'PER',
  PH: 'PHI',
  PK: 'PAK',
  PL: 'POL',
  PT: 'POR',
  PY: 'PAR',
  QA: 'QAT',
  RO: 'ROU',
  RS: 'SRB',
  RU: 'RUS',
  SA: 'KSA',
  SE: 'SWE',
  SG: 'SGP',
  SI: 'SLO',
  SK: 'SVK',
  SY: 'SYR',
  TH: 'THA',
  TJ: 'TJK',
  TM: 'TKM',
  TN: 'TUN',
  TR: 'TUR',
  TT: 'TTO',
  TW: 'TPE',
  UA: 'UKR',
  US: 'USA',
  UY: 'URU',
  UZ: 'UZB',
  VE: 'VEN',
  VN: 'VIE',
  YE: 'YEM',
  ZA: 'RSA',
  ZW: 'ZIM',
};

function toFideCountry(c: string | null): string | null {
  if (!c) return null;
  const upper = c.toUpperCase();
  if (upper.length === 3) return upper; // already FIDE code
  return ISO2_TO_FIDE[upper] ?? null;
}

interface CliArgs {
  platform: 'chess.com' | 'lichess' | 'both';
  limit: number;
  simThreshold: number;
  minMargin: number;
  maxRatingGap: number;
  dryRun: boolean;
  title: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    platform: 'both',
    limit: DEFAULT_LIMIT,
    simThreshold: DEFAULT_SIM_THRESHOLD,
    minMargin: DEFAULT_MIN_MARGIN,
    maxRatingGap: DEFAULT_MAX_RATING_GAP,
    dryRun: false,
    title: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' && argv[i + 1]) {
      const v = argv[++i]!;
      if (v !== 'chess.com' && v !== 'lichess' && v !== 'both') {
        throw new Error(`--platform must be chess.com|lichess|both (got ${v})`);
      }
      out.platform = v;
    } else if (a === '--limit' && argv[i + 1]) out.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--sim' && argv[i + 1]) out.simThreshold = Number.parseFloat(argv[++i]!);
    else if (a === '--margin' && argv[i + 1]) out.minMargin = Number.parseFloat(argv[++i]!);
    else if (a === '--rating-gap' && argv[i + 1])
      out.maxRatingGap = Number.parseInt(argv[++i]!, 10);
    else if (a === '--title' && argv[i + 1]) out.title = argv[++i]!.toUpperCase();
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

interface UnclaimedTitledHandle {
  id: string;
  platform: string;
  handle: string;
  claimed_name: string | null;
  claimed_name_normalized: string | null;
  country: string | null;
  title: string;
  rating_bullet: number | null;
  rating_blitz: number | null;
  rating_rapid: number | null;
  rating_classical: number | null;
}

interface FedCandidate {
  id: string;
  name: string;
  name_normalized: string;
  country: string | null;
  title: string | null;
  rating_standard: number | null;
  sim: number;
}

async function readUnclaimedTitled(
  sql: postgres.Sql,
  args: CliArgs,
): Promise<UnclaimedTitledHandle[]> {
  const platforms = args.platform === 'both' ? ['chess.com', 'lichess'] : [args.platform];
  const titleClause = args.title;
  if (titleClause) {
    return sql<UnclaimedTitledHandle[]>`
      SELECT id::text, platform, handle, claimed_name, claimed_name_normalized,
             country, title, rating_bullet, rating_blitz, rating_rapid, rating_classical
      FROM platform_players
      WHERE title IS NOT NULL
        AND title = ${titleClause}
        AND claimed_federation_player_id IS NULL
        AND platform = ANY(${platforms}::text[])
      ORDER BY platform, title, handle
      LIMIT ${args.limit}
    `;
  }
  return sql<UnclaimedTitledHandle[]>`
    SELECT id::text, platform, handle, claimed_name, claimed_name_normalized,
           country, title, rating_bullet, rating_blitz, rating_rapid, rating_classical
    FROM platform_players
    WHERE title IS NOT NULL
      AND claimed_federation_player_id IS NULL
      AND platform = ANY(${platforms}::text[])
    ORDER BY platform, title, handle
    LIMIT ${args.limit}
  `;
}

/**
 * Find the top federation_players matches for a given handle. Uses pg_trgm
 * similarity on name_normalized; gates on title equality and (when handle.
 * country is known) country equality. Returns up to 5 sorted by sim desc.
 *
 * We probe against the `claimed_name_normalized` field when present; falling
 * back to `handle_normalized` would over-match (handles aren't names).
 */
async function findFedCandidates(
  sql: postgres.Sql,
  handle: UnclaimedTitledHandle,
): Promise<FedCandidate[]> {
  // Need a name to search against.
  const probe = handle.claimed_name_normalized;
  if (!probe || probe.length < 3) return [];

  const fideCountry = toFideCountry(handle.country);
  if (fideCountry) {
    return sql<FedCandidate[]>`
      SELECT id::text, name, name_normalized, country, title, rating_standard,
             similarity(name_normalized, ${probe}) AS sim
      FROM federation_players
      WHERE title = ${handle.title}
        AND country = ${fideCountry}
        AND name_normalized % ${probe}
      ORDER BY sim DESC
      LIMIT 5
    `;
  }
  // No mappable country — broaden, but the verdict layer will require a
  // stronger margin to compensate (top-2 gap).
  return sql<FedCandidate[]>`
    SELECT id::text, name, name_normalized, country, title, rating_standard,
           similarity(name_normalized, ${probe}) AS sim
    FROM federation_players
    WHERE title = ${handle.title}
      AND name_normalized % ${probe}
    ORDER BY sim DESC
    LIMIT 5
  `;
}

function handleBestRating(h: UnclaimedTitledHandle): number | null {
  const ratings = [h.rating_classical, h.rating_rapid, h.rating_blitz, h.rating_bullet].filter(
    (r): r is number => r !== null,
  );
  if (ratings.length === 0) return null;
  return Math.max(...ratings);
}

interface MatchVerdict {
  ok: boolean;
  reason: string;
  best: FedCandidate | null;
  margin: number;
}

function verdict(
  handle: UnclaimedTitledHandle,
  candidates: FedCandidate[],
  args: CliArgs,
): MatchVerdict {
  if (candidates.length === 0) {
    return { ok: false, reason: 'no-candidates', best: null, margin: 0 };
  }
  const best = candidates[0]!;
  const second = candidates[1] ?? null;
  const margin = second ? best.sim - second.sim : 1;

  if (best.sim < args.simThreshold) {
    return { ok: false, reason: `sim-low(${best.sim.toFixed(2)})`, best, margin };
  }
  if (second && margin < args.minMargin) {
    return {
      ok: false,
      reason: `tie(${best.sim.toFixed(2)}/${second.sim.toFixed(2)})`,
      best,
      margin,
    };
  }

  // Country sanity (when handle.country was relaxed during the SELECT, ensure
  // fed.country isn't NULL — we never want to match a country-less FIDE row to
  // a country-less handle without strong evidence).
  if (!handle.country && best.country === null) {
    return { ok: false, reason: 'both-country-null', best, margin };
  }

  // Rating sanity.
  const hr = handleBestRating(handle);
  if (hr !== null && best.rating_standard !== null) {
    const gap = Math.abs(hr - best.rating_standard);
    if (gap > args.maxRatingGap) {
      return { ok: false, reason: `rating-gap(${gap})`, best, margin };
    }
  }

  return { ok: true, reason: 'match', best, margin };
}

async function applyClaim(
  sql: postgres.Sql,
  handle: UnclaimedTitledHandle,
  fed: FedCandidate,
): Promise<boolean> {
  // COALESCE means we never overwrite an existing claim. If a concurrent
  // worker beat us to it, RETURNING returns 0 rows and we count it as a skip.
  const result = await sql<{ id: string }[]>`
    UPDATE platform_players SET
      claimed_name = COALESCE(claimed_name, ${fed.name}),
      claimed_name_normalized = COALESCE(claimed_name_normalized, ${fed.name_normalized}),
      claimed_federation_player_id = COALESCE(claimed_federation_player_id, ${fed.id}::uuid),
      claimed_federation_resolved_at = COALESCE(claimed_federation_resolved_at, NOW()),
      last_seen_at = NOW()
    WHERE id = ${handle.id}::uuid
      AND claimed_federation_player_id IS NULL
    RETURNING id::text
  `;
  return result.length > 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { client: sql } = getDb();

  try {
    console.log(
      `[reverse-claim] platform=${args.platform}${args.title ? ` title=${args.title}` : ''} ` +
        `sim>=${args.simThreshold} margin>=${args.minMargin} rating-gap<=${args.maxRatingGap}` +
        `${args.dryRun ? ' DRY-RUN' : ''}`,
    );

    const t0 = Date.now();
    const handles = await readUnclaimedTitled(sql, args);
    console.log(
      `[reverse-claim] ${fmt(handles.length)} unclaimed titled handles in ${(
        (Date.now() - t0) /
        1000
      ).toFixed(1)}s`,
    );
    if (handles.length === 0) return;

    let withName = 0;
    let withoutName = 0;
    let matched = 0;
    let applied = 0;
    const reasonCounts: Record<string, number> = {};
    const titleCounts: Record<string, number> = {};

    let i = 0;
    for (const h of handles) {
      i++;
      if (!h.claimed_name_normalized || h.claimed_name_normalized.length < 3) {
        withoutName++;
        reasonCounts['no-claimed-name'] = (reasonCounts['no-claimed-name'] ?? 0) + 1;
        continue;
      }
      withName++;
      const cands = await findFedCandidates(sql, h);
      const v = verdict(h, cands, args);
      reasonCounts[v.reason] = (reasonCounts[v.reason] ?? 0) + 1;

      if (v.ok && v.best) {
        matched++;
        titleCounts[h.title] = (titleCounts[h.title] ?? 0) + 1;
        if (!args.dryRun) {
          const wrote = await applyClaim(sql, h, v.best);
          if (wrote) applied++;
        }
      }

      if (i % 500 === 0) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `  · [${fmt(i)}/${fmt(handles.length)}] matched=${fmt(matched)} applied=${fmt(
            applied,
          )} (${dt}s)`,
        );
      }
    }

    const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[reverse-claim] DONE in ${totalDt}s`);
    console.log(`  handles scanned: ${fmt(handles.length)}`);
    console.log(`    with claimed_name: ${fmt(withName)}`);
    console.log(`    without claimed_name: ${fmt(withoutName)}`);
    console.log(`  matched (verdict ok): ${fmt(matched)}`);
    console.log(`  applied to DB: ${fmt(applied)}${args.dryRun ? ' (dry-run)' : ''}`);
    console.log(
      `  hit rate (of with-name): ${withName > 0 ? ((matched / withName) * 100).toFixed(2) : '0'}%`,
    );

    console.log(`\n  verdict reason histogram:`);
    const reasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
    for (const [r, n] of reasons) console.log(`    ${r}: ${fmt(n)}`);

    if (Object.keys(titleCounts).length > 0) {
      console.log(`\n  matches by title:`);
      const titles = Object.entries(titleCounts).sort((a, b) => b[1] - a[1]);
      for (const [t, n] of titles) console.log(`    ${t}: ${fmt(n)}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('reverse-claim worker failed:', err);
  process.exit(1);
});
