import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import {
  TargetSchema,
  evidenceWith,
  findingWith,
} from '../lib/core/task/concepts.mts'
import {
  MarkdownTargetSchema,
  type MarkdownTarget,
} from '../lib/core/task/targets/markdown.mts'
import {
  GitCommitTargetSchema,
  type GitCommitTarget,
} from '../lib/core/task/targets/git-commit.mts'
import exploreTask, {
  ExploreInputSchema,
  ExploreOutputSchema,
} from '../lib/standard/tasks/explore.mts'
import exploreCodeTask from '../lib/standard/tasks/explore-code.mts'
import exploreCommitTask from '../lib/standard/tasks/explore-commit.mts'
import { resolveCapabilities } from '../lib/core/task/capabilities.mts'

// ───────────────────────────────────────────────────────────────────
// Shared sample fixtures
// ───────────────────────────────────────────────────────────────────

const goal = { outcome: 'Determine whether the batch exporter covers the final item' }
const questions = [{ id: 'q1', ask: 'Does the loop cover the final item?', blocking: true }]

const codeInputSample = {
  goal,
  questions,
  targets: [{ kind: 'file', value: 'src/batch.ts' }],
}

const codeOutputSample = {
  results: [
    {
      question_id: 'q1',
      status: 'answered' as const,
      findings: [
        {
          id: 'f1',
          conclusion: 'covered by inclusive bound',
          targets: [{ kind: 'file', value: 'src/batch.ts' }],
          evidences: ['ev1'],
          confidence: 'high' as const,
        },
      ],
    },
  ],
  evidences: [
    { id: 'ev1', source: { kind: 'file', value: 'src/batch.ts' }, observation: 'inclusive bound at line 40' },
  ],
}

const commitInputSample = {
  goal,
  questions,
  targets: [{ kind: 'git_commit', value: 'main', hash: 'HEAD~20..HEAD' }],
  count: 20,
  focus: 'exporter',
}

const commitOutputSample = {
  results: [
    {
      question_id: 'q1',
      status: 'answered' as const,
      findings: [
        {
          id: 'f1',
          conclusion: 'active development area: exporter',
          targets: [{ kind: 'git_commit', value: 'abc1234', hash: 'abc1234', theme: 'exporter' }],
          evidences: ['ev1'],
          confidence: 'medium' as const,
        },
      ],
    },
  ],
  evidences: [
    {
      id: 'ev1',
      source: { kind: 'git_commit', value: 'abc1234', hash: 'abc1234', date: '2026-07-10', theme: 'exporter' },
      observation: 'commit touched src/exporter.ts',
    },
  ],
}

// ───────────────────────────────────────────────────────────────────
// Direct explore definition and exported schemas
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks explore — direct definition, prompt & exported schemas', () => {
  it('is a direct readonly forge/fast TaskDefinition backed by the exported schemas', () => {
    assert.equal(exploreTask.__type, 'task')
    assert.equal(exploreTask.config.permission, 'readonly')
    assert.equal(exploreTask.config.agentRuntime, 'forge/fast')
    assert.equal(exploreTask.sourcePath, 'lib/standard/tasks/explore.mts')
    assert.deepEqual(exploreTask.config.instructions, [])
    assert.equal(exploreTask.config.input, ExploreInputSchema)
    assert.equal(exploreTask.config.output, ExploreOutputSchema)
    assert.equal(typeof exploreTask.config.prompt, 'function')
  })

  it('renders the generic role, problem inputs, and pooled-evidence output guidance', async () => {
    const prompt = await exploreTask.config.prompt({
      goal,
      questions,
      targets: [{ kind: 'url', value: 'https://example.test/reference' }],
      constraints: [{ rule: 'Use only the declared reference' }],
    })
    assert.match(prompt, /You are \*\*Explorer\*\*/)
    assert.match(prompt, /answered\|unanswered\|blocked/)
    assert.match(prompt, /Determine whether the batch exporter covers the final item/)
    assert.match(prompt, /Use only the declared reference/)
    assert.match(prompt, /pooled/)
    assert.match(prompt, /<result>/)
  })

  it('the exported schemas validate the unified open-target input and pooled output', () => {
    const input = {
      goal,
      questions,
      targets: [{ kind: 'custom_reference', value: 'reference-1' }],
    }
    const output = {
      results: [{ question_id: 'q1', status: 'unanswered' as const, findings: [] }],
      evidences: [
        {
          id: 'ev1',
          source: { kind: 'custom_reference', value: 'reference-1' },
          observation: 'No conclusive evidence was available',
        },
      ],
    }

    assert.deepEqual(ExploreInputSchema.parse(input), input)
    assert.deepEqual(ExploreOutputSchema.parse(output), output)
    assert.throws(() => ExploreInputSchema.parse({ goal, targets: input.targets }))
    assert.throws(() => ExploreInputSchema.parse({ goal, questions }))
    assert.throws(() => ExploreOutputSchema.parse({ results: output.results }))
  })

  it('keeps the direct family configuration differences explicit', () => {
    assert.deepEqual(
      [
        exploreTask.config.agentRuntime,
        exploreCodeTask.config.agentRuntime,
        exploreCommitTask.config.agentRuntime,
      ],
      ['forge/fast', 'forge/fast', 'forge/fast'],
    )
    assert.deepEqual(exploreCodeTask.config.instructions, [])
    assert.notDeepEqual(exploreCommitTask.config.instructions, [])
  })
})

// ───────────────────────────────────────────────────────────────────
// Domain targets: MarkdownTarget & GitCommitTarget satisfy open TargetBase
// ───────────────────────────────────────────────────────────────────

describe('standard-library Batch D3 — domain Targets satisfy open TargetBase', () => {
  it('MarkdownTarget narrows kind to literal markdown and carries title/category/freshness', () => {
    const parsed = MarkdownTargetSchema.parse({
      kind: 'markdown',
      value: 'docs/specs/x.md',
      title: 'X',
      category: 'spec',
      freshness: '2026-07-12',
    })
    assert.equal(parsed.kind, 'markdown')
    assert.equal(parsed.category, 'spec')
    assert.throws(() => MarkdownTargetSchema.parse({ kind: 'file', value: 'a' }))
  })

  it('GitCommitTarget narrows kind to literal git_commit and requires hash', () => {
    const parsed = GitCommitTargetSchema.parse({
      kind: 'git_commit',
      value: 'abc1234',
      hash: 'abc1234',
      date: '2026-07-10',
      theme: 'exporter',
    })
    assert.equal(parsed.kind, 'git_commit')
    assert.equal(parsed.hash, 'abc1234')
    assert.throws(() => GitCommitTargetSchema.parse({ kind: 'git_commit', value: 'x' })) // missing hash
    assert.throws(() => GitCommitTargetSchema.parse({ kind: 'file', value: 'a' }))
  })

  it('domain Targets DO NOT modify the open TargetSchema (D29 open polymorphism)', () => {
    // The open TargetSchema still accepts arbitrary kinds, unchanged.
    assert.ok(TargetSchema.parse({ kind: 'anything', value: 'v' }))
    // ...and it accepts a MarkdownTarget / GitCommitTarget instance without
    // error. (zod strips unknown keys, so only kind/value survive — that is
    // expected; the point is the open contract is preserved, not narrowed.)
    const md: MarkdownTarget = { kind: 'markdown', value: 'docs/x.md', title: 'X', category: 'spec' }
    const gc: GitCommitTarget = { kind: 'git_commit', value: 'h', hash: 'h', theme: 't' }
    assert.equal(TargetSchema.parse(md).kind, 'markdown')
    assert.equal(TargetSchema.parse(gc).kind, 'git_commit')
  })

  it('evidence/finding factories from concepts are reused (not redefined) by domain tasks', () => {
    assert.equal(typeof evidenceWith, 'function')
    assert.equal(typeof findingWith, 'function')
  })
})

// ───────────────────────────────────────────────────────────────────
// explore-code
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks explore-code — definition, prompt & schema', () => {
  it('is a direct readonly forge/fast TaskDefinition with FileTarget schemas', () => {
    assert.equal(exploreCodeTask.__type, 'task')
    assert.equal(exploreCodeTask.config.permission, 'readonly')
    assert.equal(exploreCodeTask.config.agentRuntime, 'forge/fast')
    assert.equal(exploreCodeTask.sourcePath, 'lib/standard/tasks/explore-code.mts')
    assert.deepEqual(exploreCodeTask.config.instructions, [])
  })

  it('prompt preserves rg preference and entry/data-flow tracing', async () => {
    const prompt = await exploreCodeTask.config.prompt(codeInputSample)
    assert.match(prompt, /Code Explorer/)
    assert.match(prompt, /rg/)
    assert.match(prompt, /entry/)
    assert.match(prompt, /data flow/)
    assert.match(prompt, /answered\|unanswered\|blocked/)
  })

  it('schema parses a valid unified input/output (file-targeted evidence)', () => {
    assert.ok(exploreCodeTask.config.input.parse(codeInputSample))
    assert.deepEqual(exploreCodeTask.config.output.parse(codeOutputSample), codeOutputSample)
  })

  it('rejects input missing questions and output missing pooled evidences', () => {
    assert.throws(() =>
      exploreCodeTask.config.input.parse({ goal, targets: [{ kind: 'file', value: 'a' }] }),
    )
    assert.throws(() => exploreCodeTask.config.output.parse({ results: [] }))
  })
})

// ───────────────────────────────────────────────────────────────────
// explore-commit
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks explore-commit — definition, prompt & schema', () => {
  it('is a direct readonly forge/fast TaskDefinition with GitCommitTarget schemas', () => {
    assert.equal(exploreCommitTask.__type, 'task')
    assert.equal(exploreCommitTask.config.permission, 'readonly')
    assert.equal(exploreCommitTask.config.agentRuntime, 'forge/fast')
    assert.equal(exploreCommitTask.sourcePath, 'lib/standard/tasks/explore-commit.mts')
    const joined = (exploreCommitTask.config.instructions ?? []).join('\n')
    assert.match(joined, /# Shell Usage/)
  })

  it('prompt preserves git log/show workflow and renders count + focus', async () => {
    const prompt = await exploreCommitTask.config.prompt(commitInputSample)
    assert.match(prompt, /Commit Explorer/)
    assert.match(prompt, /git --no-optional-locks log/)
    assert.match(prompt, /git --no-optional-locks show/)
    assert.match(prompt, /20/) // default count rendered
    assert.match(prompt, /exporter/) // focus rendered
    const noFocus = await exploreCommitTask.config.prompt({
      goal,
      questions,
      targets: [{ kind: 'git_commit', value: 'main', hash: 'HEAD' }],
    })
    assert.match(noFocus, /\(none\)/) // focus absent
  })

  it('prompt requests git commands only in the deployed git-history safe shapes', async () => {
    const prompt = await exploreCommitTask.config.prompt(commitInputSample)
    // All three deployed safe shapes carry --no-optional-locks.
    assert.match(prompt, /git --no-optional-locks log --oneline -20/)
    assert.match(prompt, /git --no-optional-locks show --name-only <hash>/)
    assert.match(prompt, /git --no-optional-locks show --stat <hash>/)
    // No generic log/show or percent-format command remains after the safe shapes are removed.
    const stripped = prompt
      .replaceAll('git --no-optional-locks log --oneline', '')
      .replaceAll('git --no-optional-locks show --name-only', '')
      .replaceAll('git --no-optional-locks show --stat', '')
    assert.doesNotMatch(stripped, /git log|git show|pretty=format|%H%x09|%ad%x09|%s/)
  })

  it('declares exactly git-history and resolves it for every input under readonly permission', () => {
    assert.equal(exploreCommitTask.config.permission, 'readonly')
    assert.deepEqual(exploreCommitTask.config.capabilities?.available, ['git-history'])
    // Deterministic selection: any input mounts exactly git-history.
    assert.deepEqual(
      resolveCapabilities(exploreCommitTask.config.capabilities, commitInputSample),
      ['git-history'],
    )
    assert.deepEqual(
      resolveCapabilities(exploreCommitTask.config.capabilities, {
        goal,
        questions,
        targets: [{ kind: 'git_commit', value: 'main', hash: 'HEAD' }],
      }),
      ['git-history'],
    )
  })

  it('schema parses a valid unified input/output with optional count extension (GitCommitTarget source)', () => {
    assert.ok(exploreCommitTask.config.input.parse(commitInputSample))
    // count/focus optional — parse without them
    assert.ok(
      exploreCommitTask.config.input.parse({
        goal,
        questions,
        targets: [{ kind: 'git_commit', value: 'main', hash: 'HEAD' }],
      }),
    )
    assert.deepEqual(exploreCommitTask.config.output.parse(commitOutputSample), commitOutputSample)
  })

  it('output narrows evidence source to GitCommitTarget (rejects non-git_commit kind)', () => {
    assert.throws(() =>
      exploreCommitTask.config.output.parse({
        results: [{ question_id: 'q1', status: 'answered', findings: [] }],
        evidences: [{ id: 'ev1', source: { kind: 'file', value: '/x' }, observation: 'wrong' }],
      }),
    )
    assert.ok(
      exploreCommitTask.config.output.parse({
        results: [{ question_id: 'q1', status: 'answered', findings: [] }],
        evidences: [
          { id: 'ev1', source: { kind: 'git_commit', value: 'h', hash: 'h', theme: 't' }, observation: 'ok' },
        ],
      }),
    )
  })
})

// ───────────────────────────────────────────────────────────────────
// Cross-cutting: schemas convert to draft-07 JSON Schema (loader path)
// ───────────────────────────────────────────────────────────────────

describe('standard-library Batch D3 — Zod schemas convert to draft-07 JSON Schema', () => {
  const schemas = {
    exploreInput: ExploreInputSchema,
    exploreOutput: ExploreOutputSchema,
    markdownTarget: MarkdownTargetSchema,
    gitCommitTarget: GitCommitTargetSchema,
    codeInput: exploreCodeTask.config.input,
    codeOutput: exploreCodeTask.config.output,
    commitInput: exploreCommitTask.config.input,
    commitOutput: exploreCommitTask.config.output,
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
