/**
 * Wire protocol between GamePlayer.tsx and the realtime game-room server.
 * Mirrors apps/realtime/src/types.ts — keep them in sync.
 */

export type Color = 'white' | 'black';
export type Result = '1-0' | '0-1' | '1/2-1/2' | '*';
export type Termination =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient_material'
  | 'threefold_repetition'
  | 'fifty_moves'
  | 'resign'
  | 'timeout'
  | 'agreed_draw'
  | 'creator_abandoned'
  | 'opponent_abandoned'
  | 'aborted';

/** Server → client */
export type ServerMsg =
  | {
      type: 'state';
      fen: string;
      pgn: string;
      whiteTimeMs: number;
      blackTimeMs: number;
      sideToMove: Color;
      lastMove: { san: string; uci: string; ply: number } | null;
      youAre: Color;
      whiteUserId: string;
      blackUserId: string;
      status: 'live' | 'completed' | 'aborted' | 'abandoned';
      result: Result | null;
      termination: Termination | null;
      paused: boolean;
    }
  | {
      type: 'move';
      san: string;
      uci: string;
      ply: number;
      fen: string;
      whiteTimeMs: number;
      blackTimeMs: number;
    }
  | { type: 'clock'; whiteTimeMs: number; blackTimeMs: number; paused: boolean }
  | {
      type: 'end';
      result: Result;
      termination: Termination;
      whiteTimeMs: number;
      blackTimeMs: number;
    }
  | { type: 'draw_offer'; from: Color }
  | { type: 'draw_decline'; from: Color }
  | {
      type: 'presence';
      color: Color;
      connected: boolean;
      reason: 'waiting' | 'first_move' | 'disconnected' | 'reconnected';
      deadlineMs: number | null;
    }
  | {
      type: 'error';
      code: 'illegal_move' | 'not_your_turn' | 'game_over' | 'auth' | 'unknown';
      message: string;
    };

/** Client → server */
export type ClientMsg =
  | { type: 'move'; uci: string; clientTs: number }
  | { type: 'resign' }
  | { type: 'offer_draw' }
  | { type: 'accept_draw' }
  | { type: 'decline_draw' }
  | { type: 'abort' };
