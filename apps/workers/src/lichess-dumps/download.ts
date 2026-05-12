/**
 * Stream a Lichess monthly dump from database.lichess.org.
 *
 * Returns:
 *   - text: a Readable<string> stream of decompressed PGN, line-by-line OK
 *   - totalBytes: Content-Length header (may be undefined)
 *   - getBytesRead(): live byte counter on the compressed input
 */
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ZstdDecompressStream } from './zstd-stream';

export interface DumpStream {
  /** Readable that emits decompressed UTF-8 PGN text. */
  text: Readable;
  /** Content-Length of the .zst, when the server returned it. */
  totalBytes: number | undefined;
  /** Live counter — bytes read off the compressed wire. */
  getCompressedBytesRead(): number;
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
