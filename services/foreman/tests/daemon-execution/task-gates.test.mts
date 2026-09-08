import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { describeTask, discoverTasks, listTasks, resetRegistry } from '../../lib/workspace/task-loader.mts'
import { isGateError } from '../../lib/core/task/failure.mts'
import { invalidateProjectCache } from '../../lib/core/project/loader.mts'
import type { AgentResult, ExecutionOptions, TaskExecutionResult, TaskRunSettingsResolver } from '../../lib/types.mts'
import { closeDb, get as dbGet, initDb, run as dbRun } from '../../lib/db/connection.mts'
import { DaemonTaskRunner } from '../../lib/daemon/execution/task-runner.mts'
import { getForemanEventBus, resetForemanEventBusForTest } from '../../lib/events/event-bus.mts'
import type { ForemanEvent } from '../../lib/events/event-types.mts'

let tempDirs: string[] = []

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

function executeTask(name: string, input: unknown, opts: ExecutionOptions | string): Promise<TaskExecutionResult> {
  return new DaemonTaskRunner().execute(name, input, normalizeExecutionOptions(opts))
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
  closeDb()
  initDb(':memory:')
  resetRegistry()
  invalidateProjectCache()
})

afterEach(() => {
  resetRegistry()
  invalidateProjectCache()
  closeDb()
  resetForemanEventBusForTest()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

type TaskRow = {
  status: string
  failure_category: string | null
  error_message: string | null
}


function readOnlyTaskRow(): TaskRow | undefined {
  return dbGet<TaskRow>('SELECT status, failure_category, error_message FROM tasks ORDER BY created_at LIMIT 1')
}

function captureTaskRunEvents(taskRunId: string): { events: ForemanEvent[]; stop: () => void } {
  const events: ForemanEvent[] = []
  const stop = getForemanEventBus().subscribe({
    handle(event: ForemanEvent) {
      const refId = (event.refs as { taskId?: string } | undefined)?.taskId
      if (refId === taskRunId) events.push(event)
    },
  })
  return { events, stop }
}


describe('daemon task gates', () => {
  function stripOutputContract(text: string): string {
    return text.split('\n\n<foreman-output-contract')[0]?.trim() ?? text
  }

  function xmlOutput(data: unknown, summary = 'Done.'): string {
    return `<foreman-task-output>
<summary>
${summary}
</summary>
<result>
${JSON.stringify(data)}
</result>
</foreman-task-output>`
  }

  function textOutput(text: string): string {
    return xmlOutput({ result: stripOutputContract(text) })
  }

  const mockAgent = async (_profile: string, prompt: string): Promise<AgentResult> => ({ output: textOutput(prompt), status: 'done' })

  it('fails an active task without dispatch requirements before invoking a model', async () => {
    const workspace = makeTempDir('foreman-v2-dispatch-required-')
    const projectDir = join(workspace, 'projects', 'app')
    writeFileSync(join(projectDir, 'missing-dispatch.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: () => 'must-not-run',
})\n`, 'utf-8')
    await discoverTasks(workspace)
    let modelCalls = 0

    await assert.rejects(
      new DaemonTaskRunner().execute('missing-dispatch', {}, {
        workspaceRoot: workspace,
        currentProject: 'app',
        taskDispatchResolver: {
          resolve() {
            throw new Error('resolver must not run without requirements')
          },
          eligible() {
            throw new Error('resolver must not run without requirements')
          },
          resolveExplicit() {
            throw new Error('resolver must not run without requirements')
          },
          listExactRuntimes() {
            throw new Error('resolver must not run without requirements')
          },
        },
        primitives: {
          agent: async () => {
            modelCalls += 1
            return { output: textOutput('unexpected'), status: 'done' }
          },
        },
      }),
      /automatic selection requires a taskSettingsResolver or dispatch requirements with a taskDispatchResolver/u,
    )

    assert.equal(modelCalls, 0)
  })

  it('passes when all pre-gates and post-gates pass', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'echo.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'echo:' + text,
  gates: {
    pre: [
      { id: 'input-check', description: 'Verify text is not empty', run: (ctx) => ({ ok: true }) },
    ],
    post: [
      {
        id: 'output-check',
        description: 'Verify output starts with echo:',
        run: (ctx) => {
          const result = ctx.output && typeof ctx.output === 'object' ? ctx.output.result : undefined
          return typeof result === 'string' && result.startsWith('echo:')
            ? { ok: true }
            : { ok: false, expected: 'output.result starting with echo:', actual: String(result) }
        },
      },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    const result = await executeTask('echo', { text: 'hello' }, {
      workspaceRoot: workspace,
      primitives: { agent: mockAgent },
    })
    assert.equal(result.status, 'done')
    assert.deepEqual(result.output, { result: 'echo:hello' })
  })

  it('fails at first failing pre-gate and persists structured failure', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'gated.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'echo:' + text,
  gates: {
    pre: [
      { id: 'passing', run: (ctx) => ({ ok: true }) },
      {
        id: 'failing-gate',
        description: 'Always fails',
        run: (ctx) => ({
          ok: false,
          expected: 'success',
          actual: 'failure',
          evidence: { reason: 'test failure' },
          remediation: 'Fix the issue',
        }),
      },
      { id: 'should-not-run', run: (ctx) => ({ ok: true }) },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    let caught: any
    try {
      await executeTask('gated', { text: 'hello' }, { workspaceRoot: workspace, primitives: { agent: mockAgent } })
      assert.fail('expected executeTask to throw')
    } catch (err) {
      caught = err
    }

    assert.ok(isGateError(caught), 'error should be GateFailureError')
    assert.equal(caught.failure_category, 'gate_failed')
    assert.equal(caught.failure.phase, 'pre')
    assert.equal(caught.failure.gate_id, 'failing-gate')
    assert.equal(caught.failure.expected, 'success')
    assert.equal(caught.failure.actual, 'failure')
    assert.deepEqual(caught.failure.evidence, { reason: 'test failure' })
    assert.equal(caught.failure.remediation, 'Fix the issue')

    // Verify task record persistence
    const record = readOnlyTaskRow()
    assert.equal(record?.status, 'failed')
    assert.equal(record?.failure_category, 'gate_failed')
    const errMsg = record?.error_message ?? ''
    const parsed = JSON.parse(errMsg)
    assert.equal(parsed.type, 'gate_failed')
    assert.equal(parsed.phase, 'pre')
    assert.equal(parsed.gate_id, 'failing-gate')
  })

  it('fails at first failing post-gate after task succeeds', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'gated.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'result:' + text,
  gates: {
    post: [
      {
        id: 'post-fail',
        run: (ctx) => ({
          ok: false,
          expected: 'output matching pattern',
          actual: String(ctx.output),
          remediation: 'Try again',
        }),
      },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    let caught: any
    try {
      await executeTask('gated', { text: 'hello' }, { workspaceRoot: workspace, primitives: { agent: mockAgent } })
      assert.fail('expected executeTask to throw')
    } catch (err) {
      caught = err
    }

    assert.ok(isGateError(caught))
    assert.equal(caught.failure.phase, 'post')
    assert.equal(caught.failure.gate_id, 'post-fail')
  })

  it('shares state bag between pre-gates and post-gates', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'gated.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'result:' + text,
  gates: {
    pre: [
      {
        id: 'set-before-head',
        run: (ctx) => {
          ctx.state.beforeHead = 'abc123'
          return { ok: true }
        },
      },
    ],
    post: [
      {
        id: 'check-before-head',
        run: (ctx) => {
          if (ctx.state.beforeHead !== 'abc123') {
            return { ok: false, expected: 'abc123', actual: String(ctx.state.beforeHead) }
          }
          return { ok: true }
        },
      },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    const result = await executeTask('gated', { text: 'hello' }, {
      workspaceRoot: workspace,
      primitives: { agent: mockAgent },
    })
    assert.equal(result.status, 'done')
  })

  it('shell helper runs in workDir', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    // Use a portable cwd check; Windows cmd does not provide pwd.
    writeFileSync(join(projectDir, 'gated.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'result:' + text,
  gates: {
    post: [
      {
        id: 'shell-check',
        run: async (ctx) => {
          const result = await ctx.shell('node -e "console.log(process.cwd())"')
          if (!result.stdout.trim().endsWith('app')) {
            return { ok: false, expected: 'cwd ending in workspace', actual: result.stdout.trim() }
          }
          return { ok: true }
        },
      },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    const result = await executeTask('gated', { text: 'hello' }, {
      workspaceRoot: workspace,
      workingDirectory: projectDir,
      primitives: {
        agent: mockAgent,
        shell: async (cmd, opts) => {
          return { exitCode: 0, stdout: opts?.cwd ?? process.cwd(), stderr: '' }
        },
      },
    })
    assert.equal(result.status, 'done')
  })

  it('retries a failing gate up to maxAttempts', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'gated.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'result:' + text,
  gates: {
    pre: [
      {
        id: 'retry-gate',
        retry: { maxAttempts: 3 },
        run: (ctx) => {
          if (!ctx.state.counter) ctx.state.counter = 0
          ctx.state.counter = (ctx.state.counter as number) + 1
          if ((ctx.state.counter as number) < 3) {
            return { ok: false, expected: '3rd attempt', actual: 'attempt ' + ctx.state.counter }
          }
          return { ok: true, evidence: ctx.state.counter }
        },
      },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    const result = await executeTask('gated', { text: 'hello' }, {
      workspaceRoot: workspace,
      primitives: { agent: mockAgent },
    })
    assert.equal(result.status, 'done')
  })

  it('fails after exhausting retry attempts', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'gated.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'result:' + text,
  gates: {
    pre: [
      {
        id: 'always-fail',
        retry: { maxAttempts: 2 },
        run: (ctx) => ({
          ok: false,
          expected: 'should work',
          actual: 'always fails',
        }),
      },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    let caught: any
    try {
      await executeTask('gated', { text: 'hello' }, { workspaceRoot: workspace, primitives: { agent: mockAgent } })
      assert.fail('expected executeTask to throw')
    } catch (err) {
      caught = err
    }

    assert.ok(isGateError(caught))
    assert.equal(caught.failure.gate_id, 'always-fail')
  })


  it('reports scheduled gates in task_describe', async () => {
    // Verify gate metadata is exposed via describeTask. We test this
    // by creating a task with gates and checking the ListedDefinition.
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'gated.task.ts'), `export default defineTask({
  permission: 'readonly',
  description: 'Task with gates',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'result:' + text,
  gates: {
    pre: [
      { id: 'check-setup', description: 'Verify preconditions' },
    ],
    post: [
      { id: 'validate-output', description: 'Check output format' },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    const desc = describeTask('gated', workspace, 'app')
    assert.ok(desc, 'task should be described')
    assert.ok(desc?.gates, 'gates metadata should be present')
    assert.ok(desc?.gates?.pre)
    assert.equal(desc?.gates?.pre?.[0].id, 'check-setup')
    assert.equal(desc?.gates?.pre?.[0].description, 'Verify preconditions')
    assert.ok(desc?.gates?.post)
    assert.equal(desc?.gates?.post?.[0].id, 'validate-output')
    assert.equal(desc?.gates?.post?.[0].description, 'Check output format')

    // Also check listTasks
    const tasks = listTasks(workspace, 'app')
    const listed = tasks.find((t) => t.name === 'gated')
    assert.ok(listed, 'task should appear in listTasks')
    assert.equal(listed?.gates?.pre?.[0].id, 'check-setup')
    assert.equal(listed?.gates?.post?.[0].id, 'validate-output')
  })

  it('publishes exactly one task.run.failed event with matching refs.taskId', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'gated.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'result:' + text,
  gates: {
    post: [
      {
        id: 'post-fail',
        run: (ctx) => ({
          ok: false,
          expected: 'output matching pattern',
          actual: String(ctx.output),
          remediation: 'Try again',
        }),
      },
    ],
  },
})\n`, 'utf-8')
    await discoverTasks(workspace)

    const taskId = 'evt_failed'
    const captured = captureTaskRunEvents(taskId)
    let caught: any
    try {
      await executeTask('gated', { text: 'hello' }, {
        workspaceRoot: workspace,
        taskId,
        primitives: { agent: mockAgent },
      })
      assert.fail('expected executeTask to throw')
    } catch (err) {
      caught = err
    }
    captured.stop()

    assert.ok(isGateError(caught))
    const finals = captured.events.filter((e) => e.kind === 'task.run.failed')
    assert.equal(finals.length, 1, 'exactly one terminal task.run.failed event must be published')
    assert.equal((finals[0].refs as { taskId?: string }).taskId, taskId, 'refs.taskId must equal the task run id')
  })

  it('publishes exactly one task.run.cancelled event with matching refs.taskId', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'echo.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'echo:' + text,
})\n`, 'utf-8')
    await discoverTasks(workspace)

    const taskId = 'evt_cancelled'
    const cancelledAgent = async (_profile: string, _prompt: string): Promise<AgentResult> => {
      const error = new Error('task cancelled')
      ;(error as { failure_category?: string }).failure_category = 'task_cancelled'
      ;(error as { error_message?: string }).error_message = JSON.stringify({
        type: 'task_cancelled',
        task_run_id: taskId,
        status: 'cancelled',
      })
      throw error
    }

    const captured = captureTaskRunEvents(taskId)
    let caught: any
    try {
      await executeTask('echo', { text: 'hello' }, {
        workspaceRoot: workspace,
        taskId,
        primitives: { agent: cancelledAgent },
      })
      assert.fail('expected executeTask to throw')
    } catch (err) {
      caught = err
    }
    captured.stop()

    assert.ok(caught)
    const finals = captured.events.filter((e) => e.kind === 'task.run.cancelled')
    assert.equal(finals.length, 1, 'exactly one terminal task.run.cancelled event must be published')
    assert.equal((finals[0].refs as { taskId?: string }).taskId, taskId, 'refs.taskId must equal the task run id')
  })

  it('publishes exactly one task.run.interrupted event with matching refs.taskId', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'echo.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'echo:' + text,
})\n`, 'utf-8')
    await discoverTasks(workspace)

    const taskId = 'evt_interrupted'
    const interruptedAgent = async (_profile: string, _prompt: string): Promise<AgentResult> => {
      const error = new Error('task interrupted')
      ;(error as { failure_category?: string }).failure_category = 'task_interrupted'
      ;(error as { error_message?: string }).error_message = JSON.stringify({
        type: 'task_interrupted',
        task_run_id: taskId,
        status: 'interrupted',
      })
      throw error
    }

    const captured = captureTaskRunEvents(taskId)
    let caught: any
    try {
      await executeTask('echo', { text: 'hello' }, {
        workspaceRoot: workspace,
        taskId,
        primitives: { agent: interruptedAgent },
      })
      assert.fail('expected executeTask to throw')
    } catch (err) {
      caught = err
    }
    captured.stop()

    assert.ok(caught)
    const finals = captured.events.filter((e) => e.kind === 'task.run.interrupted')
    assert.equal(finals.length, 1, 'exactly one terminal task.run.interrupted event must be published')
    assert.equal((finals[0].refs as { taskId?: string }).taskId, taskId, 'refs.taskId must equal the task run id')
  })

  it('emits no final task lifecycle event on a losing late terminal update', async () => {
    const workspace = makeTempDir('foreman-v2-gate-')
    const projectDir = join(workspace, 'projects', 'app')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'echo.task.ts'), `export default defineTask({
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => 'echo:' + text,
})\n`, 'utf-8')
    await discoverTasks(workspace)

    // Pre-commit the task row as cancelled so a late run attempt loses the
    // terminal compare-and-set and must emit nothing.
    const taskId = 'evt_late_cas'
    const now = new Date().toISOString()
    dbRun(
      `INSERT INTO tasks (id, template, project, status, retry_policy, created_at, updated_at)
       VALUES (?, 'echo', 'app', 'cancelled', 'side-effects', ?, ?)`,
      taskId,
      now,
      now,
    )

    const captured = captureTaskRunEvents(taskId)
    const result = await executeTask('echo', { text: 'hello' }, {
      workspaceRoot: workspace,
      taskId,
      primitives: { agent: mockAgent },
    })
    captured.stop()

    assert.equal(result.status, 'cancelled', 'late attempt must observe the already-terminal status')
    const finals = captured.events.filter((e) => e.kind?.startsWith('task.run.'))
    assert.equal(finals.length, 0, 'a losing late terminal update must emit no task lifecycle event')
  })
})
