/** Auxiliary role identifiers; no IO or selection logic. */
import type { SessionRoutesPreviewRole } from '@wrenyard/protocol';
/** Auxiliary call roles are model-call facts on the wire; declared in `@wrenyard/protocol/session` and re-exported here. */
export type { AuxiliaryCallRole } from '@wrenyard/protocol/session';
import type { AuxiliaryCallRole } from '@wrenyard/protocol/session';
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
