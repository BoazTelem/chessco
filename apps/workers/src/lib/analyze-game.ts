/**
 * Per-game cp-loss aggregation.
 *
 * Given a PGN and a running StockfishEngine, walk the moves and evaluate
 * each position between `startPly` and `endPly`. For each consecutive pair
 * of evals (the mover's POV → opponent's POV), cp_loss for the mover is:
 *
 *   cp_loss = max(0, eval_before_their_move + eval_after_their_move)
 *
 * Both Stockfish evals are reported from side-to-move POV, so summing
 * them gives the *signed change* from the mover's POV — a positive sum
 * means the mover gave up that many centipawns vs continuing to play.
 *
 * We skip the first `startPly` plies (book theory) and any plies past
 * `endPly` (endgames are noisy and asymmetric). Defaults are 10–60 which
 * captures the "middlegame fingerprint" most players have personality in.
 */
import { Chess } from 'chess.js';
import { scoreToCp, type StockfishEngine } from './stockfish';

export interface AnalyzeOptions {
  /** Ply count from which to start analyzing (0-based). Default 10 = skip opening. */
  startPly?: number;
  /** Max ply to analyze, exclusive. Default 60 = skip late endgames. */
  endPly?: number;
  /** Stockfish depth per position. Default 10 = ~25–40ms/pos with lite-single. */
  depth?: number;
  /** Centipawn loss threshold for a "blunder". Default 200 = 2 pawns lost. */
  blunderCp?: number;
}

export interface GameAnalysis {
  /** Plies actually evaluated (skipped book + truncated to endPly). */
  plies_analyzed: number;
  /** Mean cp-loss per ply, in centipawns. null if no plies analyzed. */
  mean_cp_loss: number | null;
  /** Count of plies where cp-loss exceeded `blunderCp`. */
  blunder_count: number;
  /** Per-side breakdown — useful for "this player blunders as black" signals. */
  mean_cp_loss_white: number | null;
  mean_cp_loss_black: number | null;
}

export async function analyzeGame(
  engine: StockfishEngine,
  pgn: string,
  opts: AnalyzeOptions = {},
): Promise<GameAnalysis> {
  const startPly = opts.startPly ?? 10;
  const endPly = opts.endPly ?? 60;
  const depth = opts.depth ?? 10;
  const blunderCp = opts.blunderCp ?? 200;

  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch {
    return emptyAnalysis();
  }

  const history = chess.history({ verbose: true });
  if (history.length < startPly + 2) return emptyAnalysis();

  // Replay from the start, collecting FEN-before-each-move so we can hand
  // them to Stockfish in order.
  const replay = new Chess();
  const positions: Array<{ fen: string; mover: 'white' | 'black' }> = [];
  for (let i = 0; i < history.length && i <= endPly; i++) {
    positions.push({ fen: replay.fen(), mover: replay.turn() === 'w' ? 'white' : 'black' });
    replay.move(history[i]!.san);
  }
  // Also push the final position so we have the after-eval for the last move
  // we care about.
  if (history.length <= endPly) {
    positions.push({ fen: replay.fen(), mover: replay.turn() === 'w' ? 'white' : 'black' });
  }

  // Evaluate each position between startPly and the last needed ply.
  // We need eval[i] AND eval[i+1] for cp-loss of move i, so analyze startPly..endPly inclusive.
  const evals: Array<{ cp: number | null; mover: 'white' | 'black' }> = [];
  for (let i = startPly; i < positions.length; i++) {
    const p = positions[i]!;
    const result = await engine.evalPosition(p.fen, depth);
    evals.push({ cp: scoreToCp(result), mover: p.mover });
  }

  // Compute cp-loss per ply, attributing to the mover of that ply.
  let lossSum = 0;
  let lossCount = 0;
  let lossSumWhite = 0;
  let lossSumBlack = 0;
  let lossCountWhite = 0;
  let lossCountBlack = 0;
  let blunderCount = 0;
  for (let i = 0; i + 1 < evals.length; i++) {
    const before = evals[i]!;
    const after = evals[i + 1]!;
    if (before.cp === null || after.cp === null) continue;
    // cp_loss for the mover = before + after  (both reported from side-to-move POV)
    const loss = Math.max(0, before.cp + after.cp);
    lossSum += loss;
    lossCount += 1;
    if (before.mover === 'white') {
      lossSumWhite += loss;
      lossCountWhite += 1;
    } else {
      lossSumBlack += loss;
      lossCountBlack += 1;
    }
    if (loss >= blunderCp) blunderCount += 1;
  }

  return {
    plies_analyzed: lossCount,
    mean_cp_loss: lossCount > 0 ? lossSum / lossCount : null,
    blunder_count: blunderCount,
    mean_cp_loss_white: lossCountWhite > 0 ? lossSumWhite / lossCountWhite : null,
    mean_cp_loss_black: lossCountBlack > 0 ? lossSumBlack / lossCountBlack : null,
  };
}

function emptyAnalysis(): GameAnalysis {
  return {
    plies_analyzed: 0,
    mean_cp_loss: null,
    blunder_count: 0,
    mean_cp_loss_white: null,
    mean_cp_loss_black: null,
  };
}
