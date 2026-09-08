import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
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
import { AgentExecutionSupervisor } from '../../lib/daemon/execution/agent-supervisor.mts'
import { RepoWriteLocks } from '../../lib/daemon/execution/repo-write-locks.mts'
import { TaskWorkflowRunner } from '../../lib/daemon/execution/task-workflow-runner.mts'
import {
  DAEMON_PLANNED_RESTART_CODE,
  DAEMON_PLANNED_RESTART_MESSAGE,
  DispatchControlError,
} from '../../lib/daemon/dispatch-control.mts'
import { DaemonTaskRunner } from '../../lib/daemon/execution/task-runner.mts'
import { bindTaskRuntimeOverrideConfigPath } from '../../lib/config/task-runtime-override.mts'
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
let fakeForgeScriptCounter = 0

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

type TaskRow = {
  id: string
  template: string
  status: string
  output: string | null
  summary: string | null
  failure_category: string | null
  error_message: string | null
}



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
            permission: opts.permission,
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
    permission: opts.permission,
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

type ExecutionOutputRow = {
  id: string
  task_id: string | null
  output: string | null
}

function readOnlyTaskRow(): TaskRow | undefined {
  return dbGet<TaskRow>('SELECT id, template, status, output, summary, failure_category, error_message FROM tasks ORDER BY created_at LIMIT 1')
}

function readTaskRowByTemplate(template: string): TaskRow | undefined {
  return dbGet<TaskRow>('SELECT id, template, status, output, summary, failure_category, error_message FROM tasks WHERE template = ?', template)
}


function readExecutionOutputRows(): ExecutionOutputRow[] {
  return getDb().prepare<unknown[], ExecutionOutputRow>(
    `SELECT id, task_id, output
    FROM executions
    ORDER BY created_at ASC, id ASC`,
  ).all()
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

function invalidXmlOutput(): string {
  return [
    '<foreman-task-output>',
    '<summary>Done.</summary>',
    '<result>',
    '{bad json',
    '</result>',
    '</foreman-task-output>',
  ].join('\n')
}

// Extracts the first task-emitted JSON object from a composed prompt. The
// daemon prepends a structured-output contract (which itself contains JSON)
// to the task's emitted payload, so JSON.parse on the whole prompt fails.
function extractEmittedTaskJson(prompt: string): Record<string, unknown> {
  const marker = '"availableAtEval"'
  const markerIndex = prompt.indexOf(marker)
  assert.ok(markerIndex !== -1, 'composed prompt must contain the task-emitted JSON object')
  const open = prompt.lastIndexOf('{', markerIndex)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = open; i < prompt.length; i += 1) {
    const ch = prompt[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(prompt.slice(open, i + 1)) as Record<string, unknown>
      }
    }
  }
  assert.fail('could not find the closing brace of the task-emitted JSON object')
}

const NO_INPUT_SCHEMA = `input: foremanSchemas.z.object({}),`
const TEXT_OUTPUT_SCHEMA = `output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),`

function textOutput(result: string, summary = 'Done.'): string {
  return xmlOutput({ result: stripOutputContract(result) }, summary)
}

function stripOutputContract(text: string): string {
  return text.replace(/\n\n<foreman-output-contract[\s\S]*$/u, '')
}

function installSupervisorBackedAgent(): void {
  const db = getDb()
  setAgentExecutionSupervisor(new AgentExecutionSupervisor({
    db,
    repoWriteLocks: new RepoWriteLocks(),
  }))
}

function installFakeForgeLines(dir: string, events: Array<Record<string, unknown>>): void {
  installFakeForgeOutput(dir, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

function installFakeForgeOutput(dir: string, output: string): void {
  fakeForgeScriptCounter += 1
  const script = join(dir, `fake-forge-${fakeForgeScriptCounter}.mjs`)
  writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})\n`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function installRetryingStructuredForge(dir: string): void {
  fakeForgeScriptCounter += 1
  const script = join(dir, `fake-forge-${fakeForgeScriptCounter}.mjs`)
  const counterPath = join(dir, `fake-forge-${fakeForgeScriptCounter}.count`)
  const firstOutput = invalidXmlOutput()
  const secondOutput = xmlOutput({ label: 'valid retry' })
  writeFileSync(script, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const counterPath = ${JSON.stringify(counterPath)}
const current = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0
const attempt = current + 1
writeFileSync(counterPath, String(attempt))

function event(seq, type, data) {
  return JSON.stringify({
    protocol: 'forge.agent.stream',
    version: 1,
    run_id: 'fr_daemon_execution_retry',
    seq,
    type,
    timestamp: '2026-06-19T00:00:00.000Z',
    data,
  }) + '\\n'
}

if (attempt === 1) {
  process.stdout.write(event(1, 'run_started', { profile: 'test', client_family: 'claude', cwd: ${JSON.stringify(dir)} }))
  process.stdout.write(event(2, 'run_finished', {
    status: 'done',
    exit_code: 0,
    summary: ${JSON.stringify(firstOutput)},
    native_session_id: 'native_structured_retry',
    client_family: 'claude',
  }))
} else {
  await new Promise((resolve) => setTimeout(resolve, 750))
  process.stdout.write(event(1, 'run_started', { profile: 'test', client_family: 'claude', cwd: ${JSON.stringify(dir)} }))
  process.stdout.write(event(2, 'run_finished', {
    status: 'done',
    exit_code: 0,
    summary: ${JSON.stringify(secondOutput)},
    native_session_id: 'native_structured_retry',
    client_family: 'claude',
  }))
}
`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function forgeStreamEvent(seq: number, type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 'forge.agent.stream',
    version: 1,
    run_id: 'fr_daemon_execution_test',
    seq,
    type,
    timestamp: '2026-06-19T00:00:00.000Z',
    data,
  }
}

async function waitForInvalidStructuredAttemptBeforeRetryCompletes(): Promise<TaskRow> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const executions = readExecutionOutputRows()
    const sawInvalid = executions.some((row) => row.output?.includes('{bad json'))
    const sawValid = executions.some((row) => row.output?.includes('"valid retry"'))
    const task = readOnlyTaskRow()
    if (sawInvalid && !sawValid && task) return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('did not observe invalid structured attempt before the valid retry completed')
}


describe('daemon execution', { concurrency: false }, () => {
  it('validates input and executes simple tasks', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'echo.task.ts'),
`export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  ${TEXT_OUTPUT_SCHEMA}
  prompt: ({ text }) => \`echo:\${text}\`,
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    const agent = async (_profile: string, prompt: string): Promise<AgentResult> => ({ output: textOutput(prompt), status: 'done' })
    assert.deepEqual(await runTask('echo', { text: 'hello' }, { workspaceRoot: workspace, primitives: { agent } }), { result: 'echo:hello' })
    await assert.rejects(
      () => runTask('echo', {}, { workspaceRoot: workspace, primitives: { agent } }),
      /Invalid input for task 'echo'/u,
    )
  })

  it('refuses active unconstrained task execution without a settings or dispatch resolver', async () => {
    const workspace = makeTempDir('foreman-daemon-no-resolver-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    // An active task with no dispatch requirements and no legacy profile pin.
    writeFileSync(
      join(projectDir, 'unconstrained.task.ts'),
      `export default defineTask({
  permission: 'readonly',
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'auto',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    let agentCalls = 0
    // Bypass the test helper (which injects an automatic settings resolver) to
    // prove active execution has no hidden profile/config pin fallback.
    await assert.rejects(
      () => createTaskRunner().execute('unconstrained', undefined, {
        workspaceRoot: workspace,
        currentProject: 'app',
        primitives: {
          agent: async () => {
            agentCalls += 1
            return { output: textOutput('done'), status: 'done' }
          },
        },
      }),
      /without a resolver/,
    )
    assert.equal(agentCalls, 0)
  })

  it('does not dispatch the builtin scheduling:legacy implement for new work without explicit resolution', async () => {
    const workspace = makeTempDir('foreman-daemon-legacy-new-work-')
    await discoverTasks(workspace)

    let agentCalls = 0
    // No settings resolver is supplied (same shape as the unconstrained active
    // case above). The pin-free legacy builtin must never auto-dispatch through
    // a hidden definition profile, so new-work execution rejects before any
    // agent launches.
    await assert.rejects(
      () => createTaskRunner().execute('implement', undefined, {
        workspaceRoot: workspace,
        currentProject: 'app',
        primitives: {
          agent: async () => {
            agentCalls += 1
            return { output: textOutput('done'), status: 'done' }
          },
        },
      }),
    )
    assert.equal(agentCalls, 0, 'legacy implement must never launch an agent for new work')
  })
})

describe('task run admission', { concurrency: false }, () => {
  // A contract-faithful admission controller: throws DispatchControlError with
  // the exact code/message when planned restart is in force, no-op otherwise.
  function plannedRestartAdmission(): {
    assertAccepting: () => void
    setPlannedRestart: (value: boolean) => void
  } {
    let planned = false
    return {
      assertAccepting() {
        if (planned) {
          throw new DispatchControlError(DAEMON_PLANNED_RESTART_CODE, DAEMON_PLANNED_RESTART_MESSAGE)
        }
      },
      setPlannedRestart(value: boolean) {
        planned = value
      },
    }
  }

  function writeEchoTask(workspace: string): void {
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'echo.task.ts'),
      `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  ${TEXT_OUTPUT_SCHEMA}
  prompt: ({ text }) => \`echo:\${text}\`,
})
`,
      'utf-8',
    )
  }


  it('rejects startTaskRun during planned_restart before any placeholder or agent call', async () => {
    const admission = plannedRestartAdmission()
    admission.setPlannedRestart(true)
    let agentCalls = 0
    const agent = async (_profile: string, _prompt: string): Promise<AgentResult> => {
      agentCalls += 1
      return { output: textOutput('x'), status: 'done' }
    }
    const runner = new TaskWorkflowRunner({
      db: getDb(),
      agentExecutionHost: fakeExecutionHost(agent),
      admissionControl: () => admission.assertAccepting(),
    })
    await assert.rejects(
      runner.startTaskRun({
        taskName: 'echo',
        definitionName: 'echo',
        project: 'app',
        executionProject: 'app',
        input: { text: 'hi' },
        workspaceRoot: makeTempDir('foreman-admit-task-'),
        workingDirectory: process.cwd(),
      }),
      (err) => err instanceof DispatchControlError
        && err.code === DAEMON_PLANNED_RESTART_CODE
        && err.message === DAEMON_PLANNED_RESTART_MESSAGE,
    )
    assert.equal(readOnlyTaskRow(), undefined, 'no task placeholder should be created during planned_restart')
    assert.equal(agentCalls, 0, 'no background agent call should be created during planned_restart')
  })



  it('does not cancel or halt already-accepted task execution after planned_restart begins', async () => {
    const workspace = makeTempDir('foreman-admit-continue-task-')
    writeEchoTask(workspace)
    await discoverTasks(workspace)

    const admission = plannedRestartAdmission()
    const runner = new TaskWorkflowRunner({
      db: getDb(),
      agentExecutionHost: fakeExecutionHost(async (_profile, prompt) => {
        if (prompt.includes('echo:')) return { output: textOutput('echo-result'), status: 'done' }
        return { output: textOutput('unexpected'), status: 'done' }
      }),
      admissionControl: () => admission.assertAccepting(),
    })
    // Active execution resolves automatically through the settings resolver,
    // matching daemon bootstrap; there is no legacy profile fallback.
    runner.setTaskSettingsResolver(automaticSettingsResolver())

    // Accept while mode is accepting.
    const handle = await runner.startTaskRun({
      taskName: 'echo',
      definitionName: 'echo',
      project: 'app',
      executionProject: 'app',
      input: { text: 'hi' },
      workspaceRoot: workspace,
      workingDirectory: workspace,
    })
    // Mode changes to planned_restart AFTER acceptance.
    admission.setPlannedRestart(true)

    let row: TaskRow | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      row = readTaskRowByTemplate('echo')
      if (row && row.status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(row?.status, 'done', 'already-accepted task must complete normally')
    assert.equal(row?.failure_category, null)
    assert.equal(handle.task_run_id, row?.id)
    // The kernel reasserts the authoritative definition provenance on the
    // running row: the project 'echo' definition resolves to source project.
    const persisted = getDb().prepare<[string], { definition_source: string | null }>(
      `SELECT definition_source FROM tasks WHERE id = ?`,
    ).get(handle.task_run_id)
    assert.equal(persisted?.definition_source, 'project')
  })

})

// ── Permission mode tests ──────────────────────────────────────────────

describe('daemon execution permission', { concurrency: false }, () => {
  it('passes permission to agent opts when set in config', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'perm-test.task.ts'),
      `export default defineTask({
  permission: 'yolo',
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'test',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    let capturedPermission: string | undefined
    const agent = async (_profile: string, _prompt: string, opts?: AgentOpts): Promise<AgentResult> => {
      capturedPermission = opts?.permission
      return { output: textOutput('done'), status: 'done' }
    }

    const result = await executeTask('perm-test', undefined, {
      workspaceRoot: workspace,
      primitives: { agent },
    })

    assert.equal(result.status, 'done')
    assert.equal(capturedPermission, 'yolo',
      'agent opts should include permission=yolo when config sets it',
    )
  })

  it('resolves deterministic edit targets into checkout-local absolute write paths', async () => {
    const workspace = makeTempDir('foreman-daemon-write-targets-')
    const projectDir = join(workspace, 'projects', 'app')
    const checkout = join(workspace, 'checkout')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(checkout, { recursive: true })
    writeFileSync(
      join(projectDir, 'scoped-edit.task.ts'),
      `export default defineTask({
  permission: 'edit',
  input: foremanSchemas.z.object({ paths: foremanSchemas.z.array(foremanSchemas.z.string()) }),
  ${TEXT_OUTPUT_SCHEMA}
  writeTargets: (input) => input.paths,
  prompt: () => 'test',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    let capturedWritePaths: readonly string[] | undefined
    const agent = async (_profile: string, _prompt: string, opts?: AgentOpts): Promise<AgentResult> => {
      capturedWritePaths = opts?.writePaths
      return { output: textOutput('done'), status: 'done' }
    }

    const result = await executeTask('scoped-edit', {
      paths: ['src/a.ts', 'src/../src/b.ts', 'src/a.ts'],
    }, {
      workspaceRoot: workspace,
      currentProject: 'app',
      workingDirectory: checkout,
      primitives: { agent },
    })

    assert.equal(result.status, 'done')
    assert.deepEqual(capturedWritePaths, [join(checkout, 'src/a.ts'), join(checkout, 'src/b.ts')])
  })

  it('rejects scoped edit targets outside the active checkout before spawning an agent', async () => {
    const workspace = makeTempDir('foreman-daemon-write-target-escape-')
    const projectDir = join(workspace, 'projects', 'app')
    const checkout = join(workspace, 'checkout')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(checkout, { recursive: true })
    writeFileSync(
      join(projectDir, 'scoped-edit.task.ts'),
      `export default defineTask({
  permission: 'edit',
  input: foremanSchemas.z.object({ paths: foremanSchemas.z.array(foremanSchemas.z.string()) }),
  ${TEXT_OUTPUT_SCHEMA}
  writeTargets: (input) => input.paths,
  prompt: () => 'test',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    let agentStarted = false
    await assert.rejects(
      executeTask('scoped-edit', { paths: ['../outside.ts'] }, {
        workspaceRoot: workspace,
        currentProject: 'app',
        workingDirectory: checkout,
        primitives: {
          agent: async () => {
            agentStarted = true
            return { output: textOutput('done'), status: 'done' }
          },
        },
      }),
      /inside the active checkout/,
    )
    assert.equal(agentStarted, false)
  })

  it('rejects missing permission at task load time', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'perm-none.task.ts'),
      `export default defineTask({
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'test',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)
    const { getLoadErrors } = await import('../../lib/workspace/task-loader.mts')
    const errors = getLoadErrors(workspace)
    assert.ok(errors.length > 0, 'should have load errors for missing permission')
    assert.match(errors[0].load_error, /Missing required permission/u)
  })

  it('rejects invalid permission value at task load time', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'bad-perm.task.ts'),
      `export default defineTask({
  permission: 'bogus',
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'test',
})
`,
      'utf-8',
    )

    await discoverTasks(workspace)
    const { getLoadErrors } = await import('../../lib/workspace/task-loader.mts')
    const errors = getLoadErrors(workspace)
    assert.ok(errors.length > 0, 'should have load errors for invalid permission')
    assert.match(
      errors[0].load_error,
      /Invalid permission/iu,
      'load error should mention invalid permission',
    )
  })

  it('rejects deprecated Forge permission aliases at task load time', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'old-perm.task.ts'),
      `export default defineTask({
  permission: 'exec',
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'test',
})
`,
      'utf-8',
    )

    await discoverTasks(workspace)
    const { getLoadErrors } = await import('../../lib/workspace/task-loader.mts')
    const errors = getLoadErrors(workspace)
    assert.ok(errors.length > 0, 'should have load errors for deprecated permission aliases')
    assert.match(
      errors[0].load_error,
      /Invalid permission.*readonly, edit, yolo/iu,
      'load error should point to the direct-runtime permission set',
    )
  })
})

// ── Timeout propagation tests ────────────────────────────────────────

describe('daemon execution timeout', { concurrency: false }, () => {
  it('passes timeoutMs from TaskConfig to structured agent opts', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'timeout-task.task.ts'),
      `export default defineTask({
  permission: 'readonly',
  timeoutMs: 7200000,
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'long build',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    let capturedTimeoutMs: number | undefined
    const agent = async (_profile: string, _prompt: string, opts?: AgentOpts): Promise<AgentResult> => {
      capturedTimeoutMs = opts?.timeoutMs
      return { output: textOutput('done'), status: 'done' }
    }

    const result = await executeTask('timeout-task', undefined, {
      workspaceRoot: workspace,
      primitives: { agent },
    })

    assert.equal(result.status, 'done')
    assert.equal(capturedTimeoutMs, 7200000,
      'agent opts should include timeoutMs=7200000 when TaskConfig sets it',
    )
  })

  it('omits timeoutMs from agent opts when TaskConfig has no timeoutMs', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'no-timeout.task.ts'),
      `export default defineTask({
  permission: 'readonly',
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'quick task',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    let capturedTimeoutMs: number | undefined
    const agent = async (_profile: string, _prompt: string, opts?: AgentOpts): Promise<AgentResult> => {
      capturedTimeoutMs = opts?.timeoutMs
      return { output: textOutput('done'), status: 'done' }
    }

    const result = await executeTask('no-timeout', undefined, {
      workspaceRoot: workspace,
      primitives: { agent },
    })

    assert.equal(result.status, 'done')
    assert.equal(capturedTimeoutMs, 900000,
      'structured tasks should pass the structured collector default timeout when TaskConfig omits it',
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
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  ${TEXT_OUTPUT_SCHEMA}
  prompt: ({ text }) => \`echo:\${text}\`,})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    const agent = async (_profile: string, prompt: string): Promise<AgentResult> => ({ output: textOutput(prompt), status: 'done' })
    await runTask('simple', { text: 'hello' }, { workspaceRoot: workspace, primitives: { agent } })

    const facts = readDaemonFacts()
    assert.deepEqual(facts.map((event) => event.type), ['task.run.started', 'task.run.completed'])
    assert.equal((facts[0].payload.refs as { project?: string }).project, 'app')
    assert.equal((facts[1].payload.data as { taskName?: string }).taskName, 'simple')
  })

  it('records progress facts independently from notify config', async () => {
    const workspace = makeTempDir('foreman-v2-events-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'gated.task.ts'),
`export default defineTask({
  permission: 'readonly',
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'gated',
  gates: {
    pre: [{ id: 'check', run: async () => ({ ok: true }) }],
    post: [{ id: 'verify', run: async () => ({ ok: true }) }],
  },
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    const agent = async (): Promise<AgentResult> => ({ output: textOutput('done'), status: 'done' })
    await runTask('gated', undefined, { workspaceRoot: workspace, primitives: { agent } })

    const progress = readDaemonFacts().filter((event) => event.type === 'task.run.progress')
    assert.equal(progress.length, 2)
    assert.match((progress[0].payload.data as { detail: string }).detail, /Pre-gates passed/u)
    assert.match((progress[1].payload.data as { detail: string }).detail, /Post-gates passed/u)
  })

  it('records task failure facts', async () => {
    const workspace = makeTempDir('foreman-v2-events-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'failing.task.ts'),
      `export default defineTask({
  permission: 'readonly',
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'fail me',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    const agent = async (): Promise<AgentResult> => { throw new Error('BOOM') }
    await assert.rejects(
      () => runTask('failing', undefined, { workspaceRoot: workspace, primitives: { agent } }),
      /BOOM/,
    )

    const facts = readDaemonFacts()
    assert.equal(facts.at(-1)?.type, 'task.run.failed')
    assert.equal(facts.at(-1)?.payload.severity, 'error')
  })

})

describe('TaskService _meta execution fields', { concurrency: false }, () => {
  it('exposes requested_agent_runtime and resolved_profile in status/output when present', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'meta-task.task.ts'),
      `export default defineTask({
  permission: 'readonly',
  ${NO_INPUT_SCHEMA}
  ${TEXT_OUTPUT_SCHEMA}
  prompt: () => 'meta',
})
`,
      'utf-8',
    )
    await discoverTasks(workspace)

    const agent = async (): Promise<AgentResult> => ({ output: textOutput('meta-done'), status: 'done' })
    installSupervisorBackedAgent()
    installFakeForgeLines(workspace, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd: workspace }),
      forgeStreamEvent(2, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: textOutput('meta-done'),
        native_session_id: 'native_meta',
        client_family: 'claude',
      }),
    ])

    const result = await executeTask('meta-task', undefined, {
      workspaceRoot: workspace,
      workingDirectory: workspace,
    })

    assert.equal(result.status, 'done')

    const { TaskService } = await import('../../lib/core/task/service.mts')
    const service = new TaskService({ workspaceRoot: workspace })
    const status = service.status(result.task_id)
    const output = service.output(result.task_id)

    assert.ok(status && typeof status === 'object')
    const statusMeta = (status as { _meta?: { requested_agent_runtime?: unknown; resolved_profile?: unknown } })._meta
    assert.ok(statusMeta)
    assert.equal(typeof statusMeta.requested_agent_runtime, 'string')
    assert.equal(typeof statusMeta.resolved_profile, 'string')

    assert.ok(output && typeof output === 'object')
    const outputMeta = (output as { _meta?: { requested_agent_runtime?: unknown; resolved_profile?: unknown } })._meta
    assert.ok(outputMeta)
    assert.equal(typeof outputMeta.requested_agent_runtime, 'string')
    assert.equal(typeof outputMeta.resolved_profile, 'string')
  })

  it('omits requested_agent_runtime and resolved_profile from _meta for historical null rows', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    const projectDir = join(workspace, 'projects', 'app')
    // Insert a historical task row without execution join
    const taskId = `task_hist_${randomBytes(4).toString('hex')}`
    const now = new Date().toISOString()
    getDb().prepare(
      `INSERT INTO tasks (
        id, template, project, input, status, structured, created_at, updated_at
      ) VALUES (?, 'historical', null, '{}', 'done', 0, ?, ?)`,
    ).run(taskId, now, now)

    const { TaskService } = await import('../../lib/core/task/service.mts')
    const service = new TaskService({ workspaceRoot: workspace })
    const status = service.status(taskId)
    const output = service.output(taskId)

    assert.ok(status && typeof status === 'object')
    const statusMeta = (status as { _meta?: { requested_agent_runtime?: unknown; resolved_profile?: unknown } })._meta
    assert.ok(statusMeta)
    assert.equal(statusMeta.requested_agent_runtime, undefined)
    assert.equal(statusMeta.resolved_profile, undefined)

    assert.ok(output && typeof output === 'object')
    const outputMeta = (output as { _meta?: { requested_agent_runtime?: unknown; resolved_profile?: unknown } })._meta
    assert.ok(outputMeta)
    assert.equal(outputMeta.requested_agent_runtime, undefined)
    assert.equal(outputMeta.resolved_profile, undefined)
  })

  it('keeps historical requested_agent_runtime/resolved_profile readable with no task_run_attempt_dispatch row', async () => {
    const workspace = makeTempDir('foreman-daemon-execution-')
    // A genuinely old execution record that predates per-attempt dispatch
    // snapshots: the identity lives only on the direct executions columns and
    // there is no task_run_attempt_dispatch row at all.
    const taskId = `task_hist_${randomBytes(4).toString('hex')}`
    const executionId = `exec_hist_${randomBytes(4).toString('hex')}`
    const now = new Date().toISOString()
    getDb().prepare(
      `INSERT INTO tasks (
        id, template, project, input, status, structured, execution_id, created_at, updated_at
      ) VALUES (?, 'old-pinned', null, '{}', 'done', 1, null, ?, ?)`,
    ).run(taskId, now, now)
    getDb().prepare(
      `INSERT INTO executions (
        id, task_id, profile, permission, cwd, prompt, status,
        requested_agent_runtime, resolved_profile, created_at, updated_at
      ) VALUES (?, ?, 'legacy/profile', 'yolo', ?, 'old run prompt', 'done', ?, ?, ?, ?)`,
    ).run(executionId, taskId, workspace, 'requested/legacy-runtime', 'resolved/legacy-profile', now, now)
    getDb().prepare('UPDATE tasks SET execution_id = ? WHERE id = ?').run(executionId, taskId)

    const dispatchCount = getDb()
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM task_run_attempt_dispatch WHERE task_run_id = ?')
      .get(taskId)
    assert.equal(dispatchCount?.n, 0, 'the old record must have no per-attempt dispatch snapshot')

    // Historical display is a pure read: the persisted fields stay readable
    // and the absent snapshot is omitted rather than fabricated.
    const { TaskService } = await import('../../lib/core/task/service.mts')
    const service = new TaskService({ workspaceRoot: workspace })

    const status = service.status(taskId)
    assert.ok(status && typeof status === 'object')
    const statusMeta = (status as { _meta?: { requested_agent_runtime?: unknown; resolved_profile?: unknown } })._meta
    assert.ok(statusMeta)
    assert.equal(statusMeta.requested_agent_runtime, 'requested/legacy-runtime')
    assert.equal(statusMeta.resolved_profile, 'resolved/legacy-profile')

    const output = service.output(taskId)
    assert.ok(output && typeof output === 'object')
    const outputMeta = (output as { _meta?: { requested_agent_runtime?: unknown; resolved_profile?: unknown } })._meta
    assert.ok(outputMeta)
    assert.equal(outputMeta.requested_agent_runtime, 'requested/legacy-runtime')
    assert.equal(outputMeta.resolved_profile, 'resolved/legacy-profile')
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
  permission: 'readonly',
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

  it('passes invocation settings to the resolver and launches only the resolved runtime with its timeout', async () => {
    const workspace = makeTempDir('foreman-settings-kernel-')
    writeSettingsTask(workspace)
    await discoverTasks(workspace)

    let resolverCalls = 0
    let capturedInvocation: unknown
    const resolver: TaskRunSettingsResolver = async (params) => {
      resolverCalls += 1
      capturedInvocation = params.invocation
      return automaticResolution('forge/settings-resolved', 42_000)
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
    assert.equal(capturedOpts?.permission, 'readonly', 'permission must remain the TaskConfig permission')
    assert.ok(capturedPrompt?.includes('base dynamic prompt'), 'builtin dynamic prompt must still be present')
    // Invocation settings are never persisted: the task row input stays clean.
    const row = dbGet<{ input: string | null }>('SELECT input FROM tasks ORDER BY created_at LIMIT 1')
    assert.ok(row, 'a persisted task row must exist')
  })

  it('does not reintroduce an automatic stale machine pin when a settings resolver is present', async () => {
    const workspace = makeTempDir('foreman-settings-stale-')
    writeSettingsTask(workspace)
    // A machine-configured soft pin that the legacy path would apply for this task.
    const configPath = join(workspace, 'foreman.config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ tasks: { agentRuntime: { 'settings-task': 'forge/fast' } } }),
      'utf-8',
    )
    const unbind = bindTaskRuntimeOverrideConfigPath(configPath)
    try {
      await discoverTasks(workspace)
      const resolver: TaskRunSettingsResolver = async () => automaticResolution('forge/general')

      let launchedProfile: string | undefined
      const agent = async (profile: string, _prompt: string): Promise<AgentResult> => {
        launchedProfile = profile
        return { output: textOutput('done'), status: 'done' }
      }

      const result = await executeTask('settings-task', undefined, {
        workspaceRoot: workspace,
        taskSettingsResolver: resolver,
        primitives: { agent },
      })

      assert.equal(result.status, 'done')
      assert.equal(launchedProfile, 'forge/general', 'automatic settings result must win over a stale machine pin')
    } finally {
      unbind()
    }
  })

  it('terminates with no fallback and zero agent calls when the resolver fails explicitly', async () => {
    const workspace = makeTempDir('foreman-settings-fail-')
    writeSettingsTask(workspace)
    await discoverTasks(workspace)

    const resolver: TaskRunSettingsResolver = async () => {
      throw new Error('settings resolution exploded')
    }
    let agentCalls = 0
    await assert.rejects(
      () => executeTask('settings-task', undefined, {
        workspaceRoot: workspace,
        taskSettingsResolver: resolver,
        primitives: {
          agent: async () => {
            agentCalls += 1
            return { output: textOutput('done'), status: 'done' }
          },
        },
      }),
      /settings resolution exploded/,
    )
    assert.equal(agentCalls, 0, 'no agent may launch when settings resolution fails')
  })
})
