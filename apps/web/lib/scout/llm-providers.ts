/**
 * LLM provider for Scout's evidence-prose generation.
 *
 * Single provider: DeepSeek chat-completions (OpenAI-compatible).
 * Evidence-prose is a presentation-layer task: all chess pattern matching
 * is already done by the deterministic Stage 2/3 pipeline before the LLM
 * is asked to write a sentence. Any chat-completion model with passable
 * JSON-following can fill this slot.
 *
 * The seam (interface + factory) is kept so we can later A/B candidate
 * engines without touching `evidence-prose.ts` or the call sites in
 * `/api/identify`. To add a provider, add a new class + branch in
 * getProseProvider; today we only ship DeepSeek.
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

/**
 * Resolve the configured provider from env. Returns `null` (not throws) when
 * no provider is configured, so callers can fall back to bullet reasons.
 *
 * Required key: DEEPSEEK_API_KEY.
 *
 * Optional `model` override lets the call site pick a reasoning-tier model
 * (e.g. 'deepseek-reasoner') for close-call escalation without restructuring.
 */
export function getProseProvider(opts: { model?: string } = {}): LlmProvider | null {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  return new DeepSeekProvider(key, opts.model);
}
