/**
 * LLM provider registry for Scout's evidence-prose generation.
 *
 * Today we use a single provider at a time (selected by SCOUT_PROSE_PROVIDER
 * env var, defaulting to DeepSeek). The interface is intentionally small —
 * one async `generate(prompt) → text` call — because evidence-prose is a
 * presentation-layer task: all chess pattern matching is already done by
 * the deterministic Stage 2/3 pipeline before the LLM is asked to write
 * a sentence. Any chat-completion model with passable JSON-following can
 * fill this slot.
 *
 * The provider seam exists so we can later A/B candidate engines (DeepSeek,
 * Claude Haiku, GPT-4o-mini, Gemini Flash, etc.) and pick the best on cost,
 * latency, and JSON adherence — without touching `evidence-prose.ts` or
 * the call sites in `/api/identify`.
 *
 * Each provider returns plain text; the caller is responsible for JSON
 * extraction. Failures throw — `generateEvidenceProse` catches at the
 * boundary so the API stays 200 and the UI falls back to bullet reasons.
 */

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(opts: { prompt: string; maxTokens: number }): Promise<string>;
}

/** DeepSeek chat-completions (OpenAI-compatible API).
 *  Docs: https://api-docs.deepseek.com/api/create-chat-completion
 *  Pricing (2026): ~$0.27/M output tokens for deepseek-chat. */
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
        // Ask DeepSeek for strict JSON. The model still occasionally adds a
        // stray sentence, so `extractJsonObject` in evidence-prose.ts is the
        // belt to this suspender.
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

/** Anthropic Claude Haiku — kept available so a future env flip turns it on
 *  for A/B comparison against DeepSeek without code changes. Loaded lazily
 *  to avoid bundling the SDK when the default DeepSeek provider is selected. */
class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model = 'claude-haiku-4-5-20251001') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate({ prompt, maxTokens }: { prompt: string; maxTokens: number }): Promise<string> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const res = await client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
  }
}

/**
 * Resolve the configured provider from env. Returns `null` (not throws) when
 * no provider is configured, so callers can fall back to bullet reasons.
 *
 * SCOUT_PROSE_PROVIDER: 'deepseek' (default) | 'anthropic'
 * Required key per provider: DEEPSEEK_API_KEY | ANTHROPIC_API_KEY
 */
export function getProseProvider(): LlmProvider | null {
  const name = (process.env.SCOUT_PROSE_PROVIDER ?? 'deepseek').toLowerCase();
  if (name === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return null;
    return new DeepSeekProvider(key);
  }
  if (name === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    return new AnthropicProvider(key);
  }
  return null;
}
