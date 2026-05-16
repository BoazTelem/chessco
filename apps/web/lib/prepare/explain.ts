/**
 * Phase 5: LLM explainer for the Phase 4 correlation engine output.
 *
 * Takes a structured digest of (overlap top-N + drift top-N) and a
 * provider, asks the model to produce:
 *
 *   1. A 1-2 sentence headline characterizing the opponent's recent
 *      style + the most-promising prep direction
 *   2. 3 concrete lines to study, each with the move and a one-line
 *      "why" rooted in the correlation data
 *   3. Up to 3 drift callouts ("they switched from X to Y this
 *      quarter") so the user knows where lifetime stats lie
 *
 * Pure function — no DB, no fetch. Caller wires in the LLM provider
 * (apps/web/lib/scout/llm-providers.ts:getProseProvider) and handles
 * the HTTP / caching layer.
 *
 * Fail-soft: throws on API/JSON failures; the route handler catches
 * and falls back to "explainer unavailable" so the raw correlation
 * panel still renders.
 */
import type { LlmProvider } from '../scout/llm-providers';

// Mirrors the response shape of /api/prepare/correlate. Re-declared
// here to keep this module a pure leaf — the route serializes it,
// this module deserializes, no shared type-export dance.
export interface CorrelateDigest {
  me: { platform: string; handle: string };
  opp: { platform: string; handle: string };
  depth: number;
  overlapBucket: { timeBucket: string } | null;
  driftBuckets: {
    baseline: { timeBucket: string } | null;
    recent: { timeBucket: string } | null;
  };
  asWhite: DigestOverlap[];
  asBlack: DigestOverlap[];
  driftAsWhite: DigestDrift[];
  driftAsBlack: DigestDrift[];
}

interface DigestOverlap {
  yourMove: { san: string; gamesCount: number };
  theirResponses: Array<{ san: string; gamesCount: number; scoreShare: number }>;
  theirAggregate: { totalGames: number; scoreShare: number };
  opportunityScore: number;
}

interface DigestDrift {
  fenKey: string;
  allTime: {
    totalGames: number;
    scoreShare: number;
    topMove: { san: string; share: number } | null;
  };
  recent: {
    totalGames: number;
    scoreShare: number;
    topMove: { san: string; share: number } | null;
  };
  scoreDelta: number;
  topMoveChanged: boolean;
  mixDistance: number;
}

export interface ExplainLine {
  /** Short title shown as the line header, e.g. "1.e4 → Sicilian Najdorf" */
  title: string;
  /** Your specific move from the source position, as SAN. */
  yourMove: string;
  /** One-line motivation rooted in the data — gamesCount, scoreShare, etc. */
  why: string;
}

export interface ExplainResult {
  /** 1-2 sentence headline characterizing the opponent + best prep angle. */
  headline: string;
  /** Up to 3 concrete lines to study, ranked by importance. */
  lines: ExplainLine[];
  /** Up to 3 drift callouts the user should know about. */
  driftCallouts: string[];
  /** Provider + token-budget info for telemetry / cost tracking. */
  provider: string;
}

// Cap the digest fed to the model — top-N per section is enough signal
// and keeps the input under ~2k tokens (well within DeepSeek's 32k).
const MAX_OVERLAP_PER_COLOR = 8;
const MAX_DRIFT_PER_COLOR = 4;
const MAX_TOKENS = 800;

export async function generateExplanation(
  digest: CorrelateDigest,
  provider: LlmProvider,
): Promise<ExplainResult> {
  const prompt = buildPrompt(digest);
  const raw = await provider.generate({ prompt, maxTokens: MAX_TOKENS });
  const parsed = extractJsonObject(raw);
  if (!parsed) throw new Error('LLM returned unparseable JSON');

  const headline = typeof parsed.headline === 'string' ? parsed.headline : '';
  const linesRaw = Array.isArray(parsed.lines) ? parsed.lines : [];
  const lines: ExplainLine[] = linesRaw
    .slice(0, 3)
    .map((l) => {
      const obj = (l ?? {}) as Record<string, unknown>;
      return {
        title: typeof obj.title === 'string' ? obj.title : '',
        yourMove: typeof obj.yourMove === 'string' ? obj.yourMove : '',
        why: typeof obj.why === 'string' ? obj.why : '',
      };
    })
    .filter((l) => l.title && l.yourMove && l.why);
  const driftRaw = Array.isArray(parsed.driftCallouts) ? parsed.driftCallouts : [];
  const driftCallouts = driftRaw
    .slice(0, 3)
    .map((d) => (typeof d === 'string' ? d : ''))
    .filter(Boolean);

  return { headline, lines, driftCallouts, provider: provider.name };
}

function buildPrompt(digest: CorrelateDigest): string {
  const oppLabel = `${digest.opp.handle} (${digest.opp.platform})`;
  const meLabel = `${digest.me.handle} (${digest.me.platform})`;
  const bucket = digest.overlapBucket?.timeBucket ?? 'unknown window';

  const asWhite = digest.asWhite.slice(0, MAX_OVERLAP_PER_COLOR).map(summarizeOverlap);
  const asBlack = digest.asBlack.slice(0, MAX_OVERLAP_PER_COLOR).map(summarizeOverlap);
  const driftWhite = digest.driftAsWhite.slice(0, MAX_DRIFT_PER_COLOR).map(summarizeDrift);
  const driftBlack = digest.driftAsBlack.slice(0, MAX_DRIFT_PER_COLOR).map(summarizeDrift);

  return [
    `You are a chess prep coach. The user (${meLabel}) is about to play ${oppLabel}.`,
    `Based on their bucketed repertoire data below (window: ${bucket}, depth ${digest.depth}),`,
    `produce a JSON object with this exact shape:`,
    `{`,
    `  "headline": "1-2 sentence summary characterizing ${digest.opp.handle}'s recent style + the highest-leverage prep direction",`,
    `  "lines": [`,
    `    { "title": "<short opening label>", "yourMove": "<SAN from the source position>", "why": "<one line citing games count and score share>" }`,
    `  ],  // up to 3 lines, ranked by importance`,
    `  "driftCallouts": ["<one short sentence>"]  // up to 3 — only if drift data warrants it; empty array otherwise`,
    `}`,
    ``,
    `Important: only cite facts from the data below. Don't fabricate move sequences, opening names you can't infer from the moves, or statistics. Reference real opportunity scores and games counts. Prefer "the Sicilian" over guessing a specific variation if you're unsure.`,
    ``,
    `## Overlap lines — you as White (their Black responses):`,
    asWhite.length === 0 ? '(no overlap above the noise threshold)' : asWhite.join('\n'),
    ``,
    `## Overlap lines — you as Black (their White responses):`,
    asBlack.length === 0 ? '(no overlap above the noise threshold)' : asBlack.join('\n'),
    ``,
    `## Drift in their Black play (what you face as White), recent vs all_time:`,
    driftWhite.length === 0 ? '(no material drift)' : driftWhite.join('\n'),
    ``,
    `## Drift in their White play (what you face as Black), recent vs all_time:`,
    driftBlack.length === 0 ? '(no material drift)' : driftBlack.join('\n'),
    ``,
    `Return ONLY the JSON object, no preamble.`,
  ].join('\n');
}

function summarizeOverlap(o: DigestOverlap): string {
  const responses = o.theirResponses
    .slice(0, 3)
    .map((r) => `${r.san} (${r.gamesCount}g, ${(r.scoreShare * 100).toFixed(0)}%)`)
    .join(', ');
  return `- Your ${o.yourMove.san} (${o.yourMove.gamesCount} games) → they reach ${o.theirAggregate.totalGames} times scoring ${(o.theirAggregate.scoreShare * 100).toFixed(0)}%; their responses: ${responses}; opportunity=${o.opportunityScore.toFixed(1)}`;
}

function summarizeDrift(d: DigestDrift): string {
  const allTop = d.allTime.topMove?.san ?? '?';
  const recentTop = d.recent.topMove?.san ?? '?';
  const changed = d.topMoveChanged
    ? `top-move CHANGED ${allTop}→${recentTop}`
    : `top move stable: ${recentTop}`;
  const scorePart = `score: ${(d.allTime.scoreShare * 100).toFixed(0)}%→${(d.recent.scoreShare * 100).toFixed(0)}% (Δ${d.scoreDelta >= 0 ? '+' : ''}${(d.scoreDelta * 100).toFixed(0)}pp)`;
  return `- position ${d.fenKey.slice(0, 40)}…: ${changed}, ${scorePart}, mix-shift=${d.mixDistance.toFixed(2)} (${d.allTime.totalGames}g→${d.recent.totalGames}g)`;
}

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
