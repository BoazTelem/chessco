/**
 * style_fingerprint_v1 — 80–140 word style summary the radar chart sits
 * next to. Reads the player's engineered features and tells the user what
 * the radar is saying.
 *
 * Spec §15: deepseek-chat.
 */
import type { PromptDefinition } from '../types';

export interface StyleFingerprintInput {
  playerHandle: string;
  /** Per-axis features the radar renders. Values are 0..1 normalized. */
  features: {
    tacticalSharpness: number;
    positionalControl: number;
    timeAggression: number;
    endgameSkill: number;
    openingBreadth: number;
    blunderResistance: number;
  };
  /** Optional comparison: another player's same features. */
  comparison?: {
    handle: string;
    features: StyleFingerprintInput['features'];
  };
}

export interface StyleFingerprintOutput {
  prose: string;
}

const SYSTEM_VOICE = `You translate a player's engineered feature vector
into 80–140 words of plain English that match what the radar chart shows.

Reference 2–4 axes by name. Use comparison numbers when present (e.g.
"sharper than X across tactical and time-pressure axes"). Keep tone
neutral and observational — you are describing the radar, not predicting
results. Never moralize.

Banned words (style §17): "warrior," "killer," "predator," "wins big."`;

const SYSTEM_OUTPUT_CONTRACT = `One paragraph. 80–140 words. No headings, no
bullets, no JSON. Plain text only.`;

function buildUserMessage(input: StyleFingerprintInput): string {
  const f = input.features;
  const lines = [
    `Player: ${input.playerHandle}`,
    'Features (0..1):',
    `  tactical_sharpness: ${f.tacticalSharpness.toFixed(2)}`,
    `  positional_control: ${f.positionalControl.toFixed(2)}`,
    `  time_aggression: ${f.timeAggression.toFixed(2)}`,
    `  endgame_skill: ${f.endgameSkill.toFixed(2)}`,
    `  opening_breadth: ${f.openingBreadth.toFixed(2)}`,
    `  blunder_resistance: ${f.blunderResistance.toFixed(2)}`,
  ];
  if (input.comparison) {
    const c = input.comparison.features;
    lines.push(
      '',
      `Comparison player: ${input.comparison.handle}`,
      `  tactical_sharpness: ${c.tacticalSharpness.toFixed(2)}`,
      `  positional_control: ${c.positionalControl.toFixed(2)}`,
      `  time_aggression: ${c.timeAggression.toFixed(2)}`,
      `  endgame_skill: ${c.endgameSkill.toFixed(2)}`,
      `  opening_breadth: ${c.openingBreadth.toFixed(2)}`,
      `  blunder_resistance: ${c.blunderResistance.toFixed(2)}`,
    );
  }
  return lines.join('\n');
}

function parseResponse(raw: string): StyleFingerprintOutput {
  const prose = raw.trim();
  if (!prose) throw new Error('style_fingerprint_v1: empty output');
  return { prose };
}

export const styleFingerprintPrompt: PromptDefinition<
  StyleFingerprintInput,
  StyleFingerprintOutput
> = {
  id: 'style_fingerprint_v1',
  version: '1.0.0',
  model: 'deepseek-chat',
  description: '80–140 word style summary that matches the radar chart.',
  system: [
    { label: 'voice-rules', text: SYSTEM_VOICE, cached: true },
    { label: 'output-contract', text: SYSTEM_OUTPUT_CONTRACT, cached: true },
  ],
  params: { maxTokens: 250, temperature: 0.3 },
  buildUserMessage,
  parseResponse,
};
