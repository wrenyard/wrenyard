// @ts-nocheck
/**
 * Batch B2 — old-vs-new AJV equivalence tests for the Feature Point protocol.
 *
 * Compiles the *legacy* draft-07 schema from `tests/fixtures/legacy-workspace-schemas/
 * feature-point.schema.json` (which `$ref`s `shared.schema.json` and
 * `inquiry.schema.json`) with AJV, and compiles the *new* Zod-4 source of
 * truth (`lib/core/task/schemas/feature-point.mts`) converted to draft-07
 * JSON Schema with AJV. For a battery of valid and invalid documents it
 * asserts that the old and new validators AGREE on every structural
 * invariant the B2 migration must preserve:
 *
 *   - required fields
 *   - enums (set status, point status, priority, design contract kind,
 *     design_decision status)
 *   - string patterns (FP- / DO- / AC- refs)
 *   - minLength (topic, title, intent, ...)
 *   - additionalProperties: false (reject unknown keys)
 *   - minItems (points array; selected-point design arrays)
 *   - if/then: confirmed set -> design_decision selected/combined/adjusted
 *     with >=1 selected_option_refs; selected point -> non-empty design arrays
 *   - not/contains: confirmed set -> no blocking open_questions / open_items
 *   - uniqueItems: trace.design_option_refs, trace.supersedes,
 *     design_decision.selected_option_refs
 *
 * The new schema deliberately remaps a few shared primitives
 * (`ProjectRef` -> `ProjectTarget` { kind, value }, `EvidenceRef` ->
 * `Evidence` { id, source, observation }, `ContextEntry` -> `ctx: string`,
 * `OpenItem` -> `QuestionSchema` { id, ask, blocking }). Those remaps change
 * the *shape* of the document, so each equivalence case carries an
 * old-shaped document (validated by the legacy schema) and a new-shaped
 * document (validated by the converted schema); what must match is the
 * acceptance decision.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import { describe, it } from 'node:test'

import { FeaturePointSetSchema, featurePointSetToJSONSchema } from '../../../lib/core/task/schemas/feature-point.mts'
import { compileSchema } from '../../../lib/workspace/schema-loader.mts'

const here = dirname(fileURLToPath(import.meta.url))
const legacyDir = join(here, '..', '..', 'fixtures', 'legacy-workspace-schemas')
const fixtureDir = join(here, '..', '..', 'fixtures', 'migration-feature-point')

const loadLegacy = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(legacyDir, name), 'utf8'))
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Old (legacy) validator ────────────────────────────────────────
//
// The legacy feature-point schema pulls shared concepts from
// `shared.schema.json` (ProjectRef / EvidenceRef / ContextEntry) and
// `OpenItem.ref` from `inquiry.schema.json` (QuestionRef). Both must be
// registered so AJV can resolve the external `$ref`s.

function buildOldAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false })
  ajv.addSchema(loadLegacy('shared.schema.json'))
  ajv.addSchema(loadLegacy('inquiry.schema.json'))
  return ajv
}

const oldAjv = buildOldAjv()
const oldValidate = oldAjv.compile(loadLegacy('feature-point.schema.json')) as ValidateFunction

// ─── New (Zod -> draft-07) validator ───────────────────────────────

const newAjv = new Ajv({ allErrors: true, strict: false })
const newValidate = newAjv.compile(featurePointSetToJSONSchema()) as ValidateFunction

// Runtime validator: the exported Zod schema compiled through the production
// `compileSchema` path (z.toJSONSchema -> AJV). Must enforce every B4
// invariant the helper enforces, so the runtime gap cannot recur.
const runtimeValidate = compileSchema(FeaturePointSetSchema).validate

/** Set a nested value in place along a simple key path. */
function setPath(doc: Record<string, unknown>, path: string[], value: unknown): void {
  let node: Record<string, unknown> = doc
  for (let i = 0; i < path.length - 1; i++) {
    node = node[path[i]] as Record<string, unknown>
  }
  node[path[path.length - 1]] = value
}

/**
 * Assert the old and new validators reach the SAME acceptance decision for
 * the given old-shaped / new-shaped documents.
 */
function assertAgree(
  oldDoc: unknown,
  newDoc: unknown,
  label: string,
): void {
  const oldOk = oldValidate(oldDoc)
  const newOk = newValidate(newDoc)
  const runtimeOk = runtimeValidate(newDoc)
  assert.equal(
    oldOk,
    newOk,
    `equivalence divergence on "${label}": old=${oldOk} new=${newOk}\n` +
      `  old errors: ${JSON.stringify(oldValidate.errors)}\n` +
      `  new errors: ${JSON.stringify(newValidate.errors)}`,
  )
  assert.equal(
    newOk,
    runtimeOk,
    `runtime gap on "${label}": helper=${newOk} runtime=${runtimeOk}\n` +
      `  helper errors: ${JSON.stringify(newValidate.errors)}\n` +
      `  runtime errors: ${JSON.stringify(runtimeValidate.errors)}`,
  )
}

// ─── Valid set (old shape vs new shape) ─────────────────────────────

describe('B2 equivalence — valid feature point set (old shape vs new shape)', () => {
  const legacyValid = loadFixture('feature-point-set.valid.legacy.json')
  const newValid = loadFixture('feature-point-set.valid.new.json')

  it('accepts a valid confirmed set with a selected point under both old and new', () => {
    assertAgree(legacyValid, newValid, 'valid confirmed set')
  })
})

// ─── Selected feature points ───────────────────────────────────────

describe('B2 equivalence — selected feature points', () => {
  it('rejects a selected point with an empty design array (boundaries) under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['points', 0, 'boundaries'], [])
    setPath(newInvalid, ['points', 0, 'boundaries'], [])
    assertAgree(legacyInvalid, newInvalid, 'selected point empty boundaries')
  })

  it('rejects a selected point with empty design_contracts under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['points', 0, 'design_contracts'], [])
    setPath(newInvalid, ['points', 0, 'design_contracts'], [])
    assertAgree(legacyInvalid, newInvalid, 'selected point empty design_contracts')
  })

  it('accepts a non-selected (deferred) point with empty design arrays under both', () => {
    // The selected-point minItems invariant is keyed on point.status, so a
    // deferred point may legitimately have empty design arrays.
    const legacyOk = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newOk = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyOk, ['points', 0, 'status'], 'deferred')
    setPath(newOk, ['points', 0, 'status'], 'deferred')
    setPath(legacyOk, ['points', 0, 'boundaries'], [])
    setPath(newOk, ['points', 0, 'boundaries'], [])
    setPath(legacyOk, ['points', 0, 'non_goals'], [])
    setPath(newOk, ['points', 0, 'non_goals'], [])
    setPath(legacyOk, ['points', 0, 'rough_acceptance_signals'], [])
    setPath(newOk, ['points', 0, 'rough_acceptance_signals'], [])
    setPath(legacyOk, ['points', 0, 'design_contracts'], [])
    setPath(newOk, ['points', 0, 'design_contracts'], [])
    setPath(legacyOk, ['points', 0, 'evidence'], [])
    setPath(newOk, ['points', 0, 'evidence'], [])
    setPath(legacyOk, ['points', 0, 'decision_refs'], [])
    setPath(newOk, ['points', 0, 'decision_refs'], [])
    assertAgree(legacyOk, newOk, 'deferred point empty design arrays')
  })
})

// ─── Confirmed decisions ────────────────────────────────────────────

describe('B2 equivalence — confirmed decisions', () => {
  it('rejects a confirmed set whose design_decision.status is needs_more_exploration under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['design_decision', 'status'], 'needs_more_exploration')
    setPath(newInvalid, ['design_decision', 'status'], 'needs_more_exploration')
    assertAgree(legacyInvalid, newInvalid, 'confirmed + needs_more_exploration')
  })

  it('rejects a confirmed set with no selected_option_refs under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['design_decision', 'selected_option_refs'], [])
    setPath(newInvalid, ['design_decision', 'selected_option_refs'], [])
    assertAgree(legacyInvalid, newInvalid, 'confirmed + empty selected_option_refs')
  })

  it('rejects a confirmed combined decision with duplicate selected_option_refs under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['design_decision', 'status'], 'combined')
    setPath(newInvalid, ['design_decision', 'status'], 'combined')
    setPath(legacyInvalid, ['design_decision', 'selected_option_refs'], ['DO-001', 'DO-001'])
    setPath(newInvalid, ['design_decision', 'selected_option_refs'], ['DO-001', 'DO-001'])
    assertAgree(legacyInvalid, newInvalid, 'confirmed + duplicate selected_option_refs')
  })
})

// ─── Blocking questions ─────────────────────────────────────────────

describe('B2 equivalence — blocking questions', () => {
  it('accepts a blocking open question when the set is not confirmed (draft) under both', () => {
    const legacyOk = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newOk = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyOk, ['status'], 'draft')
    setPath(newOk, ['status'], 'draft')
    setPath(legacyOk, ['context_summary', 'open_questions', 0, 'blocking'], true)
    setPath(newOk, ['context_summary', 'open_questions', 0, 'blocking'], true)
    assertAgree(legacyOk, newOk, 'draft + blocking open_question')
  })

  it('rejects a confirmed set with a blocking open_question under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['context_summary', 'open_questions', 0, 'blocking'], true)
    setPath(newInvalid, ['context_summary', 'open_questions', 0, 'blocking'], true)
    assertAgree(legacyInvalid, newInvalid, 'confirmed + blocking open_question')
  })

  it('rejects a confirmed set with a blocking open_item under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['open_items', 0, 'blocking'], true)
    setPath(newInvalid, ['open_items', 0, 'blocking'], true)
    assertAgree(legacyInvalid, newInvalid, 'confirmed + blocking open_item')
  })
})

// ─── Duplicates (uniqueItems) ──────────────────────────────────────

describe('B2 equivalence — duplicates (uniqueItems)', () => {
  it('rejects duplicate trace.design_option_refs under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['points', 0, 'trace', 'design_option_refs'], ['DO-001', 'DO-001'])
    setPath(newInvalid, ['points', 0, 'trace', 'design_option_refs'], ['DO-001', 'DO-001'])
    assertAgree(legacyInvalid, newInvalid, 'duplicate trace.design_option_refs')
  })

  it('rejects duplicate trace.supersedes under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['points', 0, 'trace', 'supersedes'], ['FP-001', 'FP-001'])
    setPath(newInvalid, ['points', 0, 'trace', 'supersedes'], ['FP-001', 'FP-001'])
    assertAgree(legacyInvalid, newInvalid, 'duplicate trace.supersedes')
  })

  it('accepts distinct trace.design_option_refs under both', () => {
    const legacyOk = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newOk = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyOk, ['points', 0, 'trace', 'design_option_refs'], ['DO-001', 'DO-002'])
    setPath(newOk, ['points', 0, 'trace', 'design_option_refs'], ['DO-001', 'DO-002'])
    assertAgree(legacyOk, newOk, 'distinct trace.design_option_refs')
  })
})

// ─── Invalid patterns ───────────────────────────────────────────────

describe('B2 equivalence — invalid patterns', () => {
  it('rejects a malformed FeaturePointRef (FP-1) under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['points', 0, 'ref'], 'FP-1')
    setPath(newInvalid, ['points', 0, 'ref'], 'FP-1')
    assertAgree(legacyInvalid, newInvalid, 'bad FeaturePointRef')
  })

  it('rejects a malformed DesignOptionRef (DOX) under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['design_decision', 'selected_option_refs'], ['DOX'])
    setPath(newInvalid, ['design_decision', 'selected_option_refs'], ['DOX'])
    assertAgree(legacyInvalid, newInvalid, 'bad DesignOptionRef')
  })

  it('rejects a malformed FeaturePointRef in trace.supersedes under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    setPath(legacyInvalid, ['points', 0, 'trace', 'supersedes'], ['FP-1'])
    setPath(newInvalid, ['points', 0, 'trace', 'supersedes'], ['FP-1'])
    assertAgree(legacyInvalid, newInvalid, 'bad supersedes FeaturePointRef')
  })
})

// ─── additionalProperties: false ────────────────────────────────────

describe('B2 equivalence — additionalProperties: false', () => {
  it('rejects an unknown top-level property under both', () => {
    const legacyInvalid = clone(loadFixture('feature-point-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('feature-point-set.valid.new.json'))
    ;(legacyInvalid as Record<string, unknown>).unexpected_extra = true
    ;(newInvalid as Record<string, unknown>).unexpected_extra = true
    assertAgree(legacyInvalid, newInvalid, 'extra top-level property')
  })
})

// ─── Converted draft-07 structure preservation ──────────────────────

describe('B2 equivalence — converted draft-07 JSON Schema preserves invariants', () => {
  const json = featurePointSetToJSONSchema() as Record<string, unknown>

  it('emits the legacy required fields and additionalProperties: false at the root', () => {
    assert.deepEqual(
      json.required,
      ['schema_version', 'topic', 'project', 'status', 'design_decision', 'points', 'context_summary'],
    )
    assert.equal(json.additionalProperties, false)
  })

  it('emits the confirmed if/then invariant (design_decision + no blocking questions/items)', () => {
    assert.ok(json.if, 'missing if')
    const ifProps = (json.if as Record<string, unknown>).properties as Record<string, unknown>
    assert.deepEqual(ifProps.status, { const: 'confirmed' })
    const then = json.then as Record<string, unknown>
    const dd = (then.properties as Record<string, unknown>).design_decision as Record<string, unknown>
    assert.deepEqual(dd.properties, {
      status: { enum: ['selected', 'combined', 'adjusted'] },
      selected_option_refs: { minItems: 1 },
    })
    // uniqueItems preserved at the base (unconditional) level.
    const ddBase = (json.properties as Record<string, unknown>).design_decision as Record<string, unknown>
    const sor = (ddBase.properties as Record<string, unknown>).selected_option_refs as Record<string, unknown>
    assert.equal(sor.uniqueItems, true)
  })

  it('emits the selected-point if/then invariant and uniqueItems on trace refs', () => {
    const points = (json.properties as Record<string, unknown>).points as Record<string, unknown>
    const point = points.items as Record<string, unknown>
    assert.equal(point.additionalProperties, false)
    assert.deepEqual(point.if, {
      properties: { status: { const: 'selected' } },
      required: ['status'],
    })
    const then = point.then as Record<string, unknown>
    assert.deepEqual(
      (then.properties as Record<string, unknown>).boundaries,
      { minItems: 1 },
    )
    const trace = (point.properties as Record<string, unknown>).trace as Record<string, unknown>
    const traceProps = trace.properties as Record<string, unknown>
    assert.equal(
      (traceProps.design_option_refs as Record<string, unknown>).uniqueItems,
      true,
    )
    assert.equal((traceProps.supersedes as Record<string, unknown>).uniqueItems, true)
  })

  it('emits the ref patterns (FP- / DO-) and the FeaturePoint minItems: 1 on points', () => {
    const points = (json.properties as Record<string, unknown>).points as Record<string, unknown>
    assert.equal(points.minItems, 1)
    const point = points.items as Record<string, unknown>
    assert.equal((point.properties as Record<string, unknown>).ref.pattern, '^FP-[0-9]{3,}$')
    const trace = (point.properties as Record<string, unknown>).trace as Record<string, unknown>
    const traceProps = trace.properties as Record<string, unknown>
    assert.equal(
      (traceProps.design_option_refs as Record<string, unknown>).items.pattern,
      '^DO-[0-9]{3,}$',
    )
  })
})
