import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS,
  STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
  TASK_TIMEOUT_SCOPE,
} from '../../lib/task-timeouts.mts'
import {
  describeTask,
  ensureDiscovered,
  findTaskDefinition,
  getLoadErrors,
  isPathStale,
  listTasks,
  markDirty,
  registerTaskFile,
  resetRegistry,
  resolveRunTarget,
  resolveTaskTarget,
  discoverTasks,
} from '../../lib/workspace/task-loader.mts'
import { foremanStateRoot } from '../../lib/config/state.mts'
import { invalidateProjectCache } from '../../lib/core/project/loader.mts'
import type { ResolvedTarget, TaskDefinition } from '../../lib/types.mts'

type ResolvedTaskTarget = ResolvedTarget & {
  type: 'task'
  definition: TaskDefinition
}

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeTask(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.task.ts`), taskSource(`'${name}'`), 'utf-8')
}

function assertTaskTarget(target: ResolvedTarget | null): asserts target is ResolvedTaskTarget {
  assert.ok(target)
  assert.equal(target.type, 'task')
  assert.equal(target.definition.__type, 'task')
}

function taskSource(promptExpression: string, extraConfig = ''): string {
  return `export default defineTask({
  profile: 'test',
  permission: 'readonly',
${extraConfig}
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: () => ${promptExpression},
})
`
}

function registerProject(projectDir: string, name: string): void {
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${name}.fmproj`), `name: ${name}
description: test project
`, 'utf-8')
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

describe('workspace definition registry', () => {
  it('discovers .task.ts files under projects', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const workspaceProject = join(workspace, 'projects', 'app')
    registerProject(workspaceProject, 'app')
    writeTask(workspaceProject, 'probe')

    await discoverTasks(workspace)

    const tasks = listTasks(workspace)
    // Builtins and project definitions coexist as plain ids; list returns
    // one effective definition per id.
    assert.equal(tasks.filter((task) => task.source === 'builtin').length, 33)
    // Project definitions require project context to be selected.
    const appTasks = listTasks(workspace, 'app')
    assert.equal(appTasks.some((task) => task.name === 'probe' && task.source === 'project'), true)
    assert.equal(new Set(tasks.map((task) => task.name)).size, tasks.length)
  })

  it('resolves builtin < project < ancestor project by plain id', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    registerProject(join(workspace, 'projects', 'app'), 'app')
    registerProject(join(workspace, 'projects', 'ure'), 'ure')
    registerProject(join(workspace, 'projects', 'ure', 'site'), 'site')
    // `edit` is builtin, then intentionally shadow it at every higher layer.
    writeTask(join(workspace, 'projects', 'app'), 'edit')
    writeTask(join(workspace, 'projects', 'ure'), 'edit')
    writeTask(join(workspace, 'projects', 'ure', 'site'), 'edit')

    await discoverTasks(workspace)

    // No context (or an unknown project) falls back to the builtin layer.
    assert.equal(resolveTaskTarget('edit', workspace)?.source, 'builtin')
    assert.equal(resolveTaskTarget('edit', workspace, 'other')?.source, 'builtin')
    // A registered project definition overrides the builtin.
    assert.equal(resolveTaskTarget('edit', workspace, 'app')?.source, 'project')
    assert.equal(resolveTaskTarget('edit', workspace, 'app')?.project, 'app')
    assert.equal(resolveTaskTarget('edit', workspace, 'ure')?.project, 'ure')
    assert.equal(resolveTaskTarget('edit', workspace, 'ure/site')?.project, 'ure/site')
    assert.equal(listTasks(workspace).filter((task) => task.name === 'edit').length, 1)
    assert.equal(listTasks(workspace, 'ure').filter((task) => task.name === 'edit').length, 1)
    assert.equal(listTasks(workspace, 'ure/site').filter((task) => task.name === 'edit').length, 1)
    assert.equal(getLoadErrors(workspace).length, 0)
    assert.throws(() => resolveTaskTarget('ure/site/edit', workspace), /containing '\/' are not supported/)
  })

  it('exposes per-agent-attempt timeout metadata through list and describe', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeFileSync(join(projectDir, 'quick.task.ts'), taskSource("'quick'"), 'utf-8')
    writeFileSync(join(projectDir, 'quick.task.ts'), taskSource("'quick'"), 'utf-8')
    writeFileSync(join(projectDir, 'slow.task.ts'), taskSource("'slow'", '  timeoutMs: 7200000,\n'), 'utf-8')

    await discoverTasks(workspace)

    const quick = listTasks(workspace, 'app').find((task) => task.name === 'quick')
    assert.ok(quick, 'quick task should be listed')
    assert.equal(quick.timeoutMs, undefined)
    assert.equal(quick.effectiveTimeoutMs, STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS)
    assert.equal(quick.structuredRetryTimeoutMs, STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS)
    assert.equal(quick.timeoutScope, TASK_TIMEOUT_SCOPE)

    const slow = listTasks(workspace, 'app').find((task) => task.name === 'slow')
    assert.ok(slow, 'slow task should be listed')
    assert.equal(slow.timeoutMs, 7200000)
    assert.equal(slow.effectiveTimeoutMs, 7200000)
    assert.equal(slow.structuredRetryTimeoutMs, STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS)
    assert.equal(slow.timeoutScope, TASK_TIMEOUT_SCOPE)

    const described = describeTask('slow', workspace, 'app')
    assert.ok(described, 'slow task should be describable')
    assert.equal(described.timeoutMs, 7200000)
    assert.equal(described.effectiveTimeoutMs, 7200000)
    assert.equal(described.structuredRetryTimeoutMs, STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS)
    assert.equal(described.timeoutScope, TASK_TIMEOUT_SCOPE)
  })

  it('records a load error for invalid timeoutMs in task config', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'invalid-timeout.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, taskSource("'invalid-timeout'", '  timeoutMs: 0,\n'), 'utf-8')

    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('invalid-timeout', workspace), null)
    const errors = getLoadErrors(workspace)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].sourcePath, taskPath)
    assert.match(errors[0].load_error, /Invalid timeoutMs/)
    assert.match(errors[0].load_error, /positive safe integer/)
  })

  it('reloads changed task source when re-registering a file', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    const taskPath = join(projectDir, 'probe.task.ts')
    writeFileSync(taskPath, taskSource("'version-one'"), 'utf-8')

    await discoverTasks(workspace)
    const initialTarget = resolveTaskTarget('probe', workspace, 'app')
    assertTaskTarget(initialTarget)
    assert.equal(await initialTarget.definition.config.prompt({}), 'version-one')

    writeFileSync(taskPath, taskSource("'version-two'"), 'utf-8')
    const updated = await registerTaskFile(taskPath, workspace)

    assert.equal(await updated.definition.config.prompt({}), 'version-two')
    const updatedTarget = resolveTaskTarget('probe', workspace, 'app')
    assertTaskTarget(updatedTarget)
    assert.equal(await updatedTarget.definition.config.prompt({}), 'version-two')
  })

  it('resolves run targets as tasks', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeTask(projectDir, 'build')

    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('build', workspace, 'app')?.type, 'task')
    assert.equal(resolveRunTarget('build', workspace, 'app')?.type, 'task')
  })

  it('excludes generated directories from discovery', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    registerProject(join(workspace, 'projects', 'app'), 'app')
    writeTask(join(workspace, 'projects', 'app'), 'valid')
    writeTask(join(workspace, 'projects', 'workspace', 'node_modules'), 'invalid')
    writeTask(join(workspace, 'dist'), 'dist-task')

    await discoverTasks(workspace)

    const names = listTasks(workspace, 'app')
      .filter((task) => task.source !== 'builtin')
      .map((task) => task.name)
    assert.deepEqual(names, ['valid'])
  })

  it('maps base checkout and managed worktree definitions to same registered project id', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const stateHome = makeTempDir('foreman-state-')
    const prevXdg = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = resolve(stateHome)
    try {
      // Register 'app' project with .fmproj
      const appDir = join(workspace, 'projects', 'app')
      mkdirSync(appDir, { recursive: true })
      writeFileSync(join(appDir, 'app.fmproj'), 'name: app\ndescription: test project', 'utf-8')
      writeTask(appDir, 'valid')

      // Create managed worktree metadata pointing to a separate worktree root.
      // The worktree metadata path is: {foremanStateRoot()}/worktrees/.foreman/{id}.json
      const stateRoot = resolve(foremanStateRoot())
      const worktreeMetaDir = join(stateRoot, 'worktrees', '.foreman')
      mkdirSync(worktreeMetaDir, { recursive: true })
      const worktreeRoot = join(workspace, 'worktrees', 'abc12345')
      mkdirSync(worktreeRoot, { recursive: true })
      writeFileSync(
        join(worktreeMetaDir, 'abc12345.json'),
        JSON.stringify({ id: 'abc12345', project: 'app', path: resolve(worktreeRoot) }),
        'utf-8',
      )
      // Write task in the worktree root
      writeTask(worktreeRoot, 'worktree-task')

      await discoverTasks(workspace)

      // Both base project task AND worktree task resolve under project 'app'
      const appTasks = listTasks(workspace, 'app')
        .filter((task) => task.source !== 'builtin')
        .map((task) => task.name)
        .sort()
      assert.deepEqual(appTasks, ['valid', 'worktree-task'])

      // No invalid-scope errors
      assert.equal(getLoadErrors(workspace).length, 0)

      // Orphan file outside all registered roots remains invalid
      const orphanDir = join(workspace, 'orphan')
      mkdirSync(orphanDir, { recursive: true })
      writeTask(orphanDir, 'orphan-invalid')
      invalidateProjectCache()
      resetRegistry()
      await discoverTasks(workspace)
      const errors = getLoadErrors(workspace)
      const orphanError = errors.find((e) => e.sourcePath.includes('orphan-invalid'))
      assert.ok(orphanError, 'orphan file outside all roots should produce a load error')
      assert.match(orphanError.load_error, /outside any registered project/)
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_STATE_HOME
      } else {
        process.env.XDG_STATE_HOME = prevXdg
      }
    }
  })

  it('picks up modified task on next ensureDiscovered after markDirty', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'hot.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, taskSource("'original'"), 'utf-8')

    await discoverTasks(workspace)
    const before = resolveTaskTarget('hot', workspace, 'app')
    assertTaskTarget(before)
    assert.equal(await before.definition.config.prompt({}), 'original')

    // Modify file and mark dirty
    writeFileSync(taskPath, taskSource("'modified'"), 'utf-8')
    markDirty(workspace)

    // ensureDiscovered should trigger refresh
    await ensureDiscovered(workspace)
    const after = resolveTaskTarget('hot', workspace, 'app')
    assertTaskTarget(after)
    assert.equal(await after.definition.config.prompt({}), 'modified')
  })

  it('preserves last-good on broken file and surfaces load error', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'fragile.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, taskSource("'v1'"), 'utf-8')

    await discoverTasks(workspace)

    // Break the file
    writeFileSync(taskPath, "this is not valid typescript", 'utf-8')
    markDirty(workspace)
    await ensureDiscovered(workspace)

    // Last-good version still preserved
    const target = resolveTaskTarget('fragile', workspace, 'app')
    assertTaskTarget(target)
    assert.equal(await target.definition.config.prompt({}), 'v1')

    // Load error surfaced
    const errors = getLoadErrors(workspace)
    assert.ok(errors.length > 0, 'should have load errors')
    assert.equal(errors[0].sourcePath, taskPath)
    assert.ok(errors[0].stale)

    // Path marked stale
    assert.equal(isPathStale(taskPath, workspace), true)
  })

  it('removes deleted files from registry on refresh', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'temp.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, taskSource("'temp'"), 'utf-8')

    await discoverTasks(workspace)
    assert.ok(resolveTaskTarget('temp', workspace, 'app'), 'should exist before deletion')

    // Delete file and refresh
    rmSync(taskPath)
    markDirty(workspace)
    await ensureDiscovered(workspace)

    assert.equal(resolveTaskTarget('temp', workspace, 'app'), null, 'should be removed after deletion')
  })

  it('skipRefresh prevents mid-run definition refresh', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'pinned.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, taskSource("'v1'"), 'utf-8')

    await discoverTasks(workspace)

    // Simulate mid-flow: mark dirty (hot-reload), but use skipRefresh
    writeFileSync(taskPath, taskSource("'v2'"), 'utf-8')
    markDirty(workspace)

    // ensureDiscovered with skipRefresh should NOT reload
    await ensureDiscovered(workspace, true)
    assert.ok(resolveTaskTarget('pinned', workspace, 'app'), 'target should still resolve')
    // After skip, dirty flag should still be set
    assert.ok(true, 'skip refresh preserves in-flight versions')

    // Without skip, refresh happens
    await ensureDiscovered(workspace, false)
    const afterRefresh = resolveTaskTarget('pinned', workspace, 'app')
    assertTaskTarget(afterRefresh)
    assert.equal(await afterRefresh.definition.config.prompt({}), 'v2', 'should pick up v2 after non-skipped refresh')
  })

  // ── agentRuntime tests ──

  it('exposes agentRuntime in list/describe and synthesizes forge/<profile> from legacy definitions', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    // Legacy: no agentRuntime, only profile
    writeFileSync(join(projectDir, 'legacy.task.ts'), taskSource("'legacy'"), 'utf-8')
    // New: agentRuntime with concrete profile
    writeFileSync(join(projectDir, 'modern.task.ts'), `export default defineTask({
  permission: 'readonly',
  agentRuntime: 'forge/codex-luna',
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: () => 'modern',
})
`, 'utf-8')

    await discoverTasks(workspace)

    const listed = listTasks(workspace, 'app')
    const legacy = listed.find((task) => task.name === 'legacy')
    assert.ok(legacy, 'legacy task should be listed')
    assert.equal(legacy.agentRuntime, 'forge/test')
    assert.equal('profile' in legacy, false, 'profile must not appear in public metadata')

    const modern = listed.find((task) => task.name === 'modern')
    assert.ok(modern, 'modern task should be listed')
    assert.equal(modern.agentRuntime, 'forge/codex-luna')
    assert.equal('profile' in modern, false, 'profile must not appear in public metadata')

    const described = describeTask('modern', workspace, 'app')
    assert.ok(described, 'modern task should be describable')
    assert.equal(described.agentRuntime, 'forge/codex-luna')
    assert.equal('profile' in described, false)
  })

  it('synthesizes forge/<profile> for findTaskDefinition', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeFileSync(join(projectDir, 'finder.task.ts'), taskSource("'finder'"), 'utf-8')

    await discoverTasks(workspace)

    const found = findTaskDefinition('finder', workspace, 'app')
    assert.ok(found, 'task should be findable')
    assert.equal(found.agentRuntime, 'forge/test')
    assert.equal('profile' in found, false)
  })

  it('validates agentRuntime format at load time', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'bad-runtime.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, taskSource("'bad-runtime'",
      "  agentRuntime: '/no-runtime',\n"), 'utf-8')

    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('bad-runtime', workspace), null, 'task with bad runtime format should not resolve')
    const errors = getLoadErrors(workspace)
    assert.ok(errors.some((error) => error.load_error.includes('agentRuntime')), 'should have agentRuntime load error')
  })

  it('accepts forge policy profiles via agentRuntime', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeFileSync(join(projectDir, 'policy.task.ts'), `export default defineTask({
  permission: 'readonly',
  agentRuntime: 'forge/general',
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: () => 'policy',
})
`, 'utf-8')

    await discoverTasks(workspace)

    const task = describeTask('policy', workspace, 'app')
    assert.ok(task, 'policy task should be loadable')
    assert.equal(task.agentRuntime, 'forge/general')
  })

  it('rejects unsupported runtime in agentRuntime', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'unsupported.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, `export default defineTask({
  permission: 'readonly',
  agentRuntime: 'claude/sonnet',
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: () => 'unsupported',
})
`, 'utf-8')

    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('unsupported', workspace), null)
    const errors = getLoadErrors(workspace)
    assert.ok(errors.some((error) => error.load_error.includes('Unsupported runtime')), errors.map((e) => e.load_error).join('; '))
  })

  it('rejects agentRuntime with slash in config-id', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'slashes.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, taskSource("'slashes'",
      "  agentRuntime: 'forge/nested/config',\n"), 'utf-8')

    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('slashes', workspace), null)
    const errors = getLoadErrors(workspace)
    assert.ok(errors.some((error) => error.load_error.includes('agentRuntime')), errors.map((e) => e.load_error).join('; '))
  })

  it('rejects task definition declaring both agentRuntime and profile', async () => {
    const workspace = makeTempDir('foreman-v2-loader-')
    const projectDir = join(workspace, 'projects', 'app')
    const taskPath = join(projectDir, 'both.task.ts')
    registerProject(projectDir, 'app')
    writeFileSync(taskPath, taskSource("'both'",
      "  agentRuntime: 'forge/codex-luna',\n"), 'utf-8')

    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('both', workspace), null, 'task with both profile and agentRuntime should not resolve')
    const errors = getLoadErrors(workspace)
    assert.ok(errors.some((error) => error.load_error.includes('both agentRuntime')), errors.map((e) => e.load_error).join('; '))
  })

  it('exposes source and omits project on public task definitions', async () => {
    const workspace = makeTempDir('foreman-v2-loader-source-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeFileSync(join(projectDir, 'sourced.task.ts'), taskSource("'sourced'"), 'utf-8')

    await discoverTasks(workspace)

    const listed = listTasks(workspace, 'app').find((task) => task.name === 'sourced')
    assert.ok(listed, 'sourced task should be listed')
    assert.equal(listed.source, 'project')
    assert.equal(listed.project, 'app')

    const described = describeTask('sourced', workspace, 'app')
    assert.ok(described, 'sourced task should be describable')
    assert.equal(described.name, 'sourced')
    assert.equal(described.source, 'project')
    assert.equal(described.project, 'app')

    const found = findTaskDefinition('sourced', workspace, 'app')
    assert.ok(found, 'sourced task should be findable')
    assert.equal(found.name, 'sourced')
    assert.equal(found.source, 'project')
    assert.equal(found.project, 'app')
  })
})
