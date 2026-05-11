// Versioned Claude prompt library + helpers.
// Phase 1 populates prep_summary_v1, evidence_v1, style_fingerprint_v1.
// All prompts must follow spec §15 discipline: coach/writer/summarizer,
// never analyst. Structured findings as source of truth.

export const promptLibraryVersion = '0.0.0' as const;

export type ClaudeModel = 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';

export const DEFAULT_MODELS = {
  prepSummary: 'claude-opus-4-7',
  riskParagraphs: 'claude-sonnet-4-6',
  evidenceProse: 'claude-haiku-4-5-20251001',
  styleFingerprint: 'claude-haiku-4-5-20251001',
  helpChat: 'claude-haiku-4-5-20251001',
} satisfies Record<string, ClaudeModel>;
