import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ForgeClientReadinessError,
  parseForgeClientReadinessJson,
  queryForgeClientReadiness,
} from '../../lib/daemon/execution/forge-client-readiness-query.mts'

const fixture = fileURLToPath(new URL('../fixtures/client-readiness-forge.mjs', import.meta.url))
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixtureEnv(mode: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WRENYARD_RUNTIME_BIN: process.execPath,
    WRENYARD_FORGE_ARGS_PREFIX: JSON.stringify([fixture]),
    WRENYARD_TEST_CLIENT_READINESS_MODE: mode,
    ...extra,
  }
}

function report(checks: unknown, ok = true): string {
  return JSON.stringify({ ok, checks })
}

test('projects only id -> enabled/installed and ignores extras', () => {
  const projected = parseForgeClientReadinessJson(report([{
    adapter: 'clients',
    status: 'ok',
    details: {
      claude: { enabled: true, installed: true, path: '/secret', token: 'do-not-echo' },
    },
  }]))
  assert.deepEqual({ ...projected }, { claude: { enabled: true, installed: true } })
  assert.equal(JSON.stringify(projected).includes('do-not-echo'), false)
  assert.equal(JSON.stringify(projected).includes('/secret'), false)
})

test('rejects malformed, missing, conflicting, and error reports', () => {
  const cases = [
    report([], true),
    report([{ adapter: 'clients', details: {} }]),
    report([{ adapter: 'clients', status: 'unknown', details: {} }]),
    JSON.stringify({ ok: false, checks: [{ adapter: 'clients', status: 'ok', details: {} }] }),
    report([{ adapter: 'clients', status: 'error', details: {} }]),
    report([{ adapter: 'clients', status: 'ok' }]),
    report([{ adapter: 'clients', status: 'ok', details: { claude: { enabled: 'yes', installed: true } } }]),
    report([{ adapter: 'clients', status: 'ok', details: { claude: { enabled: true } } }]),
    report([{ adapter: 'clients', status: 'ok', details: { claude: true } }]),
    report([{ adapter: 'clients', status: 'ok', details: {} }, { adapter: 'clients', status: 'ok', details: {} }]),
    JSON.stringify([{ adapter: 'clients' }]),
    'not json',
  ]
  for (const text of cases) {
    assert.throws(
      () => parseForgeClientReadinessJson(text),
      (error) => error instanceof ForgeClientReadinessError && error.code === 'invalid_response',
    )
  }
})

test('invokes exactly doctor clients --json', async () => {
  const snapshot = await queryForgeClientReadiness({ env: fixtureEnv('args') })
  assert.deepEqual({ ...snapshot.clientsById }, { claude: { enabled: true, installed: true } })
  const bound = await queryForgeClientReadiness({ env: fixtureEnv('ok'), now: () => 1234 })
  assert.equal(bound.sampledAtMs, 1234)
  assert.deepEqual({ ...bound.clientsById }, {
    claude: { enabled: true, installed: true },
    codex: { enabled: true, installed: false },
    grok: { enabled: false, installed: true },
  })
})

test('nonzero command errors are sanitized and never expose stderr', async () => {
  await assert.rejects(
    queryForgeClientReadiness({ env: fixtureEnv('error') }),
    (error) => error instanceof ForgeClientReadinessError
      && error.code === 'command_failed'
      && !error.message.includes('sensitive-client-readiness-detail'),
  )
})

test('stdout cap terminates the child and returns only a stable error', async () => {
  await assert.rejects(
    queryForgeClientReadiness({ env: fixtureEnv('overflow'), maxStdoutBytes: 1_024 }),
    (error) => error instanceof ForgeClientReadinessError && error.code === 'output_limit',
  )
})

test('timeout kills the detached Forge process tree before rejecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-client-readiness-'))
  temporaryDirectories.push(dir)
  const marker = join(dir, 'grandchild.pid')
  const startedAt = Date.now()
  await assert.rejects(
    queryForgeClientReadiness({
      env: fixtureEnv('hang', { WRENYARD_TEST_CLIENT_READINESS_MARKER: marker }),
      timeoutMs: 250,
    }),
    (error) => error instanceof ForgeClientReadinessError && error.code === 'timeout',
  )
  assert.ok(Date.now() - startedAt < 5_000, 'timeout cleanup must remain bounded')
  const grandchildPid = Number(readFileSync(marker, 'utf8'))
  assert.throws(() => process.kill(grandchildPid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH')
})
