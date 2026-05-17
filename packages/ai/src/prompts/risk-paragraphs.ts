/**
 * risk_paragraphs_v1 — short coaching paragraphs that flag the specific
 * risks the user faces in each leak line.
 *
 * Spec §15: Sonnet 4.6. One paragraph per leak, plain text.
 */
import type { PromptDefinition } from '../types';

export interface RiskParagraphsInput {
  userColor: 'white' | 'black';
  leaks: Array<{
    line: string;
    /** Position the leak occurs at, in FEN. */
    fen: string;
    /** What the opponent's stats look like at this position. */
    opponentStats: { winRateAgainst: number; sampleSize: number };
    /** The user's recommended response and its engine eval. */
    response: { uci: string; san: string; eval: number };
  }>;
}

export interface RiskParagraphsOutput {
  paragraphs: string[];
}

const SYSTEM_VOICE = `You write short coaching paragraphs that flag what the
user must remember when playing a prepared leak line.

Voice: practical, calm. One paragraph per leak. 40–80 words. No headings,
no bullets. Reference the recommended move once and explain why the
opponent struggles at the position. Cite the win rate and sample size
verbatim so the user trusts the source. Never moralize or hype.

Banned vocabulary (Chessco style §17): "battle," "warrior," "crush,"
"destroy," "hammer," "smash," "annihilate."`;

const SYSTEM_OUTPUT_CONTRACT = `Emit one paragraph per leak in the input
order, separated by blank lines. No preamble. No numbering. No JSON.`;

function buildUserMessage(input: RiskParagraphsInput): string {
  const leakBlocks = input.leaks.map((leak, i) => {
    return [
      `Leak ${i + 1}:`,
      `  line: ${leak.line}`,
      `  fen: ${leak.fen}`,
      `  opponent wins ${(leak.opponentStats.winRateAgainst * 100).toFixed(0)}% from here (n=${leak.opponentStats.sampleSize})`,
      `  recommended: ${leak.response.san} (${leak.response.uci}), eval ${leak.response.eval >= 0 ? '+' : ''}${leak.response.eval.toFixed(2)}`,
    ].join('\n');
  });
  return [
    `You play: ${input.userColor}`,
    '',
    `Total leaks: ${input.leaks.length}`,
    '',
    ...leakBlocks,
  ].join('\n\n');
}

function parseResponse(raw: string): RiskParagraphsOutput {
  const paragraphs = raw
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) {
    throw new Error('risk_paragraphs_v1: empty output');
  }
  return { paragraphs };
}

export const riskParagraphsPrompt: PromptDefinition<RiskParagraphsInput, RiskParagraphsOutput> = {
  id: 'risk_paragraphs_v1',
  version: '1.0.0',
  model: 'claude-sonnet-4-6',
  description: 'One short coaching paragraph per leak line, evidence-grounded.',
  system: [
    { label: 'coach-voice', text: SYSTEM_VOICE, cached: true },
    { label: 'output-contract', text: SYSTEM_OUTPUT_CONTRACT, cached: true },
  ],
  params: { maxTokens: 1500, temperature: 0.4 },
  buildUserMessage,
  parseResponse,
};
