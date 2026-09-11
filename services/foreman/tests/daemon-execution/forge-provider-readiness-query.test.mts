import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  evaluateForgeNativeRouteReadiness,
  ForgeProviderReadinessError,
  parseForgeCursorModelAvailability,
  parseForgeProviderReadinessJson,
  queryForgeProviderReadiness,
} from '../../lib/daemon/execution/forge-provider-readiness-query.mts'

const fixture = fileURLToPath(new URL('../fixtures/provider-readiness-forge.mjs', import.meta.url))
const temporaryDirectories: string[] = []

test('conflicting duplicate Cursor rows never grant model access', () => {
  const denied = { id: 'cursor', auth_ok: true, model_availability: { model: { status: 'blocked', reason: 'admin_blocked' } } }
  const allowed = { id: 'cursor', auth_ok: true, model_availability: { model: { status: 'available' } } }
  for (const rows of [[denied, allowed], [allowed, denied], [{ id: 'cursor', auth_ok: true }, allowed]]) {
    assert.equal(parseForgeCursorModelAvailability(JSON.stringify(rows))?.model?.status, 'unknown')
  }
})

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
    cursorModelAvailability: Object.freeze({
      'composer-1': { status: 'available' as const },
    }),
  }
  assert.equal(evaluateForgeNativeRouteReadiness(snapshot, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'available')
  assert.equal(evaluateForgeNativeRouteReadiness(snapshot, {
    providerId: 'cursor', client: 'cursor', mode: 'native', nativeClients: ['cursor'], model: 'composer-1',
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

const cursorNative = {
  providerId: 'cursor' as const,
  client: 'cursor',
  mode: 'native' as const,
  nativeClients: ['cursor'],
}

test('authenticated Cursor requires exact available model status', () => {
  const blocked = {
    sampledAtMs: 1,
    authByProvider: Object.freeze({ chatgpt: true, cursor: true }),
    cursorModelAvailability: Object.freeze({
      'arbitrary-team-model': { status: 'blocked' as const, reason: 'admin_blocked' as const },
    }),
  }
  assert.equal(evaluateForgeNativeRouteReadiness(blocked, {
    ...cursorNative, model: 'arbitrary-team-model',
  }), 'blocked')
  const allowed = {
    sampledAtMs: 2,
    authByProvider: Object.freeze({ chatgpt: true, cursor: true }),
    cursorModelAvailability: Object.freeze({
      'arbitrary-team-model': { status: 'available' as const },
      'non-default-model': { status: 'available' as const },
    }),
  }
  assert.equal(evaluateForgeNativeRouteReadiness(allowed, {
    ...cursorNative, model: 'arbitrary-team-model',
  }), 'available')
  assert.equal(evaluateForgeNativeRouteReadiness(allowed, {
    ...cursorNative, model: 'non-default-model',
  }), 'available')
  assert.equal(evaluateForgeNativeRouteReadiness(allowed, {
    providerId: 'chatgpt', client: 'codex', mode: 'native', nativeClients: ['codex'],
  }), 'available', 'ChatGPT stays auth-only')
  const unblocked = {
    sampledAtMs: 3,
    authByProvider: Object.freeze({ chatgpt: true, cursor: true }),
    cursorModelAvailability: Object.freeze({
      'arbitrary-team-model': { status: 'available' as const },
    }),
  }
  assert.equal(evaluateForgeNativeRouteReadiness(unblocked, {
    ...cursorNative, model: 'arbitrary-team-model',
  }), 'available')
})

test('absent malformed or unknown Cursor model data is not available', () => {
  const authed = {
    sampledAtMs: 1,
    authByProvider: Object.freeze({ cursor: true }),
  }
  assert.equal(evaluateForgeNativeRouteReadiness(authed, {
    ...cursorNative, model: 'composer-1',
  }), 'unknown')
  assert.equal(evaluateForgeNativeRouteReadiness({
    ...authed,
    cursorModelAvailability: Object.freeze({
      'composer-1': { status: 'unknown' as const },
    }),
  }, { ...cursorNative, model: 'composer-1' }), 'unknown')
  assert.equal(evaluateForgeNativeRouteReadiness({
    ...authed,
    cursorModelAvailability: Object.freeze({
      'other-model': { status: 'available' as const },
    }),
  }, { ...cursorNative, model: 'composer-1' }), 'unknown')
  const malformed = JSON.stringify([
    { id: 'cursor', auth_ok: true, model_availability: 'nope', extra: { token: 'do-not-echo' } },
  ])
  parseForgeProviderReadinessJson(malformed)
  const projected = parseForgeCursorModelAvailability(malformed)
  assert.deepEqual({ ...projected }, {})
  assert.equal(evaluateForgeNativeRouteReadiness({
    sampledAtMs: 1,
    authByProvider: Object.freeze({ cursor: true }),
    cursorModelAvailability: projected,
  }, { ...cursorNative, model: 'composer-1' }), 'unknown')
})

test('Cursor model_availability keeps only safe ids status and reason', () => {
  const text = JSON.stringify([{
    id: 'cursor',
    auth_ok: true,
    model_availability: {
      'ok-model': { status: 'available', leak: 'nope' },
      'blocked-model': { status: 'blocked', reason: 'admin_blocked', raw: 'team_settings_blocked' },
      'bad status': { status: 'nope' },
      ' ': { status: 'available' },
    },
  }])
  const projected = parseForgeCursorModelAvailability(text)
  assert.deepEqual({ ...projected }, {
    'ok-model': { status: 'available' },
    'blocked-model': { status: 'blocked', reason: 'admin_blocked' },
  })
  assert.equal(JSON.stringify(projected).includes('leak'), false)
  assert.equal(JSON.stringify(projected).includes('team_settings_blocked'), false)
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


test('Cursor wire Grok availability is projected to canonical model identity', () => {
  const parsed = parseForgeCursorModelAvailability(JSON.stringify([{ id: 'cursor', auth_ok: true,
    model_availability: { 'cursor-grok-4.6-high': { status: 'blocked', reason: 'admin_blocked' } },
  }]))
  assert.deepEqual(parsed?.['grok-4.6'], { status: 'blocked', reason: 'admin_blocked' })
  assert.equal(parsed?.['cursor-grok-4.6-high'], undefined)
  const conflict = parseForgeCursorModelAvailability(JSON.stringify([{ id: 'cursor', auth_ok: true,
    model_availability: { 'cursor-grok-4.6-high': { status: 'available' }, 'grok-4.6': { status: 'blocked' } },
  }]))
  assert.equal(conflict?.['grok-4.6']?.status, 'unknown')
})
