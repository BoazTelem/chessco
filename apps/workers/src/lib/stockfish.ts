/**
 * Thin UCI wrapper around a long-running Stockfish subprocess.
 *
 * Single-threaded lite-wasm via `node bin/stockfish-18-lite-single.js`.
 * The native Cloud Run binary (later) speaks the same UCI protocol over
 * the same stdio interface, so this wrapper survives the swap.
 *
 * Usage:
 *   const sf = await StockfishEngine.start();
 *   const e = await sf.evalPosition(fen, 12);   // { cp: 37, mate: null }
 *   ...
 *   await sf.quit();
 *
 * The wrapper keeps ONE in-flight `go` command at a time — UCI is stateful
 * and `position`/`go` interleave badly. Concurrency is achieved by
 * spawning multiple StockfishEngine instances.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SfVariant = 'lite-single' | 'single' | 'lite' | 'full';

export interface StartOptions {
  /** WASM variant to use when no native binary is configured. */
  variant?: SfVariant;
  /** Explicit path to a native Stockfish binary. Overrides env + auto-detect. */
  nativeBinaryPath?: string;
}

export interface PositionEval {
  /** Centipawns from side-to-move POV. null if mate-only. */
  cp: number | null;
  /** Mate-in-N (positive = side to move mates; negative = side to move is mated). null if not a forced mate. */
  mate: number | null;
}

const VARIANT_FILES: Record<SfVariant, string> = {
  'lite-single': 'stockfish-18-lite-single.js',
  single: 'stockfish-18-single.js',
  lite: 'stockfish-18-lite.js',
  full: 'stockfish-18.js',
};

function resolveEngineJs(variant: SfVariant): string {
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(require.resolve('stockfish/package.json'));
  return join(pkgRoot, 'bin', VARIANT_FILES[variant]);
}

/**
 * Look for a native Stockfish binary, in order:
 *   1. Explicit `nativeBinaryPath` option
 *   2. STOCKFISH_BIN env var (absolute path)
 *   3. apps/workers/vendor/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe
 *      (the vendored Win64 binary that scripts/fetch-stockfish.ps1 drops)
 *   4. `stockfish` on PATH (Linux/Mac dev installs)
 *
 * Returns null if no native binary is found — caller falls back to WASM.
 */
function resolveNativeBinary(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  const fromEnv = process.env.STOCKFISH_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // apps/workers/vendor/stockfish/stockfish/stockfish-windows-x86-64-avx2.exe
  // relative to this lib file's location at apps/workers/src/lib/stockfish.ts
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'vendor', 'stockfish', 'stockfish', 'stockfish-windows-x86-64-avx2.exe'),
    join(here, '..', '..', 'vendor', 'stockfish', 'stockfish', 'stockfish'),
    join(here, '..', '..', 'vendor', 'stockfish', 'stockfish-windows-x86-64-avx2.exe'),
    join(here, '..', '..', 'vendor', 'stockfish', 'stockfish'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export class StockfishEngine {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private listeners: Array<(line: string) => void> = [];
  private closed = false;

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.on('close', () => {
      this.closed = true;
    });
    proc.on('error', (e) => {
      this.closed = true;
      // Surface engine death to anyone awaiting a line.
      for (const l of this.listeners) l(`__engine_error__:${e.message}`);
    });
  }

  /**
   * Start a Stockfish engine. Prefers a native binary (5-10x faster than
   * WASM) when one is available; otherwise spawns the bundled WASM build
   * under Node. The UCI protocol is identical either way so callers don't
   * need to know which they got.
   *
   * Pass `start()` or `start({ variant: 'lite-single' })` for the legacy
   * WASM-explicit call shape. Pass `start({ nativeBinaryPath })` to force
   * a specific binary path.
   */
  static async start(opts: StartOptions | SfVariant = {}): Promise<StockfishEngine> {
    const options: StartOptions = typeof opts === 'string' ? { variant: opts } : opts;
    const variant = options.variant ?? 'lite-single';
    const native = resolveNativeBinary(options.nativeBinaryPath);

    let proc: ChildProcessWithoutNullStreams;
    if (native) {
      proc = spawn(native, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      const enginePath = resolveEngineJs(variant);
      proc = spawn(process.execPath, [enginePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    }

    const engine = new StockfishEngine(proc);
    await engine.send('uci', (l) => l === 'uciok');
    await engine.send('isready', (l) => l === 'readyok');
    return engine;
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    while (true) {
      const i = this.buf.indexOf('\n');
      if (i < 0) break;
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line.length === 0) continue;
      for (const l of this.listeners) l(line);
    }
  }

  /** Send a UCI command and resolve when `predicate` matches a line. */
  private async send(
    cmd: string,
    predicate: (line: string) => boolean,
    timeoutMs = 60_000,
  ): Promise<string[]> {
    if (this.closed) throw new Error('engine closed');
    const captured: string[] = [];
    return new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        captured.push(line);
        if (line.startsWith('__engine_error__:')) {
          this.listeners = this.listeners.filter((l) => l !== onLine);
          clearTimeout(timer);
          reject(new Error(line));
          return;
        }
        if (predicate(line)) {
          this.listeners = this.listeners.filter((l) => l !== onLine);
          clearTimeout(timer);
          resolve(captured);
        }
      };
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== onLine);
        reject(new Error(`stockfish timeout after ${timeoutMs}ms on: ${cmd}`));
      }, timeoutMs);
      this.listeners.push(onLine);
      this.proc.stdin.write(cmd + '\n');
    });
  }

  async evalPosition(fen: string, depth: number): Promise<PositionEval> {
    // `position fen` fully resets the board, so we don't need `ucinewgame`
    // between calls — the hash table can leak across unrelated positions but
    // that only affects timing (warm cache), never the eval. Earlier code
    // round-tripped ucinewgame + isready which silently burned 1s per call
    // (ucinewgame emits nothing, so the predicate waited for the timeout).
    this.proc.stdin.write(`position fen ${fen}\n`);
    const lines = await this.send(`go depth ${depth}`, (l) => l.startsWith('bestmove '));

    // Find the LAST info line that has a score — Stockfish prints info at every
    // iteration; the deepest one is the most accurate.
    let cp: number | null = null;
    let mate: number | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i]!;
      if (!ln.startsWith('info ') || !/ score /.test(ln)) continue;
      const cpM = ln.match(/score cp (-?\d+)/);
      const mateM = ln.match(/score mate (-?\d+)/);
      if (cpM) cp = parseInt(cpM[1]!, 10);
      if (mateM) mate = parseInt(mateM[1]!, 10);
      break;
    }
    return { cp, mate };
  }

  async quit(): Promise<void> {
    if (this.closed) return;
    this.proc.stdin.write('quit\n');
    await new Promise<void>((r) => this.proc.on('close', () => r()));
  }
}

/**
 * Coerce a UCI score to a single signed centipawn value for arithmetic.
 * Mate-in-N is treated as ±(10000 - |N|) so cp_loss math is well-defined.
 * null mate AND null cp returns null (caller skips the ply).
 */
export function scoreToCp(e: PositionEval): number | null {
  if (e.mate != null) {
    const sign = e.mate >= 0 ? 1 : -1;
    return sign * (10_000 - Math.min(Math.abs(e.mate), 9_999));
  }
  return e.cp;
}
