import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import {
  AssessmentSchema,
  CandidateSchema,
  ChangeSchema,
  ConstraintSchema,
  DecisionSchema,
  EvidenceSchema,
  evidenceWith,
  AcceptanceCriterionSchema,
  FileTargetSchema,
  FindingSchema,
  findingWith,
  GoalSchema,
  ProjectTargetSchema,
  QuestionSchema,
  CoreTargetSchema,
  TargetSchema,
  TargetBaseSchema,
  type Assessment,
  type AcceptanceCriterion,
  type Candidate,
  type Change,
  type Constraint,
  type CoreTarget,
  type Decision,
  type Evidence,
  type EvidenceDefault,
  type Finding,
  type FindingDefault,
  type FileTarget,
  type Goal,
  type ProjectTarget,
  type Question,
  type Ref,
  type Target,
  type TargetBase,
  type OtherTarget,
  conceptSchemas,
} from '../../../lib/core/task/concepts.mts'

describe('core/task concepts — schema + TS type duality (AC-1, D22)', () => {
  it('exports all 11 concepts plus Ref<T>, Target polymorphism, factories', () => {
    // 11 zod schemas
    const schemas = [
      GoalSchema, QuestionSchema, TargetSchema, ConstraintSchema,
      AcceptanceCriterionSchema, ChangeSchema, EvidenceSchema, FindingSchema,
      AssessmentSchema, DecisionSchema, CandidateSchema,
    ]
    assert.equal(schemas.length, 11)
    for (const s of schemas) assert.equal(typeof s.parse, 'function', 'zod schema must expose parse')

    // Ref<T> is a compile-time-only marker — at runtime it is `string`
    type _R = Ref<{ id: string }>
    const refSample: _R = 'abc'
    assert.equal(refSample, 'abc')

    // Target polymorphism
    assert.equal(typeof TargetBaseSchema.parse, 'function')
    assert.equal(typeof TargetSchema.parse, 'function')
    assert.equal(typeof CoreTargetSchema.parse, 'function')

    // Factory exports
    assert.equal(typeof evidenceWith, 'function')
    assert.equal(typeof findingWith, 'function')
  })

  it('conceptSchemas aggregate exposes every concept', () => {
    const keys = Object.keys(conceptSchemas).sort()
    assert.deepEqual(keys, [
      'AcceptanceCriterion',
      'ArtifactTarget',
      'Assessment',
      'Candidate',
      'Change',
      'CommandTarget',
      'Constraint',
      'CoreTarget',
      'Decision',
      'Evidence',
      'FileTarget',
      'Finding',
      'Goal',
      'OtherTarget',
      'ProjectTarget',
      'Question',
      'SymbolTarget',
      'Target',
      'TargetBase',
      'UrlTarget',
    ])
  })
})

describe('core/task concepts — Target is open, CoreTarget is closed (D29)', () => {
  it('TargetSchema accepts any kind, including unregistered domain kinds', () => {
    const md = TargetSchema.parse({ kind: 'markdown', value: '/tmp/note.md' })
    assert.deepEqual(md, { kind: 'markdown', value: '/tmp/note.md' })

    const custom = TargetSchema.parse({ kind: 'custom_kind', value: 'whatever' })
    assert.equal(custom.kind, 'custom_kind')
  })

  it('CoreTargetSchema rejects unregistered kinds (the rationale for open Target — F1)', () => {
    assert.throws(
      () => CoreTargetSchema.parse({ kind: 'markdown', value: '/tmp/note.md' }),
    )
  })

  it('CoreTargetSchema accepts every known kind', () => {
    const known = [
      { kind: 'file', value: '/tmp/a.ts' },
      { kind: 'file', value: '/tmp/a.ts', line_range: [1, 10] },
      { kind: 'symbol', value: 'foo' },
      { kind: 'command', value: 'npm test' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'project', value: 'ure/service' },
      { kind: 'artifact', value: 'build-123' },
      { kind: 'other', value: 'misc' },
    ]
    for (const target of known) {
      assert.ok(CoreTargetSchema.parse(target), `expected ${target.kind} to parse`)
    }
  })

  it('FileTargetSchema line_range is a 2-tuple of numbers', () => {
    assert.throws(() => FileTargetSchema.parse({ kind: 'file', value: '/x', line_range: [1] }))
    assert.throws(() => FileTargetSchema.parse({ kind: 'file', value: '/x', line_range: ['a', 'b'] }))
    const ok = FileTargetSchema.parse({ kind: 'file', value: '/x', line_range: [1, 10] })
    assert.deepEqual(ok.line_range, [1, 10])
  })

  it('TS Target type is the open TargetBase alias (not the closed CoreTarget)', () => {
    // Compile-time check: any object with kind:string + value:string satisfies Target.
    const t: Target = { kind: 'whatever', value: 'x' }
    assert.equal(t.kind, 'whatever')
    // CoreTarget requires a known kind literal.
    const c: CoreTarget = { kind: 'file', value: '/x' }
    assert.equal(c.kind, 'file')
  })
})

describe('core/task concepts — Assessment.status includes not_supported (AC-1)', () => {
  it('parses all four statuses including not_supported', () => {
    const ok = AssessmentSchema.parse({ criterion_id: 'ac1', status: 'not_supported', evidences: [] })
    assert.equal(ok.status, 'not_supported')

    const statuses = ['passed', 'failed', 'blocked', 'not_supported'] as const
    for (const status of statuses) {
      const parsed = AssessmentSchema.parse({ criterion_id: 'ac1', status, evidences: ['ev1'] })
      assert.equal(parsed.status, status)
    }
  })

  it('rejects unknown statuses', () => {
    assert.throws(() =>
      AssessmentSchema.parse({ criterion_id: 'ac1', status: 'skipped', evidences: [] }),
    )
  })

  it('requires criterion_id and evidences; reason is optional', () => {
    assert.throws(() => AssessmentSchema.parse({ status: 'passed', evidences: [] }))
    assert.throws(() => AssessmentSchema.parse({ criterion_id: 'ac1', status: 'passed' }))
    const minimal = AssessmentSchema.parse({ criterion_id: 'ac1', status: 'passed', evidences: [] })
    assert.equal(minimal.reason, undefined)
  })
})

describe('core/task concepts — schema → JSON Schema → AJV (D25 修正 / B1)', () => {
  it('every concept schema converts via z.toJSONSchema(target:draft-07)', () => {
    for (const [name, schema] of Object.entries(conceptSchemas)) {
      const json = z.toJSONSchema(schema as any, { target: 'draft-07' }) as Record<string, unknown>
      assert.equal(json.$schema, 'http://json-schema.org/draft-07/schema#', `${name} should produce draft-07`)
      assert.ok(typeof json.type === 'string' || typeof json.oneOf === 'string' || Array.isArray(json.oneOf) || typeof json.allOf === 'string' || Array.isArray(json.allOf), `${name} should produce a typed schema`)
    }
  })

  it('AssessmentSchema converts to a JSON Schema with all four enum values', () => {
    const json = z.toJSONSchema(AssessmentSchema, { target: 'draft-07' }) as any
    const statusProp = json.properties.status
    assert.equal(statusProp.type, 'string')
    assert.deepEqual(statusProp.enum, ['passed', 'failed', 'blocked', 'not_supported'])
  })
})

describe('core/task concepts — generic Evidence / Finding factories (D30)', () => {
  it('evidenceWith narrows source to a domain Target subtype', () => {
    const MarkdownTargetSchema = FileTargetSchema.extend({ kind: z.literal('markdown') })
    const MarkdownEvidenceSchema = evidenceWith(MarkdownTargetSchema)

    const ok = MarkdownEvidenceSchema.parse({
      id: 'ev1',
      source: { kind: 'markdown', value: '/tmp/note.md' },
      observation: 'saw a note',
    })
    assert.equal(ok.source.kind, 'markdown')

    // file kind is no longer accepted in the narrowed schema
    assert.throws(() =>
      MarkdownEvidenceSchema.parse({
        id: 'ev2',
        source: { kind: 'file', value: '/tmp/note.md' },
        observation: 'wrong kind',
      }),
    )
  })

  it('findingWith narrows targets to a domain Target subtype', () => {
    const MarkdownTargetSchema = FileTargetSchema.extend({ kind: z.literal('markdown') })
    const MarkdownFindingSchema = findingWith(MarkdownTargetSchema)

    const ok = MarkdownFindingSchema.parse({
      id: 'f1',
      conclusion: 'note confirmed',
      targets: [{ kind: 'markdown', value: '/tmp/note.md' }],
      evidences: ['ev1'],
      confidence: 'high',
    })
    assert.equal(ok.targets?.[0].kind, 'markdown')

    assert.throws(() =>
      MarkdownFindingSchema.parse({
        id: 'f2',
        conclusion: 'wrong',
        targets: [{ kind: 'file', value: '/x' }],
        evidences: [],
        confidence: 'low',
      }),
    )
  })

  it('TS Evidence<TTarget> generic narrows source at compile time', () => {
    type MarkdownTarget = { kind: 'markdown'; value: string }
    const md: MarkdownTarget = { kind: 'markdown', value: '/x' }
    const ev: Evidence<MarkdownTarget> = { id: 'ev1', source: md, observation: 'obs' }
    // @ts-expect-error — wrong target kind should not typecheck
    const bad: Evidence<MarkdownTarget> = { id: 'ev2', source: { kind: 'file', value: '/x' }, observation: 'obs' }
    assert.equal(ev.source.kind, 'markdown')
    // The bad value still exists at runtime (TS-erasable), but the type guard above caught it.
    assert.equal((bad as Evidence).source.kind, 'file')
  })

  it('default Evidence / Finding types match z.infer of base schemas', () => {
    const ev: EvidenceDefault = EvidenceSchema.parse({
      id: 'ev1',
      source: { kind: 'file', value: '/x' },
      observation: 'obs',
    })
    assert.equal(ev.source.kind, 'file')

    const f: FindingDefault = FindingSchema.parse({
      id: 'f1',
      conclusion: 'concluded',
      evidences: ['ev1'],
      confidence: 'high',
    })
    assert.equal(f.id, 'f1')
  })
})

describe('core/task concepts — per-concept schema behaviors', () => {
  it('Goal requires outcome string', () => {
    assert.deepEqual(GoalSchema.parse({ outcome: 'ship it' }), { outcome: 'ship it' })
    assert.throws(() => GoalSchema.parse({ statement: 'ship it' }))
    assert.throws(() => GoalSchema.parse({}))
  })

  it('AcceptanceCriterion uses given/when/then (D11)', () => {
    const ac = AcceptanceCriterionSchema.parse({
      id: 'ac1',
      given: 'a file exists',
      when: 'edit runs',
      then: 'content changes',
    })
    assert.equal(ac.when, 'edit runs')
    // `given` is optional
    const minimal = AcceptanceCriterionSchema.parse({ id: 'ac2', when: 'w', then: 't' })
    assert.equal(minimal.given, undefined)
  })

  it('Constraint.rule required, decisions optional (back-ref to Decision)', () => {
    const ok = ConstraintSchema.parse({ rule: 'no breaking changes' })
    assert.equal(ok.rule, 'no breaking changes')
    const withDecisions = ConstraintSchema.parse({ rule: 'x', decisions: ['d1', 'd2'] })
    assert.deepEqual(withDecisions.decisions, ['d1', 'd2'])
  })

  it('Change splits instruction and expected (D12)', () => {
    const ch = ChangeSchema.parse({
      target: { kind: 'file', value: '/x' },
      action: 'update',
      instruction: 'add export',
      expected: 'symbol exported',
    })
    assert.equal(ch.action, 'update')
    assert.equal(ch.instruction, 'add export')
    assert.equal(ch.expected, 'symbol exported')
    assert.throws(() =>
      ChangeSchema.parse({ target: { kind: 'file', value: '/x' }, action: 'update', instruction: 'add' }),
    )
  })

  it('Decision has id, choice, optional rationale/supersedes', () => {
    const minimal = DecisionSchema.parse({ id: 'd1', choice: 'use zod' })
    assert.equal(minimal.choice, 'use zod')
    const full = DecisionSchema.parse({
      id: 'd2',
      choice: 'use zod 4',
      rationale: 'better TS inference',
      supersedes: ['d1'],
    })
    assert.deepEqual(full.supersedes, ['d1'])
  })

  it('Question has id, ask, blocking (no question/text synonyms)', () => {
    const q = QuestionSchema.parse({ id: 'q1', ask: 'why?', blocking: true })
    assert.equal(q.ask, 'why?')
    assert.equal(q.blocking, true)
    assert.throws(() => QuestionSchema.parse({ id: 'q1', question: 'why?', blocking: true }))
    assert.throws(() => QuestionSchema.parse({ id: 'q1', ask: 'why?' }))
  })

  it('Candidate kind is option|hypothesis|scope', () => {
    for (const kind of ['option', 'hypothesis', 'scope'] as const) {
      const c = CandidateSchema.parse({ id: 'c1', kind, proposal: 'x' })
      assert.equal(c.kind, kind)
    }
    assert.throws(() => CandidateSchema.parse({ id: 'c1', kind: 'idea', proposal: 'x' }))
  })

  it('Finding confidence is high|medium|low', () => {
    const f = FindingSchema.parse({
      id: 'f1',
      conclusion: 'c',
      evidences: [],
      confidence: 'medium',
    })
    assert.equal(f.confidence, 'medium')
    assert.throws(() =>
      FindingSchema.parse({ id: 'f1', conclusion: 'c', evidences: [], confidence: 'certain' }),
    )
  })

  it('ProjectTarget value is the qualified project name', () => {
    const pt = ProjectTargetSchema.parse({ kind: 'project', value: 'ure/service' })
    assert.equal(pt.value, 'ure/service')
    assert.throws(() => ProjectTargetSchema.parse({ kind: 'project' }))
  })
})

describe('core/task concepts — TS type + z.infer agreement (D22 schema-as-type)', () => {
  it('Evidence<Target> matches z.infer<EvidenceSchema>', () => {
    const inferred: EvidenceDefault = { id: 'e', source: { kind: 'file', value: '/x' }, observation: 'o' }
    const manual: Evidence<Target> = inferred
    assert.equal(manual.id, 'e')
  })

  it('Finding<Target> matches z.infer<FindingSchema>', () => {
    const inferred: FindingDefault = {
      id: 'f',
      conclusion: 'c',
      targets: [{ kind: 'file', value: '/x' }],
      evidences: ['e'],
      confidence: 'high',
    }
    const manual: Finding<Target> = inferred
    assert.equal(manual.id, 'f')
  })

  it('all 11 concept TS types are independently referenceable', () => {
    const g: Goal = { outcome: 'x' }
    const ac: AcceptanceCriterion = { id: 'a', when: 'w', then: 't' }
    const t: Target = { kind: 'k', value: 'v' }
    const c: Constraint = { rule: 'r' }
    const ch: Change = { target: t, action: 'create', instruction: 'i', expected: 'e' }
    const ev: Evidence = { id: 'e', source: t, observation: 'o' }
    const f: Finding = { id: 'f', conclusion: 'c', evidences: [], confidence: 'low' }
    const a: Assessment = { criterion_id: 'ac', status: 'passed', evidences: [] }
    const d: Decision = { id: 'd', choice: 'c' }
    const q: Question = { id: 'q', ask: 'a', blocking: false }
    const cand: Candidate = { id: 'c', kind: 'option', proposal: 'p' }

    // Touch each to ensure they are used.
    assert.ok(g && ac && t && c && ch && ev && f && a && d && q && cand)
  })

  it('Target subtype interfaces extend TargetBase', () => {
    const ft: FileTarget = { kind: 'file', value: '/x', line_range: [1, 2] }
    const pt: ProjectTarget = { kind: 'project', value: 'a/b' }
    const ot: OtherTarget = { kind: 'other', value: 'misc' }

    // All three are assignable to TargetBase (open contract).
    const tb1: TargetBase = ft
    const tb2: TargetBase = pt
    const tb3: TargetBase = ot
    assert.ok(tb1 && tb2 && tb3)
  })
})
