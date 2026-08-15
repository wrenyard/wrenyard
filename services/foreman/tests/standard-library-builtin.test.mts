import assert from 'node:assert/strict'
import { hostname as osHostname } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { z } from 'zod'
import {
  BUILTIN_NAMES,
  BUILTIN_SOURCE_PATH,
  BUILTIN_TASKS,
} from '../lib/standard/index.mts'
import prepareFixTask from '../lib/standard/tasks/prepare-fix.mts'
import implementTask from '../lib/standard/tasks/implement.mts'
import codeReviewTask from '../lib/standard/tasks/code-review.mts'
import shellUsage from '../lib/standard/instructions/shell-usage.mts'
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
  profile: 'test',
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
  prevForemanWorkspace = process.env.FOREMAN_WORKSPACE
})

afterEach(() => {
  resetRegistry()
  invalidateProjectCache()
  if (prevForemanWorkspace === undefined) delete process.env.FOREMAN_WORKSPACE
  else process.env.FOREMAN_WORKSPACE = prevForemanWorkspace
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

const EXPECTED_BUILTIN_NAMES = [
  'explore',
  'edit',
  'test',
  'explore-code',
  'explore-commit',
  'code-review',
  'commit',
  'librarian',
  'oracle',
  'look-at',
  'prepare-fix',
  'architect',
  'conform-review',
  'explore-notes',
  'feature-point-synthesize',
  'fp-review',
  'fu-review',
  'functional-unit-breakdown',
  'inquiry-step',
  'investigate',
  'plan-review',
  'propose-design',
  'request-intake',
  'spec-review',
  'deep-research-fetch',
  'deep-research-scope',
  'deep-research-synthesize',
  'deep-research-verify',
  'diagnose-repro',
  'instrument-evidence',
  'test-hypothesis',
  'verify-fix',
  'implement',
  'write-failing-test',
] as const

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
  it('exposes exactly 34 entries in the fixed order', () => {
    assert.equal(BUILTIN_TASKS.length, 34)
    assert.deepEqual(
      BUILTIN_TASKS.map((e) => e.name),
      [...EXPECTED_BUILTIN_NAMES],
    )
  })

  it('every entry is a TaskDefinition with __type task and a sourcePath', () => {
    for (const entry of BUILTIN_TASKS) {
      assert.equal(entry.definition.__type, 'task')
      assert.equal(typeof entry.definition.config.prompt, 'function')
      assert.equal(typeof entry.definition.sourcePath, 'string')
    }
  })

  it('BUILTIN_NAMES matches the 34 builtin names', () => {
    assert.equal(BUILTIN_NAMES.size, 34)
    for (const name of EXPECTED_BUILTIN_NAMES) {
      assert.equal(BUILTIN_NAMES.has(name), true, `${name} should be in BUILTIN_NAMES`)
    }
  })
})

// ───────────────────────────────────────────────────────────────────
// Injection — builtins registered after discovery
// ───────────────────────────────────────────────────────────────────

describe('standard-library builtin injection', () => {
  it('keeps all 34 builtins resolvable but omits legacy-only tasks from scheduling lists', async () => {
    const workspace = makeTempDir('foreman-builtin-empty-')
    await discoverTasks(workspace)

    const tasks = listTasks(workspace)
    const builtins = tasks.filter((t) => t.source === 'builtin')
    assert.equal(builtins.length, 33)

    for (const name of EXPECTED_BUILTIN_NAMES.filter((candidate) => candidate !== 'implement')) {
      const entry = tasks.find((t) => t.name === name)
      assert.ok(entry, `builtin ${name} should be listed`)
      assert.equal(entry.source, 'builtin')
      assert.equal(entry.path, BUILTIN_SOURCE_PATH)
    }
    assert.equal(tasks.some((task) => task.name === 'implement'), false)
    assert.equal(resolveTaskTarget('implement', workspace)?.name, 'implement',
      'legacy graphs must retain exact definition resolution')
    assert.equal(describeTask('implement', workspace)?.scheduling, 'legacy')
  })

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

  it('discovers representative migrated tasks with builtin provenance', async () => {
    const workspace = makeTempDir('foreman-builtin-migrated-')
    await discoverTasks(workspace)

    const tasks = listTasks(workspace)
    for (const name of [
      'request-intake',
      'propose-design',
      'feature-point-synthesize',
      'deep-research-scope',
      'functional-unit-breakdown',
      'diagnose-repro',
      'write-failing-test',
    ]) {
      const entry = tasks.find((t) => t.name === name)
      assert.ok(entry, `migrated builtin ${name} should be listed`)
      assert.equal(entry.source, 'builtin')
      assert.equal(entry.path, BUILTIN_SOURCE_PATH)
    }
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

    for (const name of ['explore', 'edit', 'oracle', 'look-at']) {
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

  it('listTaskDefinitions includes builtins (with source builtin) in summary list', async () => {
    const workspace = makeTempDir('foreman-builtin-list-defs-')
    await discoverTasks(workspace)

    const defs = listTaskDefinitions(workspace)
    const builtinDefs = defs.filter((d) => d.source === 'builtin')
    assert.equal(builtinDefs.length, 33)
    for (const name of EXPECTED_BUILTIN_NAMES.filter((candidate) => candidate !== 'implement')) {
      const def = defs.find((d) => d.name === name)
      assert.ok(def, `${name} should be in listTaskDefinitions`)
      assert.equal(def.source, 'builtin')
    }
    assert.equal(defs.some((definition) => definition.name === 'implement'), false)
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

    process.env.FOREMAN_WORKSPACE = workspace
    const originalLog = console.log
    let stdout = ''
    console.log = (...args: unknown[]) => { stdout += args.join(' ') + '\n' }
    try {
      const { handleTaskDoctor } = await import('../lib/client/cli/commands/task.mts')
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
  it('executes a builtin in the requested real project cwd', async () => {
    const workspace = makeTempDir('foreman-builtin-exec-')
    const hostname = osHostname()
    const projectCwd = makeTempDir('foreman-builtin-exec-cwd-')

    // Set up a real project with a host mapping pointing to projectCwd.
    const projectDir = join(workspace, 'projects', 'ure', 'service')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'service.fmproj'),
      `name: service\ndescription: Test\nhosts:\n  ${hostname}: ${JSON.stringify(projectCwd)}\n`,
      'utf-8',
    )

    await discoverTasks(workspace)

    let captured: {
      executionProject?: string
      workingDirectory?: string
      project?: string
      taskName?: string
      source?: 'builtin' | 'project'
      input?: unknown
      taskContext?: Record<string, unknown>
    } = {}
    const mockRunner = {
      startTaskRun: async (opts: typeof captured) => {
        captured = opts
        return { id: 'run-1', task_run_id: 'run-1', hint: 'ok' }
      },
      cancelTaskRun: async () => ({}),
    }

    const { TaskService } = await import('../lib/core/task/service.mts')
    const service = new TaskService({
      workspaceRoot: workspace,
      operations: { runner: mockRunner as never },
    })

    await service.run({
      taskId: 'explore',
      project: 'ure/service',
      input: {
        goal: { outcome: 'test' },
        questions: [{ id: 'q1', ask: 'test?', blocking: false }],
        targets: [{ kind: 'file', value: 'src/main.ts' }],
        ctx: { shared: 'embedded', snippet: 'export const main = true' },
      },
      ctx: { shared: 'outer', decision: 'preserve exports' },
    })

    assert.ok(captured.executionProject)
    assert.equal(captured.executionProject, 'ure/service')
    assert.equal(captured.workingDirectory, projectCwd)
    assert.equal(captured.taskName, 'explore')
    assert.equal(captured.project, 'ure/service')
    assert.equal(captured.source, 'builtin')
    assert.deepEqual(captured.input, {
      goal: { outcome: 'test' },
      questions: [{ id: 'q1', ask: 'test?', blocking: false }],
      targets: [{ kind: 'file', value: 'src/main.ts' }],
    })
    assert.deepEqual(captured.taskContext, {
      shared: 'embedded',
      decision: 'preserve exports',
      snippet: 'export const main = true',
    })
  })

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

  it('uses the real registered foreman project cwd', async () => {
    const workspace = makeTempDir('foreman-builtin-real-')
    const hostname = osHostname()
    const foremanCwd = makeTempDir('foreman-builtin-real-foreman-cwd-')
    const projectDir = join(workspace, 'projects', 'foreman')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'foreman.fmproj'),
      `name: foreman\ndescription: Foreman\nhosts:\n  ${hostname}: ${JSON.stringify(foremanCwd)}\n`,
      'utf-8',
    )
    await discoverTasks(workspace)

    let captured: { executionProject?: string; workingDirectory?: string } = {}
    const mockRunner = {
      startTaskRun: async (opts: typeof captured) => {
        captured = opts
        return { id: 'run-3', task_run_id: 'run-3', hint: 'ok' }
      },
      cancelTaskRun: async () => ({}),
    }

    const { TaskService } = await import('../lib/core/task/service.mts')
    const service = new TaskService({
      workspaceRoot: workspace,
      operations: { runner: mockRunner as never },
    })

    await service.run({
      taskId: 'explore',
      project: 'foreman',
      input: {
        goal: { outcome: 'test' },
        questions: [{ id: 'q1', ask: 'test?', blocking: false }],
        targets: [{ kind: 'file', value: 'src/main.ts' }],
      },
    })

    assert.equal(captured.executionProject, 'foreman')
    assert.equal(captured.workingDirectory, foremanCwd)
  })
})

// ───────────────────────────────────────────────────────────────────
// prepare-fix builtin task — definition / schema / prompt
// ───────────────────────────────────────────────────────────────────

describe('standard-library prepare-fix builtin task', () => {
  it('registers prepare-fix as a category-decorated shallow clone and write-failing-test as the final catalog entry', () => {
    const entry = BUILTIN_TASKS.find((e) => e.name === 'prepare-fix')
    assert.ok(entry, 'prepare-fix should be a builtin task')
    // BUILTIN_TASKS carries a category-decorated shallow clone, not the module
    // singleton. The clone copies the definition and injects the category.
    assert.equal(entry.definition.__type, 'task')
    assert.deepEqual(entry.definition.config.category, { id: 'edit', displayLabel: '编码' })
    assert.equal(entry.definition.sourcePath, prepareFixTask.sourcePath)
    // Registration must not mutate the imported module singleton.
    assert.equal(
      (prepareFixTask.config as { category?: unknown }).category,
      undefined,
      'the module singleton config must stay category-free after registration',
    )
    assert.equal(BUILTIN_TASKS[BUILTIN_TASKS.length - 1].name, 'write-failing-test')
  })

  it('exposes a task definition with the migrated static description/runtime/permission', () => {
    assert.equal(prepareFixTask.__type, 'task')
    assert.equal(
      prepareFixTask.config.description,
      'Analyze failed verification evidence and produce precise edit instructions only when the failure is credible and code repair is required.',
    )
    assert.equal(prepareFixTask.config.agentRuntime, 'forge/general')
    assert.equal(prepareFixTask.config.permission, 'readonly')
    assert.deepEqual(prepareFixTask.config.instructions, [shellUsage])
    assert.equal(prepareFixTask.sourcePath, 'lib/standard/tasks/prepare-fix.mts')
  })

  it('input schema requires implementation_context and test_report, others optional', () => {
    const input = prepareFixTask.config.input
    // Required fields present.
    const ok = input.safeParse({ implementation_context: {}, test_report: {} })
    assert.equal(ok.success, true)
    // Optional fields accepted.
    const withOptional = input.safeParse({
      implementation_context: { feature_point: { ref: 'FP-001' } },
      test_report: { passed: false },
      edit_report: {},
      edit_reports: [{}],
      attempt: 2,
    })
    assert.equal(withOptional.success, true)
    // Missing required fields rejected.
    const missing = input.safeParse({ test_report: {} })
    assert.equal(missing.success, false)
  })

  it('output schema requires status/analysis/patches/confidence with the exact status enum', () => {
    const output = prepareFixTask.config.output
    const ok = output.safeParse({
      status: 'edit_required',
      analysis: 'credible failure',
      patches: [
        {
          target: { kind: 'file', value: 'src/x.ts' },
          action: 'update',
          instruction: 'fix x',
          expected: 'no longer fails',
        },
      ],
      confidence: 'high',
    })
    assert.equal(ok.success, true)
    // Invalid status enum rejected.
    const bad = output.safeParse({ status: 'nope', analysis: 'a', patches: [], confidence: 'high' })
    assert.equal(bad.success, false)
    // patches must be Change records (action enum).
    const badPatch = output.safeParse({
      status: 'edit_required',
      analysis: 'a',
      patches: [{ target: { kind: 'file', value: 'src/x.ts' }, action: 'mutate', instruction: 'i', expected: 'e' }],
      confidence: 'low',
    })
    assert.equal(badPatch.success, false)
  })

  it('prompt renders the Verification Repair Planner contract with default attempt', () => {
    const prompt = prepareFixTask.config.prompt({
      implementation_context: { feature_point: { ref: 'FP-001' } },
      test_report: { passed: false },
    }) as unknown as string
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Verification Repair Planner/)
    assert.match(prompt, /edit_required/)
    assert.match(prompt, /Attempt: 1/)
  })

  it('prompt honors an explicit attempt value', () => {
    const prompt = prepareFixTask.config.prompt({
      implementation_context: {},
      test_report: {},
      attempt: 3,
    }) as unknown as string
    assert.match(prompt, /Attempt: 3/)
  })
})

// ───────────────────────────────────────────────────────────────────
// implement builtin task — registration / strict I/O / runtime contract
// ───────────────────────────────────────────────────────────────────

describe('standard-library implement builtin task', () => {
  it('registers implement as a category-decorated edit builtin without mutating the module singleton', () => {
    const entry = BUILTIN_TASKS.find((e) => e.name === 'implement')
    assert.ok(entry, 'implement should be a builtin task')
    assert.equal(entry.definition.__type, 'task')
    assert.deepEqual(entry.definition.config.category, { id: 'edit', displayLabel: '编码' })
    assert.equal(entry.definition.sourcePath, implementTask.sourcePath)
    // Registration must not mutate the imported module singleton.
    assert.equal(
      (implementTask.config as { category?: unknown }).category,
      undefined,
      'the module singleton config must stay category-free after registration',
    )
  })

  it('keeps the old runtime contract for recovery but marks it legacy-only', () => {
    assert.equal(implementTask.__type, 'task')
    assert.equal(implementTask.config.agentRuntime, 'forge/general')
    assert.equal(implementTask.config.permission, 'yolo')
    assert.equal(implementTask.config.timeoutMs, 1_800_000)
    assert.equal(implementTask.config.scheduling, 'legacy')
    assert.equal(implementTask.sourcePath, 'lib/standard/tasks/implement.mts')
    assert.ok(implementTask.config.instructions?.includes(shellUsage))
  })

  it('rejects direct scheduling of the legacy implement task', async () => {
    const workspace = makeTempDir('foreman-legacy-implement-')
    const hostname = osHostname()
    const projectCwd = makeTempDir('foreman-legacy-implement-cwd-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'app.fmproj'),
      `name: app\ndescription: Test\nhosts:\n  ${hostname}: ${JSON.stringify(projectCwd)}\n`,
      'utf-8',
    )
    await discoverTasks(workspace)

    const { TaskService } = await import('../lib/core/task/service.mts')
    const service = new TaskService({ workspaceRoot: workspace })
    await assert.rejects(
      service.run({
        taskId: 'implement',
        project: 'app',
        input: {
          objective: 'large change',
          acceptance_criteria: [{ id: 'ac-1', when: 'done', then: 'done' }],
        },
      }),
      (error) => (error as { code?: string }).code === 'legacy_task_not_schedulable',
    )
  })

  it('allows the internal compatibility flag to resume a persisted implement node', async () => {
    const workspace = makeTempDir('foreman-legacy-implement-recovery-')
    const hostname = osHostname()
    const projectCwd = makeTempDir('foreman-legacy-implement-recovery-cwd-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'app.fmproj'),
      `name: app\ndescription: Test\nhosts:\n  ${hostname}: ${JSON.stringify(projectCwd)}\n`,
      'utf-8',
    )
    await discoverTasks(workspace)

    const mockRunner = {
      startTaskRun: async () => ({ id: 'legacy-run', task_run_id: 'legacy-run', hint: 'ok' }),
      cancelTaskRun: async () => ({}),
    }
    const { TaskService } = await import('../lib/core/task/service.mts')
    const service = new TaskService({
      workspaceRoot: workspace,
      operations: { runner: mockRunner as never },
    })
    const result = await service.run({
      taskId: 'implement',
      project: 'app',
      input: {
        objective: 'resume old node',
        acceptance_criteria: [{ id: 'ac-1', when: 'done', then: 'done' }],
      },
      allowLegacyTask: true,
    })
    assert.ok('task_run_id' in result)
    assert.equal(result.task_run_id, 'legacy-run')
  })

  it('input schema requires objective and acceptance_criteria, others optional', () => {
    const input = implementTask.config.input
    const ok = input.safeParse({
      objective: 'Add a retry helper',
      context: 'Optional context',
      scope: ['src/retry.ts'],
      constraints: ['No new dependencies'],
      acceptance_criteria: [
        { id: 'ac-1', given: 'a failing operation', when: 'calling retry', then: 'it retries up to 3 times' },
      ],
      verification_commands: ['npm test'],
    })
    assert.equal(ok.success, true)
    // Minimal input parses.
    const minimal = input.safeParse({
      objective: 'Add a retry helper',
      acceptance_criteria: [{ id: 'ac-1', when: 'calling retry', then: 'it retries' }],
    })
    assert.equal(minimal.success, true)
    // Missing objective rejected.
    assert.equal(
      input.safeParse({ acceptance_criteria: [{ id: 'ac-1', when: 'w', then: 't' }] }).success,
      false,
    )
    // Empty acceptance_criteria rejected (min 1).
    assert.equal(
      input.safeParse({ objective: 'x', acceptance_criteria: [] }).success,
      false,
    )
  })

  it('output schema is strict and bounded with the exact status enum', () => {
    const output = implementTask.config.output
    const ok = output.safeParse({
      status: 'completed',
      summary: 'Implemented the retry helper.',
      changes: [{ path: 'src/retry.ts', summary: 'Added retry helper' }],
      verification: [{ command: 'npm test', status: 'passed', summary: 'All tests pass' }],
      remaining_issues: [],
    })
    assert.equal(ok.success, true)
    // Unknown status enum rejected.
    assert.equal(
      output.safeParse({
        status: 'done',
        summary: 'x',
        changes: [],
        verification: [],
        remaining_issues: [],
      }).success,
      false,
    )
    // Missing required fields rejected.
    assert.equal(
      output.safeParse({ status: 'completed', summary: 'x', verification: [], remaining_issues: [] }).success,
      false,
    )
    // Strict output rejects unknown keys.
    assert.equal(
      output.safeParse({
        status: 'completed',
        summary: 'x',
        changes: [],
        verification: [],
        remaining_issues: [],
        extra: true,
      }).success,
      false,
    )
    // blocked/needs_attention are valid statuses.
    assert.equal(
      output.safeParse({
        status: 'needs_attention',
        summary: 'Incomplete',
        changes: [],
        verification: [],
        remaining_issues: ['missing tests'],
      }).success,
      true,
    )
  })

  it('prompt renders the continuous vertical-slice contract', () => {
    const prompt = implementTask.config.prompt({
      objective: 'Add a retry helper',
      acceptance_criteria: [{ id: 'ac-1', when: 'calling retry', then: 'it retries up to 3 times' }],
    }) as unknown as string
    assert.equal(typeof prompt, 'string')
    assert.match(prompt, /Implementer/)
    assert.match(prompt, /acceptance criteria/i)
    assert.match(prompt, /Never commit|NEVER commit/)
    assert.match(prompt, /completed/)
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
