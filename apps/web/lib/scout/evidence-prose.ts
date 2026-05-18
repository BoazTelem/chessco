/**
 * LLM rerank + verdict + per-candidate prose, in a single batched call.
 *
 * The algorithmic Stage 2/3 matcher produces a top-K ranked candidate list
 * with per-component scores. This module hands that structured evidence to
 * DeepSeek and asks it to do three things in one prompt:
 *
 *   1. **Re-rank** the candidates — synthesize the close calls the
 *      algorithm couldn't resolve (e.g. "rank #2 has perfect ECO and
 *      cp-loss match but rank #1 only wins on name; promote rank #2").
 *   2. **Render a single overall verdict** — "best_match" handle +
 *      confidence + one-paragraph reasoning. This becomes the headline
 *      banner on the match-results page.
 *   3. **Write per-candidate prose** — one English sentence per candidate
 *      explaining why they are / aren't a likely match (same as before).
 *
 * Design:
 *   - One round-trip per identification query (~$0.001 with DeepSeek-chat,
 *     ~1-2s latency). Cheaper to do all three in one prompt than three.
 *   - Fail-soft on every layer: missing API key, JSON parse failure, API
 *     error → return empty RerankResult, caller falls back to algorithmic
 *     order + bullet reasons.
 *   - Provider-agnostic via getProseProvider().
 *
 * TODO(WS-4 → Scout-Ready Pipeline Phase 5): migrate this module to use
 *   @chessco/ai's `runPrompt('evidence_v1', ...)` per-candidate (plus a
 *   batched verdict variant) so DeepSeek's automatic prompt cache kicks
 *   in on the shared coach-voice system block. Both code paths share
 *   the same DEEPSEEK_API_KEY today.
 */
import { getProseProvider } from './llm-providers';

export interface ProseSubject {
  name: string;
  country?: string | null;
  /** Hard FIDE rating from a federation_players row. Use this for
   *  federation-anchored queries; leave null for ad-hoc anchors and use
   *  `rating_estimate` instead. The LLM treats fide_rating as authoritative
   *  ("FIDE 2150") and rating_estimate as user-supplied ("you said ~2150"). */
  fide_rating?: number | null;
  /** Structured user-supplied rating estimate from an ad-hoc anchor. When
   *  set, the prompt renders this with the explicit band + provenance so
   *  the LLM can cite "you said 1900 ±100" instead of treating the
   *  midpoint as a hard FIDE number. Workstream D differentiation pillar:
   *  the LLM-narrated path explicitly references the user's input. */
  rating_estimate?: {
    value: number;
    band_half_width: number | null;
    source: 'user_estimate' | 'national_federation' | 'club' | 'self_reported';
  } | null;
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

export interface AiVerdict {
  /** "platform/handle" key of the LLM's chosen best match. */
  best_match: string;
  /** LLM's self-rated confidence in its best_match choice. */
  confidence: 'high' | 'medium' | 'low';
  /** One-paragraph English reasoning. Renders on the match page banner. */
  reasoning: string;
}

export interface RerankResult {
  /** LLM's reordering of candidates as "platform/handle" keys.
   *  Empty array when the LLM didn't return a usable order; caller keeps
   *  the algorithmic order in that case. May omit candidates the LLM
   *  judged irrelevant. */
  order: string[];
  /** Overall verdict — null if the LLM didn't return one. */
  verdict: AiVerdict | null;
  /** Per-candidate prose, keyed by "platform/handle". */
  prose: Map<string, string>;
}

/**
 * Heuristic: should we even pay for the LLM call?
 * - Skip when there are 0-1 candidates (nothing to rerank, nothing to judge).
 * - Otherwise fire — the prose is valuable on every candidate, and rerank
 *   only changes the order when the LLM disagrees with the algorithm
 *   (which is rare for runaway top-1s but always shows up as a confidence
 *   "high" verdict).
 */
export function shouldRerank(candidates: ProseCandidate[]): boolean {
  return candidates.length >= 2;
}

/** Returns an empty result. Callers fall back to algorithmic ranking + bullets. */
function emptyResult(): RerankResult {
  return { order: [], verdict: null, prose: new Map() };
}

export async function generateRerankProse(
  subject: ProseSubject,
  candidates: ProseCandidate[],
): Promise<RerankResult> {
  if (candidates.length === 0) return emptyResult();
  const provider = getProseProvider();
  if (!provider) return emptyResult();

  // Render the rating signal carefully — FIDE-anchored vs ad-hoc estimate
  // have very different epistemic weight, and the LLM should cite each
  // honestly. FIDE: "FIDE 2150". user_estimate with band: "user estimate
  // ~1900 (±100)". user_estimate without band: "user estimate ~1900".
  // Federation/club/self_reported sources get their own label so the LLM
  // doesn't conflate them with hand-typed values.
  const ratingLabel = renderRatingLabel(subject);
  const subjectLine = [
    subject.title,
    subject.name,
    subject.country ? `(${subject.country})` : null,
    ratingLabel,
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
      `    algorithmic_confidence: ${(c.confidence * 100).toFixed(0)}%`,
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
      ? 'from sample-game stylometric matching (opening repertoire + play quality)'
      : 'from name + country + rating fuzzy search';

  const ratingGuidance = subject.rating_estimate
    ? `- The subject's rating is a USER-SUPPLIED ESTIMATE${
        subject.rating_estimate.band_half_width != null
          ? ` with explicit band ±${subject.rating_estimate.band_half_width}`
          : ''
      }, not an authoritative FIDE rating. When citing it in prose, reference it as "you said ~${subject.rating_estimate.value}${
        subject.rating_estimate.band_half_width != null
          ? ` ±${subject.rating_estimate.band_half_width}`
          : ''
      }" — never as "FIDE ${subject.rating_estimate.value}". An online rating inside the band is a positive signal but softer than a FIDE match would be.`
    : '';

  const transliterationGuidance = `- Names may have script variations the algorithm couldn't match. Consider whether the subject's name could appear differently across scripts/languages (e.g. "Andrejkin / Андрейкин / Andreikin" Cyrillic↔Latin transliteration; "Wang Hao / 王浩" Chinese pinyin; "Hod / חוד" Hebrew). If a candidate's claimed_name looks like a plausible transliteration of the subject's name, treat it as a strong name-match signal even when trigram similarity is moderate.`;

  const prompt = `You're judging which online chess account belongs to a known player. The algorithm has already produced ranked candidates with per-signal scores. Your job is to (a) synthesize the evidence holistically and decide the best match, (b) re-rank the candidates by your judgment, and (c) write one short English sentence per candidate explaining the verdict.

SUBJECT: ${subjectLine || subject.name}
MATCHING METHOD: ${viaPhrase}

CANDIDATES (${candidates.length}, ranked by algorithm):
${lines.join('\n')}

Reasoning guidelines:
- Strong name + country match dominates when present. ECO/opening-sequence overlap is highly identifying; cp-loss disagreement with claimed rating (e.g. claimed GM but cp-loss 100) is a red flag for fake accounts.
- The candidates are pre-sorted by algorithmic_confidence (highest first). Default to that ordering and only override it when you have a SPECIFIC structured-signal reason — a unique strong signal one candidate has that another lacks (e.g., "rank #2 has seq-W=80% while rank #1 has 0%"). Do NOT swap candidates whose algorithmic scores are within 0.05 of each other unless you can point to a concrete signal that justifies it.
- A higher percentage is always better than a lower one. Higher algorithmic_confidence means a better algorithmic match. When in doubt, trust the higher number.
- Be honest about weak matches. If nothing looks right, set verdict.confidence = "low" and explain why.
${ratingGuidance ? ratingGuidance + '\n' : ''}${transliterationGuidance}
- Per-candidate prose: for the top match, explain why it IS them. For other candidates, write "why this isn't them" — the specific disqualifying signal (rating gap too large, country mismatch, claimed_name resolves to a different FIDE player, etc.). One sentence each, ≤25 words.

Return STRICT JSON in this exact shape — no prose outside the JSON, no markdown:

{
  "verdict": {
    "best_match": "<platform>/<handle>",
    "confidence": "high" | "medium" | "low",
    "reasoning": "One paragraph synthesizing why this is the best match (or why no match is confident). When the subject has a user-supplied estimate, cite it as 'you said' rather than 'FIDE'."
  },
  "order": ["<platform>/<handle>", "<platform>/<handle>", ...],
  "prose": {
    "<platform>/<handle>": "One concise sentence (≤25 words) explaining this candidate.",
    "<platform>/<handle>": "..."
  }
}

Use the exact "platform/handle" keys from the candidates list above. Order must include every candidate, best first. Prose must include one entry per candidate.`;

  try {
    const text = await provider.generate({ prompt, maxTokens: 2500 });
    const parsed = extractJsonObject(text);
    if (!parsed) return emptyResult();

    const out = emptyResult();

    // Prose extraction
    const proseRaw = parsed['prose'];
    if (proseRaw && typeof proseRaw === 'object') {
      for (const [k, v] of Object.entries(proseRaw as Record<string, unknown>)) {
        if (typeof v === 'string') out.prose.set(k, v);
      }
    }

    // Order extraction
    const orderRaw = parsed['order'];
    if (Array.isArray(orderRaw)) {
      const validKeys = new Set(candidates.map((c) => `${c.platform}/${c.handle}`));
      for (const o of orderRaw) {
        if (typeof o === 'string' && validKeys.has(o)) out.order.push(o);
      }
    }

    // Verdict extraction — defensive against missing fields.
    const vRaw = parsed['verdict'];
    if (vRaw && typeof vRaw === 'object') {
      const v = vRaw as Record<string, unknown>;
      const bm = v.best_match;
      const cf = v.confidence;
      const rs = v.reasoning;
      if (
        typeof bm === 'string' &&
        (cf === 'high' || cf === 'medium' || cf === 'low') &&
        typeof rs === 'string'
      ) {
        out.verdict = { best_match: bm, confidence: cf, reasoning: rs };
      }
    }

    return out;
  } catch {
    return emptyResult();
  }
}

/** Legacy wrapper for code paths that only want the prose map.
 *  New code should call `generateRerankProse` directly. */
export async function generateEvidenceProse(
  subject: ProseSubject,
  candidates: ProseCandidate[],
): Promise<Map<string, string>> {
  const result = await generateRerankProse(subject, candidates);
  return result.prose;
}

/**
 * Render the rating signal for the subject line. FIDE-anchored queries get
 * "FIDE 2150" (authoritative). Ad-hoc queries with rating_estimate get a
 * provenance-aware label so the LLM can cite the user's input honestly
 * rather than treating it as if it were a FIDE rating.
 *
 * Precedence: fide_rating wins when set (federation_players row exists);
 * rating_estimate is the fallback for ad-hoc and any future federation/
 * club/self-reported import paths.
 */
function renderRatingLabel(subject: ProseSubject): string | null {
  if (subject.fide_rating) {
    return `FIDE ${subject.fide_rating}`;
  }
  const re = subject.rating_estimate;
  if (!re) return null;
  const bandSuffix = re.band_half_width != null ? ` ±${re.band_half_width}` : '';
  switch (re.source) {
    case 'user_estimate':
      return `user-supplied estimate ~${re.value}${bandSuffix}`;
    case 'national_federation':
      return `national-federation rating ${re.value}${bandSuffix}`;
    case 'club':
      return `club rating ${re.value}${bandSuffix}`;
    case 'self_reported':
      return `self-reported rating ${re.value}${bandSuffix}`;
  }
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
