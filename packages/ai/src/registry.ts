/**
 * Typed registry of every prompt definition. `runPrompt(id, input)` and
 * `inspectPrompt(id)` both dispatch through here.
 *
 * Each entry's input/output types are anchored by its PromptDefinition;
 * the union of all entries gives the dispatcher a tagged-union shape so
 * callers get end-to-end type safety on input.
 */
import { evidencePrompt, type EvidenceInput, type EvidenceOutput } from './prompts/evidence';
import { helpChatPrompt, type HelpChatInput, type HelpChatOutput } from './prompts/help-chat';
import {
  prepSummaryPrompt,
  type PrepSummaryInput,
  type PrepSummaryOutput,
} from './prompts/prep-summary';
import {
  riskParagraphsPrompt,
  type RiskParagraphsInput,
  type RiskParagraphsOutput,
} from './prompts/risk-paragraphs';
import {
  styleFingerprintPrompt,
  type StyleFingerprintInput,
  type StyleFingerprintOutput,
} from './prompts/style-fingerprint';
import type { PromptDefinition, PromptId } from './types';

export interface PromptIO {
  prep_summary_v1: { input: PrepSummaryInput; output: PrepSummaryOutput };
  risk_paragraphs_v1: { input: RiskParagraphsInput; output: RiskParagraphsOutput };
  evidence_v1: { input: EvidenceInput; output: EvidenceOutput };
  style_fingerprint_v1: { input: StyleFingerprintInput; output: StyleFingerprintOutput };
  help_chat_v1: { input: HelpChatInput; output: HelpChatOutput };
}

type Registry = {
  [K in PromptId]: PromptDefinition<PromptIO[K]['input'], PromptIO[K]['output']>;
};

export const PROMPT_REGISTRY: Registry = {
  prep_summary_v1: prepSummaryPrompt,
  risk_paragraphs_v1: riskParagraphsPrompt,
  evidence_v1: evidencePrompt,
  style_fingerprint_v1: styleFingerprintPrompt,
  help_chat_v1: helpChatPrompt,
};

export function getPromptDefinition<K extends PromptId>(
  id: K,
): PromptDefinition<PromptIO[K]['input'], PromptIO[K]['output']> {
  return PROMPT_REGISTRY[id];
}

export function listPromptIds(): PromptId[] {
  return Object.keys(PROMPT_REGISTRY) as PromptId[];
}
