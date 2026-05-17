# Spectator mode (WS-12)

Spec §6 Phase 6. Read-only WebSocket subscription to a live match with a 10-move delay to prevent real-time coaching abuse. Verified silver+ users can opt into no-delay viewing.

---

## Why a delay

If a spectator can see the live position, a viewer with engine access can whisper recommended moves through any side channel. The 10-move delay (≈ 30–90 seconds at blitz/rapid pace) is long enough that any coaching is moot: by the time the position is visible, the game has moved on.

For verified silver+ users the delay drops to 0 because they have a trust + KYC track record and the platform's exposure to abuse is much lower.

---

## WS endpoint

    wss://gameserver.chessco.org/spectate/{match_id}?token={spectator_jwt}

The `spectator_jwt` is signed by the web app and includes:

- `match_id`
- `viewer_profile_id`
- `delay_plies` — server enforces (10 by default, 0 for verified silver+)
- `exp` — short-lived (~15 min)

The realtime server validates the JWT and the match's spectator policy (the creator can disable spectators per-challenge in the create flow).

## Protocol

Server pushes the same `state` / `move` events as the player WS, but **shifted by `delay_plies`**. The server queues live events and releases them only when the game has advanced by N plies past the queued point. Format:

    { "type": "state", "fen": "...", "pgn": "...", "clocks": { ... }, "ply": 23 }

`ply` is the **viewable** ply, not the live ply. Spectators never see the live ply on the wire.

## Live-ply leak prevention

Three rules:

1. The server's broadcast queue holds events for `delay_plies` before flushing.
2. The `clocks` field is updated to the time-as-of-the-viewable-ply, not real time. A spectator subtracting clock-tick from server time cannot back into the live position.
3. On game end, the queue flushes fully so spectators see the final position within ~1 second of conclusion.

## Auth + opt-out

Match creators can disable spectators per challenge via `challenges.spectators_enabled` (column add — TBD; not in this WS). Default opt-in for unrated/credit games; default opt-out for paid matches above $5 USD equivalent.

## Operator follow-through

1. Add `challenges.spectators_enabled` boolean column (default true).
2. Build the realtime server's `/spectate/{match_id}` handler with the delay queue.
3. Add a JWT mint endpoint at `POST /api/spectate/[match_id]/ticket` (mirroring the existing player ticket route).
4. Build the spectator board UI — same component as the live game, read-only, with a "viewing 10-ply delayed" banner.
