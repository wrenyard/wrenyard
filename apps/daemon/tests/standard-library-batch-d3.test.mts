import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { TargetSchema } from '../lib/core/task/concepts.mts'
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
  it('is a direct observational TaskDefinition backed by the exported schemas with no permission field', () => {
    assert.equal(exploreTask.__type, 'task')
    assert.equal('permission' in exploreTask.config, false)
    assert.equal('agentRuntime' in exploreTask.config, false)
    assert.equal('profile' in exploreTask.config, false)
    assert.equal(exploreTask.sourcePath, 'lib/standard/tasks/explore.mts')
    assert.match((exploreTask.config.instructions ?? []).join('\n'), /# Shell Usage/)
    assert.equal(exploreTask.config.input, ExploreInputSchema)
    assert.equal(exploreTask.config.output, ExploreOutputSchema)
    assert.equal(typeof exploreTask.config.prompt, 'function')
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
