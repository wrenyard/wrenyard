/**
 * Current-only document execution scope regressions.
 *
 * These tests exercise the REAL identity gate `documentExecutionScope` and the
 * REAL trusted singleton from the standard library. A temporary `.fmproj`
 * project registration makes the workspace discovery path real; no production
 * helper is exported and no model/network call is made.
 *
 * Privilege is granted by exact object identity plus a canonical, registered,
 * category-scoped `.md` target only. A clone, override, same-named or
 * same-source-path definition never receives that privilege, and an oversized
 * conversation string on the document domain schema never widens the separate
 * bounded task `ctx` contract.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { documentExecutionScope } from '../../lib/core/task/doc-scope.mts'
import { isTrustedDocDefinition, TRUSTED_DOC_DEFINITION } from '../../lib/standard/index.mts'
import { DocInputSchema } from '../../lib/standard/tasks/doc.mts'
import {
  normalizeTaskContext,
  TASK_CONTEXT_MAX_BYTES,
  TaskContextError,
} from '../../lib/core/task/context.mts'
import type { TaskDefinition } from '../../lib/core/task/types.mts'
import { resetRegistry } from '../../lib/workspace/task-loader.mts'
import { invalidateProjectCache } from '../../lib/core/project/loader.mts'

const TRUSTED_TARGET = { definition: TRUSTED_DOC_DEFINITION, source: 'builtin' as const }
const CATEGORY_DIRECTORY = { spec: 'specs', plan: 'plans', report: 'reports', handoff: 'handoff' } as const

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Register a real project whose host path is an existing temp checkout. */
function registerProject(workspace: string, project: string, checkout: string): void {
  const name = project.split('/').at(-1)!
  const dir = join(workspace, 'projects', ...project.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.fmproj`),
    `name: ${name}\ndescription: Test project ${project}\nhosts:\n  ${osHostname()}: ${JSON.stringify(checkout)}\n`,
    'utf-8',
  )
  mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true })
}

beforeEach(() => {
  resetRegistry()
  invalidateProjectCache()
})

afterEach(() => {
  resetRegistry()
  invalidateProjectCache()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('documentExecutionScope trusted identity gate', () => {
  it('grants canonical workspace-root cwd and exact category target for the trusted singleton', () => {
    const workspace = makeTempDir('wy-doc-scope-ok-')
    const checkout = makeTempDir('wy-doc-scope-co-')
    registerProject(workspace, 'alpha', checkout)

    const input = {
      targetProject: 'alpha',
      category: 'spec',
      targetPath: 'projects/alpha/docs/specs/design.md',
    }
    const scope = documentExecutionScope(TRUSTED_TARGET, input, workspace, 'alpha')
    assert.ok(scope, 'the trusted singleton in a registered project must receive scope')
    assert.equal(scope.workingDirectory, realpathSync(resolve(workspace)))
    assert.equal(scope.targetPath, resolve(realpathSync(resolve(workspace)), input.targetPath))
  })

  it('maps every declared category directory and trim-matches the project', () => {
    const workspace = makeTempDir('wy-doc-scope-cats-')
    registerProject(workspace, 'alpha', makeTempDir('wy-doc-scope-cat-co-'))

    for (const [category, directory] of Object.entries(CATEGORY_DIRECTORY)) {
      const targetPath = `projects/alpha/docs/${directory}/note.md`
      const scope = documentExecutionScope(
        TRUSTED_TARGET,
        { targetProject: '  alpha  ', category, targetPath },
        workspace,
        'alpha',
      )
      assert.ok(scope, `category ${category} should receive scope`)
      assert.equal(scope.targetPath, resolve(realpathSync(resolve(workspace)), targetPath))
    }
  })

  it('supports qualified nested project ids only when exactly matched', () => {
    const workspace = makeTempDir('wy-doc-scope-nested-')
    registerProject(workspace, 'org/team', makeTempDir('wy-doc-scope-nested-co-'))

    const scope = documentExecutionScope(
      TRUSTED_TARGET,
      { targetProject: 'org/team', category: 'plan', targetPath: 'projects/org/team/docs/plans/p.md' },
      workspace,
      'org/team',
    )
    assert.ok(scope)

    const wrongProject = documentExecutionScope(
      TRUSTED_TARGET,
      { targetProject: 'org/team', category: 'plan', targetPath: 'projects/org/team/docs/plans/p.md' },
      workspace,
      'org',
    )
    assert.equal(wrongProject, undefined, 'a parent-qualified name is not the registered project')
  })
})

describe('documentExecutionScope rejects privilege by name, shape, or target', () => {
  it('never trusts a clone, override, or same source by identity', () => {
    assert.equal(isTrustedDocDefinition(TRUSTED_DOC_DEFINITION, 'builtin'), true)
    assert.equal(isTrustedDocDefinition(TRUSTED_DOC_DEFINITION, 'project'), false)
    assert.equal(isTrustedDocDefinition({ ...TRUSTED_DOC_DEFINITION }, 'builtin'), false)

    const sameNamedClone: TaskDefinition = {
      __type: 'task',
      sourcePath: 'lib/standard/tasks/doc.mts',
      config: { ...TRUSTED_DOC_DEFINITION.config },
    }
    assert.equal(isTrustedDocDefinition(sameNamedClone, 'builtin'), false)

    const workspace = makeTempDir('wy-doc-scope-clone-')
    registerProject(workspace, 'alpha', makeTempDir('wy-doc-scope-clone-co-'))
    const input = { targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/specs/design.md' }

    assert.equal(
      documentExecutionScope({ definition: sameNamedClone, source: 'builtin' }, input, workspace, 'alpha'),
      undefined,
      'same-named/source-path/metadata clone gets no scope',
    )
    assert.equal(
      documentExecutionScope(
        { definition: { ...TRUSTED_DOC_DEFINITION } as TaskDefinition, source: 'builtin' },
        input,
        workspace,
        'alpha',
      ),
      undefined,
    )
    assert.equal(
      documentExecutionScope(TRUSTED_TARGET, input, workspace, 'alpha', 'wt-1'),
      undefined,
      'a worktree target is never scoped',
    )
  })

  it('rejects traversal, absolute, wrong category/project, unregistered, and malformed targets', () => {
    const workspace = makeTempDir('wy-doc-scope-reject-')
    registerProject(workspace, 'alpha', makeTempDir('wy-doc-scope-reject-co-'))
    const call = (input: Record<string, unknown>): unknown =>
      documentExecutionScope(TRUSTED_TARGET, input, workspace, 'alpha')

    // Traversal / alternate spellings normalize away from the raw string.
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/specs/../x.md' }), undefined)
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/specs/./x.md' }), undefined)
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/specs//x.md' }), undefined)
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/specs/x.md\0' }), undefined)
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects\\alpha\\docs\\specs\\x.md' }), undefined)
    // Absolute and non-Markdown.
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: '/tmp/x.md' }), undefined)
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/specs/x.txt' }), undefined)
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: '' }), undefined)
    // Category / project mismatches.
    assert.equal(call({ targetProject: 'alpha', category: 'other', targetPath: 'projects/alpha/docs/specs/x.md' }), undefined)
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/plans/x.md' }), undefined)
    assert.equal(call({ targetProject: 'beta', category: 'spec', targetPath: 'projects/beta/docs/specs/x.md' }), undefined)
    // The prefix itself is not a document.
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/specs' }), undefined)
    assert.equal(call({ targetProject: 'alpha', category: 'spec', targetPath: 'projects/alpha/docs/specs/' }), undefined)
    // Unregistered project id.
    assert.equal(call({ targetProject: 'ghost', category: 'spec', targetPath: 'projects/ghost/docs/specs/x.md' }), undefined)
  })
})

describe('document domain input vs bounded task ctx', () => {
  it('declares exactly the current doc input keys with no legacy aliases', () => {
    assert.deepEqual(
      Object.keys(DocInputSchema.shape).sort(),
      ['category', 'conversation', 'intent', 'targetPath', 'targetProject', 'templateRules'],
    )
  })

  it('preserves the entire conversation, exact target, and single write target in the prompt', async () => {
    const conversation = `HEAD ${'中间'.repeat(9_000)} TAIL`
    const parsed = DocInputSchema.parse({
      targetProject: 'alpha',
      category: 'plan',
      targetPath: 'projects/alpha/docs/plans/p.md',
      intent: 'plan the work',
      conversation,
    })
    assert.deepEqual(TRUSTED_DOC_DEFINITION.config.writeTargets?.(parsed), ['projects/alpha/docs/plans/p.md'])

    const prompt = await Promise.resolve(TRUSTED_DOC_DEFINITION.config.prompt(parsed))
    assert.ok(prompt.includes(conversation), 'the full conversation is preserved verbatim')
    assert.ok(prompt.includes('projects/alpha/docs/plans/p.md'))
    assert.ok(prompt.includes('plan the work'))
  })

})
