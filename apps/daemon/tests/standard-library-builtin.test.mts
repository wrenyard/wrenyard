import assert from 'node:assert/strict'
import { hostname as osHostname } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { z } from 'zod'
import {
  BUILTIN_METADATA,
  BUILTIN_NAMES,
  BUILTIN_SOURCE_PATH,
  BUILTIN_TASKS,
} from '../lib/standard/index.mts'
import codeReviewTask from '../lib/standard/tasks/code-review.mts'
import {
  describeTask,
  discoverTasks,
  ensureDiscovered,
  findTaskDefinition,
  getLoadErrors,
  listTaskDefinitions,
  listTasks,
  markDirty,
  resetRegistry,
  resolveTaskTarget,
} from '../lib/workspace/task-loader.mts'
import { invalidateProjectCache } from '../lib/core/project/loader.mts'
import {
  COMMIT_DISPATCH_REQUIREMENTS,
  FREQUENT_DISPATCH_REQUIREMENTS,
  GENERAL_DISPATCH_REQUIREMENTS,
  REVIEW_DISPATCH_REQUIREMENTS,
  ULTRA_DISPATCH_REQUIREMENTS,
} from '../lib/standard/task-dispatch.mts'

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

let tempDirs: string[] = []
let prevForemanWorkspace: string | undefined

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeFmproj(workspace: string, project: string): string {
  const parts = project.split('/')
  const name = parts.at(-1)!
  const projectDir = join(workspace, 'projects', ...parts)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, `${name}.fmproj`),
    `name: ${name}\ndescription: Test project ${project}\n`,
    'utf-8',
  )
  return projectDir
}

function writeTask(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.task.ts`), taskSource(`'${name}'`), 'utf-8')
}

function taskSource(promptExpression: string): string {
  return `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: () => ${promptExpression},
})
`
}

beforeEach(() => {
  resetRegistry()
  invalidateProjectCache()
  prevForemanWorkspace = process.env.WRENYARD_WORKSPACE
})

afterEach(() => {
  resetRegistry()
  invalidateProjectCache()
  if (prevForemanWorkspace === undefined) delete process.env.WRENYARD_WORKSPACE
  else process.env.WRENYARD_WORKSPACE = prevForemanWorkspace
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

// The retained seven-role builtin catalog, in fixed order.
const EXPECTED_BUILTIN_NAMES = [
  'explore',
  'edit',
  'test',
  'code-review',
  'commit',
  'librarian',
  'oracle',
] as const

// Retired roles that must no longer resolve or describe at the registry surface.
const RETIRED_BUILTIN_NAMES = [
  'implement',
  'prepare-fix',
  'architect',
  'explore-code',
  'explore-commit',
  'look-at',
]

// Zod schema for the public list/describe shape (the fields the
// standard-library builtin contract guarantees).
const ListedDefinitionShapeSchema = z.object({
  name: z.string(),
  source: z.string(),
  path: z.string(),
  description: z.string().optional(),
  agentRuntime: z.string().optional(),
  input_schema: z.unknown().optional(),
  output_schema: z.unknown().optional(),
  structured: z.boolean().optional(),
  permission: z.string().optional(),
  effectiveTimeoutMs: z.number().optional(),
  structuredRetryTimeoutMs: z.number().optional(),
  timeoutScope: z.string().optional(),
  scheduling: z.enum(['active', 'legacy']).optional(),
})

// ───────────────────────────────────────────────────────────────────
// BUILTIN_TASKS index — exact count, order, names
// ───────────────────────────────────────────────────────────────────

describe('standard-library BUILTIN_TASKS index', () => {
  it('every entry is a TaskDefinition with __type task and a sourcePath', () => {
    for (const entry of BUILTIN_TASKS) {
      assert.equal(entry.definition.__type, 'task')
      assert.equal(typeof entry.definition.config.prompt, 'function')
      assert.equal(typeof entry.definition.sourcePath, 'string')
    }
  })

})

// ───────────────────────────────────────────────────────────────────
// Injection — builtins registered after discovery
// ───────────────────────────────────────────────────────────────────

describe('standard-library builtin injection', () => {
  it('resolveTaskTarget selects the builtin for unqualified builtin names', async () => {
    const workspace = makeTempDir('foreman-builtin-resolve-')
    await discoverTasks(workspace)

    for (const name of EXPECTED_BUILTIN_NAMES) {
      const target = resolveTaskTarget(name, workspace)
      assert.ok(target, `${name} should resolve`)
      assert.equal(target.name, name)
      assert.equal(target.source, 'builtin')
      assert.equal(target.project, undefined)
    }
  })

  it('rejects qualified task ids instead of parsing them', async () => {
    const workspace = makeTempDir('foreman-builtin-qualified-')
    await discoverTasks(workspace)

    assert.throws(() => resolveTaskTarget('foreman/explore', workspace), /containing '\/' are not supported/)
  })

  it('a registered project definition overrides a same-id builtin', async () => {
    const workspace = makeTempDir('foreman-builtin-precedence-')
    const projectDir = writeFmproj(workspace, 'app')
    writeTask(projectDir, 'edit')
    await discoverTasks(workspace)

    // Builtin remains the fallback when no project context selects the override.
    assert.equal(resolveTaskTarget('edit', workspace)?.source, 'builtin')

    const target = resolveTaskTarget('edit', workspace, 'app')
    assert.ok(target)
    assert.equal(target.source, 'project')
    assert.equal(target.project, 'app')
    assert.equal(getLoadErrors(workspace).length, 0)
  })
})

// ───────────────────────────────────────────────────────────────────
// Source/describe schemas from Zod
// ───────────────────────────────────────────────────────────────────

describe('standard-library builtin list/describe schemas', () => {
  it('every builtin listTasks entry conforms to the Zod shape', async () => {
    const workspace = makeTempDir('foreman-builtin-schema-')
    await discoverTasks(workspace)

    const builtins = listTasks(workspace).filter((t) => t.source === 'builtin')
    for (const task of builtins) {
      ListedDefinitionShapeSchema.parse(task)
      assert.equal(task.source, 'builtin')
      assert.equal(task.path, BUILTIN_SOURCE_PATH)
    }
  })

  it('describeTask exposes builtin provenance and conforms to the Zod shape', async () => {
    const workspace = makeTempDir('foreman-builtin-describe-')
    await discoverTasks(workspace)

    for (const name of ['explore', 'edit', 'oracle', 'commit']) {
      const described = describeTask(name, workspace)
      assert.ok(described, `${name} should be describable`)
      ListedDefinitionShapeSchema.parse(described)
      assert.equal(described.source, 'builtin')
      assert.equal(described.path, BUILTIN_SOURCE_PATH)
      assert.equal(described.name, name)
      assert.ok(described.input_schema, `${name} should have an input schema`)
      assert.ok(described.output_schema, `${name} should have an output schema`)
    }

    const editSchema = describeTask('edit', workspace)?.input_schema as {
      anyOf?: Array<{ type?: string; properties?: Record<string, unknown> }>
    }
    const objectVariant = editSchema.anyOf?.find((variant) => variant.type === 'object')
    assert.ok(objectVariant?.properties?.ctx, 'object task input variants should expose reserved ctx')
  })

  it('findTaskDefinition resolves builtins and exposes provenance', async () => {
    const workspace = makeTempDir('foreman-builtin-find-')
    await discoverTasks(workspace)

    const found = findTaskDefinition('commit', workspace)
    assert.ok(found)
    ListedDefinitionShapeSchema.parse(found)
    assert.equal(found.source, 'builtin')
    assert.equal(found.name, 'commit')
  })

  it('external project definitions carry project source metadata and are context-scoped', async () => {
    const workspace = makeTempDir('foreman-builtin-ext-src-')
    writeTask(writeFmproj(workspace, 'other'), 'other-task')
    writeTask(writeFmproj(workspace, 'app'), 'app-task')
    await discoverTasks(workspace)

    // Without project context, project-only entries are intentionally hidden.
    const tasks = listTasks(workspace)
    assert.equal(tasks.some((t) => t.name === 'other-task'), false)
    assert.equal(tasks.some((t) => t.name === 'app-task'), false)

    const otherTasks = listTasks(workspace, 'other')
    const otherTask = otherTasks.find((t) => t.name === 'other-task')
    assert.ok(otherTask)
    assert.equal(otherTask.source, 'project')
    assert.equal(otherTask.project, 'other')

    const appTasks = listTasks(workspace, 'app')
    const appTask = appTasks.find((t) => t.name === 'app-task')
    assert.ok(appTask)
    assert.equal(appTask.source, 'project')
    assert.equal(appTask.project, 'app')
  })
})

// ───────────────────────────────────────────────────────────────────
// Layering, shadowing, and duplicate diagnostics
// ───────────────────────────────────────────────────────────────────

describe('standard-library layered task resolution', () => {
  it('allows a project definition to override a builtin without a conflict', async () => {
    const workspace = makeTempDir('foreman-builtin-shadow-')
    const projectDir = writeFmproj(workspace, 'app')
    writeTask(projectDir, 'explore')

    await discoverTasks(workspace)

    const target = resolveTaskTarget('explore', workspace, 'app')
    assert.ok(target)
    assert.equal(target.name, 'explore')
    assert.equal(target.source, 'project')
    assert.equal(target.project, 'app')
    assert.equal(getLoadErrors(workspace).length, 0)
    assert.equal(listTasks(workspace, 'app').filter((task) => task.name === 'explore').length, 1)
  })

  it('uses project context to select one effective definition and hides project-only ids without context', async () => {
    const workspace = makeTempDir('foreman-builtin-project-overlay-')
    writeTask(writeFmproj(workspace, 'app'), 'shared')
    writeTask(writeFmproj(workspace, 'bar'), 'shared')
    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('shared', workspace), null)
    assert.equal(findTaskDefinition('shared', workspace), null)
    assert.equal(resolveTaskTarget('shared', workspace, 'app')?.project, 'app')
    assert.equal(resolveTaskTarget('shared', workspace, 'bar')?.project, 'bar')
    assert.equal(listTasks(workspace).some((task) => task.name === 'shared'), false)
    assert.equal(listTasks(workspace, 'app').filter((task) => task.name === 'shared').length, 1)
  })

  it('reports duplicates only when the same id occurs twice in one scope', async () => {
    const workspace = makeTempDir('foreman-builtin-duplicate-')
    const projectDir = writeFmproj(workspace, 'app')
    const firstDir = join(projectDir, 'a')
    const secondDir = join(projectDir, 'b')
    writeTask(firstDir, 'same')
    writeTask(secondDir, 'same')

    await discoverTasks(workspace)

    const duplicates = getLoadErrors(workspace).filter((error) => error.kind === 'duplicate_definition')
    assert.equal(duplicates.length, 1)
    assert.equal(duplicates[0].id, 'same')
    assert.equal(duplicates[0].scope, 'app')
    assert.match(duplicates[0].load_error, /Duplicate definition 'same'/)
    assert.equal(resolveTaskTarget('same', workspace, 'app')?.source, 'project')

    process.env.WRENYARD_WORKSPACE = workspace
    const originalLog = console.log
    let stdout = ''
    console.log = (...args: unknown[]) => { stdout += args.join(' ') + '\n' }
    try {
      const { handleTaskDoctor } = await import('../../cli/src/commands/task.mts')
      assert.equal(await handleTaskDoctor([]), 1)
      assert.match(stdout, /Duplicate definitions/)
      assert.doesNotMatch(stdout, /builtin_conflict/)
    } finally {
      console.log = originalLog
    }
  })
})

// ───────────────────────────────────────────────────────────────────
// Dirty refresh — reassert builtins, update deleted conflict diagnostics
// ───────────────────────────────────────────────────────────────────

describe('standard-library dirty refresh', () => {
  it('reasserts builtins on dirty refresh', async () => {
    const workspace = makeTempDir('foreman-builtin-refresh-')
    await discoverTasks(workspace)
    assert.ok(resolveTaskTarget('explore', workspace))

    // Simulate a dirty reload — builtins should still be present.
    markDirty(workspace)
    await ensureDiscovered(workspace)

    for (const name of EXPECTED_BUILTIN_NAMES) {
      const target = resolveTaskTarget(name, workspace)
      assert.ok(target, `${name} should survive dirty refresh`)
      assert.equal(target.name, name)
      assert.equal(target.source, 'builtin')
    }
  })

  it('reveals the builtin again after a project shadow is deleted', async () => {
    const workspace = makeTempDir('foreman-builtin-refresh-delete-')
    const projectDir = writeFmproj(workspace, 'app')
    const shadowPath = join(projectDir, 'explore.task.ts')
    writeFileSync(shadowPath, taskSource("'shadow'"), 'utf-8')

    await discoverTasks(workspace)
    assert.equal(resolveTaskTarget('explore', workspace, 'app')?.source, 'project')

    rmSync(shadowPath)
    markDirty(workspace)
    await ensureDiscovered(workspace)

    const target = resolveTaskTarget('explore', workspace, 'app')
    assert.ok(target)
    assert.equal(target.source, 'builtin')
    assert.equal(getLoadErrors(workspace).length, 0)
  })
})

// ───────────────────────────────────────────────────────────────────
// Requested-project execution
// ───────────────────────────────────────────────────────────────────

describe('standard-library TaskService builtin execution', () => {
  it('rejects unregistered foreman and workspace execution projects', async () => {
    const workspace = makeTempDir('foreman-builtin-virtual-')
    await discoverTasks(workspace)

    const mockRunner = {
      startTaskRun: async () => ({ id: 'run-2', task_run_id: 'run-2', hint: 'ok' }),
      cancelTaskRun: async () => ({}),
    }

    const { TaskService } = await import('../lib/core/task/service.mts')
    const service = new TaskService({
      workspaceRoot: workspace,
      operations: { runner: mockRunner as never },
    })

    await assert.rejects(
      service.run({
        taskId: 'explore',
        project: 'foreman',
        input: {
          goal: { outcome: 'test' },
          questions: [{ id: 'q1', ask: 'test?', blocking: false }],
          targets: [{ kind: 'file', value: 'src/main.ts' }],
        },
      }),
      (error) => (error as { code?: string }).code === 'project_not_found',
    )
    await assert.rejects(
      service.run({
        taskId: 'explore',
        project: 'workspace',
        input: {
          goal: { outcome: 'test' },
          questions: [{ id: 'q1', ask: 'test?', blocking: false }],
          targets: [{ kind: 'file', value: 'src/main.ts' }],
        },
      }),
      (error) => (error as { code?: string }).code === 'project_not_found',
    )
  })

})

// ───────────────────────────────────────────────────────────────────
// code-review builtin task — normal review-outcome boundary
// ───────────────────────────────────────────────────────────────────

describe('standard-library code-review outcome boundary', () => {
  it('code-review output still accepts a schema-valid non-empty findings outcome', () => {
    const outcome = {
      assessments: [{ criterion_id: 'ac-1', status: 'failed', evidences: ['ev-1'], reason: 'loop bound bug' }],
      findings: [{
        id: 'f-1',
        conclusion: 'definite_correctness_bug: loop end bound is exclusive',
        targets: [{ kind: 'file', value: 'src/batch.ts', line_range: [40, 58] }],
        evidences: ['ev-1'],
        confidence: 'high',
      }],
      required_changes: [{
        target: { kind: 'file', value: 'src/batch.ts' },
        action: 'update',
        instruction: 'Change the loop end bound to be inclusive.',
        expected: 'Final item is processed.',
      }],
      evidences: [{ id: 'ev-1', source: { kind: 'file', value: 'src/batch.ts' }, observation: 'Loop end bound is exclusive.' }],
    }
    const parsed = codeReviewTask.config.output.safeParse(outcome)
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error?.issues))
    const data = parsed.data as { findings: unknown[]; required_changes: unknown[] }
    assert.equal(data.findings.length, 1)
    assert.equal(data.required_changes.length, 1)
  })
})

// ───────────────────────────────────────────────────────────────────
// Immutable four-tier dispatch presets — task wiring.
// ───────────────────────────────────────────────────────────────────

describe('standard-library dispatch preset contracts', () => {
  it('no builtin preset carries a configurable maximum intelligence ceiling', () => {
    for (const preset of [
      FREQUENT_DISPATCH_REQUIREMENTS,
      COMMIT_DISPATCH_REQUIREMENTS,
      GENERAL_DISPATCH_REQUIREMENTS,
      REVIEW_DISPATCH_REQUIREMENTS,
      ULTRA_DISPATCH_REQUIREMENTS,
    ]) {
      assert.equal(
        (preset as { intelligenceMax?: unknown }).intelligenceMax,
        undefined,
        'a retired maximum intelligence ceiling must not be present',
      )
    }
  })


  it('librarian requires native search on top of general dispatch requirements', () => {
    const entry = BUILTIN_TASKS.find((e) => e.name === 'librarian')
    assert.ok(entry)
    assert.deepEqual(entry.definition.config.dispatch, { ...GENERAL_DISPATCH_REQUIREMENTS, requiresWebSearch: true })
  })

  it('the review builtin targets high via REVIEW_DISPATCH_REQUIREMENTS', () => {
    const entry = BUILTIN_TASKS.find((e) => e.name === 'code-review')
    assert.ok(entry, 'code-review should be a builtin')
    assert.deepEqual(entry.definition.config.dispatch, REVIEW_DISPATCH_REQUIREMENTS)
  })

  it('the commit builtin uses COMMIT_DISPATCH_REQUIREMENTS', () => {
    const entry = BUILTIN_TASKS.find((e) => e.name === 'commit')
    assert.ok(entry, 'commit should be a builtin')
    assert.deepEqual(entry.definition.config.dispatch, COMMIT_DISPATCH_REQUIREMENTS)
  })
})
