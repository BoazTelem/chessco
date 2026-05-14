/**
 * Player URL slugs are derived (not stored): `${kebab(name)}-${fed}-${id}`.
 * Example: `Telem, Boaz` (FIDE 2860740) -> `telem-boaz-fide-2860740`.
 * The `[player_id]` route segment accepts either a UUID (legacy / shared
 * pre-slug links) or a slug; UUID hits 308 to the canonical slug URL.
 */

const FEDERATIONS = ['fide', 'uscf', 'ecf', 'dsb', 'fsi', 'ffe', 'icf'] as const;
type Federation = (typeof FEDERATIONS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_TAIL_RE = new RegExp(`-(${FEDERATIONS.join('|')})-(\\d+)$`, 'i');
const DIACRITICS_RE = /[̀-ͯ]/g;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function kebabName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(DIACRITICS_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function toPlayerSlug(p: {
  name: string;
  federation_id: string;
  federation_player_id: string;
}): string {
  return `${kebabName(p.name)}-${p.federation_id.toLowerCase()}-${p.federation_player_id}`;
}

export function parseFederationPlayerId(
  slug: string,
): { federation_id: string; federation_player_id: string } | null {
  const m = slug.match(SLUG_TAIL_RE);
  if (!m) return null;
  return {
    federation_id: (m[1] as Federation).toUpperCase(),
    federation_player_id: m[2]!,
  };
}

export function playerDisplayName(name: string): string {
  const parts = name.split(',').map((s) => s.trim());
  if (parts.length === 2 && parts[0] && parts[1]) return `${parts[1]} ${parts[0]}`;
  return name;
}
