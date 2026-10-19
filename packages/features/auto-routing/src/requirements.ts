/** Auxiliary, task and bot requirements as data; no IO or selection logic. */
import type { IntelligenceTier, ModelCapability, ReasoningEffort } from '@wrenyard/models';

/** Every role that may issue an auxiliary call. */
export type AuxiliaryCallRole = 'title' | 'memory-search' | 'search' | 'dispatch' | 'document' | 'todo' | 'vcs' | 'project' | 'reply' | 'status' | 'suggestion';

/** The model evidence one routing requirement asks for. */
export interface RoleReasoningRequirement {
  intelligenceMin: IntelligenceTier;
  intelligenceExpected: IntelligenceTier;
  expectedTps: number;
  minimumContextWindow: number;
  requiredCapabilities: readonly ModelCapability[];
  /** Ordered preference: selection keeps the routes supporting the first level any route supports. */
  expectedReasoningEffort: readonly ReasoningEffort[];
}

const TEXT: readonly ModelCapability[] = ['text'];
const NO_THINKING: readonly ReasoningEffort[] = ['none', 'low'];
export const ROLE_REQUIREMENTS: Readonly<Record<AuxiliaryCallRole, RoleReasoningRequirement>> = {
  title: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
  status: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
  suggestion: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
  'memory-search': { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
  'search': { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
  dispatch: { intelligenceMin: 'mid', intelligenceExpected: 'high', expectedTps: 100, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: ['high'] },
  document: { intelligenceMin: 'mid', intelligenceExpected: 'high', expectedTps: 100, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: ['low', 'medium'] },
  vcs: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: ['none', 'low'] },
  todo: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: ['none', 'low'] },
  project: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: ['none', 'low'] },
  reply: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
};

/**
 * The task requirement is the ordinary text-only reply profile. Per-invocation
 * requirements (intelligence tier, TPS, caps) arrive through the settings layer;
 * this constant only names the baseline the settings are applied to.
 */
export const TASK_REQUIREMENT: RoleReasoningRequirement = ROLE_REQUIREMENTS.reply;

/** Bot agents run on a hard-coded high/premium intelligence rule at a high
 *  reasoning level, with the reply profile's remaining gates. */
export const BOT_REQUIREMENT: RoleReasoningRequirement = {
  ...ROLE_REQUIREMENTS.reply,
  intelligenceMin: 'high',
  intelligenceExpected: 'premium',
  expectedReasoningEffort: ['high'],
};

/** Must equal the session loop budget. */
export const AUXILIARY_TIMEOUT_MS = 60_000;

/**
 * The session's Gateway protocol entry points in its fixed precedence order
 * Chat -> Responses -> Messages. This copy must stay in sync with
 * `selectSessionProtocol` in `packages/features/session/src/transport/protocol.ts`.
 */
const SESSION_PROTOCOLS = ['openai_chat', 'openai_responses', 'anthropic_messages'] as const;

/** True when a model's per-model protocols admit a session call at all. */
export function supportsSession(model: { protocols?: readonly string[] }): boolean {
  return SESSION_PROTOCOLS.find((protocol) => model.protocols?.includes(protocol) === true) !== undefined;
}
