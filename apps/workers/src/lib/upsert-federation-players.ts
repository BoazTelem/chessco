/**
 * Generic UNNEST batch upsert into `federation_players` + automatic
 * snapshot writes when ratings/title change.
 *
 * Promoted from `apps/workers/src/fide/upsert.ts` (whose pattern was tested
 * against ~755k FIDE rows and proven idempotent). The FIDE worker continues to
 * use its bespoke `upsertMerged` while Wave 1 migrates it to this generic
 * helper; new federations should import this directly.
 *
 * The contract: caller hands us an array of `NormalizedFederationPlayerRow`
 * (one row per real-world player, with all rating types merged) and we:
 *   - Upsert in batches of UPSERT_BATCH_SIZE
 *   - Emit a `federation_rating_snapshots` row when rating_* or title changed
 *   - Report inserted/updated/skipped counts back to the caller
 */
import type postgres from 'postgres';

const UPSERT_BATCH_SIZE = 1000;

export interface NormalizedFederationPlayerRow {
  /** Federation-internal player ID (FIDE id, USCF id, ICF id, …). */
  federationPlayerId: string;
  name: string;
  nameNormalized: string;
  /** Source country code (alpha-2 or alpha-3 — `country_iso2()` normalizes at query time). */
  country: string | null;
  birthYear: number | null;
  gender: 'M' | 'F' | null;
  title: string | null;
  ratingStandard: number | null;
  ratingRapid: number | null;
  ratingBlitz: number | null;
  ratingQuick: number | null;
  /** Original source record stashed as JSONB for forensics. */
  raw: Record<string, unknown>;
}

export interface UpsertMetrics {
  inserted: number;
  updated: number;
  skipped: number;
  snapshots: number;
}

export async function upsertFederationPlayers(
  sql: postgres.Sql,
  federationId: string,
  rows: NormalizedFederationPlayerRow[],
  snapshotDate: string,
  log: (msg: string) => void,
  opts: { batchSize?: number } = {},
): Promise<UpsertMetrics> {
  const batchSize = opts.batchSize ?? UPSERT_BATCH_SIZE;
  const metrics: UpsertMetrics = { inserted: 0, updated: 0, skipped: 0, snapshots: 0 };
  const total = rows.length;
  log(`[${federationId}] upserting ${total} rows in batches of ${batchSize}…`);

  for (let i = 0; i < total; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    const result = await sql<
      {
        federation_player_id_internal: string;
        action: 'inserted' | 'updated' | 'unchanged';
        rating_standard: number | null;
        rating_rapid: number | null;
        rating_blitz: number | null;
        rating_quick: number | null;
        title: string | null;
      }[]
    >`
      WITH incoming AS (
        SELECT * FROM UNNEST(
          ${sql.array(batch.map((r) => r.federationPlayerId))}::text[],
          ${sql.array(batch.map((r) => r.name))}::text[],
          ${sql.array(batch.map((r) => r.nameNormalized))}::text[],
          ${sql.array(batch.map((r) => r.country))}::text[],
          ${sql.array(batch.map((r) => r.gender))}::text[],
          ${sql.array(batch.map((r) => r.title))}::text[],
          ${sql.array(batch.map((r) => r.ratingStandard))}::int[],
          ${sql.array(batch.map((r) => r.ratingRapid))}::int[],
          ${sql.array(batch.map((r) => r.ratingBlitz))}::int[],
          ${sql.array(batch.map((r) => r.ratingQuick))}::int[],
          ${sql.array(batch.map((r) => r.birthYear))}::int[],
          ${sql.array(batch.map((r) => JSON.stringify(r.raw)))}::text[]
        ) AS t(
          fpid, name, name_normalized, country, gender, title,
          rating_standard, rating_rapid, rating_blitz, rating_quick,
          birth_year, raw
        )
      ),
      existing AS (
        SELECT fp.id, fp.federation_player_id,
               fp.rating_standard, fp.rating_rapid, fp.rating_blitz,
               fp.rating_quick, fp.title
        FROM federation_players fp
        WHERE fp.federation_id = ${federationId}
          AND fp.federation_player_id IN (SELECT fpid FROM incoming)
      ),
      upserted AS (
        INSERT INTO federation_players (
          federation_id, federation_player_id, name, name_normalized,
          country, gender, title,
          rating_standard, rating_rapid, rating_blitz, rating_quick,
          birth_year, raw, last_updated_at
        )
        SELECT
          ${federationId}, i.fpid, i.name, i.name_normalized,
          NULLIF(i.country, ''),
          NULLIF(i.gender, '')::char(1),
          NULLIF(i.title, ''),
          i.rating_standard, i.rating_rapid, i.rating_blitz, i.rating_quick,
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
          rating_quick = COALESCE(EXCLUDED.rating_quick, federation_players.rating_quick),
          birth_year = COALESCE(EXCLUDED.birth_year, federation_players.birth_year),
          raw = EXCLUDED.raw,
          last_updated_at = NOW()
        RETURNING id, federation_player_id,
                  rating_standard, rating_rapid, rating_blitz, rating_quick,
                  title, (xmax = 0) AS was_inserted
      )
      SELECT
        u.id::text AS federation_player_id_internal,
        CASE
          WHEN u.was_inserted THEN 'inserted'
          WHEN e.rating_standard IS DISTINCT FROM u.rating_standard
            OR e.rating_rapid IS DISTINCT FROM u.rating_rapid
            OR e.rating_blitz IS DISTINCT FROM u.rating_blitz
            OR e.rating_quick IS DISTINCT FROM u.rating_quick
            OR e.title IS DISTINCT FROM u.title THEN 'updated'
          ELSE 'unchanged'
        END AS action,
        u.rating_standard, u.rating_rapid, u.rating_blitz, u.rating_quick, u.title
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
        federationPlayerId: row.federation_player_id_internal,
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

    if ((i / batchSize) % 20 === 0) {
      log(
        `[${federationId}]   …${Math.min(i + batchSize, total)}/${total} ` +
          `(+${metrics.inserted} new, ~${metrics.updated} updated)`,
      );
    }
  }

  return metrics;
}
