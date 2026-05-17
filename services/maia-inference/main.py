"""
Maia ladder inference service. Spawns one lc0 subprocess per rating
bucket on startup, keeps each one alive via stdin/stdout UCI, and routes
incoming /move requests to the right subprocess.

Contract: docs/MAIA-INFERENCE.md (chessco repo).
Deployment plan: docs/MAIA-DEPLOYMENT.md (chessco repo).

License note: this file (the HTTP wrapper) can be whatever license you
prefer — it does not statically link with lc0 or Maia. lc0 (GPL-3.0) and
Maia weights (GPL-3.0) are loaded as a child process at runtime, which
is the SaaS-safe pattern. See docs/MAIA-DEPLOYMENT.md "License
compliance".
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

import chess
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

LC0_BIN = os.environ.get("LC0_BIN", "/usr/local/bin/lc0")
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/opt/maia/weights")
LADDER_RATINGS = [int(r) for r in os.environ.get("LADDER_RATINGS", "1500,1700,1900").split(",")]
# Maia's design uses raw policy output (1 node = single forward pass + softmax).
# Bumping nodes past 1 lets lc0 search past the policy head and produce
# stronger-than-human moves — defeats the purpose of Maia.
THINK_NODES = int(os.environ.get("THINK_NODES", "1"))
# Per-request timeout for lc0's `bestmove` reply. lc0 with 1-node search
# should respond in <100ms; 10s is a generous ceiling for startup warmup.
BESTMOVE_TIMEOUT_S = float(os.environ.get("BESTMOVE_TIMEOUT_S", "10.0"))


class Engine:
    """One lc0 subprocess in UCI mode, serialized by an asyncio.Lock so
    concurrent /move requests don't interleave UCI commands on the same
    process."""

    def __init__(self, weights_path: str) -> None:
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
        await self._wait_for("uciok", timeout=30.0)
        await self._cmd("isready")
        await self._wait_for("readyok", timeout=10.0)

    async def _cmd(self, line: str) -> None:
        assert self.proc is not None and self.proc.stdin is not None
        self.proc.stdin.write((line + "\n").encode())
        await self.proc.stdin.drain()

    async def _wait_for(self, marker: str, timeout: float) -> List[str]:
        assert self.proc is not None and self.proc.stdout is not None
        lines: List[str] = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"lc0 did not produce {marker!r} within {timeout}s")
            raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout=remaining)
            text = raw.decode().strip()
            lines.append(text)
            if text.startswith(marker):
                return lines

    async def best_move(self, fen: str, history_uci: List[str]) -> Dict[str, object]:
        async with self.lock:
            moves = " ".join(history_uci)
            position_cmd = f"position fen {fen}" + (f" moves {moves}" if moves else "")
            await self._cmd(position_cmd)
            await self._cmd(f"go nodes {THINK_NODES}")
            t0 = time.monotonic()
            lines = await self._wait_for("bestmove", timeout=BESTMOVE_TIMEOUT_S)
            dt_ms = int((time.monotonic() - t0) * 1000)
            best_line = next(line for line in lines if line.startswith("bestmove"))
            parts = best_line.split()
            if len(parts) < 2:
                raise RuntimeError(f"malformed bestmove line: {best_line!r}")
            uci = parts[1]
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


app = FastAPI(lifespan=lifespan, title="chessco-maia-inference")


class HistoryItem(BaseModel):
    uci: str
    timeMs: Optional[int] = None


class MoveRequest(BaseModel):
    # UUID of the maia_weights row. For Phase A's ladder, three fixed UUIDs
    # are mapped to the three Maia ratings via env vars below.
    weightsId: str
    fen: str
    history: List[HistoryItem] = Field(default_factory=list)
    temperature: float = 1.0


# Map weights row UUIDs -> ladder rating. The chessco repo seeds three rows
# in maia_weights with fixed UUIDs; we read those same UUIDs from env at
# boot so a redeploy doesn't break the lookup. Phase B will replace this
# static map with a Supabase Storage download keyed on weightsId.
WEIGHTS_ID_TO_RATING: Dict[str, int] = {
    rid: rating
    for rid, rating in (
        (os.environ.get("LADDER_1500_ID", ""), 1500),
        (os.environ.get("LADDER_1700_ID", ""), 1700),
        (os.environ.get("LADDER_1900_ID", ""), 1900),
    )
    if rid
}


@app.get("/healthz")
def healthz() -> Dict[str, object]:
    return {"ok": True, "engines": sorted(engines.keys())}


@app.post("/move")
async def move(req: MoveRequest) -> Dict[str, object]:
    rating = WEIGHTS_ID_TO_RATING.get(req.weightsId)
    if rating is None or rating not in engines:
        raise HTTPException(status_code=404, detail="weights_not_found")
    history_uci = [h.uci for h in req.history]

    # Validate FEN + history before handing to lc0 — fail fast with 400
    # instead of letting lc0 emit a malformed UCI line.
    try:
        board = chess.Board(req.fen)
        for u in history_uci:
            board.push(chess.Move.from_uci(u))
    except (ValueError, AssertionError) as err:
        raise HTTPException(status_code=400, detail=f"invalid position: {err}") from err

    result = await engines[rating].best_move(req.fen, history_uci)
    uci = str(result["uci"])

    try:
        move_obj = chess.Move.from_uci(uci)
        san = board.san(move_obj)
    except (ValueError, AssertionError):
        # lc0 returned a UCI we can't replay (shouldn't happen with a
        # valid FEN, but be defensive — return UCI without SAN rather
        # than 500ing the request).
        san = uci

    return {
        "uci": uci,
        "san": san,
        # lc0 in single-node mode returns the highest-probability policy
        # move with no scalar probability exposed via UCI. The web client
        # treats this as a hint, not a hard signal — we return 1.0 to
        # mean "this is the move Maia would play". A future version can
        # add --multipv N and parse the per-move policy if the UI needs
        # it.
        "probability": 1.0,
        "candidates": [],
        "latencyMs": result["latency_ms"],
    }
