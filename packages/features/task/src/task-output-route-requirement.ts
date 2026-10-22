/**
 * Task-owned routing configuration for the `task-output` compile call.
 *
 * The selection algorithm and these types live in `@wrenyard/auto-routing`;
 * this module only owns the configuration values, independent of session's
 * dispatch routing so each side can change its own requirement separately.
 */
import type { LadderStep, RoleReasoningRequirement, ScoreWeights } from '@wrenyard/auto-routing';
import type { ModelCapability } from '@wrenyard/models';

const TEXT: readonly ModelCapability[] = ['text'];

/** Speed-first weights shared with session auxiliary calls (S/P/Q/I). */
export const TASK_OUTPUT_SCORE_WEIGHTS: ScoreWeights = { S: 0.6, P: 0.2, Q: 0.2, I: 0 };

/** Task-output compile tries mid models first, then low, then the rest. */
export const TASK_OUTPUT_LADDER: readonly LadderStep[] = [
  { intelligence: ['mid'] },
  { intelligence: ['low'] },
  { intelligence: ['low', 'mid', 'high', 'premium'] },
];

export const TASK_OUTPUT_ROUTE_REQUIREMENT: RoleReasoningRequirement = {
  intelligenceMin: 'low',
  intelligenceExpected: 'high',
  expectedTps: 400,
  minimumContextWindow: 131072,
  requiredCapabilities: TEXT,
  scoreWeights: TASK_OUTPUT_SCORE_WEIGHTS,
  ladder: TASK_OUTPUT_LADDER,
};
