/**
 * prep_summary_v1 — 3-paragraph executive summary of a prep report.
 *
 * Spec §15: Opus 4.7. Role is coach/writer/summarizer (NOT analyst). Takes
 * structured findings as input and renders them as prose; never invents
 * facts that aren't in the findings.
 */
import type { PromptDefinition } from '../types';

export interface PrepSummaryInput {
  opponentName: string;
  opponentRating: number;
  userColor: 'white' | 'black';
  findings: {
    repertoireOverview: string;
    topLeaks: Array<{ line: string; winRateAgainst: number; eval: number }>;
    avoidLines: Array<{ line: string; reason: string }>;
    styleNotes: string[];
  };
}

export interface PrepSummaryOutput {
  paragraphs: [string, string, string];
}

const SYSTEM_COACH_VOICE = `You write 3-paragraph prep summaries for tournament chess players.

Voice: direct, professional, evidence-grounded. You are a coach speaking to
the user — not an analyst. Never use words like "battle," "warrior,"
"destroy," "crush," or other chess clichés (per Chessco style §17).

Discipline: every concrete claim must trace to a finding in the input. If a
finding isn't present, you do not mention it. Do not speculate about the
opponent's psychology beyond what the style notes support.

Format: three paragraphs, no headings, no bullet points. Plain text only.
Paragraph 1 = repertoire snapshot. Paragraph 2 = top exploitable leaks.
Paragraph 3 = lines to avoid + one-line recommendation.`;

const SYSTEM_OUTPUT_CONTRACT = `Return exactly three paragraphs separated by
blank lines. No preamble. No JSON. No trailing commentary.`;

function buildUserMessage(input: PrepSummaryInput): string {
  const leaks = input.findings.topLeaks
    .map(
      (l) =>
        `  - ${l.line} (win rate ${(l.winRateAgainst * 100).toFixed(0)}%, eval ${l.eval >= 0 ? '+' : ''}${l.eval.toFixed(2)})`,
    )
    .join('\n');
  const avoids = input.findings.avoidLines.map((a) => `  - ${a.line}: ${a.reason}`).join('\n');
  const styles = input.findings.styleNotes.map((s) => `  - ${s}`).join('\n');
  return [
    `Opponent: ${input.opponentName} (~${input.opponentRating})`,
    `You play: ${input.userColor}`,
    '',
    'Repertoire overview:',
    input.findings.repertoireOverview,
    '',
    'Top leaks:',
    leaks || '  (none surfaced)',
    '',
    'Lines to avoid:',
    avoids || '  (none surfaced)',
    '',
    'Style notes:',
    styles || '  (none surfaced)',
  ].join('\n');
}

function parseResponse(raw: string): PrepSummaryOutput {
  const trimmed = raw.trim();
  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length < 3) {
    throw new Error(
      `prep_summary_v1: expected 3 paragraphs, got ${paragraphs.length}. Raw output: ${trimmed.slice(0, 200)}…`,
    );
  }
  // Use the first three paragraphs; the model is instructed to emit
  // exactly three but tolerate trailing whitespace.
  return { paragraphs: [paragraphs[0]!, paragraphs[1]!, paragraphs[2]!] };
}

export const prepSummaryPrompt: PromptDefinition<PrepSummaryInput, PrepSummaryOutput> = {
  id: 'prep_summary_v1',
  version: '1.0.0',
  model: 'claude-opus-4-7',
  description:
    'Three-paragraph executive summary of a prep report (coach voice, evidence-grounded).',
  system: [
    { label: 'coach-voice', text: SYSTEM_COACH_VOICE, cached: true },
    { label: 'output-contract', text: SYSTEM_OUTPUT_CONTRACT, cached: true },
  ],
  params: { maxTokens: 800, temperature: 0.4 },
  buildUserMessage,
  parseResponse,
};
