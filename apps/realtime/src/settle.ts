import { env } from './env';
import type { Result, Termination } from './types';

/**
 * Notify the web app that a game has ended; the web app is the single
 * place where ledger writes happen (escrow → opponent_wallet, or the
 * auto-refund path for opponent abandonment).
 *
 * This call is idempotent on the web side keyed by matchId.
 */
export async function notifySettle(args: {
  matchId: string;
  result: Result;
  termination: Termination;
}): Promise<void> {
  const url = `${env.webOrigin}/api/practice/settle`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-practice-settle-secret': env.settleSecret,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[settle] failed for match ${args.matchId}: ${res.status} ${text}`);
  }
}
