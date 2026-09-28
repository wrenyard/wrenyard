import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { startForemanDaemon } from '@wrenyard/daemon'
import { resetRegistry } from '@wrenyard/daemon/workspace/task-loader'
import { createTestIpcEndpoint } from '../../daemon/tests/helpers/ipc-endpoint.mts'
import { installIsolatedForemanEnv, type IsolatedForemanEnv } from '../../daemon/tests/helpers/isolated-env.mts'

const tempDirs: string[] = []
let isolatedEnv: IsolatedForemanEnv | undefined

beforeEach(() => {
  isolatedEnv = installIsolatedForemanEnv('foreman-cli-test-env')
})

afterEach(() => {
  isolatedEnv?.restore()
  isolatedEnv = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('zero arguments invokes the TUI launcher and returns its exit code', async () => {
  const { runForemanCli } = await import('../src/index.mts')

  let callCount = 0
  const mockTuiLauncher = (): number => {
    callCount++
    return 42
  }

  const code = await runForemanCli([], mockTuiLauncher)
  assert.equal(callCount, 1, 'TUI launcher must be called exactly once')
  assert.equal(code, 42, 'TUI launcher exit code must be returned')
})

test('top-level version flag prints the suite version', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'src', 'index.mts')
  const suiteRoot = resolve(repoRoot, '..', '..')
  const pkg = JSON.parse(readFileSync(join(suiteRoot, 'package.json'), 'utf-8')) as { version: string }

  for (const args of [['--version'], ['-v']] as const) {
    const result = runForemanSync(repoRoot, binary, [...args])
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), pkg.version)
    assert.equal(result.stderr, '')
  }
})

test('foreman status --json reaches the running daemon over IPC', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'src', 'index.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-health-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-health-config-'))
  const endpoint = createTestIpcEndpoint('status')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  const running = await startForemanDaemon({
    service: { enabled: true, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
  })

  try {
    const address = running.httpServer.address() as AddressInfo
    const configPath = join(configDir, 'config.json')
    writeJsonConfig(configPath, {
      service: { bind: `127.0.0.1:${address.port}`, ipc: { path: running.ipcPath } },
      workspace: { root: workDir },
      message: { enabled: false },
      messageDelivery: { enabled: false },
    })

    const result = await runForeman(repoRoot, binary, [
      'status',
      '--config',
      configPath,
      '--json',
    ])

    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout) as { ok?: boolean; uptimeMs?: number }
    assert.equal(payload.ok, true)
    assert.equal(typeof payload.uptimeMs, 'number')
  } finally {
    await running.stop()
    resetRegistry()
  }
})

test('foreman taskgraph commands drive the kernel and reject invalid params', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'src', 'index.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-taskgraph-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-taskgraph-config-'))
  const endpoint = createTestIpcEndpoint('taskgraph')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  const running = await startForemanDaemon({
    service: { enabled: true, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
  })

  try {
    const unreachableHttpPort = await allocateFreeTcpPort()
    const configPath = join(configDir, 'config.json')
    writeJsonConfig(configPath, {
      service: { bind: `127.0.0.1:${unreachableHttpPort}`, ipc: { path: running.ipcPath } },
      workspace: { root: workDir },
      message: { enabled: false },
      messageDelivery: { enabled: false },
    })

    const create = await runForeman(repoRoot, binary, [
      'taskgraph',
      'create',
      '--config',
      configPath,
      JSON.stringify({
        template: 'default',
      }),
    ])
    assert.ifError(create.error)
    assert.equal(create.status, 0, create.stderr)
    const created = JSON.parse(create.stdout) as { taskgraph: { id: string; revision: number } }
    const taskgraphId = created.taskgraph.id

    const taskgraphProtocolCases = [
      {
        selection: ['taskgraph', 'patch'],
        legalParams: {
          taskgraph_id: taskgraphId,
          operation: {
            type: 'request_patch',
            patch: {
              base_revision: created.taskgraph.revision,
              actor: 'test',
              reason: 'test',
              created_at: new Date().toISOString(),
              ops: [],
            },
          },
        },
        assertResult: (value: { type?: string }) => assert.equal(value.type, 'preview'),
      },
      {
        selection: ['taskgraph', 'status'],
        legalParams: { taskgraph_id: taskgraphId },
        assertResult: (value: { state?: string }) => assert.equal(value.state, 'created'),
      },
      {
        selection: ['taskgraph', 'events'],
        legalParams: { taskgraph_id: taskgraphId },
        assertResult: (value: { events?: unknown[] }) => assert.ok(value.events?.length),
      },
      {
        selection: ['taskgraph', 'signal'],
        legalParams: { taskgraph_id: taskgraphId, signal: { type: 'pause_graph' } },
        assertResult: (value: { accepted?: boolean }) => assert.equal(value.accepted, true),
      },
      {
        selection: ['taskgraph', 'node', 'inspect'],
        legalParams: { taskgraph_id: taskgraphId, node_id: 'start' },
        assertResult: (value: { run?: { state?: string } }) => assert.equal(value.run?.state, 'planned'),
      },
    ]

    for (const { selection, legalParams, assertResult } of taskgraphProtocolCases) {
      const legalResult = await runForeman(repoRoot, binary, [
        ...selection,
        '--config',
        configPath,
        JSON.stringify(legalParams),
      ])
      assert.ifError(legalResult.error)
      assert.equal(legalResult.status, 0, legalResult.stderr)
      assertResult(JSON.parse(legalResult.stdout) as never)
    }

    for (const { selection } of [
      { selection: ['taskgraph', 'create'] },
      ...taskgraphProtocolCases,
    ]) {
      const emptyResult = await runForeman(repoRoot, binary, [...selection, '--config', configPath, '{}'])
      assert.ifError(emptyResult.error)
      assert.notEqual(emptyResult.status, 0, `expected non-zero for ${selection.join(' ')} with {}`)
      assert.doesNotMatch(emptyResult.stdout + emptyResult.stderr, /NOT_IMPLEMENTED/u, `empty params should not reach handler for ${selection.join(' ')}`)
    }
  } finally {
    await running.stop()
    resetRegistry()
  }
})

test('foreman task commands reach the running service over IPC', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'src', 'index.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-task-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-task-config-'))
  const fakeForgeDir = mkdtempSync(join(tmpdir(), 'foreman-cli-task-forge-'))
  const endpoint = createTestIpcEndpoint('taskrun')
  tempDirs.push(workDir, configDir, fakeForgeDir, endpoint.dir)
  const appRepo = writeWorkspaceFixture(workDir)
  writeFileSync(
    join(appRepo, 'echo.task.ts'),
    `export default defineTask({
  dispatch: { minimumTps: 1 },
  permission: 'readonly',
  input: foremanSchemas.z.object({
    text: foremanSchemas.z.string(),
  }),
  output: foremanSchemas.z.object({
    result: foremanSchemas.z.string(),
  }).strict(),
  prompt: ({ text }) => \`Return "\${text}" as result.\`,
})
`,
    'utf-8',
  )
  writeFileSync(
    join(appRepo, 'items.task.ts'),
    `export default defineTask({
  dispatch: { minimumTps: 1 },
  permission: 'readonly',
  input: foremanSchemas.z.array(foremanSchemas.z.string()),
  output: foremanSchemas.z.any(),
  prompt: (input) => \`Count \${input.length} items.\`,
})
`,
    'utf-8',
  )
  const oldForgeBin = process.env.WRENYARD_RUNTIME_BIN
  const oldForgeArgsPrefix = process.env.WRENYARD_FORGE_ARGS_PREFIX
  installFakeForgeLines(fakeForgeDir, [
    forgeStreamEvent(1, 'run_started', { profile: 'test-profile', client_family: 'claude', cwd: appRepo }),
    forgeStreamEvent(2, 'run_finished', {
      status: 'done',
      exit_code: 0,
      summary: xmlOutput({ result: 'hello from ipc task' }, 'Task completed over IPC.'),
      native_session_id: 'native_cli_task_ipc',
      client_family: 'claude',
    }),
  ])
  const oldDbPath = process.env.FOREMAN_DB_PATH
  process.env.FOREMAN_DB_PATH = join(configDir, 'foreman.sqlite')

  let running: Awaited<ReturnType<typeof startForemanDaemon>> | undefined

  try {
    running = await startForemanDaemon({
      service: { enabled: true, ipc: { path: endpoint.path } },
      workspaceRoot: workDir,
    })

    const unreachableHttpPort = await allocateFreeTcpPort()
    const configPath = join(configDir, 'config.json')
    writeJsonConfig(configPath, {
      service: { bind: `127.0.0.1:${unreachableHttpPort}`, ipc: { path: running.ipcPath } },
      workspace: { root: workDir },
      message: { enabled: false },
      messageDelivery: { enabled: false },
    })

    const taskListResult = await runForeman(repoRoot, binary, [
      'task',
      'list',
      'app',
      '--config',
      configPath,
      '--json',
    ])
    assert.ifError(taskListResult.error)
    assert.equal(taskListResult.status, 0, `stdout:\n${taskListResult.stdout}\nstderr:\n${taskListResult.stderr}`)
    const taskListPayload = JSON.parse(taskListResult.stdout) as { tasks?: Array<{ name?: string }> }
    assert.ok(taskListPayload.tasks?.some((task) => task.name === 'echo'), taskListResult.stdout)

    const taskDescribeResult = await runForeman(repoRoot, binary, [
      'task',
      'describe',
      'echo',
      '-p',
      'app',
      '--config',
      configPath,
    ])
    assert.ifError(taskDescribeResult.error)
    assert.equal(taskDescribeResult.status, 0, `stdout:\n${taskDescribeResult.stdout}\nstderr:\n${taskDescribeResult.stderr}`)
    const taskDescribePayload = JSON.parse(taskDescribeResult.stdout) as { name?: string; source?: string }
    assert.equal(taskDescribePayload.name, 'echo')
    assert.equal(taskDescribePayload.source, 'project')
    assert.equal((taskDescribePayload as Record<string, unknown>).project, 'app')

    const runResult = await runForeman(repoRoot, binary, [
      'task',
      'run',
      'echo',
      '-p',
      'app',
      '--config',
      configPath,
      JSON.stringify({ text: 'hello from ipc task' }),
    ])
    assert.ifError(runResult.error)
    assert.equal(runResult.status, 0, `stdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`)

    const runPayload = JSON.parse(runResult.stdout) as { task_run_id?: string; status?: string; output?: unknown }
    assert.match(runPayload.task_run_id ?? '', /^task_/u)
    assert.equal(runPayload.status, 'done')
    assert.deepEqual(runPayload.output, { result: 'hello from ipc task' })

    const statusResult = await runForeman(repoRoot, binary, [
      'task',
      'status',
      runPayload.task_run_id ?? '',
      '--config',
      configPath,
    ])
    assert.ifError(statusResult.error)
    assert.equal(statusResult.status, 0, `stdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`)
    const statusPayload = JSON.parse(statusResult.stdout) as { task_run_id?: string; status?: string; has_output?: boolean }
    assert.equal(statusPayload.task_run_id, runPayload.task_run_id)
    assert.equal(statusPayload.status, 'done')
    assert.equal(statusPayload.has_output, true)
    const statusMeta = (statusPayload as Record<string, unknown>)._meta as { project?: string } | undefined
    assert.equal(statusMeta?.project, 'app')

    const outputResult = await runForeman(repoRoot, binary, [
      'task',
      'output',
      runPayload.task_run_id ?? '',
      '--config',
      configPath,
    ])
    assert.ifError(outputResult.error)
    assert.equal(outputResult.status, 0, `stdout:\n${outputResult.stdout}\nstderr:\n${outputResult.stderr}`)
    const outputPayload = JSON.parse(outputResult.stdout) as { task_run_id?: string; status?: string; output?: unknown }
    assert.equal(outputPayload.task_run_id, runPayload.task_run_id)
    assert.equal(outputPayload.status, 'done')
    assert.deepEqual(outputPayload.output, { result: 'hello from ipc task' })

    const taskCancelResult = await runForeman(repoRoot, binary, [
      'task',
      'cancel',
      runPayload.task_run_id ?? '',
      '--config',
      configPath,
    ])
    assert.ifError(taskCancelResult.error)
    assert.equal(taskCancelResult.status, 0, `stdout:\n${taskCancelResult.stdout}\nstderr:\n${taskCancelResult.stderr}`)
    const taskCancelPayload = JSON.parse(taskCancelResult.stdout) as { ok?: boolean; task_run_id?: string; status?: string }
    assert.equal(taskCancelPayload.ok, false)
    assert.equal(taskCancelPayload.task_run_id, runPayload.task_run_id)
    assert.equal(taskCancelPayload.status, 'done')

    // items task with array input schema — transportability proof
    const taskListItems = await runForeman(repoRoot, binary, [
      'task',
      'list',
      'app',
      '--config',
      configPath,
      '--json',
    ])
    assert.ifError(taskListItems.error)
    assert.equal(taskListItems.status, 0, `stdout:\n${taskListItems.stdout}\nstderr:\n${taskListItems.stderr}`)
    const taskListItemsPayload = JSON.parse(taskListItems.stdout) as { tasks?: Array<{ name?: string }> }
    assert.ok(taskListItemsPayload.tasks?.some((task) => task.name === 'items'), taskListItems.stdout)

    const runItemsResult = await runForeman(repoRoot, binary, [
      'task',
      'run',
      'items',
      '-p',
      'app',
      '--config',
      configPath,
      JSON.stringify(['alpha', 'bravo', 'charlie']),
    ])
    assert.ifError(runItemsResult.error)
    assert.equal(runItemsResult.status, 0, `stdout:\n${runItemsResult.stdout}\nstderr:\n${runItemsResult.stderr}`)

  } finally {
    await running?.stop()
    resetRegistry()
    if (oldForgeBin === undefined) delete process.env.WRENYARD_RUNTIME_BIN
    else process.env.WRENYARD_RUNTIME_BIN = oldForgeBin
    if (oldForgeArgsPrefix === undefined) delete process.env.WRENYARD_FORGE_ARGS_PREFIX
    else process.env.WRENYARD_FORGE_ARGS_PREFIX = oldForgeArgsPrefix
    if (oldDbPath === undefined) delete process.env.FOREMAN_DB_PATH
    else process.env.FOREMAN_DB_PATH = oldDbPath
  }
})

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function writeFmproj(workspace: string, projectId: string, repo: string): void {
  const parts = projectId.split('/')
  const name = parts.at(-1)
  assert.ok(name)
  const projectDir = join(workspace, 'projects', ...parts)
  mkdirSync(projectDir, { recursive: true })
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

function writeWorkspaceFixture(workspace: string): string {
  const repo = join(workspace, 'projects', 'app')
  mkdirSync(repo, { recursive: true })
  writeFmproj(workspace, 'app', repo)
  return repo
}

function writeJsonConfig(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
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

async function allocateFreeTcpPort(): Promise<number> {
  const server = createServer()
  await listen(server, 0)
  const port = serverPort(server)
  await closeServer(server)
  return port
}

function serverPort(server: Server): number {
  const address = server.address()
  assert(address && typeof address === 'object')
  return address.port
}

function installFakeForgeLines(dir: string, events: Array<Record<string, unknown>>): void {
  const output = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const script = join(dir, 'fake-forge.mjs')
  // The real native provider readiness probe invokes `forge providers list --json`
  // and `doctor clients --json` / `quota --json` before dispatch. Those calls must
  // return valid JSON so a clean host without an existing host login still
  // dispatches the task. Every other invocation keeps the exact inference stream
  // fixture unchanged.
  const scriptBody = [
    `const argv = process.argv.slice(2)`,
    `if (argv[0] === 'doctor' && argv[1] === 'clients') {`,
    `  process.stdout.write('{"ok":true,"checks":[{"adapter":"clients","status":"ok","details":{"codex":{"enabled":true,"installed":true}}}]}')`,
    `  process.exit(0)`,
    `}`,
    `if (argv[0] === 'providers' && argv[1] === 'list') {`,
    `  process.stdout.write(JSON.stringify([{ id: 'chatgpt', auth_ok: true }]) + '\\n')`,
    `  process.exit(0)`,
    `}`,
    `if (argv[0] === 'quota' && argv[1] === '--json') {`,
    `  process.stdout.write(JSON.stringify([]) + '\\n')`,
    `  process.exit(0)`,
    `}`,
    `process.stdout.write(${JSON.stringify(output)})`,
    '',
  ].join('\n')
  writeFileSync(script, scriptBody, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function forgeStreamEvent(seq: number, type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 'forge.agent.stream',
    version: 1,
    run_id: 'fr_cli_task_ipc',
    seq,
    type,
    timestamp: '2026-06-30T00:00:00.000Z',
    data,
  }
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

function runForeman(
  repoRoot: string,
  binary: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  const command = process.platform === 'win32' ? 'cmd' : join(repoRoot, 'node_modules', '.bin', 'tsx')
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'tsx', binary, ...args]
    : [binary, ...args]
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolve({ status: null, stdout, stderr, error })
    })
    child.on('close', (status) => {
      resolve({ status, stdout, stderr })
    })
  })
}

function runForemanSync(repoRoot: string, binary: string, args: string[]) {
  return process.platform === 'win32'
    ? spawnSync('cmd', ['/d', '/s', '/c', 'tsx', binary, ...args], {
        encoding: 'utf-8',
      })
    : spawnSync(join(repoRoot, 'node_modules', '.bin', 'tsx'), [binary, ...args], {
        encoding: 'utf-8',
      })
}
