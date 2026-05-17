# Maia inference + training pipeline (WS-12 contract)

Phase 6. Bots that play like a specific human, per spec §6. The web app calls a Cloud Run worker; the worker holds the per-player weights and answers move-by-move.

---

## Inference contract

The web app uses [apps/web/lib/maia/inference.ts](../apps/web/lib/maia/inference.ts) to call the worker. Single HTTP endpoint:

    POST {MAIA_INFERENCE_URL}/move
    Content-Type: application/json

    {
      "weightsId": "uuid",
      "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "history": [{ "uci": "e2e4", "timeMs": 1200 }],
      "temperature": 1.0
    }

Responses:

| Status    | Body                                                 | Meaning                                          |
| --------- | ---------------------------------------------------- | ------------------------------------------------ |
| 200       | `{ uci, san, probability, candidates[], latencyMs }` | move chosen                                      |
| 409       | `{ status: 'queued' \| 'training' \| 'failed' }`     | weights row not ready                            |
| 4xx / 5xx | `{ error }`                                          | transport error; web treats as `transport_error` |

The web client times out at 8 s.

## Weights storage

Per-player weights live in `maia_weights` (schema added in WS-12):

- `target_profile_id` OR `target_player_id` identifies who the bot mimics.
- `weights_url` is a Supabase Storage path (private bucket `maia-weights`).
- `status` is one of `queued | training | ready | failed | deprecated`.
- `dataset_hash` lets the training pipeline skip a re-run when the source games haven't changed.

The worker on cold start downloads the weights file by `weightsId`, caches in memory, and serves until it's evicted. Per-player weight files are small (~30 MB) so a single Cloud Run instance can cache hundreds.

## Training pipeline (operator-gated)

Until the dedicated training worker lands, the pipeline is:

1. **Pick a target** — a Chessco profile or external player with ≥ 200 games in the corpus.
2. **Build the dataset** — `pnpm --filter @chessco/workers maia:build-dataset --target <id>` (worker script, to be written) writes a `.csv` of `(fen, played_uci, time_ms)` rows from `games` + `moves`.
3. **Hash it** — SHA-256 over the dataset; compare to `maia_weights.dataset_hash`. If unchanged, skip.
4. **Dispatch training** — Cloud Run Job spec at `apps/workers/Dockerfile.maia-train` (to be authored) with the dataset URL + base model. Insert a `maia_weights` row with `status='training'`.
5. **On completion** — the training worker uploads the weights file to Supabase Storage, updates the row with `status='ready'` + `weights_url`, and sets `training_finished_at`. On failure, sets `status='failed'` + `error_text`.

Real Maia base models live in the public Maia repo. Fine-tuning takes hours on a single accelerator per spec; budget accordingly.

## Drill + sandbox UX

- `/practice/drill?reportId=…` calls `getBotMove` per drill position. Bot plays opponent's role; user practices their planned response.
- `/practice/sandbox` plays full games from start position against `maia-1500 / 1700 / 1900` (generic ladder; no fine-tuning needed for these tiers).

## Operator follow-through

1. Build + deploy the Cloud Run inference worker; set `MAIA_INFERENCE_URL` in web env.
2. Author `apps/workers/Dockerfile.maia-train` for the offline training job.
3. Wire the drill + sandbox React components — server-side endpoints are stubbed; client-side board UI is its own follow-up.
4. Auth the `maia-weights` Supabase Storage bucket so only the worker service role can read.
