import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { ForemanDatabase } from '../../../lib/db/types.mts'
import { AgentExecutionSupervisor, ExecutionTerminationFailure } from '../../../lib/daemon/execution/agent-supervisor.mts'
import { RepoWriteLocks } from '../../../lib/daemon/execution/repo-write-locks.mts'
import { closeTestDb, initTestDb } from '../../helpers/test-db.mts'

interface RawResultRow {
  raw_result: string | null
  output: string | null
}

interface NativeSessionRow {
  native_session_id: string | null
  client_family: string | null
  output: string | null
}

interface EventRow {
  type: string
  data: string | null
}

let db: ForemanDatabase
let oldForgeBin: string | undefined
let oldForgeArgsPrefix: string | undefined
let tempDirs: string[] = []
let scriptCounter = 0
let supervisors: AgentExecutionSupervisor[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeSupervisor(repoWriteLocks?: RepoWriteLocks): AgentExecutionSupervisor {
  const locks = repoWriteLocks ?? new RepoWriteLocks()
  const supervisor = new AgentExecutionSupervisor({ db, repoWriteLocks: locks })
  supervisors.push(supervisor)
  return supervisor
}

beforeEach(() => {
  oldForgeBin = process.env.WRENYARD_RUNTIME_BIN
  oldForgeArgsPrefix = process.env.WRENYARD_FORGE_ARGS_PREFIX
  db = initTestDb()
})

afterEach(async () => {
  const shutdownErrors: unknown[] = []
  await Promise.allSettled(supervisors.map((s) => s.shutdown())).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') shutdownErrors.push(r.reason)
    }
  })

  if (oldForgeBin === undefined) delete process.env.WRENYARD_RUNTIME_BIN
  else process.env.WRENYARD_RUNTIME_BIN = oldForgeBin
  if (oldForgeArgsPrefix === undefined) delete process.env.WRENYARD_FORGE_ARGS_PREFIX
  else process.env.WRENYARD_FORGE_ARGS_PREFIX = oldForgeArgsPrefix

  closeTestDb()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
  supervisors = []

  if (shutdownErrors.length > 0) {
    throw new Error(
      `supervisor shutdown failures: ${shutdownErrors.map((e) => String(e)).join('; ')}`,
    )
  }
})

describe('AgentExecutionSupervisor', { concurrency: false }, () => {
  it('queues same-repo write executions until the in-memory repo lock is released', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-lock-')
    const firstStartedPath = join(cwd, 'first-started')
    const releasePath = join(cwd, 'release-first')
    const promptLogPath = join(cwd, 'prompt-log')
    installBlockingFakeForge(cwd, firstStartedPath, releasePath, promptLogPath)

    const supervisor = makeSupervisor()
    const first = await supervisor.startExecution({
      profile: 'test',
      permission: 'edit',
      cwd,
      prompt: 'first writer',
    })
    await waitForFile(firstStartedPath)

    const second = await supervisor.startExecution({
      profile: 'test',
      permission: 'edit',
      cwd,
      prompt: 'second writer',
    })

    await sleep(60)
    assert.deepEqual(readFileSync(promptLogPath, 'utf-8').trim().split('\n'), ['first writer'])

    writeFileSync(releasePath, 'release', 'utf-8')
    assert.equal((await first.wait()).status, 'done')
    assert.equal((await second.wait()).status, 'done')
    assert.deepEqual(readFileSync(promptLogPath, 'utf-8').trim().split('\n'), ['first writer', 'second writer'])
  })

  it('starts same-repo edit executions concurrently when their exact target paths differ', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-scoped-lock-')
    const firstStartedPath = join(cwd, 'first-started')
    const releasePath = join(cwd, 'release-first')
    const promptLogPath = join(cwd, 'prompt-log')
    installBlockingFakeForge(cwd, firstStartedPath, releasePath, promptLogPath)

    const supervisor = makeSupervisor()
    const first = await supervisor.startExecution({
      profile: 'test',
      permission: 'edit',
      cwd,
      prompt: 'first writer',
      writePaths: [join(cwd, 'src/a.ts')],
    })
    await waitForFile(firstStartedPath)

    const second = await supervisor.startExecution({
      profile: 'test',
      permission: 'edit',
      cwd,
      prompt: 'second writer',
      writePaths: [join(cwd, 'src/b.ts')],
    })

    assert.equal((await second.wait()).status, 'done',
      'the disjoint edit must finish while the first writer is still blocked')
    assert.deepEqual(readFileSync(promptLogPath, 'utf-8').trim().split('\n'), ['first writer', 'second writer'])

    writeFileSync(releasePath, 'release', 'utf-8')
    assert.equal((await first.wait()).status, 'done')
  })

  it('treats Forge Agent Stream v1 envelope events as the terminal result', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'message', { role: 'assistant', text: 'v1 envelope output' }),
      forgeStreamEvent(3, 'turn_usage', { input_tokens: 14, output_tokens: 3, duration_ms: 456 }),
      forgeStreamEvent(4, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'v1 envelope output',
        native_session_id: 'native-v1-1',
        client_family: 'claude',
        usage: { input_tokens: 14, output_tokens: 3, duration_ms: 456 },
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit v1 envelope events',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')
    assert.equal(result.output, 'v1 envelope output')

    const execution = db.prepare<unknown[], NativeSessionRow>(
      `SELECT native_session_id, client_family, output
      FROM executions
      WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(execution, 'expected execution row')
    assert.equal(execution.native_session_id, 'native-v1-1')
    assert.equal(execution.client_family, 'claude')
    assert.equal(execution.output, 'v1 envelope output')

    const rows = db.prepare<unknown[], EventRow>(
      `SELECT type, data FROM events WHERE execution_id = ? ORDER BY seq`,
    ).all(handle.executionId)
    assert.ok(rows.some((row) => row.type === 'message' && row.data?.includes('v1 envelope output')))
    const usage = rows.find((row) => row.type === 'turn_usage')
    assert.ok(usage?.data, 'expected turn_usage event data')
    assert.equal((JSON.parse(usage.data) as Record<string, unknown>).input_tokens, 14)
  })

  it('persists Codex command execution items as tool call events', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', { profile: 'codex-test', client_family: 'codex', cwd }),
      forgeStreamEvent(2, 'item.started', {
        item: {
          id: 'item_shell_1',
          type: 'command_execution',
          command: 'npm test',
        },
      }),
      forgeStreamEvent(3, 'item.completed', {
        item: {
          id: 'item_shell_1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'all tests passed',
          exit_code: 0,
          status: 'completed',
        },
      }),
      forgeStreamEvent(4, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'done',
        native_session_id: 'native-codex-tools',
        client_family: 'codex',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'codex-test',
      permission: 'readonly',
      cwd,
      prompt: 'emit codex command execution item',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const rows = db.prepare<unknown[], EventRow>(
      `SELECT type, data FROM events WHERE execution_id = ? ORDER BY seq`,
    ).all(handle.executionId)

    const toolCall = rows.find((row) => row.type === 'tool_call')
    assert.ok(toolCall?.data, 'expected command execution to produce tool_call')
    const callData = JSON.parse(toolCall.data) as Record<string, unknown>
    assert.equal(callData.name, 'command_execution')
    assert.equal(callData.call_id, 'item_shell_1')
    assert.equal(callData.input_summary, 'npm test')

    const toolResult = rows.find((row) => row.type === 'tool_result')
    assert.ok(toolResult?.data, 'expected command execution to produce tool_result')
    const resultData = JSON.parse(toolResult.data) as Record<string, unknown>
    assert.equal(resultData.call_id, 'item_shell_1')
    assert.equal(resultData.status, 'ok')
    assert.equal(resultData.output_tail, 'all tests passed')
  })

  it('captures OpenCode native session ids from Forge Agent Stream v1 events', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', { profile: 'opencode-test', client_family: 'opencode', cwd }),
      forgeStreamEvent(2, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'opencode output',
        native_session_id: 'ses_opencode_direct_1',
        client_family: 'opencode',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'opencode-test',
      permission: 'readonly',
      cwd,
      prompt: 'emit opencode native session',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')
    assert.equal(result.output, 'opencode output')

    const execution = db.prepare<unknown[], NativeSessionRow>(
      `SELECT native_session_id, client_family, output
      FROM executions
      WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(execution, 'expected execution row')
    assert.equal(execution.native_session_id, 'ses_opencode_direct_1')
    assert.equal(execution.client_family, 'opencode')
  })

  it('captures native session ids only from run_finished protocol events', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'message', {
        role: 'assistant',
        text: 'non-terminal message output',
        native_session_id: 'native-from-message',
        client_family: 'claude',
      }),
      forgeStreamEvent(3, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'canonical terminal output',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit non-terminal native id',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')
    assert.equal(result.output, 'canonical terminal output')

    const execution = db.prepare<unknown[], NativeSessionRow>(
      `SELECT native_session_id, client_family, output
      FROM executions
      WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(execution, 'expected execution row')
    assert.equal(execution.native_session_id, null)
    assert.equal(execution.client_family, null)
  })

  it('passes prompts to Forge direct runtime through stdin instead of argv', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    const argvPath = join(cwd, 'argv.json')
    const stdinPath = join(cwd, 'stdin.txt')
    installFakeForgeRecorder(cwd, argvPath, stdinPath, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'stdin prompt ok',
      }),
    ])

    const supervisor = makeSupervisor()
    const prompt = 'emit via stdin\nwith shell-sensitive chars: $PATH && "quoted"'
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt,
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[]
    assert.equal(argv.includes(prompt), false)
    assert.equal(readFileSync(stdinPath, 'utf-8'), prompt)
  })

  it('rejects bare raw stream events without the Forge Agent Stream v1 envelope', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      { type: 'run_started', profile: 'test', client_family: 'claude', cwd },
      { type: 'message', role: 'assistant', text: 'bare direct runtime output' },
      { type: 'turn_usage', input_tokens: 10, output_tokens: 2, duration_ms: 123 },
      { type: 'run_finished', status: 'done', exit_code: 0 },
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit bare direct runtime events',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'failed')
    assert.equal(result.output, null)
    assert.match(result.error ?? '', /no terminal event/u)

    const rows = db.prepare<unknown[], EventRow>(
      `SELECT type, data FROM events WHERE execution_id = ? ORDER BY seq`,
    ).all(handle.executionId)
    assert.equal(rows.some((row) => row.type === 'message'), false)
    assert.equal(rows.some((row) => row.type === 'turn_usage'), false)
  })

  it('skips malformed stream-json lines while preserving the terminal Forge Agent Stream v1 result', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeOutput(cwd, [
      'this is not json',
      JSON.stringify(forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd })),
      JSON.stringify(forgeStreamEvent(2, 'message', { role: 'assistant', text: 'survived malformed input' })),
      JSON.stringify(forgeStreamEvent(3, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'survived malformed input',
      })),
      '',
    ].join('\n'))

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit one malformed line',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')
    assert.equal(result.output, 'survived malformed input')
  })

  it('treats Forge Agent Stream v1 run_finished failures as failed executions', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'error', { message: 'provider rejected the request' }),
      forgeStreamEvent(3, 'run_finished', {
        status: 'failed',
        exit_code: 1,
        summary: 'agent failed',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit failed v1 terminal event',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'failed')
    assert.equal(result.exitCode, 0)
    assert.equal(result.output, 'agent failed')
    assert.match(result.error ?? '', /agent failed|provider rejected/u)
  })

  it('redacts secret fields from final stream events before persisting raw_result', async () => {
    const row = await runFinalEvent(runFinishedFinalEvent())
    assert.equal(row.output, 'safe final output')
    assert.ok(row.raw_result, 'expected raw_result to be persisted')
    assert.doesNotMatch(row.raw_result, /tok-final-secret|api-key-final-secret|Bearer final-auth-secret/u)
    assert.doesNotMatch(row.raw_result, /private-key-secret|access-key-secret|credential-secret|json-string-token-secret/u)
    assert.doesNotMatch(row.raw_result, /private-camel-secret|access-camel-secret|api-hyphen-secret/u)
    assert.match(row.raw_result, /\[REDACTED\]/u)

    const raw = JSON.parse(row.raw_result) as Record<string, unknown>
    assert.equal(raw.type, 'run_finished')
    const data = raw.data as Record<string, unknown>
    assert.equal(data.summary, 'safe final output')
    const debugPayloadText = data.debug_payload
    assert.ok(typeof debugPayloadText === 'string')
    const debugPayload = JSON.parse(debugPayloadText) as Record<string, unknown>
    assert.equal(debugPayload.token, '[REDACTED]')
    assert.equal(debugPayload.keep, 'json string debug')
  })

  it('passes capabilities to the spawned Forge argv as --cap pairs', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-cap-')
    const argvPath = join(cwd, 'argv.json')
    const stdinPath = join(cwd, 'stdin.txt')
    installFakeForgeRecorder(cwd, argvPath, stdinPath, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'capabilities test',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'test capabilities',
      capabilities: ['browser-use', 'computer-use'],
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[]
    const capIdx1 = argv.indexOf('--cap')
    assert.notEqual(capIdx1, -1, 'argv must contain --cap for first capability')
    assert.equal(argv[capIdx1 + 1], 'browser-use')
    const capIdx2 = argv.indexOf('--cap', capIdx1 + 1)
    assert.notEqual(capIdx2, -1, 'argv must contain --cap for second capability')
    assert.equal(argv[capIdx2 + 1], 'computer-use')
  })

  it('passes no --cap flags when capabilities are absent or empty', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-nocap-')
    const argvPath = join(cwd, 'argv.json')
    const stdinPath = join(cwd, 'stdin.txt')
    installFakeForgeRecorder(cwd, argvPath, stdinPath, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'no capabilities test',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'test no capabilities',
      capabilities: [],
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const argv = JSON.parse(readFileSync(argvPath, 'utf-8')) as string[]
    assert.equal(argv.indexOf('--cap'), -1, 'argv must not contain --cap when capabilities is empty')
  })

  it('ignores legacy native terminal event types inside the Forge Agent Stream v1 envelope', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'result', {
        subtype: 'success',
        is_error: false,
        session_id: 'native_result_session',
        result: 'legacy native result output',
        usage: { input_tokens: 8, output_tokens: 2, duration_ms: 99 },
      }),
      forgeStreamEvent(2, 'turn.completed', {
        status: 'completed',
        output: 'legacy native turn output',
        usage: { input_tokens: 9, output_tokens: 3, duration_ms: 111 },
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit legacy native terminal events',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'failed')
    assert.equal(result.output, null)
    assert.match(result.error ?? '', /no terminal event/u)

    const rows = db.prepare<unknown[], EventRow>(
      `SELECT type, data FROM events WHERE execution_id = ? ORDER BY seq`,
    ).all(handle.executionId)
    assert.equal(rows.some((row) => row.type === 'turn_usage'), false)
  })

  it('persists the exact agent_turn_v1 three-field contract on turn_usage events and yields honest telemetry', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-scope-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'turn_usage', {
        input_tokens: 30,
        output_tokens: 2000,
        duration_ms: 4000,
        token_scope: 'agent_turn',
        duration_scope: 'agent_turn',
        tps_contract: 'agent_turn_v1',
      }),
      forgeStreamEvent(3, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'scoped usage',
      }),
    ])

    const taskId = 'task_usage_scope'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit scoped usage',
      taskId,
    })
    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const rows = db.prepare<unknown[], EventRow>(
      `SELECT type, data FROM events WHERE execution_id = ? ORDER BY seq`,
    ).all(handle.executionId)
    const usage = rows.find((row) => row.type === 'turn_usage')
    assert.ok(usage?.data, 'expected a persisted turn_usage event')
    const usageData = JSON.parse(usage.data) as Record<string, unknown>
    assert.equal(usageData.token_scope, 'agent_turn', 'the exact token_scope must reach the persisted event')
    assert.equal(usageData.duration_scope, 'agent_turn', 'the exact duration_scope must reach the persisted event')
    assert.equal(usageData.tps_contract, 'agent_turn_v1', 'the exact tps_contract must reach the persisted event')
    assert.notEqual(usageData.token_scope, '[REDACTED]', 'token_scope is structural usage provenance, not a credential')
    assert.equal(usageData.output_tokens, 2000)
    assert.equal(usageData.duration_ms, 4000)

    const telemetry = db.prepare<[string], { output_tokens: number; agent_turn_ms: number; usage_event_count: number; tps_complete: number }>(
      `SELECT output_tokens, agent_turn_ms, usage_event_count, tps_complete
      FROM task_run_telemetry WHERE task_run_id = ?`,
    ).get(taskId)
    assert.ok(telemetry, 'expected a durable telemetry row')
    assert.equal(telemetry.output_tokens, 2000)
    assert.equal(telemetry.agent_turn_ms, 4000)
    assert.equal(telemetry.usage_event_count, 1)
    assert.equal(telemetry.tps_complete, 1, 'a genuine agent_turn_v1 event must keep TPS enabled')
  })

  it('omits missing provenance and never upgrades wrong token/duration/contract values on persisted usage events', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-scope-omit-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'turn_usage', {
        input_tokens: 5,
        output_tokens: 100,
        duration_ms: 200,
      }),
      forgeStreamEvent(3, 'turn_usage', {
        input_tokens: 5,
        output_tokens: 150,
        duration_ms: 300,
        token_scope: 'model_output',
        duration_scope: 'model_output',
        tps_contract: 'agent_turn_v0',
      }),
      forgeStreamEvent(4, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'unscoped usage',
      }),
    ])

    const taskId = 'task_usage_scope_omit'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit unscoped usage',
      taskId,
    })
    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const rows = db.prepare<unknown[], EventRow>(
      `SELECT type, data FROM events WHERE execution_id = ? ORDER BY seq`,
    ).all(handle.executionId)
    const usageRows = rows.filter((row) => row.type === 'turn_usage')
    assert.equal(usageRows.length, 2)
    const missingScope = JSON.parse(usageRows[0].data!) as Record<string, unknown>
    assert.equal('token_scope' in missingScope, false, 'a missing token_scope must be omitted, not fabricated')
    assert.equal('duration_scope' in missingScope, false, 'a missing duration_scope must be omitted, not fabricated')
    assert.equal('tps_contract' in missingScope, false, 'a missing tps_contract must be omitted, not fabricated')
    const otherScope = JSON.parse(usageRows[1].data!) as Record<string, unknown>
    assert.equal(otherScope.token_scope, 'model_output', 'a wrong token_scope must be preserved, never upgraded')
    assert.equal(otherScope.duration_scope, 'model_output', 'a wrong duration_scope must be preserved, never upgraded')
    assert.equal(otherScope.tps_contract, 'agent_turn_v0', 'a wrong tps_contract must be preserved, never upgraded')

    const telemetry = db.prepare<[string], { output_tokens: number; agent_turn_ms: number; usage_event_count: number; tps_complete: number }>(
      `SELECT output_tokens, agent_turn_ms, usage_event_count, tps_complete
      FROM task_run_telemetry WHERE task_run_id = ?`,
    ).get(taskId)
    assert.ok(telemetry, 'expected a durable telemetry row')
    assert.equal(telemetry.usage_event_count, 0, 'no persisted event may count as agent-turn usage')
    assert.equal(telemetry.output_tokens, 0)
    assert.equal(telemetry.tps_complete, 0, 'missing/other-scope usage must disable TPS for the run')
  })

  it('maps normalized Forge stream-json tool_call and tool_result envelope events', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', { profile: 'test', client_family: 'claude', cwd }),
      forgeStreamEvent(2, 'tool_call', {
        name: 'bash',
        call_id: 'toolu_abc123',
        input: { command: 'echo hello' },
      }),
      forgeStreamEvent(3, 'tool_result', {
        call_id: 'toolu_abc123',
        output: 'hello',
        is_error: false,
      }),
      forgeStreamEvent(4, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'tool events test',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit normalized tool_call and tool_result',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const rows = db.prepare<unknown[], EventRow>(
      `SELECT type, data FROM events WHERE execution_id = ? ORDER BY seq`,
    ).all(handle.executionId)

    const toolCall = rows.find((row) => row.type === 'tool_call')
    assert.ok(toolCall?.data, 'expected normalized tool_call to produce tool_call event')
    const callData = JSON.parse(toolCall.data) as Record<string, unknown>
    assert.equal(callData.name, 'bash')
    assert.equal(callData.call_id, 'toolu_abc123')

    const toolResult = rows.find((row) => row.type === 'tool_result')
    assert.ok(toolResult?.data, 'expected normalized tool_result to produce tool_result event')
    const resultData = JSON.parse(toolResult.data) as Record<string, unknown>
    assert.equal(resultData.call_id, 'toolu_abc123')
    assert.equal(resultData.status, 'ok')
  })

  it('does not capture native session ids from legacy result events', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'system', {
        subtype: 'init',
        session_id: 'legacy_system_init',
      }),
      forgeStreamEvent(2, 'thread.started', {
        thread_id: 'legacy_thread_started',
      }),
      forgeStreamEvent(3, 'result', {
        subtype: 'success',
        is_error: false,
        session_id: 'legacy_native_result',
        result: 'legacy native result output',
      }),
      forgeStreamEvent(4, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'canonical run finished output',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit legacy native session id and canonical terminal event',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')
    assert.equal(result.output, 'canonical run finished output')

    const row = db.prepare<unknown[], NativeSessionRow>(
      `SELECT native_session_id, client_family, output
      FROM executions
      WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(row, 'expected execution row')
    assert.equal(row.output, 'canonical run finished output')
    assert.equal(row.native_session_id, null)
    assert.equal(row.client_family, null)
  })

  it('persists requested_agent_runtime on execution creation', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForge(cwd, runFinishedFinalEvent())

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'forge/general',
      permission: 'readonly',
      cwd,
      prompt: 'test requested agent runtime',
      requestedAgentRuntime: 'forge/general',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const row = db.prepare<unknown[], { requested_agent_runtime: string | null }>(
      `SELECT requested_agent_runtime FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(row, 'expected execution row')
    assert.equal(row.requested_agent_runtime, 'forge/general')
  })

  it('resolved_profile is NULL for initial runs', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForge(cwd, runFinishedFinalEvent())

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'test resolved profile null',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const row = db.prepare<unknown[], { resolved_profile: string | null }>(
      `SELECT resolved_profile FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(row, 'expected execution row')
    assert.equal(row.resolved_profile, null)
  })

  it('captures run_started.profile as resolved_profile exactly once', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', {
        profile: 'codex-flash',
        client_family: 'claude',
        cwd,
      }),
      forgeStreamEvent(2, 'run_started', {
        profile: 'codex-luna',
        client_family: 'claude',
        cwd,
      }),
      forgeStreamEvent(3, 'run_finished', {
        status: 'done',
        exit_code: 0,
        summary: 'two start events',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'emit two run_started events',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const row = db.prepare<unknown[], { resolved_profile: string | null }>(
      `SELECT resolved_profile FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(row, 'expected execution row')
    assert.equal(row.resolved_profile, 'codex-flash',
      'first run_started.profile must win; second must be ignored')
  })

  it('captures policy resolved_profile from run_finished when run_started has no profile', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForgeLines(cwd, [
      forgeStreamEvent(1, 'run_started', {
        selector: 'policy',
        policy: 'fast',
      }),
      forgeStreamEvent(2, 'attempt_started', {
        profile: 'cb-hy',
        attempt: 1,
        retry: 0,
        mode: 'initial',
      }),
      forgeStreamEvent(3, 'policy_fallback', {
        from_profile: 'cb-hy',
        to_profile: 'cb-dsf',
        reason: 'profile_specific_limit',
      }),
      forgeStreamEvent(4, 'run_finished', {
        status: 'done',
        exit_code: 0,
        profile: 'cb-dsf',
        client_family: 'claude',
        native_session_id: 'native-policy-1',
        summary: 'policy result',
      }),
    ])

    const supervisor = makeSupervisor()
    const handle = await supervisor.startExecution({
      profile: 'forge/fast',
      permission: 'readonly',
      cwd,
      prompt: 'run policy',
      requestedAgentRuntime: 'forge/fast',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const row = db.prepare<unknown[], { resolved_profile: string | null }>(
      `SELECT resolved_profile FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(row, 'expected execution row')
    assert.equal(row.resolved_profile, 'cb-dsf',
      'terminal policy profile must be captured instead of an intermediate candidate')
  })

  it('historical rows with NULL requested_agent_runtime use frozen profile', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-')
    installFakeForge(cwd, runFinishedFinalEvent())

    const supervisor = makeSupervisor()
    // Start without requestedAgentRuntime to simulate legacy
    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'legacy execution',
    })

    const result = await handle.wait()
    assert.equal(result.status, 'done')

    const row = db.prepare<unknown[], { requested_agent_runtime: string | null; profile: string }>(
      `SELECT requested_agent_runtime, profile FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(row, 'expected execution row')
    assert.equal(row.requested_agent_runtime, null)
    assert.equal(row.profile, 'test')
  })

  it('cancelExecution blocks until the child process and execution row are terminal, the repo lock is released, and no active execution remains', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-cancel-')
    const startedPath = join(cwd, 'started')
    installLongRunningFakeForge(cwd, startedPath)

    const repoWriteLocks = new RepoWriteLocks()
    const supervisor = makeSupervisor(repoWriteLocks)

    const taskId = 'task_cancel_wait'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'edit',
      cwd,
      prompt: 'long running',
      taskId,
    })
    await waitForFile(startedPath)

    assert.ok(typeof handle.pid === 'number', 'expected the long-running Forge child to expose a real pid')
    const childPid = handle.pid as number

    assert.ok(repoWriteLocks.isLocked(cwd), 'repo write lock should be held while running')

    // cancelExecution must not resolve until the child is killed and the terminal row is committed.
    await supervisor.cancelExecution(handle.executionId)

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(execRow, 'expected execution row')
    assert.equal(execRow.status, 'cancelled', 'execution row must be terminal cancelled')

    assert.equal(repoWriteLocks.isLocked(cwd), null, 'repo write lock must be released after cancel')

    const activeCount = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM executions WHERE status IN ('queued', 'running', 'starting')`,
    ).get()?.c ?? 0
    assert.equal(activeCount, 0, 'no active execution should remain after cancel')

    let alive = true
    try {
      process.kill(childPid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'child process must be killed after cancel')
  })

  it('cancelExecution must settle within a short bound when the registered child PID is absent and the stream/close observer is stalled', {
    timeout: 15_000,
  }, async () => {
    // The fake Forge parent spawns a detached keeper that inherits the parent stdout
    // pipe, records its pid, then writes the started marker and exits immediately.
    // Waiting for started therefore means the keeper fixture is fully ready. The keeper
    // keeps the pipe write-end open forever, so the supervisor's stream consumer never sees EOF
    // and the child 'close' event never fires: the registered PID is absent but the
    // stream/close observer is stalled.
    const cwd = makeTempDir('foreman-agent-supervisor-stalled-cancel-')
    const startedPath = join(cwd, 'started')
    const keeperPidPath = join(cwd, 'keeper-pid')
    installStalledObserverFakeForge(cwd, startedPath, keeperPidPath)

    const repoWriteLocks = new RepoWriteLocks()
    // Short injected cancellation-settlement bound so a stalled observer cannot
    // postpone the durable cancelled state beyond the test's own bounded window.
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      cancelSettlementTimeoutMs: 200,
    })
    supervisors.push(supervisor)

    const taskId = 'task_stalled_cancel'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'edit',
      cwd,
      prompt: 'stalled observer cancel',
      taskId,
    })
    await waitForFile(startedPath)

    const keeperPid = Number(readFileSync(keeperPidPath, 'utf-8').trim())
    assert.ok(keeperPid, 'expected stalled stream keeper child pid')
    assert.ok(typeof handle.pid === 'number', 'expected the fake Forge child to expose a real pid')

    let cancelPromise: Promise<void> | undefined
    try {
      // Ensure the registered PID is already absent before cancelling so killProcessTree
      // cannot terminate the stream keeper for us and unblock the observer. Keep this
      // readiness assertion inside the cleanup guard so any failure still kills the keeper.
      await waitForProcessExit(handle.pid as number)
      assert.ok(repoWriteLocks.isLocked(cwd), 'repo write lock should be held while running')

      cancelPromise = supervisor.cancelExecution(handle.executionId)
      const settlement = await Promise.race([
        cancelPromise.then(() => 'settled' as const),
        sleep(2000).then(() => 'timeout' as const),
      ])
      assert.equal(settlement, 'settled',
        'cancelExecution must settle within a short bound even when the registered child PID is absent and the stream/close observer is stalled')

      const execRow = db.prepare<unknown[], { status: string }>(
        `SELECT status FROM executions WHERE id = ?`,
      ).get(handle.executionId)
      assert.ok(execRow, 'expected execution row')
      assert.equal(execRow.status, 'cancelled', 'execution row must be durably cancelled exactly once')

      const taskRow = db.prepare<unknown[], { status: string }>(
        `SELECT status FROM tasks WHERE id = ?`,
      ).get(taskId)
      assert.equal(taskRow?.status, 'cancelled', 'linked task must be durably cancelled exactly once')

      assert.equal(repoWriteLocks.isLocked(cwd), null, 'repo write lock must be released after cancel')

      const activeCount = db.prepare<unknown[], { c: number }>(
        `SELECT COUNT(*) AS c FROM executions WHERE status IN ('queued', 'running', 'starting')`,
      ).get()?.c ?? 0
      assert.equal(activeCount, 0, 'no active execution should remain after bounded cancel')

      const cancelledEventCount = db.prepare<unknown[], { c: number }>(
        `SELECT COUNT(*) AS c FROM events WHERE execution_id = ? AND type = 'cancelled'`,
      ).get(handle.executionId)?.c ?? 0
      assert.equal(cancelledEventCount, 1, 'exactly one cancelled execution event must be emitted')

      // Releasing the stream keeper lets the delayed observer (child close +
      // stream completion) finish and re-enter the terminalize path. It must be a
      // no-op: terminal generation and the authoritative terminal row guard it.
      try {
        process.kill(keeperPid, 'SIGKILL')
      } catch {
        // already gone
      }
      await sleep(150)

      // Repeated cancel and reconciliation after the late observer delivery is a
      // no-op and must not duplicate events or overwrite terminal state.
      await supervisor.cancelExecution(handle.executionId)
      await supervisor.cancelExecution(handle.executionId)

      const afterExecRow = db.prepare<unknown[], { status: string }>(
        `SELECT status FROM executions WHERE id = ?`,
      ).get(handle.executionId)
      assert.equal(afterExecRow?.status, 'cancelled', 'late delivery must not overwrite terminal execution state')

      const afterTaskRow = db.prepare<unknown[], { status: string }>(
        `SELECT status FROM tasks WHERE id = ?`,
      ).get(taskId)
      assert.equal(afterTaskRow?.status, 'cancelled', 'late delivery must not overwrite terminal task state')

      const afterEvents = db.prepare<unknown[], { c: number }>(
        `SELECT COUNT(*) AS c FROM events WHERE execution_id = ? AND type = 'cancelled'`,
      ).get(handle.executionId)?.c ?? 0
      assert.equal(afterEvents, 1, 'late/repeated delivery must not duplicate the cancelled event')
    } finally {
      // Releasing the stream keeper lets the stalled observer complete so the
      // supervisor terminalizes the execution and shutdown can finish.
      try {
        process.kill(keeperPid, 'SIGKILL')
      } catch {
        // already gone
      }
      if (cancelPromise) await cancelPromise.catch(() => {})
    }
  })

  it('does not launch Forge when the task is already terminal at binding time', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-attach-fail-')
    const startedPath = join(cwd, 'started')
    installLongRunningFakeForge(cwd, startedPath)

    const repoWriteLocks = new RepoWriteLocks()
    const supervisor = makeSupervisor(repoWriteLocks)

    const taskId = 'task_term_before_bind'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'done', 1, ?, ?)`,
    ).run(taskId, now, now)

    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'edit',
      cwd,
      prompt: 'should not run',
      taskId,
    })

    // Give the (never launched) forge a moment; startedPath must never appear.
    await sleep(80)
    assert.equal(existsSync(startedPath), false, 'Forge must not be launched for a terminal task')

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.ok(execRow, 'expected execution row')
    assert.equal(execRow.status, 'cancelled', 'new execution must be synchronously cancelled when binding fails')

    assert.equal(repoWriteLocks.isLocked(cwd), null, 'repo write lock must be released')

    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'done', 'pre-terminal task must remain untouched')
  })

  it('passes the authoritative task run id and preserves unrelated environment to Forge children', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-env-')
    const envPath = join(cwd, 'env.json')
    installFakeForgeEnvRecorder(cwd, envPath, [
      forgeStreamEvent(1, 'run_finished', { status: 'done', exit_code: 0, summary: 'env ok' }),
    ])

    const taskId = 'task_env_authoritative'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const oldTaskRunId = process.env.FOREMAN_TASK_RUN_ID
    const oldSentinel = process.env.FOREMAN_ENV_TEST_SENTINEL
    try {
      process.env.FOREMAN_ENV_TEST_SENTINEL = 'parent-sentinel-value'
      const supervisor = makeSupervisor()
      const handle = await supervisor.startExecution({
        profile: 'test',
        permission: 'readonly',
        cwd,
        prompt: 'record env',
        taskId,
      })

      const result = await handle.wait()
      assert.equal(result.status, 'done')
      assert.ok(existsSync(envPath), 'expected Forge child to record its environment')

      const env = JSON.parse(readFileSync(envPath, 'utf-8')) as Record<string, unknown>
      assert.equal(env.FOREMAN_TASK_RUN_ID, taskId, 'child must receive the exact authoritative task run id')
      assert.equal(env.FOREMAN_ENV_TEST_SENTINEL, 'parent-sentinel-value', 'unrelated parent env must be preserved')
      assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0, 'PATH must be preserved')
    } finally {
      if (oldTaskRunId === undefined) delete process.env.FOREMAN_TASK_RUN_ID
      else process.env.FOREMAN_TASK_RUN_ID = oldTaskRunId
      if (oldSentinel === undefined) delete process.env.FOREMAN_ENV_TEST_SENTINEL
      else process.env.FOREMAN_ENV_TEST_SENTINEL = oldSentinel
    }
  })

  it('propagates the persisted task id to a promoted queued execution', async () => {
    const supervisor = makeSupervisor()

    const blockers: Array<{ executionId: string; pid?: number }> = []
    for (let i = 0; i < 10; i += 1) {
      const blockerCwd = makeTempDir(`foreman-agent-supervisor-queue-${i}-`)
      const blockerStarted = join(blockerCwd, 'started')
      installLongRunningFakeForge(blockerCwd, blockerStarted)
      const handle = await supervisor.startExecution({
        profile: 'test',
        permission: 'readonly',
        cwd: blockerCwd,
        prompt: 'blocker',
      })
      await waitForFile(blockerStarted)
      blockers.push(handle)
    }

    const cwd = makeTempDir('foreman-agent-supervisor-queue-promote-')
    const envPath = join(cwd, 'env.json')
    const taskId = 'task_queue_promote'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const handle = await supervisor.startExecution({
      profile: 'test',
      permission: 'readonly',
      cwd,
      prompt: 'queued child',
      taskId,
    })

    // The execution must be queued, not launched, while all slots are occupied.
    await sleep(80)
    assert.equal(existsSync(envPath), false, 'queued execution must not launch before a slot frees')

    const queuedRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(handle.executionId)
    assert.equal(queuedRow?.status, 'queued', 'queued execution should remain queued while slots are full')

    // Install the env-recording script so the promoted child uses it instead of a blocker script.
    installFakeForgeEnvRecorder(cwd, envPath, [
      forgeStreamEvent(1, 'run_finished', { status: 'done', exit_code: 0, summary: 'promoted env ok' }),
    ])

    for (const blocker of blockers) {
      await supervisor.cancelExecution(blocker.executionId)
    }

    const result = await handle.wait()
    assert.equal(result.status, 'done')
    assert.ok(existsSync(envPath), 'promoted Forge child must record its environment')

    const env = JSON.parse(readFileSync(envPath, 'utf-8')) as Record<string, unknown>
    assert.equal(env.FOREMAN_TASK_RUN_ID, taskId, 'promoted child must receive the persisted task id')
  })

  it('strips an inherited stale FOREMAN_TASK_RUN_ID from taskless executions', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-env-stale-')
    const envPath = join(cwd, 'env.json')
    installFakeForgeEnvRecorder(cwd, envPath, [
      forgeStreamEvent(1, 'run_finished', { status: 'done', exit_code: 0, summary: 'stale env ok' }),
    ])

    const oldTaskRunId = process.env.FOREMAN_TASK_RUN_ID
    const oldSentinel = process.env.FOREMAN_ENV_TEST_SENTINEL
    try {
      process.env.FOREMAN_TASK_RUN_ID = 'stale-task-run-id'
      process.env.FOREMAN_ENV_TEST_SENTINEL = 'parent-sentinel-value'
      const supervisor = makeSupervisor()
      const handle = await supervisor.startExecution({
        profile: 'test',
        permission: 'readonly',
        cwd,
        prompt: 'taskless child',
      })

      const result = await handle.wait()
      assert.equal(result.status, 'done')
      assert.ok(existsSync(envPath), 'expected Forge child to record its environment')

      const env = JSON.parse(readFileSync(envPath, 'utf-8')) as Record<string, unknown>
      assert.equal(env.FOREMAN_TASK_RUN_ID ?? undefined, undefined, 'stale inherited task context must be removed')
      assert.equal(env.FOREMAN_ENV_TEST_SENTINEL, 'parent-sentinel-value', 'unrelated parent env must be preserved')
      assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0, 'PATH must be preserved')
    } finally {
      if (oldTaskRunId === undefined) delete process.env.FOREMAN_TASK_RUN_ID
      else process.env.FOREMAN_TASK_RUN_ID = oldTaskRunId
      if (oldSentinel === undefined) delete process.env.FOREMAN_ENV_TEST_SENTINEL
      else process.env.FOREMAN_ENV_TEST_SENTINEL = oldSentinel
    }
  })

  it('cancels a running execution that has no supervisor registry entry by killing and terminalizing it', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-no-registry-')
    const startedPath = join(cwd, 'started')
    scriptCounter += 1
    const orphanScript = join(cwd, `orphan-${scriptCounter}.mjs`)
    writeFileSync(orphanScript, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(startedPath)}, 'started')
await new Promise(() => {})
`, 'utf-8')

    const orphanPid = spawn(process.execPath, [orphanScript], {
      detached: true,
      stdio: 'ignore',
    }).pid
    assert.ok(orphanPid, 'expected orphan child pid')
    await waitForFile(startedPath)

    const taskId = 'task_orphan_exec'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_orphan'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'readonly', ?, 'orphan', 'running', ?, ?, ?, ?)`,
    ).run(execId, taskId, cwd, orphanPid, orphanPid, now, now)

    const supervisor = makeSupervisor()
    await supervisor.cancelExecution(execId)

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.ok(execRow, 'expected execution row')
    assert.equal(execRow.status, 'cancelled', 'orphan running execution must be terminalized as cancelled')

    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'cancelled', 'linked task must be cancelled')

    const activeCount = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM executions WHERE status IN ('queued', 'running', 'starting')`,
    ).get()?.c ?? 0
    assert.equal(activeCount, 0, 'no active execution should remain')

    let alive = true
    try {
      process.kill(orphanPid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'orphan child process must be killed')
  })

  it('keeps an unregistered running execution active when the recorded PID kill fails', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-cancel-kill-fail-')
    const taskId = 'task_cancel_kill_fail'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_cancel_kill_fail'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'edit', ?, 'orphan', 'running', 424242, 424242, ?, ?)`,
    ).run(execId, taskId, cwd, now, now)

    const repoWriteLocks = new RepoWriteLocks()
    repoWriteLocks.tryAcquire(cwd, execId, 'edit')
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      killProcessTreeImpl: async () => {
        throw new Error('simulated kill failure')
      },
    })
    supervisors.push(supervisor)

    await assert.rejects(
      supervisor.cancelExecution(execId),
      (error: unknown) => error instanceof ExecutionTerminationFailure
        && error.executionId === execId
        && error.phase === 'kill',
      'a kill failure must surface as a structured cancellation failure',
    )

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.equal(execRow?.status, 'running', 'execution must stay active when the PID cannot be controlled')
    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'running', 'linked task must stay active')
    assert.equal(repoWriteLocks.isLocked(cwd)?.holderExecutionId, execId, 'repo write protection must remain held')
    const cancelled = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE execution_id = ? AND type = 'cancelled'`,
    ).get(execId)?.c ?? 0
    assert.equal(cancelled, 0, 'no terminal cancelled event may be inserted')
  })

  it('keeps an unregistered running execution active when the recorded PID remains live after kill', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-cancel-live-')
    const taskId = 'task_cancel_live'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_cancel_live'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'edit', ?, 'orphan', 'running', 434343, 434343, ?, ?)`,
    ).run(execId, taskId, cwd, now, now)

    const repoWriteLocks = new RepoWriteLocks()
    repoWriteLocks.tryAcquire(cwd, execId, 'edit')
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      // The kill resolves, but the liveness probe reports the PID still live.
      killProcessTreeImpl: async () => {},
      isProcessLiveImpl: () => true,
    })
    supervisors.push(supervisor)

    await assert.rejects(
      supervisor.cancelExecution(execId),
      (error: unknown) => error instanceof ExecutionTerminationFailure
        && error.executionId === execId
        && error.phase === 'verify',
      'a PID that remains live must surface as a structured cancellation failure',
    )

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.equal(execRow?.status, 'running', 'execution must stay active while the PID is still live')
    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'running', 'linked task must stay active')
    assert.equal(repoWriteLocks.isLocked(cwd)?.holderExecutionId, execId, 'repo write protection must remain held')
    const cancelled = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE execution_id = ? AND type = 'cancelled'`,
    ).get(execId)?.c ?? 0
    assert.equal(cancelled, 0, 'no terminal cancelled event may be inserted')
  })

  it('kills a live persisted parent/child tree using persisted PID data on a fresh registry', {
    // macOS keeps the deliberately detached child in its own process group, so
    // the persisted parent group cannot deterministically terminate it.
    skip: process.platform === 'darwin' ? 'known macOS detached-process-group limitation' : false,
  }, async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-startup-tree-')
    const startedPath = join(cwd, 'started')
    const childPidPath = join(cwd, 'child-pid')

    // A long-running child that the parent keeps alive so the tree is a real target.
    scriptCounter += 1
    const childScript = join(cwd, `tree-child-${scriptCounter}.mjs`)
    writeFileSync(childScript, `setInterval(() => {}, 1000)\n`, 'utf-8')

    // The parent is test-owned (detached, new process group) and spawns the child into its group.
    scriptCounter += 1
    const parentScript = join(cwd, `tree-parent-${scriptCounter}.mjs`)
    writeFileSync(parentScript, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
writeFileSync(${JSON.stringify(startedPath)}, 'started')
setInterval(() => {}, 1000)
`, 'utf-8')

    const parent = spawn(process.execPath, [parentScript], { detached: true, stdio: 'ignore' })
    const rootPid = parent.pid
    assert.ok(rootPid, 'expected test-owned root parent pid')
    await waitForFile(startedPath)
    // Register PIDs immediately so cleanup is guaranteed even if an assertion below fails.
    const trackedPids = [rootPid]
    const childPid = Number(readFileSync(childPidPath, 'utf-8').trim())
    assert.ok(childPid, 'expected test-owned child pid')
    trackedPids.push(childPid)

    const execId = 'exec_startup_tree'
    const taskId = 'task_startup_tree'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'readonly', ?, 'tree', 'running', ?, ?, ?, ?)`,
    ).run(execId, taskId, cwd, rootPid, rootPid, now, now)

    try {
      // Fresh supervisor: its in-memory registry has no entry for this execution, so it
      // must rely entirely on the persisted PID/pgid to locate and kill the tree.
      const supervisor = makeSupervisor()
      await supervisor.markInterruptedOnStartup()

      const execRow = db.prepare<unknown[], { status: string }>(
        `SELECT status FROM executions WHERE id = ?`,
      ).get(execId)
      assert.ok(execRow, 'expected execution row')
      assert.equal(execRow.status, 'interrupted', 'persisted running row must be interrupted on startup')

      let rootAlive = true
      try {
        process.kill(rootPid, 0)
      } catch {
        rootAlive = false
      }
      assert.equal(rootAlive, false, 'known root parent process must be killed')

      let childAlive = true
      try {
        process.kill(childPid, 0)
      } catch {
        childAlive = false
      }
      assert.equal(childAlive, false, 'known child process must be killed via the persisted process group')
    } finally {
      for (const pid of trackedPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone; nothing to clean up
        }
      }
    }
  })

  it('treats an already-absent persisted PID as interrupted without failing startup', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-startup-exited-')

    // A test-owned process that exits before it is seeded as a persisted PID.
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    const exitedPid = exited.pid
    assert.ok(exitedPid, 'expected test-owned exited child pid')
    await new Promise<void>((resolve) => exited.on('exit', () => resolve()))

    let alive = true
    try {
      process.kill(exitedPid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'test-owned process must already be exited before seeding')

    const execId = 'exec_startup_exited'
    const taskId = 'task_startup_exited'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'readonly', ?, 'exited', 'starting', ?, ?, ?, ?)`,
    ).run(execId, taskId, cwd, exitedPid, exitedPid, now, now)

    // markInterruptedOnStartup must resolve even though the persisted PID is already gone,
    // and it must still mark the row interrupted.
    const supervisor = makeSupervisor()
    await supervisor.markInterruptedOnStartup()

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.ok(execRow, 'expected execution row')
    assert.equal(execRow.status, 'interrupted', 'already-absent starting row must be interrupted idempotently')
  })

  it('keeps a stale execution active on startup when its recorded PID kill fails', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-startup-kill-fail-')
    const taskId = 'task_startup_kill_fail'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_startup_kill_fail'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'edit', ?, 'stale', 'running', 454545, 454545, ?, ?)`,
    ).run(execId, taskId, cwd, now, now)

    const repoWriteLocks = new RepoWriteLocks()
    repoWriteLocks.tryAcquire(cwd, execId, 'edit')
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      killProcessTreeImpl: async () => {
        throw new Error('simulated startup kill failure')
      },
    })
    supervisors.push(supervisor)

    const failures = await supervisor.markInterruptedOnStartup()
    assert.equal(failures.length, 1, 'the kill failure must be surfaced')
    assert.equal(failures[0].executionId, execId)
    assert.equal(failures[0].action, 'startup-interrupt')
    assert.equal(failures[0].phase, 'kill')

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.equal(execRow?.status, 'running', 'execution must stay active when the PID cannot be controlled')
    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'running', 'linked task must stay active')
    assert.equal(repoWriteLocks.isLocked(cwd)?.holderExecutionId, execId, 'repo write protection must remain held')
    const eventCount = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE execution_id = ?`,
    ).get(execId)?.c ?? 0
    assert.equal(eventCount, 0, 'no terminal event may be inserted for an uncontrolled process')
  })

  it('keeps a stale execution active on startup when its recorded PID remains live after kill', async () => {
    const cwd = makeTempDir('foreman-agent-supervisor-startup-live-')
    const taskId = 'task_startup_live'
    const now = new Date().toISOString()
    db.prepare<unknown[]>(
      `INSERT INTO tasks (id, template, project, input, status, structured, created_at, updated_at)
      VALUES (?, 'echo', 'ws', '{}', 'running', 1, ?, ?)`,
    ).run(taskId, now, now)

    const execId = 'exec_startup_live'
    db.prepare<unknown[]>(
      `INSERT INTO executions (id, task_id, profile, permission, cwd, prompt, status, pid, pgid, created_at, updated_at)
      VALUES (?, ?, 'test', 'edit', ?, 'stale', 'running', 464646, 464646, ?, ?)`,
    ).run(execId, taskId, cwd, now, now)

    const repoWriteLocks = new RepoWriteLocks()
    repoWriteLocks.tryAcquire(cwd, execId, 'edit')
    const supervisor = new AgentExecutionSupervisor({
      db,
      repoWriteLocks,
      // The kill resolves, but the liveness probe reports the PID still live.
      killProcessTreeImpl: async () => {},
      isProcessLiveImpl: () => true,
    })
    supervisors.push(supervisor)

    const failures = await supervisor.markInterruptedOnStartup()
    assert.equal(failures.length, 1, 'the still-live process must be surfaced')
    assert.equal(failures[0].executionId, execId)
    assert.equal(failures[0].action, 'startup-interrupt')
    assert.equal(failures[0].phase, 'verify')

    const execRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM executions WHERE id = ?`,
    ).get(execId)
    assert.equal(execRow?.status, 'running', 'execution must stay active while the PID is still live')
    const taskRow = db.prepare<unknown[], { status: string }>(
      `SELECT status FROM tasks WHERE id = ?`,
    ).get(taskId)
    assert.equal(taskRow?.status, 'running', 'linked task must stay active')
    assert.equal(repoWriteLocks.isLocked(cwd)?.holderExecutionId, execId, 'repo write protection must remain held')
    const eventCount = db.prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE execution_id = ?`,
    ).get(execId)?.c ?? 0
    assert.equal(eventCount, 0, 'no terminal event may be inserted for an uncontrolled process')
  })
})

async function runFinalEvent(event: Record<string, unknown>): Promise<RawResultRow> {
  const cwd = makeTempDir('foreman-agent-supervisor-')
  installFakeForge(cwd, event)

  const supervisor = makeSupervisor()
  const handle = await supervisor.startExecution({
    profile: 'test',
    permission: 'readonly',
    cwd,
    prompt: 'emit one final event',
  })
  const result = await handle.wait()
  assert.equal(result.status, 'done')

  const row = db.prepare<unknown[], RawResultRow>(
    `SELECT raw_result, output
    FROM executions
    WHERE id = ?`,
  ).get(handle.executionId)
  assert.ok(row, 'expected execution row')
  return row
}

function installFakeForge(dir: string, event: Record<string, unknown>): void {
  installFakeForgeLines(dir, [forgeStreamEvent(1, String(event.type), event)])
}

function installLongRunningFakeForge(dir: string, startedPath: string): void {
  scriptCounter += 1
  const script = join(dir, `fake-forge-long-${scriptCounter}.mjs`)
  writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(startedPath)}, 'started')
setInterval(() => {}, 1000)
`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function installStalledObserverFakeForge(dir: string, startedPath: string, keeperPidPath: string): void {
  scriptCounter += 1
  const script = join(dir, `fake-forge-stalled-${scriptCounter}.mjs`)
  writeFileSync(script, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'inherit',
})
writeFileSync(${JSON.stringify(keeperPidPath)}, String(keeper.pid))
writeFileSync(${JSON.stringify(startedPath)}, 'started')
process.exit(0)
`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await sleep(20)
  }
  throw new Error(`Timed out waiting for PID ${pid} to exit`)
}

function installFakeForgeLines(dir: string, events: Array<Record<string, unknown>>): void {
  installFakeForgeOutput(dir, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

function installFakeForgeOutput(dir: string, output: string): void {
  scriptCounter += 1
  const script = join(dir, `fake-forge-${scriptCounter}.mjs`)
  writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})\n`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function installBlockingFakeForge(
  dir: string,
  firstStartedPath: string,
  releasePath: string,
  promptLogPath: string,
): void {
  scriptCounter += 1
  const script = join(dir, `fake-forge-lock-${scriptCounter}.mjs`)
  writeFileSync(script, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'

let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  prompt += chunk
})
await new Promise((resolve) => process.stdin.on('end', resolve))

const label = prompt.includes('first writer') ? 'first writer' : 'second writer'
appendFileSync(${JSON.stringify(promptLogPath)}, label + '\\n')

if (label === 'first writer') {
  writeFileSync(${JSON.stringify(firstStartedPath)}, 'started')
  while (!existsSync(${JSON.stringify(releasePath)})) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const event = {
  protocol: 'forge.agent.stream',
  version: 1,
  run_id: 'fr_lock',
  seq: 1,
  type: 'run_finished',
  timestamp: '2026-06-19T00:00:00.000Z',
  data: {
    status: 'done',
    exit_code: 0,
    summary: label + ' done',
  },
}
process.stdout.write(JSON.stringify(event) + '\\n')
`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function installFakeForgeRecorder(
  dir: string,
  argvPath: string,
  stdinPath: string,
  events: Array<Record<string, unknown>>,
): void {
  scriptCounter += 1
  const script = join(dir, `fake-forge-${scriptCounter}.mjs`)
  const output = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  writeFileSync(script, `
import { writeFileSync } from 'node:fs'

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdin += chunk
})
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
  writeFileSync(${JSON.stringify(stdinPath)}, stdin)
  process.stdout.write(${JSON.stringify(output)})
})
process.stdin.resume()
`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function installFakeForgeEnvRecorder(
  dir: string,
  envPath: string,
  events: Array<Record<string, unknown>>,
): void {
  scriptCounter += 1
  const script = join(dir, `fake-forge-env-${scriptCounter}.mjs`)
  const output = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({
  FOREMAN_TASK_RUN_ID: process.env.FOREMAN_TASK_RUN_ID,
  PATH: process.env.PATH,
  FOREMAN_ENV_TEST_SENTINEL: process.env.FOREMAN_ENV_TEST_SENTINEL,
}))
process.stdout.write(${JSON.stringify(output)})
`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

async function waitForFile(path: string, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function forgeStreamEvent(seq: number, type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 'forge.agent.stream',
    version: 1,
    run_id: 'fr_test',
    seq,
    type,
    timestamp: '2026-06-19T00:00:00.000Z',
    data,
  }
}

function runFinishedFinalEvent(): Record<string, unknown> {
  return {
    type: 'run_finished',
    status: 'done',
    exit_code: 0,
    is_error: false,
    summary: 'safe final output',
    token: 'tok-final-secret',
    api_key: 'api-key-final-secret',
    authorization: 'Bearer final-auth-secret',
    debug_payload: JSON.stringify({ token: 'json-string-token-secret', keep: 'json string debug' }),
    nested: {
      private_key: 'private-key-secret',
      privateKey: 'private-camel-secret',
      access_key: 'access-key-secret',
      accessKey: 'access-camel-secret',
      credential: 'credential-secret',
      debug: 'kept for diagnostics',
    },
  }
}
