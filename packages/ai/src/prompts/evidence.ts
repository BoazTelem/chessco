/**
 * evidence_v1 — one-sentence "why we think this is the right account"
 * confidence prose for the identification result card.
 *
 * Spec §15: deepseek-chat. Fast, cheap, deterministic.
 */
import type { PromptDefinition } from '../types';

export interface EvidenceInput {
  candidateHandle: string;
  candidatePlatform: 'lichess' | 'chess.com';
  confidence: 'high' | 'medium' | 'low';
  /** Up to 5 dotted reasons the matcher surfaced. */
  signals: string[];
}

export interface EvidenceOutput {
  sentence: string;
}

const SYSTEM_VOICE = `You write one-sentence confidence-grounded evidence
prose for the identification result card. Use plain English. 14–28 words.

Discipline: list 2–3 signals from the input directly. Do not add new
signals. Do not soften certainty when confidence is high. Do not hedge
beyond what the input warrants.

Forbidden words: "likely," "probably," "perhaps," "maybe" when confidence
== 'high'. Use them when confidence == 'low'. For 'medium', use "appears"
or "looks like."`;

const SYSTEM_OUTPUT_CONTRACT = `One sentence. No quotes. No preamble. No
trailing period repetition. Plain text only.`;

function buildUserMessage(input: EvidenceInput): string {
  return [
    `Candidate: ${input.candidateHandle} on ${input.candidatePlatform}`,
    `Confidence: ${input.confidence}`,
    'Signals:',
    ...input.signals.map((s) => `  - ${s}`),
  ].join('\n');
}

function parseResponse(raw: string): EvidenceOutput {
  const sentence = raw.trim().replace(/^["']|["']$/g, '');
  if (!sentence) throw new Error('evidence_v1: empty output');
  return { sentence };
}

export const evidencePrompt: PromptDefinition<EvidenceInput, EvidenceOutput> = {
  id: 'evidence_v1',
  version: '1.0.0',
  model: 'deepseek-chat',
  description: 'One-sentence evidence prose for the identification result card.',
  system: [
    { label: 'voice-rules', text: SYSTEM_VOICE, cached: true },
    { label: 'output-contract', text: SYSTEM_OUTPUT_CONTRACT, cached: true },
  ],
  params: { maxTokens: 120, temperature: 0.2 },
  buildUserMessage,
  parseResponse,
};
