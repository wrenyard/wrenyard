import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  ExplicitRuntimeUnavailableError,
  NoEligiblePlanError,
  type TaskDispatchResolver,
} from '../../lib/core/task/dispatch-resolver.mts'
import type { TaskResolvedDispatch } from '../../lib/task-run-metadata-types.mts'
import {
  TaskSettingsContentConflictError,
  TaskSettingsRuntimeUnavailableError,
  TaskSettingsService,
  TaskSettingsTaskNotFoundError,
  taskInstructionTemplate,
  type TaskSettingsDaemonAvailabilityCallback,
  type TaskSettingsDefinitionSource,
  type TaskSettingsRuntimeAvailabilityCallback,
} from '../../lib/daemon/services/task-settings-service.mts'

const CATALOG_CHECKED_AT = '2026-09-05'

interface ProfileFixture {
  exactAgentRuntime: string
  profile: string
  client: string
  provider: string
  model: string
  intelligence: string
  tps: number
  inputUsd: number
  outputUsd: number
}

const PROFILES: ProfileFixture[] = [
  {
    exactAgentRuntime: 'forge/cb-dsf',
    profile: 'cb-dsf',
    client: 'codex',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    intelligence: 'mid',
    tps: 107,
    inputUsd: 0.2,
    outputUsd: 1.2,
  },
  {
    exactAgentRuntime: 'forge/codex-luna',
    profile: 'codex-luna',
    client: 'codex',
    provider: 'codex',
    model: 'gpt-6.0-nova',
    intelligence: 'high',
    tps: 120,
    inputUsd: 0.5,
    outputUsd: 2.0,
  },
  {
    exactAgentRuntime: 'forge/codex-sol',
    profile: 'codex-sol',
    client: 'claude',
    provider: 'claude',
    model: 'claude-opus-4',
    intelligence: 'frontier',
    tps: 60,
    inputUsd: 5,
    outputUsd: 15,
  },
]

function resolvedChoice(profile: ProfileFixture): TaskResolvedDispatch {
  return {
    requested_agent_runtime: profile.exactAgentRuntime,
    profile: profile.profile,
    client: profile.client,
    provider: profile.provider,
    model: profile.model,
    model_id: `${profile.provider}/${profile.model}`,
    mode: 'native',
    speed: {
      effective_tps: profile.tps,
      source: 'catalog_default',
      sample_count: 0,
      checked_at: CATALOG_CHECKED_AT,
      expected_tps_met: true,
    },
    intelligence: profile.intelligence,
    reference_pricing: {
      input_usd_per_million: profile.inputUsd,
      output_usd_per_million: profile.outputUsd,
      source: 'catalog',
      checked_at: CATALOG_CHECKED_AT,
    },
  }
}

function resolveTriple(profile: ProfileFixture): { client: string; provider: string; model: string } {
  return { client: profile.client, provider: profile.provider, model: profile.model }
}

function exactRuntimeIdForTriple(triple: { client: string; provider: string; model: string }): string | null {
  const profile = PROFILES.find(
    (p) => p.client === triple.client && p.provider === triple.provider && p.model === triple.model,
  )
  return profile?.exactAgentRuntime ?? null
}

interface ResolverFixtureOptions {
  /** exact runtimes intentionally unavailable per task name. */
  unavailable?: Record<string, string>
  /** tasks whose automatic `resolve` must fail deterministically. */
  autoFailTasks?: string[]
}

function createResolverFixture(options: ResolverFixtureOptions = {}): TaskDispatchResolver {
  const unavailable = options.unavailable ?? {}
  const autoFailTasks = options.autoFailTasks ?? []
  const blocked = (taskName: string, exactAgentRuntime: string): boolean =>
    unavailable[taskName] === exactAgentRuntime
  return {
    resolve(input) {
      if (autoFailTasks.includes(input.taskName)) {
        return { ok: false as const, error: new NoEligiblePlanError(input.taskName, [], input.requirements) }
      }
      const profile = PROFILES[0]!
      return { ok: true as const, exactAgentRuntime: profile.exactAgentRuntime, resolved: resolvedChoice(profile) }
    },
    eligible(input) {
      const choices = PROFILES
        .filter((profile) => !blocked(input.taskName, profile.exactAgentRuntime))
        .map((profile) => ({ ...resolvedChoice(profile), exactAgentRuntime: profile.exactAgentRuntime }))
      return { ok: true as const, choices }
    },
    resolveExplicit(input) {
      const profile = PROFILES.find((p) => p.exactAgentRuntime === input.exactRuntime)
      if (!profile) {
        return {
          ok: false as const,
          error: new ExplicitRuntimeUnavailableError(
            input.taskName,
            input.exactRuntime,
            'runtime does not exist',
          ),
        }
      }
      if (blocked(input.taskName, profile.exactAgentRuntime)) {
        return {
          ok: false as const,
          error: new ExplicitRuntimeUnavailableError(
            input.taskName,
            input.exactRuntime,
            'runtime is unavailable',
          ),
        }
      }
      return { ok: true as const, exactAgentRuntime: profile.exactAgentRuntime, resolved: resolvedChoice(profile) }
    },
    listExactRuntimes(input) {
      return {
        ok: true as const,
        items: PROFILES.map((profile) => {
          const isAvailable = !blocked(input.taskName, profile.exactAgentRuntime)
          return isAvailable
            ? { exactAgentRuntime: profile.exactAgentRuntime, available: true as const, resolved: resolvedChoice(profile) }
            : {
              exactAgentRuntime: profile.exactAgentRuntime,
              available: false as const,
              unavailableReason: 'fixture-blocked',
            }
        }),
      }
    },
  }
}

interface DefEntry {
  name: string
  displayName?: string
  agentRuntime: string
  dispatch?: Record<string, unknown>
  timeoutMs?: number
  description?: string
  source?: string
  /** Ordered TaskConfig-style instructions (strings + functions). */
  instructions?: Array<string | ((input?: unknown) => string | Promise<string>)>
}

const BUILTIN_DEFS: DefEntry[] = [
  {
    name: 'commit',
    displayName: 'Commit helper',
    agentRuntime: 'forge/fast',
    dispatch: { expectedTps: 80, minimumTps: 60 },
    timeoutMs: 120_000,
    description: 'Commit message helper',
    source: 'workspace',
  },
  {
    name: 'review',
    agentRuntime: 'forge/codex-sol',
    dispatch: { maxOutputUsdPerMillion: 15 },
    timeoutMs: 180_000,
    description: 'Code review',
    source: 'workspace',
  },
  {
    name: 'unavailable',
    agentRuntime: 'forge/codex-sol',
    dispatch: { maxOutputUsdPerMillion: 15 },
    timeoutMs: 180_000,
    description: 'Review task whose pinned runtime is blocked',
    source: 'workspace',
  },
  {
    name: 'auto-fail',
    agentRuntime: 'forge/fast',
    dispatch: { expectedTps: 1000 },
    timeoutMs: 120_000,
    description: 'Automatic dispatch that fails preflight',
    source: 'workspace',
  },
]

function defToSummary(entry: DefEntry, project?: string) {
  return {
    name: entry.name,
    ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
    ...(project !== undefined ? { kind: 'project' as const, project } : { kind: 'builtin' as const }),
    source: entry.source ?? 'workspace',
    description: entry.description,
    agentRuntime: entry.agentRuntime,
    ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    ...(entry.dispatch !== undefined ? { dispatch: entry.dispatch } : {}),
    ...(entry.instructions !== undefined
      ? { instructionTemplate: taskInstructionTemplate({ instructions: entry.instructions, prompt: () => '' }) }
      : {}),
  }
}

function createDefinitionsFixture(): TaskSettingsDefinitionSource {
  const findEntry = (name: string): DefEntry | undefined =>
    BUILTIN_DEFS.find((entry) => entry.name === name)
  return {
    async list(project) {
      if (project === undefined) return BUILTIN_DEFS.map((entry) => defToSummary(entry))
      const entries = BUILTIN_DEFS.filter(
        (entry) => entry.name === 'commit' || entry.name === 'review',
      )
      return entries.map((entry) => defToSummary(entry, project))
    },
    async describe(taskId, project) {
      const entry = findEntry(taskId)
      if (!entry) throw new Error(`task '${taskId}' not found`)
      const summary = defToSummary(entry, project)
      return {
        ...summary,
        permission: 'readonly',
        input_schema: { note: taskId },
        output_schema: { done: true },
      }
    },
  }
}

interface ProjectFixtureGroup {
  id: string
  displayName?: string
  defs: DefEntry[]
}

/** Injectable source with registered-project discovery: unscoped listing yields
 *  builtins only; each registered project lists exactly its own task defs. */
function createGroupedDefinitionsFixture(projects: ProjectFixtureGroup[]): TaskSettingsDefinitionSource {
  const projectOf = (taskId: string, project?: string): DefEntry | undefined => {
    if (project !== undefined) {
      const group = projects.find((entry) => entry.id === project)
      const found = group?.defs.find((entry) => entry.name === taskId)
      if (found) return found
    }
    return undefined
  }
  const anyProjectEntry = (taskId: string): DefEntry | undefined =>
    projects.flatMap((group) => group.defs).find((entry) => entry.name === taskId)
  const findEntry = (taskId: string, project?: string): DefEntry | undefined =>
    projectOf(taskId, project) ?? BUILTIN_DEFS.find((entry) => entry.name === taskId) ?? anyProjectEntry(taskId)
  return {
    async list(project) {
      if (project === undefined) return BUILTIN_DEFS.map((entry) => defToSummary(entry))
      const group = projects.find((entry) => entry.id === project)
      return group ? group.defs.map((entry) => defToSummary(entry, project)) : []
    },
    async listProjects() {
      return projects.map((entry) => ({
        id: entry.id,
        ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
      }))
    },
    async describe(taskId, project) {
      const entry = findEntry(taskId, project)
      if (!entry) throw new Error(`task '${taskId}' not found`)
      const summary = defToSummary(entry, project)
      return {
        ...summary,
        permission: 'readonly',
        input_schema: { note: taskId },
        output_schema: { done: true },
      }
    },
  }
}

interface TestContext {
  dir: string
  configPath: string
  makeService: (overrides?: Partial<ConstructorParameters<typeof TaskSettingsService>[0]>) => TaskSettingsService
}

const defaultDaemonAvailability: TaskSettingsDaemonAvailabilityCallback = () => ({ accepting: true, known: true })
const defaultRuntimeAvailability: TaskSettingsRuntimeAvailabilityCallback = () => ({
  providerCredential: 'available',
  providerLive: 'unknown',
  quota: 'unknown',
  available: true,
})

describe('daemon task-settings-service (no-model)', () => {
  let context: TestContext | undefined

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-task-settings-'))
    const configPath = join(dir, 'config.json')
    context = {
      dir,
      configPath,
      makeService: (overrides = {}) =>
        new TaskSettingsService({
          workspaceRoot: dir,
          configPath,
          resolver: createResolverFixture({
            unavailable: { unavailable: 'forge/codex-sol' },
            autoFailTasks: ['auto-fail'],
          }),
          definitions: createDefinitionsFixture(),
          daemonAvailability: defaultDaemonAvailability,
          runtimeAvailability: defaultRuntimeAvailability,
          ...overrides,
        }),
    }
  })

  afterEach(() => {
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

  it('reports the authoritative path, revision and layered effective settings with per-field sources', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { selectionMode: 'automatic', timeoutMs: 900_000, dispatch: { expectedTps: 100 } },
          byTask: {
            'builtin:commit': { additionalInstructions: 'be terse', dispatch: { minimumTps: 90 } },
          },
        },
      },
    })
    const service = context!.makeService()
    const snapshot = await service.snapshot({})

    assert.equal(snapshot.config_path, context!.configPath)
    assert.equal(snapshot.revision.length > 0, true)
    // user-global layer surfaced as JSON-safe snake_case layer.
    assert.deepEqual(snapshot.user_global, {
      mode: 'automatic',
      timeout_ms: 900_000,
      automatic: { expected_tps: 100 },
    })

    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    // Builtin metadata is read-only: source/description and a dynamic template marker.
    assert.equal(commit.builtin.name, 'commit')
    assert.equal(commit.builtin.source, 'workspace')
    assert.equal(commit.builtin.prompt_template, 'dynamic')
    assert.equal('additional_instructions' in commit.builtin, false)
    assert.equal(commit.builtin.declared_runtime, null)

    // Per-task persisted layer is exactly the byTask entry (snake_case DTO).
    assert.deepEqual(commit.user_task, {
      additional_instructions: 'be terse',
      automatic: { minimum_tps: 90 },
    })

    // Field-level right-wins precedence with the winning source reported.
    assert.deepEqual(commit.effective.mode, { value: 'automatic', source: 'user_global' })
    assert.deepEqual(commit.effective.timeout_ms, { value: 900_000, source: 'user_global' })
    assert.deepEqual(commit.effective.additional_instructions, { value: 'be terse', source: 'user_task' })
    assert.deepEqual(commit.effective.explicit_runtime, { value: null, source: 'system' })
    assert.deepEqual(commit.effective.automatic.expected_tps, { value: 100, source: 'user_global' })
    // Builtin minimumTps (60) overridden by the per-task minimumTps (90).
    assert.deepEqual(commit.effective.automatic.minimum_tps, { value: 90, source: 'user_task' })
    assert.deepEqual(commit.effective.automatic.intelligence_min, { value: null, source: 'system' })
    // No validation issues for a clean automatic row.
    assert.deepEqual(commit.issues, [])
  })

  it('keys project rows by stable project identity', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { timeoutMs: 60_000 },
          byTask: { 'project:alpha:review': { timeoutMs: 222_000 } },
        },
      },
    })
    const service = context!.makeService()
    const snapshot = await service.snapshot({ project: 'alpha' })

    assert.equal(snapshot.project, 'alpha')
    const review = snapshot.rows.find((row) => row.identity === 'project:alpha:review')
    assert.ok(review)
    assert.equal(review.project, 'alpha')
    assert.deepEqual(review.effective.timeout_ms, { value: 222_000, source: 'user_task' })
    assert.equal(review.builtin.identity, 'project:alpha:review')
    // No legacy agentRuntime is consulted for project rows.
    assert.equal(review.builtin.declared_runtime, 'forge/codex-sol')
  })

  it('reset deletes only the current-layer field and cleans empty containers', async () => {
    writeConfig({
      top_level: { keep: true },
      tasks: {
        settings: {
          global: { timeoutMs: 800_000 },
          byTask: { 'builtin:commit': { timeoutMs: 123_456, additionalInstructions: 'keep me' } },
        },
      },
    })
    const service = context!.makeService()
    const before = await service.snapshot({})

    const after = await service.save({
      scope: 'task',
      task_id: 'commit',
      expected_revision: before.revision,
      patch: { timeout_ms: null },
    })

    const commit = after.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    // timeout_ms deleted at the per-task layer only; the sibling field survives.
    assert.deepEqual(commit.user_task, { additional_instructions: 'keep me' })
    // Global timeout inherited again.
    assert.deepEqual(commit.effective.timeout_ms, { value: 800_000, source: 'user_global' })

    let onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    assert.deepEqual(byTask['builtin:commit'], { additionalInstructions: 'keep me' })
    assert.deepEqual(onDisk.top_level, { keep: true })
    assert.equal(tempResidue().length, 0)

    // Resetting the final field removes the byTask entry and empty containers.
    const secondBefore = await service.snapshot({})
    await service.save({
      scope: 'task',
      task_id: 'commit',
      expected_revision: secondBefore.revision,
      patch: { additional_instructions: null },
    })
    onDisk = readConfig()
    const afterTasks = onDisk.tasks as Record<string, unknown>
    const afterSettings = afterTasks.settings as Record<string, unknown>
    assert.equal((afterSettings as { byTask?: unknown }).byTask, undefined)
    assert.deepEqual(afterSettings.global, { timeoutMs: 800_000 })
    assert.equal(tempResidue().length, 0)
  })

  it('accepts the stable identity returned by snapshot when saving a task row', async () => {
    writeConfig({})
    const service = context!.makeService()
    const before = await service.snapshot({})
    const after = await service.save({
      scope: 'task',
      task_id: 'builtin:commit',
      expected_revision: before.revision,
      patch: { additional_instructions: 'identity round trip' },
    })

    assert.equal(after.rows.length, 1)
    assert.equal(after.rows[0]?.identity, 'builtin:commit')
    assert.deepEqual(after.rows[0]?.user_task, { additional_instructions: 'identity round trip' })
    assert.deepEqual(
      (readConfig().tasks as { settings: { byTask: Record<string, unknown> } }).settings.byTask['builtin:commit'],
      { additionalInstructions: 'identity round trip' },
    )
  })

  it('save persists a validated explicit selection under the stable identity', async () => {
    writeConfig({})
    const service = context!.makeService()
    const before = await service.snapshot({})

    const after = await service.save({
      scope: 'task',
      task_id: 'commit',
      expected_revision: before.revision,
      patch: {
        mode: 'explicit',
        explicit_runtime: resolveTriple(PROFILES[0]!),
      },
    })

    const commit = after.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.deepEqual(commit.effective.mode, { value: 'explicit', source: 'user_task' })
    assert.deepEqual(commit.effective.explicit_runtime, {
      value: resolveTriple(PROFILES[0]!),
      source: 'user_task',
    })
    assert.ok(commit.explicit)
    assert.equal(commit.explicit.runtime.client, PROFILES[0]!.client)
    assert.equal(commit.explicit.resolved?.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.equal(commit.explicit.resolved?.model, PROFILES[0]!.model)

    const onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    assert.deepEqual(byTask['builtin:commit'], {
      selectionMode: 'explicit',
      agentRuntime: 'forge/cb-dsf',
    })
    assert.equal(tempResidue().length, 0)
  })

  it('rejects an explicit save when the live provider is unavailable and writes nothing', async () => {
    writeConfig({})
    const service = context!.makeService({
      runtimeAvailability: () => ({
        providerCredential: 'missing',
        providerLive: 'unknown',
        quota: 'unknown',
        available: false,
      }),
    })
    const before = await service.snapshot({})

    await assert.rejects(
      service.save({
        scope: 'task',
        task_id: 'commit',
        expected_revision: before.revision,
        patch: {
          mode: 'explicit',
          explicit_runtime: resolveTriple(PROFILES[0]!),
        },
      }),
      (error) => error instanceof TaskSettingsRuntimeUnavailableError,
    )
    assert.deepEqual(readConfig(), {})
    assert.equal(tempResidue().length, 0)
  })

  it('rejects an explicit save when the daemon is not accepting and writes nothing', async () => {
    writeConfig({})
    const service = context!.makeService({
      daemonAvailability: () => ({ accepting: false, known: true }),
    })
    const before = await service.snapshot({})

    await assert.rejects(
      service.save({
        scope: 'task',
        task_id: 'commit',
        expected_revision: before.revision,
        patch: {
          mode: 'explicit',
          explicit_runtime: resolveTriple(PROFILES[0]!),
        },
      }),
      (error) => error instanceof TaskSettingsRuntimeUnavailableError,
    )
    assert.deepEqual(readConfig(), {})
  })

  it('stale expected_revision raises typed content_conflict and preserves the external edit', async () => {
    writeConfig({
      external: 'edited-out-of-band',
      tasks: { settings: { global: { timeoutMs: 800_000 } } },
    })
    const service = context!.makeService()
    const before = await service.snapshot({})

    writeConfig({
      external: 'edited-out-of-band-v2',
      tasks: { settings: { global: { timeoutMs: 800_000 }, byTask: { 'builtin:commit': { timeoutMs: 1_000 } } } },
    })

    await assert.rejects(
      service.save({
        scope: 'task',
        task_id: 'commit',
        expected_revision: before.revision,
        patch: { additional_instructions: 'never written' },
      }),
      (error) => error instanceof TaskSettingsContentConflictError,
    )

    const onDisk = readConfig()
    assert.equal(onDisk.external, 'edited-out-of-band-v2')
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    assert.deepEqual(byTask['builtin:commit'], { timeoutMs: 1_000 })
    assert.equal(tempResidue().length, 0)
  })

  it('unknown top-level and sibling keys survive a save', async () => {
    writeConfig({
      unknown_top: { nested: [1, 2, 3] },
      tasks: {
        settings: {
          global: { timeoutMs: 60_000 },
        },
        sibling_flag: true,
      },
    })
    const service = context!.makeService()
    const before = await service.snapshot({})

    await service.save({
      scope: 'task',
      task_id: 'commit',
      expected_revision: before.revision,
      patch: { additional_instructions: 'hello' },
    })

    const onDisk = readConfig()
    assert.deepEqual(onDisk.unknown_top, { nested: [1, 2, 3] })
    const tasks = onDisk.tasks as Record<string, unknown>
    assert.equal(tasks.sibling_flag, true)
    assert.equal(tempResidue().length, 0)
  })

  it('automatic preflight runs through resolver.resolve and reports structured issues on failure', async () => {
    const service = context!.makeService()
    const snapshot = await service.snapshot({})

    // commit resolves automatically without issues.
    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.equal(commit.effective.mode.value, 'automatic')
    assert.deepEqual(commit.issues, [])
    // The automatic row exposes the exact successful resolver result.
    assert.equal(commit.resolved_runtime?.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.equal(commit.resolved_runtime?.model, PROFILES[0]!.model)

    // auto-fail resolves through the same resolver path and stays as a row with
    // a structured unavailable issue (never dropped).
    const autoFail = snapshot.rows.find((row) => row.identity === 'builtin:auto-fail')
    assert.ok(autoFail)
    assert.equal(autoFail.effective.mode.value, 'automatic')
    assert.ok(autoFail.issues.some((issue) => issue.code === 'automatic_dispatch_unavailable'))
    // A failed automatic resolution never exposes a stale or alternate runtime.
    assert.equal(autoFail.resolved_runtime, null)
  })

  it('explicit preflight runs through resolveExplicit/listExactRuntimes with no fallback', async () => {
    const service = context!.makeService()
    const snapshot = await service.snapshot({})

    // review declares an exact builtin runtime; explicit resolution succeeds.
    const review = snapshot.rows.find((row) => row.identity === 'builtin:review')
    assert.ok(review)
    assert.deepEqual(review.effective.mode, { value: 'explicit', source: 'builtin' })
    assert.deepEqual(review.effective.explicit_runtime, {
      value: resolveTriple(PROFILES[2]!),
      source: 'builtin',
    })
    assert.ok(review.explicit)
    // Pickers surface every currently available exact runtime.
    assert.deepEqual(
      review.explicit.choices.map((choice) => choice.exactAgentRuntime).sort(),
      ['forge/cb-dsf', 'forge/codex-luna', 'forge/codex-sol'].sort(),
    )
    assert.equal(review.explicit.resolved?.exactAgentRuntime, 'forge/codex-sol')
    // The row-level resolved runtime mirrors the exact explicit resolution.
    assert.equal(review.resolved_runtime?.exactAgentRuntime, 'forge/codex-sol')
    assert.equal(review.resolved_runtime?.model, PROFILES[2]!.model)
    // Readiness from injected non-billable availability callbacks.
    assert.ok(review.explicit.readiness)
    assert.equal(review.explicit.readiness.daemon, 'accepting')
    assert.equal(review.explicit.readiness.quota, 'unknown')
    assert.equal(review.explicit.readiness.available, true)
    assert.equal(review.explicit.readiness.runtime, 'forge/codex-sol')

    // unavailable declares the same exact runtime but its resolveExplicit fails
    // deterministically. The mode stays explicit and the row reports the issue:
    // automatic mode is never used as a fallback.
    const unavailable = snapshot.rows.find((row) => row.identity === 'builtin:unavailable')
    assert.ok(unavailable)
    assert.equal(unavailable.effective.mode.value, 'explicit')
    assert.ok(unavailable.issues.some((issue) => issue.code === 'explicit_runtime_unavailable'))
    if (unavailable.explicit) {
      assert.equal(unavailable.explicit.resolved, null)
      assert.equal(unavailable.explicit.readiness, null)
    }
    // The row-level resolved runtime stays null: no stale/alternate runtime is
    // ever reported when the exact resolution fails.
    assert.equal(unavailable.resolved_runtime, null)
  })

  it('exposes authoritative runtime_choices on automatic rows and reuses them for explicit rows', async () => {
    // Block forge/codex-sol for both the automatic 'commit' row and the
    // explicit 'unavailable' row so exclusion and reuse are observable.
    const service = context!.makeService({
      resolver: createResolverFixture({
        unavailable: { commit: 'forge/codex-sol', unavailable: 'forge/codex-sol' },
      }),
    })
    const snapshot = await service.snapshot({})

    // Automatic row: runtime_choices come straight from listExactRuntimes, the
    // blocked runtime is excluded, and no explicit current selection is invented.
    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.equal(commit.effective.mode.value, 'automatic')
    assert.equal(commit.explicit, undefined)
    assert.equal(commit.effective.explicit_runtime.value, null)
    // The automatic row's resolved runtime is the exact resolver selection.
    assert.equal(commit.resolved_runtime?.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.deepEqual(
      commit.runtime_choices.map((choice) => choice.exactAgentRuntime).sort(),
      ['forge/cb-dsf', 'forge/codex-luna'].sort(),
    )
    assert.equal(commit.runtime_choices.some((choice) => choice.exactAgentRuntime === 'forge/codex-sol'), false)
    // Only available items with truthful resolved metadata are projected.
    assert.ok(
      commit.runtime_choices.every(
        (choice) =>
          choice.client !== ''
          && choice.provider !== ''
          && choice.model !== ''
          && choice.model_id !== ''
          && choice.mode === 'native',
      ),
    )

    // Explicit row: explicit.choices is the same authoritative array, still
    // excluding the blocked runtime while keeping the mode explicit.
    const unavailable = snapshot.rows.find((row) => row.identity === 'builtin:unavailable')
    assert.ok(unavailable)
    assert.equal(unavailable.effective.mode.value, 'explicit')
    assert.deepEqual(
      unavailable.runtime_choices.map((choice) => choice.exactAgentRuntime).sort(),
      ['forge/cb-dsf', 'forge/codex-luna'].sort(),
    )
    assert.ok(unavailable.explicit)
    assert.deepEqual(unavailable.explicit.choices, unavailable.runtime_choices)
    assert.equal(unavailable.explicit.resolved, null)
    // No stale or alternate runtime leaks into the row-level resolved runtime.
    assert.equal(unavailable.resolved_runtime, null)
  })

  it('snapshot readiness reflects a non-accepting daemon and unknown quota', async () => {
    const service = context!.makeService({
      daemonAvailability: () => ({ accepting: false, known: true }),
      runtimeAvailability: () => ({
        providerCredential: 'available',
        providerLive: 'unknown',
        quota: 'unknown',
        available: true,
      }),
    })
    const snapshot = await service.snapshot({})

    const review = snapshot.rows.find((row) => row.identity === 'builtin:review')
    assert.ok(review)
    assert.ok(review.explicit?.readiness)
    assert.equal(review.explicit.readiness.daemon, 'unavailable')
    assert.equal(review.explicit.readiness.available, false)
    assert.equal(review.explicit.readiness.quota, 'unknown')
    assert.ok(review.explicit.readiness.issues.some((issue) => issue.code === 'daemon_not_accepting'))
  })

  it('reads legacy tasks.agentRuntime pins as builtin compatibility but never writes them', async () => {
    writeConfig({ tasks: { agentRuntime: { commit: 'forge/codex-sol' } } })
    const service = context!.makeService()
    const before = await service.snapshot({})

    const commit = before.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.deepEqual(commit.user_task, {
      mode: 'explicit',
      explicit_runtime: resolveTriple(PROFILES[2]!),
    })
    assert.deepEqual(commit.effective.mode, { value: 'explicit', source: 'user_task' })
    assert.deepEqual(commit.effective.explicit_runtime, {
      value: resolveTriple(PROFILES[2]!),
      source: 'user_task',
    })

    // Editing a different field migrates the selection into tasks.settings but
    // never rewrites the legacy agentRuntime map.
    await service.save({
      scope: 'task',
      task_id: 'commit',
      expected_revision: before.revision,
      patch: { timeout_ms: 777_000 },
    })

    const onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    assert.deepEqual(tasks.agentRuntime, { commit: 'forge/codex-sol' })
    assert.deepEqual(byTask['builtin:commit'], {
      selectionMode: 'explicit',
      agentRuntime: 'forge/codex-sol',
      timeoutMs: 777_000,
    })
    assert.equal(tempResidue().length, 0)
  })

  it('prompt customization is a plain additional_instructions field; the builtin template stays read-only', async () => {
    writeConfig({})
    const service = context!.makeService()
    const before = await service.snapshot({})

    const after = await service.save({
      scope: 'task',
      task_id: 'review',
      expected_revision: before.revision,
      patch: { additional_instructions: 'always cite line numbers' },
    })

    const review = after.rows.find((row) => row.identity === 'builtin:review')
    assert.ok(review)
    assert.equal(review.builtin.prompt_template, 'dynamic')
    assert.deepEqual(review.builtin, {
      ...review.builtin,
      prompt_template: 'dynamic',
      source: 'workspace',
      description: 'Code review',
      identity: 'builtin:review',
      name: 'review',
      declared_runtime: 'forge/codex-sol',
      timeout_ms: 180_000,
      dispatch: { max_output_usd_per_million: 15 },
    })
    assert.equal(review.effective.additional_instructions.value, 'always cite line numbers')

    const onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    // Only the editable plain-instruction override is stored for the builtin.
    assert.deepEqual(byTask['builtin:review'], { additionalInstructions: 'always cite line numbers' })
  })

  it('task existence is required before any task-scope save', async () => {
    writeConfig({})
    const service = context!.makeService()
    const before = await service.snapshot({})

    await assert.rejects(
      service.save({
        scope: 'task',
        task_id: 'does-not-exist',
        expected_revision: before.revision,
        patch: { additional_instructions: 'x' },
      }),
      (error) => error instanceof TaskSettingsTaskNotFoundError,
    )
    assert.deepEqual(readConfig(), {})
    assert.equal(tempResidue().length, 0)
  })

  it('a malformed explicit runtime triple is rejected as invalid settings', async () => {
    writeConfig({})
    const service = context!.makeService()
    const before = await service.snapshot({})

    await assert.rejects(
      service.save({
        scope: 'task',
        task_id: 'commit',
        expected_revision: before.revision,
        patch: {
          mode: 'explicit',
          explicit_runtime: { client: 'nope', provider: 'nope', model: 'nope' },
        },
      }),
      (error) => error instanceof Error && error.message.includes('invalid task settings'),
    )
    assert.deepEqual(readConfig(), {})
    assert.equal(tempResidue().length, 0)
  })

  it('exact runtime identity mapping is stable across triple and id forms', () => {
    for (const profile of PROFILES) {
      const triple = resolveTriple(profile)
      const id = exactRuntimeIdForTriple(triple)
      assert.equal(id, profile.exactAgentRuntime)
    }
    assert.equal(
      exactRuntimeIdForTriple({ client: 'x', provider: 'y', model: 'z' }),
      null,
    )
  })

  it('resolveForRun merges five layers right-wins including invocation and never persists it', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            agentRuntime: 'forge/codex-luna',
            timeoutMs: 900_000,
            additionalInstructions: 'global note',
          },
          byTask: {
            'builtin:commit': {
              selectionMode: 'explicit',
              agentRuntime: 'forge/codex-sol',
              timeoutMs: 700_000,
            },
          },
        },
      },
    })
    const service = context!.makeService()
    const resolution = await service.resolveForRun({
      taskName: 'commit',
      kind: 'builtin',
      defaults: { agentRuntime: 'forge/codex-sol', timeoutMs: 200_000 },
      invocation: {
        mode: 'automatic',
        timeout_ms: 111_000,
        additional_instructions: 'invocation note',
        automatic: { expected_tps: 250 },
      },
    })
    // Invocation is the top layer: its automatic mode, timeout, additional
    // instructions and automatic dispatch field each win right-wins.
    assert.equal(resolution.mode, 'automatic')
    assert.equal(resolution.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.equal(resolution.timeoutMs, 111_000)
    assert.equal(resolution.additionalInstructions, 'invocation note')
    assert.equal(resolution.sources.selectionMode, 'invocation')
    assert.equal(resolution.sources.timeoutMs, 'invocation')
    assert.equal(resolution.sources.additionalInstructions, 'invocation')
    assert.deepEqual(resolution.sources.automatic.expected_tps, 'invocation')
    // The inherited exact runtime pin is dropped in automatic mode.
    assert.equal(resolution.sources.agentRuntime, 'system')
    assert.ok(resolution.dispatch)
    assert.equal(resolution.dispatch.profile, PROFILES[0]!.profile)
    assert.equal(resolution.dispatch.model, PROFILES[0]!.model)

    // The invocation layer is never written to the authoritative config.
    const onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    assert.deepEqual(settings.byTask, {
      'builtin:commit': { selectionMode: 'explicit', agentRuntime: 'forge/codex-sol', timeoutMs: 700_000 },
    })
    assert.equal((settings as { invocation?: unknown }).invocation, undefined)
  })

  it('resolveForRun converts an invocation explicit_runtime triple to the one exact runtime id', async () => {
    writeConfig({
      tasks: { settings: { global: { selectionMode: 'explicit', agentRuntime: 'forge/codex-luna' } } },
    })
    const service = context!.makeService()
    const resolution = await service.resolveForRun({
      taskName: 'commit',
      kind: 'builtin',
      defaults: { agentRuntime: 'forge/codex-sol' },
      invocation: { mode: 'explicit', explicit_runtime: resolveTriple(PROFILES[0]!) },
    })
    assert.equal(resolution.mode, 'explicit')
    assert.equal(resolution.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.equal(resolution.sources.agentRuntime, 'invocation')
    assert.ok(resolution.dispatch)
    assert.equal(resolution.dispatch.client, PROFILES[0]!.client)
    // Config unchanged: triple conversion never persisted an agentRuntime id.
    assert.deepEqual(readConfig(), {
      tasks: { settings: { global: { selectionMode: 'explicit', agentRuntime: 'forge/codex-luna' } } },
    })
  })

  it('resolveForRun automatic mode ignores a stale inherited exact runtime pin', async () => {
    // 'unavailable' declares an exact runtime the resolver blocks, but
    // user-global automatic mode must ignore that stale pin and resolve.
    writeConfig({ tasks: { settings: { global: { selectionMode: 'automatic' } } } })
    const service = context!.makeService()
    const resolution = await service.resolveForRun({
      taskName: 'unavailable',
      kind: 'builtin',
      defaults: { agentRuntime: 'forge/codex-sol' },
    })
    assert.equal(resolution.mode, 'automatic')
    assert.equal(resolution.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.equal(resolution.timeoutMs, 900_000)
  })

  it('resolveForRun explicit mode fails without automatic fallback when the exact runtime is unavailable', async () => {
    writeConfig({})
    const service = context!.makeService()
    await assert.rejects(
      service.resolveForRun({
        taskName: 'unavailable',
        kind: 'builtin',
        defaults: { agentRuntime: 'forge/codex-sol' },
      }),
      (error) => error instanceof ExplicitRuntimeUnavailableError,
    )
    assert.deepEqual(readConfig(), {})
  })

  it('resolveForRun explicit mode fails when the live provider credential is unavailable', async () => {
    writeConfig({})
    const service = context!.makeService({
      runtimeAvailability: () => ({
        providerCredential: 'missing',
        providerLive: 'unknown',
        quota: 'unknown',
        available: false,
      }),
    })
    await assert.rejects(
      service.resolveForRun({
        taskName: 'review',
        kind: 'builtin',
        defaults: { agentRuntime: 'forge/codex-sol' },
      }),
      (error) => error instanceof TaskSettingsRuntimeUnavailableError,
    )
    assert.deepEqual(readConfig(), {})
  })

  it('resolveForRun reads legacy builtin agentRuntime pins when no per-task entry exists and never writes them', async () => {
    writeConfig({ tasks: { agentRuntime: { commit: 'forge/codex-sol' } } })
    const service = context!.makeService()
    const resolution = await service.resolveForRun({
      taskName: 'commit',
      kind: 'builtin',
      defaults: { agentRuntime: 'forge/cb-dsf' },
    })
    assert.equal(resolution.mode, 'explicit')
    assert.equal(resolution.exactAgentRuntime, 'forge/codex-sol')
    assert.equal(resolution.sources.agentRuntime, 'user_task')
    assert.deepEqual(readConfig(), { tasks: { agentRuntime: { commit: 'forge/codex-sol' } } })
  })

  it('resolveForRun isolates stable per-task settings by project identity and reports effective timeout and instructions', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { timeoutMs: 60_000 },
          byTask: {
            'project:alpha:review': { timeoutMs: 222_000, additionalInstructions: 'alpha review terse' },
          },
        },
      },
    })
    const service = context!.makeService()
    const alpha = await service.resolveForRun({
      taskName: 'review',
      kind: 'project',
      project: 'alpha',
      defaults: { agentRuntime: 'forge/codex-sol' },
    })
    assert.equal(alpha.timeoutMs, 222_000)
    assert.equal(alpha.additionalInstructions, 'alpha review terse')
    assert.equal(alpha.sources.timeoutMs, 'user_task')
    assert.equal(alpha.sources.additionalInstructions, 'user_task')

    // 'beta' shares the name but not the stable identity: no alpha settings leak.
    const beta = await service.resolveForRun({
      taskName: 'review',
      kind: 'project',
      project: 'beta',
      defaults: { agentRuntime: 'forge/codex-sol' },
    })
    assert.equal(beta.timeoutMs, 60_000)
    assert.equal(beta.additionalInstructions, undefined)
    assert.equal(beta.sources.timeoutMs, 'user_global')
    assert.equal(beta.sources.additionalInstructions, 'system')
  })

  it('resolveForRun automatic mode runs the live availability callback once against the selected runtime', async () => {
    writeConfig({ tasks: { settings: { global: { selectionMode: 'automatic' } } } })
    const seen: Array<{ client: string; provider: string; model: string }> = []
    const daemonCalls: number[] = []
    const service = context!.makeService({
      daemonAvailability: () => {
        daemonCalls.push(1)
        return { accepting: true, known: true }
      },
      runtimeAvailability: (runtime) => {
        seen.push(runtime)
        return {
          providerCredential: 'available',
          providerLive: 'unknown',
          quota: 'unknown',
          available: true,
        }
      },
    })
    const resolution = await service.resolveForRun({
      taskName: 'unavailable',
      kind: 'builtin',
      defaults: { agentRuntime: 'forge/codex-sol' },
    })
    assert.equal(resolution.mode, 'automatic')
    assert.equal(resolution.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    // Live readiness is probed exactly once against the resolver-selected
    // client/provider/model; unknown quota does not block the run.
    assert.equal(daemonCalls.length, 1)
    assert.deepEqual(seen, [resolveTriple(PROFILES[0]!)])
  })

  it('resolveForRun automatic mode fails on live unavailability with no second resolver call or alternate selection', async () => {
    writeConfig({ tasks: { settings: { global: { selectionMode: 'automatic' } } } })
    const resolver = createResolverFixture()
    const counts = { resolve: 0, resolveExplicit: 0 }
    const service = context!.makeService({
      resolver: {
        ...resolver,
        resolve(input) {
          counts.resolve += 1
          return resolver.resolve(input)
        },
        resolveExplicit(input) {
          counts.resolveExplicit += 1
          return resolver.resolveExplicit(input)
        },
      },
      runtimeAvailability: () => ({
        providerCredential: 'missing',
        providerLive: 'unknown',
        quota: 'unknown',
        available: false,
      }),
    })
    await assert.rejects(
      service.resolveForRun({
        taskName: 'unavailable',
        kind: 'builtin',
        defaults: { agentRuntime: 'forge/codex-sol' },
      }),
      (error) => error instanceof TaskSettingsRuntimeUnavailableError,
    )
    // Exactly one automatic resolver call picked the runtime, the live check
    // failed it, and no fallback or alternate selection was attempted.
    assert.equal(counts.resolve, 1)
    assert.equal(counts.resolveExplicit, 0)
    assert.deepEqual(readConfig(), {
      tasks: { settings: { global: { selectionMode: 'automatic' } } },
    })
  })

  it('unscoped snapshot lists builtins once plus exact project tasks and never duplicates inherited builtins', async () => {
    writeConfig({})
    const groups: ProjectFixtureGroup[] = [
      {
        id: 'alpha',
        displayName: 'Alpha 平台',
        defs: [
          { name: 'commit', displayName: 'Alpha commit task', agentRuntime: 'forge/fast', timeoutMs: 45_000 },
          { name: 'alpha-only', displayName: 'Alpha only task', agentRuntime: 'forge/fast', timeoutMs: 30_000 },
        ],
      },
      {
        id: 'beta',
        defs: [{ name: 'commit', displayName: 'Beta commit task', agentRuntime: 'forge/fast', timeoutMs: 55_000 }],
      },
    ]
    const service = context!.makeService({
      definitions: createGroupedDefinitionsFixture(groups),
    })
    const snapshot = await service.snapshot({})

    // Every builtin is listed exactly once, regardless of any project.
    for (const entry of BUILTIN_DEFS) {
      const matches = snapshot.rows.filter((row) => row.identity === `builtin:${entry.name}`)
      assert.equal(matches.length, 1, `expected exactly one builtin:${entry.name}`)
    }
    // Registered projects contribute exactly their own definitions.
    assert.deepEqual(
      snapshot.rows.filter((row) => row.identity.startsWith('project:alpha:')).map((row) => row.identity).sort(),
      ['project:alpha:alpha-only', 'project:alpha:commit'],
    )
    assert.deepEqual(
      snapshot.rows.filter((row) => row.identity.startsWith('project:beta:')).map((row) => row.identity),
      ['project:beta:commit'],
    )
    // Inherited builtins are never duplicated under a project: auto-fail and
    // unavailable exist only as builtin identities.
    assert.equal(snapshot.rows.some((row) => row.identity === 'project:alpha:auto-fail'), false)
    assert.equal(snapshot.rows.some((row) => row.identity === 'project:alpha:unavailable'), false)
    assert.equal(snapshot.rows.some((row) => row.identity === 'project:alpha:review'), false)
    // Deduplicated stable identities across the whole snapshot.
    const identities = snapshot.rows.map((row) => row.identity)
    assert.equal(new Set(identities).size, identities.length)
  })

  it('labels use authoritative display values then exact name/id fallbacks', async () => {
    writeConfig({})
    const groups: ProjectFixtureGroup[] = [
      {
        id: 'alpha',
        displayName: 'Alpha 平台',
        defs: [{ name: 'commit', displayName: 'Alpha commit task', agentRuntime: 'forge/fast' }],
      },
      { id: 'beta', defs: [{ name: 'commit', displayName: 'Beta commit task', agentRuntime: 'forge/fast' }] },
    ]
    const service = context!.makeService({
      definitions: createGroupedDefinitionsFixture(groups),
    })
    const snapshot = await service.snapshot({})

    const builtinCommit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(builtinCommit)
    assert.equal(builtinCommit.name, 'commit')
    assert.equal(builtinCommit.display_name, 'Commit helper')
    assert.equal('project_display_name' in builtinCommit, false)

    // auto-fail declares no displayName: exact task name fallback.
    const builtinAutoFail = snapshot.rows.find((row) => row.identity === 'builtin:auto-fail')
    assert.ok(builtinAutoFail)
    assert.equal(builtinAutoFail.display_name, 'auto-fail')

    // alpha is registered with a `.fmproj` display label; beta is not.
    const alphaCommit = snapshot.rows.find((row) => row.identity === 'project:alpha:commit')
    assert.ok(alphaCommit)
    assert.equal(alphaCommit.display_name, 'Alpha commit task')
    assert.equal(alphaCommit.project_display_name, 'Alpha 平台')
    assert.equal(alphaCommit.project, 'alpha')

    const betaCommit = snapshot.rows.find((row) => row.identity === 'project:beta:commit')
    assert.ok(betaCommit)
    assert.equal(betaCommit.display_name, 'Beta commit task')
    // No authoritative project display label: exact project id fallback.
    assert.equal(betaCommit.project_display_name, 'beta')
  })

  it('unscoped and scoped snapshots preserve stable per-project save scopes', async () => {
    writeConfig({})
    const groups: ProjectFixtureGroup[] = [
      {
        id: 'alpha',
        displayName: 'Alpha 平台',
        defs: [{ name: 'commit', agentRuntime: 'forge/fast' }, { name: 'alpha-only', agentRuntime: 'forge/fast' }],
      },
      { id: 'beta', defs: [{ name: 'commit', agentRuntime: 'forge/fast' }] },
    ]
    const service = context!.makeService({
      definitions: createGroupedDefinitionsFixture(groups),
    })
    const before = await service.snapshot({ project: 'alpha' })
    assert.equal(before.rows.some((row) => row.identity === 'project:alpha:commit'), true)

    await service.save({
      scope: 'task',
      task_id: 'project:alpha:commit',
      project: 'alpha',
      expected_revision: before.revision,
      patch: { timeout_ms: 222_000 },
    })

    const onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    // The per-task override is keyed only under the exact alpha project
    // identity; the beta project sharing the name is untouched.
    assert.deepEqual(byTask, { 'project:alpha:commit': { timeoutMs: 222_000 } })
  })

  it('projects a safe instruction_template preserving static text/order without executing anything', async () => {
    writeConfig({})
    const executed: string[] = []
    const previewDef: DefEntry = {
      name: 'preview',
      agentRuntime: 'forge/fast',
      instructions: [
        'First static instruction.',
        () => {
          executed.push('second instruction executed')
          return 'dynamic function guidance'
        },
        'Second static instruction.',
      ],
    }
    const service = context!.makeService({
      definitions: {
        async list() {
          return [defToSummary(previewDef)]
        },
        async listProjects() {
          return []
        },
        async describe(taskId) {
          if (taskId !== 'preview') throw new Error(`task '${taskId}' not found`)
          return { ...defToSummary(previewDef), permission: 'readonly' }
        },
      },
      daemonAvailability: () => {
        throw new Error('daemon probe must not run for a preview')
      },
      runtimeAvailability: () => {
        throw new Error('runtime availability must not be probed for a preview')
      },
    })
    const snapshot = await service.snapshot({ task_id: 'builtin:preview' })

    const row = snapshot.rows.find((entry) => entry.identity === 'builtin:preview')
    assert.ok(row)
    assert.deepEqual(row.builtin.instruction_template, [
      { kind: 'text', source: 'task.instructions[0]', text: 'First static instruction.' },
      { kind: 'placeholder', source: 'task.instructions[1]', label: '运行时填入任务输入' },
      { kind: 'text', source: 'task.instructions[2]', text: 'Second static instruction.' },
      // One additional-instructions slot in buildTaskPrompt order: after every
      // TaskConfig instruction and before the input-dependent prompt body.
      { kind: 'additional_instructions', source: 'task.settings.additionalInstructions' },
      { kind: 'placeholder', source: 'task.prompt', label: '运行时根据任务输入生成任务提示' },
    ])
    // Static instructions kept their exact text and relative order, and the
    // function instruction was never invoked.
    assert.deepEqual(executed, [])
    // Labels fall back to the exact task name when none is declared.
    assert.equal(row.display_name, 'preview')
  })
})
