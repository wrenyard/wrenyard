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

// ───────────────────────────────────────────────────────────────────
// Shared sample fixtures
// ───────────────────────────────────────────────────────────────────

const goal = { outcome: 'Determine whether the batch exporter covers the final item' }
const questions = [{ id: 'q1', ask: 'Does the loop cover the final item?', blocking: true }]

// ───────────────────────────────────────────────────────────────────
// Direct explore definition and exported schemas
// ───────────────────────────────────────────────────────────────────

describe('standard/tasks explore — direct definition, prompt & exported schemas', () => {
  it('is a direct readonly TaskDefinition backed by the exported schemas with no runtime pin', () => {
    assert.equal(exploreTask.__type, 'task')
    assert.equal(exploreTask.config.permission, 'readonly')
    assert.equal('agentRuntime' in exploreTask.config, false)
    assert.equal('profile' in exploreTask.config, false)
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

  it('the generic ExploreInputSchema accepts code/git/markdown representative targets without executing a prompt', () => {
    // The merged explore role supersedes the retired explore-code and
    // explore-commit roles; its unified open-target input must accept file,
    // git_commit and markdown targets natively.
    for (const target of [
      { kind: 'file', value: 'src/batch.ts' },
      { kind: 'git_commit', value: 'main', hash: 'HEAD~20..HEAD' },
      { kind: 'markdown', value: 'docs/specs/x.md', title: 'X', category: 'spec' },
    ]) {
      const parsed = ExploreInputSchema.parse({ goal, questions, targets: [target] })
      assert.equal(parsed.targets[0].kind, target.kind)
    }
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
// Cross-cutting: schemas convert to draft-07 JSON Schema (loader path)
// ───────────────────────────────────────────────────────────────────

describe('standard-library Batch D3 — Zod schemas convert to draft-07 JSON Schema', () => {
  const schemas = {
    exploreInput: ExploreInputSchema,
    exploreOutput: ExploreOutputSchema,
    markdownTarget: MarkdownTargetSchema,
    gitCommitTarget: GitCommitTargetSchema,
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
