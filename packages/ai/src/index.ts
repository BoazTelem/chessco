// Versioned DeepSeek prompt library + helpers.
//
// Spec §15: every prompt is a coach/writer/summarizer — never an analyst.
// Structured findings are the source of truth; prompts render them as prose
// without inventing facts. All prompts route through DeepSeek's
// OpenAI-compatible chat-completions API. The provider's automatic
// server-side cache (reported via prompt_cache_hit_tokens / _miss_tokens)
// is surfaced through CacheTelemetry; we do not control breakpoints.

export const promptLibraryVersion = '1.1.0' as const;

export type {
  DeepseekModel,
  PromptId,
  PromptResult,
  PromptRunOptions,
  InspectedPrompt,
} from './types';
export type { PromptIO } from './registry';
export type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  DeepseekClient,
} from './client';

export { runPrompt, inspectPrompt } from './run-prompt';
export { listPromptIds, getPromptDefinition, PROMPT_REGISTRY } from './registry';
export { setDeepseekClient, getDeepseekClient } from './client';

// Model-name map per spec §15. Defaults are deepseek-chat (cheap + fast);
// escalate prep_summary / risk_paragraphs via runPrompt's modelOverride
// to deepseek-reasoner when narrative quality matters more than latency.
export const DEFAULT_MODELS = {
  prepSummary: 'deepseek-chat',
  riskParagraphs: 'deepseek-chat',
  evidenceProse: 'deepseek-chat',
  styleFingerprint: 'deepseek-chat',
  helpChat: 'deepseek-chat',
} as const;
