import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createTestIpcEndpoint } from './helpers/ipc-endpoint.mts'

/**
 * Opt-in real-process integration test for task-context automatic no-wait
 * planned restart. It drives the actual `bin/foreman.mts` CLI: it starts an
 * isolated daemon, runs a task whose fake Forge executable schedules a planned
 * restart (auto no-wait because the daemon injects FOREMAN_TASK_RUN_ID), then
 * verifies the coordinator survives the old daemon exit, performs a full
 * health-gated handoff to a new daemon pid, restores admission, and keeps the
 * scheduled task output readable across the restart.
 *
 * This exercises the real `restartDaemonProcess`; it never mocks it.
 */
test('task-context planned restart drains, hands off to a new daemon, and keeps task output readable', {
  timeout: 120_000,
  skip: process.env.FOREMAN_RUN_DAEMON_RESTART_INTEGRATION_TESTS === '1'
    ? false
    : 'set FOREMAN_RUN_DAEMON_RESTART_INTEGRATION_TESTS=1 to run the isolated daemon restart integration coverage',
}, async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')

  const workDir = mkdtempSync(join(tmpdir(), 'foreman-restart-int-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-restart-int-config-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'foreman-restart-int-state-'))
  const fakeForgeDir = mkdtempSync(join(tmpdir(), 'foreman-restart-int-forge-'))
  const endpoint = createTestIpcEndpoint('restart-int')
  const tempDirs = [workDir, configDir, stateDir, fakeForgeDir, endpoint.dir]

  const configPath = join(configDir, 'config.json')
  const dbPath = join(configDir, 'foreman.sqlite')
  const scriptPath = join(fakeForgeDir, 'fake-forge.mjs')
  const recordPath = join(fakeForgeDir, 'recorded-task-run-id.txt')

  const port = await allocateFreeTcpPort()

  writeWorkspaceFixture(workDir)
  writeFakeForgeScript(scriptPath)
  writeTaskDefinition(workDir)

  writeJsonConfig(configPath, {
    service: { enabled: true, bind: `127.0.0.1:${port}`, ipc: { path: endpoint.path } },
    workspace: { root: workDir },
    pet: { enabled: false },
    message: { enabled: false },
    notify: { enabled: false },
  })

  // Isolated, durable, real-process environment. FOREMAN_TASK_RUN_ID is
  // deliberately absent from the driver env: only the daemon injects it onto
  // the task's Forge process, which is how the restart command detects task
  // context and auto no-waits.
  const baseEnv: NodeJS.ProcessEnv = {
    FOREMAN_DB_PATH: dbPath,
    XDG_STATE_HOME: stateDir,
    WRENYARD_RUNTIME_BIN: process.execPath,
    WRENYARD_FORGE_ARGS_PREFIX: JSON.stringify([scriptPath]),
    FOREMAN_FAKE_FORGE_CONFIG: configPath,
    FOREMAN_FAKE_FORGE_BINARY: binary,
    FOREMAN_FAKE_FORGE_RECORD: recordPath,
  }

  const recordedPids: number[] = []
  let originalPid: number | undefined
  let replacementPid: number | undefined

  // Run every driver command with FOREMAN_TASK_RUN_ID stripped so the driver
  // is never in task context; only the daemon-spawned Forge gets it.
  const runCli = (args: string[]) => runForeman(repoRoot, binary, args, stripDriverTaskContext(baseEnv))

  try {
    const start = await runCli(['daemon', 'start', '--config', configPath])
    assert.ifError(start.error)
    assert.equal(start.status, 0, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`)
    assert.match(start.stdout, /Wrenyard daemon started/u)

    const startedStatus = await runCli(['daemon', 'status', '--config', configPath, '--json'])
    assert.ifError(startedStatus.error)
    assert.equal(startedStatus.status, 0, startedStatus.stderr)
    const started = JSON.parse(startedStatus.stdout) as { daemon?: { pid?: number } }
    assert.equal(typeof started.daemon?.pid, 'number', 'expected a running daemon pid')
    originalPid = started.daemon?.pid as number
    recordedPids.push(originalPid)

    // Run a task whose fake Forge records FOREMAN_TASK_RUN_ID, triggers the
    // real daemon restart in task context, and emits the scheduled payload as
    // valid Forge Agent Stream terminal output.
    const run = await runCli([
      'task', 'run', 'restart-trigger', '-p', 'app', '--config', configPath,
      JSON.stringify({ text: 'trigger-planned-restart' }),
    ])
    assert.ifError(run.error)
    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
    const runPayload = JSON.parse(run.stdout) as {
      task_run_id?: string
      status?: string
      has_output?: boolean
    }
    const taskRunId = runPayload.task_run_id ?? ''
    assert.match(taskRunId, /^task_/u)
    assert.equal(runPayload.status, 'done')
    assert.equal(runPayload.has_output, true)

    // The Forge recorded the very task run id the daemon injected.
    const recordedEnvId = readRecordedId(recordPath)
    assert.equal(recordedEnvId, taskRunId, 'recorded FOREMAN_TASK_RUN_ID must equal the returned task_run_id')

    // The task output is the scheduled restart payload (task-context auto no-wait).
    const firstOutput = await runCli(['task', 'output', taskRunId, '--config', configPath])
    assert.ifError(firstOutput.error)
    assert.equal(firstOutput.status, 0, firstOutput.stderr)
    const firstPayload = JSON.parse(firstOutput.stdout) as {
      task_run_id?: string
      status?: string
      output?: { operation_id?: string; scheduled?: boolean; status_endpoint?: string; joining?: boolean }
    }
    assert.equal(firstPayload.task_run_id, taskRunId)
    assert.equal(firstPayload.status, 'done')
    const scheduled = firstPayload.output
    assert.ok(scheduled, 'expected scheduled payload in task output')
    assert.equal(typeof scheduled.operation_id, 'string')
    assert.equal(scheduled.scheduled, true)
    assert.equal(scheduled.status_endpoint, 'wrenyard status --json')

    const scheduledOperationId = scheduled.operation_id as string

    // Poll through the IPC restart gap until a different (replacement) daemon
    // pid is healthy. Track whether we observed the durable planned-restart
    // operation that we scheduled.
    let sawScheduledOperation = false
    let healthyNewPid = false
    const pollDeadline = Date.now() + 90_000
    while (Date.now() < pollDeadline) {
      const status = await runCli(['daemon', 'status', '--config', configPath, '--json'])
      if (status.error || status.status !== 0) {
        await delay(250)
        continue
      }
      const s = JSON.parse(status.stdout) as {
        ok?: boolean
        mode?: string
        operation_id?: string
        daemon?: { pid?: number }
      }
      if (s.mode === 'planned_restart' && s.operation_id === scheduledOperationId) {
        sawScheduledOperation = true
      }
      if (
        s.ok === true
        && typeof s.daemon?.pid === 'number'
        && s.daemon.pid !== originalPid
      ) {
        replacementPid = s.daemon.pid
        healthyNewPid = true
        // The handoff is only complete once the coordinator finishes verifying
        // and admission returns to accepting; until then the daemon is still in
        // the planned_restart (verifying) phase.
        if (s.mode === 'accepting') break
      }
      await delay(250)
    }
    assert.ok(healthyNewPid, 'replacement daemon never became healthy with a different pid')
    assert.ok(replacementPid !== undefined && replacementPid !== originalPid, 'replacement pid must differ from original')
    recordedPids.push(replacementPid as number)

    // The durable operation completed and admission was restored behind a full
    // health gate with a natural zero-active drain.
    const finalStatus = await runCli(['daemon', 'status', '--config', configPath, '--json'])
    assert.ifError(finalStatus.error)
    assert.equal(finalStatus.status, 0, finalStatus.stderr)
    const final = JSON.parse(finalStatus.stdout) as {
      ok?: boolean
      mode?: string
      recovery_required?: boolean
      ipc?: { ok?: boolean }
      http?: { ok?: boolean }
      mcp?: { ok?: boolean }
      db?: { ok?: boolean }
      active_task_count?: number
      active_workflow_count?: number
      active_execution_count?: number
    }
    assert.equal(final.ok, true)
    assert.equal(final.mode, 'accepting', 'admission must be restored to accepting after completion')
    assert.equal(final.recovery_required, false, 'completion must not require recovery')
    assert.equal(final.ipc?.ok, true)
    assert.equal(final.http?.ok, true)
    assert.equal(final.mcp?.ok, true)
    assert.equal(final.db?.ok, true)
    assert.equal(final.active_task_count, 0)
    assert.equal(final.active_workflow_count, 0)
    assert.equal(final.active_execution_count, 0)
    assert.ok(
      sawScheduledOperation,
      'did not observe the durable scheduled planned-restart operation during the restart window',
    )

    // The original task output remains readable from the replacement daemon.
    const secondOutput = await runCli(['task', 'output', taskRunId, '--config', configPath])
    assert.ifError(secondOutput.error)
    assert.equal(secondOutput.status, 0, secondOutput.stderr)
    const secondPayload = JSON.parse(secondOutput.stdout) as {
      task_run_id?: string
      status?: string
      output?: { operation_id?: string; scheduled?: boolean; status_endpoint?: string; joining?: boolean }
    }
    assert.equal(secondPayload.task_run_id, taskRunId)
    assert.equal(secondPayload.status, 'done')
    assert.deepEqual(secondPayload.output, scheduled, 'scheduled payload must be identical after restart')
  } finally {
    // Stop the isolated daemon through the real CLI, then terminate only any
    // remaining recorded isolated process ids, then remove temporary resources.
    await runCli(['daemon', 'stop', '--config', configPath])
    for (const pid of recordedPids) {
      if (typeof pid === 'number' && isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // Best effort; the daemon stop already attempted a graceful shutdown.
        }
      }
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  }
})

// ── Fixtures ───────────────────────────────────────────────────────────────

function writeWorkspaceFixture(workspace: string): void {
  const projectDir = join(workspace, 'projects', 'workspace')
  mkdirp(projectDir)
  const repo = join(workspace, 'checkouts', 'app')
  mkdirp(repo)
  writeFmproj(workspace, 'app', repo)
}

function writeFmproj(workspace: string, projectId: string, repo: string): void {
  const name = projectId.split('/').at(-1)
  assert.ok(name)
  const projectDir = join(workspace, 'projects', ...projectId.split('/'))
  mkdirp(projectDir)
  writeFileSync(
    join(projectDir, `${name}.fmproj`),
    `name: ${name}
description: Test project ${projectId}
git:
  remote: https://example.test/${name}.git
  default_branch: main
hosts:
  ${hostname()}: ${repo}
`,
    'utf-8',
  )
}

function writeTaskDefinition(workDir: string): void {
  writeFileSync(
    join(workDir, 'projects', 'workspace', 'restart-trigger.task.ts'),
    `export default defineTask({
  profile: 'test-profile',
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.any(),
  prompt: ({ text }) => \`Trigger a planned restart: \${text}\`,
})
`,
    'utf-8',
  )
}

/**
 * Fake Forge executable. It records the daemon-injected FOREMAN_TASK_RUN_ID,
 * runs the real `bin/foreman.mts daemon restart` (which detects task context
 * via the inherited env and auto no-waits), parses the scheduled JSON, and
 * emits that payload as a valid Forge Agent Stream terminal event.
 */
function writeFakeForgeScript(scriptPath: string): void {
  const lines = [
    "import { spawnSync } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    '',
    "const taskRunId = process.env.FOREMAN_TASK_RUN_ID || ''",
    "const configPath = process.env.FOREMAN_FAKE_FORGE_CONFIG",
    "const binary = process.env.FOREMAN_FAKE_FORGE_BINARY",
    "const recordPath = process.env.FOREMAN_FAKE_FORGE_RECORD",
    '',
    "if (recordPath && taskRunId) {",
    "  writeFileSync(recordPath, taskRunId, 'utf-8')",
    '}',
    '',
    "const restart = spawnSync(process.execPath, [binary, 'daemon', 'restart', '--config', configPath, '--json'], { encoding: 'utf-8', env: process.env })",
    '',
    'let scheduled',
    'try {',
    '  scheduled = JSON.parse(restart.stdout)',
    '} catch (e) {',
    "  scheduled = { parse_error: String(e), stdout: restart.stdout, stderr: restart.stderr }",
    '}',
    '',
    'function ev(seq, type, data) {',
    "  return { protocol: 'forge.agent.stream', version: 1, run_id: 'fr_restart_integration', seq: seq, type: type, timestamp: '2026-06-30T00:00:00.000Z', data: data }",
    '}',
    '',
    'const events = [',
    "  ev(1, 'run_started', { profile: 'test-profile', client_family: 'claude', cwd: process.cwd() }),",
    "  ev(2, 'run_finished', { status: 'done', exit_code: 0, output: '<foreman-task-output><summary>daemon restart scheduled from task context</summary><result>' + JSON.stringify(scheduled) + '</result></foreman-task-output>', native_session_id: 'native_restart_integration', client_family: 'claude' }),",
    ']',
    '',
    "process.stdout.write(events.map((e) => JSON.stringify(e)).join('\\n') + '\\n')",
    '',
  ]
  writeFileSync(scriptPath, lines.join('\n'), 'utf-8')
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function writeJsonConfig(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function readRecordedId(recordPath: string): string {
  return readFileSync(recordPath, 'utf-8').trim()
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function stripDriverTaskContext(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env }
  delete merged.FOREMAN_TASK_RUN_ID
  return merged
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function allocateFreeTcpPort(): Promise<number> {
  const server = createServer()
  await listen(server, 0)
  const port = serverPort(server)
  await closeServer(server)
  return port
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function serverPort(server: Server): number {
  const address = server.address()
  assert(address && typeof address === 'object')
  return (address as AddressInfo).port
}

function runForeman(
  repoRoot: string,
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  const command = process.platform === 'win32'
    ? 'cmd'
    : join(repoRoot, 'node_modules', '.bin', 'tsx')
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'tsx', binary, ...args]
    : [binary, ...args]
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error: Error) => {
      resolve({ status: null, stdout, stderr, error })
    })
    child.on('close', (status: number | null) => {
      resolve({ status, stdout, stderr })
    })
  })
}
