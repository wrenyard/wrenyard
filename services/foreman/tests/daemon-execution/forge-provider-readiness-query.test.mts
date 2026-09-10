import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  evaluateForgeNativeRouteReadiness,
  ForgeProviderReadinessError,
  parseForgeProviderReadinessJson,
  queryForgeProviderReadiness,
} from '../../lib/daemon/execution/forge-provider-readiness-query.mts'

const fixture = fileURLToPath(new URL('../fixtures/provider-readiness-forge.mjs', import.meta.url))
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixtureEnv(mode: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WRENYARD_RUNTIME_BIN: process.execPath,
    WRENYARD_FORGE_ARGS_PREFIX: JSON.stringify([fixture]),
    WRENYARD_TEST_PROVIDER_READINESS_MODE: mode,
    ...extra,
  }
}

test('projects required id/auth_ok fields and ignores legitimate provider-list extras', async () => {
  const snapshot = await queryForgeProviderReadiness({ env: fixtureEnv('ok'), now: () => 1234 })
  assert.equal(snapshot.sampledAtMs, 1234)
  assert.deepEqual({ ...snapshot.authByProvider }, { chatgpt: true, cursor: false })
  assert.equal(JSON.stringify(snapshot).includes('api_kind'), false)
  assert.equal(JSON.stringify(snapshot).includes('ignored'), false)
})

test('rejects nonboolean auth and conflicting duplicate ids without echoing raw status', () => {
  for (const text of [
    JSON.stringify([{ id: 'chatgpt', auth_ok: 'yes', secret: 'do-not-echo' }]),
    JSON.stringify([{ id: 'chatgpt', auth_ok: true }, { id: 'chatgpt', auth_ok: false }]),
  ]) {
    assert.throws(
      () => parseForgeProviderReadinessJson(text),
      (error) => error instanceof ForgeProviderReadinessError
        && error.code === 'invalid_response'
        && !error.message.includes('do-not-echo'),
    )
  }
})

test('native readiness is exact-provider and never promotes native auth into gateway support', () => {
  const snapshot = {
    sampledAtMs: 1,
    authByProvider: Object.freeze({ chatgpt: true, cursor: false }),
  }
  assert.equal(evaluateForgeNativeRouteReadiness(snapshot, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'available')
  assert.equal(evaluateForgeNativeRouteReadiness(snapshot, {
    providerId: 'cursor', client: 'cursor', mode: 'native', nativeClients: ['cursor'],
  }), 'missing')
  assert.equal(evaluateForgeNativeRouteReadiness({
    sampledAtMs: 1,
    authByProvider: Object.freeze({}),
  }, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'unknown')
  assert.equal(evaluateForgeNativeRouteReadiness(snapshot, {
    providerId: 'chatgpt', client: 'grok', mode: 'gateway', nativeClients: ['codex'],
  }), 'unsupported')
  assert.equal(evaluateForgeNativeRouteReadiness(snapshot, {
    providerId: 'forge-managed', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'unsupported', 'a shared native client cannot promote an unsupported credential resolver')
  assert.equal(evaluateForgeNativeRouteReadiness(snapshot, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: [],
  }), 'unsupported', 'a credential resolver cannot bypass the provider native-client allowlist')
})

test('nonzero command errors are sanitized and never expose stderr', async () => {
  await assert.rejects(
    queryForgeProviderReadiness({ env: fixtureEnv('error') }),
    (error) => error instanceof ForgeProviderReadinessError
      && error.code === 'command_failed'
      && !error.message.includes('sensitive-provider-status-detail'),
  )
})

test('stdout cap terminates the child and returns only a stable error', async () => {
  await assert.rejects(
    queryForgeProviderReadiness({ env: fixtureEnv('overflow'), maxStdoutBytes: 1_024 }),
    (error) => error instanceof ForgeProviderReadinessError && error.code === 'output_limit',
  )
})

test('timeout kills the detached Forge process tree before rejecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-provider-readiness-'))
  temporaryDirectories.push(dir)
  const marker = join(dir, 'grandchild.pid')
  const startedAt = Date.now()
  await assert.rejects(
    queryForgeProviderReadiness({
      env: fixtureEnv('hang', { WRENYARD_TEST_PROVIDER_READINESS_MARKER: marker }),
      timeoutMs: 250,
    }),
    (error) => error instanceof ForgeProviderReadinessError && error.code === 'timeout',
  )
  assert.ok(Date.now() - startedAt < 5_000, 'timeout cleanup must remain bounded')
  const grandchildPid = Number(readFileSync(marker, 'utf8'))
  assert.throws(() => process.kill(grandchildPid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH')
})
