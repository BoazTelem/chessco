/**
 * Annotated PGN serializer for a prep report.
 *
 * Produces one PGN "game" per leak — the game records the user's
 * recommended response to the opponent's bad move, with comments carrying
 * the leak stats (sample size, blunder rate, avg cp loss). The output is
 * valid PGN that Lichess Studies and ChessBase will both import, so a user
 * can paste straight into their study workflow.
 *
 * Pure function — no DB, no LLM, no Playwright. Tested by virtue of
 * round-trip via chess.js when the export endpoint runs.
 */
import type { Leak } from './types';

export interface PgnExportArgs {
  reportId: string;
  opponentLabel: string;
  whiteLeaks: Leak[];
  blackLeaks: Leak[];
  /** ISO string for the PGN Date tag (UTC date portion). */
  generatedAt: string;
}

const SAFE_TAG = /[\[\]"\\]/g;

function tag(name: string, value: string): string {
  // PGN tag values forbid raw `]`, `[`, `"`, `\` (per PGN spec §8.1).
  return `[${name} "${value.replace(SAFE_TAG, '')}"]`;
}

function leakCommentLines(leak: Leak): string[] {
  const lines: string[] = [];
  lines.push(`Leak vs opponent move ${leak.opponentBadMoveSan}`);
  lines.push(`Sample: ${leak.stats.gamesCount} games`);
  if (Number.isFinite(leak.stats.blunderRate)) {
    lines.push(`Blunder rate: ${(leak.stats.blunderRate * 100).toFixed(1)}%`);
  }
  if (Number.isFinite(leak.stats.mistakeRate)) {
    lines.push(`Mistake rate: ${(leak.stats.mistakeRate * 100).toFixed(1)}%`);
  }
  if (Number.isFinite(leak.stats.avgCpLoss)) {
    lines.push(`Avg cp loss: ${leak.stats.avgCpLoss.toFixed(0)}`);
  }
  lines.push(`Kind: ${leak.kind}`);
  if (leak.opponentBetterMoveSan) {
    lines.push(`Their better move: ${leak.opponentBetterMoveSan}`);
  }
  return lines;
}

/**
 * Build a PGN move text body from a leak. Pairs each ply with its SAN,
 * with the user's recommended move emitted as the last ply followed by an
 * inline comment containing the leak stats.
 *
 * Format: `1. e4 e5 2. Nf3 f6 3. Nxe5 { Leak vs opponent move f6 ... }`
 *
 * No result string — the file caller appends "*" because the position is
 * mid-game.
 */
function buildMoveText(leak: Leak, userColor: 'white' | 'black'): string {
  const plies = [...leak.sanPath, leak.opponentBadMoveSan, leak.userMoveSan];
  const out: string[] = [];
  for (let i = 0; i < plies.length; i++) {
    if (i % 2 === 0) out.push(`${Math.floor(i / 2) + 1}.`);
    else out.push(`${Math.floor(i / 2) + 1}...`);
    out.push(plies[i]!);
  }
  // Inline annotation after the user's recommended move.
  const annotation = leakCommentLines(leak).join('\n');
  out.push(`{ ${annotation} }`);
  // Mid-game game ends in "*" (no result).
  out.push('*');
  // Sanity: re-tag colour the user plays so the consumer board orients
  // correctly. Stored as a separate header tag, not inline.
  void userColor;
  return out.join(' ');
}

function leakAsGame(args: {
  reportId: string;
  opponentLabel: string;
  leak: Leak;
  userColor: 'white' | 'black';
  generatedAt: string;
  index: number;
}): string {
  const dateOnly = args.generatedAt.slice(0, 10).replace(/-/g, '.');
  const white = args.userColor === 'white' ? 'You (prep)' : args.opponentLabel;
  const black = args.userColor === 'white' ? args.opponentLabel : 'You (prep)';
  const header = [
    tag('Event', `Chessco prep leak #${args.index + 1}`),
    tag('Site', 'chessco.org'),
    tag('Date', dateOnly),
    tag('Round', String(args.index + 1)),
    tag('White', white),
    tag('Black', black),
    tag('Result', '*'),
    tag('ChesscoReportId', args.reportId),
    tag('ChesscoLeakFingerprint', args.leak.fingerprint),
    tag('ChesscoLeakKind', args.leak.kind),
    tag('ChesscoUserColor', args.userColor),
  ].join('\n');
  return `${header}\n\n${buildMoveText(args.leak, args.userColor)}`;
}

export function exportReportAsPgn(args: PgnExportArgs): string {
  const games: string[] = [];
  args.whiteLeaks.forEach((leak, i) => {
    games.push(
      leakAsGame({
        reportId: args.reportId,
        opponentLabel: args.opponentLabel,
        leak,
        userColor: 'white',
        generatedAt: args.generatedAt,
        index: i,
      }),
    );
  });
  args.blackLeaks.forEach((leak, i) => {
    games.push(
      leakAsGame({
        reportId: args.reportId,
        opponentLabel: args.opponentLabel,
        leak,
        userColor: 'black',
        generatedAt: args.generatedAt,
        index: args.whiteLeaks.length + i,
      }),
    );
  });
  // PGN convention: two newlines between games.
  return games.join('\n\n');
}
