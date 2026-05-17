/**
 * Shared insert path for the external_pgn_sources staging table.
 *
 * Used by per-source workers (TWIC, chessgames.com, …) to push parsed
 * PGN rows into the games-corpus DB with a uniform shape. The downstream
 * passes (FIDE resolver, games ingester) then read from this table —
 * see docs/external-pgn-auto-fetch.md for the full pipeline.
 *
 * Idempotency: ON CONFLICT (source, source_url) DO NOTHING. Re-running
 * an issue is safe and skips rows we've already seen.
 */
import type postgres from 'postgres';
import type { ParsedGame } from '../../lichess-dumps/types';

export interface ExternalPgnRow {
  source: string;
  source_url: string;
  source_event: string | null;
  source_issue: string | null;
  raw_pgn: string;
  white_name: string | null;
  black_name: string | null;
  white_elo: number | null;
  black_elo: number | null;
  /** ISO 8601 string at the day level — Postgres parses to timestamptz. */
  played_at: string | null;
  result: '1-0' | '0-1' | '1/2-1/2' | '*' | null;
}

/** Reconstruct a single-game PGN block from parsed headers + move text. */
export function serialiseParsedGame(game: ParsedGame): string {
  const lines: string[] = [];
  for (const [tag, value] of Object.entries(game.headers)) {
    if (typeof value !== 'string') continue;
    // PGN header escaping: " → \", \ → \\.
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`[${tag} "${escaped}"]`);
  }
  lines.push('');
  lines.push(game.moveText.trim());
  return lines.join('\n');
}

/** Convert a TWIC/PGN Date header ('2023.12.23' / '2023.??.??') to ISO. */
function parsePgnDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [y, m, d] = parts;
  if (!y || y === '????') return null;
  const month = !m || m === '??' ? '01' : m.padStart(2, '0');
  const day = !d || d === '??' ? '01' : d.padStart(2, '0');
  return `${y}-${month}-${day}T00:00:00.000Z`;
}

function parseElo(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function canonicalResult(raw: string | undefined): ExternalPgnRow['result'] {
  if (raw === '1-0' || raw === '0-1' || raw === '1/2-1/2' || raw === '*') return raw;
  return null;
}

/**
 * Build an ExternalPgnRow from a ParsedGame and source metadata. Source-
 * specific workers call this per game inside their stream loop.
 */
export function buildExternalPgnRow(
  game: ParsedGame,
  source: string,
  sourceUrl: string,
  sourceIssue: string | null,
): ExternalPgnRow {
  const h = game.headers;
  return {
    source,
    source_url: sourceUrl,
    source_event: typeof h.Event === 'string' ? h.Event : null,
    source_issue: sourceIssue,
    raw_pgn: serialiseParsedGame(game),
    white_name: typeof h.White === 'string' ? h.White : null,
    black_name: typeof h.Black === 'string' ? h.Black : null,
    white_elo: parseElo(typeof h.WhiteElo === 'string' ? h.WhiteElo : undefined),
    black_elo: parseElo(typeof h.BlackElo === 'string' ? h.BlackElo : undefined),
    played_at: parsePgnDate(typeof h.Date === 'string' ? h.Date : undefined),
    result: canonicalResult(typeof h.Result === 'string' ? h.Result : undefined),
  };
}

/**
 * Batch-insert rows into external_pgn_sources. Idempotent — existing
 * (source, source_url) pairs are skipped.
 *
 * Chunked at 500 rows per INSERT because raw_pgn is long (~2KB avg);
 * 500 × ~12 cols = 6,000 params, well under the 65,534 cap and keeps
 * a single statement under ~1 MB.
 */
export async function batchInsertExternalPgn(
  sql: postgres.Sql,
  rows: ExternalPgnRow[],
): Promise<{ inserted: number; conflicts: number }> {
  if (rows.length === 0) return { inserted: 0, conflicts: 0 };

  const CHUNK = 500;
  let inserted = 0;
  let conflicts = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    // jsonb_to_recordset gives us a stable INSERT shape regardless of the
    // ParsedGame surface, and the postgres-js JSON.stringify roundtrip
    // sidesteps the sql.array() text[] CSV gotcha (memory:
    // feedback_postgres_js_arrays).
    const result = await sql<{ id: string }[]>`
      INSERT INTO external_pgn_sources (
        source, source_url, source_event, source_issue, raw_pgn,
        white_name, black_name, white_elo, black_elo, played_at, result
      )
      SELECT
        source, source_url, source_event, source_issue, raw_pgn,
        white_name, black_name, white_elo, black_elo, played_at::timestamptz, result
      FROM jsonb_to_recordset(${JSON.stringify(slice)}::jsonb)
        AS r(
          source text, source_url text, source_event text, source_issue text,
          raw_pgn text, white_name text, black_name text,
          white_elo int, black_elo int, played_at text, result text
        )
      ON CONFLICT (source, source_url) DO NOTHING
      RETURNING id::text
    `;
    inserted += result.length;
    conflicts += slice.length - result.length;
  }

  return { inserted, conflicts };
}
