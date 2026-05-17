/**
 * runPrompt(id, input) — dispatch through the registry, send to Anthropic
 * with prompt-cache markers, parse the response.
 *
 * inspectPrompt(id) returns a metadata-only view useful for B11 (so the
 * shape regression doesn't need to spend API tokens) and admin tooling.
 */
import { getAnthropicClient } from './client';
import { buildSystem } from './cache';
import { getPromptDefinition, type PromptIO } from './registry';
import type {
  CacheTelemetry,
  InspectedPrompt,
  PromptId,
  PromptResult,
  PromptRunOptions,
} from './types';

export async function runPrompt<K extends PromptId>(
  id: K,
  input: PromptIO[K]['input'],
  options: PromptRunOptions = {},
): Promise<PromptResult<PromptIO[K]['output']>> {
  const def = getPromptDefinition(id);
  const client = getAnthropicClient();
  const system = buildSystem(def.system);
  const userMessage = def.buildUserMessage(input);

  const response = await client.messages.create({
    model: options.modelOverride ?? def.model,
    max_tokens: options.maxTokens ?? def.params.maxTokens,
    temperature: def.params.temperature,
    system,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content
    .filter(
      (block): block is { type: 'text'; text: string; citations: unknown } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('');

  // cache_creation_input_tokens / cache_read_input_tokens are present on
  // recent SDK versions but the type only exposes them when the SDK was
  // compiled with the prompt-caching surface. Access via a typed shim so
  // older SDK pins still compile.
  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  const telemetry: CacheTelemetry = {
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };

  return {
    output: def.parseResponse(raw),
    raw,
    model: def.model,
    promptId: id,
    version: def.version,
    stopReason: response.stop_reason,
    telemetry,
  };
}

export function inspectPrompt(id: PromptId): InspectedPrompt {
  const def = getPromptDefinition(id);
  return {
    id: def.id,
    version: def.version,
    model: def.model,
    description: def.description,
    systemBlocks: def.system.map((b) => ({
      label: b.label,
      cached: b.cached,
      chars: b.text.length,
    })),
    params: def.params,
  };
}
