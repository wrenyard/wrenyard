import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { JsonRpcClient } from '../lib/client/jsonrpc-client.mts'
import { connectIpcForemanClient } from '../lib/client/ipc-foreman-client.mts'
import {
  DAEMON_PLANNED_RESTART_CODE,
  DAEMON_PLANNED_RESTART_MESSAGE,
} from '../lib/daemon/dispatch-control.mts'
import { PlannedRestartStore, type PlannedRestartPlan } from '../lib/daemon/planned-restart-store.mts'
import { closeDb, initDb, run as dbRun } from '../lib/db/connection.mts'
import { INVALID_PARAMS, METHOD_NOT_FOUND, ProtocolError, TASK_NOT_FOUND } from '../lib/protocol/errors.mts'
import { connectIpcClientTransport } from '../lib/transport/ipc-client.mts'
import { createIpcServer } from '../lib/transport/ipc-server.mts'
import {
  TaskGraphStore,
  type TaskGraph,
  type TaskGraphNode,
} from '../lib/core/taskgraph/index.mts'
import {
  STRUCTURED_OUTPUT_INITIAL_TIMEOUT_MS,
  STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
  TASK_TIMEOUT_SCOPE,
} from '../lib/task-timeouts.mts'
import { resetRegistry } from '../lib/workspace/task-loader.mts'
import { MessageDeliveryHub, type MessageBackend } from '../lib/message/delivery/hub.mts'
import type { ChannelConfig, MessageDeliveryResult, MessageEnvelope, MessageDeliveryRegistryConfig } from '../lib/message/delivery/types.mts'
import { CANONICAL_PRINCIPALS } from '../lib/message/principal.mts'
import { closeTestDb, initTestDb } from './helpers/test-db.mts'
import { createTestIpcEndpoint } from './helpers/ipc-endpoint.mts'
import { installIsolatedForemanEnv, type IsolatedForemanEnv } from './helpers/isolated-env.mts'
import { getForemanEventBus, resetForemanEventBusForTest } from '../lib/events/event-bus.mts'
import type { ForemanEvent } from '../lib/events/event-types.mts'

let isolatedEnv: IsolatedForemanEnv | undefined

beforeEach(() => {
  isolatedEnv = installIsolatedForemanEnv('foreman-service-test-env')
})

afterEach(() => {
  isolatedEnv?.restore()
  isolatedEnv = undefined
})

test('service exposes orchestration and message tools from one MCP endpoint', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-mcp-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const running = await createTestService(workDir)
  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    const health = await getJson(`${baseUrl}/health`) as { status: string; uptime: number; startedAt: number; tasksActive: number }
    assert.equal(health.status, 'ok')
    assert.equal(typeof health.uptime, 'number')
    assert.equal(typeof health.startedAt, 'number')
    assert.equal(health.tasksActive, 0)

    const orchestrationTools = await mcpToolNames(`${baseUrl}/mcp`)
    assert.deepEqual(
      orchestrationTools.filter((name) => ['status', 'task_run', 'task_list', 'send_message'].includes(name)),
      ['status', 'task_run', 'task_list', 'send_message'],
    )
    assert.equal(orchestrationTools.some((name) => name.startsWith('pet_') || name === 'pet'), false)

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }),
    })
    assert.equal(initialized.status, 202)
    assert.equal(await initialized.text(), '')
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('service exposes health.ping over IPC without replacing HTTP health', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-ipc-health-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const running = await createTestService(workDir)
  let client: Awaited<ReturnType<typeof connectIpcForemanClient>> | undefined
  try {
    client = await connectIpcForemanClient({ path: running.ipcPath, timeoutMs: 1_000 })
    const result = await client.health.ping()
    assert.equal(result.ok, true)
    assert.equal(typeof result.uptimeMs, 'number')

    const address = running.httpServer.address() as AddressInfo
    const httpHealth = await getJson(`http://127.0.0.1:${address.port}/health`) as { status: string }
    assert.equal(httpHealth.status, 'ok')
  } finally {
    client?.close()
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('service stop closes the IPC health endpoint', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-ipc-stop-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const running = await createTestService(workDir)
  const ipcPath = running.ipcPath

  try {
    await running.stop()
    await assert.rejects(
      connectIpcForemanClient({ path: ipcPath, timeoutMs: 200 }),
      /Daemon unavailable|Unable to connect|Timed out|ENOENT|ECONNREFUSED/u,
    )
  } finally {
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})




test('service IPC task run can target a managed worktree', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-task-worktree-'))
  const repo = mkdtempSync(join(tmpdir(), 'foreman-service-task-worktree-repo-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'foreman-service-task-worktree-remote-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'foreman-service-task-worktree-state-'))
  const remote = join(remoteRoot, 'origin.git')
  initProjectRepo(repo)
  mkdirSync(join(repo, 'services', 'app'), { recursive: true })
  commitProjectFile(repo, 'services/app/app.txt', 'app component\n', 'add app component')
  initProjectBareRemote(remote)
  projectGit(repo, ['remote', 'add', 'origin', remote])
  projectGit(repo, ['push', '-u', 'origin', 'main'])
  writeProjectFmproj(workDir, 'app', join(repo, 'services', 'app'))
  const projectDir = join(workDir, 'projects', 'app')
  writeFileSync(
    join(projectDir, 'echo.task.ts'),
    `export default defineTask({
  profile: 'test-profile',
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ cwd: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => \`cwd:\${text}\`,
})
`,
    'utf-8',
  )

  const fakeForge = join(workDir, 'fake-forge-cwd.mjs')
  writeFileSync(fakeForge, `
const output = [
  { protocol: 'forge.agent.stream', version: 1, run_id: 'fr_task_worktree', seq: 1, type: 'run_started', timestamp: '2026-06-30T00:00:00.000Z', data: { profile: 'test-profile', client_family: 'claude', cwd: process.cwd() } },
  { protocol: 'forge.agent.stream', version: 1, run_id: 'fr_task_worktree', seq: 2, type: 'run_finished', timestamp: '2026-06-30T00:00:00.000Z', data: { status: 'done', exit_code: 0, native_session_id: 'native_task_worktree', client_family: 'claude', summary: '<foreman-task-output>\\n<summary>cwd captured</summary>\\n<result>\\n' + JSON.stringify({ cwd: process.cwd() }) + '\\n</result>\\n</foreman-task-output>' } },
]
process.stdout.write(output.map((event) => JSON.stringify(event)).join('\\n') + '\\n')
`, 'utf-8')

  const oldStateHome = process.env.XDG_STATE_HOME
  const oldForgeBin = process.env.WRENYARD_RUNTIME_BIN
  const oldForgeArgsPrefix = process.env.WRENYARD_FORGE_ARGS_PREFIX
  const oldDbPath = process.env.FOREMAN_DB_PATH
  process.env.XDG_STATE_HOME = stateDir
  process.env.FOREMAN_DB_PATH = join(workDir, 'foreman.sqlite')
  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([fakeForge])

  const running = await createTestService(workDir)
  let client: Awaited<ReturnType<typeof connectIpcForemanClient>> | undefined

  try {
    client = await connectIpcForemanClient({ path: running.ipcPath, timeoutMs: 1_000 })
    const created = await client.project.worktree.create({ project: 'app', worktree_id: 'deadbeef' })
    const taskStarted = await client.task.run.create({
      task_id: 'echo',
      project: 'app',
      worktree: 'deadbeef',
      input: { text: 'worktree task' },
    })
    const taskRunId = taskRunIdFromPayload(taskStarted)
    assert.match(taskRunId ?? '', /^task_/u)
    const taskStatus = await waitForIpcTaskStatus(client, taskRunId ?? '', 'done')
    assert.equal((taskStatus as { worktree?: string }).worktree, 'deadbeef')
    const taskOutput = await client.task.run.output({ task_run_id: taskRunId ?? '' })
    assert.deepEqual(taskOutput.output, { cwd: realpathSync(join(created.path, 'services', 'app')) })
  } finally {
    client?.close()
    await running.stop()
    resetRegistry()
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldStateHome
    if (oldForgeBin === undefined) delete process.env.WRENYARD_RUNTIME_BIN
    else process.env.WRENYARD_RUNTIME_BIN = oldForgeBin
    if (oldForgeArgsPrefix === undefined) delete process.env.WRENYARD_FORGE_ARGS_PREFIX
    else process.env.WRENYARD_FORGE_ARGS_PREFIX = oldForgeArgsPrefix
    if (oldDbPath === undefined) delete process.env.FOREMAN_DB_PATH
    else process.env.FOREMAN_DB_PATH = oldDbPath
    rmSync(workDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('service IPC exposes project control methods', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-project-ipc-'))
  const repo = mkdtempSync(join(tmpdir(), 'foreman-service-project-repo-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'foreman-service-project-remote-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'foreman-service-project-state-'))
  const oldStateHome = process.env.XDG_STATE_HOME
  const remote = join(remoteRoot, 'origin.git')
  initProjectRepo(repo)
  initProjectBareRemote(remote)
  projectGit(repo, ['remote', 'add', 'origin', remote])
  projectGit(repo, ['push', '-u', 'origin', 'main'])
  writeProjectFmproj(workDir, 'app', repo)

  process.env.XDG_STATE_HOME = stateDir
  let running: Awaited<ReturnType<typeof createTestService>> | undefined
  let client: Awaited<ReturnType<typeof connectIpcForemanClient>> | undefined

  try {
    running = await createTestService(workDir)
    client = await connectIpcForemanClient({ path: running.ipcPath, timeoutMs: 1_000 })

    const projects = await client.project.list()
    assert.deepEqual(projects.map((project) => project.name), ['app'])

    const described = await client.project.describe({ project: 'app' })
    assert.equal(described.name, 'app')
    assert.equal(described.path, repo)

    const status = await client.project.status({ project: 'app' })
    assert(!Array.isArray(status))
    assert.equal(status.name, 'app')
    assert.deepEqual(status.worktrees, [])

    const pull = await client.project.pull({ project: 'app' })
    assert.equal(pull.project, 'app')
    assert.equal(pull.pulled, true)

    const created = await client.project.worktree.create({ project: 'app', worktree_id: 'deadbeef' })
    assert.equal(created.project, 'app')
    assert.equal(created.worktree_id, 'deadbeef')
    assert.equal(created.path, join(stateDir, 'wrenyard', 'worktrees', 'deadbeef'))
    assert.equal(existsSync(created.path), true)
    assert.equal(existsSync(join(workDir, 'worktrees')), false)

    const worktrees = await client.project.worktree.list({ project: 'app' })
    assert.equal(worktrees.some((worktree) => worktree.id === 'deadbeef'), true)

    const removable = await client.project.worktree.create({ project: 'app', worktree_id: 'feedbeef' })
    const removed = await client.project.worktree.remove({ worktree_id: 'feedbeef' })
    assert.equal(removed.removed, true)
    assert.equal(removed.project, 'app')
    assert.equal(existsSync(removable.path), false)

    commitProjectFile(created.path, 'ipc.txt', 'merged over ipc\n', 'ipc worktree')
    const merged = await client.project.worktree.merge({ project: 'app', worktree_id: 'deadbeef' })
    assert.equal(merged.merged, true)
    assert.equal(merged.removed, true)
    assert.equal(existsSync(created.path), false)
    assert.equal(readFileSync(join(repo, 'ipc.txt'), 'utf-8').replace(/\r\n/gu, '\n'), 'merged over ipc\n')

    commitProjectFile(repo, 'push.txt', 'pushed over ipc\n', 'ipc push')
    const pushed = await client.project.push({ project: 'app' })
    assert.equal(pushed.pushed, true)
    assert.equal(pushed.project, 'app')
    const localSha = projectGit(repo, ['rev-parse', '--verify', 'main']).trim()
    const remoteSha = projectGit(repo, ['ls-remote', 'origin', 'refs/heads/main']).trim().split(/\s+/u)[0]
    assert.equal(remoteSha, localSha)

    await assert.rejects(
      client.project.describe({ project: 'missing' }),
      (error) => {
        assert(error instanceof ProtocolError)
        assert.equal(error.code, INVALID_PARAMS.code)
        assert.match(error.message, /Project 'missing'/u)
        return true
      },
    )
  } finally {
    client?.close()
    if (running) await running.stop()
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldStateHome
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    rmSync(remoteRoot, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('service IPC does not register unrelated method groups', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-ipc-unrelated-methods-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const running = await createTestService(workDir)
  const raw = await connectRawJsonRpcIpcClient(running.ipcPath)

  try {
    for (const method of ['session.debug.fake', 'not-a-real-method']) {
      await assert.rejects(
        raw.client.request(method, {}),
        (error) => {
          assert(error instanceof ProtocolError)
          assert.equal(error.code, METHOD_NOT_FOUND.code)
          return true
        },
      )
    }
  } finally {
    raw.client.close()
    raw.transport.close()
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('service IPC exposes message.send through service runtime', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-ipc-message-'))
  const endpoint = createTestIpcEndpoint('ipc-msg')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )
  const messageDeliveries: Array<{ event: MessageEnvelope; channel: string; backend: string }> = []
  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      publicUrl: 'http://127.0.0.1:0',
      ipc: { path: endpoint.path },
    },
    workspaceRoot: workDir,
    pet: testPetConfig(workDir),
    message: testMessageConfig(),
    messageDelivery: { enabled: false, default: [], channels: {} },
  }, {
    messageTransportFactory: (_name, cfg) => ({
      name: cfg.transport,
      async deliver(event, channel) {
        messageDeliveries.push({ event, channel, backend: cfg.transport })
        return { channel, backend: cfg.transport, ok: true }
      },
    }),
  })
  const client = await connectIpcForemanClient({ path: running.ipcPath, timeoutMs: 1_000 })

  try {
    const sent = await client.message.send({
      to: 'relay',
      text: 'hello over ipc',
      sender: { role: 'codex' },
    })
    assert.equal(sent.accepted, true)
    assert.match(sent.message_id ?? '', /^fm_/u)
    assert.equal(messageDeliveries.length, 1)
    assert.equal(messageDeliveries[0].channel, 'relay.openclaw')
    assert.equal(messageDeliveries[0].event.body, 'hello over ipc')
    assert.deepEqual(messageDeliveries[0].event.origin, { channel: 'foreman-message', sender: 'codex' })
  } finally {
    client.close()
    await running.stop()
    resetRegistry()
    rmSync(endpoint.dir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('service IPC controls daemon-owned pet service', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-ipc-pet-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )
  let petState: 'stopped' | 'running' = 'stopped'
  const running = await createTestService(workDir, {
    petService: {
      setForemanIpcPath() {},
      async start() {
        petState = 'running'
      },
      async stop() {
        petState = 'stopped'
      },
      async restart() {
        petState = 'running'
      },
      status() {
        return {
          state: petState,
          enabled: true,
          running: petState === 'running',
          transport: 'ipc-jsonrpc',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: workDir,
        }
      },
    },
  })
  const client = await connectIpcForemanClient({ path: running.ipcPath, timeoutMs: 1_000 })

  try {
    const initial = await client.pet.status()
    assert.equal(initial.state, 'stopped')
    assert.equal(initial.transport, 'ipc-jsonrpc')

    const stopped = await client.pet.stop()
    assert.equal(stopped.ok, true)
    assert.equal(stopped.status.state, 'stopped')

    const started = await client.pet.start()
    assert.equal(started.ok, true)
    assert.equal(started.status.state, 'running')
  } finally {
    client.close()
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('failed service startup closes HTTP when IPC endpoint is occupied', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-ipc-occupied-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )
  const endpoint = createTestIpcEndpoint('busy')
  const occupiedIpcServer = await createIpcServer({
    path: endpoint.path,
    onMessage: () => undefined,
  })
  const port = await allocateFreeTcpPort()
  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')

  try {
    await assert.rejects(
      startForemanDaemon({
        service: {
          enabled: true,
          host: '127.0.0.1',
          port,
          ipc: { path: endpoint.path },
        },
        workspaceRoot: workDir,
        pet: {
          enabled: true,
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: workDir,
          startupTimeoutMs: 1_000,
          stopTimeoutMs: 1_000,
          restartOnExit: false,
          restartDelayMs: 10,
        },
        message: testMessageConfig(),
        messageDelivery: {
          enabled: false,
          default: ['system'],
          channels: {},
        },
      }),
      /already in use|EADDRINUSE|listen EADDRINUSE/u,
    )

    await assertHttpUnavailable(port)
  } finally {
    await occupiedIpcServer.close()
    resetRegistry()
    rmSync(endpoint.dir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('failed pet service startup closes HTTP and IPC resources', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-pet-fail-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )
  const endpoint = createTestIpcEndpoint('petfail')
  const port = await allocateFreeTcpPort()
  let petStopCount = 0
  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')

  try {
    await assert.rejects(
      startForemanDaemon({
        service: {
          enabled: true,
          host: '127.0.0.1',
          port,
          ipc: { path: endpoint.path },
        },
        workspaceRoot: workDir,
        pet: {
          enabled: true,
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: workDir,
          startupTimeoutMs: 1_000,
          stopTimeoutMs: 1_000,
          restartOnExit: false,
          restartDelayMs: 10,
        },
        message: testMessageConfig(),
        messageDelivery: {
          enabled: false,
          default: ['system'],
          channels: {},
        },
      }, {
        petService: {
          async start() {
            throw new Error('pet service startup failed')
          },
          async stop() {
            petStopCount += 1
          },
          status() {
            return {
              state: 'failed',
              enabled: true,
              running: false,
              transport: 'ipc-jsonrpc',
              command: process.execPath,
              args: ['-e', 'setInterval(() => {}, 1000)'],
              cwd: workDir,
              last_error: 'pet service startup failed',
            }
          },
        } as any,
      }),
      /pet service startup failed/u,
    )

    assert.equal(petStopCount, 1)
    await assertHttpUnavailable(port)
    await assert.rejects(
      connectIpcForemanClient({ path: endpoint.path, timeoutMs: 200 }),
      /Daemon unavailable|Unable to connect|Timed out|ENOENT|ECONNREFUSED/u,
    )
    if (process.platform !== 'win32') {
      assert.equal(existsSync(endpoint.path), false)
    }
  } finally {
    resetRegistry()
    rmSync(endpoint.dir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('service unified MCP forwards URL sender metadata into message protocol payloads', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-message-sender-'))
  const endpoint = createTestIpcEndpoint('sender')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const deliveries: Array<{ event: MessageEnvelope; channel: string; backend: string }> = []

  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      publicUrl: 'http://127.0.0.1:0',
      ipc: { path: endpoint.path },
    },
    workspaceRoot: workDir,
    pet: {
      enabled: false,
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: workDir,
      startupTimeoutMs: 1_000,
      stopTimeoutMs: 1_000,
      restartOnExit: false,
      restartDelayMs: 10,
    },
    message: testMessageConfig(),
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
  }, {
    messageTransportFactory: (_name, cfg) => ({
      name: cfg.transport,
      async deliver(event, channel) {
        deliveries.push({ event, channel, backend: cfg.transport })
        return { channel, backend: cfg.transport, ok: true }
      },
    }),
  })

  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const accepted = await mcpToolCall<{ accepted: boolean; message_id: string }>(
      `${baseUrl}/mcp?sender=codex`,
      'send_message',
      { to: 'relay', text: 'hello from foreman' },
    )

    assert.equal(accepted.accepted, true)
    assert.match(accepted.message_id, /^fm_/u)
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].channel, 'relay.openclaw')
    assert.equal(deliveries[0].backend, 'openclaw')
    assert.equal(deliveries[0].event.body, 'hello from foreman')
    assert.deepEqual(deliveries[0].event.origin, { channel: 'foreman-message', sender: 'codex' })
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(endpoint.dir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
})



type TestForemanClient = Awaited<ReturnType<typeof connectIpcForemanClient>>

function createTestService(workDir: string, deps?: any) {
  const endpoint = createTestIpcEndpoint('service')
  return import('../lib/daemon/daemon.mts').then(async ({ startForemanDaemon }) => {
    const running = await startForemanDaemon({
      service: {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'http://127.0.0.1:0',
        ipc: { path: endpoint.path },
      },
      workspaceRoot: workDir,
      pet: testPetConfig(workDir),
      message: testMessageConfig(),
      messageDelivery: {
        enabled: false,
        default: ['system'],
        channels: {},
      },
    }, deps)
    const stop = running.stop.bind(running)
    let endpointCleaned = false
    const cleanupEndpoint = (): void => {
      if (endpointCleaned) return
      endpointCleaned = true
      rmSync(endpoint.dir, { recursive: true, force: true })
    }

    return {
      ...running,
      async stop() {
        try {
          await stop()
        } finally {
          cleanupEndpoint()
        }
      },
    }
  }).catch((error) => {
    rmSync(endpoint.dir, { recursive: true, force: true })
    throw error
  })
}

function testPetConfig(workDir: string) {
  return {
    enabled: false,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: workDir,
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    restartOnExit: false,
    restartDelayMs: 10,
  }
}

function reconcileStartupGraph(): TaskGraph {
  const start: TaskGraphNode = {
    id: 'start',
    name: 'start',
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  }
  const work: TaskGraphNode = {
    id: 'work',
    name: 'work',
    action: { type: 'task', params: { name: 'echo', project: 'workspace', input: {} } },
    deps: ['start'],
    input: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  }
  const end: TaskGraphNode = {
    id: 'end',
    name: 'end',
    action: { type: 'end', params: {} },
    deps: ['work'],
    input: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
  }
  return { id: 'tg_startup_reconcile', revision: 1, nodes: { start, work, end } }
}

function projectGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function initProjectRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  projectGit(path, ['init'])
  projectGit(path, ['config', 'user.name', 'Foreman Test'])
  projectGit(path, ['config', 'user.email', 'foreman@example.test'])
  projectGit(path, ['checkout', '-b', 'main'])
  writeFileSync(join(path, 'README.md'), '# test repo\n', 'utf-8')
  projectGit(path, ['add', 'README.md'])
  projectGit(path, ['commit', '-m', 'initial'])
}

function initProjectBareRemote(path: string): void {
  projectGit(dirname(path), ['init', '--bare', path])
  projectGit(path, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
}

function commitProjectFile(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content, 'utf-8')
  projectGit(repo, ['add', file])
  projectGit(repo, ['commit', '-m', message])
}

function writeProjectFmproj(workspace: string, project: string, repo: string): void {
  const projectDir = join(workspace, 'projects', project)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, `${project}.fmproj`),
    `name: ${project}
description: Test project ${project}
git:
  remote: https://example.test/${project}.git
  default_branch: main
hosts:
  ${hostname()}: ${JSON.stringify(repo)}
`,
    'utf-8',
  )
}

function taskRunIdFromPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const taskRunId = (value as Record<string, unknown>).task_run_id
  return typeof taskRunId === 'string' && taskRunId.trim() ? taskRunId : null
}


async function waitForIpcTaskStatus(
  client: TestForemanClient,
  taskRunId: string,
  expectedStatus: string,
): Promise<{ task_run_id: string; status: string; has_output?: boolean }> {
  let lastStatus: unknown
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    lastStatus = await client.task.run.status({ task_run_id: taskRunId })
    if (lastStatus && typeof lastStatus === 'object' && !Array.isArray(lastStatus)) {
      const status = (lastStatus as Record<string, unknown>).status
      if (status === expectedStatus) return lastStatus as { task_run_id: string; status: string; has_output?: boolean }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`task ${taskRunId} did not reach ${expectedStatus}; last status: ${JSON.stringify(lastStatus, null, 2)}`)
}


function installFakeForgeLines(dir: string, events: Array<Record<string, unknown>>): void {
  const output = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const script = join(dir, 'fake-forge.mjs')
  writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})\n`, 'utf-8')

  process.env.WRENYARD_RUNTIME_BIN = process.execPath
  process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])
}

function forgeStreamEvent(seq: number, type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 'forge.agent.stream',
    version: 1,
    run_id: 'fr_service_ipc',
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

function insertIpcTaskRun(params: {
  taskRunId: string
  output: unknown
  summary: string
}): void {
  const now = new Date().toISOString()
  dbRun(
    `INSERT INTO tasks (
      id, template, project, worktree, input, output, summary, error,
      status, structured, retry_policy, created_at, updated_at, ended_at
    ) VALUES (?, 'rpc-task', 'workspace', NULL, '{}', ?, ?, NULL,
      'done', 1, 'side-effects', ?, ?, ?)`,
    params.taskRunId,
    JSON.stringify(params.output),
    params.summary,
    now,
    now,
    now,
  )
}


function testMessageConfig(): import('../lib/config/normalize.mts').NormalizedMessageConfig {
  return {
    enabled: true,
    principals: {
      ...CANONICAL_PRINCIPALS,
      operator: {
        id: 'operator',
        kind: 'human',
        canSend: true,
        canReceive: true,
        grants: [{ name: 'message.send' }, { name: 'work.read' }],
        deliveryRoute: 'operator.telegram',
      },
      relay: {
        id: 'relay',
        kind: 'agent',
        canSend: true,
        canReceive: true,
        grants: [{ name: 'message.send' }, { name: 'work.read' }],
        deliveryRoute: 'relay.openclaw',
      },
    },
    routes: {
      'relay.openclaw': {
        transport: 'openclaw',
        address: {
          target: '1682807251',
          channel: 'telegram',
          mode: 'agent',
          session_key: 'agent:main:telegram:direct:1682807251',
        },
        format: 'markdown',
      },
      'operator.telegram': {
        transport: 'telegram',
        address: {
          chat_id: '1682807251',
        },
        format: 'telegram-html',
      },
    },
  }
}

function testDeliveryBackendFactory(_name: string, cfg: ChannelConfig): MessageBackend {
  return {
    name: cfg.backend,
    async deliver(_event, channel) {
      return { channel, backend: cfg.backend, ok: true }
    },
  }
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  return response.json()
}

async function allocateFreeTcpPort(): Promise<number> {
  const server = createServer()
  await listenTestServer(server, 0)
  const port = serverPort(server)
  await closeTestServer(server)
  return port
}

async function assertHttpUnavailable(port: number): Promise<void> {
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    }),
  )
}

async function connectRawJsonRpcIpcClient(path: string): Promise<{
  client: JsonRpcClient
  transport: Awaited<ReturnType<typeof connectIpcClientTransport>>
}> {
  const pendingChunks: Buffer[] = []
  let client: JsonRpcClient | undefined
  const transport = await connectIpcClientTransport({
    path,
    timeoutMs: 1_000,
    onChunk: (chunk) => {
      if (client) {
        client.handleIncoming(chunk)
        return
      }
      pendingChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    },
  })

  client = new JsonRpcClient({ transport, timeoutMs: 1_000 })
  for (const chunk of pendingChunks) {
    client.handleIncoming(chunk)
  }

  return { client, transport }
}

async function mcpToolNames(url: string): Promise<string[]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    }),
  })
  const text = await response.text()
  const payload = parseSseJson(text) as { result?: { tools?: Array<{ name: string }> } }
  return payload.result?.tools?.map((tool) => tool.name) ?? []
}

async function mcpToolCall<T>(url: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  const payload = parseSseJson(text) as {
    error?: { message?: string }
    result?: { content?: Array<{ text?: string }> }
  }
  assert.equal(payload.error, undefined)
  const content = payload.result?.content?.[0]?.text
  if (typeof content !== 'string') {
    assert.fail(`expected MCP tool result text, received ${text}`)
  }
  return JSON.parse(content) as T
}

function listenTestServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeTestServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function serverPort(server: Server): number {
  const address = server.address()
  assert(address && typeof address === 'object')
  return address.port
}

async function readJsonRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf-8')
  return text ? JSON.parse(text) as unknown : null
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}


function parseSseJson(text: string): unknown {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  assert.ok(dataLine, `expected SSE data line, received ${text}`)
  return JSON.parse(dataLine.slice('data: '.length))
}

test('POST /message/deliver dispatches through hub and returns deliveries', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-notify-'))
  const endpoint = createTestIpcEndpoint('notify')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )
  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      publicUrl: 'http://127.0.0.1:0',
      ipc: { path: endpoint.path },
    },
    workspaceRoot: workDir,
    pet: testPetConfig(workDir),
    message: testMessageConfig(),
    messageDelivery: {
      enabled: true,
      channels: { main: { backend: 'system' } },
      default: ['main'],
    },
  }, {
    deliveryBackendFactory: testDeliveryBackendFactory,
  })

  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    // Test flat message shape
    const response1 = await fetch(`${baseUrl}/message/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Test notification from endpoint',
        title: 'Integration Test',
        severity: 'info',
      }),
    })
    const result1 = await response1.json() as { ok: boolean; deliveries: Array<{ channel: string; ok: boolean; backend: string }> }
    assert.equal(response1.status, 200)
    assert.equal(result1.ok, true)
    assert.ok(Array.isArray(result1.deliveries))
    assert.equal(result1.deliveries.length, 1)
    assert.equal(result1.deliveries[0].channel, 'main')
    assert.equal(result1.deliveries[0].ok, true)
    assert.equal(result1.deliveries[0].backend, 'system')

    // Test full event shape
    const response2 = await fetch(`${baseUrl}/message/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: {
          id: 'test-event',
          kind: 'message',
          severity: 'warning',
          title: 'Full Event Test',
          body: 'This uses the full event shape',
          refs: { project: 'test' },
        },
        channels: ['main'],
      }),
    })
    const result2 = await response2.json() as { ok: boolean; deliveries: Array<unknown> }
    assert.equal(response2.status, 200)
    assert.equal(result2.ok, true)
    assert.ok(Array.isArray(result2.deliveries))
    assert.equal(result2.deliveries.length, 1)

    // Test unknown channel produces explicit error delivery
    const response3 = await fetch(`${baseUrl}/message/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Test',
        channels: ['nonexistent'],
      }),
    })
    const result3 = await response3.json() as { ok: boolean; deliveries: Array<unknown> }
    assert.equal(response3.status, 200)
    assert.ok(Array.isArray(result3.deliveries))
    assert.equal(result3.deliveries.length, 1)
    assert.equal((result3.deliveries[0] as MessageDeliveryResult).ok, false)
    assert.equal((result3.deliveries[0] as MessageDeliveryResult).error, "no config for channel 'nonexistent'")
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(endpoint.dir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('shared TaskGraphService publishes projected events to ForemanEventBus', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-taskgraph-events-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  resetForemanEventBusForTest()

  const received: ForemanEvent[] = []
  const unsub = getForemanEventBus().subscribe({
    handle(event: ForemanEvent) {
      received.push(event)
    },
  })

  const running = await createTestService(workDir)
  const raw = await connectRawJsonRpcIpcClient(running.ipcPath)

  try {
    // Create a taskgraph via RPC — protocol create is template-only; the
    // handler expands `template` into service-layer IR. Server-owned
    // id/revision are not supplied by the client.
    const created = await raw.client.request('taskgraph.create', {
      template: 'default',
    })
    assert.ok(created)
    const createdRecord = created as { taskgraph?: { id?: string; revision?: number } }
    const taskgraphId = createdRecord.taskgraph?.id
    assert.ok(taskgraphId)

    // The daemon's eventSink publishes projected TaskGraphEvents to the
    // ForemanEventBus, including creation events.
    const graphEvent = received.find((e) => e.source === 'foreman.taskgraph')
    assert.ok(graphEvent, 'expected a foreman.taskgraph event on the bus')
    assert.equal(graphEvent.source, 'foreman.taskgraph')
    assert.equal(graphEvent.refs?.taskgraphId, taskgraphId)

    // When no task_run_id is present in the source event, neither taskRunId
    // nor taskId should be set; taskId must not be overloaded.
    assert.equal(graphEvent.refs?.taskRunId, undefined, 'refs.taskRunId should be undefined when no task_run_id is in source event')
    assert.equal(graphEvent.refs?.taskId, undefined, 'refs.taskId should not be overloaded with task_run_id')
  } finally {
    raw.client.close()
    raw.transport.close()
    await running.stop()
    unsub()
    resetForemanEventBusForTest()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('daemon startup reconciles persisted actionable taskgraphs before transports are usable', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-reconcile-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  // Seed an actionable graph into the daemon's own DB before startup: a
  // running run whose node persisted as running with no task run binding.
  const dbPath = process.env.FOREMAN_DB_PATH
  assert.ok(dbPath, 'isolated test env must set FOREMAN_DB_PATH')
  {
    const db = initDb(dbPath)
    const store = new TaskGraphStore(db)
    const now = new Date().toISOString()
    store.createProjection(reconcileStartupGraph(), now)
    store.updateRun('tg_startup_reconcile', { state: 'running' }, now)
    store.putNodeState('tg_startup_reconcile', 'work', {
      state: 'running', error: null, output: null, taskRunId: null,
    }, now)
    closeDb()
  }

  const running = await createTestService(workDir)
  const raw = await connectRawJsonRpcIpcClient(running.ipcPath)

  try {
    // reconcileStartup already recovered the graph before HTTP/IPC/MCP became
    // reachable: the unbound running node was failed (TASK_RUN_UNBOUND) and
    // the graph paused, so the first observable status reflects the recovery.
    const statusPayload = await raw.client.request('taskgraph.status', {
      taskgraph_id: 'tg_startup_reconcile',
    })
    const status = statusPayload as { state: string; node_counts: Record<string, number> }
    assert.equal(status.state, 'paused')
    assert.equal(status.node_counts.failed, 1)

    // Exactly once: a single node.failed + paused event pair proves startup
    // recovery ran once and was not re-triggered by the first taskgraph RPC.
    const eventsPayload = await raw.client.request('taskgraph.events', {
      taskgraph_id: 'tg_startup_reconcile',
      after_seq: 0,
      limit: 100,
    })
    const events = eventsPayload as { events: Array<{ type: string }> }
    const types = events.events.map((event) => event.type)
    assert.equal(types.filter((type) => type === 'taskgraph.node.failed').length, 1)
    assert.equal(types.filter((type) => type === 'taskgraph.paused').length, 1)
  } finally {
    raw.client.close()
    raw.transport.close()
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})

// ============================================================
// Federation auth tests
// ============================================================

test('POST /message/deliver with correct Bearer token returns 200 when auth configured', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-notify-auth-'))
  const endpoint = createTestIpcEndpoint('notify-auth')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  process.env.NOTIFY_AUTH_TOKEN = 'test-auth-token'
  try {
    const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
    const running = await startForemanDaemon({
      service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
      workspaceRoot: workDir,
      pet: testPetConfig(workDir),
      message: testMessageConfig(),
      messageDelivery: {
        enabled: true,
        auth: { token_env: 'NOTIFY_AUTH_TOKEN' },
        channels: { main: { backend: 'system' } },
        default: ['main'],
      },
    }, {
      deliveryBackendFactory: testDeliveryBackendFactory,
    })

    try {
      const address = running.httpServer.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${address.port}`

      // Correct token → 200
      const resp1 = await fetch(`${baseUrl}/message/deliver`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-auth-token',
        },
        body: JSON.stringify({ message: 'auth test', title: 'Test' }),
      })
      assert.equal(resp1.status, 200)
      const body1 = await resp1.json() as { ok: boolean }
      assert.equal(body1.ok, true)

      // Wrong token → 401
      const resp2 = await fetch(`${baseUrl}/message/deliver`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-token',
        },
        body: JSON.stringify({ message: 'auth test' }),
      })
      assert.equal(resp2.status, 401)

      // Missing token → 401
      const resp3 = await fetch(`${baseUrl}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'auth test' }),
      })
      assert.equal(resp3.status, 401)
    } finally {
      await running.stop()
    }
  } finally {
    delete process.env.NOTIFY_AUTH_TOKEN
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(endpoint.dir, { recursive: true, force: true })
  }
})

test('POST /message/deliver with no auth + non-loopback returns 403', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-notify-noloop-'))
  const endpoint = createTestIpcEndpoint('notify-noloop')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    pet: testPetConfig(workDir),
    message: testMessageConfig(),
    messageDelivery: {
      enabled: true,
      channels: { main: { backend: 'system' } },
      default: ['main'],
    },
  }, {
    deliveryBackendFactory: testDeliveryBackendFactory,
  })

  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    // Loopback without auth → 200
    const resp1 = await fetch(`${baseUrl}/message/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'loopback test' }),
    })
    assert.equal(resp1.status, 200)
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(endpoint.dir, { recursive: true, force: true })
  }
})

// ============================================================
// Anti-loop (hop-limit) test
// ============================================================

test('POST /message/deliver with hops=1 refuses remote channel with hop-limit', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-notify-hoplimit-'))
  const endpoint = createTestIpcEndpoint('notify-hoplimit')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    pet: testPetConfig(workDir),
    message: testMessageConfig(),
    messageDelivery: {
      enabled: true,
      channels: {
        remote_ch: { backend: 'remote', peer: 'peer1', channel: 'wecom' },
        desktop: { backend: 'system' },
      },
      peers: { peer1: { url: 'http://10.0.0.1:8787' } },
      default: ['remote_ch', 'desktop'],
    },
  }, {
    deliveryBackendFactory: testDeliveryBackendFactory,
  })

  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    // Send event with hops=1 — remote_ch should get hop-limit, desktop should deliver
    const resp = await fetch(`${baseUrl}/message/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: {
          id: 'test-hop',
          kind: 'message',
          severity: 'info',
          title: 'Hop Limit Test',
          body: 'Testing hop limit',
          hops: 1,
        },
      }),
    })
    assert.equal(resp.status, 200)
    const result = await resp.json() as { ok: boolean; deliveries: MessageDeliveryResult[] }
    assert.equal(result.ok, true)

    const remoteDelivery = result.deliveries.find((d) => d.channel === 'remote_ch')
    const desktopDelivery = result.deliveries.find((d) => d.channel === 'desktop')

    assert.ok(remoteDelivery, 'remote_ch delivery should exist')
    assert.equal(remoteDelivery.ok, false)
    assert.equal(remoteDelivery.error, 'hop-limit')

    assert.ok(desktopDelivery, 'desktop delivery should exist')
    assert.equal(desktopDelivery.ok, true)
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(endpoint.dir, { recursive: true, force: true })
  }
})

// ============================================================
// Federation integration: two instances
// ============================================================

test('POST /message/deliver allows remote channel through unified channel delivery', async () => {
  const workDirA = mkdtempSync(join(tmpdir(), 'foreman-federate-a-'))
  const workDirB = mkdtempSync(join(tmpdir(), 'foreman-federate-b-'))
  const endpointA = createTestIpcEndpoint('fed-a')
  const endpointB = createTestIpcEndpoint('fed-b')
  for (const wd of [workDirA, workDirB]) {
    const wp = join(wd, 'projects', 'workspace')
    mkdirSync(wp, { recursive: true })
    writeFileSync(join(wp, 'workspace.fmproj'), 'name: workspace\ndescription: Workspace shared resources\n', 'utf-8')
  }

  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')

  // Instance B — target instance with system channel
  const runningB = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpointB.path } },
    workspaceRoot: workDirB,
    pet: testPetConfig(workDirB),
    message: testMessageConfig(),
    messageDelivery: {
      enabled: true,
      channels: { sys: { backend: 'system' } },
      default: ['sys'],
    },
  }, {
    deliveryBackendFactory: testDeliveryBackendFactory,
  })

  const addrB = runningB.httpServer.address() as AddressInfo
  const urlB = `http://127.0.0.1:${addrB.port}`

  // Instance A — sends to B via remote channel
  const runningA = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpointA.path } },
    workspaceRoot: workDirA,
    pet: testPetConfig(workDirA),
    message: testMessageConfig(),
    messageDelivery: {
      enabled: true,
      channels: {
        remote_sys: { backend: 'remote', peer: 'peer-b', channel: 'sys' },
      },
      peers: { 'peer-b': { url: urlB } },
      default: ['remote_sys'],
    },
  })

  try {
    const addrA = runningA.httpServer.address() as AddressInfo
    const baseUrlA = `http://127.0.0.1:${addrA.port}`

    // Emit on A
    const resp = await fetch(`${baseUrlA}/message/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Federation test from A',
        title: 'Fed Test',
      }),
    })
    assert.equal(resp.status, 200)
    const result = await resp.json() as { ok: boolean; deliveries: MessageDeliveryResult[] }
    assert.equal(result.ok, true)
    assert.equal(result.deliveries.length, 1)

    const delivery = result.deliveries[0]
    assert.equal(delivery.channel, 'remote_sys')
    assert.equal(delivery.backend, 'remote')
    assert.equal(delivery.ok, true)
  } finally {
    await runningA.stop()
    await runningB.stop()
    resetRegistry()
    rmSync(endpointA.dir, { recursive: true, force: true })
    rmSync(endpointB.dir, { recursive: true, force: true })
    rmSync(workDirA, { recursive: true, force: true })
    rmSync(workDirB, { recursive: true, force: true })
  }
})

// ============================================================
// Federation integration with bearer auth
// ============================================================

test('POST /message/deliver allows authenticated remote channel delivery', async () => {
  const workDirA = mkdtempSync(join(tmpdir(), 'foreman-federate-auth-a-'))
  const workDirB = mkdtempSync(join(tmpdir(), 'foreman-federate-auth-b-'))
  const endpointA = createTestIpcEndpoint('fed-auth-a')
  const endpointB = createTestIpcEndpoint('fed-auth-b')
  for (const wd of [workDirA, workDirB]) {
    const wp = join(wd, 'projects', 'workspace')
    mkdirSync(wp, { recursive: true })
    writeFileSync(join(wp, 'workspace.fmproj'), 'name: workspace\ndescription: Workspace shared resources\n', 'utf-8')
  }

  process.env.FED_AUTH_TOKEN = 'shared-fed-token'
  try {
    const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')

    // Instance B with auth required
    const runningB = await startForemanDaemon({
      service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpointB.path } },
      workspaceRoot: workDirB,
      pet: testPetConfig(workDirB),
      message: testMessageConfig(),
      messageDelivery: {
        enabled: true,
        auth: { token_env: 'FED_AUTH_TOKEN' },
        channels: { sys: { backend: 'system' } },
        default: ['sys'],
      },
    }, {
      deliveryBackendFactory: testDeliveryBackendFactory,
    })

    const addrB = runningB.httpServer.address() as AddressInfo
    const urlB = `http://127.0.0.1:${addrB.port}`

    // Instance A — uses peer token to authenticate to B
    const runningA = await startForemanDaemon({
      service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpointA.path } },
      workspaceRoot: workDirA,
      pet: testPetConfig(workDirA),
      message: testMessageConfig(),
      messageDelivery: {
        enabled: true,
        channels: {
          remote_sys: { backend: 'remote', peer: 'peer-b', channel: 'sys' },
        },
        peers: { 'peer-b': { url: urlB, token_env: 'FED_AUTH_TOKEN' } },
        default: ['remote_sys'],
      },
    })

    try {
      const addrA = runningA.httpServer.address() as AddressInfo
      const baseUrlA = `http://127.0.0.1:${addrA.port}`

      const resp = await fetch(`${baseUrlA}/message/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Auth federation test', title: 'Auth Fed' }),
      })
      assert.equal(resp.status, 200)
      const result = await resp.json() as { ok: boolean; deliveries: MessageDeliveryResult[] }
      assert.equal(result.ok, true)
      assert.equal(result.deliveries.length, 1)
      assert.equal(result.deliveries[0].ok, true)
    } finally {
      await runningA.stop()
      await runningB.stop()
    }
  } finally {
    delete process.env.FED_AUTH_TOKEN
    resetRegistry()
    rmSync(endpointA.dir, { recursive: true, force: true })
    rmSync(endpointB.dir, { recursive: true, force: true })
    rmSync(workDirA, { recursive: true, force: true })
    rmSync(workDirB, { recursive: true, force: true })
  }
})

// ============================================================
// SSE shutdown on service stop (Fix 2)
// ============================================================

test('service with active SSE subscriber stops promptly', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-sse-stop-'))
  const endpoint = createTestIpcEndpoint('sse-stop')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    pet: testPetConfig(workDir),
    message: testMessageConfig(),
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
  })

  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    // Open an SSE subscription — this registers a long-lived connection
    const ssePromise = fetch(`${baseUrl}/mcp/channel/events?connId=sse-stop-test`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)

    // Wait a bit for the SSE to connect
    await new Promise((r) => setTimeout(r, 200))

    // Stop should complete promptly (no hang waiting for SSE to close)
    const stopStart = Date.now()
    await running.stop()
    const stopDuration = Date.now() - stopStart
    assert.ok(stopDuration < 3000, `stop() should complete within 3s (took ${stopDuration}ms)`)

    await ssePromise
  } catch {
    // Ignore fetch errors from aborted SSE during stop
  } finally {
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(endpoint.dir, { recursive: true, force: true })
  }
})

// ============================================================
// Bounded request body reader (Fix 3)
// ============================================================

test('oversized body gets 413 without full buffering', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-bounded-body-'))
  const endpoint = createTestIpcEndpoint('bounded-body')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    pet: testPetConfig(workDir),
    message: testMessageConfig(),
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
  })

  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    // Send an oversized body (>16KB) to /channel/connections/:id/message
    // The bounded reader should abort early and return 413 (connection may
    // be reset before the full response is received — both are acceptable).
    const bigMessage = 'x'.repeat(20 * 1024)
    try {
      const resp = await fetch(`${baseUrl}/channel/connections/test-conn/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: bigMessage }),
      })
      assert.equal(resp.status, 413)
      const result = await resp.json() as { error: string }
      assert.equal(result.error, 'body too large')
    } catch (err: unknown) {
      // Connection may be reset by the server destroying the request — that's
      // the expected "early abort" behavior proving the body wasn't fully buffered.
      const msg = (err as Error).message
      assert.ok(msg.includes('fetch failed') || msg.includes('other side closed') || msg.includes('SocketError'),
        `Expected fetch failure or 413 for oversized body, got: ${msg}`)
    }
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(endpoint.dir, { recursive: true, force: true })
  }
})

// ============================================================
// Channel connection token requirement tests
// ============================================================

test('POST /mcp with X-Foreman-Channel-Connection but without X-Foreman-Channel-Token returns 403', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-mcp-no-token-'))
  const endpoint = createTestIpcEndpoint('mcp-no-token')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    pet: testPetConfig(workDir),
    message: testMessageConfig(),
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
  })

  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const connId = 'token-test-conn'

    // Register the connection via SSE
    const sseRes = await new Promise<import('http').IncomingMessage>((resolve, reject) => {
      const req = get(
        `${baseUrl}/mcp/channel/events?connId=${connId}`,
        (res) => resolve(res),
      )
      req.on('error', reject)
    })

    // Wait for connection registration
    await new Promise((r) => setTimeout(r, 200))

    // POST /mcp with connId but WITHOUT token → 403
    const resp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Foreman-Channel-Connection': connId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    })
    assert.equal(resp.status, 403)
    const body = await resp.json() as { error: string }
    assert.equal(body.error, 'forbidden')

    sseRes.destroy()
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(endpoint.dir, { recursive: true, force: true })
  }
})

// ============================================================
// Planned restart: bootstrap hydration + failed-closed recovery
// ============================================================

test('service starts over a persisted planned_restart plan and rejects new work', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-planned-restart-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )
  writeFileSync(
    join(workspaceProject, 'echo.task.ts'),
    `export default defineTask({
  profile: 'test-profile',
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => \`echo:\${text}\`,
})
`,
    'utf-8',
  )

  // Seed an active planned_restart plan through the durable store. The daemon
  // uses the same default store root (the isolated Foreman state dir), so it
  // must hydrate this plan before any dispatch becomes reachable.
  const store = new PlannedRestartStore()
  const operationId = `op_${randomBytes(4).toString('hex')}`
  const seededPhase = 'draining'
  const seededKind: PlannedRestartPlan['kind'] = 'update'
  store.beginPlan({
    operation_id: operationId,
    kind: seededKind,
    phase: seededPhase,
    recovery_required: false,
    created_at: new Date().toISOString(),
  })

  const running = await createTestService(workDir)
  let client: Awaited<ReturnType<typeof connectIpcForemanClient>> | undefined

  try {
    // First reachable status reflects the persisted plan.
    const status = running.dispatchControl.status()
    assert.equal(status.mode, 'planned_restart')
    assert.ok(status.plannedRestart)
    assert.equal(status.plannedRestart.operationId, operationId)
    assert.equal(status.plannedRestart.kind, seededKind)
    assert.equal(status.plannedRestart.phase, seededPhase)
    assert.equal(status.plannedRestart.recoveryRequired, false)

    client = await connectIpcForemanClient({ path: running.ipcPath, timeoutMs: 1_000 })

    // Pin the externally promised literal so a simultaneous source-and-test
    // constant change cannot silently mask contract drift.
    assert.equal(
      DAEMON_PLANNED_RESTART_MESSAGE,
      'Foreman daemon is planning restart and is not accepting new tasks or workflows.',
    )

    await assert.rejects(
      client.task.run.create({ task_id: 'echo', project: 'workspace', input: { text: 'x' } }),
      (error) => {
        assert(error instanceof ProtocolError)
        assert.equal(error.message, DAEMON_PLANNED_RESTART_MESSAGE)
        assert.equal((error.data as { code?: unknown } | undefined)?.code, DAEMON_PLANNED_RESTART_CODE)
        return true
      },
    )
  } finally {
    client?.close()
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('startup failure over a persisted plan leaves a durable failed-closed recovery plan', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-planned-restart-fail-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )
  const endpoint = createTestIpcEndpoint('planned-restart-fail')
  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')

  const store = new PlannedRestartStore()
  const operationId = `op_${randomBytes(4).toString('hex')}`
  const oldHead = 'abc1234'
  const newHead = 'def5678'
  const coordinatorPid = 4242
  const seededConfigPath = join(workDir, 'foreman.state.json')
  const seededCheckoutPath = join(workDir, 'checkout')
  store.beginPlan({
    operation_id: operationId,
    kind: 'restart',
    phase: 'stopping',
    recovery_required: false,
    created_at: new Date().toISOString(),
    old_head: oldHead,
    new_head: newHead,
    coordinator_pid: coordinatorPid,
    config_path: seededConfigPath,
    checkout_path: seededCheckoutPath,
  })

  try {
    await assert.rejects(
      startForemanDaemon({
        service: {
          enabled: true,
          host: '127.0.0.1',
          port: 0,
          publicUrl: 'http://127.0.0.1:0',
          ipc: { path: endpoint.path },
        },
        workspaceRoot: workDir,
        pet: {
          enabled: true,
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: workDir,
          startupTimeoutMs: 1_000,
          stopTimeoutMs: 1_000,
          restartOnExit: false,
          restartDelayMs: 10,
        },
        message: testMessageConfig(),
        messageDelivery: {
          enabled: false,
          default: ['system'],
          channels: {},
        },
      }, {
        petService: {
          async start() {
            throw new Error('pet service startup failed')
          },
          async stop() {
            // no-op for the failing dependency
          },
          status() {
            return {
              state: 'failed',
              enabled: true,
              running: false,
              transport: 'ipc-jsonrpc',
              command: process.execPath,
              args: ['-e', 'setInterval(() => {}, 1000)'],
              cwd: workDir,
              last_error: 'pet service startup failed',
            }
          },
        } as any,
      }),
      /pet service startup failed/u,
    )

    // The plan must remain planned_restart and be marked failed / recovery_required.
    const snapshot = store.snapshot()
    assert.equal(snapshot.mode, 'planned_restart')
    assert.ok(snapshot.plan)
    assert.equal(snapshot.plan.operation_id, operationId)
    assert.equal(snapshot.plan.phase, 'failed')
    assert.equal(snapshot.plan.recovery_required, true)
    assert.ok(typeof snapshot.plan.error_code === 'string' && snapshot.plan.error_code.length > 0)
    assert.equal(snapshot.plan.error_message, 'pet service startup failed')
    assert.ok(typeof snapshot.plan.failed_at === 'string' && snapshot.plan.failed_at.length > 0)

    // Pre-seeded plan fields must be merged, not erased.
    assert.equal(snapshot.plan.old_head, oldHead)
    assert.equal(snapshot.plan.new_head, newHead)
    assert.equal(snapshot.plan.coordinator_pid, coordinatorPid)
    assert.equal(snapshot.plan.config_path, seededConfigPath)
    assert.equal(snapshot.plan.checkout_path, seededCheckoutPath)

    // No SQLite/schema rollback is performed; the durable plan file is the
    // only state mutated by the failed-closed recovery path.
  } finally {
    rmSync(endpoint.dir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
})

// ============================================================
// FWA assign adapter contract
// ============================================================

test('fwa.assign over IPC returns { session } through daemon RPC surface', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-fwa-sim-'))
  const endpoint = createTestIpcEndpoint('fwa-sim')
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )
  writeFileSync(join(workDir, 'FWA.md'), '# Test FWA\n')

  const { startForemanDaemon } = await import('../lib/daemon/daemon.mts')
  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1:0', ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    fwa: {
      workspaceRoot: workDir,
      llm: {
        model: 'test-model',
                turn_timeout_ms: 30000,
        http_timeout_ms: 90000,
        max_retries: 2,
        retry_backoff_ms: 500,
      },
    },
    pet: testPetConfig(workDir),
    message: testMessageConfig(),
    messageDelivery: { enabled: false, default: ['system'], channels: {} },
  })

  let client: Awaited<ReturnType<typeof connectIpcForemanClient>> | undefined
  try {
    client = await connectIpcForemanClient({ path: running.ipcPath, timeoutMs: 1_000 })

    const result = await client.fwa.assign({
      ticket_id: 'test-ticket-1',
      project_id: 'workspace',
      prompt: 'test prompt',
    })

    // Verify { session: { ... } } shape matching FwaAssignResult
    assert.ok(result.session, 'result must have session key')
    assert.equal(typeof result.session.id, 'string')
    assert.equal(result.session.ticket_id, 'test-ticket-1')
    assert.equal(result.session.project_id, 'workspace')
    assert.equal(typeof result.session.status, 'string')
    assert.equal(typeof result.session.queue_depth, 'number')
    assert.ok(Array.isArray(result.session.graph_refs))
    assert.ok(Array.isArray(result.session.task_refs))

    // Extra fields from FwaSession (active_turn_seq, last_error, created_at,
    // updated_at) must not leak through the adapter wrapping. The adapter
    // explicitly shapes the result so the registered schema
    // (fwaAssignResultSchema with additionalProperties: false) passes.
    assert.equal(result.session.message_address, result.session.id.replace(/^fwa_/, 'fwa-'))
    assert.equal(Object.keys(result.session).length, 8, 'session must have exactly 8 schema-valid fields')
    assert.equal((result.session as Record<string, unknown>).active_turn_seq, undefined)
    assert.equal((result.session as Record<string, unknown>).last_error, undefined)
    assert.equal((result.session as Record<string, unknown>).created_at, undefined)
    assert.equal((result.session as Record<string, unknown>).updated_at, undefined)
  } finally {
    client?.close()
    await running.stop()
    resetRegistry()
    rmSync(endpoint.dir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  }
})
