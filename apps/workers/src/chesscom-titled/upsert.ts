/**
 * Upsert chess.com titled handles into Supabase platform_players.
 *
 * For the titled list endpoint Chess.com only returns usernames — to get
 * country + rating we have to fetch /pub/player/{u} and /pub/player/{u}/stats
 * per handle. For 3-5k titled handles total this is feasible (~10 minutes
 * with 100ms rate limit). For country lists (up to 1M handles per ISO)
 * we'll fetch the directory only and defer per-handle enrichment.
 */
import type postgres from 'postgres';
import { fetchPlayer, fetchPlayerStats, isoFromCountryUrl } from '../lib/chesscom-api';
import { normalizeClaimedName } from '../lib/claimed-name';

export interface UpsertResult {
  upserted: number;
  enriched: number;
  errors: number;
}

export interface UpsertOpts {
  enrich?: boolean;
}

export async function upsertChesscomTitled(
  sql: postgres.Sql,
  title: string,
  handles: string[],
  opts: UpsertOpts = {},
): Promise<UpsertResult> {
  const result: UpsertResult = { upserted: 0, enriched: 0, errors: 0 };

  // First, bulk-insert (or no-op) the bare handle + title in one round trip.
  // postgres-js v3.4 row-helper types reject readonly column tuples; cast.
  const insert = sql as unknown as (rows: object[], ...cols: string[]) => postgres.Helper<object[]>;
  if (handles.length > 0) {
    const rows = handles.map((h) => {
      const normalized = h.trim().toLowerCase();
      return {
        platform: 'chess.com',
        handle: normalized,
        handle_normalized: normalized,
        title,
        pulled_via: 'titled',
        // postgres-js row helper doesn't auto-serialize objects for jsonb;
        // stringify so the column receives a json literal.
        raw: JSON.stringify({ source: 'pub/titled/' + title }),
      };
    });
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO platform_players
        ${insert(rows, 'platform', 'handle', 'handle_normalized', 'title', 'pulled_via', 'raw')}
      ON CONFLICT (platform, handle) DO UPDATE SET
        title = EXCLUDED.title,
        last_seen_at = NOW()
      RETURNING id
    `;
    result.upserted = inserted.length;
  }

  if (!opts.enrich) return result;

  // Per-handle enrichment: country + rating. Best effort — log + continue on error.
  for (const handle of handles) {
    const normalized = handle.trim().toLowerCase();
    try {
      const [player, stats] = await Promise.all([
        fetchPlayer(normalized),
        fetchPlayerStats(normalized),
      ]);
      if (!player) continue;
      const claimedName = player.name ?? null;
      const claimedNormalized = claimedName ? normalizeClaimedName(claimedName) : null;
      const claimedCountry = isoFromCountryUrl(player.country) ?? null;
      const claimedFideRating =
        typeof player.fide === 'number' && player.fide > 0 ? player.fide : null;
      await sql`
        UPDATE platform_players SET
          country = ${claimedCountry},
          rating_bullet = ${stats?.chess_bullet?.last?.rating ?? null},
          rating_blitz = ${stats?.chess_blitz?.last?.rating ?? null},
          rating_rapid = ${stats?.chess_rapid?.last?.rating ?? null},
          rating_classical = ${stats?.chess_daily?.last?.rating ?? null},
          claimed_name = ${claimedName},
          claimed_name_normalized = ${claimedNormalized},
          claimed_fide_rating = ${claimedFideRating},
          claimed_country = ${claimedCountry},
          raw = COALESCE(raw, '{}'::jsonb) || ${JSON.stringify({ player, stats })}::jsonb,
          last_seen_at = NOW()
        WHERE platform = 'chess.com' AND handle = ${normalized}
      `;
      result.enriched++;
    } catch (err) {
      console.warn(`  ⚠ enrich ${normalized} failed:`, (err as Error).message);
      result.errors++;
    }
  }

  return result;
}
