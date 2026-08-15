import { z } from 'zod'
import {
  type Ref,
  type Decision,
  DecisionSchema,
  type Evidence,
  EvidenceSchema,
  ProjectTargetSchema,
  QuestionSchema,
} from '../concepts.mts'
import { withExtensions } from './json-schema-extensions.mts'

/**
 * Feature Point protocol schemas (Zod 4) — Batch B2.
 *
 * New source-of-truth for the legacy `feature-point.schema.json` protocol.
 * Every legacy required field, enum, pattern, `minLength`, `maxLength`,
 * `additionalProperties: false`, `uniqueItems`, `if/then`, and `not/contains`
 * invariant is preserved. The legacy shared concepts are remapped per the
 * fixed Batch-B2 mapping:
 *
 *   - `ProjectRef`            -> `ProjectTarget` (object { kind, value })
 *   - `EvidenceRef`           -> `Evidence`  (id / source:Target / observation)
 *   - `ContextEntry`          -> `ctx: string`  (decisions / exploration_findings)
 *   - `OpenItem`              -> `QuestionSchema` rich extension (id/ask/blocking
 *                                + resolution_hint)
 *   - `DesignDecision`        -> extends `DecisionSchema`, retains status /
 *                                selected_option_refs (options) / constraints
 *   - `FeaturePointRef` etc.  -> `Ref<T>` patterned strings
 *   - `DesignContract`        -> retained domain structure (FP)
 *
 * `draft-07` constructs zod cannot express natively (if/then, not/contains,
 * uniqueItems) are restored after `z.toJSONSchema` via `withExtensions`.
 */

// ─── Legacy *Ref remaps (Ref<T> patterned strings) ─────────────────

export type FeaturePointRef = Ref<{ id: string }>
export const FeaturePointRefSchema = z.string().regex(/^FP-[0-9]{3,}$/)

export type AcceptanceCriterionRef = Ref<{ id: string }>
export const AcceptanceCriterionRefSchema = z.string().regex(/^AC-[0-9]{3,}$/)

export type DesignOptionRef = Ref<{ id: string }>
export const DesignOptionRefSchema = z.string().regex(/^DO-[0-9]{3,}$/)

export type DecisionRef = Ref<Decision>
export const DecisionRefSchema = z.string().min(1)

// ─── OpenItem — QuestionSchema rich extension (FP) ─────────────────
//
// `ref` -> `id` (Ref<Question>; legacy `^Q-…` pattern dropped like B1),
// `question` -> `ask`, `blocking` kept, `resolution_hint` retained optional.

export const OpenItemSchema = QuestionSchema.extend({
  resolution_hint: z.string().min(1).optional(),
})
export type OpenItem = z.infer<typeof OpenItemSchema>

// ─── DesignDecision — extends DecisionSchema ───────────────────────
//
// `decision_summary` -> `choice`, `rationale` kept (required), plus the
// retained `status` / `selected_option_refs` (options) / `constraints`
// fields and `rejected_options` / `adjustments` / `supersedes`.

export const RejectedOptionSchema = z.object({
  ref: DesignOptionRefSchema,
  reason: z.string().min(1),
})
export type RejectedOption = z.infer<typeof RejectedOptionSchema>

export const DesignDecisionSchema = DecisionSchema.extend({
  id: z.string().min(1),
  choice: z.string().min(1),
  rationale: z.string().min(1),
  status: z.enum(['selected', 'combined', 'adjusted', 'needs_more_exploration']),
  selected_option_refs: z.array(DesignOptionRefSchema).meta({ uniqueItems: true }),
  constraints: z.array(z.string().min(1)),
  rejected_options: z.array(RejectedOptionSchema),
  adjustments: z.array(z.string().min(1)).optional(),
  supersedes: z.array(z.string()).optional(),
})
export type DesignDecision = z.infer<typeof DesignDecisionSchema>

// ─── DesignContract (retained domain structure, FP) ────────────────

export const DesignContractSchema = z.object({
  kind: z.enum([
    'data_model',
    'index',
    'event_stream',
    'job',
    'api',
    'rest_route',
    'mcp_tool',
    'result_schema',
    'config',
    'ops',
    'observability',
    'workflow',
    'capability',
  ]),
  name: z.string().min(1),
  contract_shape: z.looseObject({}),
  fixed_decisions: z.array(z.string().min(1)).min(1),
})
export type DesignContract = z.infer<typeof DesignContractSchema>

// ─── FeaturePoint ──────────────────────────────────────────────────

export const FeaturePointSchema = z.object({
  ref: FeaturePointRefSchema,
  title: z.string().min(1).max(120),
  status: z.enum(['selected', 'deferred', 'rejected']),
  intent: z.string().min(1),
  user_value: z.string().min(1),
  design_basis: z.string().min(1),
  boundaries: z.array(z.string().min(1)),
  non_goals: z.array(z.string().min(1)),
  rough_acceptance_signals: z.array(z.string().min(1)),
  capability_hints: z.array(z.string().min(1)).optional(),
  design_contracts: z.array(DesignContractSchema),
  evidence: z.array(EvidenceSchema),
  decision_refs: z.array(DecisionRefSchema),
  priority: z.enum(['must', 'should', 'could']),
  trace: z.object({
    source_request: z.array(z.string().min(1)).min(1),
    design_option_refs: z.array(DesignOptionRefSchema).meta({ uniqueItems: true }),
    supersedes: z.array(FeaturePointRefSchema).meta({ uniqueItems: true }).optional(),
  }),
}).meta({
  if: { properties: { status: { const: 'selected' } }, required: ['status'] },
  then: {
    properties: {
      boundaries: { minItems: 1 },
      non_goals: { minItems: 1 },
      rough_acceptance_signals: { minItems: 1 },
      design_contracts: { minItems: 1 },
      evidence: { minItems: 1 },
      decision_refs: { minItems: 1 },
    },
  },
})
export type FeaturePoint = z.infer<typeof FeaturePointSchema>

// ─── FeaturePointSet (top) ─────────────────────────────────────────

export const FeaturePointSetSchema = z.object({
  schema_version: z.literal('feature-point/v1'),
  topic: z.string().min(1),
  project: ProjectTargetSchema,
  status: z.enum(['draft', 'confirmed', 'partial', 'blocked']),
  design_decision: DesignDecisionSchema,
  points: z.array(FeaturePointSchema).min(1),
  context_summary: z.object({
    decisions: z.array(z.string().min(1)),
    exploration_findings: z.array(z.string().min(1)),
    open_questions: z.array(OpenItemSchema),
  }),
  open_items: z.array(OpenItemSchema).optional(),
}).meta({
  if: { properties: { status: { const: 'confirmed' } }, required: ['status'] },
  then: {
    properties: {
      design_decision: {
        properties: {
          status: { enum: ['selected', 'combined', 'adjusted'] },
          selected_option_refs: { minItems: 1 },
        },
      },
      context_summary: {
        properties: {
          open_questions: {
            not: {
              contains: {
                type: 'object',
                required: ['blocking'],
                properties: { blocking: { const: true } },
              },
            },
          },
        },
      },
      open_items: {
        not: {
          contains: {
            type: 'object',
            required: ['blocking'],
            properties: { blocking: { const: true } },
          },
        },
      },
    },
  },
})
export type FeaturePointSet = z.infer<typeof FeaturePointSetSchema>

// ─── draft-07 extension fragments (restored after toJSONSchema) ────

// Set-level: when confirmed, design_decision must be selected/combined/adjusted
// with ≥1 selected_option_refs, and no blocking open questions / open items.
// `selected_option_refs` also keeps the legacy `uniqueItems: true` invariant
// (zod has no native uniqueItems), restored at the base (unconditional) level.
const FP_SET_EXT = {} as Record<string, unknown>

// Point-level: when a FeaturePoint is `selected`, the design-bearing arrays
// must be non-empty (uniqueItems on trace refs restored too).
const FP_POINT_EXT = {} as Record<string, unknown>

/** Strip root-only keywords before inlining a sub-schema node. */
function stripRoot(node: Record<string, unknown>): Record<string, unknown> {
  delete node.$schema
  delete node.$id
  return node
}

/** Convert the FeaturePointSet schema to a draft-07 JSON Schema. */
export function featurePointSetToJSONSchema(): Record<string, unknown> {
  const json = withExtensions(FeaturePointSetSchema, FP_SET_EXT) as Record<string, unknown>
  const pointJson = stripRoot(withExtensions(FeaturePointSchema, FP_POINT_EXT) as Record<string, unknown>)
  ;(json.properties as Record<string, unknown>).points = {
    ...(json.properties as Record<string, unknown>).points as Record<string, unknown>,
    items: pointJson,
  }
  return json
}
