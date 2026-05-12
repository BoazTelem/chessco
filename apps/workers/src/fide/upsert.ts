/**
 * Bulk upsert FIDE players into `federation_players` + write rating snapshots.
 *
 * Strategy:
 *   - Accept already-merged player records (one row per fideid with all three
 *     rating types filled in if present).
 *   - Upsert in batches of UPSERT_BATCH_SIZE.
 *   - For each row whose existing version differs in rating_* or title,
 *     emit a `federation_rating_snapshots` row.
 *
 * postgres-js handles parameterized arrays natively, so we can do this in a
 * single SQL per batch using UNNEST.
 */
import type postgres from 'postgres';
import type { ParsedFidePlayer } from './parse.js';

const UPSERT_BATCH_SIZE = 1000;

export type MergedRecord = {
  fideid: string;
  name: string;
  nameNormalized: string;
  country: string | null;
  gender: 'M' | 'F' | null;
  title: string | null;
  ratingStandard: number | null;
  ratingRapid: number | null;
  ratingBlitz: number | null;
  birthYear: number | null;
  raw: Record<string, unknown>;
};

/**
 * Merge a player from a single rating-list pass into the in-memory map.
 * Standard takes precedence for the canonical name/title (per spec §4).
 */
export function mergePlayer(
  map: Map<string, MergedRecord>,
  player: ParsedFidePlayer,
  ratingClass: 'standard' | 'rapid' | 'blitz',
): void {
  const existing = map.get(player.fideid);
  if (!existing) {
    map.set(player.fideid, {
      fideid: player.fideid,
      name: player.name,
      nameNormalized: player.nameNormalized,
      country: player.country,
      gender: player.gender,
      title: player.title,
      ratingStandard: ratingClass === 'standard' ? player.rating : null,
      ratingRapid: ratingClass === 'rapid' ? player.rating : null,
      ratingBlitz: ratingClass === 'blitz' ? player.rating : null,
      birthYear: player.birthYear,
      raw: { [ratingClass]: player.raw },
    });
    return;
  }

  // Standard wins for canonical fields if it arrives.
  if (ratingClass === 'standard') {
    existing.name = player.name;
    existing.nameNormalized = player.nameNormalized;
    existing.country = player.country ?? existing.country;
    existing.gender = player.gender ?? existing.gender;
    existing.title = player.title ?? existing.title;
    existing.birthYear = player.birthYear ?? existing.birthYear;
    existing.ratingStandard = player.rating;
  } else if (ratingClass === 'rapid') {
    existing.ratingRapid = player.rating;
    existing.title = existing.title ?? player.title;
    existing.country = existing.country ?? player.country;
  } else if (ratingClass === 'blitz') {
    existing.ratingBlitz = player.rating;
    existing.title = existing.title ?? player.title;
    existing.country = existing.country ?? player.country;
  }

  (existing.raw as Record<string, unknown>)[ratingClass] = player.raw;
}

export type UpsertMetrics = {
  inserted: number;
  updated: number;
  skipped: number;
  snapshots: number;
};

/**
 * Bulk-upsert merged FIDE records. Detects changed ratings/title and writes
 * snapshots in the same transaction batch.
 */
export async function upsertMerged(
  sql: postgres.Sql,
  records: MergedRecord[],
  snapshotDate: string,
  log: (msg: string) => void,
): Promise<UpsertMetrics> {
  const metrics: UpsertMetrics = { inserted: 0, updated: 0, skipped: 0, snapshots: 0 };
  const total = records.length;
  log(`[fide] upserting ${total} merged records in batches of ${UPSERT_BATCH_SIZE}…`);

  for (let i = 0; i < total; i += UPSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + UPSERT_BATCH_SIZE);

    // Use a single UNNEST-based upsert that also reports which rows changed,
    // so we can decide on snapshots without a second roundtrip.
    const result = await sql<
      {
        fideid: string;
        federation_player_id: string;
        action: 'inserted' | 'updated' | 'unchanged';
        rating_standard: number | null;
        rating_rapid: number | null;
        rating_blitz: number | null;
        title: string | null;
      }[]
    >`
      WITH incoming AS (
        SELECT * FROM UNNEST(
          ${sql.array(batch.map((r) => r.fideid))}::text[],
          ${sql.array(batch.map((r) => r.name))}::text[],
          ${sql.array(batch.map((r) => r.nameNormalized))}::text[],
          ${sql.array(batch.map((r) => r.country))}::text[],
          ${sql.array(batch.map((r) => r.gender))}::text[],
          ${sql.array(batch.map((r) => r.title))}::text[],
          ${sql.array(batch.map((r) => r.ratingStandard))}::int[],
          ${sql.array(batch.map((r) => r.ratingRapid))}::int[],
          ${sql.array(batch.map((r) => r.ratingBlitz))}::int[],
          ${sql.array(batch.map((r) => r.birthYear))}::int[],
          ${sql.array(batch.map((r) => JSON.stringify(r.raw)))}::text[]
        ) AS t(
          fideid, name, name_normalized, country, gender, title,
          rating_standard, rating_rapid, rating_blitz, birth_year, raw
        )
      ),
      existing AS (
        SELECT fp.id, fp.federation_player_id, fp.rating_standard, fp.rating_rapid, fp.rating_blitz, fp.title
        FROM federation_players fp
        WHERE fp.federation_id = 'FIDE'
          AND fp.federation_player_id IN (SELECT fideid FROM incoming)
      ),
      upserted AS (
        INSERT INTO federation_players (
          federation_id, federation_player_id, name, name_normalized,
          country, gender, title,
          rating_standard, rating_rapid, rating_blitz,
          birth_year, raw, last_updated_at
        )
        SELECT
          'FIDE', i.fideid, i.name, i.name_normalized,
          NULLIF(i.country, ''),
          NULLIF(i.gender, '')::char(1),
          NULLIF(i.title, ''),
          i.rating_standard, i.rating_rapid, i.rating_blitz,
          i.birth_year, i.raw::jsonb, NOW()
        FROM incoming i
        ON CONFLICT (federation_id, federation_player_id) DO UPDATE SET
          name = EXCLUDED.name,
          name_normalized = EXCLUDED.name_normalized,
          country = COALESCE(EXCLUDED.country, federation_players.country),
          gender = COALESCE(EXCLUDED.gender, federation_players.gender),
          title = COALESCE(EXCLUDED.title, federation_players.title),
          rating_standard = COALESCE(EXCLUDED.rating_standard, federation_players.rating_standard),
          rating_rapid = COALESCE(EXCLUDED.rating_rapid, federation_players.rating_rapid),
          rating_blitz = COALESCE(EXCLUDED.rating_blitz, federation_players.rating_blitz),
          birth_year = COALESCE(EXCLUDED.birth_year, federation_players.birth_year),
          raw = EXCLUDED.raw,
          last_updated_at = NOW()
        RETURNING id, federation_player_id,
                  rating_standard, rating_rapid, rating_blitz, title,
                  (xmax = 0) AS was_inserted
      )
      SELECT
        u.federation_player_id AS fideid,
        u.id::text AS federation_player_id,
        CASE
          WHEN u.was_inserted THEN 'inserted'
          WHEN e.rating_standard IS DISTINCT FROM u.rating_standard
            OR e.rating_rapid IS DISTINCT FROM u.rating_rapid
            OR e.rating_blitz IS DISTINCT FROM u.rating_blitz
            OR e.title IS DISTINCT FROM u.title THEN 'updated'
          ELSE 'unchanged'
        END AS action,
        u.rating_standard, u.rating_rapid, u.rating_blitz, u.title
      FROM upserted u
      LEFT JOIN existing e ON e.federation_player_id = u.federation_player_id
    `;

    const snapshotRows: {
      federationPlayerId: string;
      ratingStandard: number | null;
      ratingRapid: number | null;
      ratingBlitz: number | null;
      title: string | null;
    }[] = [];

    for (const row of result) {
      if (row.action === 'inserted') {
        metrics.inserted++;
      } else if (row.action === 'updated') {
        metrics.updated++;
      } else {
        metrics.skipped++;
        continue;
      }
      snapshotRows.push({
        federationPlayerId: row.federation_player_id,
        ratingStandard: row.rating_standard,
        ratingRapid: row.rating_rapid,
        ratingBlitz: row.rating_blitz,
        title: row.title,
      });
    }

    if (snapshotRows.length > 0) {
      await sql`
        INSERT INTO federation_rating_snapshots (
          federation_player_id, snapshot_date,
          rating_standard, rating_rapid, rating_blitz, title
        )
        SELECT * FROM UNNEST(
          ${sql.array(snapshotRows.map((r) => r.federationPlayerId))}::uuid[],
          ${sql.array(snapshotRows.map(() => snapshotDate))}::date[],
          ${sql.array(snapshotRows.map((r) => r.ratingStandard))}::int[],
          ${sql.array(snapshotRows.map((r) => r.ratingRapid))}::int[],
          ${sql.array(snapshotRows.map((r) => r.ratingBlitz))}::int[],
          ${sql.array(snapshotRows.map((r) => r.title))}::text[]
        )
        ON CONFLICT (federation_player_id, snapshot_date) DO NOTHING
      `;
      metrics.snapshots += snapshotRows.length;
    }

    if ((i / UPSERT_BATCH_SIZE) % 20 === 0) {
      log(
        `[fide]   …${Math.min(i + UPSERT_BATCH_SIZE, total)}/${total} ` +
          `(+${metrics.inserted} new, ~${metrics.updated} updated)`,
      );
    }
  }

  return metrics;
}
