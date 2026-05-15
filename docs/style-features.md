# Style Features — Schema Reference

Per-handle stylometric fingerprint produced by `apps/workers/src/features/extract.ts` and consumed by the `/scout` PGN matcher (Stage 3 cascade). Every value below is computed from a window of games belonging to one handle, with no engine evaluation required (Stockfish-derived fields are populated only when prior analysis exists in `games.mean_cp_loss*`).

Stored as JSONB in `style_features.features`. The shape is captured in TypeScript at [apps/workers/src/features/types.ts](../apps/workers/src/features/types.ts) (`PlayerFeaturesV0`). Materialized writers also stamp the **`features_version` column** on `style_features` and `account_fingerprints` (added in migration [0013_features_versioning.sql](../packages/db/migrations/games-corpus/0013_features_versioning.sql), 2026-05-15) so future schema evolution can be A/B-compared by query without unpacking the JSON.

## Field catalog (V0)

### Coverage

| Field            | Type   | Description                             |
| ---------------- | ------ | --------------------------------------- |
| `version`        | `'v0'` | Schema marker. Mirror of the DB column. |
| `games_total`    | int    | Games in the window.                    |
| `games_as_white` | int    | Subset where this handle was White.     |
| `games_as_black` | int    | Subset where this handle was Black.     |

### Result mix (per color × outcome)

| Field                                                | Type | Description          |
| ---------------------------------------------------- | ---- | -------------------- |
| `wins_as_white`, `losses_as_white`, `draws_as_white` | int  | White-side outcomes. |
| `wins_as_black`, `losses_as_black`, `draws_as_black` | int  | Black-side outcomes. |

### Opening repertoire (ECO histograms)

| Field       | Type                 | Description                                                               |
| ----------- | -------------------- | ------------------------------------------------------------------------- |
| `eco_white` | `Record<eco, count>` | ECO codes the handle reached as White. Frequency-counted, not normalized. |
| `eco_black` | `Record<eco, count>` | ECO codes as Black.                                                       |

### Move-sequence fingerprint

| Field            | Type                 | Description                                                                   |
| ---------------- | -------------------- | ----------------------------------------------------------------------------- |
| `move_seq_white` | `Record<seq, count>` | First 12 plies of each White game, joined SAN with spaces. Frequency-counted. |
| `move_seq_black` | `Record<seq, count>` | First 12 plies of each Black game.                                            |

### Time control

| Field        | Type                       | Description                                                      |
| ------------ | -------------------------- | ---------------------------------------------------------------- |
| `time_class` | `Record<TimeClass, count>` | Pace distribution: bullet / blitz / rapid / classical / unknown. |

### Game termination

| Field         | Type                    | Description                                                           |
| ------------- | ----------------------- | --------------------------------------------------------------------- |
| `termination` | `Record<string, count>` | Termination text from PGN (Normal / Time forfeit / Abandoned / etc.). |

### Opponent strength

| Field                 | Type          | Description                                                       |
| --------------------- | ------------- | ----------------------------------------------------------------- |
| `avg_opponent_rating` | float \| null | Mean of opposing-side rating across all games.                    |
| `opponent_rating_min` | int \| null   | Lowest opponent rating observed.                                  |
| `opponent_rating_max` | int \| null   | Highest opponent rating observed.                                 |
| `avg_ply_count`       | float \| null | Mean game length in plies. Proxy for grinding vs. tactical style. |

### Window bounds

| Field                | Type     | Description                        |
| -------------------- | -------- | ---------------------------------- |
| `earliest_played_at` | ISO date | Oldest game in the feature window. |
| `latest_played_at`   | ISO date | Newest game in the feature window. |

### Stockfish-derived accuracy (nullable when no analyzed games)

| Field                | Type          | Description                                                              |
| -------------------- | ------------- | ------------------------------------------------------------------------ |
| `analyzed_games`     | int           | Subset of `games_total` where `games.mean_cp_loss` is non-null.          |
| `mean_cp_loss`       | float \| null | Average centipawn loss across all analyzed plies. Lower = more accurate. |
| `mean_cp_loss_white` | float \| null | Same, restricted to White-side plies.                                    |
| `mean_cp_loss_black` | float \| null | Same, restricted to Black-side plies.                                    |

(Note: `blunder_rate` was in the original V0 plan but is currently not populated by `extract.ts`; treat as nullable / not yet computed.)

## How the matcher uses these

`apps/workers/src/stage3/match.ts` (and its web mirror `apps/web/lib/scout/stage3.ts`) combines the seven scoring components below into a `combined_score` ∈ [0, 1]:

| Component               | Source                     | Default weight |
| ----------------------- | -------------------------- | -------------- |
| `eco_white` cosine      | `eco_white` histogram      | 0.18           |
| `eco_black` cosine      | `eco_black` histogram      | 0.18           |
| `move_seq_white` cosine | `move_seq_white` histogram | 0.18           |
| `move_seq_black` cosine | `move_seq_black` histogram | 0.18           |
| `time_class` cosine     | `time_class` histogram     | 0.08           |
| `opp_rating` Gaussian   | `avg_opponent_rating`      | 0.10           |
| `cp_loss` Gaussian      | `mean_cp_loss`             | 0.10           |

Components with null inputs degrade to 0 contribution; the cascade matcher (machine #1's `79003a1`) reuses these weights in Stage C re-rank.

## Sparse storage shape (cascade Stage A/B)

The same V0 features are denormalized into two additional tables for the sparse-cascade matcher (migration [0010_account_fingerprints.sql](../packages/db/migrations/games-corpus/0010_account_fingerprints.sql)):

- **`account_fingerprints`** — one row per handle. Holds the scalar prefilter columns (`games_window`, `median_rating`, `dominant_time_class`, `white_share`) plus a `scalar_summary` JSONB mirror of the V0 features. `features_version` column lets you query exactly the version you produced.
- **`fingerprint_terms`** — sparse inverted index. One row per `(player_id, kind, term)` with an L1-normalized `weight`. Stage B retrieval scores candidates by SUM(stored_weight × query_weight × kind_weight).

## Versioning conventions (`features_version`)

- `v0` — current schema (this document).
- `v1` and beyond — bump when ANY of the following change in a way that breaks comparisons:
  1. New field added that's used in scoring (else just leave it `v0` and treat the new field as nullable in callers).
  2. Existing field's computation changes (window size, normalization, dedup rule, etc.).
  3. Score weights in the matcher change in a way that callers might want to reproduce/test against the old weights.

When bumping the version:

1. Update `version` literal in [apps/workers/src/features/types.ts](../apps/workers/src/features/types.ts).
2. Update writers to stamp the new value on every upsert (`extract.ts`, `fast-lane.ts`).
3. Backfill or wait — the matcher should default to `WHERE features_version = $latest`, falling back to `v0` for any handle that hasn't been re-extracted yet.
4. Update this document with the new field catalog and what changed.
