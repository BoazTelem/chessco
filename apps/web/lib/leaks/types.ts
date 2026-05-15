export type Platform = 'lichess' | 'chess.com';
export type Color = 'white' | 'black';
// 'personalized' / 'surprise': leaks in the OPPONENT's play that the user
//   can punish — the original feature.
// 'own': positions where the USER has played a bad move that the opponent
//   actually reaches in their own games — "where you slip up against this
//   opponent's repertoire." userMoveSan = the user's bad move on the row.
export type LeakKind = 'personalized' | 'surprise' | 'own';

export interface SerializedNextMove {
  san: string;
  uci: string;
  fromSquare: string;
  toSquare: string;
  gamesCount: number;
  wins: number;
  draws: number;
  losses: number;
  weightedScore: number;
  lastPlayedAt: string;
  recentGameIds: string[];
}

export interface SerializedTreeNode {
  fenKey: string;
  totalGames: number;
  totalWeighted: number;
  children: Record<string, SerializedNextMove>;
}

export type SerializedTree = Record<string, SerializedTreeNode>;

export interface MoveQuality {
  gamesCount: number;
  blunderRate: number;
  mistakeRate: number;
  avgCpLoss: number;
}

export type MoveQualityIndex = Map<string, MoveQuality>;

export interface LeakStats {
  gamesCount: number;
  blunderRate: number;
  mistakeRate: number;
  avgCpLoss: number;
  userReach: number;
  opponentReach: number;
  badMoveShare: number;
}

export interface Leak {
  fingerprint: string;
  fenKey: string;
  sanPath: string[];
  userMoveSan: string;
  userMoveUci: string;
  opponentBadMoveSan: string;
  opponentBadMoveUci: string;
  opponentBetterMoveSan: string | null;
  stats: LeakStats;
  kind: LeakKind;
  score: number;
}

export interface ScoreOptions {
  platform: Platform;
  handleNormalized: string;
  userColor: Color;
  maxPlies?: number;
  minGamesCount?: number;
  maxPersonalized?: number;
  maxSurprise?: number;
}
