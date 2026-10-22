/** Per auxiliary-role automatic routing requirements; no IO or selection logic. */
import type { LadderStep, RoleReasoningRequirement, ScoreWeights } from '@wrenyard/auto-routing';
import type { ModelCapability } from '@wrenyard/models';
import type { AuxiliaryCallRole } from './roles.ts';
import { DISPATCH_LADDER } from '../auxiliary/dispatch.ts';

const TEXT: readonly ModelCapability[] = ['text'];

/** Speed-first auxiliary weights (S=speed, P=price, Q=quota, I=intelligence); intelligence is not scored. */
export const AUXILIARY_SCORE_WEIGHTS: ScoreWeights = { S: 0.6, P: 0.2, Q: 0.2, I: 0 };

/** Auxiliary roles try low/mid models with abundant quota first, then low/mid with sufficient quota, then the ordinary ranked order. */
export const AUXILIARY_LADDER: readonly LadderStep[] = [
  { intelligence: ['low', 'mid'], quotaState: 'abundant' },
  { intelligence: ['low', 'mid'], quotaState: 'sufficient' },
  { intelligence: ['low', 'mid', 'high', 'premium'] },
];

// `task-output` routing config is owned by `@wrenyard/task`
// (`TASK_OUTPUT_ROUTE_REQUIREMENT`); the session table narrows to session roles.
export const ROLE_ROUTE_REQUIREMENTS: Readonly<Record<Exclude<AuxiliaryCallRole, 'task-output'>, RoleReasoningRequirement>> = {
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
