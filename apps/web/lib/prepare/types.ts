export type Platform = 'lichess' | 'chess.com';

export type Color = 'white' | 'black';

export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'unknown';
export type RealTimeClass = Exclude<TimeClass, 'unknown'>;
export const REAL_TIME_CLASSES: readonly RealTimeClass[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
] as const;

export type GameResult = 'win' | 'loss' | 'draw';

export type WindowPreset = 1 | 2 | 3 | 5 | 'all' | 'custom';

export interface Filters {
  color: Color;
  timeClasses: ReadonlySet<RealTimeClass>;
  window: WindowPreset;
  customSince: Date | null;
  customUntil: Date | null;
}

export interface GameRecord {
  id: string;
  playedAt: Date;
  playerColor: Color;
  result: GameResult;
  resultText: '1-0' | '0-1' | '1/2-1/2';
  timeClass: TimeClass;
  whiteHandle: string;
  blackHandle: string;
  whiteElo: number | null;
  blackElo: number | null;
  movesSan: string[];
  movesUci: string[];
  fensBefore: string[];
}

const SAMPLE_GAMES_PER_MOVE = 6;
export const MAX_SAMPLE_GAMES_PER_MOVE = SAMPLE_GAMES_PER_MOVE;

export interface NextMoveStats {
  san: string;
  uci: string;
  fromSquare: string;
  toSquare: string;
  gamesCount: number;
  wins: number;
  draws: number;
  losses: number;
  weightedScore: number;
  lastPlayedAt: Date;
  recentGameIds: string[];
}

export interface TreeNode {
  fenKey: string;
  totalGames: number;
  totalWeighted: number;
  children: Map<string, NextMoveStats>;
}

export type Tree = Map<string, TreeNode>;

export interface FetchProgress {
  phase: 'idle' | 'hydrating' | 'fetching' | 'parsing' | 'done' | 'error';
  fetchedGames: number;
  estimatedTotal: number | null;
  currentLabel: string | null;
  errorMessage: string | null;
}

export const STARTING_FEN_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
