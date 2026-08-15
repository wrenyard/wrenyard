// @ts-nocheck
/**
 * Batch B1 — old-vs-new AJV equivalence tests.
 *
 * Compiles the *legacy* draft-07 schemas from `tests/fixtures/legacy-workspace-schemas`
 * (the local legacy fixtures) with AJV, and compiles the *new* Zod-4 source
 * of truth converted to draft-07 JSON Schema (via the schema files in
 * `lib/core/task/schemas/`) with AJV. For a battery of valid and invalid
 * documents it asserts that the old and new validators AGREE on every
 * structural invariant the migration must preserve:
 *
 *   - required fields
 *   - enums
 *   - string patterns (commit hash, SC-/EXP- refs)
 *   - minLength
 *   - additionalProperties: false (reject unknown keys)
 *   - minItems (non-empty arrays)
 *   - commit `minProperties` (non-empty change set)
 *   - `uniqueItems` preservation (via the B1 post-conversion helper)
 *
 * The new schema deliberately remaps a few shared primitives
 * (`ProjectRef` -> inline `ProjectTarget` object, `QuestionRef` -> plain
 * `id`, `decisions` -> `DecisionSchema[]`). Those remaps change the *shape*
 * of the document, so each equivalence case carries an old-shaped document
 * (validated by the legacy schema) and a new-shaped document (validated by
 * the converted schema); what must match is the acceptance decision.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import { describe, it } from 'node:test'

import { commitRequestToJSONSchema } from '../../../lib/core/task/schemas/commit.mts'
import {
  RequestIntakeResultSchema,
  InquiryStepResultSchema,
  inquiryToJSONSchema,
} from '../../../lib/core/task/schemas/inquiry.mts'
import { reviewChecklistIssueBaseToJSONSchema } from '../../../lib/core/task/schemas/review.mts'
import { applyUniqueItemsAtPath } from '../../../lib/core/task/schemas/index.mts'

const here = dirname(fileURLToPath(import.meta.url))
const legacyDir = join(here, '..', '..', 'fixtures', 'legacy-workspace-schemas')
const fixtureDir = join(here, '..', '..', 'fixtures', 'migration-b1')

const loadLegacy = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(legacyDir, name), 'utf8'))
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Old (legacy) validators ────────────────────────────────────────

function buildOldAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false })
  // shared.schema.json is referenced externally by the inquiry schema.
  ajv.addSchema(loadLegacy('shared.schema.json'))
  return ajv
}

const oldAjv = buildOldAjv()
// Each legacy file's root `$ref` points at a single definition; compile the
// file as-is, then a `$ref`-rewritten copy for InquiryStepResult.
const oldCommit = oldAjv.compile(loadLegacy('commit.schema.json')) as ValidateFunction
const oldInquiryIntake = oldAjv.compile(loadLegacy('inquiry.schema.json')) as ValidateFunction
const stepLegacy = clone(loadLegacy('inquiry.schema.json'))
stepLegacy.$ref = '#/definitions/InquiryStepResult'
stepLegacy.$id = 'https://agent-workspace.local/schemas/inquiry.step.schema.json'
const oldInquiryStep = oldAjv.compile(stepLegacy) as ValidateFunction
const oldReview = oldAjv.compile(loadLegacy('review.schema.json')) as ValidateFunction

// ─── New (Zod -> draft-07) validators ───────────────────────────────

const newAjv = new Ajv({ allErrors: true, strict: false })
const newCommit = newAjv.compile(commitRequestToJSONSchema()) as ValidateFunction
const newInquiryIntake = newAjv.compile(
  inquiryToJSONSchema(RequestIntakeResultSchema),
) as ValidateFunction
const newInquiryStep = newAjv.compile(
  inquiryToJSONSchema(InquiryStepResultSchema),
) as ValidateFunction
const newReview = newAjv.compile(reviewChecklistIssueBaseToJSONSchema()) as ValidateFunction

/**
 * Assert the old and new validators reach the SAME acceptance decision for
 * the given old-shaped / new-shaped documents.
 */
function assertAgree(
  oldValidate: ValidateFunction,
  newValidate: ValidateFunction,
  oldDoc: unknown,
  newDoc: unknown,
  label: string,
): void {
  const oldOk = oldValidate(oldDoc)
  const newOk = newValidate(newDoc)
  assert.equal(
    oldOk,
    newOk,
    `equivalence divergence on "${label}": old=${oldOk} new=${newOk}\n` +
      `  old errors: ${JSON.stringify(oldValidate.errors)}\n` +
      `  new errors: ${JSON.stringify(newValidate.errors)}`,
  )
}

// ─── Commit request ─────────────────────────────────────────────────

describe('B1 equivalence — commit request (old shape == new shape)', () => {
  const valid = loadFixture('commit-request.valid.json')

  it('accepts a valid commit request under both old and new', () => {
    assertAgree(oldCommit, newCommit, valid, valid, 'valid')
  })

  it('rejects an empty change set (minProperties: 1) under both', () => {
    const invalid = loadFixture('commit-request.invalid.empty-changeset.json')
    assertAgree(oldCommit, newCommit, invalid, invalid, 'empty changeset')
  })

  it('rejects unknown top-level properties (additionalProperties: false) under both', () => {
    const invalid = { ...valid, unexpected_extra: true }
    assertAgree(oldCommit, newCommit, invalid, invalid, 'extra property')
  })

  it('converted draft-07 preserves CommitChangeSet minProperties and additionalProperties: false', () => {
    const json = commitRequestToJSONSchema() as Record<string, unknown>
    assert.deepEqual(json.required, ['changes_to_commit'])
    assert.equal(json.additionalProperties, false)
    assert.equal('need_push' in (json.properties as Record<string, unknown>), false)
    const cs = (json.properties as Record<string, unknown>).changes_to_commit as Record<string, unknown>
    assert.equal(cs.minProperties, 1)
    // Legacy restricts change-set values to non-empty strings (object form).
    assert.deepEqual(cs.additionalProperties, { type: 'string', minLength: 1 })
  })
})

// ─── Inquiry intake ─────────────────────────────────────────────────

describe('B1 equivalence — inquiry intake (old shape vs new shape)', () => {
  const legacyValid = loadFixture('inquiry-intake.valid.legacy.json')
  const newValid = loadFixture('inquiry-intake.valid.new.json')

  it('accepts a valid intake under both old and new', () => {
    assertAgree(oldInquiryIntake, newInquiryIntake, legacyValid, newValid, 'valid')
  })

  it('rejects a missing required field (understanding) under both', () => {
    const legacyInvalid = loadFixture('inquiry-intake.invalid.missing-field.json')
    const newInvalid = clone(newValid)
    delete (newInvalid as Record<string, unknown>).understanding
    assertAgree(oldInquiryIntake, newInquiryIntake, legacyInvalid, newInvalid, 'missing field')
  })

  it('rejects a bad enum value (phase) under both', () => {
    const legacyInvalid = loadFixture('inquiry-intake.invalid.bad-enum.json')
    const newInvalid = clone(newValid)
    ;(newInvalid as Record<string, unknown>).phase = 'bogus_phase'
    assertAgree(oldInquiryIntake, newInquiryIntake, legacyInvalid, newInvalid, 'bad enum')
  })

  it('rejects a bad pattern value (scope ref) under both', () => {
    const legacyInvalid = loadFixture('inquiry-intake.invalid.bad-pattern.json')
    const newInvalid = clone(newValid)
    const scopes = (newInvalid as Record<string, unknown>).candidate_scopes as any[]
    scopes[0].ref = 'X-1'
    assertAgree(oldInquiryIntake, newInquiryIntake, legacyInvalid, newInvalid, 'bad pattern')
  })

  it('rejects an empty candidate_scopes array (minItems: 1) under both', () => {
    const legacyInvalid = loadFixture('inquiry-intake.invalid.minitems.json')
    const newInvalid = clone(newValid)
    ;(newInvalid as Record<string, unknown>).candidate_scopes = []
    assertAgree(oldInquiryIntake, newInquiryIntake, legacyInvalid, newInvalid, 'minItems')
  })

  it('rejects unknown top-level properties (additionalProperties: false) under both', () => {
    const legacyInvalid = loadFixture('inquiry-intake.invalid.extra-prop.json')
    const newInvalid = clone(newValid)
    ;(newInvalid as Record<string, unknown>).unexpected_extra_property = true
    assertAgree(oldInquiryIntake, newInquiryIntake, legacyInvalid, newInvalid, 'extra property')
  })

  it('converted draft-07 preserves additionalProperties: false and candidate minItems', () => {
    const json = inquiryToJSONSchema(RequestIntakeResultSchema) as Record<string, unknown>
    assert.equal(json.additionalProperties, false)
    const cs = (json.properties as Record<string, unknown>).candidate_scopes as Record<string, unknown>
    assert.equal(cs.minItems, 1)
    assert.equal((cs.items as Record<string, unknown>).additionalProperties, false)
  })
})

// ─── Inquiry step ───────────────────────────────────────────────────

describe('B1 equivalence — inquiry step (old shape vs new shape)', () => {
  const legacyValid = loadFixture('inquiry-step.valid.legacy.json')
  const newValid = loadFixture('inquiry-step.valid.new.json')

  it('accepts a valid step under both old and new', () => {
    assertAgree(oldInquiryStep, newInquiryStep, legacyValid, newValid, 'valid')
  })

  it('rejects a missing required field (action) under both', () => {
    const legacyInvalid = clone(legacyValid)
    delete (legacyInvalid as Record<string, unknown>).action
    const newInvalid = clone(newValid)
    delete (newInvalid as Record<string, unknown>).action
    assertAgree(oldInquiryStep, newInquiryStep, legacyInvalid, newInvalid, 'missing field')
  })

  it('rejects a bad enum value (action) under both', () => {
    const legacyInvalid = clone(legacyValid)
    ;(legacyInvalid as Record<string, unknown>).action = 'bogus_action'
    const newInvalid = clone(newValid)
    ;(newInvalid as Record<string, unknown>).action = 'bogus_action'
    assertAgree(oldInquiryStep, newInquiryStep, legacyInvalid, newInvalid, 'bad enum')
  })
})

// ─── Review checklist issue ─────────────────────────────────────────

describe('B1 equivalence — review checklist issue (old shape == new shape)', () => {
  const valid = loadFixture('review-issue.valid.json')

  it('accepts a valid issue under both old and new', () => {
    assertAgree(oldReview, newReview, valid, valid, 'valid')
  })

  it('rejects a missing required field (required_change) under both', () => {
    const legacyInvalid = loadFixture('review-issue.invalid.missing-field.json')
    assertAgree(oldReview, newReview, legacyInvalid, legacyInvalid, 'missing field')
  })

  it('rejects unknown properties (additionalProperties: false) under both', () => {
    const invalid = { ...valid, unexpected_extra: true }
    assertAgree(oldReview, newReview, invalid, invalid, 'extra property')
  })
})

// ─── uniqueItems preservation (B1 post-conversion helper) ───────────

describe('B1 equivalence — uniqueItems preservation on candidate_scopes', () => {
  // Old: take the legacy inquiry schema, point it at RequestIntakeResult, and
  // patch uniqueItems onto candidate_scopes the same way a post-conversion
  // step would.
  const oldJson = loadLegacy('inquiry.schema.json')
  oldJson.$ref = '#/definitions/RequestIntakeResult'
  const oldCs = (
    (oldJson.definitions as Record<string, any>).RequestIntakeResult.properties as Record<string, any>
  ).candidate_scopes as Record<string, unknown>
  oldCs.uniqueItems = true
  const oldUnique = new Ajv({ allErrors: true, strict: false })
    .addSchema(loadLegacy('shared.schema.json'))
    .compile(oldJson) as ValidateFunction

  // New: convert the Zod schema and apply the B1 helper.
  const newJson = inquiryToJSONSchema(RequestIntakeResultSchema) as Record<string, unknown>
  applyUniqueItemsAtPath(newJson, ['properties', 'candidate_scopes'])
  const newUnique = new Ajv({ allErrors: true, strict: false }).compile(
    newJson,
  ) as ValidateFunction

  it('converted new schema carries uniqueItems: true on candidate_scopes', () => {
    const cs = (newJson.properties as Record<string, unknown>).candidate_scopes as Record<string, unknown>
    assert.equal(cs.uniqueItems, true)
  })

  it('rejects duplicate candidate_scopes under both old and new (uniqueness)', () => {
    const legacyDupes = clone(loadFixture('inquiry-intake.valid.legacy.json'))
    const scope = (legacyDupes as any).candidate_scopes[0]
    ;(legacyDupes as any).candidate_scopes = [scope, clone(scope)]
    const newDupes = clone(loadFixture('inquiry-intake.valid.new.json'))
    const nscope = (newDupes as any).candidate_scopes[0]
    ;(newDupes as any).candidate_scopes = [nscope, clone(nscope)]
    assertAgree(oldUnique, newUnique, legacyDupes, newDupes, 'duplicate scopes')
  })

  it('accepts distinct candidate_scopes under both old and new', () => {
    const legacyDistinct = clone(loadFixture('inquiry-intake.valid.legacy.json'))
    ;(legacyDistinct as any).candidate_scopes = [
      (legacyDistinct as any).candidate_scopes[0],
      { ...(legacyDistinct as any).candidate_scopes[0], ref: 'SC-002', title: 'Second' },
    ]
    const newDistinct = clone(loadFixture('inquiry-intake.valid.new.json'))
    ;(newDistinct as any).candidate_scopes = [
      (newDistinct as any).candidate_scopes[0],
      { ...(newDistinct as any).candidate_scopes[0], ref: 'SC-002', title: 'Second' },
    ]
    assertAgree(oldUnique, newUnique, legacyDistinct, newDistinct, 'distinct scopes')
  })
})
