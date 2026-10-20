/** Auxiliary, task and bot requirements as data; no IO or selection logic. */
import type { IntelligenceTier, ModelCapability } from '@wrenyard/models';
import type { QuotaState, ScoreWeights } from './types.ts';

/** Every role that may issue an auxiliary call. */
export type AuxiliaryCallRole = 'title' | 'memory-search' | 'search' | 'dispatch' | 'document' | 'todo' | 'vcs' | 'project' | 'reply' | 'status' | 'suggestion';

/** One tier pool in a bot or auxiliary role's step-down ladder. */
export interface BotLadderStep {
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
  ladder?: readonly BotLadderStep[];
  /** Optional per-role ranking weights; absent uses the global routing settings. */
  scoreWeights?: ScoreWeights;
  /** Optional post-selection effort rule; high-or-above is reserved for bots. */
  reasoningEffortRule?: 'high-or-above';
}

const TEXT: readonly ModelCapability[] = ['text'];

/** Speed-first auxiliary weights (S=speed, P=price, Q=quota, I=intelligence); intelligence is not scored; these take precedence over the global routing settings for auxiliary roles. */
export const AUXILIARY_SCORE_WEIGHTS: ScoreWeights = { S: 0.6, P: 0.2, Q: 0.2, I: 0 };

/** Auxiliary roles try low/mid models with abundant quota first, then low/mid models with sufficient quota, then the ordinary ranked order over every remaining admitted route (the last step has no quota-state restriction; exhausted routes are always dropped). */
export const AUXILIARY_LADDER: readonly BotLadderStep[] = [
  { intelligence: ['low', 'mid'], quotaState: 'abundant' },
  { intelligence: ['low', 'mid'], quotaState: 'sufficient' },
  { intelligence: ['low', 'mid', 'high', 'premium'] },
];

/** The dispatch compiler tries mid models first, then low models, then the ordinary ranked order over the rest. */
export const DISPATCH_LADDER: readonly BotLadderStep[] = [
  { intelligence: ['mid'] },
  { intelligence: ['low'] },
  { intelligence: ['low', 'mid', 'high', 'premium'] },
];

export const ROLE_REQUIREMENTS: Readonly<Record<AuxiliaryCallRole, RoleReasoningRequirement>> = {
  title: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 400, minimumContextWindow: 0, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  status: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 400, minimumContextWindow: 0, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  suggestion: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 400, minimumContextWindow: 0, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  'memory-search': { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 0, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  'search': { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  dispatch: { intelligenceMin: 'low', intelligenceExpected: 'high', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: DISPATCH_LADDER },
  document: { intelligenceMin: 'low', intelligenceExpected: 'high', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  vcs: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  todo: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  project: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  reply: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
};

/**
 * The plain text-only baseline for tasks and explicit-requirement selections.
 * Per-invocation requirements (intelligence tier, TPS, caps) arrive through the
 * settings layer. It carries no auxiliary weights or ladder: those are for
 * auxiliary roles only.
 */
export const TASK_REQUIREMENT: RoleReasoningRequirement = {
  intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT,
};

/** Bot agents run a four-state tier ladder: premium and high models with
 *  abundant, then sufficient, then insufficient quota, and finally any mid
 *  model in a usable state. Exhausted routes are never used. Low stays
 *  excluded by the minimum gate. */
export const BOT_REQUIREMENT: RoleReasoningRequirement = {
  intelligenceMin: 'mid',
  intelligenceExpected: 'premium',
  expectedTps: 200,
  minimumContextWindow: 131072,
  requiredCapabilities: TEXT,
  reasoningEffortRule: 'high-or-above',
  ladder: [
    { intelligence: ['premium', 'high'], quotaState: 'abundant' },
    { intelligence: ['premium', 'high'], quotaState: 'sufficient' },
    { intelligence: ['premium', 'high'], quotaState: 'insufficient' },
    { intelligence: ['mid'] },
  ],
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
