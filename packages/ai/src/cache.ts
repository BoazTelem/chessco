/**
 * Flatten a prompt's `SystemBlock[]` into a single system-message string.
 *
 * DeepSeek's chat-completions API takes one `{ role: 'system', content }`
 * message, not an array of cached/uncached blocks. The `cached` flag on
 * SystemBlock is preserved on the type for inspectPrompt() / B11 fixture
 * regression but is a no-op at runtime: DeepSeek has no caller-controlled
 * prompt cache (its server-side cache is automatic and reported back via
 * `prompt_cache_hit_tokens` in usage). We concatenate blocks in order with
 * blank-line separators so a future provider that does support cache
 * markers can re-introduce them without changing call sites.
 */
import type { SystemBlock } from './types';

export function buildSystemPrompt(blocks: SystemBlock[]): string {
  return blocks
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}
