# Maia deployment plan (v0)

Phased plan to ship the Maia-powered practice surfaces on Chessco. Sister
doc to [MAIA-INFERENCE.md](./MAIA-INFERENCE.md), which is the HTTP
contract; this doc is "how to actually get a service up that satisfies
the contract."

---

## Phasing

| Phase | Scope                                    | What ships to users                                                               | Cost rough                              |
| ----- | ---------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| **A** | Generic Maia ladder (1500 / 1700 / 1900) | `/practice/drill` + `/practice/sandbox` work against a fixed-skill human-like bot | ~$10–25/mo (Cloud Run, min-instances=1) |
| **B** | Per-player fine-tuned weights            | `/prepare/otb` works against a bot trained on the actual opponent's games         | ~$30–80/mo + per-training-run GPU cost  |

Phase A is a 1–2 day task. Phase B is days+ (training pipeline, GPU jobs,
weights storage). **Ship A first**, see whether users engage with
human-like-bot practice, then invest in B.

This doc fully specs Phase A. Phase B has a stub at the bottom — flesh
out when A's metrics justify it.

---

## License compliance (one-time setup, applies to both phases)

Maia is GPL-3.0 (built on Leela Chess Zero, also GPL-3.0). Running it as
a separate HTTP service that the web app calls is **not GPL distribution**
— same pattern as every other commercial chess product using Stockfish.

Required compliance:

- Acknowledgement page (e.g. `/about/credits` or footer link): "Practice
  opponents powered by [Maia](https://maiachess.com/) ([CSSLab @ U Toronto](https://github.com/CSSLab/maia-chess), GPL-3.0) and [Leela Chess Zero](https://lczero.org/) (GPL-3.0)."
- Subprocessor list in [docs/legal/privacy.md](./legal/privacy.md): add the Maia/lc0 inference service (self-hosted), describe data flow (board positions only — no PII).
- **Do not** bundle weights into the web bundle, into PGNs, into a desktop/mobile app, or into any artifact the user receives. Only the rendered move output (UCI string + probability) crosses the network boundary.
- If you modify the Maia inference code itself, those modifications must be available under GPL-3.0. The thin HTTP wrapper around lc0 is yours; publish it as GPL-3.0 to be safe (or as a separate repo whose only GPL component is the linkage to lc0).

---

## Phase A architecture

```
Browser
  │
  ▼
Vercel (Next.js)
  │  POST /api/practice/maia/move
  │  body: { weightsId, fen, history, temperature }
  ▼
Cloud Run service: chessco-maia-inference  (this doc covers building + deploying)
  │
  │  lc0 child process per rating bucket (1500, 1700, 1900)
  │  loaded once at startup, fed UCI commands per request
  ▼
  Returns { uci, san, probability, candidates[], latencyMs }
```

The Cloud Run service is a thin Python/FastAPI wrapper that spawns 3
`lc0` subprocesses on boot (one per ladder rating), keeps them alive,
and routes incoming `/move` requests to the right subprocess. The web
contract is already coded ([apps/web/lib/maia/inference.ts](../apps/web/lib/maia/inference.ts));
the service just needs to satisfy it.

---

## Phase A — actionable steps

### Step 1 — Pick a place for the service code

Add a new top-level directory to the chessco monorepo:

    services/maia-inference/
      main.py
      requirements.txt
      Dockerfile
      README.md
      .dockerignore

It is NOT a node workspace — keep it out of `pnpm-workspace.yaml`. CI for
this service is its own thing (the Cloud Run deploy below builds from
the `services/maia-inference/` subtree directly).

### Step 2 — Download Maia weights into the build context

CSSLab publishes the per-rating weight files at:

    https://github.com/CSSLab/maia-chess/raw/master/maia_weights/maia-{rating}.pb.gz

Available buckets: 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900
(nine files, each ~30 MB compressed).

For Phase A we expose 1500 / 1700 / 1900 (covers the common opponent
rating range; add more later if needed). Fetch them at Docker build time
(see Dockerfile below) — don't commit weight files to git.

### Step 3 — Write the inference service

`services/maia-inference/requirements.txt`:

    fastapi==0.115.5
    uvicorn[standard]==0.32.1
    python-chess==1.999

`services/maia-inference/main.py`:

```python
"""
Maia ladder inference service. Spawns one lc0 subprocess per rating
bucket on startup, keeps each one alive via stdin/stdout UCI, and routes
incoming /move requests to the right subprocess.

Contract: docs/MAIA-INFERENCE.md (the chessco repo).
"""
import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

import chess
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

LC0_BIN = os.environ.get("LC0_BIN", "/usr/local/bin/lc0")
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/opt/maia/weights")
LADDER_RATINGS = [int(r) for r in os.environ.get("LADDER_RATINGS", "1500,1700,1900").split(",")]
THINK_NODES = int(os.environ.get("THINK_NODES", "1"))  # Maia papers: 1 node = single-move policy lookup

class Engine:
    """Wrap one lc0 subprocess in UCI mode."""
    def __init__(self, weights_path: str):
        self.weights_path = weights_path
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.lock = asyncio.Lock()

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            LC0_BIN,
            f"--weights={self.weights_path}",
            "--backend=blas",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await self._cmd("uci")
        await self._wait_for("uciok")
        await self._cmd("isready")
        await self._wait_for("readyok")

    async def _cmd(self, line: str) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write((line + "\n").encode())
        await self.proc.stdin.drain()

    async def _wait_for(self, marker: str, timeout: float = 5.0) -> List[str]:
        assert self.proc and self.proc.stdout
        lines: List[str] = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout=deadline - time.monotonic())
            text = raw.decode().strip()
            lines.append(text)
            if text.startswith(marker):
                return lines
        raise TimeoutError(f"lc0 did not produce {marker!r} within {timeout}s")

    async def best_move(self, fen: str, history_uci: List[str]) -> Dict[str, object]:
        async with self.lock:
            moves = " ".join(history_uci)
            position_cmd = f"position fen {fen}" + (f" moves {moves}" if moves else "")
            await self._cmd(position_cmd)
            await self._cmd(f"go nodes {THINK_NODES}")
            t0 = time.monotonic()
            lines = await self._wait_for("bestmove", timeout=10.0)
            dt_ms = int((time.monotonic() - t0) * 1000)
            best_line = next(line for line in lines if line.startswith("bestmove"))
            uci = best_line.split()[1]
            return {"uci": uci, "latency_ms": dt_ms}

engines: Dict[int, Engine] = {}

@asynccontextmanager
async def lifespan(_: FastAPI):
    for rating in LADDER_RATINGS:
        weights_path = os.path.join(WEIGHTS_DIR, f"maia-{rating}.pb.gz")
        if not os.path.exists(weights_path):
            raise RuntimeError(f"missing Maia weights: {weights_path}")
        eng = Engine(weights_path)
        await eng.start()
        engines[rating] = eng
    yield
    for eng in engines.values():
        if eng.proc:
            eng.proc.terminate()

app = FastAPI(lifespan=lifespan)

class MoveRequest(BaseModel):
    weightsId: str  # the chessco maia_weights row UUID (we use it to look up rating below)
    fen: str
    history: List[Dict[str, object]] = Field(default_factory=list)
    temperature: float = 1.0

# Map weights row UUIDs -> ladder ratings. In Phase A we hardcode the three
# ladder-row UUIDs after seeding maia_weights (see Step 6 below). For
# Phase B this becomes a database lookup; per-player weights live in
# Supabase Storage.
WEIGHTS_ID_TO_RATING: Dict[str, int] = {
    os.environ.get("LADDER_1500_ID", ""): 1500,
    os.environ.get("LADDER_1700_ID", ""): 1700,
    os.environ.get("LADDER_1900_ID", ""): 1900,
}

@app.get("/healthz")
def healthz() -> Dict[str, object]:
    return {"ok": True, "engines": list(engines.keys())}

@app.post("/move")
async def move(req: MoveRequest) -> Dict[str, object]:
    rating = WEIGHTS_ID_TO_RATING.get(req.weightsId)
    if rating is None or rating not in engines:
        raise HTTPException(status_code=404, detail="weights_not_found")
    history_uci = [str(h["uci"]) for h in req.history if isinstance(h, dict) and "uci" in h]
    result = await engines[rating].best_move(req.fen, history_uci)
    # SAN derivation for the response (the web client wants it for the move log)
    board = chess.Board(req.fen)
    for u in history_uci:
        board.push(chess.Move.from_uci(u))
    move_obj = chess.Move.from_uci(str(result["uci"]))
    san = board.san(move_obj)
    return {
        "uci": result["uci"],
        "san": san,
        "probability": 1.0,  # lc0 in policy-only mode returns the highest-prob move; full distribution requires --multipv
        "candidates": [],
        "latencyMs": result["latency_ms"],
    }
```

### Step 4 — Dockerize

`services/maia-inference/Dockerfile`:

```dockerfile
# Two stages: (1) get lc0 + weights into a thin runtime; (2) FastAPI on top.
FROM debian:bookworm-slim AS lc0

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential ninja-build meson \
      python3 python3-pip libopenblas-dev libprotobuf-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Build lc0 from source — current stable.
RUN git clone --depth 1 --branch v0.31.2 https://github.com/LeelaChessZero/lc0.git /tmp/lc0
WORKDIR /tmp/lc0
RUN ./build.sh -Dgtest=false -Dblas=true -Dopencl=false -Dcudnn=false

RUN mkdir -p /opt/maia/weights \
 && for r in 1500 1700 1900; do \
      curl -sSL -o /opt/maia/weights/maia-${r}.pb.gz \
        https://github.com/CSSLab/maia-chess/raw/master/maia_weights/maia-${r}.pb.gz ; \
    done

# Runtime stage
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      libopenblas0 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=lc0 /tmp/lc0/build/release/lc0 /usr/local/bin/lc0
COPY --from=lc0 /opt/maia/weights /opt/maia/weights

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

ENV LC0_BIN=/usr/local/bin/lc0
ENV WEIGHTS_DIR=/opt/maia/weights
ENV LADDER_RATINGS=1500,1700,1900
ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

`services/maia-inference/.dockerignore`:

    __pycache__
    *.pyc
    .venv
    .pytest_cache

### Step 5 — Build + test locally

```powershell
cd C:\xampp\htdocs\chessco\services\maia-inference
docker build -t chessco-maia-inference .
docker run --rm -p 8080:8080 `
  -e LADDER_1500_ID=00000000-0000-0000-0000-000000001500 `
  -e LADDER_1700_ID=00000000-0000-0000-0000-000000001700 `
  -e LADDER_1900_ID=00000000-0000-0000-0000-000000001900 `
  chessco-maia-inference
```

Once the logs show "Application startup complete", smoke-test:

```powershell
curl http://localhost:8080/healthz
# Expect: {"ok":true,"engines":[1500,1700,1900]}

curl -X POST http://localhost:8080/move `
  -H "content-type: application/json" `
  -d '{\"weightsId\":\"00000000-0000-0000-0000-000000001500\",\"fen\":\"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\",\"history\":[],\"temperature\":1.0}'
# Expect: { "uci": "...", "san": "...", "probability": 1.0, "candidates": [], "latencyMs": <int> }
```

If the container OOMs at startup or the engines fail to load, bump
Docker's allocated RAM (Settings → Resources → set to 4 GB+).

### Step 6 — Seed the `maia_weights` ladder rows

The web app's call site queries `maia_weights` by id. For the Phase A
ladder, insert three rows pointing at the in-container weights. Run in
your Supabase SQL editor (or via the Supabase MCP):

```sql
-- Reuse the fixed UUIDs from Step 5's docker run so the ladder is stable
-- across container restarts.
INSERT INTO maia_weights
  (id, target_profile_id, target_player_id, base_model, version, status, weights_url, dataset_hash, training_games_count, training_started_at, training_finished_at)
VALUES
  ('00000000-0000-0000-0000-000000001500', NULL, NULL, 'maia-1500', '1.0.0', 'ready', 'embedded:in-container', 'ladder', 0, NOW(), NOW()),
  ('00000000-0000-0000-0000-000000001700', NULL, NULL, 'maia-1700', '1.0.0', 'ready', 'embedded:in-container', 'ladder', 0, NOW(), NOW()),
  ('00000000-0000-0000-0000-000000001900', NULL, NULL, 'maia-1900', '1.0.0', 'ready', 'embedded:in-container', 'ladder', 0, NOW(), NOW())
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      version = EXCLUDED.version,
      training_finished_at = NOW();
```

(Drop the ladder rows easily if you ever migrate to Supabase-Storage-backed weights: `DELETE FROM maia_weights WHERE weights_url = 'embedded:in-container';`.)

### Step 7 — Deploy to Cloud Run

```powershell
gcloud auth login
gcloud config set project YOUR_GCP_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com

cd C:\xampp\htdocs\chessco\services\maia-inference
gcloud run deploy chessco-maia-inference `
  --source . `
  --region us-central1 `
  --memory 2Gi `
  --cpu 2 `
  --concurrency 4 `
  --timeout 30 `
  --min-instances 1 `
  --max-instances 3 `
  --allow-unauthenticated `
  --set-env-vars "LADDER_1500_ID=00000000-0000-0000-0000-000000001500,LADDER_1700_ID=00000000-0000-0000-0000-000000001700,LADDER_1900_ID=00000000-0000-0000-0000-000000001900"
```

Note `--min-instances 1` — three lc0 subprocesses take ~30 s to load on
cold start; without min-instances=1 the first user request would hang
past the web client's 8-second timeout. The ~$10–15/mo it costs is the
table-stakes for shipping this feature.

Copy the printed service URL — looks like
`https://chessco-maia-inference-xxxxxx-uc.a.run.app`.

### Step 8 — Wire MAIA_INFERENCE_URL

Local (`apps/web/.env.local`):

    MAIA_INFERENCE_URL=https://chessco-maia-inference-xxxxxx-uc.a.run.app

Vercel:

    Dashboard → chessco project → Settings → Environment Variables
    Add: MAIA_INFERENCE_URL = https://chessco-maia-inference-xxxxxx-uc.a.run.app
    Scope: Production + Preview + Development
    Redeploy.

### Step 9 — Verify end-to-end

1. `/practice/sandbox` should now render an active board (no "not configured" banner).
2. Pick the 1500 ladder. Make a move. The bot should reply within ~3 s with a plausibly human-shaped move (no Stockfish-quality refutations).
3. Repeat for 1700 / 1900.
4. Check Cloud Run logs (`gcloud run services logs read chessco-maia-inference --region us-central1`) — every request should log a single line with FEN + UCI; no `bestmove` timeouts.

### Step 10 — Disclose in user-facing copy

Edit [docs/legal/privacy.md](./legal/privacy.md) to add the Maia/lc0
subprocessor disclosure. Add an acknowledgements section to the website
footer or a `/about/credits` page with the GPL-3.0 attribution.

---

## Phase B sketch — per-player fine-tuning (later)

When you decide to ship per-opponent practice:

1. **Dataset builder** — `apps/workers/src/maia/build-dataset.ts`: writes `(fen, played_uci, time_ms)` CSV from `games` + `moves` for a target profile/player.
2. **Dataset storage** — Supabase Storage bucket `maia-datasets` (service-role only).
3. **Training Dockerfile** — `services/maia-train/Dockerfile`: lc0 in train mode + the Maia training scripts ([CSSLab maia-chess training repo](https://github.com/CSSLab/maia-chess/tree/master/move_prediction)). Runs as a Cloud Run Job, not a service. Needs a GPU — Cloud Run Jobs supports L4/T4 GPUs as of 2024.
4. **Training dispatcher** — `apps/workers/src/maia/dispatch-train.ts`: when a new opponent prep is requested with ≥200 games, insert a `maia_weights` row with `status='training'`, kick off a Cloud Run Job, on completion update the row with the Supabase Storage URL of the fine-tuned weights.
5. **Inference service v2** — load weights on-demand by `weightsId`: keep an LRU cache of the most-recent ~50 sets in memory; cold-load from Supabase Storage when missing. ~30 MB per set, single instance can cache hundreds.
6. **Auth on `maia-weights` bucket** — Supabase Storage policy: read only by service role used by the inference container.

Phase B's training cost dominates: ~$2–8 per opponent for a fine-tune on a T4. Decide upfront whether this is free for paying users, metered, or only for top-tier subscribers.

---

## Open questions (decide before shipping Phase A)

1. **Acknowledgement page location** — `/about/credits` (new page) or footer link from every page?
2. **Ladder choice** — 1500/1700/1900 covers the common tournament-prep range, but for chess.com bullet players you might also want 1300/2100. Add more to `LADDER_RATINGS` env without code changes.
3. **Rate limit** — should `/move` have per-user rate limits? Today nothing prevents one logged-in user from hammering the service. Phase A is fine without limits at low scale; revisit if usage grows.
4. **Move logging** — should we persist `(weightsId, fen, uci)` tuples for debugging / future fine-tuning data? Add a `maia_move_log` table behind an env flag.
5. **Subscription gating** — free users get 5 games/day? All users unlimited? Product decision; gate in the web route, not in the service.
