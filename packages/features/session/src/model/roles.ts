/** Auxiliary selection tuning data; no IO or selection logic. */
import type { IntelligenceTier, ModelCapability, ReasoningEffort } from '@wrenyard/models';
import type { SessionRoutesPreviewRole } from '@wrenyard/protocol';
export type AuxiliaryCallRole = 'title' | 'memory-search' | 'search' | 'dispatch' | 'document' | 'todo' | 'vcs' | 'project' | 'reply' | 'status' | 'suggestion';
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
 * feature and the daemon never drift. The preview never invokes a model.
 */
export type AuxiliaryRoutePreview = SessionRoutesPreviewRole;
