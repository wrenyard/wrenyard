/** Model roles and automatic routing requirements for the harness. */
import type { LadderStep, RoleReasoningRequirement, ScoreWeights } from '@wrenyard/auto-routing';
import type { ModelCapability, ReasoningEffort } from '@wrenyard/models';
import type { SessionRoutesPreviewRole } from '@wrenyard/protocol';
import type { AuxiliaryCallRole } from '@wrenyard/protocol/session';
import { DISPATCH_LADDER } from './auxiliary/dispatch.ts';

export type { AuxiliaryCallRole } from '@wrenyard/protocol/session';
export type {
  AuxiliaryRoute,
  CallErrorFact,
  CallRunner,
  ReasonSelection,
  ReasoningRetryPolicy,
} from '@wrenyard/ai';

/** Auxiliary roles in the fixed order the route preview lists them. */
export const AUXILIARY_ROLE_ORDER: readonly AuxiliaryCallRole[] = [
  'reply',
  'dispatch',
  'document',
  'todo',
  'vcs',
  'project',
  'search',
  'memory-search',
  'title',
  'status',
  'suggestion',
];

/**
 * Read-only preview of one auxiliary role's rank-1 route. Derives from the
 * shared `session.routes.preview` wire DTO in `@wrenyard/protocol` so the
 * harness and the daemon never drift. The preview never invokes a model.
 */
export type AuxiliaryRoutePreview = SessionRoutesPreviewRole;

/** Every role that may issue a model call. `reason` is the one primary role. */
export const CALL_ROLES = [
  'reason',
  'memory-search',
  'search',
  'dispatch',
  'reply',
  'title',
  'document',
  'todo',
  'vcs',
  'project',
  'status',
  'suggestion',
  'task-output',
] as const;

export type CallRole = (typeof CALL_ROLES)[number];

const TEXT: readonly ModelCapability[] = ['text'];

/** Speed-first auxiliary weights (S=speed, P=price, Q=quota, I=intelligence); intelligence is not scored. */
export const AUXILIARY_SCORE_WEIGHTS: ScoreWeights = { S: 0.6, P: 0.2, Q: 0.2, I: 0 };

/** Auxiliary roles try low/mid models with abundant quota first, then low/mid with sufficient quota, then the ordinary ranked order. */
export const AUXILIARY_LADDER: readonly LadderStep[] = [
  { intelligence: ['low', 'mid'], quotaState: 'abundant' },
  { intelligence: ['low', 'mid'], quotaState: 'sufficient' },
  { intelligence: ['low', 'mid', 'high', 'premium'] },
];

export const ROLE_ROUTE_REQUIREMENTS: Readonly<Record<Exclude<AuxiliaryCallRole, 'task-output'>, RoleReasoningRequirement>> = {
  title: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 400, minimumContextWindow: 0, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  status: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 400, minimumContextWindow: 0, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  suggestion: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 400, minimumContextWindow: 0, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  'memory-search': { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 0, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  search: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  dispatch: { intelligenceMin: 'low', intelligenceExpected: 'high', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: DISPATCH_LADDER },
  document: { intelligenceMin: 'low', intelligenceExpected: 'high', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  vcs: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  todo: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  project: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
  reply: { intelligenceMin: 'low', intelligenceExpected: 'mid', expectedTps: 400, minimumContextWindow: 131072, requiredCapabilities: TEXT, scoreWeights: AUXILIARY_SCORE_WEIGHTS, ladder: AUXILIARY_LADDER },
};

/** Input payload forwarded into `@wrenyard/session` turn admission. */
export interface HarnessTurnInput {
  text: string;
  model?: {
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    fast?: boolean;
    automatic?: boolean;
    autoSelected?: boolean;
  };
  publicId?: string;
  contextWindow?: number;
  attachmentsKey?: string;
  sender?: { botId: string };
}
