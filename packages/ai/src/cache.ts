/**
 * Build the system array Anthropic expects, with `cache_control` markers
 * on the blocks we want the prompt cache to hold across calls.
 *
 * Anthropic prompt caching has a 5-minute ephemeral TTL and supports up to
 * 4 cache breakpoints per request. We expose `cache_control: { type:
 * 'ephemeral' }` on any SystemBlock marked `cached: true`. Callers should
 * mark stable, large blocks (style guides, glossaries, vocab tables) so a
 * sequence of related calls re-uses the same cached prefix.
 */
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { SystemBlock } from './types';

const MAX_CACHE_BREAKPOINTS = 4;

export function buildSystem(blocks: SystemBlock[]): TextBlockParam[] {
  let breakpointsUsed = 0;
  return blocks.map<TextBlockParam>((block) => {
    if (block.cached && breakpointsUsed < MAX_CACHE_BREAKPOINTS) {
      breakpointsUsed++;
      return {
        type: 'text',
        text: block.text,
        cache_control: { type: 'ephemeral' },
      };
    }
    return { type: 'text', text: block.text };
  });
}
