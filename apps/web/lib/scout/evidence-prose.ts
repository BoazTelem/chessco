/**
 * Turns the bullet-list "reasons" we already attach to each candidate into
 * a one-sentence English explanation, via a swappable LLM provider.
 *
 *   reasons: ["fuzzy match on 'gelfand'", "name match 57%", "country matches",
 *             "rating in band"]
 *   evidence_prose: "Israeli GM whose chess.com handle 'boris-gelfand'
 *     matches the name and country, with 2504 blitz consistent with his
 *     2635 FIDE rating."
 *
 * Design:
 *   - LLM choice lives in `llm-providers.ts` (DeepSeek by default; flip
 *     SCOUT_PROSE_PROVIDER=anthropic for A/B). This file is engine-agnostic.
 *   - One batched call per identification query (15 candidates max).
 *   - Strict JSON-only output, keyed by `${platform}:${handle}` so we
 *     can map prose back to rows.
 *   - Graceful fallback: if no provider is configured or the API fails,
 *     return an empty map. The match page falls back to bullet reasons.
 *
 * Cost: ~2-3k output tokens per query × ~$0.27/M for DeepSeek-chat
 * ≈ $0.0008/query. Latency: ~1-2s. We add it after the candidates are
 * persisted with a status update, so the user can see results immediately
 * and the prose fills in on refresh.
 */
import { getProseProvider } from './llm-providers';

export interface ProseSubject {
  name: string;
  country?: string | null;
  fide_rating?: number | null;
  title?: string | null;
  via: 'name' | 'sample_game';
}

export interface ProseCandidate {
  platform: 'lichess' | 'chess.com';
  handle: string;
  confidence: number;
  country: string | null;
  title: string | null;
  ratings: {
    bullet?: number | null;
    blitz?: number | null;
    rapid?: number | null;
    classical?: number | null;
  };
  reasons: string[];
}

/** Returns a map keyed by `${platform}:${handle}` → English explanation. */
export async function generateEvidenceProse(
  subject: ProseSubject,
  candidates: ProseCandidate[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (candidates.length === 0) return out;

  const provider = getProseProvider();
  if (!provider) return out;

  const subjectLine = [
    subject.title,
    subject.name,
    subject.country ? `(${subject.country})` : null,
    subject.fide_rating ? `FIDE ${subject.fide_rating}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const lines = candidates.slice(0, 15).map((c, i) => {
    const r = c.ratings;
    const ratingStr = [
      r.bullet ? `bullet ${r.bullet}` : null,
      r.blitz ? `blitz ${r.blitz}` : null,
      r.rapid ? `rapid ${r.rapid}` : null,
      r.classical ? `classical ${r.classical}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return [
      `[${i + 1}] ${c.platform}/${c.handle}`,
      `    confidence: ${(c.confidence * 100).toFixed(0)}%`,
      c.country ? `    country: ${c.country}` : null,
      c.title ? `    title: ${c.title}` : null,
      ratingStr ? `    ratings: ${ratingStr}` : null,
      `    signals: ${c.reasons.join('; ')}`,
    ]
      .filter(Boolean)
      .join('\n');
  });

  const viaPhrase =
    subject.via === 'sample_game'
      ? 'from sample-game stylometric matching'
      : 'from name + country + rating fuzzy search';

  const prompt = `You're writing one-sentence evidence summaries for chess account match candidates.

SUBJECT: ${subjectLine || subject.name}
MATCHING METHOD: ${viaPhrase}

CANDIDATES (${candidates.length}):
${lines.join('\n')}

For each candidate, write ONE concise sentence (≤25 words) explaining why we think this might or might not be the subject's online account. Reference specific signals from the list (country, title alignment, rating-band, name vs handle similarity, etc.). Be honest about weak matches.

Return strict JSON only, in this exact shape — no prose, no markdown:
{
  "lichess/handlename": "Sentence here.",
  "chess.com/another": "Sentence here."
}

Use the exact "platform/handle" keys from the candidates above.`;

  try {
    const text = await provider.generate({ prompt, maxTokens: 2000 });
    const parsed = extractJsonObject(text);
    if (parsed) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out.set(k, v);
      }
    }
  } catch {
    // Fail-soft: return whatever we have (likely empty).
  }
  return out;
}

/** Find the first `{ ... }` block in the text and JSON.parse it.
 *  Models sometimes add a stray sentence even when asked for JSON only. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
