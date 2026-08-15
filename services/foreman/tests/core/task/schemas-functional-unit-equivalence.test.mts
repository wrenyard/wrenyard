// @ts-nocheck
/**
 * Batch B2 — old-vs-new AJV equivalence tests for the Functional Unit protocol.
 *
 * Compiles the *legacy* draft-07 schema from `tests/fixtures/legacy-workspace-schemas/
 * functional-unit.schema.json` (which `$ref`s `shared.schema.json`,
 * `feature-point.schema.json`, and `inquiry.schema.json`) with AJV, and
 * compiles the *new* Zod-4 source of truth
 * (`lib/core/task/schemas/functional-unit.mts`) converted to draft-07 JSON
 * Schema with AJV. For a battery of valid and invalid documents it asserts
 * that the old and new validators AGREE on every structural invariant the B2
 * migration must preserve:
 *
 *   - required fields
 *   - enums (set status, unit status, contract kind, risk level/tags,
 *     verification, confidence, checkpoint status, review status/check_id,
 *     decomposition booleans)
 *   - string patterns (FU- refs; checkpoint confirmed_at timestamp)
 *   - minLength (topic, title, intent fields, capability, ...)
 *   - minItems (units; confirmed-unit design arrays; surfaces minItems 1)
 *   - additionalProperties: false (reject unknown keys)
 *   - if/then: confirmed unit -> checkpoint present + checkpoint.status
 *     confirmed, code_anchors>=1, acceptance>=1, contract fixed_decisions/
 *     must_not_decide >=1, all decomposition flags true, no unresolved
 *     blockers, no blocking open questions
 *   - allOf/if/then: review result approved|blocked => no issues;
 *     changes_required => >=1 issue
 *   - not/contains: confirmed unit => no blocking open questions
 *   - uniqueItems: scope.surfaces, dependencies.depends_on/blocks/
 *     conflicts_with/related, trace.supersedes, risk.tags
 *
 * The FU migration deliberately remaps several shared primitives:
 *
 *   - `ProjectRef`      -> `ProjectTarget`              { kind, value }
 *   - `EvidenceRef`     -> `Evidence`                   { id, source, observation }
 *   - `ContextEntry`    -> `ctx: string`                (decisions / exploration_findings)
 *   - `OpenQuestion`    -> `QuestionSchema`             { id, ask, blocking, options }
 *   - `CodeAnchor`      -> `Target` variant             { kind, value, project, ... }
 *   - `AcceptanceCriterion` (FU) -> common Given/When/Then
 *                           `AcceptanceCriterion`        { id, given, when, then }
 *   - `FunctionalUnitRef` -> `Ref<T>` patterned string  `^FU-[0-9]{3,}$`
 *
 * Those remaps change the *shape* of the document, so each equivalence case
 * carries an old-shaped document (validated by the legacy schema) and a
 * new-shaped document (validated by the converted schema); what must match
 * is the acceptance decision. The legacy `AC-` / `Q-` / project patterns are
 * intentionally *not* preserved (the mapped common concepts use plain
 * strings / open Targets), so equivalence cases only mutate invariants that
 * survive the remap identically.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import { describe, it } from 'node:test'

import { FunctionalUnitSetSchema, functionalUnitSetToJSONSchema } from '../../../lib/core/task/schemas/functional-unit.mts'
import { compileSchema } from '../../../lib/workspace/schema-loader.mts'

const here = dirname(fileURLToPath(import.meta.url))
const legacyDir = join(here, '..', '..', 'fixtures', 'legacy-workspace-schemas')
const fixtureDir = join(here, '..', '..', 'fixtures', 'migration-functional-unit')

const loadLegacy = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(legacyDir, name), 'utf8'))
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Old (legacy) validator ────────────────────────────────────────
//
// The legacy functional-unit schema pulls shared concepts from
// `shared.schema.json` (ProjectRef / EvidenceRef / ContextEntry), the
// acceptance `ref` from `feature-point.schema.json` (AcceptanceCriterionRef),
// and `OpenQuestion.ref` from `inquiry.schema.json` (QuestionRef). All three
// must be registered so AJV can resolve the external `$ref`s.

function buildOldAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false })
  ajv.addSchema(loadLegacy('shared.schema.json'))
  ajv.addSchema(loadLegacy('feature-point.schema.json'))
  ajv.addSchema(loadLegacy('inquiry.schema.json'))
  return ajv
}

const oldAjv = buildOldAjv()
const oldValidate = oldAjv.compile(loadLegacy('functional-unit.schema.json')) as ValidateFunction

// ─── New (Zod -> draft-07) validator ───────────────────────────────

const newAjv = new Ajv({ allErrors: true, strict: false })
const newValidate = newAjv.compile(functionalUnitSetToJSONSchema()) as ValidateFunction

// Runtime validator: the exported Zod schema compiled through the production
// `compileSchema` path (z.toJSONSchema -> AJV). Must enforce every B4
// invariant the helper enforces, so the runtime gap cannot recur.
const runtimeValidate = compileSchema(FunctionalUnitSetSchema).validate

/** Set a nested value in place along a simple key path. */
function setPath(doc: Record<string, unknown>, path: string[], value: unknown): void {
  let node: Record<string, unknown> = doc
  for (let i = 0; i < path.length - 1; i++) {
    node = node[path[i]] as Record<string, unknown>
  }
  node[path[path.length - 1]] = value
}

/** Delete a nested value along a simple key path. */
function delPath(doc: Record<string, unknown>, path: string[]): void {
  let node: Record<string, unknown> = doc
  for (let i = 0; i < path.length - 1; i++) {
    node = node[path[i]] as Record<string, unknown>
  }
  delete node[path[path.length - 1]]
}

/**
 * Assert the old and new validators reach the SAME acceptance decision for
 * the given old-shaped / new-shaped documents.
 */
function assertAgree(oldDoc: unknown, newDoc: unknown, label: string): void {
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

describe('B2 equivalence — valid functional unit set (old shape vs new shape)', () => {
  const legacyValid = loadFixture('functional-unit-set.valid.legacy.json')
  const newValid = loadFixture('functional-unit-set.valid.new.json')

  it('accepts a valid confirmed set with a confirmed unit under both old and new', () => {
    assertAgree(legacyValid, newValid, 'valid confirmed set')
  })

  it('accepts the same set with a draft unit under both old and new', () => {
    const legacyOk = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyOk, ['status'], 'draft')
    setPath(newOk, ['status'], 'draft')
    setPath(legacyOk, ['units', 0, 'status'], 'draft')
    setPath(newOk, ['units', 0, 'status'], 'draft')
    delPath(legacyOk, ['units', 0, 'checkpoint'])
    delPath(newOk, ['units', 0, 'checkpoint'])
    assertAgree(legacyOk, newOk, 'draft set with draft unit')
  })
})

// ─── Checkpoint requirements ────────────────────────────────────────

describe('B2 equivalence — checkpoint requirements (confirmed unit)', () => {
  it('rejects a confirmed unit without a checkpoint under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    delPath(legacyInvalid, ['units', 0, 'checkpoint'])
    delPath(newInvalid, ['units', 0, 'checkpoint'])
    assertAgree(legacyInvalid, newInvalid, 'confirmed unit missing checkpoint')
  })

  it('rejects a confirmed unit whose checkpoint.status is not confirmed under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'checkpoint', 'status'], 'pending')
    setPath(newInvalid, ['units', 0, 'checkpoint', 'status'], 'pending')
    assertAgree(legacyInvalid, newInvalid, 'confirmed unit checkpoint not confirmed')
  })
})

// ─── Blocking questions ─────────────────────────────────────────────

describe('B2 equivalence — blocking questions (confirmed unit)', () => {
  it('accepts a blocking open question when the unit is not confirmed (draft) under both', () => {
    const legacyOk = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyOk, ['units', 0, 'status'], 'draft')
    setPath(newOk, ['units', 0, 'status'], 'draft')
    delPath(legacyOk, ['units', 0, 'checkpoint'])
    delPath(newOk, ['units', 0, 'checkpoint'])
    setPath(legacyOk, ['units', 0, 'questions', 0, 'blocking'], true)
    setPath(newOk, ['units', 0, 'questions', 0, 'blocking'], true)
    assertAgree(legacyOk, newOk, 'draft unit + blocking open question')
  })

  it('rejects a confirmed unit with a blocking open question under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'questions', 0, 'blocking'], true)
    setPath(newInvalid, ['units', 0, 'questions', 0, 'blocking'], true)
    assertAgree(legacyInvalid, newInvalid, 'confirmed unit + blocking open question')
  })
})

// ─── Decomposition flags ────────────────────────────────────────────

describe('B2 equivalence — decomposition flags (confirmed unit)', () => {
  it('rejects a confirmed unit whose is_atomic is false under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'decomposition_check', 'is_atomic'], false)
    setPath(newInvalid, ['units', 0, 'decomposition_check', 'is_atomic'], false)
    assertAgree(legacyInvalid, newInvalid, 'confirmed unit is_atomic false')
  })

  it('rejects a confirmed unit with an unresolved blocker under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'decomposition_check', 'unresolved_blockers'], ['still blocked'])
    setPath(newInvalid, ['units', 0, 'decomposition_check', 'unresolved_blockers'], ['still blocked'])
    assertAgree(legacyInvalid, newInvalid, 'confirmed unit unresolved blocker')
  })

  it('rejects a confirmed unit with empty acceptance criteria under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'acceptance'], [])
    setPath(newInvalid, ['units', 0, 'acceptance'], [])
    assertAgree(legacyInvalid, newInvalid, 'confirmed unit empty acceptance')
  })

  it('rejects a confirmed unit with empty code_anchors under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'scope', 'code_anchors'], [])
    setPath(newInvalid, ['units', 0, 'scope', 'code_anchors'], [])
    assertAgree(legacyInvalid, newInvalid, 'confirmed unit empty code_anchors')
  })
})

// ─── Duplicate refs (uniqueItems) ──────────────────────────────────

describe('B2 equivalence — duplicate refs (uniqueItems)', () => {
  it('rejects duplicate dependencies.depends_on under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'dependencies', 'depends_on'], ['FU-002', 'FU-002'])
    setPath(newInvalid, ['units', 0, 'dependencies', 'depends_on'], ['FU-002', 'FU-002'])
    assertAgree(legacyInvalid, newInvalid, 'duplicate depends_on')
  })

  it('rejects duplicate scope.surfaces under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'scope', 'surfaces'], ['api', 'api'])
    setPath(newInvalid, ['units', 0, 'scope', 'surfaces'], ['api', 'api'])
    assertAgree(legacyInvalid, newInvalid, 'duplicate surfaces')
  })

  it('rejects an empty surfaces array (minItems 1) under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'scope', 'surfaces'], [])
    setPath(newInvalid, ['units', 0, 'scope', 'surfaces'], [])
    assertAgree(legacyInvalid, newInvalid, 'empty surfaces')
  })

  it('rejects duplicate risk.tags under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'risk', 'tags'], ['security', 'security'])
    setPath(newInvalid, ['units', 0, 'risk', 'tags'], ['security', 'security'])
    assertAgree(legacyInvalid, newInvalid, 'duplicate risk.tags')
  })

  it('rejects duplicate trace.supersedes under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'trace', 'supersedes'], ['FU-002', 'FU-002'])
    setPath(newInvalid, ['units', 0, 'trace', 'supersedes'], ['FU-002', 'FU-002'])
    assertAgree(legacyInvalid, newInvalid, 'duplicate trace.supersedes')
  })

  it('accepts distinct dependencies.blocks under both', () => {
    const legacyOk = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyOk, ['units', 0, 'dependencies', 'blocks'], ['FU-003', 'FU-004'])
    setPath(newOk, ['units', 0, 'dependencies', 'blocks'], ['FU-003', 'FU-004'])
    assertAgree(legacyOk, newOk, 'distinct blocks')
  })
})

// ─── Invalid patterns ──────────────────────────────────────────────

describe('B2 equivalence — invalid patterns', () => {
  it('rejects a malformed FunctionalUnitRef (FU-1) under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'ref'], 'FU-1')
    setPath(newInvalid, ['units', 0, 'ref'], 'FU-1')
    assertAgree(legacyInvalid, newInvalid, 'bad FunctionalUnitRef')
  })

  it('rejects a malformed FunctionalUnitRef inside dependencies under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'dependencies', 'depends_on'], ['FU-1'])
    setPath(newInvalid, ['units', 0, 'dependencies', 'depends_on'], ['FU-1'])
    assertAgree(legacyInvalid, newInvalid, 'bad depends_on FunctionalUnitRef')
  })

  it('rejects a malformed checkpoint confirmed_at timestamp under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'checkpoint', 'confirmed_at'], '2026-07-12')
    setPath(newInvalid, ['units', 0, 'checkpoint', 'confirmed_at'], '2026-07-12')
    assertAgree(legacyInvalid, newInvalid, 'bad confirmed_at pattern')
  })
})

// ─── additionalProperties: false ────────────────────────────────────

describe('B2 equivalence — additionalProperties: false', () => {
  it('rejects an unknown top-level property under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    ;(legacyInvalid as Record<string, unknown>).unexpected_extra = true
    ;(newInvalid as Record<string, unknown>).unexpected_extra = true
    assertAgree(legacyInvalid, newInvalid, 'extra top-level property')
  })

  it('rejects an unknown property inside a unit under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    ;(legacyInvalid.units as Record<string, unknown>[])[0].ghost_field = true
    ;(newInvalid.units as Record<string, unknown>[])[0].ghost_field = true
    assertAgree(legacyInvalid, newInvalid, 'extra unit property')
  })
})

// ─── Review-result conditional (allOf) ──────────────────────────────

describe('B2 equivalence — review result conditional (allOf)', () => {
  const baseReview = (): Record<string, unknown> => ({
    kind: 'fu',
    status: 'approved',
    issues: [],
    summary: 'looks good',
  })

  it('accepts an approved review with no issues under both', () => {
    const legacyOk = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('functional-unit-set.valid.new.json'))
    ;(legacyOk as Record<string, unknown>).review = baseReview()
    ;(newOk as Record<string, unknown>).review = baseReview()
    assertAgree(legacyOk, newOk, 'approved review no issues')
  })

  it('rejects an approved review that still carries issues under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    const r = baseReview()
    ;(r.issues as unknown[]) = [
      {
        target_ref: 'FU-001',
        check_id: 'fu_acceptance_missing',
        problem: 'p',
        required_change: 'c',
      },
    ]
    ;(legacyInvalid as Record<string, unknown>).review = r
    ;(newInvalid as Record<string, unknown>).review = r
    assertAgree(legacyInvalid, newInvalid, 'approved review with issues')
  })

  it('rejects a changes_required review with no issues under both', () => {
    const legacyInvalid = clone(loadFixture('functional-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('functional-unit-set.valid.new.json'))
    const r = baseReview()
    r.status = 'changes_required'
    ;(legacyInvalid as Record<string, unknown>).review = r
    ;(newInvalid as Record<string, unknown>).review = r
    assertAgree(legacyInvalid, newInvalid, 'changes_required review no issues')
  })
})

// ─── Converted draft-07 structure preservation ──────────────────────

describe('B2 equivalence — converted draft-07 JSON Schema preserves invariants', () => {
  const json = functionalUnitSetToJSONSchema() as Record<string, unknown>

  it('emits the legacy required fields and additionalProperties: false at the root', () => {
    assert.deepEqual(
      json.required,
      ['schema_version', 'topic', 'project', 'status', 'units', 'context_summary'],
    )
    assert.equal(json.additionalProperties, false)
  })

  it('emits the FU- ref pattern on units.items.ref', () => {
    const units = json.properties as Record<string, unknown>
    const items = (units.units as Record<string, unknown>).items as Record<string, unknown>
    assert.equal((items.properties as Record<string, unknown>).ref.pattern, '^FU-[0-9]{3,}$')
    assert.equal((units.units as Record<string, unknown>).minItems, 1)
  })

  it('emits the confirmed-unit if/then invariant (checkpoint + decomposition + no blocking)', () => {
    const units = json.properties as Record<string, unknown>
    const items = (units.units as Record<string, unknown>).items as Record<string, unknown>
    assert.ok(items.if, 'missing if')
    const ifProps = (items.if as Record<string, unknown>).properties as Record<string, unknown>
    assert.deepEqual(ifProps.status, { const: 'confirmed' })
    const then = items.then as Record<string, unknown>
    const thenProps = then.properties as Record<string, unknown>
    assert.ok((then.required as string[]).includes('checkpoint'))
    assert.deepEqual(
      (thenProps.checkpoint as Record<string, unknown>).properties,
      { status: { const: 'confirmed' } },
    )
    const decomp = (thenProps.decomposition_check as Record<string, unknown>)
      .properties as Record<string, unknown>
    assert.deepEqual(decomp.is_atomic, { const: true })
    assert.deepEqual(decomp.unresolved_blockers, { maxItems: 0 })
    const questions = thenProps.questions as Record<string, unknown>
    assert.ok(questions.not, 'missing not/contains on questions')
    assert.deepEqual(
      (questions.not as Record<string, unknown>).contains,
      {
        type: 'object',
        required: ['blocking'],
        properties: { blocking: { const: true } },
      },
    )
  })

  it('emits uniqueItems on surfaces, dependencies, trace.supersedes and risk.tags', () => {
    const units = json.properties as Record<string, unknown>
    const items = (units.units as Record<string, unknown>).items as Record<string, unknown>
    const itemProps = items.properties as Record<string, unknown>
    assert.equal(
      (itemProps.scope as Record<string, unknown>).properties.surfaces.uniqueItems,
      true,
    )
    assert.equal(
      ((itemProps.scope as Record<string, unknown>).properties.surfaces as Record<string, unknown>)
        .minItems,
      1,
    )
    const deps = (itemProps.dependencies as Record<string, unknown>)
      .properties as Record<string, unknown>
    for (const k of ['depends_on', 'blocks', 'conflicts_with', 'related']) {
      assert.equal((deps[k] as Record<string, unknown>).uniqueItems, true)
    }
    const trace = (itemProps.trace as Record<string, unknown>).properties as Record<string, unknown>
    assert.equal((trace.supersedes as Record<string, unknown>).uniqueItems, true)
    const risk = (itemProps.risk as Record<string, unknown>).properties as Record<string, unknown>
    assert.equal((risk.tags as Record<string, unknown>).uniqueItems, true)
  })

  it('emits the review-result allOf conditional (approved|blocked => 0 issues; changes_required => >=1)', () => {
    const review = (json.properties as Record<string, unknown>).review as Record<string, unknown>
    const allOf = review.allOf as Record<string, unknown>[]
    assert.ok(Array.isArray(allOf) && allOf.length === 2, 'missing allOf with 2 branches')
    assert.deepEqual(
      (allOf[0].if as Record<string, unknown>).properties,
      { status: { enum: ['approved', 'blocked'] } },
    )
    assert.deepEqual(
      (allOf[0].then as Record<string, unknown>).properties,
      { issues: { maxItems: 0 } },
    )
    assert.deepEqual(
      (allOf[1].if as Record<string, unknown>).properties,
      { status: { const: 'changes_required' } },
    )
    assert.deepEqual(
      (allOf[1].then as Record<string, unknown>).properties,
      { issues: { minItems: 1 } },
    )
  })
})
