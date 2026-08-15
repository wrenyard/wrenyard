import { z } from 'zod'
import {
  type Ref,
  EvidenceSchema,
  ProjectTargetSchema,
  SymbolTargetSchema,
  AcceptanceCriterionSchema,
} from '../concepts.mts'
import {
  type FunctionalUnitRef,
  FunctionalUnitRefSchema,
} from './functional-unit.mts'
import { withExtensions } from './json-schema-extensions.mts'

/**
 * Implementation Unit protocol schemas (Zod 4) — Batch B1 (IU).
 *
 * New source-of-truth for the legacy `implementation-unit.schema.json`
 * protocol. Preserves every legacy required field, enum, pattern,
 * `minLength`, `maxLength`, `additionalProperties: false`, `uniqueItems`,
 * `if/then`, and `minItems` invariant. Shared-concept remaps (fixed Batch
 * mapping):
 *
 *   - `ProjectRef`      -> `ProjectTarget`              { kind, value }
 *   - `EvidenceRef`     -> `Evidence`                   { id, source, observation }
 *   - `ImplementationUnitRef` -> `Ref<T>` patterned string  `^IU-[0-9]{3,}$`
 *   - `FunctionalUnitRef`    -> `Ref<T>` patterned string  `^FU-[0-9]{3,}$`
 *                              (reused from `functional-unit.mts`)
 *   - `SymbolRef`       -> `SymbolTarget`               { kind:'symbol', value }
 *                          (legacy symbol `kind` enum preserved as `symbol_kind`)
 *   - `VerificationItem` -> common `AcceptanceCriterion`  { id, when, then }
 *                          (legacy `brief` -> `when`, `expected` -> `then`;
 *                           the stable `id` is generated per the domain schema)
 *
 * Retained domain structures: `ImplementationScope`, `RiskItem`,
 * `ImplementationUnit`, and `ImplementationUnitSet`. The legacy
 * `ready`-status `if/then` decomposition invariant and the
 * `functional_unit_refs` `uniqueItems` invariant are restored after
 * `z.toJSONSchema` via `withExtensions` (zod has no native `uniqueItems` /
 * `if/then`).
 */

// ─── Legacy *Ref remaps (Ref<T> patterned strings) ─────────────────

export type ImplementationUnitRef = Ref<{ id: string }>
export const ImplementationUnitRefSchema = z.string().regex(/^IU-[0-9]{3,}$/)

// `FunctionalUnitRef` is reused from `functional-unit.mts` (same `^FU-[0-9]{3,}$`
// pattern) to avoid a divergent second definition.
export type { FunctionalUnitRef }
export { FunctionalUnitRefSchema }

// ─── SymbolRef — SymbolTarget (legacy kind enum preserved) ─────────
//
// `name` -> `value` (SymbolTarget), `kind` enum (class/function/.../unknown)
// preserved as optional `symbol_kind`. Zod 4 emits `additionalProperties:
// false` for z.object, matching the legacy `SymbolRef` invariant.

export const SymbolRefSchema = SymbolTargetSchema.extend({
  symbol_kind: z
    .enum(['class', 'function', 'method', 'type', 'constant', 'route', 'task', 'workflow', 'unknown'])
    .optional(),
})
export type SymbolRef = z.infer<typeof SymbolRefSchema>

// ─── RiskItem (retained domain structure, IU) ──────────────────────

export const RiskItemSchema = z.object({
  summary: z.string().min(1),
  level: z.enum(['low', 'medium', 'high']).optional(),
  mitigation: z.string().min(1).optional(),
})
export type RiskItem = z.infer<typeof RiskItemSchema>

// ─── ImplementationScope (retained domain structure, IU) ───────────

export const ImplementationScopeSchema = z.object({
  project: ProjectTargetSchema,
  path: z.string().min(1),
  symbols: z.array(SymbolRefSchema),
  role: z.string().min(1),
  intent: z.string().min(1),
  constraints: z.array(z.string().min(1)),
  related_files: z.array(z.string().min(1)),
})
export type ImplementationScope = z.infer<typeof ImplementationScopeSchema>

// ─── ImplementationUnit ────────────────────────────────────────────

export const ImplementationUnitSchema = z.object({
  ref: ImplementationUnitRefSchema,
  title: z.string().min(1).max(120),
  purpose: z.string().min(1),
  status: z.enum(['ready', 'needs_more_evidence', 'blocked']),
  functional_unit_refs: z.array(FunctionalUnitRefSchema).min(1).meta({ uniqueItems: true }),
  scopes: z.array(ImplementationScopeSchema).min(1),
  constraints: z.array(z.string().min(1)),
  evidence: z.array(EvidenceSchema),
  risks: z.array(RiskItemSchema),
  decomposition_check: z.object({
    can_decompose_independently: z.boolean(),
    has_bounded_scope: z.boolean(),
    has_test_strategy: z.boolean(),
    preserves_functional_unit_trace: z.boolean(),
    unresolved_blockers: z.array(z.string().min(1)),
  }),
}).meta({
  if: { properties: { status: { const: 'ready' } }, required: ['status'] },
  then: {
    properties: {
      decomposition_check: {
        properties: {
          can_decompose_independently: { const: true },
          has_bounded_scope: { const: true },
          has_test_strategy: { const: true },
          preserves_functional_unit_trace: { const: true },
          unresolved_blockers: { maxItems: 0 },
        },
      },
    },
  },
})
export type ImplementationUnit = z.infer<typeof ImplementationUnitSchema>

// ─── ImplementationUnitSet (top) ───────────────────────────────────

export const ImplementationUnitSetSchema = z.object({
  schema_version: z.literal('implementation-unit/v1'),
  topic: z.string().min(1),
  project: ProjectTargetSchema,
  status: z.enum(['ready', 'needs_more_evidence', 'blocked']),
  summary: z.object({
    objective: z.string().min(1),
    recommended_approach: z.string().min(1),
    confidence: z.enum(['high', 'medium', 'low']),
  }),
  units: z.array(ImplementationUnitSchema).min(1),
  verification: z.array(AcceptanceCriterionSchema),
  risks: z.array(RiskItemSchema).optional(),
})
export type ImplementationUnitSet = z.infer<typeof ImplementationUnitSetSchema>

// ─── draft-07 extension fragments (restored after toJSONSchema) ────

// Unit-level: `functional_unit_refs` keeps `uniqueItems: true`, and when the
// unit `status` is `ready` the decomposition invariants must all hold
// (every flag true, no unresolved blockers).
const IU_UNIT_EXT = {
  properties: {
    functional_unit_refs: { uniqueItems: true },
  },
  if: { properties: { status: { const: 'ready' } }, required: ['status'] },
  then: {
    properties: {
      decomposition_check: {
        properties: {
          can_decompose_independently: { const: true },
          has_bounded_scope: { const: true },
          has_test_strategy: { const: true },
          preserves_functional_unit_trace: { const: true },
          unresolved_blockers: { maxItems: 0 },
        },
      },
    },
  },
} as Record<string, unknown>

/** Strip root-only keywords before inlining a sub-schema node. */
function stripRoot(node: Record<string, unknown>): Record<string, unknown> {
  delete node.$schema
  delete node.$id
  return node
}

/** Convert the ImplementationUnitSet schema to a draft-07 JSON Schema. */
export function implementationUnitSetToJSONSchema(): Record<string, unknown> {
  const json = withExtensions(ImplementationUnitSetSchema, {}) as Record<string, unknown>
  const unitJson = stripRoot(withExtensions(ImplementationUnitSchema, IU_UNIT_EXT) as Record<string, unknown>)
  ;(json.properties as Record<string, unknown>).units = {
    ...(json.properties as Record<string, unknown>).units as Record<string, unknown>,
    items: unitJson,
  }
  return json
}
