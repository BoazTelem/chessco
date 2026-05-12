/**
 * Compute a signed 64-bit hash of a FEN string suitable for the
 * positions.fen_hash bigint column.
 *
 * FNV-1a (64-bit) for speed — collisions across ~10M unique positions are
 * negligible (~5e-12 birthday probability). UNIQUE (fen) on positions table
 * catches any real-world collision anyway; fen_hash is purely an
 * acceleration index.
 *
 * Returns a bigint (signed) in the Postgres bigint range.
 */
export function fenHash(fen: string): bigint {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;

  let hash = FNV_OFFSET;
  for (let i = 0; i < fen.length; i++) {
    hash ^= BigInt(fen.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }

  // Convert unsigned 64-bit to signed (Postgres bigint is signed).
  return hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
}
