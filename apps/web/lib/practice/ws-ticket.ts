import { createHmac } from 'node:crypto';

/**
 * Mint a short-lived ticket for a participant to upgrade to the realtime
 * WebSocket server. Verified in apps/realtime/src/ticket.ts — keep the two
 * implementations byte-compatible.
 */
export type TicketRole = 'white' | 'black';

const DEFAULT_TTL_MS = 60_000;

export function signTicket(args: {
  matchId: string;
  userId: string;
  role: TicketRole;
  ttlMs?: number;
}): string {
  const secret = process.env.PRACTICE_WS_TICKET_SECRET;
  if (!secret) throw new Error('PRACTICE_WS_TICKET_SECRET not set');
  const expiresAt = Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS);
  const payload = `${args.matchId}.${args.userId}.${args.role}.${expiresAt}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
