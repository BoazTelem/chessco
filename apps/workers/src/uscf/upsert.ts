/**
 * Bulk upsert USCF players into `federation_players` + write rating snapshots.
 * Same UNNEST pattern as the FIDE and ICF upsert helpers.
 *
 * Categories overlap (a player may appear in 100-Overall + 100-Senior +
 * 100-State), so the caller must dedupe by `uscfId` before passing in.
 * The dedupe merges rating types (standard from one category + quick from
 * another) onto the same row.
 */
import type postgres from 'postgres';
import type { UscfRow } from './scrape.js';

const UPSERT_BATCH_SIZE = 500;

export type UpsertMetrics = {
  inserted: number;
  updated: number;
  skipped: number;
  snapshots: number;
};

export type DedupedUscfRow = {
  uscfId: string;
  name: string;
  nameNormalized: string;
  state: string | null;
  ratingStandard: number | null;
  ratingQuick: number | null;
  ratingBlitz: number | null;
  title: string | null;
  raw: Record<string, unknown>;
};

/**
 * Collapse rows from multiple categories into one row per uscfId.
 * Keeps the highest non-null rating per type (categories rank within
 * their slice, so the same player's rating is consistent across them,
 * but defending against rating-source confusion).
 */
export function dedupeUscfRows(rows: UscfRow[]): DedupedUscfRow[] {
  const byId = new Map<string, DedupedUscfRow>();
  for (const r of rows) {
    const existing = byId.get(r.uscfId);
    if (!existing) {
      byId.set(r.uscfId, {
        uscfId: r.uscfId,
        name: r.name,
        nameNormalized: r.nameNormalized,
        state: r.state,
        ratingStandard: r.ratingStandard,
        ratingQuick: r.ratingQuick,
        ratingBlitz: r.ratingBlitz,
        title: r.title,
        raw: {
          sources: [r.sourceCategory],
          state: r.state,
          first_seen: r.raw,
        },
      });
      continue;
    }
    existing.ratingStandard ??= r.ratingStandard;
    existing.ratingQuick ??= r.ratingQuick;
    existing.ratingBlitz ??= r.ratingBlitz;
    existing.title ??= r.title;
    existing.state ??= r.state;
    (existing.raw.sources as string[]).push(r.sourceCategory);
  }
  return Array.from(byId.values());
}

export async function upsertUscfRows(
  sql: postgres.Sql,
  rows: DedupedUscfRow[],
  snapshotDate: string,
  log: (msg: string) => void,
): Promise<UpsertMetrics> {
  const metrics: UpsertMetrics = { inserted: 0, updated: 0, skipped: 0, snapshots: 0 };
  const total = rows.length;
  log(`[uscf] upserting ${total} rows in batches of ${UPSERT_BATCH_SIZE}…`);

  for (let i = 0; i < total; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);

    const result = await sql<
      {
        uscf_id: string;
        federation_player_id_uuid: string;
        action: 'inserted' | 'updated' | 'unchanged';
        rating_standard: number | null;
        rating_quick: number | null;
        rating_blitz: number | null;
        title: string | null;
      }[]
    >`
      WITH incoming AS (
        SELECT * FROM UNNEST(
          ${sql.array(batch.map((r) => r.uscfId))}::text[],
          ${sql.array(batch.map((r) => r.name))}::text[],
          ${sql.array(batch.map((r) => r.nameNormalized))}::text[],
          ${sql.array(batch.map((r) => r.state))}::text[],
          ${sql.array(batch.map((r) => r.ratingStandard))}::int[],
          ${sql.array(batch.map((r) => r.ratingQuick))}::int[],
          ${sql.array(batch.map((r) => r.ratingBlitz))}::int[],
          ${sql.array(batch.map((r) => r.title))}::text[],
          ${sql.array(batch.map((r) => JSON.stringify(r.raw)))}::text[]
        ) AS t(uscf_id, name, name_normalized, state,
               rating_standard, rating_quick, rating_blitz, title, raw)
      ),
      existing AS (
        SELECT fp.id, fp.federation_player_id,
               fp.rating_standard, fp.rating_quick, fp.rating_blitz, fp.title
        FROM federation_players fp
        WHERE fp.federation_id = 'USCF'
          AND fp.federation_player_id IN (SELECT uscf_id FROM incoming)
      ),
      upserted AS (
        INSERT INTO federation_players (
          federation_id, federation_player_id, name, name_normalized,
          country, rating_standard, rating_quick, rating_blitz, title,
          raw, last_updated_at
        )
        SELECT
          'USCF', i.uscf_id, i.name, i.name_normalized,
          'US',
          i.rating_standard, i.rating_quick, i.rating_blitz, i.title,
          i.raw::jsonb,
          NOW()
        FROM incoming i
        ON CONFLICT (federation_id, federation_player_id) DO UPDATE SET
          name = EXCLUDED.name,
          name_normalized = EXCLUDED.name_normalized,
          rating_standard = COALESCE(EXCLUDED.rating_standard, federation_players.rating_standard),
          rating_quick = COALESCE(EXCLUDED.rating_quick, federation_players.rating_quick),
          rating_blitz = COALESCE(EXCLUDED.rating_blitz, federation_players.rating_blitz),
          title = COALESCE(EXCLUDED.title, federation_players.title),
          raw = EXCLUDED.raw,
          last_updated_at = NOW()
        RETURNING
          id, federation_player_id,
          rating_standard, rating_quick, rating_blitz, title,
          (xmax = 0) AS was_inserted
      )
      SELECT
        u.federation_player_id AS uscf_id,
        u.id::text AS federation_player_id_uuid,
        CASE
          WHEN u.was_inserted THEN 'inserted'
          WHEN e.rating_standard IS DISTINCT FROM u.rating_standard
            OR e.rating_quick IS DISTINCT FROM u.rating_quick
            OR e.rating_blitz IS DISTINCT FROM u.rating_blitz
            OR e.title IS DISTINCT FROM u.title THEN 'updated'
          ELSE 'unchanged'
        END AS action,
        u.rating_standard, u.rating_quick, u.rating_blitz, u.title
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
        federationPlayerId: row.federation_player_id_uuid,
        ratingStandard: row.rating_standard,
        ratingRapid: row.rating_quick,
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

    if ((i / UPSERT_BATCH_SIZE) % 5 === 0) {
      log(
        `[uscf]   …${Math.min(i + UPSERT_BATCH_SIZE, total)}/${total} ` +
          `(+${metrics.inserted} new, ~${metrics.updated} updated)`,
      );
    }
  }

  return metrics;
}
