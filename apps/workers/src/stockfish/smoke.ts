/**
 * Smoke test: spawn Stockfish-WASM as a node subprocess, drive it via UCI
 * over stdin/stdout. Much simpler than the in-process Emscripten module —
 * and matches how we'll talk to a native Stockfish binary in Cloud Run.
 *
 *   pnpm --filter @chessco/workers exec tsx src/stockfish/smoke.ts
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function resolveEngineJs(
  variant: 'lite-single' | 'single' | 'lite' | 'full' = 'lite-single',
): string {
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(require.resolve('stockfish/package.json'));
  const fileMap = {
    'lite-single': 'stockfish-18-lite-single.js',
    single: 'stockfish-18-single.js',
    lite: 'stockfish-18-lite.js',
    full: 'stockfish-18.js',
  };
  return join(pkgRoot, 'bin', fileMap[variant]);
}

async function main() {
  const enginePath = resolveEngineJs('lite-single');
  console.log(`[smoke] engine: ${enginePath}`);

  const proc = spawn(process.execPath, [enginePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderrChunks: string[] = [];
  proc.stderr.on('data', (b) => stderrChunks.push(b.toString('utf8')));
  proc.on('error', (e) => console.error('[smoke] spawn error:', e));

  const lines: string[] = [];
  let buf = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    while (true) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.length > 0) lines.push(line);
    }
  });

  function send(cmd: string): void {
    proc.stdin.write(cmd + '\n');
  }

  function waitFor(pred: (line: string) => boolean, timeoutMs = 30_000): Promise<string[]> {
    const start = lines.length;
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const tail = lines.slice(start);
        if (tail.some(pred)) return resolve(tail);
        if (Date.now() > deadline) {
          return reject(new Error(`timeout waiting; last lines: ${tail.slice(-3).join(' | ')}`));
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  send('uci');
  await waitFor((l) => l === 'uciok');
  console.log('[smoke] uciok received.');

  send('isready');
  await waitFor((l) => l === 'readyok');
  console.log('[smoke] readyok received.');

  send(`position fen ${STARTPOS}`);
  const t0 = Date.now();
  send('go depth 12');
  const goLines = await waitFor((l) => l.startsWith('bestmove '));
  const dt = Date.now() - t0;

  const bestmove = goLines.find((l) => l.startsWith('bestmove '));
  const lastInfo = [...goLines]
    .reverse()
    .find((l) => l.startsWith('info ') && / score cp /.test(l));
  const cpMatch = lastInfo?.match(/score cp (-?\d+)/);
  const cp = cpMatch ? parseInt(cpMatch[1]!, 10) : null;

  console.log(`[smoke] depth=12 from startpos: best=${bestmove}, score cp=${cp}, ${dt}ms`);

  send('quit');
  await new Promise<void>((r) => proc.on('close', () => r()));
  if (stderrChunks.length > 0) console.log('[smoke] stderr:', stderrChunks.join(''));
  console.log('[smoke] DONE.');
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
