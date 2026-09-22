import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { executeShell } from '../lib/adapters/shell/execute.mts'
import { killProcessTree, resolveWindowsHideOption } from '../lib/adapters/shell/process.mts'

const KILL_TEST_GRACE_MS = 10_000

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return existsSync(path)
}

describe('shell process adapter', () => {
  it('executes shell commands through the adapter entrypoint', async () => {
    const result = await executeShell('echo hello', { cwd: process.cwd() })

    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /hello/u)
    assert.equal(result.stderr, '')
  })

  it('returns the raw process exit code for failing commands', async () => {
    const result = await executeShell('exit 2', { cwd: process.cwd() })

    assert.equal(result.exitCode, 2)
  })

  it('hides subprocess windows by default on Windows', () => {
    assert.equal(resolveWindowsHideOption({}), process.platform === 'win32' ? true : undefined)
  })

  it('honors explicit windowsHide overrides', () => {
    assert.equal(resolveWindowsHideOption({ windowsHide: false }), false)
    assert.equal(resolveWindowsHideOption({ windowsHide: true }), true)
  })

  it('is the process substrate used by the Forge adapter', () => {
    const forgeExec = readFileSync(join(process.cwd(), 'lib', 'adapters', 'forge', 'exec.mts'), 'utf8')
    const forgeDirect = readFileSync(join(process.cwd(), 'lib', 'adapters', 'forge', 'direct-client.mts'), 'utf8')

    assert.match(forgeExec, /from '\.\.\/shell\/process\.mts'/u)
    assert.doesNotMatch(forgeExec, /shell\/index\.mts/u)
    assert.doesNotMatch(forgeDirect, /shell\/index\.mts/u)
    assert.doesNotMatch(forgeDirect, /killProcessTree/u)
  })

  it('does not keep legacy shell executor compatibility files', () => {
    assert.equal(existsSync(join(process.cwd(), 'lib', 'shell-executor.mts')), false)
    assert.equal(existsSync(join(process.cwd(), 'lib', 'adapters', 'shell', 'index.mts')), false)
  })

  it('killProcessTree resolves only after the target process has exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-shell-kill-'))
    const startedPath = join(dir, 'started')
    const script = join(dir, 'sleep.mjs')
    writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(startedPath)}, 'started')
await new Promise(() => {})
`, 'utf-8')

    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' })
    const pid = child.pid
    assert.ok(pid, 'expected child pid')

    try {
      assert.ok(await waitForFile(startedPath, KILL_TEST_GRACE_MS), 'child should have started')

      const pgid = process.platform === 'win32' ? undefined : pid
      await killProcessTree(pid, pgid)

      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      assert.equal(alive, false, 'target process must be gone after killProcessTree resolves')

      // Already-absent case: invoking again must resolve rather than reject.
      await killProcessTree(pid, pgid)
    } finally {
      try { child.kill('SIGKILL') } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })

})
