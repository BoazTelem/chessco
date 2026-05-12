/**
 * Streaming SAX parser for the FIDE XML rating list.
 *
 * Yields one parsed record per `<player>` element. Memory footprint stays
 * constant regardless of file size (we never accumulate the document).
 */
import sax from 'sax';
import { normalizeName, parseBirthYear, pickBestTitle } from './normalize.js';

export type ParsedFidePlayer = {
  fideid: string;
  name: string;
  nameNormalized: string;
  country: string | null;
  gender: 'M' | 'F' | null;
  title: string | null;
  rating: number | null;
  games: number | null;
  k: number | null;
  birthYear: number | null;
  raw: Record<string, string>;
};

/**
 * Stream-parse a FIDE XML file. Calls `onPlayer` for each `<player>` element.
 * Returns when the stream ends.
 */
export async function parseFideStream(
  input: NodeJS.ReadableStream,
  onPlayer: (player: ParsedFidePlayer) => Promise<void> | void,
  opts: { maxPlayers?: number; onError?: (err: Error) => void } = {},
): Promise<{ parsed: number; errors: number }> {
  const parser = sax.createStream(true, { trim: true, lowercase: true });
  let current: Record<string, string> | null = null;
  let currentField: string | null = null;
  let buffer = '';
  let parsed = 0;
  let errors = 0;
  let stopped = false;

  return new Promise((resolve, reject) => {
    parser.on('opentag', (node) => {
      if (stopped) return;
      const name = node.name.toLowerCase();
      if (name === 'player') {
        current = {};
        currentField = null;
        return;
      }
      if (current) {
        currentField = name;
        buffer = '';
      }
    });

    parser.on('text', (text) => {
      if (current && currentField) buffer += text;
    });

    parser.on('cdata', (text) => {
      if (current && currentField) buffer += text;
    });

    parser.on('closetag', async (name) => {
      const tag = name.toLowerCase();
      if (current && currentField && tag === currentField) {
        current[currentField] = buffer.trim();
        currentField = null;
        buffer = '';
        return;
      }
      if (current && tag === 'player') {
        const raw = current;
        current = null;
        try {
          const player = toPlayer(raw);
          if (player) {
            await onPlayer(player);
            parsed++;
            if (opts.maxPlayers && parsed >= opts.maxPlayers) {
              stopped = true;
              parser.removeAllListeners();
              input.removeAllListeners();
              if ('destroy' in input && typeof input.destroy === 'function') {
                (input.destroy as () => void)();
              }
              resolve({ parsed, errors });
            }
          }
        } catch (e) {
          errors++;
          opts.onError?.(e as Error);
        }
      }
    });

    parser.on('error', (err) => {
      errors++;
      opts.onError?.(err);
      // Recover from minor parse errors — log and continue.
      // sax exposes the underlying parser via _parser; reset its error.
      const innerParser = (
        parser as unknown as { _parser: { error: Error | null; resume: () => void } }
      )._parser;
      innerParser.error = null;
      innerParser.resume();
    });

    parser.on('end', () => {
      if (!stopped) resolve({ parsed, errors });
    });

    input.on('error', reject);
    input.pipe(parser);
  });
}

function toPlayer(raw: Record<string, string>): ParsedFidePlayer | null {
  const fideid = raw.fideid?.trim();
  const name = raw.name?.trim();
  if (!fideid || !name || !/^\d+$/.test(fideid)) {
    return null;
  }

  const title = pickBestTitle([raw.title, raw.w_title, raw.o_title, raw.foa_title]);
  const sex = raw.sex?.toUpperCase();
  const gender: 'M' | 'F' | null = sex === 'M' || sex === 'F' ? sex : null;
  const rating = raw.rating ? parseInt(raw.rating, 10) : null;
  const games = raw.games ? parseInt(raw.games, 10) : null;
  const k = raw.k ? parseInt(raw.k, 10) : null;

  return {
    fideid,
    name,
    nameNormalized: normalizeName(name),
    country: raw.country?.trim().toUpperCase() || null,
    gender,
    title,
    rating: Number.isFinite(rating) ? rating : null,
    games: Number.isFinite(games) ? games : null,
    k: Number.isFinite(k) ? k : null,
    birthYear: parseBirthYear(raw.birthday),
    raw,
  };
}
