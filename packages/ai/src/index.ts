// Versioned Claude prompt library + helpers.
//
// Spec §15: every prompt is a coach/writer/summarizer — never an analyst.
// Structured findings are the source of truth; prompts render them as prose
// without inventing facts. All prompts route through @anthropic-ai/sdk with
// `cache_control: { type: 'ephemeral' }` markers on stable system blocks.

export const promptLibraryVersion = '1.0.0' as const;

export type {
  ClaudeModel,
  PromptId,
  PromptResult,
  PromptRunOptions,
  InspectedPrompt,
} from './types';
export type { PromptIO } from './registry';

export { runPrompt, inspectPrompt } from './run-prompt';
export { listPromptIds, getPromptDefinition, PROMPT_REGISTRY } from './registry';
export { setAnthropicClient, getAnthropicClient } from './client';

// Backwards-compatible model-name map for callers that haven't migrated.
export const DEFAULT_MODELS = {
  prepSummary: 'claude-opus-4-7',
  riskParagraphs: 'claude-sonnet-4-6',
  evidenceProse: 'claude-haiku-4-5-20251001',
  styleFingerprint: 'claude-haiku-4-5-20251001',
  helpChat: 'claude-haiku-4-5-20251001',
} as const;
