/**
 * Anthropic client factory. Resolves the API key from env, exposes a
 * singleton so workers don't churn TCP connections, and lets tests inject
 * a fake transport via setAnthropicClient().
 */
import Anthropic from '@anthropic-ai/sdk';

let singleton: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (singleton) return singleton;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Configure it for the worker or web env, ' +
        'or call setAnthropicClient() with a stubbed client in tests.',
    );
  }
  singleton = new Anthropic({ apiKey });
  return singleton;
}

/** Test seam: inject a stubbed client. Call with null to reset. */
export function setAnthropicClient(client: Anthropic | null): void {
  singleton = client;
}
