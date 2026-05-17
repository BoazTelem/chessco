/**
 * Shared types for the prompt library.
 *
 * A PromptDefinition is the static contract for a prompt:
 *   - id (stable string used by callers and B11 fixtures)
 *   - model (deepseek-chat for general; deepseek-reasoner for narrative depth)
 *   - system blocks (cached:true is metadata-only — see cache.ts)
 *   - input/output shapes
 *
 * A PromptResult bundles the parsed output plus the provider's token
 * telemetry so callers can track cost. DeepSeek reports cache_hit /
 * cache_miss token splits automatically; we surface those when present.
 */

export type DeepseekModel = 'deepseek-chat' | 'deepseek-reasoner';

export type PromptId =
  | 'prep_summary_v1'
  | 'risk_paragraphs_v1'
  | 'evidence_v1'
  | 'style_fingerprint_v1'
  | 'help_chat_v1';

/**
 * A text block that becomes part of the flattened system prompt. The
 * `cached` flag is preserved for inspectPrompt() / B11 fixture regression
 * and as forward-compat metadata; DeepSeek has no caller-controlled cache.
 */
export interface SystemBlock {
  text: string;
  cached: boolean;
  /**
   * Human label used by inspectPrompt / B11 to verify the cached blocks
   * are present without exposing their full text.
   */
  label: string;
}

export interface ModelParams {
  maxTokens: number;
  /** 0 = deterministic; spec §15 prefers low temperatures for prose. */
  temperature: number;
  /** Set when the prompt expects strict JSON output. */
  responseFormat?: 'json_object' | 'text';
}

export interface PromptDefinition<Input, Output> {
  id: PromptId;
  version: string;
  model: DeepseekModel;
  /** One-line description for inspectPrompt + docs. */
  description: string;
  system: SystemBlock[];
  params: ModelParams;
  /** Build the user-role message from caller-supplied input. */
  buildUserMessage: (input: Input) => string;
  /** Parse the model's text response back into a typed structure. */
  parseResponse: (raw: string) => Output;
}

export interface PromptRunOptions {
  /** Optional override for max_tokens; defaults to definition value. */
  maxTokens?: number;
  /** Optional model override (defaults to definition). Use to escalate
   *  prep_summary / risk_paragraphs to deepseek-reasoner. */
  modelOverride?: DeepseekModel;
  /** Caller-tagged trace id propagated to telemetry. */
  requestId?: string;
}

export interface CacheTelemetry {
  /** DeepSeek reports an automatic server-side cache hit/miss split on
   *  recent API versions; both fields default to 0 when absent. */
  cacheHitTokens: number;
  cacheMissTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PromptResult<Output> {
  output: Output;
  raw: string;
  model: DeepseekModel;
  promptId: PromptId;
  version: string;
  stopReason: string | null;
  telemetry: CacheTelemetry;
}

export interface InspectedPrompt {
  id: PromptId;
  version: string;
  model: DeepseekModel;
  description: string;
  systemBlocks: Array<{ label: string; cached: boolean; chars: number }>;
  params: ModelParams;
}
