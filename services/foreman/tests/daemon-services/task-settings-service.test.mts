import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  ExplicitRuntimeUnavailableError,
  NoEligiblePlanError,
  type TaskDispatchDisplayLabels,
  type TaskDispatchResolver,
} from '../../lib/core/task/dispatch-resolver.mts'
import type { TaskResolvedDispatch } from '../../lib/task-run-metadata-types.mts'
import {
  TaskSettingsContentConflictError,
  TaskSettingsInvalidSettingsError,
  TaskSettingsRuntimeUnavailableError,
  TaskSettingsService,
  TaskSettingsTaskNotFoundError,
  taskInstructionTemplate,
  type TaskSettingsDaemonAvailabilityCallback,
  type TaskSettingsDefinitionSource,
  type TaskSettingsRuntimeAvailabilityCallback,
} from '../../lib/daemon/services/task-settings-service.mts'
import {
  AliasNotFoundError,
  RuntimeAliasService,
} from '../../lib/daemon/services/runtime-alias-service.mts'
import RuntimeAliasStore from '../../lib/runtime-aliases/store.mts'
import {
  AutoRoutingQuotaSnapshotService,
  type CodeBuddyActiveSnapshotView,
} from '../../lib/daemon/services/auto-routing-snapshot-service.mts'

const CATALOG_CHECKED_AT = '2026-09-05'
const QUOTA_T0 = 1_726_000_000_000

interface ProfileFixture {
  /** Canonical `provider/model:client` run target. */
  exactAgentRuntime: string
  profile: string
  client: string
  provider: string
  model: string
  intelligence: string
  tps: number
  inputUsd: number
  outputUsd: number
  mode?: 'native' | 'gateway'
}

const PROFILES: ProfileFixture[] = [
  {
    exactAgentRuntime: 'codex/gpt-5.6-luna:codex',
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
    exactAgentRuntime: 'codex/gpt-6.0-nova:codex',
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
    exactAgentRuntime: 'claude/claude-opus-4:cc',
    profile: 'codex-sol',
    client: 'cc',
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
    mode: profile.mode ?? 'native',
    ...(profile.mode === 'gateway' ? { protocol: 'openai_chat' as const } : {}),
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

function runtimeTriple(profile: ProfileFixture): { client: string; provider: string; model: string } {
  return { client: profile.client, provider: profile.provider, model: profile.model }
}

/** Deterministic fixture Catalog display labels for a resolved canonical
 *  provider/model pair, mirroring the production Catalog projection: the
 *  provider must be a registered fixture profile or no label exists. Pure and
 *  read-only — it never admits, ranks, probes, falls back, or recurses back
 *  into the resolver, so it cannot introduce a resolution loop. */
function catalogDisplayLabels(provider: string, model: string): TaskDispatchDisplayLabels {
  const title = (id: string): string =>
    id
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  return {
    provider,
    providerDisplayName: title(provider),
    model,
    modelDisplayName: title(model),
  }
}

interface ResolverFixtureOptions {
  /** exact runtimes intentionally unavailable per task name. */
  unavailable?: Record<string, string>
  /** tasks whose automatic `resolve` must fail deterministically. */
  autoFailTasks?: string[]
  /** Candidate pool (defaults to the base PROFILES). */
  profiles?: ProfileFixture[]
}

function createResolverFixture(options: ResolverFixtureOptions = {}): TaskDispatchResolver {
  const unavailable = options.unavailable ?? {}
  const autoFailTasks = options.autoFailTasks ?? []
  const pool = options.profiles ?? PROFILES
  const blocked = (taskName: string, exactAgentRuntime: string): boolean =>
    unavailable[taskName] === exactAgentRuntime
  return {
    resolve(input) {
      if (autoFailTasks.includes(input.taskName)) {
        return { ok: false as const, error: new NoEligiblePlanError(input.taskName, [], input.requirements) }
      }
      const profile = pool[0]!
      return { ok: true as const, exactAgentRuntime: profile.exactAgentRuntime, resolved: resolvedChoice(profile) }
    },
    eligible(input) {
      if (autoFailTasks.includes(input.taskName)) {
        return { ok: false as const, error: new NoEligiblePlanError(input.taskName, [], input.requirements) }
      }
      const choices = pool
        .filter((profile) => !blocked(input.taskName, profile.exactAgentRuntime))
        .map((profile) => ({ ...resolvedChoice(profile), exactAgentRuntime: profile.exactAgentRuntime }))
      return { ok: true as const, choices }
    },
    resolveExplicit(input) {
      const profile = pool.find((p) => p.exactAgentRuntime === input.exactRuntime)
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
        items: pool.map((profile) => {
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
    displayLabels(input) {
      const known = pool.some(
        (profile) => profile.provider === input.provider && profile.model === input.model,
      )
      return known ? catalogDisplayLabels(input.provider, input.model) : undefined
    },
  }
}

interface DefEntry {
  name: string
  displayName?: string
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
    dispatch: { expectedTps: 80, minimumTps: 60 },
    timeoutMs: 120_000,
    description: 'Commit message helper',
    source: 'workspace',
  },
  {
    name: 'review',
    dispatch: { maxOutputUsdPerMillion: 15 },
    timeoutMs: 180_000,
    description: 'Code review',
    source: 'workspace',
  },
  {
    name: 'auto-fail',
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

interface TestContext {
  dir: string
  configPath: string
  aliasService: RuntimeAliasService
  makeService: (overrides?: Partial<ConstructorParameters<typeof TaskSettingsService>[0]>) => TaskSettingsService
}

const defaultDaemonAvailability: TaskSettingsDaemonAvailabilityCallback = () => ({ accepting: true, known: true })
const defaultRuntimeAvailability: TaskSettingsRuntimeAvailabilityCallback = () => ({
  providerCredential: 'available',
  providerLive: 'unknown',
  quota: 'unknown',
  available: true,
})

/** All-unknown immutable quota snapshot service (empty raw report). */
function unknownQuotaSnapshotService(now: () => number = () => Date.now()): AutoRoutingQuotaSnapshotService {
  return new AutoRoutingQuotaSnapshotService({
    queryJson: () => Promise.resolve('[]'),
    now,
  })
}

/** CodeBuddy native cb profile plus a same-model grok gateway variant, used by
 *  client-collapse / confirmed-free focused tests in isolation. */
const CODEBUDDY_NATIVE_PROFILE: ProfileFixture = {
  exactAgentRuntime: 'codebuddy/deepseek-v4-flash:cb',
  profile: 'codebuddy-native',
  client: 'cb',
  provider: 'codebuddy',
  model: 'deepseek-v4-flash',
  intelligence: 'high',
  tps: 90,
  inputUsd: 0.2,
  outputUsd: 0.6,
}

const DEEPSEEK_FLASH_PRICING_PROFILE: ProfileFixture = {
  exactAgentRuntime: 'codebuddy/deepseek-v4-flash:cb',
  profile: 'codebuddy-deepseek-flash',
  client: 'cb',
  provider: 'codebuddy',
  model: 'deepseek-v4-flash',
  intelligence: 'high',
  tps: 91,
  inputUsd: 0.44,
  outputUsd: 1.32,
}

const DEEPSEEK_GLM_PRICE_PEER: ProfileFixture = {
  exactAgentRuntime: 'zhipu-coding/glm-price-peer:cb',
  profile: 'zhipu-glm-price-peer',
  client: 'cb',
  provider: 'zhipu-coding',
  model: 'glm-price-peer',
  intelligence: 'high',
  tps: 47.4,
  inputUsd: 0.2,
  outputUsd: 0.5,
}

const CODEBUDDY_GROK_PROFILE: ProfileFixture = {
  exactAgentRuntime: 'codebuddy/deepseek-v4-flash:gk',
  profile: 'codebuddy-grok',
  client: 'gk',
  provider: 'codebuddy',
  model: 'deepseek-v4-flash',
  intelligence: 'high',
  tps: 90,
  inputUsd: 0.2,
  outputUsd: 0.6,
  mode: 'gateway',
}

/** A different, more expensive canonical model used to prove distinct models
 *  never collapse with the codebuddy/deepseek-v4-flash variants above. */
const CODEBUDDY_MINIMAX_PROFILE: ProfileFixture = {
  exactAgentRuntime: 'codebuddy/minimax-m3:cb',
  profile: 'codebuddy-minimax',
  client: 'cb',
  provider: 'codebuddy',
  model: 'minimax-m3',
  intelligence: 'mid',
  tps: 60,
  inputUsd: 0.8,
  outputUsd: 2.4,
}

const CODEBUDDY_HY3_PROFILE: ProfileFixture = {
  exactAgentRuntime: 'codebuddy/hy3:cb',
  profile: 'codebuddy-hy3',
  client: 'cb',
  provider: 'codebuddy',
  model: 'hy3',
  intelligence: 'high',
  tps: 90,
  inputUsd: 0.2,
  outputUsd: 0.6,
}

const CODEX_QUOTA_PROFILE: ProfileFixture = {
  exactAgentRuntime: 'codex/gpt-5.6-terra:codex',
  profile: 'codex-terra-quota',
  client: 'codex',
  provider: 'codex',
  model: 'gpt-5.6-terra',
  intelligence: 'high',
  tps: 90,
  inputUsd: 1,
  outputUsd: 4,
}

/** Healthy Zhipu GLM-5.3-Flash candidate used to prove quota-tier ranking. Its
 *  CodeBuddy twin below carries the same canonical model (glm-5.3-flash) with
 *  equal truthful speed/intelligence/reference price, so the quota snapshot is
 *  the only deciding factor. */
const ZHIPU_GLM_FLASH_PROFILE: ProfileFixture = {
  exactAgentRuntime: 'zhipu-coding/glm-5.3-flash:cb',
  profile: 'zhipu-coding-glm-flash',
  client: 'cb',
  provider: 'zhipu-coding',
  model: 'glm-5.3-flash',
  intelligence: 'high',
  tps: 90,
  inputUsd: 0.5,
  outputUsd: 1.5,
}

/** Non-confirmed-free CodeBuddy twin of ZHIPU_GLM_FLASH_PROFILE: probes
 *  available with no free supply and has no applicable quota binding for this
 *  model, so it stays a standard unknown rather than free. */
const CODEBUDDY_GLM_FLASH_PROFILE: ProfileFixture = {
  exactAgentRuntime: 'codebuddy/glm-5.3-flash:cb',
  profile: 'codebuddy-glm-flash',
  client: 'cb',
  provider: 'codebuddy',
  model: 'glm-5.3-flash',
  intelligence: 'high',
  tps: 90,
  inputUsd: 0.5,
  outputUsd: 1.5,
}

/** Quota report carrying the privacy-safe CodeBuddy exhaustion block. */
function codebuddyExhaustionQuotaSnapshotService(): AutoRoutingQuotaSnapshotService {
  const resetsAt = new Date(Date.now() + 86_400_000).toISOString()
  return new AutoRoutingQuotaSnapshotService({
    queryJson: () =>
      Promise.resolve(
        JSON.stringify([
          {
            pool: 'codebuddy',
            status: 'ok',
            stale: false,
            windows: [{ name: 'observed', pct: 100, resets_at: resetsAt }],
          },
        ]),
      ),
    codeBuddySnapshot: () => Promise.resolve({
      stableScope: 'cbv1:task-settings-test',
      environment: 'ioa',
      resolveUpstreamModel: (model: string) => model,
      freeSupply: () => undefined,
    }),
  })
}

/** Quota report carrying the current live healthy Zhipu windows, matching the
 *  non-secret snapshot read at 2026-09-09 13:54:53 +08:00: zhipu-coding 5h
 *  rolling_partial at pct 1 (99% remaining, resets 2026-09-09T18:40:14.978
 *  +08:00) and 7d full_cycle at pct 35 (65% remaining, resets 2026-09-13T10:
 *  01:01.998 +08:00), status ok / stale false. fetched_at is pinned to that
 *  same read instant so the raw row clears the service freshness gate. */
function healthyZhipuQuotaSnapshotService(): AutoRoutingQuotaSnapshotService {
  const snapshotAtMs = Date.parse('2026-09-09T13:54:53.000+08:00')
  return new AutoRoutingQuotaSnapshotService({
    queryJson: () =>
      Promise.resolve(
        JSON.stringify([
          {
            pool: 'zhipu-coding',
            status: 'ok',
            stale: false,
            fetched_at: '2026-09-09T13:54:53.000+08:00',
            windows: [
              { name: '5h', pct: 1, resets_at: '2026-09-09T18:40:14.978+08:00', window_minutes: 300 },
              { name: '7d', pct: 35, resets_at: '2026-09-13T10:01:01.998+08:00', window_minutes: 10_080 },
            ],
          },
        ]),
      ),
    now: () => snapshotAtMs,
  })
}

function codexQuotaSnapshotService(
  windows: Array<{ name: string; pct: number; resets_at: string; window_minutes: number }>,
  row: { status?: string; stale?: boolean } = {},
): AutoRoutingQuotaSnapshotService {
  return new AutoRoutingQuotaSnapshotService({
    queryJson: () => Promise.resolve(JSON.stringify([{
      pool: 'codex',
      status: row.status ?? 'ok',
      stale: row.stale ?? false,
      fetched_at: new Date(QUOTA_T0).toISOString(),
      windows,
    }])),
    now: () => QUOTA_T0,
  })
}

/** One automatic-preview failure issue (structural type, no protocol import). */
type AutomaticUnavailableIssue = {
  code: string
  message: string
  resolutionFailure?: { code: string; message: string }
}

/** Every automatic failure issue is one closed deterministic failure: the
 *  exact resolutionFailure code plus its safe Chinese message, no raw resolver
 *  copy, and no identity/price/TPS/secret leakage. */
function assertClosedAutoIssue(issue: AutomaticUnavailableIssue | undefined): void {
  assert.ok(issue)
  assert.equal(issue.code, 'automatic_dispatch_unavailable')
  const failure = issue.resolutionFailure
  assert.ok(failure)
  assert.equal(issue.message, failure.message)
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'message'])
  const serialized = JSON.stringify(issue)
  assert.ok(!serialized.includes('no eligible dispatch plan'))
  assert.ok(!serialized.includes('auto-fail'))
  assert.ok(!serialized.includes('codex'))
  assert.ok(!serialized.includes('claude'))
  assert.ok(!serialized.includes('gpt-'))
  assert.ok(!serialized.includes('codebuddy'))
  assert.ok(!serialized.includes('-ioa'))
  assert.ok(!serialized.includes('authorization'))
  assert.ok(!serialized.includes('secret'))
  assert.ok(!serialized.includes('token'))
  assert.ok(!/\d/.test(serialized))
}

/** Snapshots the single automatic row for `identity` and returns its closed
 *  automatic_dispatch_unavailable issue (undefined when the row selected). */
async function automaticUnavailableIssueOf(
  service: TaskSettingsService,
  identity: string,
): Promise<AutomaticUnavailableIssue | undefined> {
  const snapshot = await service.snapshot({ task_id: identity })
  const row = snapshot.rows.find((entry) => entry.identity === identity)
  assert.ok(row)
  return row.issues.find((entry) => entry.code === 'automatic_dispatch_unavailable')
}

describe('daemon task-settings-service (no-model)', () => {
  let context: TestContext | undefined

  const seedAlias = async (name: string, target: string): Promise<void> => {
    const { revision } = await context!.aliasService.snapshot()
    await context!.aliasService.put({ name, target, expected_revision: revision })
  }

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-task-settings-'))
    const configPath = join(dir, 'config.json')
    const aliasService = new RuntimeAliasService(new RuntimeAliasStore({ configRoot: join(dir, 'alias-store') }))
    context = {
      dir,
      configPath,
      aliasService,
      makeService: (overrides = {}) =>
        new TaskSettingsService({
          workspaceRoot: dir,
          configPath,
          resolver: createResolverFixture({
            unavailable: {},
            autoFailTasks: ['auto-fail'],
          }),
          aliases: aliasService,
          definitions: createDefinitionsFixture(),
          daemonAvailability: defaultDaemonAvailability,
          runtimeAvailability: defaultRuntimeAvailability,
          quotaSnapshots: unknownQuotaSnapshotService(),
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
            // The retired legacy additional-instructions key stays as unrelated
            // raw config: never surfaced or effective, preserved on disk.
            'builtin:commit': { additionalInstructions: 'be terse', dispatch: { minimumTps: 90 } },
          },
        },
      },
    })
    const service = context!.makeService()
    const snapshot = await service.snapshot({})

    assert.equal(snapshot.config_path, context!.configPath)
    assert.equal(snapshot.revision.length > 0, true)
    assert.deepEqual(snapshot.aliases, [])
    // user-global layer surfaced as JSON-safe snake_case layer.
    assert.deepEqual(snapshot.user_global, {
      mode: 'automatic',
      timeout_ms: 900_000,
      automatic: { expected_tps: 100 },
    })

    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    // Builtin metadata is read-only: source/description, template marker, and
    // never a declared runtime.
    assert.equal(commit.builtin.name, 'commit')
    assert.equal(commit.builtin.source, 'workspace')
    assert.equal(commit.builtin.prompt_template, 'dynamic')
    assert.equal('declared_runtime' in commit.builtin, false)

    // Per-task persisted layer surfaces only supported fields (snake_case DTO).
    assert.deepEqual(commit.user_task, {
      automatic: { minimum_tps: 90 },
    })
    // The retired legacy key never surfaces in the per-task layer or the
    // effective row; it survives verbatim as unrelated raw config on disk.
    assert.equal(Object.hasOwn(commit.user_task, 'additional_instructions'), false)
    assert.equal(Object.hasOwn(commit.effective, 'additional_instructions'), false)
    const onDiskTasks = readConfig().tasks as { settings: { byTask: Record<string, unknown> } }
    const onDiskCommit = onDiskTasks.settings.byTask['builtin:commit'] as Record<string, unknown> | undefined
    assert.equal(onDiskCommit?.additionalInstructions, 'be terse')

    // Field-level right-wins precedence with the winning source reported.
    assert.deepEqual(commit.effective.mode, { value: 'automatic', source: 'user_global' })
    assert.deepEqual(commit.effective.timeout_ms, { value: 900_000, source: 'user_global' })
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
    // Definitions never pin a runtime; the builtin metadata exposes no runtime.
    assert.equal('declared_runtime' in review.builtin, false)
  })

  it('reset deletes only the current-layer field and cleans empty containers', async () => {
    writeConfig({
      top_level: { keep: true },
      tasks: {
        settings: {
          global: { timeoutMs: 800_000 },
          byTask: { 'builtin:commit': { timeoutMs: 123_456, dispatch: { minimumTps: 90 } } },
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
    // timeout_ms deleted at the per-task layer only; the sibling dispatch field survives.
    assert.deepEqual(commit.user_task, { automatic: { minimum_tps: 90 } })
    // Global timeout inherited again.
    assert.deepEqual(commit.effective.timeout_ms, { value: 800_000, source: 'user_global' })

    let onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    assert.deepEqual(byTask['builtin:commit'], { dispatch: { minimumTps: 90 } })
    assert.deepEqual(onDisk.top_level, { keep: true })
    assert.equal(tempResidue().length, 0)

    // Resetting the final field removes the byTask entry and empty containers.
    const secondBefore = await service.snapshot({})
    await service.save({
      scope: 'task',
      task_id: 'commit',
      expected_revision: secondBefore.revision,
      patch: { automatic: { minimum_tps: null } },
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
      patch: { timeout_ms: 333_000 },
    })

    assert.equal(after.rows.length, 1)
    assert.equal(after.rows[0]?.identity, 'builtin:commit')
    assert.deepEqual(after.rows[0]?.user_task, { timeout_ms: 333_000 })
    assert.deepEqual(
      (readConfig().tasks as { settings: { byTask: Record<string, unknown> } }).settings.byTask['builtin:commit'],
      { timeoutMs: 333_000 },
    )
  })

  it('save persists an explicit inline target reference under the stable identity', async () => {
    writeConfig({})
    const service = context!.makeService()
    const before = await service.snapshot({})

    const after = await service.save({
      scope: 'task',
      task_id: 'commit',
      expected_revision: before.revision,
      patch: {
        mode: 'explicit',
        explicit_runtime: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
      },
    })

    const commit = after.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.deepEqual(commit.effective.mode, { value: 'explicit', source: 'user_task' })
    assert.deepEqual(commit.effective.explicit_runtime, {
      value: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
      source: 'user_task',
    })
    const explicit = commit.explicit
    assert.ok(explicit)
    // The stored structural reference plus its exact canonical resolution.
    assert.deepEqual(explicit.reference, { kind: 'target', target: PROFILES[0]!.exactAgentRuntime })
    assert.equal(explicit.resolved_target, PROFILES[0]!.exactAgentRuntime)
    assert.equal(explicit.resolved?.model, PROFILES[0]!.model)
    assert.ok(explicit.readiness)
    assert.equal(explicit.readiness.available, true)

    const onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    assert.deepEqual(byTask['builtin:commit'], {
      selectionMode: 'explicit',
      explicitRuntime: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
    })
    assert.equal(tempResidue().length, 0)
  })

  it('save persists an alias reference and resolves it through the live alias service', async () => {
    writeConfig({})
    await seedAlias('primary', PROFILES[1]!.exactAgentRuntime)
    const service = context!.makeService()
    const before = await service.snapshot({})

    const after = await service.save({
      scope: 'task',
      task_id: 'commit',
      expected_revision: before.revision,
      patch: {
        mode: 'explicit',
        explicit_runtime: { kind: 'alias', name: 'primary' },
      },
    })

    const commit = after.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    const explicit = commit.explicit
    assert.ok(explicit)
    assert.deepEqual(explicit.reference, { kind: 'alias', name: 'primary' })
    assert.equal(explicit.resolved_target, PROFILES[1]!.exactAgentRuntime)
    assert.equal(explicit.resolved?.profile, PROFILES[1]!.profile)

    const onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    const byTask = settings.byTask as Record<string, unknown>
    assert.deepEqual(byTask['builtin:commit'], {
      selectionMode: 'explicit',
      explicitRuntime: { kind: 'alias', name: 'primary' },
    })
    assert.equal(tempResidue().length, 0)
  })

  it('rejects an explicit save referencing a missing alias and writes nothing', async () => {
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
          explicit_runtime: { kind: 'alias', name: 'does-not-exist' },
        },
      }),
      (error) => error instanceof AliasNotFoundError,
    )
    assert.deepEqual(readConfig(), {})
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
          explicit_runtime: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
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
          explicit_runtime: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
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
        patch: { timeout_ms: 400_000 },
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
      patch: { timeout_ms: 90_000 },
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
    // An automatic row carries no explicit row (no fabricated explicit state).
    assert.equal(commit.explicit, undefined)
    // The automatic preview projection pairs the canonical provider/model ids
    // with the fixture Catalog's deterministic provider/model display labels.
    const autoResolved = commit.automatic_selection?.resolved
    assert.ok(autoResolved)
    assert.equal(autoResolved.provider, 'codex')
    assert.equal(autoResolved.model, 'gpt-5.6-luna')
    assert.equal(autoResolved.provider_display_name, 'Codex')
    assert.equal(autoResolved.model_display_name, 'Gpt 5.6 Luna')

    // auto-fail resolves through the same automatic resolver path and stays as
    // a row with a structured unavailable issue (never dropped).
    const autoFail = snapshot.rows.find((row) => row.identity === 'builtin:auto-fail')
    assert.ok(autoFail)
    assert.equal(autoFail.effective.mode.value, 'automatic')
    const autoFailIssue = autoFail.issues.find((issue) => issue.code === 'automatic_dispatch_unavailable')
    assert.ok(autoFailIssue)
    assertClosedAutoIssue(autoFailIssue)
    // The unresolved automatic row surfaces one deterministic closed failure —
    // the eligible rejection defaults to exact no_available_provider with its
    // safe Chinese message, never the raw resolver English copy — and never
    // fabricates a selection or paired display labels.
    assert.deepEqual(autoFailIssue.resolutionFailure, {
      code: 'no_available_provider',
      message: '没有可用的服务商，请检查登录或凭据',
    })
    assert.equal(autoFail.automatic_selection, undefined)
    assert.equal(autoFail.explicit, undefined)
  })

  it('explicit rows resolve alias and inline references through resolveExplicit with no fallback', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'alias', name: 'primary' },
          },
        },
      },
    })
    await seedAlias('primary', PROFILES[1]!.exactAgentRuntime)
    const service = context!.makeService()
    const snapshot = await service.snapshot({})

    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.deepEqual(commit.effective.mode, { value: 'explicit', source: 'user_global' })
    assert.deepEqual(commit.effective.explicit_runtime, {
      value: { kind: 'alias', name: 'primary' },
      source: 'user_global',
    })
    const explicit = commit.explicit
    assert.ok(explicit)
    assert.deepEqual(explicit.reference, { kind: 'alias', name: 'primary' })
    assert.equal(explicit.resolved_target, PROFILES[1]!.exactAgentRuntime)
    assert.equal(explicit.resolved?.profile, PROFILES[1]!.profile)
    assert.equal(explicit.resolved?.model, PROFILES[1]!.model)
    assert.ok(explicit.readiness)
    assert.equal(explicit.readiness.runtime, PROFILES[1]!.exactAgentRuntime)
    assert.equal(explicit.readiness.daemon, 'accepting')
    assert.equal(explicit.readiness.available, true)
    // The resolved explicit projection pairs the canonical provider/model ids
    // with the fixture Catalog's deterministic provider/model display labels.
    assert.equal(explicit.resolved?.provider, 'codex')
    assert.equal(explicit.resolved?.model, 'gpt-6.0-nova')
    assert.equal(explicit.resolved?.provider_display_name, 'Codex')
    assert.equal(explicit.resolved?.model_display_name, 'Gpt 6.0 Nova')
    // No legacy runtime choice / resolved-runtime enumeration leaks.
    assert.equal('runtime_choices' in commit, false)
    assert.equal('resolved_runtime' in commit, false)
  })

  it('a missing alias keeps the structural explicit row unresolved with a structured issue', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'alias', name: 'gone' },
          },
        },
      },
    })
    const service = context!.makeService()
    const snapshot = await service.snapshot({})

    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.equal(commit.effective.mode.value, 'explicit')
    const explicit = commit.explicit
    assert.ok(explicit)
    // The stored structural reference survives; no resolution is fabricated and
    // no automatic mode is substituted.
    assert.deepEqual(explicit.reference, { kind: 'alias', name: 'gone' })
    assert.equal(explicit.resolved_target, null)
    assert.equal(explicit.resolved, null)
    assert.equal(explicit.readiness, null)
    assert.ok(commit.issues.some((issue) => issue.code === 'explicit_runtime_unavailable'))
  })

  it('an unavailable inline target fails preflight and runs without automatic fallback', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'target', target: PROFILES[2]!.exactAgentRuntime },
          },
        },
      },
    })
    const service = context!.makeService({
      resolver: createResolverFixture({
        unavailable: { commit: PROFILES[2]!.exactAgentRuntime },
      }),
    })
    const snapshot = await service.snapshot({})

    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.equal(commit.effective.mode.value, 'explicit')
    const explicit = commit.explicit
    assert.ok(explicit)
    assert.equal(explicit.resolved_target, null)
    assert.equal(explicit.resolved, null)
    assert.equal(explicit.readiness, null)
    assert.ok(commit.issues.some((issue) => issue.code === 'explicit_runtime_unavailable'))
    // The unresolved explicit row keeps the resolver's concrete reason and never
    // fabricates resolved metadata or paired display labels.
    const unavailableIssue = commit.issues.find((issue) => issue.code === 'explicit_runtime_unavailable')
    assert.ok(unavailableIssue)
    assert.match(unavailableIssue.message, /runtime is unavailable/)
    // Automatic mode was never used as a fallback.
    assert.equal(commit.effective.mode.value, 'explicit')

    await assert.rejects(
      service.resolveForRun({
        taskName: 'commit',
        kind: 'builtin',
        defaults: {},
      }),
      (error) => error instanceof ExplicitRuntimeUnavailableError,
    )
  })

  it('fresh alias update and deletion are observed by later snapshots and runs', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'alias', name: 'primary' },
          },
        },
      },
    })
    await seedAlias('primary', PROFILES[0]!.exactAgentRuntime)
    const service = context!.makeService()

    // First snapshot resolves the alias to its original target.
    let snapshot = await service.snapshot({ task_id: 'builtin:commit' })
    let commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.equal(commit.explicit?.resolved_target, PROFILES[0]!.exactAgentRuntime)

    // Re-point the alias; the next snapshot sees the fresh target with no cache.
    await seedAlias('primary', PROFILES[1]!.exactAgentRuntime)
    snapshot = await service.snapshot({ task_id: 'builtin:commit' })
    commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.equal(commit.explicit?.resolved_target, PROFILES[1]!.exactAgentRuntime)
    assert.equal(commit.explicit?.resolved?.profile, PROFILES[1]!.profile)

    // A run resolves the fresh alias target too.
    let resolution = await service.resolveForRun({ taskName: 'commit', kind: 'builtin', defaults: {} })
    assert.equal(resolution.mode, 'explicit')
    assert.equal(resolution.exactAgentRuntime, PROFILES[1]!.exactAgentRuntime)

    // Deleting the alias leaves the structural reference but nothing resolves.
    const { revision } = await context!.aliasService.snapshot()
    await context!.aliasService.remove({ name: 'primary', expected_revision: revision })
    snapshot = await service.snapshot({ task_id: 'builtin:commit' })
    commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    const explicit = commit.explicit
    assert.ok(explicit)
    assert.equal(explicit.resolved_target, null)
    assert.equal(explicit.resolved, null)
    assert.equal(explicit.readiness, null)
    assert.ok(commit.issues.some((issue) => issue.code === 'explicit_runtime_unavailable'))

    await assert.rejects(
      service.resolveForRun({ taskName: 'commit', kind: 'builtin', defaults: {} }),
      (error) => error instanceof AliasNotFoundError,
    )
  })

  it('snapshot returns the current live aliases for the explicit-mode picker', async () => {
    writeConfig({})
    await seedAlias('zed', PROFILES[0]!.exactAgentRuntime)
    await seedAlias('alpha', PROFILES[1]!.exactAgentRuntime)
    const service = context!.makeService()

    const snapshot = await service.snapshot({})
    assert.deepEqual(snapshot.aliases, [
      { name: 'alpha', target: PROFILES[1]!.exactAgentRuntime },
      { name: 'zed', target: PROFILES[0]!.exactAgentRuntime },
    ])

    // A save returns the same live alias surface.
    const before = await service.snapshot({})
    const after = await service.save({
      scope: 'global',
      expected_revision: before.revision,
      patch: { timeout_ms: 60_000 },
    })
    assert.deepEqual(after.aliases, snapshot.aliases)
  })

  it('automatic mode is independent from aliases', async () => {
    writeConfig({
      tasks: { settings: { global: { selectionMode: 'automatic', timeoutMs: 900_000 } } },
    })
    // The alias points at a runtime that is explicitly blocked for this task;
    // automatic selection must never consult it.
    await seedAlias('primary', PROFILES[2]!.exactAgentRuntime)
    const service = context!.makeService({
      resolver: createResolverFixture({
        unavailable: { commit: PROFILES[2]!.exactAgentRuntime },
      }),
    })

    const resolution = await service.resolveForRun({
      taskName: 'commit',
      kind: 'builtin',
      defaults: { dispatch: { expectedTps: 80 } },
    })
    assert.equal(resolution.mode, 'automatic')
    assert.equal(resolution.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.equal(resolution.timeoutMs, 900_000)
    assert.equal(resolution.sources.selectionMode, 'user_global')
    assert.equal(resolution.sources.timeoutMs, 'user_global')

    const snapshot = await service.snapshot({ task_id: 'builtin:commit' })
    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.equal(commit.effective.mode.value, 'automatic')
    assert.equal(commit.explicit, undefined)
  })

  it('resolveForRun merges five layers right-wins including invocation and never persists it', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'target', target: PROFILES[2]!.exactAgentRuntime },
            timeoutMs: 900_000,
          },
          byTask: {
            'builtin:commit': {
              selectionMode: 'explicit',
              explicitRuntime: { kind: 'target', target: PROFILES[2]!.exactAgentRuntime },
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
      defaults: { timeoutMs: 200_000, dispatch: { expectedTps: 100 } },
      invocation: {
        mode: 'automatic',
        timeout_ms: 111_000,
        automatic: { expected_tps: 250 },
      },
    })
    // Invocation is the top layer: automatic mode, timeout, and the automatic
    // dispatch field each win right-wins; the inherited explicit reference is
    // ignored in automatic mode.
    assert.equal(resolution.mode, 'automatic')
    assert.equal(resolution.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.equal(resolution.timeoutMs, 111_000)
    assert.equal(resolution.sources.selectionMode, 'invocation')
    assert.equal(resolution.sources.timeoutMs, 'invocation')
    assert.equal(resolution.sources.explicitRuntime, 'system')
    assert.deepEqual(resolution.sources.automatic.expected_tps, 'invocation')
    assert.ok(resolution.dispatch)
    assert.equal(resolution.dispatch.profile, PROFILES[0]!.profile)
    assert.equal(resolution.dispatch.model, PROFILES[0]!.model)

    // The invocation layer is never written to the authoritative config.
    const onDisk = readConfig()
    const tasks = onDisk.tasks as Record<string, unknown>
    const settings = tasks.settings as Record<string, unknown>
    assert.deepEqual(settings.byTask, {
      'builtin:commit': {
        selectionMode: 'explicit',
        explicitRuntime: { kind: 'target', target: PROFILES[2]!.exactAgentRuntime },
        timeoutMs: 700_000,
      },
    })
    assert.equal((settings as { invocation?: unknown }).invocation, undefined)
  })

  it('resolveForRun resolves an invocation alias reference freshly and never persists it', async () => {
    writeConfig({})
    await seedAlias('primary', PROFILES[0]!.exactAgentRuntime)
    const service = context!.makeService()
    const resolution = await service.resolveForRun({
      taskName: 'commit',
      kind: 'builtin',
      defaults: {},
      invocation: {
        mode: 'explicit',
        explicit_runtime: { kind: 'alias', name: 'primary' },
        timeout_ms: 42_000,
      },
    })
    assert.equal(resolution.mode, 'explicit')
    assert.equal(resolution.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    assert.equal(resolution.timeoutMs, 42_000)
    assert.equal(resolution.sources.explicitRuntime, 'invocation')
    assert.ok(resolution.dispatch)
    assert.equal(resolution.dispatch.client, PROFILES[0]!.client)
    // Config unchanged: the invocation alias was never persisted.
    assert.deepEqual(readConfig(), {})
  })

  it('resolveForRun explicit mode fails without fallback when the live provider credential is unavailable', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
          },
        },
      },
    })
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
        taskName: 'commit',
        kind: 'builtin',
        defaults: {},
      }),
      (error) => error instanceof TaskSettingsRuntimeUnavailableError,
    )
    assert.deepEqual(readConfig(), {
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
          },
        },
      },
    })
  })

  it('resolveForRun isolates stable per-task settings by project identity and reports the effective timeout', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { timeoutMs: 60_000 },
          byTask: {
            'project:alpha:review': { timeoutMs: 222_000 },
          },
        },
      },
    })
    const service = context!.makeService()
    const alpha = await service.resolveForRun({
      taskName: 'review',
      kind: 'project',
      project: 'alpha',
      defaults: { dispatch: { maxOutputUsdPerMillion: 15 } },
    })
    assert.equal(alpha.timeoutMs, 222_000)
    assert.equal(alpha.sources.timeoutMs, 'user_task')

    // 'beta' shares the name but not the stable identity: no alpha settings leak.
    const beta = await service.resolveForRun({
      taskName: 'review',
      kind: 'project',
      project: 'beta',
      defaults: { dispatch: { maxOutputUsdPerMillion: 15 } },
    })
    assert.equal(beta.timeoutMs, 60_000)
    assert.equal(beta.sources.timeoutMs, 'user_global')
  })

  it('automatic runs probe live availability once per exact choice before ranking and never again after selection', async () => {
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
      taskName: 'commit',
      kind: 'builtin',
      defaults: { dispatch: { expectedTps: 80 } },
    })
    assert.equal(resolution.mode, 'automatic')
    assert.equal(resolution.exactAgentRuntime, PROFILES[0]!.exactAgentRuntime)
    // Live readiness ran for EVERY exact choice before ranking (once each, no
    // second post-selection runtimeAvailability call); daemon admission is not
    // part of the automatic selection helper.
    assert.deepEqual(seen, PROFILES.map((profile) => runtimeTriple(profile)))
    assert.equal(daemonCalls.length, 0)
    // The resolved automatic dispatch carries the safe immutable decision.
    assert.ok(resolution.dispatch)
    const decision = resolution.dispatch!.auto_routing
    assert.ok(decision)
    assert.equal(decision!.selected_rank, 1)
    assert.equal(decision!.snapshot_id.length > 0, true)
    assert.ok(Array.isArray(decision!.reasons))
    // No secret/domain/upstream suffix leaks through the safe decision.
    const serialized = JSON.stringify(decision)
    assert.ok(!serialized.includes('native-codebuddy-token'))
    assert.ok(!serialized.includes('-ioa'))
    assert.ok(!serialized.includes('authorization'))
  })

  it('automatic selection collapses eligible client variants to the native model route before weighted ranking', async () => {
    writeConfig({ tasks: { settings: { global: { selectionMode: 'automatic' } } } })
    const pool = [CODEBUDDY_GROK_PROFILE, CODEBUDDY_MINIMAX_PROFILE, CODEBUDDY_NATIVE_PROFILE]
    const seen: Array<{ client: string; provider: string; model: string }> = []
    const service = context!.makeService({
      resolver: createResolverFixture({ profiles: pool }),
      quotaSnapshots: unknownQuotaSnapshotService(),
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
      taskName: 'commit',
      kind: 'builtin',
      defaults: { dispatch: { expectedTps: 80 } },
    })
    assert.deepEqual(seen, pool.map((profile) => runtimeTriple(profile)))
    assert.equal(resolution.exactAgentRuntime, CODEBUDDY_NATIVE_PROFILE.exactAgentRuntime)
    assert.equal(resolution.dispatch?.client, CODEBUDDY_NATIVE_PROFILE.client)
    assert.equal(resolution.dispatch?.mode, 'native')
  })

  it('automatic CodeBuddy run uses one request-bound active snapshot for quota, free supply, and wire mapping', async () => {
    writeConfig({ tasks: { settings: { global: { selectionMode: 'automatic' } } } })
    let loaderCalls = 0
    let active: CodeBuddyActiveSnapshotView = Object.freeze({
      stableScope: 'cbv1:account-a',
      environment: 'ioa',
      resolveUpstreamModel: (model: string) => `${model}-ioa`,
      freeSupply: (_model: string) => ({
        confirmedFree: true as const,
        source: 'codebuddy.credential_environment',
        ruleId: 'codebuddy.verified_hy_model_confirmed_free',
      }),
    })
    const contexts: unknown[] = []
    const quotaSnapshots = new AutoRoutingQuotaSnapshotService({
      codeBuddySnapshot: async () => {
        loaderCalls += 1
        return active
      },
      queryJson: (context) => {
        contexts.push(context)
        return Promise.resolve('[]')
      },
      now: () => QUOTA_T0,
    })
    const seenSnapshots: unknown[] = []
    const service = context!.makeService({
      resolver: createResolverFixture({ profiles: [CODEBUDDY_HY3_PROFILE] }),
      quotaSnapshots,
      runtimeAvailability: (runtime, availabilityContext) => {
        const snapshot = availabilityContext?.codeBuddySnapshot
        seenSnapshots.push(snapshot)
        if (!snapshot?.stableScope) {
          return { providerCredential: 'missing', providerLive: 'unknown', quota: 'unknown', available: false }
        }
        const expectedWireModel = snapshot.resolveUpstreamModel(runtime.model)
        return {
          providerCredential: 'available',
          providerLive: 'available',
          quota: 'unknown',
          available: true,
          ...(snapshot.freeSupply(runtime.model) ? { freeSupply: snapshot.freeSupply(runtime.model)! } : {}),
          codeBuddyExecution: {
            expectedScope: snapshot.stableScope,
            expectedEnvironment: snapshot.environment,
            expectedWireModel,
          },
        }
      },
    })

    const first = await service.resolveForRun({ taskName: 'commit', kind: 'builtin', defaults: {} })
    assert.equal(loaderCalls, 1, 'one automatic run must read the active login exactly once')
    assert.equal(seenSnapshots[0], active, 'readiness must receive the exact snapshot used by quota')
    assert.deepEqual(contexts, [{ expectedScope: 'cbv1:account-a', expectedEnvironment: 'ioa' }])
    assert.equal(first.dispatch?.auto_routing?.supply_class, 'confirmed_free')
    assert.deepEqual(first.codeBuddyExecution, {
      expectedScope: 'cbv1:account-a',
      expectedEnvironment: 'ioa',
      expectedWireModel: 'hy3-ioa',
    })
    // Only the private in-process carrier has the binding. Persisted/public
    // dispatch telemetry remains free of scope/environment/wire values.
    const serialized = JSON.stringify(first.dispatch)
    assert.ok(!serialized.includes('cbv1:account-a'))
    assert.ok(!serialized.includes('hy3-ioa'))

    active = Object.freeze({
      stableScope: 'cbv1:account-b',
      environment: 'external',
      resolveUpstreamModel: (model: string) => model,
      freeSupply: () => undefined,
    })
    const second = await service.resolveForRun({ taskName: 'commit', kind: 'builtin', defaults: {} })
    assert.equal(loaderCalls, 2)
    assert.equal(seenSnapshots[1], active)
    assert.deepEqual(contexts[1], { expectedScope: 'cbv1:account-b', expectedEnvironment: 'external' })
    assert.equal(second.dispatch?.auto_routing?.supply_class, 'standard')
    assert.deepEqual(second.codeBuddyExecution, {
      expectedScope: 'cbv1:account-b',
      expectedEnvironment: 'external',
      expectedWireModel: 'hy3',
    })
  })

  const runCodexQuota = async (
    windows: Array<{ name: string; pct: number; resets_at: string; window_minutes: number }>,
    row: { status?: string; stale?: boolean } = {},
  ) => {
    const service = context!.makeService({
      resolver: createResolverFixture({ profiles: [CODEX_QUOTA_PROFILE] }),
      quotaSnapshots: codexQuotaSnapshotService(windows, row),
    })
    return service.resolveForRun({ taskName: 'commit', kind: 'builtin', defaults: {} })
  }

  it('Codex weekly-only evidence is complete and can truthfully be strained', async () => {
    writeConfig({})
    const resolution = await runCodexQuota([{
      name: '7d', pct: 95,
      resets_at: new Date(QUOTA_T0 + 4 * 24 * 60 * 60_000).toISOString(),
      window_minutes: 10_080,
    }])
    assert.equal(resolution.dispatch?.auto_routing?.quota_tier, 'strained')
    assert.equal(resolution.dispatch?.auto_routing?.quota_coverage_complete, true)
  })

  it('a present Codex 5h blocks when exhausted, strains when low, and permits healthy routing when healthy', async () => {
    writeConfig({})
    const weekly = {
      name: '7d', pct: 20,
      resets_at: new Date(QUOTA_T0 + 4 * 24 * 60 * 60_000).toISOString(),
      window_minutes: 10_080,
    }
    await assert.rejects(
      runCodexQuota([weekly, {
        name: '5h', pct: 100,
        resets_at: new Date(QUOTA_T0 + 4 * 60 * 60_000).toISOString(),
        window_minutes: 300,
      }]),
      (error) => error instanceof NoEligiblePlanError && error.resolutionFailureCode === 'quota_unavailable',
    )
    const strained = await runCodexQuota([weekly, {
      name: '5h', pct: 95,
      resets_at: new Date(QUOTA_T0 + 4 * 60 * 60_000).toISOString(),
      window_minutes: 300,
    }])
    assert.equal(strained.dispatch?.auto_routing?.quota_tier, 'strained')
    const healthy = await runCodexQuota([weekly, {
      name: '5h', pct: 20,
      resets_at: new Date(QUOTA_T0 + 4 * 60 * 60_000).toISOString(),
      window_minutes: 300,
    }])
    assert.equal(healthy.dispatch?.auto_routing?.quota_tier, 'healthy')
    assert.equal(healthy.dispatch?.auto_routing?.quota_coverage_complete, true)
  })

  it('an absent Codex 5h is ignored, while present-invalid or stale 5h evidence stays conservative unknown', async () => {
    writeConfig({})
    const weekly = {
      name: '7d', pct: 20,
      resets_at: new Date(QUOTA_T0 + 4 * 24 * 60 * 60_000).toISOString(),
      window_minutes: 10_080,
    }
    const absent = await runCodexQuota([weekly])
    assert.equal(absent.dispatch?.auto_routing?.quota_tier, 'healthy')
    assert.equal(absent.dispatch?.auto_routing?.quota_coverage_complete, true)

    const invalid = await runCodexQuota([weekly, {
      name: '5h', pct: 20, resets_at: 'not-a-time', window_minutes: 300,
    }])
    assert.equal(invalid.dispatch?.auto_routing?.quota_tier, 'unknown')
    assert.equal(invalid.dispatch?.auto_routing?.quota_coverage_complete, false)

    const stale = await runCodexQuota([weekly, {
      name: '5h', pct: 20,
      resets_at: new Date(QUOTA_T0 + 4 * 60 * 60_000).toISOString(),
      window_minutes: 300,
    }], { stale: true })
    assert.equal(stale.dispatch?.auto_routing?.quota_tier, 'unknown')
    assert.equal(stale.dispatch?.auto_routing?.quota_coverage_complete, false)
  })

  it('explicit run preflight fails on live unavailability with no second resolver call', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
          },
        },
      },
    })
    const resolver = createResolverFixture()
    const counts = { resolveExplicit: 0 }
    const service = context!.makeService({
      resolver: {
        ...resolver,
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
        taskName: 'commit',
        kind: 'builtin',
        defaults: {},
      }),
      (error) => error instanceof TaskSettingsRuntimeUnavailableError,
    )
    // Exactly one explicit resolver call picked the canonical target; the live
    // check failed it and no fallback or alternate selection was attempted.
    assert.equal(counts.resolveExplicit, 1)
  })

  it('snapshot readiness reflects a non-accepting daemon and unknown quota', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'target', target: PROFILES[0]!.exactAgentRuntime },
          },
        },
      },
    })
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

    const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    const readiness = commit.explicit?.readiness
    assert.ok(readiness)
    assert.equal(readiness.daemon, 'unavailable')
    assert.equal(readiness.available, false)
    assert.equal(readiness.quota, 'unknown')
    assert.ok(readiness.issues.some((issue) => issue.code === 'daemon_not_accepting'))
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
        patch: { timeout_ms: 60_000 },
      }),
      (error) => error instanceof TaskSettingsTaskNotFoundError,
    )
    assert.deepEqual(readConfig(), {})
    assert.equal(tempResidue().length, 0)
  })

  it('a malformed explicit runtime reference is rejected as invalid settings', async () => {
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
          explicit_runtime: { kind: 'bogus' } as never,
        },
      }),
      (error) => error instanceof Error && /Invalid task settings/.test(error.message),
    )
    assert.deepEqual(readConfig(), {})
    assert.equal(tempResidue().length, 0)
  })

  it('projects a safe instruction_template preserving static text/order without executing anything', async () => {
    writeConfig({})
    const executed: string[] = []
    const previewDef: DefEntry = {
      name: 'preview',
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
      // The automatic preview runs the same non-billable live readiness probe
      // as automatic runs through the shared selection helper, so these
      // callbacks must answer (never throw) and must never be paid probes.
      daemonAvailability: () => ({ accepting: true, known: true }),
      runtimeAvailability: () => ({
        providerCredential: 'available',
        providerLive: 'unknown',
        quota: 'unknown',
        available: true,
      }),
    })
    const snapshot = await service.snapshot({ task_id: 'builtin:preview' })

    const row = snapshot.rows.find((entry) => entry.identity === 'builtin:preview')
    assert.ok(row)
    assert.deepEqual(row.builtin.instruction_template, [
      { kind: 'text', source: 'task.instructions[0]', text: 'First static instruction.' },
      { kind: 'placeholder', source: 'task.instructions[1]', label: '运行时填入任务输入' },
      { kind: 'text', source: 'task.instructions[2]', text: 'Second static instruction.' },
      // The input-dependent prompt body stays the final placeholder segment.
      { kind: 'placeholder', source: 'task.prompt', label: '运行时根据任务输入生成任务提示' },
    ])
    // Static instructions kept their exact text and relative order, and the
    // function instruction was never invoked.
    assert.deepEqual(executed, [])
    // Labels fall back to the exact task name when none is declared.
    assert.equal(row.display_name, 'preview')
  })

  it('global CAS save persists a zero max_auto_output_usd_per_million cap atomically and reports its source', async () => {
    writeConfig({})
    const service = context!.makeService()
    const before = await service.snapshot({})

    const after = await service.save({
      scope: 'global',
      expected_revision: before.revision,
      patch: { max_auto_output_usd_per_million: 0 },
    })

    assert.deepEqual(after.user_global, { max_auto_output_usd_per_million: 0 })
    const commit = after.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.deepEqual(commit.effective.max_auto_output_usd_per_million, {
      value: 0,
      source: 'user_global',
    })
    // Persisted in canonical camel-case form; per-task/builtin dispatch
    // constraints are untouched.
    const onDisk = readConfig()
    const tasks = onDisk.tasks as { settings: { global: Record<string, unknown> } }
    assert.deepEqual(tasks.settings.global, { maxAutoOutputUsdPerMillion: 0 })
    assert.equal(tempResidue().length, 0)
  })

  it('global CAS null clears the auto cap without altering sibling settings', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { timeoutMs: 60_000, maxAutoOutputUsdPerMillion: 5 },
        },
      },
    })
    const service = context!.makeService()
    const before = await service.snapshot({})
    assert.deepEqual(before.user_global, {
      timeout_ms: 60_000,
      max_auto_output_usd_per_million: 5,
    })

    const after = await service.save({
      scope: 'global',
      expected_revision: before.revision,
      patch: { max_auto_output_usd_per_million: null },
    })
    assert.deepEqual(after.user_global, { timeout_ms: 60_000 })
    const commit = after.rows.find((row) => row.identity === 'builtin:commit')
    assert.ok(commit)
    assert.deepEqual(commit.effective.max_auto_output_usd_per_million, {
      value: null,
      source: 'system',
    })

    const onDisk = readConfig()
    const tasks = onDisk.tasks as { settings: { global: Record<string, unknown> } }
    assert.deepEqual(tasks.settings.global, { timeoutMs: 60_000 })
    assert.equal(tempResidue().length, 0)
  })

  it('task-scope saves carrying the global-only auto cap are rejected without mutation', async () => {
    writeConfig({
      tasks: { settings: { byTask: { 'builtin:commit': { timeoutMs: 10_000 } } } },
    })
    const service = context!.makeService()
    const before = await service.snapshot({})

    await assert.rejects(
      service.save({
        scope: 'task',
        task_id: 'commit',
        expected_revision: before.revision,
        patch: { max_auto_output_usd_per_million: 2 },
      }),
      (error) => error instanceof TaskSettingsInvalidSettingsError,
    )

    const onDisk = readConfig()
    const tasks = onDisk.tasks as { settings: { byTask: Record<string, unknown> } }
    assert.deepEqual(tasks.settings.byTask['builtin:commit'], { timeoutMs: 10_000 })
    assert.equal(tempResidue().length, 0)
  })

  it('stale-revision global saves carrying the auto cap still raise content_conflict and preserve external edits', async () => {
    writeConfig({
      external: 'edited',
      tasks: { settings: { global: { maxAutoOutputUsdPerMillion: 3 } } },
    })
    const service = context!.makeService()
    const before = await service.snapshot({})

    writeConfig({
      external: 'edited-v2',
      tasks: { settings: { global: { maxAutoOutputUsdPerMillion: 3 } } },
    })

    await assert.rejects(
      service.save({
        scope: 'global',
        expected_revision: before.revision,
        patch: { max_auto_output_usd_per_million: 0 },
      }),
      (error) => error instanceof TaskSettingsContentConflictError,
    )

    const onDisk = readConfig()
    assert.equal(onDisk.external, 'edited-v2')
    const tasks = onDisk.tasks as { settings: { global: Record<string, unknown> } }
    assert.deepEqual(tasks.settings.global, { maxAutoOutputUsdPerMillion: 3 })
    assert.equal(tempResidue().length, 0)
  })

  it('automatic preview rows reuse quota and credential evidence within one snapshot request only', async () => {
    writeConfig({})
    let quotaCalls = 0
    const probeTriples: Array<{ client: string; provider: string; model: string }> = []
    // The quota service itself does not cache, so counting snapshot() calls
    // proves the request-scoped memo (not the service) collapses them.
    const realQuotaService = unknownQuotaSnapshotService()
    const quotaService = {
      routingSnapshot: async () => {
        quotaCalls += 1
        return { snapshot: await realQuotaService.snapshot(), codeBuddySnapshot: undefined }
      },
    } as unknown as AutoRoutingQuotaSnapshotService
    const service = context!.makeService({
      quotaSnapshots: quotaService,
      runtimeAvailability: (runtime) => {
        probeTriples.push(runtime)
        return {
          providerCredential: 'available',
          providerLive: 'unknown',
          quota: 'unknown',
          available: true,
        }
      },
    })

    // One snapshot request contains multiple automatic rows ('commit', 'review',
    // plus failing 'auto-fail') that share the same eligible exact runtimes.
    // Quota is obtained once and each canonical runtime readiness is probed at
    // most once across all automatic rows.
    const first = await service.snapshot({})
    assert.equal(quotaCalls, 1)
    assert.deepEqual(probeTriples, PROFILES.map((profile) => runtimeTriple(profile)))
    assert.equal(first.rows.filter((row) => row.automatic_selection !== undefined).length, 2)

    const commit = first.rows.find((row) => row.identity === 'builtin:commit')
    const review = first.rows.find((row) => row.identity === 'builtin:review')
    assert.ok(commit)
    assert.ok(commit.automatic_selection)
    assert.ok(review)
    assert.ok(review.automatic_selection)
    // Row automatic selections remain correct: each preview row matches what the
    // fresh run path resolves for the same effective requirements.
    const commitRun = await service.resolveForRun({
      taskName: 'commit',
      kind: 'builtin',
      defaults: { timeoutMs: 120_000, dispatch: { expectedTps: 80, minimumTps: 60 } },
    })
    const reviewRun = await service.resolveForRun({
      taskName: 'review',
      kind: 'builtin',
      defaults: { timeoutMs: 180_000, dispatch: { maxOutputUsdPerMillion: 15 } },
    })
    assert.equal(commit.automatic_selection.exact_runtime, commitRun.exactAgentRuntime)
    assert.equal(review.automatic_selection.exact_runtime, reviewRun.exactAgentRuntime)
    assert.deepEqual(commit.issues, [])

    // The memo is request-scoped and never leaks: a second snapshot request
    // performs fresh request-scoped probes again (one quota snapshot, one probe
    // per canonical runtime) while the chosen semantics stay identical.
    quotaCalls = 0
    probeTriples.length = 0
    const second = await service.snapshot({})
    assert.equal(quotaCalls, 1)
    assert.deepEqual(probeTriples, PROFILES.map((profile) => runtimeTriple(profile)))
    const secondCommit = second.rows.find((row) => row.identity === 'builtin:commit')
    const secondReview = second.rows.find((row) => row.identity === 'builtin:review')
    assert.ok(secondCommit)
    assert.ok(secondCommit.automatic_selection)
    assert.ok(secondReview)
    assert.ok(secondReview.automatic_selection)
    // Rows stay semantically identical across requests: same exact runtime
    // (provider/model/client target) and the same ranked decision and reasons.
    // Only the request-scoped quota snapshot identity inside auto_routing
    // refreshes, so compare the stable selection semantics instead of deep
    // equal-ing the whole object and requiring a stale snapshot_id.
    const splitSnapshotIdentity = (value: unknown): { body: unknown; snapshotIds: string[] } => {
      if (Array.isArray(value)) {
        const bodies: unknown[] = []
        const snapshotIds: string[] = []
        for (const entry of value) {
          const part = splitSnapshotIdentity(entry)
          bodies.push(part.body)
          snapshotIds.push(...part.snapshotIds)
        }
        return { body: bodies, snapshotIds }
      }
      if (value !== null && typeof value === 'object') {
        const body: Record<string, unknown> = {}
        const snapshotIds: string[] = []
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          if (key === 'snapshot_id' && typeof entry === 'string') {
            snapshotIds.push(entry)
          } else {
            const part = splitSnapshotIdentity(entry)
            body[key] = part.body
            snapshotIds.push(...part.snapshotIds)
          }
        }
        return { body, snapshotIds }
      }
      return { body: value, snapshotIds: [] }
    }
    const firstCommit = splitSnapshotIdentity(commit.automatic_selection)
    const secondCommitParts = splitSnapshotIdentity(secondCommit.automatic_selection)
    const firstReviewParts = splitSnapshotIdentity(review.automatic_selection)
    const secondReviewParts = splitSnapshotIdentity(secondReview.automatic_selection)
    assert.deepEqual(secondCommitParts.body, firstCommit.body)
    assert.deepEqual(secondReviewParts.body, firstReviewParts.body)
    assert.equal(
      secondCommit.automatic_selection.exact_runtime,
      commit.automatic_selection.exact_runtime,
    )
    assert.equal(
      secondReview.automatic_selection.exact_runtime,
      review.automatic_selection.exact_runtime,
    )
    // The second request consumed a fresh quota snapshot: its auto_routing
    // snapshot_id must differ even though every semantic field stayed equal.
    assert.ok(firstCommit.snapshotIds.length >= 1)
    assert.ok(secondCommitParts.snapshotIds.length >= 1)
    assert.notDeepEqual(secondCommitParts.snapshotIds, firstCommit.snapshotIds)
    assert.ok(firstReviewParts.snapshotIds.length >= 1)
    assert.ok(secondReviewParts.snapshotIds.length >= 1)
    assert.notDeepEqual(secondReviewParts.snapshotIds, firstReviewParts.snapshotIds)
  })

  it('automatic preview maps every rejected live readiness probe to no_available_provider', async () => {
    writeConfig({})
    const service = context!.makeService({
      runtimeAvailability: () => ({
        providerCredential: 'missing',
        providerLive: 'unavailable',
        quota: 'unknown',
        available: false,
      }),
    })
    const issue = await automaticUnavailableIssueOf(service, 'builtin:commit')
    assertClosedAutoIssue(issue)
    assert.deepEqual(issue?.resolutionFailure, {
      code: 'no_available_provider',
      message: '没有可用的服务商，请检查登录或凭据',
    })
  })

  it('automatic preview maps every above-cap rejection to price_limit', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { selectionMode: 'automatic', dispatch: { maxOutputUsdPerMillion: 1 } },
        },
      },
    })
    const service = context!.makeService()
    const issue = await automaticUnavailableIssueOf(service, 'builtin:commit')
    assertClosedAutoIssue(issue)
    assert.deepEqual(issue?.resolutionFailure, {
      code: 'price_limit',
      message: '允许价格内没有可用模型，请调整价格上限',
    })
  })

  it('automatic preview maps an unsatisfiable intelligence floor to intelligence_requirement', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { selectionMode: 'automatic', dispatch: { intelligenceMin: 'premium' } },
        },
      },
    })
    const service = context!.makeService()
    const issue = await automaticUnavailableIssueOf(service, 'builtin:commit')
    assertClosedAutoIssue(issue)
    assert.deepEqual(issue?.resolutionFailure, {
      code: 'intelligence_requirement',
      message: '没有模型满足智能要求，请调整智能要求',
    })
  })

  it('automatic preview maps an unsatisfiable minimum speed to speed_requirement', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { selectionMode: 'automatic', dispatch: { minimumTps: 200 } },
        },
      },
    })
    const service = context!.makeService()
    const issue = await automaticUnavailableIssueOf(service, 'builtin:commit')
    assertClosedAutoIssue(issue)
    assert.deepEqual(issue?.resolutionFailure, {
      code: 'speed_requirement',
      message: '没有模型满足速度要求，请调整速度要求',
    })
  })

  it('automatic preview maps a determinate hard-blocked provider to quota_unavailable', async () => {
    writeConfig({})
    const service = context!.makeService({
      resolver: createResolverFixture({ profiles: [CODEBUDDY_NATIVE_PROFILE] }),
      quotaSnapshots: codebuddyExhaustionQuotaSnapshotService(),
    })
    const issue = await automaticUnavailableIssueOf(service, 'builtin:commit')
    assertClosedAutoIssue(issue)
    assert.deepEqual(issue?.resolutionFailure, {
      code: 'quota_unavailable',
      message: '模型额度不可用，请检查额度状态',
    })
  })

  it('unknown quota with a reference price at the 10 gate classifies as price_limit, never quota_unavailable', async () => {
    writeConfig({})
    const service = context!.makeService({
      resolver: createResolverFixture({ profiles: [PROFILES[2]!] }),
    })
    const issue = await automaticUnavailableIssueOf(service, 'builtin:commit')
    assertClosedAutoIssue(issue)
    assert.deepEqual(issue?.resolutionFailure, {
      code: 'price_limit',
      message: '允许价格内没有可用模型，请调整价格上限',
    })
  })

  it('mixed eliminations surface the cheapest routing-relevant gate deterministically regardless of pool order', async () => {
    writeConfig({
      tasks: {
        settings: {
          global: { selectionMode: 'automatic', dispatch: { intelligenceMin: 'high' } },
        },
      },
    })
    const pool = [PROFILES[0]!, PROFILES[2]!]
    const forward = context!.makeService({ resolver: createResolverFixture({ profiles: pool }) })
    const forwardIssue = await automaticUnavailableIssueOf(forward, 'builtin:commit')
    assertClosedAutoIssue(forwardIssue)
    // The cheaper gpt-5.6-luna (mid) is eliminated by the intelligence floor
    // while the expensive claude-opus-4 clears intelligence but trips the
    // unknown-quota 10 reference gate. Deterministic selection prefers the
    // elimination of the cheapest routing-relevant candidate.
    assert.equal(forwardIssue?.resolutionFailure?.code, 'intelligence_requirement')
    assert.equal(forwardIssue?.message, '没有模型满足智能要求，请调整智能要求')

    const backward = context!.makeService({
      resolver: createResolverFixture({ profiles: [...pool].reverse() }),
    })
    const backwardIssue = await automaticUnavailableIssueOf(backward, 'builtin:commit')
    assertClosedAutoIssue(backwardIssue)
    assert.deepEqual(backwardIssue?.resolutionFailure, forwardIssue?.resolutionFailure)
  })

  it('automatic preview ranks a healthy zhipu-coding GLM-5.3-Flash over an otherwise equal unknown non-free CodeBuddy twin', async () => {
    writeConfig({})
    const pool = [ZHIPU_GLM_FLASH_PROFILE, CODEBUDDY_GLM_FLASH_PROFILE]
    const previewSelection = async (
      profiles: ProfileFixture[],
    ): Promise<{ exact_runtime: string; auto_routing: unknown }> => {
      const service = context!.makeService({
        resolver: createResolverFixture({ profiles }),
        quotaSnapshots: healthyZhipuQuotaSnapshotService(),
      })
      const snapshot = await service.snapshot({ task_id: 'builtin:commit' })
      const commit = snapshot.rows.find((row) => row.identity === 'builtin:commit')
      assert.ok(commit)
      // Both candidates are otherwise gate-eligible non-confirmed-free twins of
      // the same canonical model glm-5.3-flash with equal truthful
      // speed/intelligence/reference price, so the quota tier is the deciding
      // factor. CodeBuddy has no applicable quota binding for this model and
      // probes available with no free supply, keeping it a standard unknown.
      assert.deepEqual(commit.issues, [])
      const selection = commit.automatic_selection
      assert.ok(selection)
      return {
        exact_runtime: selection.exact_runtime,
        auto_routing: selection.resolved.auto_routing,
      }
    }

    const forward = await previewSelection(pool)
    assert.equal(forward.exact_runtime, ZHIPU_GLM_FLASH_PROFILE.exactAgentRuntime)
    assert.notEqual(forward.exact_runtime, CODEBUDDY_GLM_FLASH_PROFILE.exactAgentRuntime)
    // The healthy Zhipu decision is standard supply (never confirmed-free)
    // with quota tier healthy, complete coverage, and trusted headroom from
    // the live windows (5h pct 1 / 99% remaining; 7d pct 35 / 65% remaining).
    const routing = forward.auto_routing
    assert.ok(routing && typeof routing === 'object')
    const decision = routing as Record<string, unknown>
    assert.equal(decision.supply_class, 'standard')
    assert.equal(decision.quota_tier, 'healthy')
    assert.equal(decision.quota_coverage_complete, true)
    assert.equal(decision.quota_headroom_trusted, true)

    // Reversed candidate input order leaves the decision unchanged: the healthy
    // Zhipu candidate still outranks the otherwise equal unknown CodeBuddy twin.
    const backward = await previewSelection([...pool].reverse())
    assert.equal(backward.exact_runtime, ZHIPU_GLM_FLASH_PROFILE.exactAgentRuntime)
    assert.notEqual(backward.exact_runtime, CODEBUDDY_GLM_FLASH_PROFILE.exactAgentRuntime)
  })

  it('prices automatic DeepSeek Flash from the request horizon without discount bypass or stale post-cut gating', async () => {
    const previewAt = async (
      at: string,
      timeoutMs: number,
      cap: number,
    ) => {
      const nowMs = Date.parse(at)
      writeConfig({
        tasks: {
          settings: {
            global: {
              selectionMode: 'automatic',
              timeoutMs,
              maxAutoOutputUsdPerMillion: cap,
              dispatch: { expectedTps: 1, minimumTps: 1 },
            },
          },
        },
      })
      const service = context!.makeService({
        resolver: createResolverFixture({ profiles: [DEEPSEEK_FLASH_PRICING_PROFILE] }),
        quotaSnapshots: unknownQuotaSnapshotService(() => nowMs),
        now: () => nowMs,
      })
      const snapshot = await service.snapshot({ task_id: 'builtin:commit' })
      const row = snapshot.rows.find((entry) => entry.identity === 'builtin:commit')
      assert.ok(row)
      return row
    }

    const preOffPeak = await previewAt('2026-09-09T04:30:00.000Z', 120_000, 1.32)
    assert.equal(preOffPeak.automatic_selection?.resolved.auto_routing?.reference_output_usd_per_million, 1.32)
    assert.equal(preOffPeak.automatic_selection?.resolved.auto_routing?.routing_output_usd_per_million, 0.66)
    assert.equal(preOffPeak.automatic_selection?.resolved.reference_pricing.output_usd_per_million, 0.66)

    const crossing = await previewAt('2026-09-10T03:59:59.999Z', 1, 1.32)
    assert.equal(crossing.automatic_selection?.resolved.auto_routing?.reference_output_usd_per_million, 1.32)
    assert.equal(crossing.automatic_selection?.resolved.auto_routing?.routing_output_usd_per_million, 1.32)
    assert.match(crossing.automatic_selection?.resolved.reference_pricing.source ?? '', /api-docs.*fe-static/)

    const atCut = await previewAt('2026-09-10T04:00:00.000Z', 120_000, 1.25)
    assert.equal(atCut.automatic_selection?.resolved.auto_routing?.reference_output_usd_per_million, 1.2)
    assert.equal(atCut.automatic_selection?.resolved.auto_routing?.routing_output_usd_per_million, 0.6)
    assert.equal(atCut.automatic_selection?.resolved.reference_pricing.output_usd_per_million, 0.6)
    assert.match(atCut.automatic_selection?.resolved.reference_pricing.source ?? '', /fe-static/)

    const postPeak = await previewAt('2026-09-10T06:00:00.000Z', 120_000, 1.2)
    assert.equal(postPeak.automatic_selection?.resolved.auto_routing?.reference_output_usd_per_million, 1.2)
    assert.equal(postPeak.automatic_selection?.resolved.auto_routing?.routing_output_usd_per_million, 1.2)

    const preRejected = await previewAt('2026-09-09T04:30:00.000Z', 120_000, 1.25)
    assert.equal(preRejected.automatic_selection, undefined)
    assert.equal(
      preRejected.issues.find((issue) => issue.code === 'automatic_dispatch_unavailable')?.resolutionFailure?.code,
      'price_limit',
    )
    const postRejected = await previewAt('2026-09-10T04:00:00.000Z', 120_000, 1.1)
    assert.equal(postRejected.automatic_selection, undefined)
    assert.equal(
      postRejected.issues.find((issue) => issue.code === 'automatic_dispatch_unavailable')?.resolutionFailure?.code,
      'price_limit',
    )
  })

  it('uses DeepSeek horizon marginal price for ranking and retains explicit attempt pricing', async () => {
    const selectedAt = async (at: string): Promise<string> => {
      const nowMs = Date.parse(at)
      writeConfig({
        tasks: {
          settings: {
            global: {
              selectionMode: 'automatic',
              timeoutMs: 120_000,
              maxAutoOutputUsdPerMillion: 2,
              dispatch: { expectedTps: 1, minimumTps: 1 },
            },
          },
        },
      })
      const service = context!.makeService({
        resolver: createResolverFixture({ profiles: [DEEPSEEK_FLASH_PRICING_PROFILE, DEEPSEEK_GLM_PRICE_PEER] }),
        quotaSnapshots: unknownQuotaSnapshotService(() => nowMs),
        now: () => nowMs,
      })
      const snapshot = await service.snapshot({ task_id: 'builtin:commit' })
      const row = snapshot.rows.find((entry) => entry.identity === 'builtin:commit')
      assert.ok(row?.automatic_selection)
      return row.automatic_selection.exact_runtime
    }

    assert.equal(
      await selectedAt('2026-09-09T06:30:00.000Z'),
      DEEPSEEK_GLM_PRICE_PEER.exactAgentRuntime,
    )
    assert.equal(
      await selectedAt('2026-09-09T04:30:00.000Z'),
      DEEPSEEK_FLASH_PRICING_PROFILE.exactAgentRuntime,
    )

    const nowMs = Date.parse('2026-09-10T04:00:00.000Z')
    writeConfig({
      tasks: {
        settings: {
          global: {
            selectionMode: 'explicit',
            explicitRuntime: { kind: 'target', target: DEEPSEEK_FLASH_PRICING_PROFILE.exactAgentRuntime },
            timeoutMs: 120_000,
          },
        },
      },
    })
    const service = context!.makeService({
      resolver: createResolverFixture({ profiles: [DEEPSEEK_FLASH_PRICING_PROFILE] }),
      now: () => nowMs,
    })
    const snapshot = await service.snapshot({ task_id: 'builtin:commit' })
    const row = snapshot.rows.find((entry) => entry.identity === 'builtin:commit')
    assert.equal(row?.explicit?.resolved?.reference_pricing.output_usd_per_million, 0.6)
    assert.match(row?.explicit?.resolved?.reference_pricing.source ?? '', /fe-static/)
    assert.equal(row?.explicit?.resolved?.auto_routing, undefined)

    const run = await service.resolveForRun({
      taskName: 'commit',
      kind: 'builtin',
      defaults: { timeoutMs: 120_000, dispatch: {} },
    })
    assert.equal(run.mode, 'explicit')
    assert.ok(run.dispatch)
    assert.equal(run.dispatch.reference_pricing.output_usd_per_million, 0.6)
    assert.match(run.dispatch.reference_pricing.source, /fe-static/)
    assert.equal(run.dispatch.auto_routing, undefined)
  })
})
