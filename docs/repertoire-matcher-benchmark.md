# Repertoire Matcher Benchmark

This benchmark measures Chessco's PGN-first identity matcher in the way the
product actually needs to work: same player, different games. The uploaded PGNs
are not expected to exist in the matched account history.

## What It Tests

For each scout-ready account:

1. Select `N` games as the query sample.
2. Remove those games from that account's candidate repertoire.
3. Rebuild the target account's temporary repertoire from the remaining games.
4. Build a query fingerprint from the held-out games.
5. Rank the target against the eligible account corpus.
6. Record where the true account ranked.

The important guardrail: held-out games are excluded from the target account's
candidate vector for that trial. If we leak them into the candidate vector, the
benchmark becomes an exact-overlap test and overstates accuracy.

## Command

```powershell
pnpm --filter @chessco/workers eval:repertoire
```

Useful options:

```powershell
pnpm --filter @chessco/workers eval:repertoire -- --limit 500
pnpm --filter @chessco/workers eval:repertoire -- --platform lichess
pnpm --filter @chessco/workers eval:repertoire -- --sample-sizes 1,2,3,4,5,10,20,30
pnpm --filter @chessco/workers eval:repertoire -- --seeds 1,2,3,4,5
pnpm --filter @chessco/workers eval:repertoire -- --out apps/web/public/repertoire-benchmark.json
```

Default sample sizes are `1, 2, 3, 4, 5, 8, 10, 15, 20, 30`.

## Output

The worker writes `apps/web/public/repertoire-benchmark.json` by default.

The artifact includes:

- run config, timestamp, corpus size, and vector-key count
- derived game-count guidance: quick scan, recommended, high-confidence mode
- metrics by sample size: top-1, top-3, top-5, top-10, median rank, MRR
- calibration bins based on top score
- segment breakdowns: platform, rating band, title/context metadata availability,
  account game count, opening diversity, sample color balance, sample opening
  uniqueness, and dominant time class
- per-trial rows unless `--no-rows` is passed

The public summary page is `/benchmarks`.

## Reading The Results

Use the benchmark to decide product copy, not instinct.

- Quick scan: smallest sample size with top-10 accuracy at least 50%.
- Recommended: smallest sample size with top-3 accuracy at least 70%.
- High-confidence mode: smallest sample size with top-1 accuracy at least 75%.

If a threshold is not met, the UI should not claim that level yet.

## Current Matcher Shape

The benchmark uses repertoire overlap from the games-corpus move table:

- side-aware White/Black trees
- positions reached, normalized by the first four FEN fields
- player move choices from those positions
- recency weighting matching the persisted repertoire builder

This is intentionally closer to the planned secret sauce than the old
first-12-SAN-prefix cosine matcher.

## Future Additions

- Run against the full scout-ready corpus, not only a sampled `--limit`.
- Add account-context fusion benchmark: repertoire-only vs context-only vs fused.
- Add cross-platform sibling-account recovery.
- Add explicit titled/amateur labels once metadata coverage is strong enough.
- Compare offline benchmark confidence with user feedback labels:
  `correct`, `probably_correct`, `probably_wrong`, and `wrong`.
