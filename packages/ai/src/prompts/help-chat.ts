/**
 * help_chat_v1 — the in-app support chat. Lightweight Q&A that answers
 * based on a passed-in knowledge-base excerpt + recent user messages.
 *
 * Spec §15: deepseek-chat. Never gives legal, medical, or financial advice.
 */
import type { PromptDefinition } from '../types';

export interface HelpChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface HelpChatInput {
  /** KB articles or snippets relevant to the user's question. */
  knowledgeBase: Array<{ title: string; body: string }>;
  /** Conversation so far, newest last. */
  history: HelpChatTurn[];
}

export interface HelpChatOutput {
  reply: string;
}

const SYSTEM_VOICE = `You are Chessco's in-app support assistant. You answer
user questions about how the product works, using only the knowledge-base
excerpts provided. If the answer isn't in the KB, say so honestly and tell
the user where to ask next (the support email).

You do NOT give legal, medical, or financial advice. You do NOT speculate
about a user's payout, refund, or ban status; route those to support.

Tone: brief, helpful, direct. 1–4 sentences per answer. No emojis.`;

const SYSTEM_OUTPUT_CONTRACT = `Plain text reply only. No markdown beyond
inline code spans for product surfaces (e.g. \`/practice\`). No JSON.`;

function buildUserMessage(input: HelpChatInput): string {
  const kb = input.knowledgeBase.map((a) => `# ${a.title}\n${a.body}`).join('\n\n---\n\n');
  const transcript = input.history
    .map((t) => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${t.content}`)
    .join('\n');
  return [
    'KNOWLEDGE BASE EXCERPTS',
    '======================',
    kb || '(none provided)',
    '',
    'CONVERSATION SO FAR',
    '===================',
    transcript || '(no prior turns)',
    '',
    'Respond to the most recent USER message.',
  ].join('\n');
}

function parseResponse(raw: string): HelpChatOutput {
  const reply = raw.trim();
  if (!reply) throw new Error('help_chat_v1: empty output');
  return { reply };
}

export const helpChatPrompt: PromptDefinition<HelpChatInput, HelpChatOutput> = {
  id: 'help_chat_v1',
  version: '1.0.0',
  model: 'deepseek-chat',
  description: 'In-app support chat with KB-grounded answers.',
  system: [
    { label: 'voice-rules', text: SYSTEM_VOICE, cached: true },
    { label: 'output-contract', text: SYSTEM_OUTPUT_CONTRACT, cached: true },
  ],
  params: { maxTokens: 500, temperature: 0.3 },
  buildUserMessage,
  parseResponse,
};
