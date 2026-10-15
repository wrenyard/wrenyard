import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BotAdapterError,
  createInboxClient,
  runAdapter,
  type BotAdapterErrorCode,
} from '../lib/daemon/services/bot/adapters.mts'
import type { BotCommandAdapter } from '../lib/daemon/services/bot/config.mts'

// Adapter runtime behavior: the command path only. Every fake adapter is an
// inline node script, so these tests need no fixture files and no shell.

/** A command adapter that runs one inline node script. */
function inlineAdapter(
  script: string,
  patch: { env?: Record<string, string>; timeoutMs?: number } = {},
): BotCommandAdapter {
  return {
    kind: 'command',
    argv: [process.execPath, '-e', script],
    timeoutMs: patch.timeoutMs ?? 5_000,
    ...(patch.env === undefined ? {} : { env: patch.env }),
  }
}

function assertBotAdapterError(error: unknown, code: BotAdapterErrorCode): asserts error is BotAdapterError {
  if (!(error instanceof BotAdapterError)) assert.fail(`expected a BotAdapterError, received ${String(error)}`)
  assert.equal(error.code, code)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function processIsGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !processIsAlive(pid)
}

test('a valid list response is parsed into inbox items', async () => {
  const inbox = createInboxClient(inlineAdapter(
    'process.stdout.write(JSON.stringify({ items: [{ id: "a1", title: "Fix the thing", body: "details",'
    + ' project: "example", updatedAt: "2026-10-16T00:00:00.000Z" }] }))',
  ))
  assert.deepEqual(await inbox.list(), {
    items: [{
      id: 'a1',
      title: 'Fix the thing',
      body: 'details',
      project: 'example',
      updatedAt: '2026-10-16T00:00:00.000Z',
    }],
  })
})

test('a non-zero exit becomes adapter.exit', async () => {
  await assert.rejects(
    runAdapter(inlineAdapter('process.stderr.write("boom"); process.exit(3)'), { op: 'list' }),
    (error: unknown) => {
      assertBotAdapterError(error, 'adapter.exit')
      assert.match(error.message, /exited with code 3/)
      return true
    },
  )
})

test('a timeout becomes adapter.timeout and kills the child process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-bot-adapter-'))
  const pidFile = join(dir, 'child.pid')
  const timeoutMs = 500
  const adapter = inlineAdapter(
    'require("node:fs").writeFileSync(process.env.BOT_TEST_PID_FILE, String(process.pid));'
    + ' setInterval(() => {}, 1000)',
    { env: { BOT_TEST_PID_FILE: pidFile }, timeoutMs },
  )
  try {
    const startedAt = Date.now()
    await assert.rejects(runAdapter(adapter, { op: 'list' }), (error: unknown) => {
      assertBotAdapterError(error, 'adapter.timeout')
      return true
    })
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < timeoutMs * 2, `the timeout must surface within 2x the timeout (took ${elapsed} ms)`)

    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 1, `the fake adapter must record its pid (read ${pid})`)
    assert.equal(await processIsGone(pid), true, `the adapter process ${pid} must be killed`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stdout that is not one JSON object becomes adapter.invalid_json', async () => {
  await assert.rejects(
    runAdapter(inlineAdapter('process.stdout.write("not json")'), { op: 'list' }),
    (error: unknown) => {
      assertBotAdapterError(error, 'adapter.invalid_json')
      return true
    },
  )
})

test('an env reference reaches the adapter and never appears in an error', async () => {
  const secret = 'bot-adapters-test-secret-7c1f'
  const previous = process.env.BOT_ADAPTER_TEST_SECRET
  process.env.BOT_ADAPTER_TEST_SECRET = secret
  try {
    const env = { BOT_TEST_SECRET: '${env:BOT_ADAPTER_TEST_SECRET}' }

    // The fake adapter only answers a valid list when it received the value.
    const inbox = createInboxClient(inlineAdapter(
      'process.stdout.write(JSON.stringify(process.env.BOT_TEST_SECRET === '
      + `${JSON.stringify(secret)} ? { items: [] } : { items: "wrong" }))`,
      { env },
    ))
    assert.deepEqual(await inbox.list(), { items: [] })

    // The failing adapter echoes the value on stderr; the error must not carry it.
    await assert.rejects(
      runAdapter(
        inlineAdapter('process.stderr.write("token=" + process.env.BOT_TEST_SECRET); process.exit(4)', { env }),
        { op: 'list' },
      ),
      (error: unknown) => {
        assertBotAdapterError(error, 'adapter.exit')
        assert.ok(!error.message.includes(secret), 'the error message must not contain an env value')
        return true
      },
    )
  } finally {
    if (previous === undefined) delete process.env.BOT_ADAPTER_TEST_SECRET
    else process.env.BOT_ADAPTER_TEST_SECRET = previous
  }
})
