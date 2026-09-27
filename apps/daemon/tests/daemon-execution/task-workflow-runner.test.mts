import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { discoverTasks, resetRegistry } from '../../lib/workspace/task-loader.mts'
import { invalidateProjectCache } from '../../lib/core/project/loader.mts'
import type { AgentOpts, AgentResult, ExecutionOptions, TaskExecutionResult, TaskRunSettingsResolver } from '../../lib/types.mts'
import type { TaskSettingsLayer } from '../../lib/protocol/methods/task.mts'
import { closeDb, get as dbGet, getDb, initDb } from '../../lib/db/connection.mts'
import { setAgentExecutionSupervisor } from '../../lib/core/operations/primitives/agent.mts'
import { TaskWorkflowRunner } from '../../lib/daemon/execution/task-workflow-runner.mts'
import { DaemonTaskRunner } from '../../lib/daemon/execution/task-runner.mts'
import { foremanSchemas } from '../../lib/core/task/schemas/index.mts'
import type {
  AgentExecutionHost,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
  StartAgentExecutionOptions,
} from '../../lib/core/operations/types.mts'

let tempDirs: string[] = []
let oldForgeBin: string | undefined
let oldForgeArgsPrefix: string | undefined

function automaticSettingsResolver(): TaskRunSettingsResolver {
  return async () => ({
    mode: 'automatic',
    exactAgentRuntime: 'forge/test',
    dispatch: null,
    timeoutMs: null,
    sources: {
      selectionMode: 'builtin',
      explicitRuntime: 'builtin',
      timeoutMs: 'builtin',
      automatic: {},
    },
  })
}

function normalizeExecutionOptions(opts: ExecutionOptions | string): ExecutionOptions {
  const normalized = typeof opts === 'string'
    ? { workspaceRoot: opts, currentProject: 'app' }
    : { currentProject: 'app', ...opts }
  // Isolated kernel tests run without the daemon TaskSettingsService. Active
  // tasks never fall back to a declared runtime pin, so every run resolves
  // automatically through an injected settings resolver unless the test under
  // examination supplies its own.
  if (!normalized.taskSettingsResolver) {
    normalized.taskSettingsResolver = automaticSettingsResolver()
  }
  return normalized
}

function createTaskRunner(): DaemonTaskRunner {
  return new DaemonTaskRunner()
}

async function executeTask(name: string, input: unknown, opts: ExecutionOptions | string): Promise<TaskExecutionResult> {
  return createTaskRunner().execute(name, input, normalizeExecutionOptions(opts))
}

async function runTask(name: string, input: unknown, opts: ExecutionOptions | string): Promise<unknown> {
  return createTaskRunner().run(name, input, normalizeExecutionOptions(opts))
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const projectDir = join(dir, 'projects', 'app')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, 'app.fmproj'),
    'name: app\ndescription: Test application\n',
    'utf-8',
  )
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  oldForgeBin = process.env.WRENYARD_RUNTIME_BIN
  oldForgeArgsPrefix = process.env.WRENYARD_FORGE_ARGS_PREFIX
  closeDb()
  initDb(':memory:')
  resetRegistry()
  invalidateProjectCache()
  setAgentExecutionSupervisor(undefined as never)
})

afterEach(() => {
  if (oldForgeBin === undefined) delete process.env.WRENYARD_RUNTIME_BIN
  else process.env.WRENYARD_RUNTIME_BIN = oldForgeBin
  if (oldForgeArgsPrefix === undefined) delete process.env.WRENYARD_FORGE_ARGS_PREFIX
  else process.env.WRENYARD_FORGE_ARGS_PREFIX = oldForgeArgsPrefix
  resetRegistry()
  invalidateProjectCache()
  setAgentExecutionSupervisor(undefined as never)
  closeDb()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

function fakeExecutionHost(agent: (profile: string, prompt: string, opts?: AgentOpts) => Promise<AgentResult>): AgentExecutionHost {
  const executions = new Map<string, ExecutionRecord>()
  let counter = 0
  return {
    async startExecution(opts: StartAgentExecutionOptions) {
      const executionId = `exec_test_${++counter}`
      const record = executionRecordFromOptions(executionId, opts)
      executions.set(executionId, record)
      return {
        executionId,
        async wait() {
          const agentResult = await agent(opts.profile, opts.prompt, {
            workingDirectory: opts.cwd,
            timeoutMs: opts.timeoutMs,
            resume: opts.resume,
            taskId: opts.taskId,
            writePaths: opts.writePaths,
          })
          const result: ExecutionResult = {
            executionId,
            status: agentResult.status,
            output: agentResult.output,
            error: agentResult.status === 'failed' ? agentResult.output : null,
            exitCode: null,
            killReason: null,
          }
          executions.set(executionId, {
            ...record,
            status: result.status,
            native_session_id: agentResult.nativeSessionId ?? null,
            output: agentResult.output,
            raw_result: agentResult.output,
            error: result.error ?? null,
            exit_code: null,
            kill_reason: null,
          })
          return result
        },
        async cancel() {
          markExecution(executions, executionId, 'cancelled', 'cancelled')
        },
      }
    },
    async waitExecution(executionId: string) {
      const record = executions.get(executionId)
      if (!record) throw new Error(`execution not found: ${executionId}`)
      return executionResultFromRecord(record)
    },
    getExecution(executionId: string) {
      return executions.get(executionId)
    },
    async cancelExecution(executionId: string) {
      markExecution(executions, executionId, 'cancelled', 'cancelled')
    },
  }
}

function executionRecordFromOptions(executionId: string, opts: StartAgentExecutionOptions): ExecutionRecord {
  return {
    id: executionId,
    task_id: opts.taskId ?? null,
    profile: opts.profile,
    cwd: opts.cwd,
    prompt: opts.prompt,
    status: 'running',
    native_session_id: null,
    client_family: opts.clientFamily ?? null,
    pid: null,
    pgid: null,
    output: null,
    raw_result: null,
    error: null,
    exit_code: null,
    kill_reason: null,
    timeout_ms: opts.timeoutMs ?? null,
  }
}

function executionResultFromRecord(record: ExecutionRecord): ExecutionResult {
  return {
    executionId: record.id,
    status: record.status,
    output: record.output,
    error: record.error,
    exitCode: record.exit_code,
    killReason: record.kill_reason,
  }
}

function markExecution(
  executions: Map<string, ExecutionRecord>,
  executionId: string,
  status: ExecutionStatus,
  killReason: string,
): void {
  const record = executions.get(executionId)
  if (!record) return
  executions.set(executionId, {
    ...record,
    status,
    kill_reason: killReason,
  })
}

function xmlOutput(data: unknown, summary = 'Done.'): string {
  return [
    '<foreman-task-output>',
    '<summary>',
    summary,
    '</summary>',
    '<result>',
    JSON.stringify(data),
    '</result>',
    '</foreman-task-output>',
  ].join('\n')
}

const NO_INPUT_SCHEMA = `input: foremanSchemas.z.object({}),`
const TEXT_OUTPUT_SCHEMA = `output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),`

function textOutput(result: string, summary = 'Done.'): string {
  return xmlOutput({ result: stripOutputContract(result) }, summary)
}

function stripOutputContract(text: string): string {
  const start = text.lastIndexOf('<wy-instruction>')
  return start < 0 ? text.trim() : text.slice(start + '<wy-instruction>'.length).split('</wy-instruction>')[0].trim()
}

describe('daemon execution', { concurrency: false }, () => {
  it('validates input and executes simple tasks', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'echo.task.ts'),
`export default defineTask({
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  ${TEXT_OUTPUT_SCHEMA}
  prompt: ({ text }) => \`echo:\${text}\`,
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    // The task prompt is now composed with the stable output contract, so this
    // test returns the task result directly instead of echoing prompt text.
    const agent = async (): Promise<AgentResult> => ({ output: xmlOutput({ result: 'echo:hello' }), status: 'done' })
    assert.deepEqual(await runTask('echo', { text: 'hello' }, { workspaceRoot: workspace, primitives: { agent } }), { result: 'echo:hello' })
    await assert.rejects(
      () => runTask('echo', {}, { workspaceRoot: workspace, primitives: { agent } }),
      /Invalid input for task 'echo'/u,
    )
  })
})

// ── Daemon fact event tests ───────────────────────────────────────────────

interface StoredFactRow {
  type: string
  data: string | null
}

function readDaemonFacts(): Array<{ type: string; payload: Record<string, unknown> }> {
  return getDb().prepare<[], StoredFactRow>(
    `SELECT type, data FROM events ORDER BY id`,
  ).all()
    .map((row) => ({ type: row.type, payload: JSON.parse(row.data ?? '{}') as Record<string, unknown> }))
    .filter((row) => row.payload.schema_version === 'foreman.event.v1')
}

describe('daemon execution fact events', { concurrency: false }, () => {
  it('records task run started and completed facts in SQLite', async () => {
    const workspace = makeTempDir('foreman-v2-events-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'simple.task.ts'),
`export default defineTask({
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  ${TEXT_OUTPUT_SCHEMA}
  prompt: ({ text }) => \`echo:\${text}\`,})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    const agent = async (): Promise<AgentResult> => ({ output: xmlOutput({ result: 'done' }), status: 'done' })
    await runTask('simple', { text: 'hello' }, { workspaceRoot: workspace, primitives: { agent } })

    const facts = readDaemonFacts()
    assert.deepEqual(facts.map((event) => event.type), ['task.run.started', 'task.run.completed'])
    assert.equal((facts[0].payload.refs as { project?: string }).project, 'app')
    assert.equal((facts[1].payload.data as { taskName?: string }).taskName, 'simple')
  })

})

// ── Task settings resolver threading ────────────────────────────────────

describe('task run settings threading', { concurrency: false }, () => {
  it('forwards the attached TaskRunSettingsResolver and invocationSettings to daemon execution options once', async () => {
    const workspace = makeTempDir('foreman-settings-thread-')
    const invocationSettings = { mode: 'automatic', timeout_ms: 42_000 } as const

    const resolver: TaskRunSettingsResolver = async () => ({
      mode: 'automatic',
      exactAgentRuntime: 'forge/test',
      dispatch: null,
      timeoutMs: 42_000,
      sources: {
        selectionMode: 'invocation',
        explicitRuntime: 'system',
        timeoutMs: 'invocation',
        automatic: {},
      },
    })

    const originalExecute = DaemonTaskRunner.prototype.execute
    let executeCalls = 0
    let capturedOptions: ExecutionOptions | undefined
    try {
      DaemonTaskRunner.prototype.execute = (function (
        this: unknown,
        _definitionName: string,
        _input: unknown,
        options?: ExecutionOptions,
      ): Promise<TaskExecutionResult> {
        executeCalls += 1
        capturedOptions = options
        return Promise.resolve({ status: 'done', output: '' }) as unknown as Promise<TaskExecutionResult>
      }) as unknown as typeof DaemonTaskRunner.prototype.execute

      const runner = new TaskWorkflowRunner({
        db: getDb(),
        agentExecutionHost: fakeExecutionHost(async () => ({ output: '', status: 'done' })),
      })
      // Daemon bootstrap attaches the TaskSettingsService resolver via this setter.
      runner.setTaskSettingsResolver(resolver)

      const handle = await runner.startTaskRun({
        taskName: 'echo',
        definitionName: 'echo',
        project: 'app',
        executionProject: 'app',
        input: {},
        workspaceRoot: workspace,
        workingDirectory: workspace,
        invocationSettings,
      })

      assert.ok(handle.task_run_id)
      // Exactly one execution options construction forwards both the daemon
      // settings resolver and the non-persistent invocation settings layer.
      assert.equal(executeCalls, 1)
      assert.equal(capturedOptions?.taskSettingsResolver, resolver)
      assert.deepEqual(capturedOptions?.invocationSettings, invocationSettings)
    } finally {
      DaemonTaskRunner.prototype.execute = originalExecute
    }
  })
})

// ── Task settings resolver execution semantics (real kernel) ─────────────

describe('daemon execution task settings resolver', { concurrency: false }, () => {
  function writeSettingsTask(workspace: string): void {
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'settings-task.task.ts'),
`export default defineTask({
  timeoutMs: 7200000,
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'base dynamic prompt',
})
`,
      'utf-8',
    )
  }

  function automaticResolution(
    exactAgentRuntime: string,
    timeoutMs: number | null = null,
  ): import('../../lib/types.mts').TaskRunSettingsResolution {
    return {
      mode: 'automatic',
      exactAgentRuntime,
      dispatch: null,
      timeoutMs,
      sources: {
        selectionMode: 'builtin',
        explicitRuntime: 'builtin',
        timeoutMs: 'builtin',
        automatic: {},
      },
    }
  }

  const invocationSettings: TaskSettingsLayer = {
    mode: 'explicit',
    explicit_runtime: { kind: 'target', target: 'codex/gpt-5.6-luna:codex' },
    timeout_ms: 42_000,
  }

  it('passes invocation settings to the resolver and launches only the resolved runtime with its timeout', async (t) => {
    const now = Date.now()
    t.mock.method(Date, 'now', () => now)
    const workspace = makeTempDir('foreman-settings-kernel-')
    writeSettingsTask(workspace)
    await discoverTasks(workspace)

    let resolverCalls = 0
    let capturedInvocation: unknown
    const codeBuddyExecution = Object.freeze({
      expectedScope: 'cbv1:kernel-private-scope',
      expectedEnvironment: 'ioa',
      expectedWireModel: 'hy3-ioa',
    })
    const resolver: TaskRunSettingsResolver = async (params) => {
      resolverCalls += 1
      capturedInvocation = params.invocation
      return {
        ...automaticResolution('forge/settings-resolved', 42_000),
        codeBuddyExecution,
      }
    }
    const launchedProfiles: string[] = []
    let capturedOpts: AgentOpts | undefined
    let capturedPrompt: string | undefined
    const agent = async (profile: string, prompt: string, opts?: AgentOpts): Promise<AgentResult> => {
      launchedProfiles.push(profile)
      capturedPrompt = prompt
      capturedOpts = opts
      return { output: textOutput('done'), status: 'done' }
    }

    const result = await executeTask('settings-task', undefined, {
      workspaceRoot: workspace,
      taskSettingsResolver: resolver,
      invocationSettings,
      primitives: { agent },
    })

    assert.equal(result.status, 'done')
    assert.equal(resolverCalls, 1, 'settings resolver must be called exactly once')
    assert.deepEqual(capturedInvocation, invocationSettings, 'invocation layer must reach the resolver unchanged')
    assert.deepEqual(launchedProfiles, ['forge/settings-resolved'], 'only the resolved exact runtime may launch')
    assert.equal(capturedOpts?.timeoutMs, 42_000, 'resolved timeout must reach collectStructuredOutput as the total deadline')
    assert.equal(
      capturedOpts?.codeBuddyExecution,
      codeBuddyExecution,
      'the private execution binding must reach the first agent attempt unchanged',
    )
    assert.ok(capturedPrompt?.includes('base dynamic prompt'), 'builtin dynamic prompt must still be present')
    // Invocation settings are never persisted: the task row input stays clean.
    const row = dbGet<{ input: string | null }>('SELECT input FROM tasks ORDER BY created_at LIMIT 1')
    assert.ok(row, 'a persisted task row must exist')
    assert.ok(!JSON.stringify(result).includes(codeBuddyExecution.expectedScope), 'task results must not serialize the binding')
  })
})
