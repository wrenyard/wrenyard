// @ts-nocheck
/**
 * Implement — old-vs-new AJV equivalence tests.
 *
 * Compiles the *legacy* draft-07 schema from `tests/fixtures/legacy-workspace-schemas/
 * implement.schema.json` (which `$ref`s `feature-point.schema.json`,
 * `functional-unit.schema.json`, `implementation-unit.schema.json`,
 * `verification.schema.json`, and `commit.schema.json`) with AJV, and
 * compiles the *new* Zod-4 source of truth
 * (`lib/core/task/schemas/implement.mts`) converted to draft-07 JSON Schema
 * with AJV. For a battery of valid and invalid documents it asserts that the
 * old and new validators AGREE on every structural invariant the migration
 * must preserve:
 *
 *   - required fields (root report / ImplementReport / FunctionalUnitReport /
 *     ImplementationUnitReport / ImplementReviewAttempt)
 *   - enums (report / FU / IU status completed|failed; review status
 *     approved|failed; assessment status passed|failed|blocked|not_supported)
 *   - string patterns (FP- / FU- / IU- refs; commit hash ^[0-9a-f]{7,40}$)
 *   - nested arrays (functional_units / implementation_units /
 *     verification_results / evidence / review / commits)
 *   - additionalProperties: false (reject unknown keys at every level)
 *   - review `issues` items are open objects (additionalProperties: true)
 *
 * The new schema deliberately remaps several shared primitives:
 *
 *   - `FeaturePointRef`       -> `Ref<T>` patterned string   `^FP-[0-9]{3,}$`
 *   - `FunctionalUnitRef`     -> `Ref<T>` patterned string   `^FU-[0-9]{3,}$`
 *   - `ImplementationUnitRef` -> `Ref<T>` patterned string   `^IU-[0-9]{3,}$`
 *   - `VerificationResult`    -> common `AssessmentSchema`    { criterion_id,
 *                               status, evidences, reason } + referenced
 *                               `Evidence` pool on the FunctionalUnitReport
 *   - `CommitInfo`            -> reused verbatim from `commit.mts`
 *
 * Those remaps change the *shape* of `verification_results` (and add an
 * `evidence` pool), so each equivalence case carries an old-shaped document
 * (validated by the legacy schema) and a new-shaped document (validated by
 * the converted schema); what must match is the acceptance decision.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import { describe, it } from 'node:test'

import { compileSchema } from '../../../lib/workspace/schema-loader.mts'
import { ImplementOutputSchema, implementToJSONSchema } from '../../../lib/core/task/schemas/implement.mts'

const here = dirname(fileURLToPath(import.meta.url))
const legacyDir = join(here, '..', '..', 'fixtures', 'legacy-workspace-schemas')
const fixtureDir = join(here, '..', '..', 'fixtures', 'migration-implement')

const loadLegacy = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(legacyDir, name), 'utf8'))
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Old (legacy) validator ────────────────────────────────────────
//
// The legacy implement schema pulls shared concepts from several external
// schemas; all must be registered so AJV can resolve the external `$ref`s.

function buildOldAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false })
  ajv.addSchema(loadLegacy('shared.schema.json'))
  ajv.addSchema(loadLegacy('inquiry.schema.json'))
  ajv.addSchema(loadLegacy('feature-point.schema.json'))
  ajv.addSchema(loadLegacy('functional-unit.schema.json'))
  ajv.addSchema(loadLegacy('implementation-unit.schema.json'))
  ajv.addSchema(loadLegacy('verification.schema.json'))
  ajv.addSchema(loadLegacy('edit.schema.json'))
  ajv.addSchema(loadLegacy('commit.schema.json'))
  return ajv
}

const oldAjv = buildOldAjv()
const oldValidate = oldAjv.compile(loadLegacy('implement.schema.json')) as ValidateFunction

// ─── New (Zod -> draft-07) validator ───────────────────────────────
// Self-contained: all FP/FU/IU snapshots, Assessment/Evidence, and CommitInfo
// are inlined.

const newAjv = new Ajv({ allErrors: true, strict: false })
const newValidate = newAjv.compile(implementToJSONSchema()) as ValidateFunction

// ─── Runtime (Zod -> AJV via compileSchema) validator ────────────────

const runtimeValidate = compileSchema(ImplementOutputSchema).validate

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

// ─── Completed / failed reports ─────────────────────────────────────

describe('Implement equivalence — completed / failed reports', () => {
  it('accepts a valid completed report under both old and new', () => {
    assertAgree(
      loadFixture('implement.report.valid.legacy.json'),
      loadFixture('implement.report.valid.new.json'),
      'valid completed report',
    )
  })

  it('accepts a failed report under both old and new', () => {
    const legacyOk = clone(loadFixture('implement.report.valid.legacy.json'))
    const newOk = clone(loadFixture('implement.report.valid.new.json'))
    setPath(legacyOk, ['report', 'status'], 'failed')
    setPath(newOk, ['report', 'status'], 'failed')
    setPath(legacyOk, ['report', 'functional_units', 0, 'status'], 'failed')
    setPath(newOk, ['report', 'functional_units', 0, 'status'], 'failed')
    assertAgree(legacyOk, newOk, 'failed report')
  })

  it('rejects an unknown report status under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(legacyInvalid, ['report', 'status'], 'in_progress')
    setPath(newInvalid, ['report', 'status'], 'in_progress')
    assertAgree(legacyInvalid, newInvalid, 'bad report status')
  })
})

// ─── Missing required fields ───────────────────────────────────────

describe('Implement equivalence — missing required fields', () => {
  it('rejects a document missing the report node under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report'])
    delPath(newInvalid, ['report'])
    assertAgree(legacyInvalid, newInvalid, 'missing report')
  })

  it('rejects a report missing feature_point_ref under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'feature_point_ref'])
    delPath(newInvalid, ['report', 'feature_point_ref'])
    assertAgree(legacyInvalid, newInvalid, 'missing feature_point_ref')
  })

  it('rejects a report missing functional_units under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units'])
    delPath(newInvalid, ['report', 'functional_units'])
    assertAgree(legacyInvalid, newInvalid, 'missing functional_units')
  })

  it('rejects a FU missing ref under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'ref'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'ref'])
    assertAgree(legacyInvalid, newInvalid, 'missing FU ref')
  })

  it('rejects a FU missing title under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'title'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'title'])
    assertAgree(legacyInvalid, newInvalid, 'missing FU title')
  })

  it('rejects a FU missing implementation_units under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'implementation_units'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'implementation_units'])
    assertAgree(legacyInvalid, newInvalid, 'missing implementation_units')
  })

  it('rejects a FU missing verification_results under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'verification_results'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'verification_results'])
    assertAgree(legacyInvalid, newInvalid, 'missing verification_results')
  })

  it('rejects a FU missing evidence under both (new shape)', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'verification_results'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'evidence'])
    // Old has no `evidence` pool, so dropping verification_results is its
    // equivalent missing-field rejection; both end up invalid.
    assertAgree(legacyInvalid, newInvalid, 'missing evidence (new) / verification (old)')
  })

  it('rejects a FU missing review under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'review'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'review'])
    assertAgree(legacyInvalid, newInvalid, 'missing review')
  })

  it('rejects a FU missing commits under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'commits'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'commits'])
    assertAgree(legacyInvalid, newInvalid, 'missing commits')
  })

  it('rejects a FU missing change_summary under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'change_summary'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'change_summary'])
    assertAgree(legacyInvalid, newInvalid, 'missing change_summary')
  })

  it('rejects an implementation unit missing ref under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'implementation_units', 0, 'ref'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'implementation_units', 0, 'ref'])
    assertAgree(legacyInvalid, newInvalid, 'missing IU ref')
  })

  it('rejects a review attempt missing status under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'review', 0, 'status'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'review', 0, 'status'])
    assertAgree(legacyInvalid, newInvalid, 'missing review status')
  })
})

// ─── Invalid refs / hashes / status ─────────────────────────────────

describe('Implement equivalence — invalid refs / hashes / status', () => {
  it('rejects a malformed FeaturePointRef under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(legacyInvalid, ['report', 'feature_point_ref'], 'FP-1')
    setPath(newInvalid, ['report', 'feature_point_ref'], 'FP-1')
    assertAgree(legacyInvalid, newInvalid, 'bad feature_point_ref')
  })

  it('rejects a malformed FunctionalUnitRef under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(legacyInvalid, ['report', 'functional_units', 0, 'ref'], 'FU-1')
    setPath(newInvalid, ['report', 'functional_units', 0, 'ref'], 'FU-1')
    assertAgree(legacyInvalid, newInvalid, 'bad FU ref')
  })

  it('rejects a malformed ImplementationUnitRef under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(
      legacyInvalid,
      ['report', 'functional_units', 0, 'implementation_units', 0, 'ref'],
      'IU-1',
    )
    setPath(
      newInvalid,
      ['report', 'functional_units', 0, 'implementation_units', 0, 'ref'],
      'IU-1',
    )
    assertAgree(legacyInvalid, newInvalid, 'bad IU ref')
  })

  it('rejects a malformed commit hash (non-hex) under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(
      legacyInvalid,
      ['report', 'functional_units', 0, 'commits', 0, 'hash'],
      'ZZZ',
    )
    setPath(
      newInvalid,
      ['report', 'functional_units', 0, 'commits', 0, 'hash'],
      'ZZZ',
    )
    assertAgree(legacyInvalid, newInvalid, 'bad commit hash')
  })

  it('rejects a too-short commit hash (5 hex) under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(
      legacyInvalid,
      ['report', 'functional_units', 0, 'commits', 0, 'hash'],
      'abc12',
    )
    setPath(
      newInvalid,
      ['report', 'functional_units', 0, 'commits', 0, 'hash'],
      'abc12',
    )
    assertAgree(legacyInvalid, newInvalid, 'too-short commit hash')
  })

  it('accepts a 40-char commit hash under both', () => {
    const legacyOk = clone(loadFixture('implement.report.valid.legacy.json'))
    const newOk = clone(loadFixture('implement.report.valid.new.json'))
    const long = 'a'.repeat(40)
    setPath(legacyOk, ['report', 'functional_units', 0, 'commits', 0, 'hash'], long)
    setPath(newOk, ['report', 'functional_units', 0, 'commits', 0, 'hash'], long)
    assertAgree(legacyOk, newOk, '40-char commit hash')
  })

  it('rejects an unknown FU status under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(legacyInvalid, ['report', 'functional_units', 0, 'status'], 'blocked')
    setPath(newInvalid, ['report', 'functional_units', 0, 'status'], 'blocked')
    assertAgree(legacyInvalid, newInvalid, 'bad FU status')
  })

  it('rejects an unknown implementation-unit status under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(
      legacyInvalid,
      ['report', 'functional_units', 0, 'implementation_units', 0, 'status'],
      'ready',
    )
    setPath(
      newInvalid,
      ['report', 'functional_units', 0, 'implementation_units', 0, 'status'],
      'ready',
    )
    assertAgree(legacyInvalid, newInvalid, 'bad IU status')
  })

  it('rejects an unknown review status under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(
      legacyInvalid,
      ['report', 'functional_units', 0, 'review', 0, 'status'],
      'changes_required',
    )
    setPath(
      newInvalid,
      ['report', 'functional_units', 0, 'review', 0, 'status'],
      'changes_required',
    )
    assertAgree(legacyInvalid, newInvalid, 'bad review status')
  })

  it('rejects an unknown assessment status under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(
      legacyInvalid,
      ['report', 'functional_units', 0, 'verification_results', 0, 'status'],
      'skipped',
    )
    setPath(
      newInvalid,
      ['report', 'functional_units', 0, 'verification_results', 0, 'status'],
      'skipped',
    )
    assertAgree(legacyInvalid, newInvalid, 'bad assessment status')
  })
})

// ─── Nested review / commit structures ──────────────────────────────

describe('Implement equivalence — nested review / commit structures', () => {
  it('accepts a review attempt whose issues carry arbitrary fields (open object) under both', () => {
    const legacyOk = clone(loadFixture('implement.report.valid.legacy.json'))
    const newOk = clone(loadFixture('implement.report.valid.new.json'))
    const extra = {
      target_ref: 'FU-001',
      check_id: 'fu_acceptance_missing',
      problem: 'p',
      required_change: 'c',
      extra_note: 'free-form observation',
    }
    ;(legacyOk.report as Record<string, unknown>).functional_units[0].review = [
      { issues: [extra], status: 'failed' },
    ]
    ;(newOk.report as Record<string, unknown>).functional_units[0].review = [
      { issues: [extra], status: 'failed' },
    ]
    assertAgree(legacyOk, newOk, 'review issues with extra fields')
  })

  it('accepts multiple review attempts under both', () => {
    const legacyOk = clone(loadFixture('implement.report.valid.legacy.json'))
    const newOk = clone(loadFixture('implement.report.valid.new.json'))
    const extraAttempt = { issues: [{ note: 'second pass' }], status: 'approved' }
    ;(legacyOk.report as Record<string, unknown>).functional_units[0].review.push(extraAttempt)
    ;(newOk.report as Record<string, unknown>).functional_units[0].review.push(extraAttempt)
    assertAgree(legacyOk, newOk, 'multiple review attempts')
  })

  it('rejects a commit missing stats under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    delPath(legacyInvalid, ['report', 'functional_units', 0, 'commits', 0, 'stats'])
    delPath(newInvalid, ['report', 'functional_units', 0, 'commits', 0, 'stats'])
    assertAgree(legacyInvalid, newInvalid, 'commit missing stats')
  })

  it('rejects a commit whose numstat row is missing required fields under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(
      legacyInvalid,
      ['report', 'functional_units', 0, 'commits', 0, 'stats', 'raw_numstat'],
      [{ file: 'src/list.ts' }],
    )
    setPath(
      newInvalid,
      ['report', 'functional_units', 0, 'commits', 0, 'stats', 'raw_numstat'],
      [{ file: 'src/list.ts' }],
    )
    assertAgree(legacyInvalid, newInvalid, 'commit numstat row missing fields')
  })

  it('rejects a commit whose stats row added is negative under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    setPath(
      legacyInvalid,
      ['report', 'functional_units', 0, 'commits', 0, 'stats', 'raw_numstat', 0, 'added'],
      -5,
    )
    setPath(
      newInvalid,
      ['report', 'functional_units', 0, 'commits', 0, 'stats', 'raw_numstat', 0, 'added'],
      -5,
    )
    assertAgree(legacyInvalid, newInvalid, 'commit numstat added negative')
  })
})

// ─── additionalProperties: false ────────────────────────────────────

describe('Implement equivalence — additionalProperties: false', () => {
  it('rejects an unknown top-level property under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    ;(legacyInvalid as Record<string, unknown>).unexpected_extra = true
    ;(newInvalid as Record<string, unknown>).unexpected_extra = true
    assertAgree(legacyInvalid, newInvalid, 'extra top-level property')
  })

  it('rejects an unknown property inside the report under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    ;(legacyInvalid.report as Record<string, unknown>).ghost = true
    ;(newInvalid.report as Record<string, unknown>).ghost = true
    assertAgree(legacyInvalid, newInvalid, 'extra report property')
  })

  it('rejects an unknown property inside a functional unit under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    ;(legacyInvalid.report as Record<string, unknown>).functional_units[0].ghost = true
    ;(newInvalid.report as Record<string, unknown>).functional_units[0].ghost = true
    assertAgree(legacyInvalid, newInvalid, 'extra functional unit property')
  })

  it('rejects an unknown property inside a commit under both', () => {
    const legacyInvalid = clone(loadFixture('implement.report.valid.legacy.json'))
    const newInvalid = clone(loadFixture('implement.report.valid.new.json'))
    ;(legacyInvalid.report as Record<string, unknown>).functional_units[0].commits[0].ghost = true
    ;(newInvalid.report as Record<string, unknown>).functional_units[0].commits[0].ghost = true
    assertAgree(legacyInvalid, newInvalid, 'extra commit property')
  })
})

// ─── Converted draft-07 structure preservation ──────────────────────

describe('Implement equivalence — converted draft-07 JSON Schema preserves invariants', () => {
  const json = implementToJSONSchema() as Record<string, unknown>

  it('emits the legacy required fields and additionalProperties: false at the root', () => {
    assert.deepEqual(json.required, ['report'])
    assert.equal(json.additionalProperties, false)
  })

  it('emits the ImplementReport required fields and status enum', () => {
    const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
    assert.deepEqual(report.required, ['status', 'feature_point_ref', 'functional_units'])
    assert.equal(report.additionalProperties, false)
    assert.deepEqual((report.properties as Record<string, unknown>).status.enum, [
      'completed',
      'failed',
    ])
  })

  it('emits the FP- ref pattern on feature_point_ref', () => {
    const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
    assert.equal(
      (report.properties as Record<string, unknown>).feature_point_ref.pattern,
      '^FP-[0-9]{3,}$',
    )
  })

  it('emits the FunctionalUnitReport required fields (incl. evidence) and FU- ref pattern', () => {
    const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
    const fuArray = (report.properties as Record<string, unknown>)
      .functional_units as Record<string, unknown>
    const fuNode = fuArray.items as Record<string, unknown>
    assert.deepEqual(fuNode.required, [
      'ref',
      'title',
      'status',
      'implementation_units',
      'verification_results',
      'evidence',
      'review',
      'commits',
      'change_summary',
    ])
    assert.equal(fuNode.additionalProperties, false)
    assert.equal((fuNode.properties as Record<string, unknown>).ref.pattern, '^FU-[0-9]{3,}$')
  })

  it('emits the ImplementationUnitReport with IU- ref pattern and completed|failed enum', () => {
    const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
    const fuArray = (report.properties as Record<string, unknown>)
      .functional_units as Record<string, unknown>
    const fuNode = fuArray.items as Record<string, unknown>
    const iuArray = (fuNode.properties as Record<string, unknown>)
      .implementation_units as Record<string, unknown>
    const iuNode = iuArray.items as Record<string, unknown>
    assert.deepEqual(iuNode.required, ['ref', 'title', 'status'])
    assert.equal(iuNode.additionalProperties, false)
    assert.equal((iuNode.properties as Record<string, unknown>).ref.pattern, '^IU-[0-9]{3,}$')
    assert.deepEqual((iuNode.properties as Record<string, unknown>).status.enum, [
      'completed',
      'failed',
    ])
  })

  it('emits AssessmentSchema (criterion_id/status/evidences) for verification_results', () => {
    const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
    const fuArray = (report.properties as Record<string, unknown>)
      .functional_units as Record<string, unknown>
    const fuNode = fuArray.items as Record<string, unknown>
    const vr = (fuNode.properties as Record<string, unknown>)
      .verification_results as Record<string, unknown>
    const item = vr.items as Record<string, unknown>
    assert.deepEqual(item.required, ['criterion_id', 'status', 'evidences'])
    assert.deepEqual((item.properties as Record<string, unknown>).status.enum, [
      'passed',
      'failed',
      'blocked',
      'not_supported',
    ])
  })

  it('emits Evidence (id/source/observation) for the FU evidence pool', () => {
    const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
    const fuArray = (report.properties as Record<string, unknown>)
      .functional_units as Record<string, unknown>
    const fuNode = fuArray.items as Record<string, unknown>
    const ev = (fuNode.properties as Record<string, unknown>).evidence as Record<string, unknown>
    const item = ev.items as Record<string, unknown>
    assert.deepEqual(item.required, ['id', 'source', 'observation'])
    assert.equal(item.additionalProperties, false)
    assert.deepEqual(item.properties, {
      id: { type: 'string' },
      source: {
        type: 'object',
        properties: { kind: { type: 'string' }, value: { type: 'string' } },
        required: ['kind', 'value'],
        additionalProperties: false,
      },
      observation: { type: 'string' },
    })
  })

  it('emits ImplementReviewAttempt with approved|failed enum and open-object issues items', () => {
    const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
    const fuArray = (report.properties as Record<string, unknown>)
      .functional_units as Record<string, unknown>
    const fuNode = fuArray.items as Record<string, unknown>
    const reviewArray = (fuNode.properties as Record<string, unknown>)
      .review as Record<string, unknown>
    const reviewNode = reviewArray.items as Record<string, unknown>
    assert.deepEqual(reviewNode.required, ['issues', 'status'])
    assert.deepEqual((reviewNode.properties as Record<string, unknown>).status.enum, [
      'approved',
      'failed',
    ])
    const issuesItems = ((reviewNode.properties as Record<string, unknown>)
      .issues as Record<string, unknown>).items as Record<string, unknown>
    assert.equal(issuesItems.additionalProperties, true)
  })

  it('emits CommitInfo with the ^[0-9a-f]{7,40}$ hash pattern', () => {
    const report = (json.properties as Record<string, unknown>).report as Record<string, unknown>
    const fuArray = (report.properties as Record<string, unknown>)
      .functional_units as Record<string, unknown>
    const fuNode = fuArray.items as Record<string, unknown>
    const commits = (fuNode.properties as Record<string, unknown>).commits as Record<string, unknown>
    const commit = commits.items as Record<string, unknown>
    assert.equal(
      (commit.properties as Record<string, unknown>).hash.pattern,
      '^[0-9a-f]{7,40}$',
    )
    assert.deepEqual(commit.required, ['hash', 'message', 'stats'])
    assert.equal(commit.additionalProperties, false)
  })
})
