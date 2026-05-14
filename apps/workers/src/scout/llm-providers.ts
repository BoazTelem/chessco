/**
 * Workers-side mirror of apps/web/lib/scout/llm-providers.ts.
 *
 * Same provider seam, same env contract. Both copies must stay in sync;
 * future change would be extraction to a packages/scout-llm shared module.
 *
 * DeepSeek is the production default (see memory note feedback-deepseek-
 * default-llm). Don't reach for Anthropic without an explicit reason.
 */

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(opts: { prompt: string; maxTokens: number }): Promise<string>;
}

/** DeepSeek chat-completions (OpenAI-compatible).
 *  Docs: https://api-docs.deepseek.com/api/create-chat-completion */
class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint = 'https://api.deepseek.com/chat/completions';

  constructor(apiKey: string, model = 'deepseek-chat') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate({ prompt, maxTokens }: { prompt: string; maxTokens: number }): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('DeepSeek returned empty content');
    return text;
  }
}

/**
 * Resolve the configured provider from env. Returns `null` (not throws) when
 * no provider is configured, so callers can fall back to algorithmic-only.
 *
 * SCOUT_PROSE_PROVIDER: 'deepseek' (default)
 * Required key: DEEPSEEK_API_KEY
 *
 * Anthropic is intentionally NOT exposed on the workers side — DeepSeek is
 * the production default and workers doesn't depend on @anthropic-ai/sdk.
 * If a non-deepseek provider is ever needed in batch jobs, add the SDK
 * dependency to apps/workers/package.json and mirror the web Anthropic
 * provider here.
 *
 * Optional `model` override lets the call site pick a reasoning-tier model
 * (e.g. 'deepseek-reasoner') for close-call escalation without restructuring.
 */
export function getProseProvider(opts: { model?: string } = {}): LlmProvider | null {
  const name = (process.env.SCOUT_PROSE_PROVIDER ?? 'deepseek').toLowerCase();
  if (name === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return null;
    return new DeepSeekProvider(key, opts.model);
  }
  return null;
}
