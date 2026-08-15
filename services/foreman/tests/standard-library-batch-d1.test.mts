import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import exploreTask, {
  ExploreInputSchema,
  ExploreOutputSchema,
} from '../lib/standard/tasks/explore.mts'
import editTask, {
  EditInputSchema,
  EditOutputSchema,
} from '../lib/standard/tasks/edit.mts'
import testTask, {
  TestInputSchema,
  TestOutputSchema,
} from '../lib/standard/tasks/test.mts'
import commitTask from '../lib/standard/tasks/commit.mts'
import { CommitRequestSchema, CommitReportSchema } from '../lib/core/task/schemas/commit.mts'

// ───────────────────────────────────────────────────────────────────
// Shared sample fixtures
// ───────────────────────────────────────────────────────────────────

const exploreInputSample = {
  goal: { outcome: 'Determine why the export is missing' },
  questions: [{ id: 'q1', ask: 'Where is the symbol defined?', blocking: true }],
  targets: [{ kind: 'file', value: 'src/example.ts' }],
}

const exploreOutputSample = {
  results: [
    {
      question_id: 'q1',
      status: 'answered',
      findings: [
        { id: 'f1', conclusion: 'symbol defined in example.ts', targets: [], evidences: ['ev1'], confidence: 'high' },
      ],
    },
  ],
  evidences: [
    { id: 'ev1', source: { kind: 'file', value: 'src/example.ts' }, observation: 'export found at top' },
  ],
}

const editInputSample = {
  changes: [
    {
      target: { kind: 'file', value: 'src/example.ts' },
      action: 'update',
      instruction: 'add a public export',
      expected: 'symbol exported',
    },
  ],
}

const editOutputSample = [
  { id: 'c1', source: { kind: 'file', value: 'src/example.ts' }, observation: 'added export' },
]

const testInputSample = {
  acceptance_criteria: [
    { id: 'ac1', given: 'a file exists', when: 'edit runs', then: 'content changes' },
  ],
}

const testOutputSample = {
  evidences: [
    { id: 'ev1', source: { kind: 'command', value: 'npm test' }, observation: 'all passed' },
  ],
  assessments: [
    { criterion_id: 'ac1', status: 'passed', evidences: ['ev1'] },
  ],
}

const commitInputSample = {
  changes_to_commit: { 'src/example.ts': 'all' },
}

const commitOutputSample = {
  commits: [
    {
      hash: 'abcdef1234567',
      message: 'fix: example',
      stats: {
        files_changed: 1,
        added_lines: 10,
        deleted_lines: 2,
        edited_lines: 2,
        raw_shortstat: '1 file changed, 10 insertions(+), 2 deletions(-)',
        raw_numstat: [{ file: 'src/example.ts', added: 10, deleted: 2, raw: '10\t2\tsrc/example.ts' }],
      },
    },
  ],
}

// ───────────────────────────────────────────────────────────────────
// explore
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks explore — definition shape & config', () => {
  it('is a TaskDefinition object literal with readonly / forge/fast', () => {
    assert.equal(exploreTask.__type, 'task')
    assert.equal(exploreTask.config.permission, 'readonly')
    assert.equal(exploreTask.config.agentRuntime, 'forge/fast')
    assert.equal(exploreTask.sourcePath, 'lib/standard/tasks/explore.mts')
    // problem-driven builtin has no migrated external instructions
    assert.deepEqual(exploreTask.config.instructions, [])
  })

  it('input/output are Zod schemas', () => {
    assert.equal(typeof ExploreInputSchema.parse, 'function')
    assert.equal(typeof ExploreOutputSchema.parse, 'function')
  })

  it('prompt is English and problem-driven', async () => {
    const prompt = await exploreTask.config.prompt(exploreInputSample)
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Explorer/)
    assert.match(prompt, /answered|unanswered|blocked/)
    assert.match(prompt, /Goal/)
  })
})

describe('standard/tasks explore — schema behavior', () => {
  it('parses a valid input and output', () => {
    assert.deepEqual(ExploreInputSchema.parse(exploreInputSample), exploreInputSample)
    assert.deepEqual(ExploreOutputSchema.parse(exploreOutputSample), exploreOutputSample)
  })

  it('rejects input missing questions', () => {
    const bad = { goal: { outcome: 'x' }, targets: [{ kind: 'file', value: 'a' }] }
    assert.throws(() => ExploreInputSchema.parse(bad))
  })

  it('rejects output missing pooled evidences', () => {
    const bad = {
      results: [{ question_id: 'q1', status: 'unanswered' }],
    }
    assert.throws(() => ExploreOutputSchema.parse(bad))
  })

  it('result status is one of answered|unanswered|blocked', () => {
    assert.throws(() =>
      ExploreOutputSchema.parse({
        results: [{ question_id: 'q1', status: 'maybe', findings: [] }],
        evidences: [],
      }),
    )
  })
})

// ───────────────────────────────────────────────────────────────────
// edit
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks edit — definition shape & config', () => {
  it('is a lean TaskDefinition with edit / forge/fast and shell guidance only', () => {
    assert.equal(editTask.__type, 'task')
    assert.equal(editTask.config.permission, 'edit')
    assert.equal(editTask.config.agentRuntime, 'forge/fast')
    assert.equal(editTask.sourcePath, 'lib/standard/tasks/edit.mts')

    const joined = (editTask.config.instructions ?? []).join('\n')
    assert.match(joined, /# Shell Usage/)
    assert.doesNotMatch(joined, /# Commit Constraint/)
    assert.doesNotMatch(joined, /# Edit Operation Units/)
    assert.deepEqual(editTask.config.writeTargets?.(editInputSample), ['src/example.ts'])
  })

  it('input is {changes: ChangeSchema[]} and output is file EvidenceSchema[]', () => {
    assert.equal(typeof EditInputSchema.parse, 'function')
    assert.equal(typeof EditOutputSchema.parse, 'function')
  })

  it('prompt preserves exact-path-only editing semantics', async () => {
    const prompt = await editTask.config.prompt(editInputSample)
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Edit Executor/)
    assert.match(prompt, /exact paths/)
    assert.match(prompt, /Do not broaden scope/)
    assert.match(prompt, /mechanical edit task/)
    assert.match(prompt, /already-completed target read/)
    assert.match(prompt, /begin the first Edit\/Write immediately/)
    assert.match(prompt, /Do not call Glob, Grep, Bash/)
    assert.match(prompt, /independent test task/)
    assert.match(prompt, /must not outnumber Edit\/Write mutations/)
  })
})

describe('standard/tasks edit — schema behavior ({changes: Change[]} -> FileEvidence[])', () => {
  it('parses valid object input and file Evidence[] output', () => {
    assert.deepEqual(EditInputSchema.parse(editInputSample), editInputSample)
    assert.deepEqual(EditOutputSchema.parse(editOutputSample), editOutputSample)
  })

  it('keeps legacy Change[] input resumable while object input is canonical', () => {
    assert.deepEqual(EditInputSchema.parse(editInputSample.changes), editInputSample.changes)
  })

  it('enforces exact-path-only: target must be a file target', () => {
    const notFile = { changes: [
      { target: { kind: 'symbol', value: 'foo' }, action: 'update', instruction: 'x', expected: 'y' },
    ] }
    assert.throws(() => EditInputSchema.parse(notFile))
    // valid file target passes
    assert.ok(EditInputSchema.parse(editInputSample))
  })

  it('rejects empty changeset', () => {
    assert.throws(() => EditInputSchema.parse({ changes: [] }))
  })

  it('rejects evidence missing source', () => {
    assert.throws(() => EditOutputSchema.parse([{ id: 'c1', observation: 'x' }]))
  })

  it('accepts file line_range and rejects non-file evidence sources', () => {
    assert.ok(EditOutputSchema.parse([{ id: 'c1', source: { kind: 'file', value: 'x.ts', line_range: [1, 2] }, observation: 'x' }]))
    assert.throws(() => EditOutputSchema.parse([{ id: 'c1', source: { kind: 'command', value: 'npm test' }, observation: 'x' }]))
  })
})

// ───────────────────────────────────────────────────────────────────
// test
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks test — definition shape & config', () => {
  it('is a TaskDefinition object literal with yolo / forge/fast and migrated shell usage', () => {
    assert.equal(testTask.__type, 'task')
    assert.equal(testTask.config.permission, 'yolo')
    assert.equal(testTask.config.agentRuntime, 'forge/fast')
    assert.equal(testTask.sourcePath, 'lib/standard/tasks/test.mts')

    const joined = (testTask.config.instructions ?? []).join('\n')
    assert.match(joined, /# Shell Usage/)
  })

  it('input supports acceptance criteria, direct verification commands, and capability selection', () => {
    assert.equal(typeof TestInputSchema.parse, 'function')
    assert.equal(typeof TestOutputSchema.parse, 'function')
  })

  it('prompt preserves generic verification behavior (no edits)', async () => {
    const prompt = await testTask.config.prompt(testInputSample)
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Verification Runner/)
    assert.match(prompt, /Do not edit files/)
    assert.match(prompt, /not_supported/)
  })
})

describe('standard/tasks test — schema behavior ({ acceptance_criteria: AcceptanceCriterion[], capability? } -> Evidence[]+Assessment[])', () => {
  it('parses valid input and output', () => {
    assert.deepEqual(TestInputSchema.parse(testInputSample), testInputSample)
    assert.deepEqual(TestOutputSchema.parse(testOutputSample), testOutputSample)
  })

  it('rejects a criterion missing then', () => {
    assert.throws(() => TestInputSchema.parse({ acceptance_criteria: [{ id: 'ac1', when: 'w' }] }))
  })

  it('accepts optional capability field', () => {
    const withCap = { acceptance_criteria: [{ id: 'ac1', given: 'x', when: 'y', then: 'z' }], capability: 'browser-use' }
    const parsed = TestInputSchema.parse(withCap)
    assert.equal(parsed.capability, 'browser-use')
  })

  it('accepts bounded verification commands and renders the direct-command fast path', async () => {
    const input = { ...testInputSample, verification_commands: ['npm test -- --runInBand'] }
    assert.deepEqual(TestInputSchema.parse(input), input)
    const prompt = await testTask.config.prompt(input)
    assert.match(prompt, /Verification Commands/)
    assert.match(prompt, /run them first and do not inspect project files/)
  })

  it('rejects invalid capability value', () => {
    assert.throws(() => TestInputSchema.parse({
      acceptance_criteria: [{ id: 'ac1', given: 'x', when: 'y', then: 'z' }],
      capability: 'invalid-cap',
    }))
  })

  it('rejects output missing assessments', () => {
    assert.throws(() => TestOutputSchema.parse({ evidences: [] }))
  })

  it('assessment status includes not_supported', () => {
    const ok = TestOutputSchema.parse({
      evidences: [{ id: 'ev1', source: { kind: 'command', value: 'x' }, observation: 'o' }],
      assessments: [{ criterion_id: 'ac1', status: 'not_supported', evidences: ['ev1'] }],
    })
    assert.equal(ok.assessments[0].status, 'not_supported')
  })
})

// ───────────────────────────────────────────────────────────────────
// commit
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks commit — definition shape & config', () => {
  it('is a TaskDefinition object literal with yolo and migrated commit instructions', () => {
    assert.equal(commitTask.__type, 'task')
    assert.equal(commitTask.config.permission, 'yolo')
    assert.equal(commitTask.config.agentRuntime, 'forge/fast')
    assert.equal(commitTask.sourcePath, 'lib/standard/tasks/commit.mts')

    const joined = (commitTask.config.instructions ?? []).join('\n')
    assert.match(joined, /# Commit Constraint/)
    assert.match(joined, /# Shell Usage/)
  })

  it('uses commit domain Zod schemas for input/output', () => {
    assert.equal(commitTask.config.input, CommitRequestSchema)
    assert.equal(commitTask.config.output, CommitReportSchema)
  })

  it('prompt preserves Author/Committer consistency and the no-push boundary', async () => {
    const prompt = await commitTask.config.prompt(commitInputSample)
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Structured Commit Agent/)
    assert.match(prompt, /Author and Committer/)
    assert.match(prompt, /never stage unrelated/i)
    assert.match(prompt, /NEVER run `git push`/)
    assert.doesNotMatch(prompt, /need_push/)
  })
})

describe('standard/tasks commit — schema behavior (CommitRequest -> CommitReport)', () => {
  it('parses valid request and report', () => {
    assert.equal('need_push' in CommitRequestSchema.shape, false)
    assert.equal('atomic_commit' in CommitRequestSchema.shape, true)
    assert.equal('pushed' in CommitReportSchema.shape, false)
    assert.deepEqual(CommitRequestSchema.parse(commitInputSample), commitInputSample)
    assert.deepEqual(CommitReportSchema.parse(commitOutputSample), commitOutputSample)
  })

  it('rejects request missing changes_to_commit', () => {
    assert.throws(() => CommitRequestSchema.parse({}))
  })

  it('rejects non-string staging scope', () => {
    assert.throws(() => CommitRequestSchema.parse({ changes_to_commit: { 'a.ts': 5 } }))
  })

  it('rejects report with invalid hash pattern', () => {
    assert.throws(() =>
      CommitReportSchema.parse({
        commits: [{ hash: '!!!', message: 'x', stats: commitOutputSample.commits[0].stats }],
      }),
    )
  })
})

// ───────────────────────────────────────────────────────────────────
// Cross-cutting: schemas convert to draft-07 JSON Schema (loader path)
// ───────────────────────────────────────────────────────────────────

describe('standard-library Batch D1 — Zod schemas convert to draft-07 JSON Schema', () => {
  const schemas = {
    exploreInput: ExploreInputSchema,
    exploreOutput: ExploreOutputSchema,
    editInput: EditInputSchema,
    editOutput: EditOutputSchema,
    testInput: TestInputSchema,
    testOutput: TestOutputSchema,
    commitInput: CommitRequestSchema,
    commitOutput: CommitReportSchema,
  }
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} converts via z.toJSONSchema(target: draft-07)`, () => {
      const json = z.toJSONSchema(schema as unknown as z.ZodType, { target: 'draft-07' }) as Record<string, unknown>
      assert.equal(json.$schema, 'http://json-schema.org/draft-07/schema#')
    })
  }
})
