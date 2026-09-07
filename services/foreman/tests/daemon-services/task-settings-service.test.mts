import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type {
  TaskDispatchChoice,
  TaskDispatchResolver,
} from '../../lib/core/task/dispatch-resolver.mts'
import {
  TaskSettingsContentConflictError,
  TaskSettingsIneligibleRuntimeError,
  TaskSettingsService,
  TaskSettingsTaskNotFoundError,
  type TaskSettingsDefinitionSource,
} from '../../lib/daemon/services/task-settings-service.mts'
import {
  bindTaskRuntimeOverrideConfigPath,
  resetTaskRuntimeOverrideConfigPathBinding,
} from '../../lib/config/task-runtime-override.mts'

const CATALOG_CHECKED_AT = '2026-09-05'

function resolvedChoice(exactAgentRuntime: string, profile: string): TaskDispatchChoice {
  return {
    exactAgentRuntime,
    requested_agent_runtime: exactAgentRuntime,
    profile,
    client: 'codex',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    model_id: 'codex/gpt-5.6-luna',
    mode: 'native',
    speed: {
      effective_tps: 107,
      source: 'catalog_default',
      sample_count: 0,
      checked_at: CATALOG_CHECKED_AT,
      expected_tps_met: true,
    },
    intelligence: 'mid',
    reference_pricing: {
      input_usd_per_million: 0.2,
      output_usd_per_million: 1.2,
      source: 'catalog',
      checked_at: CATALOG_CHECKED_AT,
    },
  }
}

/**
 * Deterministic resolver fixture. Eligibility is driven by the task's declared
 * runtime exactly like the real resolver: commit declares a policy runtime so
 * every exact candidate is eligible; review declares an exact pin so only that
 * pinned profile can be selected. Policy aliases are never choices.
 */
function createResolverFixture(): TaskDispatchResolver {
  return {
    resolve(): never {
      throw new Error('resolve is not exercised by task-settings tests')
    },
    eligible(input) {
      if (input.declaredRuntime === 'forge/codex-sol') {
        return { ok: true as const, choices: [resolvedChoice('forge/codex-sol', 'codex-sol')] }
      }
      if (input.declaredRuntime === 'forge/fast' || input.declaredRuntime === undefined) {
        return {
          ok: true as const,
          choices: [
            resolvedChoice('forge/cb-dsf', 'cb-dsf'),
            resolvedChoice('forge/codex-luna', 'codex-luna'),
            resolvedChoice('forge/cb-hy', 'cb-hy'),
          ],
        }
      }
      return { ok: true as const, choices: [] }
    },
  }
}

interface FixtureEntry {
  name: string
  project?: string
  source: string
  agentRuntime: string
  dispatch: Record<string, unknown>
}

function createDefinitionsFixture(): TaskSettingsDefinitionSource {
  const listEntries = (project?: string): FixtureEntry[] => [
    {
      name: 'commit',
      ...(project !== undefined ? { project } : {}),
      source: 'workspace',
      agentRuntime: 'forge/fast',
      dispatch: { expectedTps: 80, minimumTps: 60 },
    },
    {
      name: 'review',
      ...(project !== undefined ? { project } : {}),
      source: 'workspace',
      agentRuntime: 'forge/codex-sol',
      dispatch: { maxOutputUsdPerMillion: 15 },
    },
  ]
  const findEntry = (taskId: string, project?: string): FixtureEntry | undefined => {
    return listEntries(project).find((entry) => entry.name === taskId)
  }
  return {
    async list(project) {
      return listEntries(project)
    },
    async describe(taskId, project) {
      const summary = findEntry(taskId, project)
      if (!summary) throw new Error(`task '${taskId}' not found`)
      const { dispatch, ...rest } = summary
      return {
        ...rest,
        dispatch,
        permission: 'readonly' as const,
        input_schema: { note: taskId },
        output_schema: { done: true },
      }
    },
  }
}

interface TestContext {
  dir: string
  configPath: string
  service: TaskSettingsService
}

describe('daemon task-settings-service (no-model)', () => {
  let context: TestContext | undefined

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-task-settings-'))
    const configPath = join(dir, 'config.json')
    context = {
      dir,
      configPath,
      service: new TaskSettingsService({
        workspaceRoot: dir,
        configPath,
        resolver: createResolverFixture(),
        definitions: createDefinitionsFixture(),
      }),
    }
  })

  afterEach(() => {
    resetTaskRuntimeOverrideConfigPathBinding()
    if (context) {
      rmSync(context.dir, { recursive: true, force: true })
      context = undefined
    }
  })

  const writeConfig = (data: unknown): void => {
    writeFileSync(context!.configPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  }

  const readConfig = (): Record<string, unknown> => {
    return JSON.parse(readFileSync(context!.configPath, 'utf-8')) as Record<string, unknown>
  }

  const tempResidue = (): string[] => readdirSync(context!.dir).filter((entry) => entry.includes('.tmp'))

  it('snapshot reports the authoritative config path, revision, selection source and machine-global scope', async () => {
    writeConfig({ tasks: { agentRuntime: { review: 'forge/codex-sol' } } })

    const snapshot = await context!.service.snapshot({})

    // Authoritative path and deterministic content revision are reported.
    assert.equal(snapshot.config_path, context!.configPath)
    assert.equal(snapshot.revision.length > 0, true)
    assert.equal(snapshot.scope, 'machine_global')
    assert.equal(snapshot.keyed_by, 'bare_task_name')

    const commit = snapshot.tasks.find((row) => row.task_id === 'commit')
    assert.ok(commit)
    // commit declares a policy runtime: automatic, no machine preference yet.
    assert.equal(commit.declared_agent_runtime, 'forge/fast')
    assert.equal(commit.machine_preference, null)
    assert.deepEqual(commit.selection, { agent_runtime: null, source: 'automatic' })
    // Read-only contract metadata is present.
    assert.equal(commit.source, 'workspace')
    assert.equal(commit.permission, 'readonly')
    assert.deepEqual(commit.eligible.map((c) => c.exactAgentRuntime), [
      'forge/cb-dsf',
      'forge/codex-luna',
      'forge/cb-hy',
    ])
    // Each eligible row carries the resolved dispatch fields.
    for (const choice of commit.eligible) {
      assert.equal(choice.client, 'codex')
      assert.equal(typeof choice.model, 'string')
      assert.equal(typeof choice.speed.effective_tps, 'number')
    }

    const review = snapshot.tasks.find((row) => row.task_id === 'review')
    assert.ok(review)
    // Machine preference exists: current selection is machine-sourced.
    assert.equal(review.declared_agent_runtime, 'forge/codex-sol')
    assert.equal(review.machine_preference, 'forge/codex-sol')
    assert.deepEqual(review.selection, { agent_runtime: 'forge/codex-sol', source: 'machine' })
    // Exact declared pin exposes at most one eligible choice.
    assert.deepEqual(review.eligible.map((c) => c.exactAgentRuntime), ['forge/codex-sol'])
  })

  it('keeps the builtin declaration separate from a machine preference in the default definition source', async () => {
    writeConfig({ tasks: { agentRuntime: { edit: 'forge/codex-luna' } } })
    const release = bindTaskRuntimeOverrideConfigPath(context!.configPath)
    const service = new TaskSettingsService({
      workspaceRoot: context!.dir,
      configPath: context!.configPath,
      resolver: createResolverFixture(),
    })
    const snapshot = await service.snapshot({})
    release()

    const edit = snapshot.tasks.find((row) => row.task_id === 'edit')
    assert.ok(edit)
    assert.equal(edit.declared_agent_runtime, 'forge/fast')
    assert.equal(edit.machine_preference, 'forge/codex-luna')
    assert.deepEqual(edit.selection, { agent_runtime: 'forge/codex-luna', source: 'machine' })
    assert.deepEqual(edit.eligible.map((choice) => choice.exactAgentRuntime), [
      'forge/cb-dsf',
      'forge/codex-luna',
      'forge/cb-hy',
    ])
  })

  it('save persists one exact eligible preference under the bare task name', async () => {
    writeConfig({ tasks: {} })
    const before = await context!.service.snapshot({})
    const revision = before.revision

    const after = await context!.service.save({
      task_id: 'commit',
      agent_runtime: 'forge/cb-dsf',
      expected_revision: revision,
    })

    assert.equal(after.config_path, context!.configPath)
    assert.notEqual(after.revision, revision)
    const commit = after.tasks.find((row) => row.task_id === 'commit')
    assert.ok(commit)
    assert.equal(commit.machine_preference, 'forge/cb-dsf')
    assert.deepEqual(commit.selection, { agent_runtime: 'forge/cb-dsf', source: 'machine' })

    const onDisk = readConfig()
    const agentRuntime = (onDisk.tasks as Record<string, unknown>).agentRuntime as Record<string, string>
    assert.deepEqual(agentRuntime, { commit: 'forge/cb-dsf' })
    assert.equal(tempResidue().length, 0)
  })

  it('null reset deletes only the bare task preference key', async () => {
    writeConfig({
      top_level: { keep: true },
      tasks: { agentRuntime: { commit: 'forge/cb-dsf', review: 'forge/codex-sol' } },
    })
    const before = await context!.service.snapshot({})

    const after = await context!.service.save({
      task_id: 'commit',
      agent_runtime: null,
      expected_revision: before.revision,
    })

    const commit = after.tasks.find((row) => row.task_id === 'commit')
    assert.ok(commit)
    assert.equal(commit.machine_preference, null)
    assert.deepEqual(commit.selection, { agent_runtime: null, source: 'automatic' })

    const onDisk = readConfig()
    assert.deepEqual(
      (onDisk.tasks as Record<string, unknown>).agentRuntime as Record<string, unknown>,
      { review: 'forge/codex-sol' },
    )
    // Unrelated keys survive the reset.
    assert.deepEqual(onDisk.top_level, { keep: true })
    assert.equal(tempResidue().length, 0)
  })

  it('save rejects ineligible exact runtimes and legacy policy aliases', async () => {
    writeConfig({ tasks: {} })
    const before = await context!.service.snapshot({})
    const revision = before.revision

    // commit is eligible for cb-dsf/codex-luna/cb-hy only — a different exact
    // profile is ineligible even though it is valid for review.
    await assert.rejects(
      context!.service.save({
        task_id: 'commit',
        agent_runtime: 'forge/codex-sol',
        expected_revision: revision,
      }),
      (error) => error instanceof TaskSettingsIneligibleRuntimeError,
    )
    // Legacy policy aliases are never eligible choices.
    for (const alias of ['forge/fast', 'forge/general', 'forge/ultra']) {
      await assert.rejects(
        context!.service.save({
          task_id: 'commit',
          agent_runtime: alias,
          expected_revision: revision,
        }),
        (error) => error instanceof TaskSettingsIneligibleRuntimeError,
      )
    }
    // Nothing was written by the rejected saves.
    assert.deepEqual(readConfig(), { tasks: {} })
    assert.equal(tempResidue().length, 0)
  })

  it('save preserves unknown top-level and tasks sibling keys', async () => {
    writeConfig({
      unknown_top: { nested: [1, 2, 3] },
      tasks: {
        agentRuntime: { review: 'forge/codex-sol' },
        sibling_flag: true,
        unknown_sibling: { kept: true },
      },
    })
    const before = await context!.service.snapshot({})

    await context!.service.save({
      task_id: 'commit',
      agent_runtime: 'forge/cb-hy',
      expected_revision: before.revision,
    })

    const onDisk = readConfig()
    assert.deepEqual(onDisk.unknown_top, { nested: [1, 2, 3] })
    const tasks = onDisk.tasks as Record<string, unknown>
    assert.equal(tasks.sibling_flag, true)
    assert.deepEqual(tasks.unknown_sibling, { kept: true })
    assert.deepEqual(tasks.agentRuntime, { review: 'forge/codex-sol', commit: 'forge/cb-hy' })
  })

  it('stale expected_revision raises a typed content_conflict and preserves the external edit', async () => {
    writeConfig({ tasks: { agentRuntime: { review: 'forge/codex-sol' } } })
    const before = await context!.service.snapshot({})

    // External edit: someone (a CLI/user/other tool) modifies the same config.
    writeConfig({
      external: 'edited-out-of-band',
      tasks: { agentRuntime: { review: 'forge/codex-sol', commit: 'forge/codex-luna' } },
    })

    await assert.rejects(
      context!.service.save({
        task_id: 'commit',
        agent_runtime: 'forge/cb-dsf',
        expected_revision: before.revision,
      }),
      (error) => error instanceof TaskSettingsContentConflictError,
    )

    // The failed save never wrote: the external edit is still on disk.
    const onDisk = readConfig()
    assert.equal(onDisk.external, 'edited-out-of-band')
    const agentRuntime = (onDisk.tasks as Record<string, unknown>).agentRuntime as Record<string, string>
    assert.deepEqual(agentRuntime, { review: 'forge/codex-sol', commit: 'forge/codex-luna' })
    assert.equal(tempResidue().length, 0)
  })

  it('same-named tasks in any project share the machine-global bare-name key', async () => {
    writeConfig({ tasks: { agentRuntime: { commit: 'forge/cb-dsf' } } })

    const alpha = await context!.service.snapshot({ project: 'alpha' })
    const alphaCommit = alpha.tasks.find((row) => row.task_id === 'commit')
    assert.ok(alphaCommit)
    assert.equal(alphaCommit.project, 'alpha')
    assert.equal(alphaCommit.machine_preference, 'forge/cb-dsf')
    assert.deepEqual(alphaCommit.selection, { agent_runtime: 'forge/cb-dsf', source: 'machine' })

    // A save issued while another project is selected still writes the bare key.
    const betaBefore = await context!.service.snapshot({ project: 'beta' })
    await context!.service.save({
      task_id: 'commit',
      project: 'beta',
      agent_runtime: 'forge/codex-luna',
      expected_revision: betaBefore.revision,
    })

    const onDisk = readConfig()
    const agentRuntime = (onDisk.tasks as Record<string, unknown>).agentRuntime as Record<string, unknown>
    // Key is the bare task name 'commit', not a project-qualified key.
    assert.equal(agentRuntime.commit, 'forge/codex-luna')
    assert.equal('beta/commit' in agentRuntime, false)
    assert.equal(tempResidue().length, 0)
  })

  it('task existence is required before any save or reset', async () => {
    writeConfig({ tasks: {} })
    const before = await context!.service.snapshot({})
    await assert.rejects(
      context!.service.save({
        task_id: 'does-not-exist',
        agent_runtime: null,
        expected_revision: before.revision,
      }),
      (error) => error instanceof TaskSettingsTaskNotFoundError,
    )
    assert.equal(tempResidue().length, 0)
  })
})
