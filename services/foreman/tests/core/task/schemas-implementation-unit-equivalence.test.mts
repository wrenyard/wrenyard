// @ts-nocheck
/**
 * Batch B1 (IU) — old-vs-new AJV equivalence tests for the Implementation
 * Unit protocol.
 *
 * Compiles the *legacy* draft-07 schema from `tests/fixtures/legacy-workspace-schemas/
 * implementation-unit.schema.json` (which `$ref`s `shared.schema.json` for
 * `ProjectRef`/`EvidenceRef` and `functional-unit.schema.json` for
 * `FunctionalUnitRef`) with AJV, and compiles the *new* Zod-4 source of
 * truth (`lib/core/task/schemas/implementation-unit.mts`) converted to
 * draft-07 JSON Schema with AJV. For a battery of valid and invalid
 * documents it asserts that the old and new validators AGREE on every
 * structural invariant the B1 migration must preserve:
 *
 *   - required fields
 *   - enums (set status, unit status, summary confidence, risk level,
 *     symbol kind)
 *   - string patterns (IU- / FU- refs)
 *   - minLength / maxLength (topic, title, purpose, path, ...)
 *   - minItems (units, functional_unit_refs, scopes)
 *   - additionalProperties: false (reject unknown keys)
 *   - if/then: ready unit -> all decomposition flags true and no unresolved
 *     blockers
 *   - uniqueItems: functional_unit_refs
 *
 * The IU migration deliberately remaps several shared primitives:
 *
 *   - `ProjectRef`      -> `ProjectTarget`              { kind, value }
 *   - `EvidenceRef`     -> `Evidence`                   { id, source, observation }
 *   - `ImplementationUnitRef` -> `Ref<T>` patterned string  `^IU-[0-9]{3,}$`
 *   - `FunctionalUnitRef`    -> `Ref<T>` patterned string  `^FU-[0-9]{3,}$`
 *   - `SymbolRef`       -> `SymbolTarget`               { kind:'symbol', value }
 *                              (+ legacy symbol `kind` enum as `symbol_kind`)
 *   - `VerificationItem` -> common `AcceptanceCriterion`  { id, when, then }
 *                              (brief -> when, expected -> then)
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
import { ImplementationUnitSetSchema, implementationUnitSetToJSONSchema } from '../../../lib/core/task/schemas/implementation-unit.mts'

const here = dirname(fileURLToPath(import.meta.url))
const legacyDir = join(here, '..', '..', 'fixtures', 'legacy-workspace-schemas')
const fixtureDir = join(here, '..', '..', 'fixtures', 'migration-implementation-unit')

const loadLegacy = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(legacyDir, name), 'utf8'))
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Old (legacy) validator ────────────────────────────────────────
//
// The legacy implementation-unit schema pulls shared concepts from
// `shared.schema.json` (ProjectRef / EvidenceRef) and the
// `FunctionalUnitRef` from `functional-unit.schema.json`. Both (and the
// schemas functional-unit itself references) must be registered so AJV can
// resolve the external `$ref`s.

function buildOldAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false })
  ajv.addSchema(loadLegacy('shared.schema.json'))
  ajv.addSchema(loadLegacy('feature-point.schema.json'))
  ajv.addSchema(loadLegacy('inquiry.schema.json'))
  ajv.addSchema(loadLegacy('functional-unit.schema.json'))
  return ajv
}

const oldAjv = buildOldAjv()
const oldValidate = oldAjv.compile(loadLegacy('implementation-unit.schema.json')) as ValidateFunction

// ─── New (Zod -> draft-07) validator ───────────────────────────────

const newAjv = new Ajv({ allErrors: true, strict: false })
const newValidate = newAjv.compile(implementationUnitSetToJSONSchema()) as ValidateFunction

// ─── Runtime (Zod -> AJV via compileSchema) validator ────────────────

const runtimeValidate = compileSchema(ImplementationUnitSetSchema).validate

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

// ─── Ready / blocked units ──────────────────────────────────────────

describe('B1 equivalence — ready / blocked units', () => {
  it('accepts a valid ready set under both old and new', () => {
    assertAgree(
      loadFixture('implementation-unit-set.valid.legacy.json'),
      loadFixture('implementation-unit-set.valid.new.json'),
      'valid ready set',
    )
  })

  it('accepts a blocked set with relaxed decomposition flags under both', () => {
    const legacyOk = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyOk, ['status'], 'blocked')
    setPath(newOk, ['status'], 'blocked')
    setPath(legacyOk, ['units', 0, 'status'], 'blocked')
    setPath(newOk, ['units', 0, 'status'], 'blocked')
    setPath(legacyOk, ['units', 0, 'decomposition_check', 'can_decompose_independently'], false)
    setPath(newOk, ['units', 0, 'decomposition_check', 'can_decompose_independently'], false)
    setPath(legacyOk, ['units', 0, 'decomposition_check', 'has_bounded_scope'], false)
    setPath(newOk, ['units', 0, 'decomposition_check', 'has_bounded_scope'], false)
    setPath(legacyOk, ['units', 0, 'decomposition_check', 'unresolved_blockers'], ['awaiting decision'])
    setPath(newOk, ['units', 0, 'decomposition_check', 'unresolved_blockers'], ['awaiting decision'])
    assertAgree(legacyOk, newOk, 'blocked set with relaxed decomposition')
  })

  it('accepts a needs_more_evidence set under both', () => {
    const legacyOk = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyOk, ['status'], 'needs_more_evidence')
    setPath(newOk, ['status'], 'needs_more_evidence')
    setPath(legacyOk, ['units', 0, 'status'], 'needs_more_evidence')
    setPath(newOk, ['units', 0, 'status'], 'needs_more_evidence')
    assertAgree(legacyOk, newOk, 'needs_more_evidence set')
  })
})

// ─── Decomposition flags (ready unit) ───────────────────────────────

describe('B1 equivalence — decomposition flags (ready unit)', () => {
  it('rejects a ready unit whose can_decompose_independently is false under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'decomposition_check', 'can_decompose_independently'], false)
    setPath(newInvalid, ['units', 0, 'decomposition_check', 'can_decompose_independently'], false)
    assertAgree(legacyInvalid, newInvalid, 'ready unit can_decompose_independently false')
  })

  it('rejects a ready unit whose has_test_strategy is false under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'decomposition_check', 'has_test_strategy'], false)
    setPath(newInvalid, ['units', 0, 'decomposition_check', 'has_test_strategy'], false)
    assertAgree(legacyInvalid, newInvalid, 'ready unit has_test_strategy false')
  })

  it('rejects a ready unit with an unresolved blocker under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'decomposition_check', 'unresolved_blockers'], ['still blocked'])
    setPath(newInvalid, ['units', 0, 'decomposition_check', 'unresolved_blockers'], ['still blocked'])
    assertAgree(legacyInvalid, newInvalid, 'ready unit unresolved blocker')
  })

  it('accepts a blocked unit with a false decomposition flag (no if/then) under both', () => {
    const legacyOk = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyOk, ['status'], 'blocked')
    setPath(newOk, ['status'], 'blocked')
    setPath(legacyOk, ['units', 0, 'status'], 'blocked')
    setPath(newOk, ['units', 0, 'status'], 'blocked')
    setPath(legacyOk, ['units', 0, 'decomposition_check', 'can_decompose_independently'], false)
    setPath(newOk, ['units', 0, 'decomposition_check', 'can_decompose_independently'], false)
    assertAgree(legacyOk, newOk, 'blocked unit relaxed flag')
  })
})

// ─── Duplicate refs (uniqueItems) ──────────────────────────────────

describe('B1 equivalence — duplicate refs (uniqueItems on functional_unit_refs)', () => {
  it('rejects duplicate functional_unit_refs under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'functional_unit_refs'], ['FU-001', 'FU-001'])
    setPath(newInvalid, ['units', 0, 'functional_unit_refs'], ['FU-001', 'FU-001'])
    assertAgree(legacyInvalid, newInvalid, 'duplicate functional_unit_refs')
  })

  it('accepts distinct functional_unit_refs under both', () => {
    const legacyOk = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyOk, ['units', 0, 'functional_unit_refs'], ['FU-001', 'FU-002'])
    setPath(newOk, ['units', 0, 'functional_unit_refs'], ['FU-001', 'FU-002'])
    assertAgree(legacyOk, newOk, 'distinct functional_unit_refs')
  })

  it('rejects an empty functional_unit_refs array (minItems 1) under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'functional_unit_refs'], [])
    setPath(newInvalid, ['units', 0, 'functional_unit_refs'], [])
    assertAgree(legacyInvalid, newInvalid, 'empty functional_unit_refs')
  })
})

// ─── Verification mapping (brief->when, expected->then) ─────────────

describe('B1 equivalence — verification mapping (VerificationItem -> AcceptanceCriterion)', () => {
  it('rejects a verification item missing expected (legacy) / when (new) under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    delPath(legacyInvalid, ['verification', 0, 'expected'])
    delPath(newInvalid, ['verification', 0, 'when'])
    assertAgree(legacyInvalid, newInvalid, 'verification missing expected/when')
  })

  it('rejects a verification item missing brief (legacy) / then (new) under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    delPath(legacyInvalid, ['verification', 0, 'brief'])
    delPath(newInvalid, ['verification', 0, 'then'])
    assertAgree(legacyInvalid, newInvalid, 'verification missing brief/then')
  })

  it('accepts a verification item with a get/then and an extra given (new) under both', () => {
    const legacyOk = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newOk = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(newOk, ['verification', 0, 'given'], 'given a warm cache')
    assertAgree(legacyOk, newOk, 'verification with optional given')
  })
})

// ─── Invalid patterns ──────────────────────────────────────────────

describe('B1 equivalence — invalid patterns', () => {
  it('rejects a malformed ImplementationUnitRef (IU-1) under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'ref'], 'IU-1')
    setPath(newInvalid, ['units', 0, 'ref'], 'IU-1')
    assertAgree(legacyInvalid, newInvalid, 'bad ImplementationUnitRef')
  })

  it('rejects a malformed FunctionalUnitRef (FU-1) inside functional_unit_refs under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'functional_unit_refs'], ['FU-1'])
    setPath(newInvalid, ['units', 0, 'functional_unit_refs'], ['FU-1'])
    assertAgree(legacyInvalid, newInvalid, 'bad FunctionalUnitRef in refs')
  })

  it('rejects an out-of-enum symbol kind (legacy kind / new symbol_kind) under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'scopes', 0, 'symbols', 0, 'kind'], 'nonsense')
    setPath(newInvalid, ['units', 0, 'scopes', 0, 'symbols', 0, 'symbol_kind'], 'nonsense')
    assertAgree(legacyInvalid, newInvalid, 'bad symbol kind enum')
  })

  it('rejects an empty unit title (minLength 1) under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    setPath(legacyInvalid, ['units', 0, 'title'], '')
    setPath(newInvalid, ['units', 0, 'title'], '')
    assertAgree(legacyInvalid, newInvalid, 'empty unit title')
  })
})

// ─── additionalProperties: false ────────────────────────────────────

describe('B1 equivalence — additionalProperties: false', () => {
  it('rejects an unknown top-level property under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    ;(legacyInvalid as Record<string, unknown>).unexpected_extra = true
    ;(newInvalid as Record<string, unknown>).unexpected_extra = true
    assertAgree(legacyInvalid, newInvalid, 'extra top-level property')
  })

  it('rejects an unknown property inside a unit under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    ;(legacyInvalid.units as Record<string, unknown>[])[0].ghost_field = true
    ;(newInvalid.units as Record<string, unknown>[])[0].ghost_field = true
    assertAgree(legacyInvalid, newInvalid, 'extra unit property')
  })

  it('rejects an unknown property inside an evidence item under both', () => {
    const legacyInvalid = clone(loadFixture('implementation-unit-set.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implementation-unit-set.valid.new.json'))
    ;(legacyInvalid.units as Record<string, unknown>[])[0].evidence[0].ghost = true
    ;(newInvalid.units as Record<string, unknown>[])[0].evidence[0].ghost = true
    assertAgree(legacyInvalid, newInvalid, 'extra evidence property')
  })
})

// ─── Converted draft-07 structure preservation ──────────────────────

describe('B1 equivalence — converted draft-07 JSON Schema preserves invariants', () => {
  const json = implementationUnitSetToJSONSchema() as Record<string, unknown>

  it('emits the legacy required fields and additionalProperties: false at the root', () => {
    assert.deepEqual(json.required, [
      'schema_version',
      'topic',
      'project',
      'status',
      'summary',
      'units',
      'verification',
    ])
    assert.equal(json.additionalProperties, false)
  })

  it('emits the IU- ref pattern on units.items.ref and minItems 1 on units', () => {
    const units = (json.properties as Record<string, unknown>).units as Record<string, unknown>
    const items = units.items as Record<string, unknown>
    assert.equal((items.properties as Record<string, unknown>).ref.pattern, '^IU-[0-9]{3,}$')
    assert.equal(units.minItems, 1)
  })

  it('emits the FU- ref pattern on units.items.functional_unit_refs', () => {
    const items = ((json.properties as Record<string, unknown>).units as Record<string, unknown>)
      .items as Record<string, unknown>
    const fur = (items.properties as Record<string, unknown>)
      .functional_unit_refs as Record<string, unknown>
    assert.equal((fur.items as Record<string, unknown>).pattern, '^FU-[0-9]{3,}$')
    assert.equal(fur.minItems, 1)
  })

  it('emits uniqueItems: true on functional_unit_refs', () => {
    const items = ((json.properties as Record<string, unknown>).units as Record<string, unknown>)
      .items as Record<string, unknown>
    const fur = (items.properties as Record<string, unknown>)
      .functional_unit_refs as Record<string, unknown>
    assert.equal(fur.uniqueItems, true)
  })

  it('emits the ready-unit if/then invariant (all decomposition flags true, no blockers)', () => {
    const items = ((json.properties as Record<string, unknown>).units as Record<string, unknown>)
      .items as Record<string, unknown>
    assert.ok(items.if, 'missing if')
    const ifProps = (items.if as Record<string, unknown>).properties as Record<string, unknown>
    assert.deepEqual(ifProps.status, { const: 'ready' })
    const then = items.then as Record<string, unknown>
    const decomp = (then.properties as Record<string, unknown>).decomposition_check as Record<string, unknown>
    const decompProps = decomp.properties as Record<string, unknown>
    assert.deepEqual(decompProps.can_decompose_independently, { const: true })
    assert.deepEqual(decompProps.has_bounded_scope, { const: true })
    assert.deepEqual(decompProps.has_test_strategy, { const: true })
    assert.deepEqual(decompProps.preserves_functional_unit_trace, { const: true })
    assert.deepEqual(decompProps.unresolved_blockers, { maxItems: 0 })
  })

  it('emits ProjectTarget (kind/value) for project and scope.project', () => {
    const expected = {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'project' },
        value: { type: 'string' },
      },
      required: ['kind', 'value'],
      additionalProperties: false,
    }
    const props = json.properties as Record<string, unknown>
    assert.deepEqual(props.project, expected)
    const items = (props.units as Record<string, unknown>).items as Record<string, unknown>
    const scope = (items.properties as Record<string, unknown>).scopes as Record<string, unknown>
    const scopeItems = (scope.items as Record<string, unknown>) as Record<string, unknown>
    assert.deepEqual((scopeItems.properties as Record<string, unknown>).project, expected)
  })

  it('emits SymbolTarget (kind/value + symbol_kind) for scope symbols', () => {
    const items = ((json.properties as Record<string, unknown>).units as Record<string, unknown>)
      .items as Record<string, unknown>
    const scope = (items.properties as Record<string, unknown>).scopes as Record<string, unknown>
    const scopeItems = (scope.items as Record<string, unknown>) as Record<string, unknown>
    const symbols = (scopeItems.properties as Record<string, unknown>)
      .symbols as Record<string, unknown>
    const sym = (symbols.items as Record<string, unknown>) as Record<string, unknown>
    assert.deepEqual(sym.properties.kind, { type: 'string', const: 'symbol' })
    assert.ok(sym.properties.symbol_kind, 'missing symbol_kind enum')
    assert.deepEqual(
      (sym.properties.symbol_kind as Record<string, unknown>).enum,
      ['class', 'function', 'method', 'type', 'constant', 'route', 'task', 'workflow', 'unknown'],
    )
  })

  it('emits AcceptanceCriterion (id/when/then) for verification items', () => {
    const verification = (json.properties as Record<string, unknown>)
      .verification as Record<string, unknown>
    const item = (verification.items as Record<string, unknown>) as Record<string, unknown>
    assert.ok(item.properties.when, 'missing when')
    assert.ok(item.properties.then, 'missing then')
    assert.ok(item.properties.id, 'missing id')
  })

  it('emits additionalProperties: false on unit, scope, decomposition_check and risk items', () => {
    const items = ((json.properties as Record<string, unknown>).units as Record<string, unknown>)
      .items as Record<string, unknown>
    assert.equal(items.additionalProperties, false)
    const scope = (items.properties as Record<string, unknown>).scopes as Record<string, unknown>
    const scopeItems = (scope.items as Record<string, unknown>) as Record<string, unknown>
    assert.equal(scopeItems.additionalProperties, false)
    assert.equal(
      (items.properties as Record<string, unknown>).decomposition_check.additionalProperties,
      false,
    )
    const risks = (json.properties as Record<string, unknown>).risks as Record<string, unknown>
    const riskItems = (risks.items as Record<string, unknown>) as Record<string, unknown>
    assert.equal(riskItems.additionalProperties, false)
  })
})
