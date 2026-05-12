/**
 * Node Transform stream that decompresses zstd using fzstd (pure JS).
 *
 * Node 22.17's built-in `zlib.createZstdDecompress` returned 0 bytes on
 * Lichess monthly dumps (compressed with --long=27), so we use fzstd
 * which handles them reliably. Tradeoff: ~2-4x slower than native, but
 * the bottleneck in our pipeline is DB writes anyway.
 */
import { Decompress } from 'fzstd';
import { Transform } from 'node:stream';

export class ZstdDecompressStream extends Transform {
  private decompressor: Decompress;
  private pending: Buffer[] = [];

  constructor() {
    super();
    this.decompressor = new Decompress((chunk, isLast) => {
      // fzstd hands us Uint8Array views — copy into a Buffer so push() owns it.
      this.pending.push(Buffer.from(chunk));
      // isLast is true on the final flush callback; just signals end of stream.
      void isLast;
    });
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      this.decompressor.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        false,
      );
      for (const out of this.pending) this.push(out);
      this.pending.length = 0;
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: (err?: Error | null) => void): void {
    try {
      // Final push with isFinal=true so fzstd flushes any remainder.
      this.decompressor.push(new Uint8Array(0), true);
      for (const out of this.pending) this.push(out);
      this.pending.length = 0;
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}
