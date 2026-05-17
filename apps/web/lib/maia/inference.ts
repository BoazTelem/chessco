/**
 * Maia inference client (spec §6 Phase 6 / WS-12).
 *
 * The Cloud Run inference worker holds the per-player Maia weights in
 * memory (or loads on demand from Supabase Storage) and answers
 * "given this FEN and a target player, what move would they play?"
 *
 * This module is the typed client. The worker URL lives in
 * MAIA_INFERENCE_URL; without it, getBotMove() returns a clear
 * "transport_unconfigured" outcome so the route doesn't crash.
 */

export interface BotMoveRequest {
  /** Maia weights row id (resolved via WeightsResolver, see below). */
  weightsId: string;
  fen: string;
  /** Optional move history. Some Maia variants use it for time-control bias. */
  history?: Array<{ uci: string; timeMs: number }>;
  /** Engine "noise" level — 0 = deterministic top move, 1 = sample like the
   *  trained player does. Default 1 (the whole point of Maia is non-engine
   *  play). */
  temperature?: number;
}

export interface BotMoveResponse {
  uci: string;
  san: string;
  /** Confidence of the chosen move, 0..1. */
  probability: number;
  /** Top-3 candidate moves with probabilities, for transparency / drill review. */
  candidates: Array<{ uci: string; san: string; probability: number }>;
  /** Wall-clock ms the worker spent. */
  latencyMs: number;
}

export type BotMoveOutcome =
  | { kind: 'ok'; move: BotMoveResponse }
  | { kind: 'transport_unconfigured'; message: string }
  | { kind: 'transport_error'; message: string }
  | { kind: 'weights_not_ready'; status: 'queued' | 'training' | 'failed' };

const REQUEST_TIMEOUT_MS = 8_000;

export async function getBotMove(req: BotMoveRequest): Promise<BotMoveOutcome> {
  const url = process.env.MAIA_INFERENCE_URL;
  if (!url) {
    return {
      kind: 'transport_unconfigured',
      message: 'MAIA_INFERENCE_URL is not set. Configure the Cloud Run inference endpoint.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (resp.status === 409) {
      // Worker convention: 409 = weights row exists but not ready yet.
      const body = (await resp.json().catch(() => ({ status: 'queued' }))) as {
        status?: 'queued' | 'training' | 'failed';
      };
      return { kind: 'weights_not_ready', status: body.status ?? 'queued' };
    }
    if (!resp.ok) {
      return { kind: 'transport_error', message: `inference HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as BotMoveResponse;
    return { kind: 'ok', move: data };
  } catch (err) {
    return {
      kind: 'transport_error',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve "the best ready Maia weights for this target" — caller passes
 * either a Chessco profile id or an external player id, this returns the
 * most-recent `ready` weights id (or null). The web route turns null into
 * a "no Maia for this opponent yet" UX state.
 *
 * Stays a type signature here — the actual query lives in the page that
 * needs it (so each callsite picks the right SQL backend, since this
 * could be Supabase or the practice db depending on context).
 */
export interface WeightsResolver {
  byProfile(profileId: string): Promise<string | null>;
  byPlayer(playerId: string): Promise<string | null>;
}
