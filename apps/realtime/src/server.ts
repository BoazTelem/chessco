import { createServer } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { env } from './env';
import { GameRoom } from './game-room';
import { verifyTicket, type DecodedTicket } from './ticket';

/**
 * Realtime game server. One process can host many concurrent matches; each
 * has its own GameRoom holding authoritative state in memory.
 *
 * Deployment notes:
 * - Sticky sessions required if scaled horizontally (one room per process).
 *   For Phase 1 a single instance is fine; revisit when concurrency demands.
 * - The HTTP server only exists to upgrade to WebSocket and serve a tiny
 *   /healthz endpoint for orchestrators.
 */

const rooms = new Map<string, GameRoom>();

async function getOrLoadRoom(matchId: string): Promise<GameRoom | null> {
  const existing = rooms.get(matchId);
  if (existing && !existing.isEnded) return existing;
  if (existing && existing.isEnded) rooms.delete(matchId);

  const room = await GameRoom.load(matchId);
  if (!room) return null;
  rooms.set(matchId, room);
  return room;
}

const httpServer = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  try {
    const origin = req.headers.origin;
    if (origin && !env.allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!req.url) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const match = /^\/game\/([a-f0-9-]+)$/.exec(url.pathname);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const matchId = match[1] as string;
    const ticketParam = url.searchParams.get('ticket') ?? '';
    const decoded = verifyTicket(ticketParam, env.wsTicketSecret);
    if (!decoded || decoded.matchId !== matchId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void onSocket(ws, decoded);
    });
  } catch (err) {
    console.error('[upgrade] error', err);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
});

async function onSocket(ws: WebSocket, ticket: DecodedTicket): Promise<void> {
  const room = await getOrLoadRoom(ticket.matchId);
  if (!room) {
    try {
      ws.send(JSON.stringify({ type: 'error', code: 'unknown', message: 'Match not found.' }));
      ws.close(4004, 'not found');
    } catch {
      /* ignore */
    }
    return;
  }
  if (room.isEnded) {
    try {
      ws.send(JSON.stringify({ type: 'error', code: 'game_over', message: 'Game already ended.' }));
      ws.close(4000, 'ended');
    } catch {
      /* ignore */
    }
    return;
  }
  room.attach(ticket.userId, ticket.role, ws);
}

// Periodic cleanup of ended rooms (keeps them for 60 s for late reconnects).
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.isEnded) rooms.delete(id);
  }
}, 60_000);

httpServer.listen(env.port, () => {
  console.log(`[realtime] listening on :${env.port}`);
});

process.on('SIGTERM', () => {
  console.log('[realtime] SIGTERM, shutting down');
  httpServer.close(() => process.exit(0));
});
