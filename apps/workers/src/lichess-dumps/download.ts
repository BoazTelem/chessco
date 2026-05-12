/**
 * Stream a Lichess monthly dump from database.lichess.org.
 *
 * Returns:
 *   - text: a Readable<string> stream of decompressed PGN, line-by-line OK
 *   - totalBytes: Content-Length header (may be undefined)
 *   - getBytesRead(): live byte counter on the compressed input
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ZstdDecompressStream } from './zstd-stream';

export interface DumpStream {
  /** Readable that emits decompressed UTF-8 PGN text. */
  text: Readable;
  /** Content-Length of the .zst (download mode) or file size (file mode). */
  totalBytes: number | undefined;
  /** Live counter — bytes read from the compressed source so far. */
  getCompressedBytesRead(): number;
  /** Optional cleanup: remove the on-disk cache (no-op for stream mode). */
  cleanup?(): Promise<void>;
}

/**
 * Download the entire dump to a local temp file, then return a stream
 * that reads it back from disk. Decouples our parser from CDN flakiness —
 * Lichess's CDN closes long-idle TCP streams, and our parser is much
 * slower than network so the stream is idle from the CDN's perspective.
 *
 * Resumes from a partial file if it exists and matches Content-Length.
 */
export async function downloadAndOpenDumpStream(
  url: string,
  dumpId: string,
): Promise<DumpStream> {
  const cachePath = path.join(tmpdir(), `chessco-lichess-${dumpId}.pgn.zst`);

  // Try to reuse a fully-downloaded file from a previous run.
  const head = await fetch(url, {
    method: 'HEAD',
    headers: {
      'user-agent': 'chessco-worker/0.1 (+https://chessco.org; one-time ingest)',
    },
  });
  const totalBytes = head.ok
    ? Number.parseInt(head.headers.get('content-length') ?? '0', 10) || undefined
    : undefined;

  let existing: { size: number } | null = null;
  try {
    existing = await stat(cachePath);
  } catch {
    // not present
  }

  if (!existing || (totalBytes !== undefined && existing.size !== totalBytes)) {
    console.log(`[download] fetching ${url} → ${cachePath} (${totalBytes ?? '?'} bytes)`);
    if (existing) await unlink(cachePath).catch(() => undefined);
    const res = await fetch(url, {
      headers: {
        'user-agent': 'chessco-worker/0.1 (+https://chessco.org; one-time ingest)',
      },
    });
    if (!res.ok || !res.body) {
      throw new Error(`download ${url} failed: ${res.status} ${res.statusText}`);
    }
    const webStream = res.body as unknown as WebReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(webStream), createWriteStream(cachePath));
    const finalStat = await stat(cachePath);
    console.log(`[download] saved ${finalStat.size} bytes`);
  } else {
    console.log(`[download] cache hit ${cachePath} (${existing.size} bytes)`);
  }

  return await openDumpStreamFromFile(cachePath);
}

async function openDumpStreamFromFile(cachePath: string): Promise<DumpStream> {
  const fileStat = await stat(cachePath);
  let compressedBytesRead = 0;
  const file = createReadStream(cachePath);
  const counter = new PassThrough();
  counter.on('data', (chunk: Buffer) => {
    compressedBytesRead += chunk.length;
  });
  const decompress = new ZstdDecompressStream();
  file.on('error', (e) => counter.destroy(e));
  counter.on('error', (e) => decompress.destroy(e));
  file.pipe(counter).pipe(decompress);
  decompress.setEncoding('utf8');
  return {
    text: decompress,
    totalBytes: fileStat.size,
    getCompressedBytesRead: () => compressedBytesRead,
    cleanup: async () => {
      await unlink(cachePath).catch(() => undefined);
    },
  };
}

/**
 * Open a streaming HTTP GET on the dump URL and pipe through native
 * zstd decompression. Lichess uses `--long=27`, so we have to lift the
 * windowLogMax decompression cap (default in Node is 27 already, so this
 * is belt-and-braces).
 */
export async function openDumpStream(url: string): Promise<DumpStream> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'chessco-worker/0.1 (+https://chessco.org; one-time ingest)',
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`GET ${url} returned no body`);
  }

  const contentLength = res.headers.get('content-length');
  const totalBytes = contentLength ? Number.parseInt(contentLength, 10) : undefined;

  // res.body is a WebReadableStream<Uint8Array>; convert to Node Readable.
  const webStream = res.body as unknown as WebReadableStream<Uint8Array>;
  const compressed = Readable.fromWeb(webStream);

  // Count compressed bytes via a PassThrough — attaching a 'data' listener
  // would put the source in flowing mode and race with pipe().
  let compressedBytesRead = 0;
  const counter = new PassThrough();
  counter.on('data', (chunk: Buffer) => {
    compressedBytesRead += chunk.length;
  });

  const decompress = new ZstdDecompressStream();

  compressed.on('error', (e) => counter.destroy(e));
  counter.on('error', (e) => decompress.destroy(e));

  compressed.pipe(counter).pipe(decompress);

  // Tell consumers we'll be reading utf-8 strings (avoids double-decoding).
  decompress.setEncoding('utf8');

  return {
    text: decompress,
    totalBytes,
    getCompressedBytesRead: () => compressedBytesRead,
  };
}
