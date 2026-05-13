import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WS handshake ticket. The web app mints one when a participant requests
 * to join a match; the realtime server verifies it on the WebSocket upgrade.
 *
 * Payload: <matchId>.<userId>.<role>.<expiresAtUnixMs>.<sig>
 * sig = HMAC-SHA256(secret, "<matchId>.<userId>.<role>.<expiresAtUnixMs>")
 *
 * Keep this file byte-identical with apps/web/lib/practice/ws-ticket.ts so
 * sign/verify stay in lockstep across the two workspaces.
 */

export type TicketRole = 'white' | 'black';

export interface DecodedTicket {
  matchId: string;
  userId: string;
  role: TicketRole;
  expiresAt: number;
}

export function verifyTicket(
  token: string,
  secret: string,
  nowMs = Date.now(),
): DecodedTicket | null {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [matchId, userId, role, expStr, sig] = parts as [string, string, string, string, string];
  if (role !== 'white' && role !== 'black') return null;

  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || expiresAt < nowMs) return null;

  const payload = `${matchId}.${userId}.${role}.${expStr}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  return { matchId, userId, role: role as TicketRole, expiresAt };
}
