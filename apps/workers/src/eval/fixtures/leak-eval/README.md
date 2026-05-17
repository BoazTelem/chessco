# Leak-eval datasets (B6 / B7 / B8)

These three files feed the CQ-2 verdict scripts. Until they exist, B6 / B7 / B8 emit `pending` verdicts on the `/benchmarks` dashboard.

The operator workflow:

1. Pick a panel of opponents (≥30 for B6, ≥10 for B7). FIDE 2200+ with verified online accounts is the canonical band.
2. Run the leak scorer in production via `apps/workers/scripts/leaks-smoke.ts` for each opponent + user color.
3. Serialize the outputs into the JSON shapes below.
4. Drop them in this directory and re-run `pnpm --filter @chessco/workers bench:b6 bench:b7 bench:b8`.

---

## `precision.json` (B6 — leak precision@5)

```json
{
  "generated_at": "2026-05-17T12:00:00Z",
  "opponents": [
    {
      "opponent_id": "lichess:drnykterstein",
      "user_color": "white",
      "surfaced_leaks": [
        {
          "fen_key": "r1bqkbnr/pp1ppppp/2n5/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -",
          "user_move_uci": "d2d4",
          "opp_move_uci": "c5d4",
          "eval_after_user": 0.55,
          "opp_winrate_from_position": 0.31
        }
      ]
    }
  ]
}
```

Pass criterion per leak (plan spec): `eval_after_user >= +0.4` for the user's color **and** `opp_winrate_from_position <= 0.35`. Aggregate gate: precision ≥80% across ≥10 opponents.

`eval_after_user` is signed from White's perspective; the B6 script flips it for Black users automatically.

---

## `recall.json` (B7 — leak recall sanity)

```json
{
  "generated_at": "2026-05-17T12:00:00Z",
  "opponents": [
    {
      "opponent_id": "chess.com:hikaru",
      "user_color": "black",
      "known_leak_fingerprints": ["abc123…", "def456…"],
      "surfaced_top10_fingerprints": ["abc123…", "ghi789…", "jkl…", "..."]
    }
  ]
}
```

`known_leak_fingerprints` is hand-curated (a human reviewer + engine confirms each). `surfaced_top10_fingerprints` comes verbatim from the scorer's top-10 output (use `leak.fingerprint`). Gate: recall ≥70% across ≥10 hand-labeled opponents.

---

## `prep-latency.json` (B8 — prep-report P95)

```json
{
  "generated_at": "2026-05-17T12:00:00Z",
  "samples": [
    { "opponent_id": "lichess:drnykterstein", "latency_ms": 14200 },
    { "opponent_id": "chess.com:magnuscarlsen", "latency_ms": 23800 },
    { "opponent_id": "lichess:fabianocaruana", "latency_ms": 38100 }
  ]
}
```

Capture from production by timing `GET /api/prepare/reports/[id]` end-to-end (parse PGN → leak compute → tree merge → JSON render). Gate: P95 < 90,000 ms with ≥5 samples.

---

## Updating

After collecting new data, **rotate the JSON in place** — the B-script verdicts are idempotent and the dashboard reads `runAt` from the artifact's `generated_at` field. Keep the previous versions in git so we can audit drift over time.
