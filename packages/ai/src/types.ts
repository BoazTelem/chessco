/**
 * Shared types for the prompt library.
 *
 * A PromptDefinition is the static contract for a prompt:
 *   - id (stable string used by callers and B11 fixtures)
 *   - model (Opus / Sonnet / Haiku per spec §15)
 *   - system blocks with cache-control markers
 *   - input/output shapes
 *
 * A PromptResult bundles the parsed output plus Anthropic's cache-hit
 * telemetry so callers can confirm the cache is actually working.
 */

export type ClaudeModel = 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';

export type PromptId =
  | 'prep_summary_v1'
  | 'risk_paragraphs_v1'
  | 'evidence_v1'
  | 'style_fingerprint_v1'
  | 'help_chat_v1';

/**
 * A text block that becomes part of the Anthropic `system` array. Blocks
 * marked `cached: true` get `cache_control: { type: 'ephemeral' }` so the
 * prompt cache picks them up. Mark large, stable blocks (e.g. style guide,
 * vocab) as cached; leave per-call payloads uncached.
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
}

export interface PromptDefinition<Input, Output> {
  id: PromptId;
  version: string;
  model: ClaudeModel;
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
  /** Optional model override (defaults to definition). Use rarely. */
  modelOverride?: ClaudeModel;
  /** Caller-tagged trace id propagated to telemetry. */
  requestId?: string;
}

export interface CacheTelemetry {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PromptResult<Output> {
  output: Output;
  raw: string;
  model: ClaudeModel;
  promptId: PromptId;
  version: string;
  stopReason: string | null;
  telemetry: CacheTelemetry;
}

export interface InspectedPrompt {
  id: PromptId;
  version: string;
  model: ClaudeModel;
  description: string;
  systemBlocks: Array<{ label: string; cached: boolean; chars: number }>;
  params: ModelParams;
}
