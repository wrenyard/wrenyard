import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { Ajv } from 'ajv'
import librarianTask, {
  LibrarianInputSchema,
  LibrarianOutputSchema,
} from '../lib/standard/tasks/librarian.mts'
import lookAtTask, {
  LookAtInputSchema,
  LookAtOutputSchema,
} from '../lib/standard/tasks/look-at.mts'
import oracleTask, {
  OracleInputSchema,
  OracleOutputSchema,
} from '../lib/standard/tasks/oracle.mts'
import codeReviewTask, {
  CodeReviewChangeSchema,
  CodeReviewInputSchema,
  CodeReviewOutputSchema,
} from '../lib/standard/tasks/code-review.mts'

// ───────────────────────────────────────────────────────────────────
// Shared sample fixtures
// ───────────────────────────────────────────────────────────────────

const goal = { outcome: 'Determine whether the batch exporter is correct' }
const questions = [{ id: 'q1', ask: 'Does the loop cover the final item?', blocking: true }]

const librarianInputSample = {
  goal,
  questions,
  constraints: [{ rule: 'Prefer official docs' }],
}

const librarianOutputSample = {
  findings: [
    {
      id: 'f1',
      conclusion: 'Loop end bound is exclusive',
      targets: [],
      evidences: ['ev1'],
      confidence: 'high',
    },
  ],
  evidences: [
    { id: 'ev1', source: { kind: 'url', value: 'https://example.com/batch' }, observation: 'docs show exclusive bound' },
  ],
}

const lookAtInputSample = {
  question: { id: 'q1', ask: 'What color is the error banner?', blocking: true },
  image: { kind: 'file', value: '/tmp/shot.png' },
}

const lookAtOutputSample = {
  findings: [
    { id: 'f1', conclusion: 'The banner is red', targets: [], evidences: ['ev1'], confidence: 'high' },
  ],
  evidences: [
    { id: 'ev1', source: { kind: 'file', value: '/tmp/shot.png' }, observation: 'red banner top-right' },
  ],
}

const oracleInputSample = {
  goal,
  questions,
  context: 'The loop uses i < n; client reports last item missing.',
  constraints: [{ rule: 'No new dependencies' }],
}

const oracleOutputSample = {
  findings: [
    { id: 'f1', conclusion: 'Exclusive bound drops last item', targets: [], evidences: ['ev1'], confidence: 'high' },
  ],
  decisions: [
    {
      id: 'd1',
      choice: 'Use inclusive bound i <= n (effort: Quick, confidence: high)',
      rationale: 'Change loop condition; single-line fix.',
    },
  ],
  questions: [],
}

const codeReviewInputSample = {
  goal,
  targets: [{ kind: 'file', value: 'src/batch.ts' }],
  constraints: [{ rule: 'Public API unchanged' }],
  acceptance_criteria: [{ id: 'ac1', when: 'batch runs', then: 'every item is processed' }],
  changes: [
    {
      target: { kind: 'file', value: 'src/batch.ts' },
      action: 'update',
      instruction: 'process items',
      expected: 'all items processed',
    },
  ],
}

const codeReviewApprovedSample = {
  assessments: [{ criterion_id: 'ac1', status: 'passed', evidences: ['ev1'] }],
  findings: [],
  required_changes: [],
  evidences: [
    { id: 'ev1', source: { kind: 'file', value: 'src/batch.ts' }, observation: 'all items processed' },
  ],
}

const codeReviewFailedSample = {
  assessments: [{ criterion_id: 'ac1', status: 'failed', evidences: ['ev1'] }],
  findings: [
    {
      id: 'f1',
      conclusion: 'definite_correctness_bug: last item dropped',
      targets: [{ kind: 'file', value: 'src/batch.ts', line_range: [40, 58] }],
      evidences: ['ev1'],
      confidence: 'high',
    },
  ],
  required_changes: [
    {
      target: { kind: 'file', value: 'src/batch.ts' },
      action: 'update',
      instruction: 'Use an inclusive end bound',
      expected: 'Final item is processed',
    },
  ],
  evidences: [
    { id: 'ev1', source: { kind: 'file', value: 'src/batch.ts' }, observation: 'exclusive bound' },
  ],
}

// ───────────────────────────────────────────────────────────────────
// librarian
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks librarian — definition shape & config', () => {
  it('is a TaskDefinition object literal with readonly / forge/general and migrated shell usage', () => {
    assert.equal(librarianTask.__type, 'task')
    assert.equal(librarianTask.config.permission, 'readonly')
    assert.equal(librarianTask.config.agentRuntime, 'forge/general')
    assert.equal(librarianTask.sourcePath, 'lib/standard/tasks/librarian.mts')

    const joined = (librarianTask.config.instructions ?? []).join('\n')
    assert.match(joined, /# Shell Usage/)
  })

  it('input/output are Zod schemas', () => {
    assert.equal(typeof LibrarianInputSchema.parse, 'function')
    assert.equal(typeof LibrarianOutputSchema.parse, 'function')
  })

  it('prompt preserves web-only read-only research role', async () => {
    const prompt = await librarianTask.config.prompt(librarianInputSample)
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Librarian/)
    assert.match(prompt, /READ-ONLY/)
    assert.match(prompt, /fabricate/)
    assert.match(prompt, /Goal/)
    assert.match(prompt, /Questions/)
  })
})

describe('standard/tasks librarian — schema behavior', () => {
  it('parses a valid input and output', () => {
    assert.deepEqual(LibrarianInputSchema.parse(librarianInputSample), librarianInputSample)
    assert.deepEqual(LibrarianOutputSchema.parse(librarianOutputSample), librarianOutputSample)
  })

  it('rejects input missing questions', () => {
    assert.throws(() => LibrarianInputSchema.parse({ goal: { outcome: 'x' } }))
  })

  it('accepts url-targeted evidence (web source)', () => {
    const parsed = LibrarianOutputSchema.parse({
      findings: [{ id: 'f1', conclusion: 'c', targets: [], evidences: ['ev1'], confidence: 'medium' }],
      evidences: [{ id: 'ev1', source: { kind: 'url', value: 'https://x' }, observation: 'o' }],
    })
    assert.equal(parsed.evidences[0].source.kind, 'url')
  })
})

// ───────────────────────────────────────────────────────────────────
// look-at
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks look-at — definition shape & config', () => {
  it('is a TaskDefinition object literal with readonly / forge/gk-kimi', () => {
    assert.equal(lookAtTask.__type, 'task')
    assert.equal(lookAtTask.config.permission, 'readonly')
    assert.equal(lookAtTask.config.agentRuntime, 'forge/gk-kimi')
    assert.equal(lookAtTask.sourcePath, 'lib/standard/tasks/look-at.mts')
    assert.deepEqual(lookAtTask.config.instructions, [])
  })

  it('input/output are Zod schemas', () => {
    assert.equal(typeof LookAtInputSchema.parse, 'function')
    assert.equal(typeof LookAtOutputSchema.parse, 'function')
  })

  it('prompt preserves multimodal runtime (view the image directly)', async () => {
    const prompt = await lookAtTask.config.prompt(lookAtInputSample)
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Look At/)
    assert.match(prompt, /View this file directly/)
    assert.match(prompt, /image input/)
    assert.match(prompt, /Question/)
  })
})

describe('standard/tasks look-at — schema behavior', () => {
  it('parses a valid input and output', () => {
    assert.deepEqual(LookAtInputSchema.parse(lookAtInputSample), lookAtInputSample)
    assert.deepEqual(LookAtOutputSchema.parse(lookAtOutputSample), lookAtOutputSample)
  })

  it('rejects input missing image', () => {
    assert.throws(() =>
      LookAtInputSchema.parse({ question: { id: 'q1', ask: '?', blocking: false } }),
    )
  })

  it('rejects input missing question', () => {
    assert.throws(() => LookAtInputSchema.parse({ image: { kind: 'file', value: '/x' } }))
  })
})

// ───────────────────────────────────────────────────────────────────
// oracle
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks oracle — definition shape & config', () => {
  it('is a TaskDefinition object literal with readonly / forge/ultra', () => {
    assert.equal(oracleTask.__type, 'task')
    assert.equal(oracleTask.config.permission, 'readonly')
    assert.equal(oracleTask.config.agentRuntime, 'forge/ultra')
    assert.equal(oracleTask.sourcePath, 'lib/standard/tasks/oracle.mts')
    assert.deepEqual(oracleTask.config.instructions, [])
  })

  it('input/output are Zod schemas', () => {
    assert.equal(typeof OracleInputSchema.parse, 'function')
    assert.equal(typeof OracleOutputSchema.parse, 'function')
  })

  it('prompt preserves read-only strategic advisor role', async () => {
    const prompt = await oracleTask.config.prompt(oracleInputSample)
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Oracle/)
    assert.match(prompt, /read-only/i)
    assert.match(prompt, /advise/)
    assert.match(prompt, /decisions/)
    assert.match(prompt, /questions/)
  })
})

describe('standard/tasks oracle — schema behavior', () => {
  it('parses a valid input and output', () => {
    assert.deepEqual(OracleInputSchema.parse(oracleInputSample), oracleInputSample)
    assert.deepEqual(OracleOutputSchema.parse(oracleOutputSample), oracleOutputSample)
  })

  it('context is optional on input', () => {
    const parsed = OracleInputSchema.parse({ goal: { outcome: 'x' }, questions })
    assert.equal(parsed.context, undefined)
  })

  it('output decisions and questions may be empty', () => {
    const ok = OracleOutputSchema.parse({
      findings: [{ id: 'f1', conclusion: 'c', targets: [], evidences: [], confidence: 'low' }],
      decisions: [],
      questions: [],
    })
    assert.equal(ok.decisions.length, 0)
  })

  it('rejects output missing decisions or questions', () => {
    assert.throws(() =>
      OracleOutputSchema.parse({
        findings: [],
        decisions: [{ id: 'd1', choice: 'x' }],
      }),
    )
    assert.throws(() =>
      OracleOutputSchema.parse({
        findings: [],
        questions: [],
      }),
    )
  })
})

// ───────────────────────────────────────────────────────────────────
// code-review
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks code-review — definition shape & config', () => {
  it('is a TaskDefinition object literal with readonly / forge/general and migrated shell usage', () => {
    assert.equal(codeReviewTask.__type, 'task')
    assert.equal(codeReviewTask.config.permission, 'readonly')
    assert.equal(codeReviewTask.config.agentRuntime, 'forge/general')
    assert.equal(codeReviewTask.sourcePath, 'lib/standard/tasks/code-review.mts')

    const joined = (codeReviewTask.config.instructions ?? []).join('\n')
    assert.match(joined, /# Shell Usage/)
  })

  it('input/output are Zod schemas', () => {
    assert.equal(typeof CodeReviewInputSchema.parse, 'function')
    assert.equal(typeof CodeReviewOutputSchema.parse, 'function')
  })

  it('required_changes schema narrows target to FileTarget', () => {
    assert.throws(() =>
      CodeReviewChangeSchema.parse({
        target: { kind: 'symbol', value: 'foo' },
        action: 'update',
        instruction: 'x',
        expected: 'y',
      }),
    )
    assert.ok(
      CodeReviewChangeSchema.parse({
        target: { kind: 'file', value: 'src/x.ts' },
        action: 'update',
        instruction: 'x',
        expected: 'y',
      }),
    )
  })

  it('prompt preserves blocking-only review behavior', async () => {
    const prompt = await codeReviewTask.config.prompt(codeReviewInputSample)
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Code Quality Reviewer/)
    assert.match(prompt, /BLOCKING-ONLY/)
    assert.match(prompt, /definite_correctness_bug/)
    assert.match(prompt, /required_changes/)
    assert.match(prompt, /approved/)
  })
})

describe('standard/tasks code-review — schema behavior (blocking-only invariant)', () => {
  it('parses an approved review (empty findings/required_changes, all passed)', () => {
    assert.deepEqual(CodeReviewOutputSchema.parse(codeReviewApprovedSample), codeReviewApprovedSample)
  })

  it('parses a failed review (findings + required_changes + failed assessment)', () => {
    assert.deepEqual(CodeReviewOutputSchema.parse(codeReviewFailedSample), codeReviewFailedSample)
  })

  it('rejects findings present without required_changes (and vice versa)', () => {
    assert.throws(() =>
      CodeReviewOutputSchema.parse({
        assessments: [{ criterion_id: 'ac1', status: 'failed', evidences: [] }],
        findings: [{ id: 'f1', conclusion: 'c', targets: [], evidences: [], confidence: 'high' }],
        required_changes: [],
        evidences: [],
      }),
    )
    assert.throws(() =>
      CodeReviewOutputSchema.parse({
        assessments: [{ criterion_id: 'ac1', status: 'failed', evidences: [] }],
        findings: [],
        required_changes: [
          { target: { kind: 'file', value: 'src/x.ts' }, action: 'update', instruction: 'x', expected: 'y' },
        ],
        evidences: [],
      }),
    )
  })

  it('rejects an "approved" review with a non-passed assessment', () => {
    assert.throws(() =>
      CodeReviewOutputSchema.parse({
        assessments: [{ criterion_id: 'ac1', status: 'failed', evidences: [] }],
        findings: [],
        required_changes: [],
        evidences: [],
      }),
    )
  })

  it('input parses with optional evidences omitted', () => {
    const parsed = CodeReviewInputSchema.parse(codeReviewInputSample)
    assert.equal(parsed.evidences, undefined)
    assert.deepEqual(parsed, codeReviewInputSample)
  })
})

describe('standard/tasks code-review — AJV compileSchema validation', () => {
  const ajv = new Ajv()

  it('compiles to valid draft-07 JSON Schema', () => {
    const jsonSchema = z.toJSONSchema(CodeReviewOutputSchema as unknown as z.ZodType, {
      target: 'draft-07',
    }) as Record<string, unknown>
    assert.equal(jsonSchema.$schema, 'http://json-schema.org/draft-07/schema#')
    // Must be an anyOf/oneOf (union) rather than a simple object
    assert.ok(jsonSchema.anyOf || jsonSchema.oneOf)
  })

  it('rejects findings present without required_changes via AJV', () => {
    const jsonSchema = z.toJSONSchema(CodeReviewOutputSchema as unknown as z.ZodType, {
      target: 'draft-07',
    })
    const validate = ajv.compile(jsonSchema)

    assert.ok(
      !validate({
        assessments: [{ criterion_id: 'ac1', status: 'failed', evidences: [] }],
        findings: [{ id: 'f1', conclusion: 'c', targets: [], evidences: [], confidence: 'high' }],
        required_changes: [],
        evidences: [],
      }),
      'expected findings-without-required_changes to fail AJV validation',
    )
  })

  it('rejects required_changes present without findings via AJV', () => {
    const jsonSchema = z.toJSONSchema(CodeReviewOutputSchema as unknown as z.ZodType, {
      target: 'draft-07',
    })
    const validate = ajv.compile(jsonSchema)

    assert.ok(
      !validate({
        assessments: [{ criterion_id: 'ac1', status: 'failed', evidences: [] }],
        findings: [],
        required_changes: [
          { target: { kind: 'file', value: 'src/x.ts' }, action: 'update', instruction: 'x', expected: 'y' },
        ],
        evidences: [],
      }),
      'expected required_changes-without-findings to fail AJV validation',
    )
  })

  it('rejects approved review with non-passed assessment via AJV', () => {
    const jsonSchema = z.toJSONSchema(CodeReviewOutputSchema as unknown as z.ZodType, {
      target: 'draft-07',
    })
    const validate = ajv.compile(jsonSchema)

    assert.ok(
      !validate({
        assessments: [{ criterion_id: 'ac1', status: 'failed', evidences: [] }],
        findings: [],
        required_changes: [],
        evidences: [],
      }),
      'expected approved-with-failed-assessment to fail AJV validation',
    )
  })

  it('accepts valid approved review via AJV', () => {
    const jsonSchema = z.toJSONSchema(CodeReviewOutputSchema as unknown as z.ZodType, {
      target: 'draft-07',
    })
    const validate = ajv.compile(jsonSchema)

    assert.ok(validate(codeReviewApprovedSample), 'expected valid approved sample to pass AJV')
  })

  it('accepts valid blocking review via AJV', () => {
    const jsonSchema = z.toJSONSchema(CodeReviewOutputSchema as unknown as z.ZodType, {
      target: 'draft-07',
    })
    const validate = ajv.compile(jsonSchema)

    assert.ok(validate(codeReviewFailedSample), 'expected valid blocking sample to pass AJV')
  })
})

// ───────────────────────────────────────────────────────────────────
// Cross-cutting: schemas convert to draft-07 JSON Schema (loader path)
// ───────────────────────────────────────────────────────────────────

describe('standard-library Batch D2 — Zod schemas convert to draft-07 JSON Schema', () => {
  const schemas = {
    librarianInput: LibrarianInputSchema,
    librarianOutput: LibrarianOutputSchema,
    lookAtInput: LookAtInputSchema,
    lookAtOutput: LookAtOutputSchema,
    oracleInput: OracleInputSchema,
    oracleOutput: OracleOutputSchema,
    codeReviewInput: CodeReviewInputSchema,
    codeReviewOutput: CodeReviewOutputSchema,
  }
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} converts via z.toJSONSchema(target: draft-07)`, () => {
      const json = z.toJSONSchema(schema as unknown as z.ZodType, {
        target: 'draft-07',
      }) as Record<string, unknown>
      assert.equal(json.$schema, 'http://json-schema.org/draft-07/schema#')
    })
  }
})
