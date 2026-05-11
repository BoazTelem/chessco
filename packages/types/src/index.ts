// Shared TypeScript types across the Chessco monorepo.
// Populated in subsequent phases as features come online.
// Spec §5 data model is the source of truth.

export type Currency = 'USD' | 'EUR' | 'GBP' | 'ILS';

export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';

export type ChessColor = 'w' | 'b';

export type Platform = 'lichess' | 'chess.com' | 'fide' | 'chess-results';

export type ChessTitle = 'GM' | 'IM' | 'FM' | 'NM' | 'CM' | 'WGM' | 'WIM' | 'WFM' | 'WCM' | 'WNM';

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

export type TrustTier = 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';
