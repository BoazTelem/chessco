# chessco-maia-inference

Python/FastAPI inference service that powers `/practice/drill`,
`/practice/sandbox`, and (Phase B) `/prepare/otb` on chessco. Hosts
[Maia](https://maiachess.com/) weights via [lc0](https://lczero.org/)
in UCI mode and exposes a single `/move` endpoint.

Spec docs in the parent repo:

- HTTP contract → [docs/MAIA-INFERENCE.md](../../docs/MAIA-INFERENCE.md)
- Deployment plan → [docs/MAIA-DEPLOYMENT.md](../../docs/MAIA-DEPLOYMENT.md)
- Web client → [apps/web/lib/maia/inference.ts](../../apps/web/lib/maia/inference.ts)

## Phase A status

Ships the generic Maia ladder (1500 / 1700 / 1900). Three lc0
subprocesses are spawned at container startup; `/move` requests are
routed by `weightsId` (a UUID from the `maia_weights` table) to the
right subprocess.

Per-player fine-tuned weights (Phase B) are not implemented yet — the
weights-id-to-rating map is a static env lookup, not a Supabase
Storage download.

## Local build + run

```powershell
# from the chessco repo root
cd services\maia-inference
docker build -t chessco-maia-inference .
docker run --rm -p 8080:8080 `
  -e LADDER_1500_ID=00000000-0000-0000-0000-000000001500 `
  -e LADDER_1700_ID=00000000-0000-0000-0000-000000001700 `
  -e LADDER_1900_ID=00000000-0000-0000-0000-000000001900 `
  chessco-maia-inference
```

First boot takes ~30 s while lc0 loads three weight files. Once logs
show `Application startup complete`:

```powershell
curl http://localhost:8080/healthz
# {"ok":true,"engines":[1500,1700,1900]}

curl -X POST http://localhost:8080/move `
  -H "content-type: application/json" `
  -d '{\"weightsId\":\"00000000-0000-0000-0000-000000001500\",\"fen\":\"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\",\"history\":[],\"temperature\":1.0}'
# {"uci":"e2e4","san":"e4","probability":1.0,"candidates":[],"latencyMs":42}
```

If the container OOMs at startup: bump Docker Desktop's memory
allocation to 4 GB+ (Settings → Resources).

## Deploy to Cloud Run

See [docs/MAIA-DEPLOYMENT.md](../../docs/MAIA-DEPLOYMENT.md) Step 7 for
the full `gcloud run deploy` command. Critical flags:

- `--memory 2Gi` — three lc0 procs + their working set sit around ~1.2 GB.
- `--min-instances 1` — cold start with weights load is ~30 s; without
  this flag the web client's 8 s timeout fires before the first request
  can return.
- `--concurrency 4` — each lc0 proc is serialized by an asyncio.Lock;
  more than ~4 concurrent /move requests start queuing visibly.

## Configuration

| Env var              | Default              | Meaning                                                                           |
| -------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `LC0_BIN`            | `/usr/local/bin/lc0` | Path to the lc0 binary built in the image                                         |
| `WEIGHTS_DIR`        | `/opt/maia/weights`  | Directory containing `maia-1500.pb.gz`, `maia-1700.pb.gz`, `maia-1900.pb.gz`      |
| `LADDER_RATINGS`     | `1500,1700,1900`     | Which buckets to spawn lc0 subprocesses for. Each adds ~400 MB resident memory    |
| `THINK_NODES`        | `1`                  | lc0 search nodes per move. **Leave at 1** — higher values defeat the Maia premise |
| `BESTMOVE_TIMEOUT_S` | `10.0`               | Per-request lc0 timeout                                                           |
| `LADDER_1500_ID`     | (required)           | UUID of the `maia_weights` row for the 1500 ladder; matches the chessco seed      |
| `LADDER_1700_ID`     | (required)           | UUID of the `maia_weights` row for the 1700 ladder                                |
| `LADDER_1900_ID`     | (required)           | UUID of the `maia_weights` row for the 1900 ladder                                |
| `PORT`               | `8080`               | uvicorn bind port                                                                 |

## License

This wrapper (`main.py`, `Dockerfile`, etc.) can carry any license you
choose. The lc0 binary and Maia weights bundled in the runtime image are
GPL-3.0; running them as a server-side service that responds to HTTP
requests is the SaaS-safe usage pattern. See
[docs/MAIA-DEPLOYMENT.md "License compliance"](../../docs/MAIA-DEPLOYMENT.md#license-compliance-one-time-setup-applies-to-both-phases)
for the full breakdown.
