/**
 * Main-model inference-mode selection.
 *
 * The single precedence policy shared by the main driver registration and the
 * desktop model selector: a provider's declared gateway protocols decide the
 * one runtime a main-reasoning model runs under, in the fixed order
 * `openai_chat` then `openai_responses`. A provider declaring neither is not a
 * main-reasoning supply.
 */
import type { SessionInferenceMode } from '@wrenyard/protocol';

/** The one inference mode for a provider's protocols, or `undefined` when none is supported. */
export function selectInferenceMode(protocols: readonly string[]): SessionInferenceMode | undefined {
  if (protocols.includes('openai_chat')) return 'openai_chat';
  if (protocols.includes('openai_responses')) return 'openai_responses';
  return undefined;
}
