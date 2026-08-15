// @ts-nocheck
/**
 * Implementation Plan — old-vs-new AJV equivalence tests.
 *
 * Compiles the *legacy* draft-07 schema from `tests/fixtures/legacy-workspace-schemas/
 * implementation-plan.schema.json` (which `$ref`s `shared.schema.json`,
 * `feature-point.schema.json`, `functional-unit.schema.json`,
 * `implementation-unit.schema.json`, `verification.schema.json`, and
 * `edit.schema.json`) with AJV, and compiles the *new* Zod-4 source of
 * truth (`lib/core/task/schemas/implementation-plan.mts`) converted to
 * draft-07 JSON Schema with AJV. For a battery of valid and invalid
 * documents it asserts that the old and new validators AGREE on every
 * structural invariant the migration must preserve:
 *
 *   - required fields (root plan + plan-domain nodes)
 *   - enums (plan status, commit mode)
 *   - string patterns (FP- / FU- / IU- refs)
 *   - minLength / minItems (topic, functional_units, implementation_units,
 *     verification, edit)
 *   - additionalProperties: false (reject unknown keys)
 *   - uniqueItems: depends_on (ImplementationUnitRef)
 *   - execution policy bounds (repair_rounds 0..2)
 *
 * The new schema deliberately remaps several shared primitives:
 *
 *   - `ProjectName`           -> `ProjectTarget`             { kind, value }
 *   - `FeaturePointRef`       -> `Ref<T>` patterned string   `^FP-[0-9]{3,}$`
 *   - `FunctionalUnitRef`     -> `Ref<T>` patterned string   `^FU-[0-9]{3,}$`
 *   - `ImplementationUnitRef` -> `Ref<T>` patterned string   `^IU-[0-9]{3,}$`
 *   - `VerificationItem`      -> common `AcceptanceCriterion`{ id, when, then }
 *   - `EditInstructionSet` / `EditFileInstruction`
 *                             -> `ChangeSchema` arrays
 *
 * Those remaps change the *shape* of the document, so each equivalence case
 * carries an old-shaped document (validated by the legacy schema) and a
 * new-shaped document (validated by the converted schema); what must match
 * is the acceptance decision.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import { describe, it } from 'node:test'

import { compileSchema } from '../../../lib/workspace/schema-loader.mts'
import { ImplementationPlanSchema, implementationPlanToJSONSchema } from '../../../lib/core/task/schemas/implementation-plan.mts'

const here = dirname(fileURLToPath(import.meta.url))
const legacyDir = join(here, '..', '..', 'fixtures', 'legacy-workspace-schemas')
const fixtureDir = join(here, '..', '..', 'fixtures', 'migration-implementation-plan')

const loadLegacy = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(legacyDir, name), 'utf8'))
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Old (legacy) validator ────────────────────────────────────────
//
// The legacy implementation-plan schema pulls shared concepts from several
// external schemas; all must be registered so AJV can resolve the external
// `$ref`s.

function buildOldAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false })
  ajv.addSchema(loadLegacy('shared.schema.json'))
  ajv.addSchema(loadLegacy('inquiry.schema.json'))
  ajv.addSchema(loadLegacy('feature-point.schema.json'))
  ajv.addSchema(loadLegacy('functional-unit.schema.json'))
  ajv.addSchema(loadLegacy('implementation-unit.schema.json'))
  ajv.addSchema(loadLegacy('verification.schema.json'))
  ajv.addSchema(loadLegacy('edit.schema.json'))
  return ajv
}

const oldAjv = buildOldAjv()
const oldValidate = oldAjv.compile(loadLegacy('implementation-plan.schema.json')) as ValidateFunction

// ─── New (Zod -> draft-07) validator ───────────────────────────────
// Self-contained: all FP/FU/IU snapshots are inlined.

const newAjv = new Ajv({ allErrors: true, strict: false })
const newValidate = newAjv.compile(implementationPlanToJSONSchema()) as ValidateFunction

// ─── Runtime (Zod -> AJV via compileSchema) validator ────────────────

const runtimeValidate = compileSchema(ImplementationPlanSchema).validate

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
 * Assert the old, new, and runtime validators all reach the SAME acceptance
 * decision for the given old-shaped / new-shaped documents.
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
    oldOk,
    runtimeOk,
    `runtime divergence on "${label}": old=${oldOk} runtime=${runtimeOk}\n` +
      `  old errors: ${JSON.stringify(oldValidate.errors)}\n` +
      `  runtime errors: ${JSON.stringify(runtimeValidate.errors)}`,
  )
}

// ─── Valid plan ─────────────────────────────────────────────────────

describe('Implementation Plan equivalence — valid plan', () => {
  it('accepts a valid approved plan under both old and new', () => {
    assertAgree(
      loadFixture('implementation-plan.valid.legacy.json'),
      loadFixture('implementation-plan.valid.new.json'),
      'valid approved plan',
    )
  })

  it('accepts a draft plan (execution_policy optional) under both', () => {
    const legacyOk = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyOk, ['status'], 'draft')
    setPath(newOk, ['status'], 'draft')
    delPath(legacyOk, ['execution_policy'])
    delPath(newOk, ['execution_policy'])
    assertAgree(legacyOk, newOk, 'draft plan without execution_policy')
  })
})

// ─── Missing nodes ──────────────────────────────────────────────────

describe('Implementation Plan equivalence — missing nodes', () => {
  it('rejects a plan missing the functional_units array under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    delPath(legacyInvalid, ['functional_units'])
    delPath(newInvalid, ['functional_units'])
    assertAgree(legacyInvalid, newInvalid, 'missing functional_units')
  })

  it('rejects a FU node missing implementation_units under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    delPath(legacyInvalid, ['functional_units', 0, 'implementation_units'])
    delPath(newInvalid, ['functional_units', 0, 'implementation_units'])
    assertAgree(legacyInvalid, newInvalid, 'missing implementation_units')
  })

  it('rejects a FU node missing verification under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    delPath(legacyInvalid, ['functional_units', 0, 'verification'])
    delPath(newInvalid, ['functional_units', 0, 'verification'])
    assertAgree(legacyInvalid, newInvalid, 'missing verification')
  })

  it('rejects a plan missing commit_strategy under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    delPath(legacyInvalid, ['commit_strategy'])
    delPath(newInvalid, ['commit_strategy'])
    assertAgree(legacyInvalid, newInvalid, 'missing commit_strategy')
  })
})

// ─── Invalid refs (patterns) ────────────────────────────────────────

describe('Implementation Plan equivalence — invalid refs', () => {
  it('rejects a malformed FeaturePointRef in source.feature_point_ref under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyInvalid, ['source', 'feature_point_ref'], 'FP-1')
    setPath(newInvalid, ['source', 'feature_point_ref'], 'FP-1')
    assertAgree(legacyInvalid, newInvalid, 'bad source.feature_point_ref')
  })

  it('rejects a malformed FunctionalUnitRef in functional_unit.ref under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyInvalid, ['functional_units', 0, 'functional_unit', 'ref'], 'FU-1')
    setPath(newInvalid, ['functional_units', 0, 'functional_unit', 'ref'], 'FU-1')
    assertAgree(legacyInvalid, newInvalid, 'bad functional_unit.ref')
  })

  it('rejects a malformed ImplementationUnitRef in implementation_unit.ref under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyInvalid, ['functional_units', 0, 'implementation_units', 0, 'implementation_unit', 'ref'], 'IU-1')
    setPath(newInvalid, ['functional_units', 0, 'implementation_units', 0, 'implementation_unit', 'ref'], 'IU-1')
    assertAgree(legacyInvalid, newInvalid, 'bad implementation_unit.ref')
  })

  it('rejects a malformed ImplementationUnitRef inside depends_on under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyInvalid, ['functional_units', 0, 'implementation_units', 0, 'depends_on'], ['IU-1'])
    setPath(newInvalid, ['functional_units', 0, 'implementation_units', 0, 'depends_on'], ['IU-1'])
    assertAgree(legacyInvalid, newInvalid, 'bad depends_on ref')
  })
})

// ─── Duplicate dependencies (uniqueItems) ──────────────────────────

describe('Implementation Plan equivalence — duplicate dependencies (uniqueItems)', () => {
  it('rejects duplicate depends_on refs under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyInvalid, ['functional_units', 0, 'implementation_units', 0, 'depends_on'], ['IU-001', 'IU-001'])
    setPath(newInvalid, ['functional_units', 0, 'implementation_units', 0, 'depends_on'], ['IU-001', 'IU-001'])
    assertAgree(legacyInvalid, newInvalid, 'duplicate depends_on')
  })

  it('accepts a distinct depends_on ref under both', () => {
    const legacyOk = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyOk, ['functional_units', 0, 'implementation_units', 0, 'depends_on'], ['IU-002'])
    setPath(newOk, ['functional_units', 0, 'implementation_units', 0, 'depends_on'], ['IU-002'])
    assertAgree(legacyOk, newOk, 'distinct depends_on')
  })
})

// ─── Empty edit / verification (minItems) ──────────────────────────

describe('Implementation Plan equivalence — empty edit / verification (minItems)', () => {
  it('rejects an empty edit instruction set under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    // Legacy: EditInstructionSet with empty files[]; New: ChangeSchema[] empty.
    setPath(legacyInvalid, ['functional_units', 0, 'implementation_units', 0, 'edit', 'files'], [])
    setPath(newInvalid, ['functional_units', 0, 'implementation_units', 0, 'edit'], [])
    assertAgree(legacyInvalid, newInvalid, 'empty edit')
  })

  it('rejects an empty verification array under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyInvalid, ['functional_units', 0, 'verification'], [])
    setPath(newInvalid, ['functional_units', 0, 'verification'], [])
    assertAgree(legacyInvalid, newInvalid, 'empty verification')
  })
})

// ─── Execution policy bounds ───────────────────────────────────────

describe('Implementation Plan equivalence — execution policy bounds', () => {
  it('rejects repair_rounds above the max (3) under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyInvalid, ['execution_policy', 'repair_rounds'], 3)
    setPath(newInvalid, ['execution_policy', 'repair_rounds'], 3)
    assertAgree(legacyInvalid, newInvalid, 'repair_rounds 3')
  })

  it('rejects repair_rounds below the min (-1) under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyInvalid, ['execution_policy', 'repair_rounds'], -1)
    setPath(newInvalid, ['execution_policy', 'repair_rounds'], -1)
    assertAgree(legacyInvalid, newInvalid, 'repair_rounds -1')
  })

  it('accepts repair_rounds at the upper bound (2) under both', () => {
    const legacyOk = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyOk, ['execution_policy', 'repair_rounds'], 2)
    setPath(newOk, ['execution_policy', 'repair_rounds'], 2)
    assertAgree(legacyOk, newOk, 'repair_rounds 2')
  })

  it('accepts repair_rounds at the lower bound (0) under both', () => {
    const legacyOk = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-plan.valid.new.json'))
    setPath(legacyOk, ['execution_policy', 'repair_rounds'], 0)
    setPath(newOk, ['execution_policy', 'repair_rounds'], 0)
    assertAgree(legacyOk, newOk, 'repair_rounds 0')
  })
})

// ─── additionalProperties: false ────────────────────────────────────

describe('Implementation Plan equivalence — additionalProperties: false', () => {
  it('rejects an unknown top-level property under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    ;(legacyInvalid as Record<string, unknown>).unexpected_extra = true
    ;(newInvalid as Record<string, unknown>).unexpected_extra = true
    assertAgree(legacyInvalid, newInvalid, 'extra top-level property')
  })

  it('rejects an unknown property inside a FU execution node under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-plan.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-plan.valid.new.json'))
    ;(legacyInvalid.functional_units as Record<string, unknown>[])[0].ghost_field = true
    ;(newInvalid.functional_units as Record<string, unknown>[])[0].ghost_field = true
    assertAgree(legacyInvalid, newInvalid, 'extra functional unit node property')
  })
})

// ─── Converted draft-07 structure preservation ──────────────────────

describe('Implementation Plan equivalence — converted draft-07 JSON Schema preserves invariants', () => {
  const json = implementationPlanToJSONSchema() as Record<string, unknown>

  it('emits the legacy required fields and additionalProperties: false at the root', () => {
    assert.deepEqual(json.required, [
      'schema_version',
      'status',
      'topic',
      'project',
      'source',
      'feature_point',
      'functional_units',
      'commit_strategy',
    ])
    assert.equal(json.additionalProperties, false)
  })

  it('emits the plan schema_version const and status enum', () => {
    assert.deepEqual((json.properties as Record<string, unknown>).schema_version, {
      type: 'string',
      const: 'implementation-plan/v1',
    })
    assert.deepEqual((json.properties as Record<string, unknown>).status.enum, [
      'draft',
      'reviewed',
      'approved',
    ])
  })

  it('emits the FP- ref pattern on source.feature_point_ref', () => {
    const source = (json.properties as Record<string, unknown>).source as Record<string, unknown>
    assert.equal((source.properties as Record<string, unknown>).feature_point_ref.pattern, '^FP-[0-9]{3,}$')
    assert.deepEqual(source.required, ['spec_path', 'feature_point_ref', 'functional_unit_set_ref'])
    assert.equal(source.additionalProperties, false)
  })

  it('emits the functional_units minItems:1 and FU node additionalProperties:false', () => {
    const fu = (json.properties as Record<string, unknown>).functional_units as Record<string, unknown>
    assert.equal(fu.minItems, 1)
    const fuNode = fu.items as Record<string, unknown>
    assert.equal(fuNode.additionalProperties, false)
    assert.equal(
      (fuNode.properties as Record<string, unknown>).functional_unit.properties.ref.pattern,
      '^FU-[0-9]{3,}$',
    )
    assert.equal(
      (fuNode.properties as Record<string, unknown>).implementation_units.minItems,
      1,
    )
  })

  it('emits the IU- ref pattern on implementation_unit.ref', () => {
    const fu = (json.properties as Record<string, unknown>).functional_units as Record<string, unknown>
    const fuNode = fu.items as Record<string, unknown>
    const execUnit = (fuNode.properties as Record<string, unknown>)
      .implementation_units.items as Record<string, unknown>
    assert.equal(
      (execUnit.properties as Record<string, unknown>).implementation_unit.properties.ref.pattern,
      '^IU-[0-9]{3,}$',
    )
  })

  it('emits uniqueItems:true on depends_on with the IU- ref pattern', () => {
    const fu = (json.properties as Record<string, unknown>).functional_units as Record<string, unknown>
    const fuNode = fu.items as Record<string, unknown>
    const execUnit = (fuNode.properties as Record<string, unknown>)
      .implementation_units.items as Record<string, unknown>
    const dependsOn = (execUnit.properties as Record<string, unknown>).depends_on as Record<string, unknown>
    assert.equal(dependsOn.uniqueItems, true)
    assert.equal((dependsOn.items as Record<string, unknown>).pattern, '^IU-[0-9]{3,}$')
  })

  it('emits AcceptanceCriterion (id/when/then) for verification items with minItems:1', () => {
    const fu = (json.properties as Record<string, unknown>).functional_units as Record<string, unknown>
    const fuNode = fu.items as Record<string, unknown>
    const verification = (fuNode.properties as Record<string, unknown>)
      .verification as Record<string, unknown>
    assert.equal(verification.minItems, 1)
    const item = verification.items as Record<string, unknown>
    assert.ok(item.properties.id, 'missing id')
    assert.ok(item.properties.when, 'missing when')
    assert.ok(item.properties.then, 'missing then')
  })

  it('emits ChangeSchema (target/action/instruction/expected) for edit with minItems:1', () => {
    const fu = (json.properties as Record<string, unknown>).functional_units as Record<string, unknown>
    const fuNode = fu.items as Record<string, unknown>
    const execUnit = (fuNode.properties as Record<string, unknown>)
      .implementation_units.items as Record<string, unknown>
    const edit = (execUnit.properties as Record<string, unknown>).edit as Record<string, unknown>
    assert.equal(edit.minItems, 1)
    const change = edit.items as Record<string, unknown>
    assert.ok(change.properties.target, 'missing target')
    assert.deepEqual(change.properties.action.enum, ['create', 'update', 'remove'])
    assert.ok(change.properties.instruction, 'missing instruction')
    assert.ok(change.properties.expected, 'missing expected')
  })

  it('emits the execution policy repair_rounds bounds (0..2)', () => {
    const ep = (json.properties as Record<string, unknown>).execution_policy as Record<string, unknown>
    const repair = (ep.properties as Record<string, unknown>).repair_rounds as Record<string, unknown>
    assert.equal(repair.minimum, 0)
    assert.equal(repair.maximum, 2)
    assert.equal(ep.additionalProperties, false)
  })

  it('emits the commit strategy mode enum and required fields', () => {
    const cs = (json.properties as Record<string, unknown>).commit_strategy as Record<string, unknown>
    assert.deepEqual(cs.required, ['mode', 'message_hint'])
    assert.deepEqual((cs.properties as Record<string, unknown>).mode.enum, ['commit_per_functional_unit'])
    assert.equal(cs.additionalProperties, false)
  })

  it('emits ProjectTarget (kind/value) for project', () => {
    assert.deepEqual((json.properties as Record<string, unknown>).project, {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'project' },
        value: { type: 'string' },
      },
      required: ['kind', 'value'],
      additionalProperties: false,
    })
  })
})
