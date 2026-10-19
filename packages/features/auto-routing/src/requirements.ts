/** Auxiliary, task and bot requirements as data; no IO or selection logic. */
import type { IntelligenceTier, ModelCapability } from '@wrenyard/models';
import type { QuotaState } from './types.ts';

/** Every role that may issue an auxiliary call. */
export type AuxiliaryCallRole = 'title' | 'memory-search' | 'search' | 'dispatch' | 'document' | 'todo' | 'vcs' | 'project' | 'reply' | 'status' | 'suggestion';

/** One tier pool in a bot's step-down ladder. */
export interface BotLadderStep {
  readonly intelligence: readonly ('premium' | 'high' | 'mid')[];
  /** Exhausted routes are never used, so no ladder step may name that state. */
  readonly quotaState?: Exclude<QuotaState, 'exhausted'>;
}

/** The model evidence one routing requirement asks for. */
export interface RoleReasoningRequirement {
  intelligenceMin: IntelligenceTier;
  intelligenceExpected: IntelligenceTier;
  expectedTps: number;
  minimumContextWindow: number;
  requiredCapabilities: readonly ModelCapability[];
  /** Ordered tier pools tried in sequence; absent keeps the plain ranked order. */
  ladder?: readonly BotLadderStep[];
}

const TEXT: readonly ModelCapability[] = ['text'];
export const ROLE_REQUIREMENTS: Readonly<Record<AuxiliaryCallRole, RoleReasoningRequirement>> = {
  title: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT },
  status: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT },
  suggestion: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT },
  'memory-search': { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT },
  'search': { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT },
  dispatch: { intelligenceMin: 'mid', intelligenceExpected: 'high', expectedTps: 100, minimumContextWindow: 131072, requiredCapabilities: TEXT },
  document: { intelligenceMin: 'mid', intelligenceExpected: 'high', expectedTps: 100, minimumContextWindow: 131072, requiredCapabilities: TEXT },
  vcs: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT },
  todo: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT },
  project: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT },
  reply: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT },
};

/**
 * The task requirement is the ordinary text-only reply profile. Per-invocation
 * requirements (intelligence tier, TPS, caps) arrive through the settings layer;
 * this constant only names the baseline the settings are applied to.
 */
export const TASK_REQUIREMENT: RoleReasoningRequirement = ROLE_REQUIREMENTS.reply;

/** Bot agents run a four-state tier ladder: premium and high models with
 *  abundant, then sufficient, then insufficient quota, and finally any mid
 *  model in a usable state. Exhausted routes are never used. Low stays
 *  excluded by the minimum gate. */
export const BOT_REQUIREMENT: RoleReasoningRequirement = {
  ...ROLE_REQUIREMENTS.reply,
  intelligenceMin: 'mid',
  intelligenceExpected: 'premium',
  ladder: [
    { intelligence: ['premium', 'high'], quotaState: 'abundant' },
    { intelligence: ['premium', 'high'], quotaState: 'sufficient' },
    { intelligence: ['premium', 'high'], quotaState: 'insufficient' },
    { intelligence: ['mid'] },
  ],
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
