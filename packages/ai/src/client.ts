/**
 * DeepSeek client factory. Resolves the API key from env, exposes a
 * singleton so workers don't churn TCP connections, and lets tests inject
 * a fake transport via setDeepseekClient().
 *
 * The DeepSeek API is OpenAI-compatible chat-completions. We don't take a
 * full SDK dep — the surface is small enough that a typed `fetch` wrapper
 * is cleaner and avoids ESM/CJS gotchas under Vercel's edge runtime.
 *
 * Endpoint: POST https://api.deepseek.com/chat/completions
 * Docs:     https://api-docs.deepseek.com/api/create-chat-completion
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_object' | 'text' };
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string | null };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export interface DeepseekClient {
  chatComplete(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

let singleton: DeepseekClient | null = null;

function createRealClient(apiKey: string): DeepseekClient {
  const endpoint = 'https://api.deepseek.com/chat/completions';
  return {
    async chatComplete(req) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as ChatCompletionResponse;
    },
  };
}

export function getDeepseekClient(): DeepseekClient {
  if (singleton) return singleton;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY is not set. Configure it for the worker or web env, ' +
        'or call setDeepseekClient() with a stubbed client in tests.',
    );
  }
  singleton = createRealClient(apiKey);
  return singleton;
}

/** Test seam: inject a stubbed client. Call with null to reset. */
export function setDeepseekClient(client: DeepseekClient | null): void {
  singleton = client;
}
