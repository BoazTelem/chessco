# Realtime reconnect + checkpoint contract

Audited 2026-05-17 as part of WS-7. The spec §14 calls for Redis checkpointing of game state per move so a crashed Fly.io instance can be replaced and the surviving instance resumes from the last checkpoint. The current implementation uses **Postgres `live_games`** rows as the checkpoint store — every accepted move flushes the canonical state (FEN, PGN, clocks, status) to `live_games` via `apps/realtime/src/persist.ts`. That gives us crash-safe resume today; Redis is a future latency optimization, not a correctness gap.

This doc captures the contract clients and operators rely on, so the eventual Redis swap doesn't break behavior.

---

## The state the checkpoint must persist

Every accepted move must end with these fields written before the client move-ack is sent:

| `live_games` column | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `current_fen`       | Canonical position. Used by replay and reconnect.                     |
| `pgn`               | Full move list as SAN. Replay + post-game review depend on it.        |
| `white_time_ms`     | Server-authoritative White clock at the moment the move was accepted. |
| `black_time_ms`     | Same for Black.                                                       |
| `status`            | `live` / `completed` / `aborted` / `abandoned`.                       |

Postgres writes are atomic per row, so a partial checkpoint cannot leak. The clock fields are computed by `apps/realtime/src/clock.ts` and are the source of truth for spec §14 "server-authoritative clocks".

---

## Reconnect protocol (client side)

When a client's WebSocket drops, it MUST reconnect to `/match/{match_id}?token={jwt}` within the disconnect grace window (60 s per spec §14). The server's `hello` reply hydrates state from `loadMatchContext(match_id)` in `apps/realtime/src/persist.ts`, which joins `matches` + `challenges` + `live_games` and returns:

```ts
{
  match: { id, challenge_id, opponent_id, creator_id, status, game_id },
  liveGame: {
    id, match_id, white_user_id, black_user_id,
    initial_fen, current_fen, pgn, time_control,
    white_time_ms, black_time_ms, status, started_at
  }
}
```

Clients should:

1. Render the board from `current_fen` (or `initial_fen` if `current_fen` is null at game start).
2. Replay `pgn` to populate the move list panel.
3. Start a smooth clock countdown from the side-to-move's `*_time_ms`, anchored to local wall clock at the moment of receipt. The server broadcasts `clock` resync messages every ~1s so client drift is bounded by the network jitter, not local CPU.
4. Continue sending `move` / `resign` / `draw_offer` messages normally; the server treats them idempotently per the existing protocol.

---

## Spec §14 alignment

| Spec requirement               | Today                                               | Spec target                 |
| ------------------------------ | --------------------------------------------------- | --------------------------- |
| Server-authoritative clocks    | ✓ `clock.ts` + per-move broadcast                   | same                        |
| Sub-200 ms move latency        | ✓ at Fly.io edge                                    | same                        |
| Crash-safe checkpoint per move | ✓ Postgres `live_games` row write                   | Redis (future optimization) |
| 60 s reconnect grace           | ✓ enforced in `game-room.ts`                        | same                        |
| Asymmetric abandonment rule    | ✓ via `MatchStatus` (abandoned / creator_abandoned) | same                        |

The Redis swap (when it happens):

- Adds a Redis `set match:<id> <json>` after every Postgres write so warm-resume reads off Redis at ~1 ms instead of Postgres at ~5–15 ms.
- The Postgres write stays the durable source of truth — Redis is a read-through cache, not a write-back store, so a Redis flush never loses state.
- Read path becomes: `Redis.get(match) ?? loadMatchContext(...)`. No client API change.

---

## When to swap to Redis

When **either** of the following is true:

- P95 reconnect latency on `loadMatchContext` exceeds 200 ms in prod (currently well under).
- We're paying for excess Postgres connections from concurrent reconnect storms — e.g. >200 concurrent matches with frequent reconnects in mobile networks.

Until one of those triggers fires, the Postgres-checkpoint pattern is the right tradeoff: fewer moving parts, fewer infra dependencies, easy local dev.

---

## Operator runbook deltas

- **Disaster recovery:** `live_games` is in Cloud SQL with PITR (per `SETUP-CLOUDSQL.md` §1). A regional Cloud SQL outage takes both the durable store and live state offline; the Fly.io game server cannot serve moves during that window. The 60 s reconnect grace covers normal Fly.io instance churn but NOT Cloud SQL outages.
- **Monitoring:** alert on the realtime server's `persist_failures_total` counter (write retries > 0 across a 1-minute window) — that signals Cloud SQL connectivity is degraded.
