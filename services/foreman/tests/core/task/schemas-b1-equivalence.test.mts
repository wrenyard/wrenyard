// @ts-nocheck
/**
 * Batch B1 — old-vs-new AJV equivalence tests for the commit request schema.
 *
 * Compiles the *legacy* draft-07 commit schema from
 * `tests/fixtures/legacy-workspace-schemas` with AJV, and compiles the *new*
 * Zod-4 source of truth converted to draft-07 JSON Schema (via
 * `lib/core/task/schemas/commit.mts`) with AJV. It asserts that the old and
 * new validators AGREE on every structural invariant the migration must
 * preserve:
 *
 *   - required fields (`changes_to_commit`)
 *   - string patterns (commit hash, SC-/EXP- refs)
 *   - additionalProperties: false (reject unknown keys)
 *   - commit `minProperties` (non-empty change set)
 *
 * Inquiry, review, and uniqueItems equivalence coverage has been removed
 * alongside their retired schemas; only the commit request survives here.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import { describe, it } from 'node:test'

import { commitRequestToJSONSchema } from '../../../lib/core/task/schemas/commit.mts'

const here = dirname(fileURLToPath(import.meta.url))
const legacyDir = join(here, '..', '..', 'fixtures', 'legacy-workspace-schemas')
const fixtureDir = join(here, '..', '..', 'fixtures', 'migration-b1')

const loadLegacy = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(legacyDir, name), 'utf8'))
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Old (legacy) validator ────────────────────────────────────────

const oldAjv = new Ajv({ allErrors: true, strict: false })
const oldCommit = oldAjv.compile(loadLegacy('commit.schema.json')) as ValidateFunction

// ─── New (Zod -> draft-07) validator ───────────────────────────────

const newAjv = new Ajv({ allErrors: true, strict: false })
const newCommit = newAjv.compile(commitRequestToJSONSchema()) as ValidateFunction

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
