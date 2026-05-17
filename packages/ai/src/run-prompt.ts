/**
 * runPrompt(id, input) — dispatch through the registry, send to DeepSeek
 * (OpenAI-compatible chat-completions), parse the response.
 *
 * inspectPrompt(id) returns a metadata-only view useful for B11 (so the
 * shape regression doesn't need to spend API tokens) and admin tooling.
 */
import { getDeepseekClient } from './client';
import { buildSystemPrompt } from './cache';
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
  const client = getDeepseekClient();
  const systemContent = buildSystemPrompt(def.system);
  const userMessage = def.buildUserMessage(input);

  const response = await client.chatComplete({
    model: options.modelOverride ?? def.model,
    max_tokens: options.maxTokens ?? def.params.maxTokens,
    temperature: def.params.temperature,
    response_format: def.params.responseFormat ? { type: def.params.responseFormat } : undefined,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userMessage },
    ],
  });

  const choice = response.choices[0];
  const raw = choice?.message.content ?? '';
  if (!raw) {
    throw new Error(`${id}: DeepSeek returned empty content`);
  }

  const usage = response.usage;
  const telemetry: CacheTelemetry = {
    cacheHitTokens: usage?.prompt_cache_hit_tokens ?? 0,
    cacheMissTokens: usage?.prompt_cache_miss_tokens ?? 0,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };

  return {
    output: def.parseResponse(raw),
    raw,
    model: options.modelOverride ?? def.model,
    promptId: id,
    version: def.version,
    stopReason: choice?.finish_reason ?? null,
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
