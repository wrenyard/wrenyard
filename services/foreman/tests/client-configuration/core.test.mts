import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { InstalledClientDiscovery } from '../../lib/client-configuration/discovery.mts'
import { applyFileTransaction, readFileSnapshot } from '../../lib/client-configuration/files.mts'
import {
  ensureGatewayCredentialHelper,
  gatewayCredentialHelperCommand,
  loadOrCreateGatewayCredential,
} from '../../lib/client-configuration/gateway-source.mts'
import { JsonClientOwnershipStore } from '../../lib/client-configuration/ownership-store.mts'
import { ClientConfigurationService } from '../../lib/client-configuration/service.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import { createIpcServer } from '../../lib/transport/ipc-server.mts'
import { createTestIpcEndpoint } from '../helpers/ipc-endpoint.mts'
import type {
  ClientAdapter,
  ClientConfigurationPlan,
  GatewayClientConnection,
} from '../../lib/client-configuration/types.mts'

const execFileAsync = promisify(execFile)

test('file transaction uses private permissions and rolls back every completed replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-client-files-'))
  const first = join(root, 'first.json')
  const second = join(root, 'second.json')
  await writeFile(first, 'before\n', { mode: 0o640 })
  await assert.rejects(() => applyFileTransaction([
    { path: first, content: 'after\n' },
    { path: second, content: 'created\n' },
  ], async () => {
    throw new Error('ownership write failed')
  }))
  assert.equal(await readFile(first, 'utf8'), 'before\n')
  assert.equal((await readFileSnapshot(second)).exists, false)

  const created = join(root, 'private.json')
  await applyFileTransaction([{ path: created, content: '{}\n' }], async () => undefined)
  if (process.platform !== 'win32') assert.equal((await stat(created)).mode & 0o777, 0o600)
})

test('ownership store keeps only client-owned baseline and last-applied data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-client-store-'))
  const path = join(root, 'ownership.json')
  const store = new JsonClientOwnershipStore(path)
  await store.put({
    clientId: 'codex-shared',
    baseline: { model: 'native' },
    lastApplied: { model: 'provider/model' },
    models: ['provider/model'],
    defaultModel: 'provider/model',
    updatedAt: '2026-09-04T00:00:00.000Z',
  })
  assert.equal((await store.get('codex-shared'))?.defaultModel, 'provider/model')
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  await store.remove('codex-shared')
  assert.equal((await readFileSnapshot(path)).exists, false)
})

test('gateway credential is stable and helper stores only the IPC lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-client-credential-'))
  const credentialPath = join(root, 'gateway', 'credential')
  const first = await loadOrCreateGatewayCredential(credentialPath)
  const second = await loadOrCreateGatewayCredential(credentialPath)
  assert.equal(second, first)
  assert.ok(first.length >= 32)
  if (process.platform !== 'win32') assert.equal((await stat(credentialPath)).mode & 0o777, 0o600)

  const helperPath = join(root, 'client-configuration', process.platform === 'win32' ? 'gateway-credential-helper.mjs' : 'gateway-credential-helper')
  await ensureGatewayCredentialHelper(helperPath, join(root, 'foreman.sock'))
  const helper = await readFile(helperPath, 'utf8')
  assert.match(helper, /gateway\.connection/)
  assert.doesNotMatch(helper, new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  if (process.platform !== 'win32') assert.equal((await stat(helperPath)).mode & 0o777, 0o700)
})

test('gateway credential helper command uses Node argv on Windows and the helper path on POSIX', () => {
  const helperPath = '/opt/wrenyard/bin/gateway-credential-helper'
  const nodePath = '/usr/bin/node'
  const windowsArgv = gatewayCredentialHelperCommand(helperPath, nodePath, 'win32')
  assert.deepEqual(windowsArgv, [nodePath, helperPath])
  assert.equal(windowsArgv.includes('cmd.exe'), false)
  assert.equal(windowsArgv.some((part) => part.endsWith('.cmd')), false)
  assert.deepEqual(gatewayCredentialHelperCommand(helperPath, nodePath, 'linux'), [helperPath])
  assert.deepEqual(gatewayCredentialHelperCommand(helperPath, nodePath, 'darwin'), [helperPath])
})

test('gateway credential helper resolves the live token over local IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-client-helper-'))
  const endpoint = createTestIpcEndpoint('client-helper')
  const router = new RpcRouter()
  router.register('gateway.connection', async () => ({
    openaiChatBaseUrl: 'http://127.0.0.1/gateway/openai-chat/v1',
    openaiResponsesBaseUrl: 'http://127.0.0.1/gateway/openai-responses/v1',
    anthropicBaseUrl: 'http://127.0.0.1/gateway/anthropic/v1',
    token: 'live-gateway-token',
    models: [],
  }))
  const server = await createIpcServer({
    path: endpoint.path,
    onMessage: (message) => router.handleMessage(message),
  })
  const helperPath = join(root, process.platform === 'win32' ? 'gateway-credential-helper.mjs' : 'gateway-credential-helper')
  try {
    await ensureGatewayCredentialHelper(helperPath, endpoint.path)
    const helper = await readFile(helperPath, 'utf8')
    assert.doesNotMatch(helper, /live-gateway-token/)
    const argv = gatewayCredentialHelperCommand(helperPath)
    const result = await execFileAsync(argv[0], argv.slice(1), { timeout: 2_000 })
    assert.equal(result.stdout, 'live-gateway-token\n')
    assert.equal(result.stderr, '')
  } finally {
    await server.close()
  }
})

test('discovery reports Codex App and CLI independently and accepts capability overrides', async () => {
  const executable = (name: string) => join('/bin', process.platform === 'win32' ? `${name}.exe` : name)
  const existing = new Set([join('/Applications', 'ChatGPT.app'), executable('codex'), executable('claude')])
  const discovery = new InstalledClientDiscovery({
    env: { HOME: '/home/test', PATH: '/bin' },
    platform: 'darwin',
    appRoots: ['/Applications'],
    pathExists: async (path) => existing.has(path),
    runCommand: async (executable) => ({
      stdout: /codex(?:\.exe)?$/.test(executable) ? 'codex-cli 0.153.0' : '2.1.179',
      stderr: '',
      exitCode: 0,
    }),
    capabilityProbes: {
      'codex-app': async () => ({ compatibility: 'needs-verification', detail: 'App catalog probe pending' }),
      'codex-cli': async () => ({ compatibility: 'supported' }),
      'claude-code': async () => ({ compatibility: 'needs-upgrade', detail: 'model discovery unavailable' }),
    },
  })
  const surfaces = await discovery.list()
  assert.equal(surfaces.find((entry) => entry.id === 'codex-app')?.compatibility, 'needs-verification')
  assert.equal(surfaces.find((entry) => entry.id === 'codex-cli')?.compatibility, 'supported')
  assert.equal(surfaces.find((entry) => entry.id === 'claude-code')?.compatibility, 'needs-upgrade')
  assert.equal(surfaces.find((entry) => entry.id === 'grok-build')?.installed, false)
})

test('service keeps read-only plan separate from apply and restore', async () => {
  const calls: string[] = []
  const plan: ClientConfigurationPlan = {
    clientId: 'grok-build',
    operation: 'apply',
    files: [],
    models: ['provider/model'],
    defaultModel: 'provider/model',
    connectionMode: 'additive',
    effects: [],
    requiresRestart: [],
  }
  const adapter: ClientAdapter = {
    id: 'grok-build',
    status: async () => ({ clientId: 'grok-build', state: 'not-configured', configuredModels: [] }),
    plan: async () => { calls.push('plan'); return plan },
    apply: async () => { calls.push('apply'); return { clientId: 'grok-build', state: 'connected', configuredModels: ['provider/model'] } },
    planRestore: async () => ({ ...plan, operation: 'restore' }),
    restore: async () => { calls.push('restore'); return { clientId: 'grok-build', state: 'not-configured', configuredModels: [] } },
  }
  const connection: GatewayClientConnection = {
    openaiChatBaseUrl: 'http://127.0.0.1/gateway/openai-chat/v1',
    openaiResponsesBaseUrl: 'http://127.0.0.1/gateway/openai-responses/v1',
    anthropicBaseUrl: 'http://127.0.0.1/gateway/anthropic/v1',
    credential: 'secret',
    credentialHelperPath: '/opt/wrenyard/bin/gateway-credential',
    credentialHelperCommand: ['wrenyard', 'gateway', 'credential'],
    models: [],
  }
  const service = new ClientConfigurationService(
    { list: async () => [] },
    [adapter],
    { read: async () => connection },
  )
  assert.deepEqual(calls, [])
  assert.deepEqual((await service.snapshot()).models, [])
  const preview = await service.plan('grok-build', { models: ['provider/model'], defaultModel: 'provider/model' })
  assert.deepEqual(calls, ['plan'])
  await service.apply(preview)
  const restore = await service.planRestore('grok-build')
  await service.restore(restore)
  assert.deepEqual(calls, ['plan', 'apply', 'restore'])
})
