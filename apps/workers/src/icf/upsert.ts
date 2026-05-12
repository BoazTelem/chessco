/**
 * Bulk upsert ICF players into `federation_players` + write rating snapshots.
 * Same pattern as `apps/workers/src/fide/upsert.ts` but with ICF-specific
 * column mapping.
 */
import type postgres from 'postgres';
import type { IcfRow } from './scrape.js';

const UPSERT_BATCH_SIZE = 500;

export type UpsertMetrics = {
  inserted: number;
  updated: number;
  skipped: number;
  snapshots: number;
};

export async function upsertIcfRows(
  sql: postgres.Sql,
  rows: IcfRow[],
  snapshotDate: string,
  log: (msg: string) => void,
): Promise<UpsertMetrics> {
  const metrics: UpsertMetrics = { inserted: 0, updated: 0, skipped: 0, snapshots: 0 };
  const total = rows.length;
  log(`[icf] upserting ${total} rows in batches of ${UPSERT_BATCH_SIZE}…`);

  for (let i = 0; i < total; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);

    const result = await sql<
      {
        icf_id: string;
        federation_player_id_uuid: string;
        action: 'inserted' | 'updated' | 'unchanged';
        rating_standard: number | null;
        title: string | null;
      }[]
    >`
      WITH incoming AS (
        SELECT * FROM UNNEST(
          ${sql.array(batch.map((r) => r.icfId))}::text[],
          ${sql.array(batch.map((r) => r.name))}::text[],
          ${sql.array(batch.map((r) => r.nameNormalized))}::text[],
          ${sql.array(batch.map((r) => r.israeliRating))}::int[],
          ${sql.array(batch.map((r) => JSON.stringify(r.raw)))}::text[]
        ) AS t(icf_id, name, name_normalized, rating_standard, raw)
      ),
      existing AS (
        SELECT fp.id, fp.federation_player_id, fp.rating_standard, fp.title
        FROM federation_players fp
        WHERE fp.federation_id = 'ICF'
          AND fp.federation_player_id IN (SELECT icf_id FROM incoming)
      ),
      upserted AS (
        INSERT INTO federation_players (
          federation_id, federation_player_id, name, name_normalized,
          country, rating_standard, raw, last_updated_at
        )
        SELECT
          'ICF', i.icf_id, i.name, i.name_normalized,
          'IL',
          i.rating_standard,
          i.raw::jsonb,
          NOW()
        FROM incoming i
        ON CONFLICT (federation_id, federation_player_id) DO UPDATE SET
          name = EXCLUDED.name,
          name_normalized = EXCLUDED.name_normalized,
          rating_standard = COALESCE(EXCLUDED.rating_standard, federation_players.rating_standard),
          raw = EXCLUDED.raw,
          last_updated_at = NOW()
        RETURNING id, federation_player_id, rating_standard, title, (xmax = 0) AS was_inserted
      )
      SELECT
        u.federation_player_id AS icf_id,
        u.id::text AS federation_player_id_uuid,
        CASE
          WHEN u.was_inserted THEN 'inserted'
          WHEN e.rating_standard IS DISTINCT FROM u.rating_standard
            OR e.title IS DISTINCT FROM u.title THEN 'updated'
          ELSE 'unchanged'
        END AS action,
        u.rating_standard, u.title
      FROM upserted u
      LEFT JOIN existing e ON e.federation_player_id = u.federation_player_id
    `;

    const snapshotRows: {
      federationPlayerId: string;
      ratingStandard: number | null;
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
        federationPlayerId: row.federation_player_id_uuid,
        ratingStandard: row.rating_standard,
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
          ${sql.array(snapshotRows.map(() => null))}::int[],
          ${sql.array(snapshotRows.map(() => null))}::int[],
          ${sql.array(snapshotRows.map((r) => r.title))}::text[]
        )
        ON CONFLICT (federation_player_id, snapshot_date) DO NOTHING
      `;
      metrics.snapshots += snapshotRows.length;
    }

    if ((i / UPSERT_BATCH_SIZE) % 5 === 0) {
      log(
        `[icf]   …${Math.min(i + UPSERT_BATCH_SIZE, total)}/${total} ` +
          `(+${metrics.inserted} new, ~${metrics.updated} updated)`,
      );
    }
  }

  return metrics;
}
