/** Auxiliary selection tuning data; no IO or selection logic. */
import type { IntelligenceTier, ModelCapability, ReasoningEffort } from '@wrenyard/models';
import type { SessionRoutesPreviewRole } from '@wrenyard/protocol';
export type AuxiliaryCallRole = 'title' | 'memory-search' | 'doc-search' | 'compile' | 'reply';
export interface RoleReasoningRequirement {
  intelligenceMin: IntelligenceTier;
  intelligenceExpected: IntelligenceTier;
  expectedTps: number;
  minimumContextWindow: number;
  requiredCapabilities: readonly ModelCapability[];
  /** Ordered preference: selection keeps the routes supporting the first level any route supports. */
  expectedReasoningEffort: readonly ReasoningEffort[];
}
/** Auxiliary roles in the fixed order the route preview lists them. */
export const AUXILIARY_ROLE_ORDER: readonly AuxiliaryCallRole[] = [
  'reply',
  'compile',
  'doc-search',
  'memory-search',
  'title',
];

/**
 * Read-only preview of one auxiliary role's rank-1 route. Derives from the
 * shared `session.routes.preview` wire DTO in `@wrenyard/protocol` so the
 * feature and the daemon never drift. The preview never invokes a model.
 */
export type AuxiliaryRoutePreview = SessionRoutesPreviewRole;

const TEXT: readonly ModelCapability[] = ['text'];
const NO_THINKING: readonly ReasoningEffort[] = ['none', 'low'];
export const ROLE_REQUIREMENTS: Readonly<Record<AuxiliaryCallRole, RoleReasoningRequirement>> = {
  title: { intelligenceMin: 'low', intelligenceExpected: 'low', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
  'memory-search': { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 0, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
  'doc-search': { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
  compile: { intelligenceMin: 'mid', intelligenceExpected: 'high', expectedTps: 100, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: ['high'] },
  reply: { intelligenceMin: 'mid', intelligenceExpected: 'mid', expectedTps: 200, minimumContextWindow: 131072, requiredCapabilities: TEXT, expectedReasoningEffort: NO_THINKING },
};
