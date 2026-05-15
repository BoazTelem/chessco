/**
 * Signed 64-bit FNV-1a hash for the positions.fen_hash bigint column.
 * Mirror of apps/workers/src/lichess-dumps/fen-hash.ts — duplicated rather
 * than cross-app imported to keep the web app build self-contained
 * (matches the pattern in apps/web/lib/games-db.ts).
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

  return hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
}
