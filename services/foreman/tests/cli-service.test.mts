import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { startForemanDaemon } from '../lib/daemon/daemon.mts'
import { PlannedRestartStore } from '../lib/daemon/planned-restart-store.mts'
import { resetRegistry } from '../lib/workspace/task-loader.mts'
import { createTestIpcEndpoint } from './helpers/ipc-endpoint.mts'
import { installIsolatedForemanEnv, type IsolatedForemanEnv } from './helpers/isolated-env.mts'

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

test('bin directory only keeps thin foreman entrypoints', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const entries = readdirSync(join(repoRoot, 'bin')).sort()

  assert.deepEqual(entries, ['foreman-deamon.mts', 'foreman.mts'])
})

test('public CLI does not import service bootstrap', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(join(repoRoot, 'bin', 'foreman.mts'), 'utf-8')

  assert.doesNotMatch(source, /FOREMAN_INTERNAL_SERVICE/u)
  assert.doesNotMatch(source, /startForemanDaemon/u)
  assert.doesNotMatch(source, /createHandoffScheduler/u)
  assert.doesNotMatch(source, /\.\.\/lib\/foreman-service\.mts/u)
})

test('public CLI does not import project management internals', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(join(repoRoot, 'bin', 'foreman.mts'), 'utf-8')

  assert.doesNotMatch(source, /ProjectManager/u)
  assert.doesNotMatch(source, /discoverProjects/u)
  assert.doesNotMatch(source, /ProjectNode/u)
  assert.doesNotMatch(source, /\.\.\/lib\/project\//u)
})

test('zero arguments invokes the TUI launcher and returns its exit code', async () => {
  const { runForemanCli } = await import('../lib/client/cli/index.mts')

  let callCount = 0
  const mockTuiLauncher = (): number => {
    callCount++
    return 42
  }

  const code = await runForemanCli([], mockTuiLauncher)
  assert.equal(callCount, 1, 'TUI launcher must be called exactly once')
  assert.equal(code, 42, 'TUI launcher exit code must be returned')
})

test('explicit empty-string argument does not trigger the TUI launcher', async () => {
  const { runForemanCli } = await import('../lib/client/cli/index.mts')

  let callCount = 0
  const mockTuiLauncher = (): number => {
    callCount++
    return 42
  }

  // Suppress stdout so the test stays quiet
  const origStdout = process.stdout.write
  const origStderr = process.stderr.write
  process.stdout.write = () => true
  process.stderr.write = () => true

  try {
    const code = await runForemanCli([''], mockTuiLauncher)
    assert.equal(callCount, 0, 'TUI launcher must NOT be called for empty-string argument')
    assert.equal(code, 1, 'empty-string argument must return exit code 1 (unknown command)')
  } finally {
    process.stdout.write = origStdout
    process.stderr.write = origStderr
  }
})

test('unknown top-level commands use the generic unknown command behavior', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const unknown = runForemanSync(repoRoot, binary, ['definitely-not-a-foreman-command'])

  assert.ifError(unknown.error)
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stdout, /Usage:/u)

  for (const args of [
    ['another-fake-command'],
    ['fake-domain', 'fake-action'],
  ]) {
    const result = runForemanSync(repoRoot, binary, args)
    assert.ifError(result.error)
    assert.equal(result.status, unknown.status)
    assert.equal(result.stdout, unknown.stdout)
    assert.equal(result.stderr, unknown.stderr)
  }
})

test('top-level help exits successfully', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')

  for (const args of [['--help'], ['help']] as const) {
    const result = runForemanSync(repoRoot, binary, [...args])
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage:/u)
    assert.match(result.stdout, /wrenyard daemon <start\|stop\|restart\|status\|freeze\|thaw\|drain\|dispatch-status>/u)
    assert.match(result.stdout, /wrenyard update \[--config path\] \[--no-wait\] \[--json\]/u)
    assert.doesNotMatch(result.stdout, /wrenyard deploy/u)
    assert.doesNotMatch(result.stdout, /wrenyard upgrade/u)
    assert.doesNotMatch(result.stdout, /wrenyard self-update/u)
    assert.doesNotMatch(result.stdout, /wrenyard daemon update/u)
    assert.doesNotMatch(result.stdout, /daemon .*deploy/u)
  }
})

test('top-level version flag prints the local package version', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { version: string }

  for (const args of [['--version'], ['-v']] as const) {
    const result = runForemanSync(repoRoot, binary, [...args])
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), pkg.version)
    assert.equal(result.stderr, '')
  }
})

test('daemon command exposes canonical lifecycle help', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const help = runForemanSync(repoRoot, binary, ['daemon', '--help'])

  assert.ifError(help.error)
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stderr, /Usage: wrenyard daemon <start\|stop\|restart\|status\|freeze\|thaw\|drain\|dispatch-status>/u)
  // Safe planned restart keeps the canonical config/host/port surface and adds
  // --no-wait/--json for the public safe-restart command.
  assert.match(help.stderr, /--config path/u)
  assert.match(help.stderr, /--host addr/u)
  assert.match(help.stderr, /--port n/u)
  assert.match(help.stderr, /--no-wait/u)
  assert.match(help.stderr, /--json/u)
  assert.match(help.stderr, /start/u)
  assert.doesNotMatch(help.stderr, /deploy/u)
  assert.doesNotMatch(help.stderr, /update/u)
  assert.match(help.stderr, /status/u)
})

test('foreman daemon restart --help documents the safe planned-restart flags and exits zero without a daemon', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const help = runForemanSync(repoRoot, binary, ['daemon', 'restart', '--help'])

  assert.ifError(help.error)
  assert.equal(help.status, 0, `stdout:\n${help.stdout}\nstderr:\n${help.stderr}`)
  const output = `${help.stdout}\n${help.stderr}`
  assert.match(output, /Usage: wrenyard daemon restart \[--config path\] \[--host addr\] \[--port n\] \[--no-wait\] \[--json\]/u)
  assert.match(output, /--no-wait/u)
  assert.match(output, /--json/u)
  assert.doesNotMatch(output, /deploy/u)
  assert.doesNotMatch(output, /update/u)
})

test('foreman update --help documents the safe planned-update flags and exits zero without a daemon', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const help = runForemanSync(repoRoot, binary, ['update', '--help'])

  assert.ifError(help.error)
  assert.equal(help.status, 0, `stdout:\n${help.stdout}\nstderr:\n${help.stderr}`)
  const output = `${help.stdout}\n${help.stderr}`
  assert.match(output, /Usage: wrenyard update \[--config path\] \[--no-wait\] \[--json\]/u)
  assert.match(output, /--no-wait/u)
  assert.match(output, /--json/u)
  assert.match(output, /--config path/u)
  assert.doesNotMatch(output, /deploy/u)
  assert.doesNotMatch(output, /upgrade/u)
  assert.doesNotMatch(output, /self-update/u)
  assert.doesNotMatch(output, /daemon update/u)
})

test('daemon supervisor starts Node directly with the tsx loader and hides Windows subprocess windows', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(join(repoRoot, 'lib', 'client', 'cli', 'daemon-supervisor.mts'), 'utf-8')

  assert.match(source, /windowsHide:\s*true/u)
  assert.match(source, /process\.execPath/u)
  assert.match(source, /preflight\.cjs/u)
  assert.match(source, /loader\.mjs/u)
  assert.match(source, /foreman-deamon\.mts/u)
  assert.doesNotMatch(source, /pm2/u)
  assert.doesNotMatch(source, /tsx",\s*"dist",\s*"cli\.mjs"/u)
})

test('daemon bootstrap shim is not part of the local lifecycle', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

  assert.equal(existsSync(join(repoRoot, 'lib', 'daemon', 'daemon-bootstrap.cjs')), false)
})

test('daemon freeze/thaw/drain/dispatch-status CLI handlers parse args correctly', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const configPath = join(isolatedEnv!.root, 'missing-daemon-config.json')
  writeFileSync(configPath, JSON.stringify({
    service: {
      bind: '127.0.0.1:39992',
      ipc: { path: join(isolatedEnv!.root, 'missing-daemon.sock') },
    },
    workspace: {},
    pet: { enabled: false },
  }))

  // Each handler should fail with a config/IPC error rather than a usage error,
  // proving the argument parsing succeeds and the handler is entered.
  const commands = ['freeze', 'thaw', 'drain', 'dispatch-status']
  for (const cmd of commands) {
    const result = runForemanSync(repoRoot, binary, ['daemon', cmd, '--config', configPath])
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    // daemon not running / no config path — error is expected
    assert.ok(result.stderr || result.stdout,
      `daemon ${cmd} should produce output indicating the error`)
  }

  // drain --timeout-ms requires a value
  const drainNoTimeout = runForemanSync(repoRoot, binary, ['daemon', 'drain', '--timeout-ms'])
  assert.ifError(drainNoTimeout.error)
  assert.notEqual(drainNoTimeout.status, 0)

  // drain with timeout should parse
  const drainWithTimeout = runForemanSync(repoRoot, binary, [
    'daemon', 'drain', '--timeout-ms', '5000', '--json', '--config', configPath,
  ])
  assert.ifError(drainWithTimeout.error)
  assert.notEqual(drainWithTimeout.status, 0)
})

test('top-level usage includes daemon dispatch subcommands', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const result = runForemanSync(repoRoot, binary, ['--help'])
  assert.match(result.stdout, /wrenyard daemon <start\|stop\|restart\|status\|freeze\|thaw\|drain\|dispatch-status>/u)
})

test('foreman message send reaches the running daemon over IPC', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-message-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-message-config-'))
  const endpoint = createTestIpcEndpoint('message')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)
  const messageDeliveries: Array<{ body: string; channel: string; sender?: string }> = []
  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    message: {
      enabled: true,
      principals: {
        operator: { id: 'operator', kind: 'human' as const, canSend: true, canReceive: true, grants: [{ name: 'message.send' }] },
        codex: { id: 'codex', kind: 'agent' as const, canSend: true, canReceive: false, grants: [{ name: 'message.send' }] },
        relay: { id: 'relay', kind: 'agent' as const, canSend: true, canReceive: true, grants: [{ name: 'message.send' }], deliveryRoute: 'relay.openclaw' },
      },
      routes: {
        'relay.openclaw': {
          transport: 'openclaw' as const,
          address: {
            session_key: 'agent:main:telegram:direct:1682807251',
            mode: 'agent',
          },
          format: 'markdown',
        },
      },
    },
  }, {
    messageTransportFactory: (_name, cfg) => ({
      name: cfg.transport,
      async deliver(event, channel) {
        messageDeliveries.push({
          body: event.body,
          channel,
          sender: event.origin?.sender,
        })
        return { channel, backend: cfg.transport, ok: true }
      },
    }),
  })

  try {
    const unreachableHttpPort = await allocateFreeTcpPort()
    const configPath = join(configDir, 'config.json')
    writeJsonConfig(configPath, {
      service: { bind: `127.0.0.1:${unreachableHttpPort}`, ipc: { path: running.ipcPath } },
      workspace: { root: workDir },
      message: { enabled: true },
    })

    const messageResult = await runForeman(repoRoot, binary, [
      'message',
      'send',
      '-c',
      configPath,
      '--sender',
      'codex',
      '--to',
      'relay',
      '-m',
      'hello from cli over ipc',
    ])

    assert.ifError(messageResult.error)
    assert.equal(messageResult.status, 0, messageResult.stderr)
    const messagePayload = JSON.parse(messageResult.stdout) as { accepted?: boolean; message_id?: string }
    assert.equal(messagePayload.accepted, true)
    assert.match(messagePayload.message_id ?? '', /^fm_/u)
    assert.deepEqual(messageDeliveries, [{
      body: 'hello from cli over ipc',
      channel: 'relay.openclaw',
      sender: 'codex',
    }])
  } finally {
    await running.stop()
    resetRegistry()
  }
})

test('foreman status --json reaches the running daemon over IPC', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-health-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-health-config-'))
  const endpoint = createTestIpcEndpoint('status')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    message: { enabled: false, principals: {} },
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
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

test('foreman status --json exposes the persisted planned_restart plan', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-plan-status-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-plan-status-config-'))
  const endpoint = createTestIpcEndpoint('plan-status')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  // Seed a durable active plan before the daemon starts. The daemon uses the
  // isolated XDG_STATE_HOME, so it hydrates this plan at startup and the same
  // state root is visible to the CLI child process over IPC.
  const operationId = `op_${Math.random().toString(16).slice(2)}`
  const plannedStore = new PlannedRestartStore(join(isolatedEnv!.stateHome, 'wrenyard'))
  plannedStore.beginPlan({
    operation_id: operationId,
    kind: 'update',
    phase: 'draining',
    recovery_required: true,
    created_at: new Date().toISOString(),
  })

  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    message: { enabled: false, principals: {} },
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
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
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean
      uptimeMs?: number
      mode?: string
      operation_id?: string
      kind?: string
      phase?: string
      active_task_count?: number
      active_workflow_count?: number
      active_execution_count?: number
      recovery_required?: boolean
      daemon?: { running?: boolean }
      ipc?: { ok?: boolean }
      http?: { ok?: boolean }
      mcp?: { ok?: boolean }
      db?: { ok?: boolean }
    }
    // Compatibility fields still present.
    assert.equal(payload.ok, true)
    assert.equal(typeof payload.uptimeMs, 'number')
    assert.equal(payload.daemon?.running, true)
    assert.equal(payload.ipc?.ok, true)
    assert.equal(payload.http?.ok, true)
    assert.equal(payload.mcp?.ok, true)
    assert.equal(payload.db?.ok, true)
    // Fixed operator status surface exposes the persisted plan.
    assert.equal(payload.mode, 'planned_restart')
    assert.equal(payload.operation_id, operationId)
    assert.equal(payload.kind, 'update')
    assert.equal(payload.phase, 'draining')
    assert.equal(payload.active_task_count, 0)
    assert.equal(payload.active_workflow_count, 0)
    assert.equal(payload.active_execution_count, 0)
    assert.equal(payload.recovery_required, true)
  } finally {
    await running.stop()
    resetRegistry()
  }
})

test('foreman status --json exposes the persisted non-terminal update plan', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-update-status-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-update-status-config-'))
  const endpoint = createTestIpcEndpoint('update-plan-status')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  // Seed a durable active update plan in a non-terminal phase (draining). The
  // daemon hydrates this plan at startup; crucially no pull is run against the
  // repository that contains this test suite.
  const operationId = `op_${Math.random().toString(16).slice(2)}`
  const plannedStore = new PlannedRestartStore(join(isolatedEnv!.stateHome, 'wrenyard'))
  plannedStore.beginPlan({
    operation_id: operationId,
    kind: 'update',
    phase: 'draining',
    recovery_required: false,
    created_at: new Date().toISOString(),
  })

  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    message: { enabled: false, principals: {} },
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
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
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean
      uptimeMs?: number
      mode?: string
      operation_id?: string
      kind?: string
      phase?: string
      active_task_count?: number
      active_workflow_count?: number
      active_execution_count?: number
      recovery_required?: boolean
      daemon?: { running?: boolean }
      ipc?: { ok?: boolean }
      http?: { ok?: boolean }
      mcp?: { ok?: boolean }
      db?: { ok?: boolean }
    }
    // Compatibility fields still present.
    assert.equal(payload.ok, true)
    assert.equal(typeof payload.uptimeMs, 'number')
    assert.equal(payload.daemon?.running, true)
    assert.equal(payload.ipc?.ok, true)
    assert.equal(payload.http?.ok, true)
    assert.equal(payload.mcp?.ok, true)
    assert.equal(payload.db?.ok, true)
    // Fixed operator status surface exposes the persisted non-terminal plan.
    assert.equal(payload.mode, 'planned_restart')
    assert.equal(payload.operation_id, operationId)
    assert.equal(payload.kind, 'update')
    assert.equal(payload.phase, 'draining')
    assert.equal(payload.active_task_count, 0)
    assert.equal(payload.active_workflow_count, 0)
    assert.equal(payload.active_execution_count, 0)
    assert.equal(payload.recovery_required, false)
  } finally {
    await running.stop()
    resetRegistry()
  }
})

test('foreman pm ticket commands reach the running daemon over IPC', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-pm-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-pm-config-'))
  const endpoint = createTestIpcEndpoint('pm-ticket')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    message: { enabled: false, principals: {} },
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
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

    const createMain = await runForeman(repoRoot, binary, [
      'pm',
      'ticket',
      'create',
      '--kind',
      'main',
      '-p',
      'app',
      '--title',
      'CLI main',
      '--assignee',
      'session_cli',
      '--config',
      configPath,
    ])
    assert.ifError(createMain.error)
    assert.equal(createMain.status, 0, `stdout:\n${createMain.stdout}\nstderr:\n${createMain.stderr}`)
    const mainPayload = JSON.parse(createMain.stdout) as { ticket?: { id?: string; kind?: string; assignee?: { session_id?: string } } }
    assert.match(mainPayload.ticket?.id ?? '', /^pm_/u)
    assert.equal(mainPayload.ticket?.kind, 'main')
    assert.equal(mainPayload.ticket?.assignee?.session_id, 'session_cli')

    const mainId = mainPayload.ticket?.id ?? ''
    const createSub = await runForeman(repoRoot, binary, [
      'pm',
      'ticket',
      'create',
      '--kind',
      'sub',
      '-p',
      'app',
      '--title',
      'CLI sub',
      '--parent',
      mainId,
      '--config',
      configPath,
    ])
    assert.ifError(createSub.error)
    assert.equal(createSub.status, 0, `stdout:\n${createSub.stdout}\nstderr:\n${createSub.stderr}`)
    const subPayload = JSON.parse(createSub.stdout) as { ticket?: { id?: string; kind?: string; parent_id?: string } }
    assert.match(subPayload.ticket?.id ?? '', /^pm_/u)
    assert.equal(subPayload.ticket?.kind, 'sub')
    assert.equal(subPayload.ticket?.parent_id, mainId)

    const list = await runForeman(repoRoot, binary, [
      'pm',
      'ticket',
      'list',
      '-p',
      'app',
      '--config',
      configPath,
    ])
    assert.ifError(list.error)
    assert.equal(list.status, 0, `stdout:\n${list.stdout}\nstderr:\n${list.stderr}`)
    const listPayload = JSON.parse(list.stdout) as { count?: number; tickets?: Array<{ id?: string }> }
    assert.equal(listPayload.count, 2)
    assert.equal(listPayload.tickets?.some((ticket) => ticket.id === mainId), true)

    const subId = subPayload.ticket?.id ?? ''
    const status = await runForeman(repoRoot, binary, [
      'pm',
      'ticket',
      'status',
      subId,
      'in_progress',
      '--config',
      configPath,
    ])
    assert.ifError(status.error)
    assert.equal(status.status, 0, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`)
    const statusPayload = JSON.parse(status.stdout) as { ticket?: { id?: string; status?: string } }
    assert.equal(statusPayload.ticket?.id, subId)
    assert.equal(statusPayload.ticket?.status, 'in_progress')

    const update = await runForeman(repoRoot, binary, [
      'pm',
      'ticket',
      'update',
      mainId,
      '--description',
      'Updated from CLI',
      '--config',
      configPath,
    ])
    assert.ifError(update.error)
    assert.equal(update.status, 0, `stdout:\n${update.stdout}\nstderr:\n${update.stderr}`)
    const updatePayload = JSON.parse(update.stdout) as { ticket?: { id?: string; description?: string } }
    assert.equal(updatePayload.ticket?.id, mainId)
    assert.equal(updatePayload.ticket?.description, 'Updated from CLI')

    const get = await runForeman(repoRoot, binary, [
      'pm',
      'ticket',
      'get',
      mainId,
      '--config',
      configPath,
    ])
    assert.ifError(get.error)
    assert.equal(get.status, 0, `stdout:\n${get.stdout}\nstderr:\n${get.stderr}`)
    const getPayload = JSON.parse(get.stdout) as { ticket?: { id?: string; description?: string } }
    assert.equal(getPayload.ticket?.id, mainId)
    assert.equal(getPayload.ticket?.description, 'Updated from CLI')

    const deleteSub = await runForeman(repoRoot, binary, [
      'pm',
      'ticket',
      'delete',
      subId,
      '--config',
      configPath,
    ])
    assert.ifError(deleteSub.error)
    assert.equal(deleteSub.status, 0, `stdout:\n${deleteSub.stdout}\nstderr:\n${deleteSub.stderr}`)
    const deleteSubPayload = JSON.parse(deleteSub.stdout) as { deleted?: boolean; id?: string }
    assert.equal(deleteSubPayload.deleted, true)
    assert.equal(deleteSubPayload.id, subId)

    const deleteMain = await runForeman(repoRoot, binary, [
      'pm',
      'ticket',
      'delete',
      mainId,
      '--config',
      configPath,
    ])
    assert.ifError(deleteMain.error)
    assert.equal(deleteMain.status, 0, `stdout:\n${deleteMain.stdout}\nstderr:\n${deleteMain.stderr}`)
    const deleteMainPayload = JSON.parse(deleteMain.stdout) as { deleted?: boolean; id?: string }
    assert.equal(deleteMainPayload.deleted, true)
    assert.equal(deleteMainPayload.id, mainId)
  } finally {
    await running.stop()
    resetRegistry()
  }
})

test('foreman status reports a clear error when IPC is unavailable', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-health-missing-'))
  const endpoint = createTestIpcEndpoint('missing')
  tempDirs.push(configDir, endpoint.dir)
  const configPath = join(configDir, 'config.json')
  writeJsonConfig(configPath, {
    service: { bind: '127.0.0.1:47878', ipc: { path: endpoint.path } },
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
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Wrenyard daemon IPC is not reachable/u)
  assert.match(result.stderr, /Start the Wrenyard daemon with 'wrenyard daemon start'/u)
})

test('top-level usage includes the six canonical TaskGraph command lines', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const result = runForemanSync(repoRoot, binary, ['--help'])
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  for (const line of [
    /wrenyard taskgraph create <json-params> \[--config path\]/u,
    /wrenyard taskgraph patch <json-params> \[--config path\]/u,
    /wrenyard taskgraph status <json-params> \[--config path\]/u,
    /wrenyard taskgraph events <json-params> \[--config path\]/u,
    /wrenyard taskgraph signal <json-params> \[--config path\]/u,
    /wrenyard taskgraph node inspect <json-params> \[--config path\]/u,
    /wrenyard taskgraph inspect <json-params> \[--config path\]/u,
  ]) {
    assert.match(result.stdout, line)
  }
  assert.doesNotMatch(result.stdout, /wrenyard taskgraph deploy/u)
})

test('foreman taskgraph --help for each leaf exits zero without a daemon', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  for (const args of [
    ['taskgraph', 'create', '--help'],
    ['taskgraph', 'patch', '--help'],
    ['taskgraph', 'status', '--help'],
    ['taskgraph', 'events', '--help'],
    ['taskgraph', 'signal', '--help'],
    ['taskgraph', 'node', 'inspect', '--help'],
  ]) {
    const result = runForemanSync(repoRoot, binary, args)
    assert.ifError(result.error)
    assert.equal(result.status, 0, JSON.stringify(args))
  }
})

test('foreman taskgraph commands drive the kernel and reject invalid params', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-taskgraph-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-taskgraph-config-'))
  const endpoint = createTestIpcEndpoint('taskgraph')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
    workspaceRoot: workDir,
    message: { enabled: false, principals: {} },
    messageDelivery: {
      enabled: false,
      default: ['system'],
      channels: {},
    },
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

test('foreman doctor skips project discovery when daemon IPC is unavailable', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-doctor-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-doctor-config-'))
  const endpoint = createTestIpcEndpoint('doctor-missing')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)
  const configPath = join(configDir, 'config.json')
  writeJsonConfig(configPath, {
    service: { bind: '127.0.0.1:47879', ipc: { path: endpoint.path } },
    workspace: { root: workDir },
    message: { enabled: false },
    messageDelivery: { enabled: false },
  })

  const result = await runForeman(repoRoot, binary, ['doctor', '--config', configPath], {
    FOREMAN_TEST_WORK_DIR: workDir,
  })

  assert.ifError(result.error)
  assert.match(result.stdout, /Projects: skipped \(daemon unavailable\)/u)
  assert.doesNotMatch(result.stdout, /Projects: 1 discovered/u)
})

test('foreman doctor --config does not fail on invalid default XDG config', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-doctor-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-doctor-config-'))
  const badDefaultDir = mkdtempSync(join(tmpdir(), 'foreman-cli-doctor-bad-default-'))
  const endpoint = createTestIpcEndpoint('doctor-explicit')
  tempDirs.push(workDir, configDir, badDefaultDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  // Write an invalid default config in XDG_CONFIG_HOME.
  mkdirSync(join(badDefaultDir, 'wrenyard'), { recursive: true })
  writeFileSync(join(badDefaultDir, 'wrenyard', 'config.json'), 'null', 'utf-8')

  // Write a valid explicit config
  const configPath = join(configDir, 'config.json')
  writeJsonConfig(configPath, {
    service: { bind: '127.0.0.1:47880', ipc: { path: endpoint.path } },
    workspace: { root: workDir },
    message: { enabled: false },
    messageDelivery: { enabled: false },
  })

  const result = await runForeman(repoRoot, binary, ['doctor', '--config', configPath], {
    XDG_CONFIG_HOME: badDefaultDir,
    FOREMAN_TEST_WORK_DIR: workDir,
  })

  assert.ifError(result.error)
  assert.match(result.stdout, /Config: ok/u)
  assert.doesNotMatch(result.stdout, /Config: failed/u)
})

test('foreman daemon start/status/restart/stop controls the local daemon lifecycle', {
  timeout: 60000,
  skip: process.env.FOREMAN_RUN_DAEMON_LIFECYCLE_TESTS === '1'
    ? false
    : 'set FOREMAN_RUN_DAEMON_LIFECYCLE_TESTS=1 to run isolated daemon lifecycle integration coverage',
}, async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const suiteRoot = resolve(repoRoot, '..', '..')
  const rootVersion = (JSON.parse(readFileSync(join(suiteRoot, 'package.json'), 'utf-8')) as { version: string }).version
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-daemon-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-daemon-config-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'foreman-cli-daemon-state-'))
  const endpoint = createTestIpcEndpoint('daemon')
  tempDirs.push(workDir, configDir, stateDir, endpoint.dir)
  writeWorkspaceFixture(workDir)
  const port = await allocateFreeTcpPort()
  const configPath = join(configDir, 'config.json')
  const dbPath = join(configDir, 'foreman.sqlite')
  writeJsonConfig(configPath, {
    service: { bind: `127.0.0.1:${port}`, ipc: { path: endpoint.path } },
    workspace: { root: workDir },
    pet: { enabled: false },
    message: { enabled: false },
    messageDelivery: { enabled: false },
  })
  const env = {
    FOREMAN_DB_PATH: dbPath,
    XDG_STATE_HOME: stateDir,
  }
  const oldDbPath = process.env.FOREMAN_DB_PATH
  const oldStateHome = process.env.XDG_STATE_HOME

  try {
    const start = await runForeman(repoRoot, binary, ['daemon', 'start', '--config', configPath], env)
    assert.ifError(start.error)
    assert.equal(start.status, 0, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`)
    assert.match(start.stdout, /Wrenyard daemon started/u)
    assert.doesNotMatch(start.stdout, /pm2/u)

    const status = await runForeman(repoRoot, binary, ['daemon', 'status', '--config', configPath, '--json'], env)
    assert.ifError(status.error)
    assert.equal(status.status, 0, status.stderr)
    const statusPayload = JSON.parse(status.stdout) as {
      ok?: boolean
      daemon?: { running?: boolean; pid?: number; status?: string; process?: string; pidAlive?: boolean; statePath?: string; logPaths?: { stderr?: string }; suiteRoot?: string; suiteVersion?: string }
      ipc?: { ok?: boolean }
      http?: { ok?: boolean }
      mcp?: { ok?: boolean }
      db?: { ok?: boolean }
    }
    assert.equal(statusPayload.ok, true)
    assert.equal(statusPayload.daemon?.running, true)
    assert.equal(typeof statusPayload.daemon?.pid, 'number')
    assert.equal(statusPayload.daemon?.process, 'wrenyard-daemon')
    assert.equal(statusPayload.daemon?.status, 'running')
    assert.equal(statusPayload.daemon?.pidAlive, true)
    assert.equal(statusPayload.daemon?.suiteRoot, suiteRoot)
    assert.equal(statusPayload.daemon?.suiteVersion, rootVersion)
    assert.equal(statusPayload.daemon?.statePath, join(stateDir, 'wrenyard', 'wrenyard-daemon.json'))
    assert.equal(statusPayload.daemon?.logPaths?.stderr, join(stateDir, 'wrenyard', 'logs', 'wrenyard-error.log'))
    assert.equal(statusPayload.ipc?.ok, true)
    assert.equal(statusPayload.http?.ok, true)
    assert.equal(statusPayload.mcp?.ok, true)
    assert.equal(statusPayload.db?.ok, true)

    const startAgain = await runForeman(repoRoot, binary, ['daemon', 'start', '--config', configPath], env)
    assert.ifError(startAgain.error)
    assert.equal(startAgain.status, 0, `stdout:\n${startAgain.stdout}\nstderr:\n${startAgain.stderr}`)
    assert.match(startAgain.stdout, /Wrenyard daemon already running/u)
    assert.doesNotMatch(startAgain.stdout, /pm2/u)

    const restart = await runForeman(repoRoot, binary, ['daemon', 'restart', '--config', configPath], env)
    assert.ifError(restart.error)
    assert.equal(restart.status, 0, `stdout:\n${restart.stdout}\nstderr:\n${restart.stderr}`)
    // Safe planned restart completes through the detached coordinator before
    // reporting success; it never performs an inline stop/start with pm2.
    assert.match(restart.stdout, /Planned restart/u)
    assert.match(restart.stdout, /completed/u)
    assert.doesNotMatch(restart.stdout, /Wrenyard daemon restarted/u)
    assert.doesNotMatch(restart.stdout, /pm2/u)

    const stop = await runForeman(repoRoot, binary, ['daemon', 'stop', '--config', configPath], env)
    assert.ifError(stop.error)
    assert.equal(stop.status, 0, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`)
    assert.match(stop.stdout, /Wrenyard daemon stopped/u)
    assert.doesNotMatch(stop.stdout, /pm2/u)

    const stoppedStatus = await runForeman(repoRoot, binary, ['daemon', 'status', '--config', configPath, '--json'], env)
    assert.ifError(stoppedStatus.error)
    assert.notEqual(stoppedStatus.status, 0)
    const stoppedPayload = JSON.parse(stoppedStatus.stdout) as { ok?: boolean; daemon?: { running?: boolean; status?: string } }
    assert.equal(stoppedPayload.ok, false)
    assert.equal(stoppedPayload.daemon?.running, false)
    assert.equal(stoppedPayload.daemon?.status, 'stopped')
  } finally {
    await runForeman(repoRoot, binary, ['daemon', 'stop', '--config', configPath], env)
    resetRegistry()
    if (oldDbPath === undefined) delete process.env.FOREMAN_DB_PATH
    else process.env.FOREMAN_DB_PATH = oldDbPath
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldStateHome
  }
})

test('foreman task commands reach the running service over IPC', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-task-work-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-task-config-'))
  const fakeForgeDir = mkdtempSync(join(tmpdir(), 'foreman-cli-task-forge-'))
  const endpoint = createTestIpcEndpoint('taskrun')
  tempDirs.push(workDir, configDir, fakeForgeDir, endpoint.dir)
  const appRepo = writeWorkspaceFixture(workDir)
  writeFileSync(
    join(appRepo, 'echo.task.ts'),
    `export default defineTask({
  profile: 'test-profile',
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
  profile: 'test-profile',
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
      service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
      workspaceRoot: workDir,
      message: { enabled: false, principals: {} },
      messageDelivery: {
        enabled: false,
        default: ['system'],
        channels: {},
      },
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

    const runPayload = JSON.parse(runResult.stdout) as { task_run_id?: string; status?: string; has_output?: boolean }
    assert.match(runPayload.task_run_id ?? '', /^task_/u)
    assert.equal(runPayload.status, 'done')
    assert.equal(runPayload.has_output, true)

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

test('foreman project commands reach the running service over IPC', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workspace = mkdtempSync(join(tmpdir(), 'foreman-cli-workspace-'))
  const repo = mkdtempSync(join(tmpdir(), 'foreman-cli-repo-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-project-config-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'foreman-cli-remote-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'foreman-cli-state-'))
  const oldStateHome = process.env.XDG_STATE_HOME
  const remote = join(remoteRoot, 'origin.git')
  const endpoint = createTestIpcEndpoint('project')
  tempDirs.push(workspace, repo, configDir, remoteRoot, stateDir, endpoint.dir)
  initRepo(repo)
  initBareRemote(remote)
  git(repo, ['remote', 'add', 'origin', remote])
  git(repo, ['push', '-u', 'origin', 'main'])
  writeFmproj(workspace, 'app', repo)
  process.env.XDG_STATE_HOME = stateDir
  let running: Awaited<ReturnType<typeof startForemanDaemon>> | undefined

  try {
    running = await startForemanDaemon({
      service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
      workspaceRoot: workspace,
      message: { enabled: false, principals: {} },
      messageDelivery: {
        enabled: false,
        default: ['system'],
        channels: {},
      },
    })
    const unreachableHttpPort = await allocateFreeTcpPort()
    const configPath = join(configDir, 'config.json')
    writeJsonConfig(configPath, {
      service: { bind: `127.0.0.1:${unreachableHttpPort}`, ipc: { path: running.ipcPath } },
      workspace: { root: workspace },
      message: { enabled: false },
      messageDelivery: { enabled: false },
    })

    const list = await runForeman(repoRoot, binary, ['project', 'list', '--config', configPath])
    assert.ifError(list.error)
    assert.equal(list.status, 0, `stdout:\n${list.stdout}\nstderr:\n${list.stderr}`)
    const listPayload = JSON.parse(list.stdout) as Array<{ name?: string; path?: string }>
    assert.deepEqual(listPayload.map((project) => project.name), ['app'])
    assert.equal(listPayload[0]?.path, repo)

    const described = await runForeman(repoRoot, binary, ['project', 'describe', 'app', '--config', configPath])
    assert.ifError(described.error)
    assert.equal(described.status, 0, `stdout:\n${described.stdout}\nstderr:\n${described.stderr}`)
    const describedPayload = JSON.parse(described.stdout) as { name?: string; path?: string }
    assert.equal(describedPayload.name, 'app')
    assert.equal(describedPayload.path, repo)

    const status = await runForeman(repoRoot, binary, ['project', 'status', 'app', '--config', configPath])
    assert.ifError(status.error)
    assert.equal(status.status, 0, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`)
    const statusPayload = JSON.parse(status.stdout) as { name?: string; worktrees?: unknown[] }
    assert.equal(statusPayload.name, 'app')
    assert.deepEqual(statusPayload.worktrees, [])

    const pull = await runForeman(repoRoot, binary, ['project', 'pull', 'app', '--config', configPath])
    assert.ifError(pull.error)
    assert.equal(pull.status, 0, `stdout:\n${pull.stdout}\nstderr:\n${pull.stderr}`)
    const pullPayload = JSON.parse(pull.stdout) as { project?: string; pulled?: boolean }
    assert.equal(pullPayload.project, 'app')
    assert.equal(pullPayload.pulled, true)

    const created = await runForeman(repoRoot, binary, ['project', 'worktree', 'create', 'app', 'deadbeef', '--config', configPath])
    assert.ifError(created.error)
    assert.equal(created.status, 0, `stdout:\n${created.stdout}\nstderr:\n${created.stderr}`)
    const createdPayload = JSON.parse(created.stdout) as { worktree_id?: string; path?: string }
    assert.equal(createdPayload.worktree_id, 'deadbeef')
    assert.equal(createdPayload.path, join(stateDir, 'wrenyard', 'worktrees', 'deadbeef'))
    assert.equal(existsSync(createdPayload.path ?? ''), true)
    assert.equal(existsSync(join(workspace, 'worktrees')), false)

    const removable = await runForeman(repoRoot, binary, ['project', 'worktree', 'create', 'app', 'feedbeef', '--config', configPath])
    assert.ifError(removable.error)
    assert.equal(removable.status, 0, `stdout:\n${removable.stdout}\nstderr:\n${removable.stderr}`)
    const removablePayload = JSON.parse(removable.stdout) as { worktree_id?: string; path?: string }
    assert.equal(removablePayload.worktree_id, 'feedbeef')
    assert.equal(removablePayload.path, join(stateDir, 'wrenyard', 'worktrees', 'feedbeef'))
    assert.equal(existsSync(removablePayload.path ?? ''), true)

    const removed = await runForeman(repoRoot, binary, ['project', 'worktree', 'remove', 'feedbeef', '--config', configPath])
    assert.ifError(removed.error)
    assert.equal(removed.status, 0, `stdout:\n${removed.stdout}\nstderr:\n${removed.stderr}`)
    const removedPayload = JSON.parse(removed.stdout) as { worktree_id?: string; removed?: boolean; path?: string }
    assert.deepEqual({
      worktree_id: removedPayload.worktree_id,
      removed: removedPayload.removed,
      path: removedPayload.path,
    }, {
      worktree_id: 'feedbeef',
      removed: true,
      path: removablePayload.path,
    })
    assert.equal(existsSync(removablePayload.path ?? ''), false)

    const worktrees = await runForeman(repoRoot, binary, ['project', 'worktree', 'list', 'app', '--config', configPath])
    assert.ifError(worktrees.error)
    assert.equal(worktrees.status, 0, `stdout:\n${worktrees.stdout}\nstderr:\n${worktrees.stderr}`)
    const worktreePayload = JSON.parse(worktrees.stdout) as Array<{ id?: string; path?: string }>
    assert.equal(worktreePayload.some((worktree) => worktree.id === 'deadbeef' && worktree.path === createdPayload.path), true)

    commitFile(createdPayload.path ?? '', 'cli.txt', 'merged by cli\n', 'cli work')
    const merged = await runForeman(repoRoot, binary, ['project', 'worktree', 'merge', 'app', 'deadbeef', '--config', configPath])
    assert.ifError(merged.error)
    assert.equal(merged.status, 0, `stdout:\n${merged.stdout}\nstderr:\n${merged.stderr}`)
    const mergedPayload = JSON.parse(merged.stdout) as { merged?: boolean; removed?: boolean; worktree_id?: string }
    assert.deepEqual({
      merged: mergedPayload.merged,
      removed: mergedPayload.removed,
      worktree_id: mergedPayload.worktree_id,
    }, {
      merged: true,
      removed: true,
      worktree_id: 'deadbeef',
    })
    assert.equal(existsSync(createdPayload.path ?? ''), false)
    assert.equal(readFileSync(join(repo, 'cli.txt'), 'utf-8').replace(/\r\n/gu, '\n'), 'merged by cli\n')

    commitFile(repo, 'cli-push.txt', 'pushed by cli\n', 'cli push')
    const pushed = await runForeman(repoRoot, binary, ['project', 'push', 'app', '--config', configPath])
    assert.ifError(pushed.error)
    assert.equal(pushed.status, 0, `stdout:\n${pushed.stdout}\nstderr:\n${pushed.stderr}`)
    const pushedPayload = JSON.parse(pushed.stdout) as { pushed?: boolean; project?: string; branch?: string; remote?: string }
    assert.deepEqual({
      pushed: pushedPayload.pushed,
      project: pushedPayload.project,
      branch: pushedPayload.branch,
      remote: pushedPayload.remote,
    }, {
      pushed: true,
      project: 'app',
      branch: 'main',
      remote: 'origin',
    })
    const localSha = git(repo, ['rev-parse', '--verify', 'main']).trim()
    const remoteSha = git(repo, ['ls-remote', 'origin', 'refs/heads/main']).trim().split(/\s+/u)[0]
    assert.equal(remoteSha, localSha)
  } finally {
    if (running) await running.stop()
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldStateHome
    resetRegistry()
  }
})

test('foreman fwa assign produces human-readable and --json output', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-fwa-sim-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-fwa-config-'))
  const endpoint = createTestIpcEndpoint('fwa-sim-cli')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
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
    pet: { enabled: false, command: '', args: [], cwd: '', startupTimeoutMs: 10000, stopTimeoutMs: 5000, restartOnExit: false, restartDelayMs: 1000 },
    message: { enabled: false, principals: {} },
    messageDelivery: { enabled: false, default: ['system'], channels: {} },
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

    // Human-readable output includes Session, Ticket, Project, Status, Queue depth,
    // and config-aware status/transcript suggestion commands.
    const humanResult = await runForeman(repoRoot, binary, [
      'fwa', 'assign',
      'test-ticket-cli', 'app',
      'test prompt from cli',
      '--config', configPath,
    ])
    assert.ifError(humanResult.error)
    assert.equal(humanResult.status, 0, `stdout:\n${humanResult.stdout}\nstderr:\n${humanResult.stderr}`)
    assert.match(humanResult.stdout, /Session:\s+fwa_/u)
    assert.match(humanResult.stdout, /Ticket:\s+test-ticket-cli/u)
    assert.match(humanResult.stdout, /Project:\s+app/u)
    assert.match(humanResult.stdout, /Status:/u)
    assert.match(humanResult.stdout, /Queue depth:/u)
    assert.match(humanResult.stdout, /Inspect status:\s+wrenyard fwa status fwa_/u)
    assert.match(humanResult.stdout, /Inspect transcript:\s+wrenyard fwa transcript fwa_/u)
    // Config path is quoted in the suggested commands
    assert.match(humanResult.stdout, /--config/u)
    assert.doesNotMatch(humanResult.stdout, /\{.*"service"/u)

    // JSON output remains parseable with the schema envelope
    const jsonResult = await runForeman(repoRoot, binary, [
      'fwa', 'assign',
      'test-ticket-cli-json', 'app',
      'test prompt json',
      '--config', configPath,
      '--json',
    ])
    assert.ifError(jsonResult.error)
    assert.equal(jsonResult.status, 0, `stdout:\n${jsonResult.stdout}\nstderr:\n${jsonResult.stderr}`)
    const payload = JSON.parse(jsonResult.stdout) as { session: { id?: string; ticket_id?: string; project_id?: string; status?: string; queue_depth?: number } }
    assert.ok(payload.session, 'JSON output must have session key')
    const sessionId = payload.session.id
    assert.ok(typeof sessionId === 'string')
    assert.ok(sessionId.startsWith('fwa_'))
    assert.equal(payload.session.ticket_id, 'test-ticket-cli-json')
    assert.equal(payload.session.project_id, 'app')
    assert.equal(typeof payload.session.status, 'string')
    assert.equal(typeof payload.session.queue_depth, 'number')
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
    rmSync(endpoint.dir, { recursive: true, force: true })
  }
})

test('foreman fwa status produces human-readable suggestions with actual session id and config flag', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(repoRoot, 'bin', 'foreman.mts')
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-cli-fwa-status-'))
  const configDir = mkdtempSync(join(tmpdir(), 'foreman-cli-fwa-status-config-'))
  const endpoint = createTestIpcEndpoint('fwa-status-cli')
  tempDirs.push(workDir, configDir, endpoint.dir)
  writeWorkspaceFixture(workDir)

  const running = await startForemanDaemon({
    service: { enabled: true, host: '127.0.0.1', port: 0, ipc: { path: endpoint.path } },
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
    pet: { enabled: false, command: '', args: [], cwd: '', startupTimeoutMs: 10000, stopTimeoutMs: 5000, restartOnExit: false, restartDelayMs: 1000 },
    message: { enabled: false, principals: {} },
    messageDelivery: { enabled: false, default: ['system'], channels: {} },
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

    // Create a session via assign to obtain a session id
    const assignResult = await runForeman(repoRoot, binary, [
      'fwa', 'assign',
      'test-ticket-status', 'app',
      'test prompt for status check',
      '--config', configPath,
    ])
    assert.ifError(assignResult.error)
    assert.equal(assignResult.status, 0, `stdout:\n${assignResult.stdout}\nstderr:\n${assignResult.stderr}`)
    const sessionIdMatch = assignResult.stdout.match(/Session:\s+(fwa_\S+)/u)
    assert.ok(sessionIdMatch, 'assign output must contain session id')
    const sessionId = sessionIdMatch[1]

    // Human-readable status output includes the actual session id,
    // the transcript suggestion with the real id and quoted config path,
    // and handles empty graph_refs/task_refs without printing sections.
    const humanResult = await runForeman(repoRoot, binary, [
      'fwa', 'status',
      sessionId,
      '--config', configPath,
    ])
    assert.ifError(humanResult.error)
    assert.equal(humanResult.status, 0, `stdout:\n${humanResult.stdout}\nstderr:\n${humanResult.stderr}`)
    // Session id appears (not literal <session_id>)
    assert.match(humanResult.stdout, new RegExp(`Session:\\s+${escapeRegex(sessionId)}`, 'u'))
    // Transcript suggestion uses the actual session id and --config flag
    assert.match(humanResult.stdout, new RegExp(`Inspect transcript:\\s+wrenyard fwa transcript ${escapeRegex(sessionId)}\\s+--config`, 'u'))
    // Config path is quoted in suggestion commands
    assert.match(humanResult.stdout, new RegExp(`--config ${escapeRegex(JSON.stringify(configPath))}`, 'u'))
    // Graph refs/task refs display line shows (none) when arrays are empty
    assert.match(humanResult.stdout, /Graph refs:\s+\(none\)/u)
    assert.match(humanResult.stdout, /Task refs:\s+\(none\)/u)
    // No TaskGraph journal or Task output sections since arrays are empty
    assert.doesNotMatch(humanResult.stdout, /TaskGraph journal:/u)
    assert.doesNotMatch(humanResult.stdout, /Task output:/u)

    // JSON output remains parseable
    const jsonResult = await runForeman(repoRoot, binary, [
      'fwa', 'status',
      sessionId,
      '--config', configPath,
      '--json',
    ])
    assert.ifError(jsonResult.error)
    assert.equal(jsonResult.status, 0, `stdout:\n${jsonResult.stdout}\nstderr:\n${jsonResult.stderr}`)
    const payload = JSON.parse(jsonResult.stdout) as { session_id?: string; status?: string }
    assert.equal(payload.session_id, sessionId)
    assert.equal(typeof payload.status, 'string')
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
    rmSync(endpoint.dir, { recursive: true, force: true })
  }
})

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init'])
  git(path, ['config', 'user.name', 'Foreman Test'])
  git(path, ['config', 'user.email', 'foreman@example.test'])
  git(path, ['checkout', '-b', 'main'])
  writeFileSync(join(path, 'README.md'), '# test repo\n', 'utf-8')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-m', 'initial'])
}

function initBareRemote(path: string): void {
  git(dirname(path), ['init', '--bare', path])
  git(path, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
}

function commitFile(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content, 'utf-8')
  git(repo, ['add', file])
  git(repo, ['commit', '-m', message])
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
  writeFileSync(join(workspace, 'FWA.md'), '# Test FWA\n')
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
  writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})\n`, 'utf-8')

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
