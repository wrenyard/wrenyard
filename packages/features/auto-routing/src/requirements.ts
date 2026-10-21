/** Task routing requirements as data; no IO or selection logic. */
import type { IntelligenceTier, ModelCapability, ReasoningEffort } from '@wrenyard/models';
import type { QuotaState, ScoreWeights } from './types.ts';

/**
 * One intelligence and quota pool in an ordered step-down ladder. Steps are
 * tried in order; within each step candidates are ranked by score.
 */
export interface LadderStep {
  readonly intelligence: readonly ('premium' | 'high' | 'mid' | 'low')[];
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
  ladder?: readonly LadderStep[];
  /** Optional per-role ranking weights; absent uses the global routing settings. */
  scoreWeights?: ScoreWeights;
  /**
   * Optional minimum reasoning effort after selection. When set, routing
   * resolves to the nearest supported level at or above this floor.
   */
  minimumReasoningEffort?: ReasoningEffort;
}

const TEXT: readonly ModelCapability[] = ['text'];

/**
 * The plain text-only baseline for tasks and explicit-requirement selections.
 * Per-invocation requirements (intelligence tier, TPS, caps) arrive through the
 * settings layer. It carries no auxiliary weights or ladder: callers own those.
 */
export const TASK_REQUIREMENT: RoleReasoningRequirement = {
  intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT,
};

/** DeepSeek automatic-routing pricing lookahead window. */
export const DEEPSEEK_PRICING_LOOKAHEAD_MS = 60_000;

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
