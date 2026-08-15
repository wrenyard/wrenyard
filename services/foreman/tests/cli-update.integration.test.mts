import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createTestIpcEndpoint } from './helpers/ipc-endpoint.mts'

/**
 * Opt-in real-process integration test for task-context automatic Foreman
 * self-update via `foreman update`. It builds a fully isolated Foreman
 * installation out of the current implementation: a seed (tracked tree minus
 * .git and runtime state) initialized as a clean attached `main`, a bare
 * origin it is pushed to, a cloned checkout every tested process runs from, a
 * symlinked (git-ignored) `node_modules` borrowed from the test installation,
 * and a second publisher clone used to publish a harmless commit the detached
 * coordinator fast-forwards after a natural drain.
 *
 * It drives the real `bin/foreman.mts` update command from a task whose fake
 * Forge child records the daemon-injected `FOREMAN_TASK_RUN_ID`, runs
 * `foreman update --config <path> --json` (no `--no-wait`), parses the
 * scheduled JSON, and emits it as valid Forge Agent Stream terminal output. It
 * then verifies the durable scheduled output survives the handoff to a new
 * daemon pid, the exact temporary-repository fast-forward pull, detached
 * coordinator survival, replacement-daemon health, restored admission, and
 * readable output after self-update.
 *
 * A path-intercepting `git` wrapper (placed first on PATH inside the spawned
 * processes only) records every git invocation the update issues so the test
 * can assert the update only ever used temporary-repository fast-forward pull
 * semantics and never merge/rebase/reset/stash/clean/checkout or push.
 */
test('task-context update fast-forwards the temporary checkout, hands off to a new daemon, and keeps task output readable', {
  timeout: 180_000,
  skip: process.env.FOREMAN_RUN_UPDATE_INTEGRATION_TESTS === '1'
    ? false
    : 'set FOREMAN_RUN_UPDATE_INTEGRATION_TESTS=1 to run the isolated daemon update integration coverage',
}, async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const realGit = execSync('command -v git').toString().trim()
  assert.ok(realGit, 'a git executable is required for this integration test')

  // ── Temporary repository scaffold ─────────────────────────────────────
  // Canonicalize every temporary directory through realpathSync so all
  // derived seed/origin/publisher/checkout/state paths share the same
  // /private/var/... representation that process.cwd() records on macOS
  // (where /var symlinks to /private/var). Without this, the git wrapper
  // logs a /private/var/... cwd while checkoutDir was defined as /var/...,
  // which breaks the invocation-contract path checks.
  const seedDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-seed-')))
  const originDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-origin-')))
  const checkoutDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-checkout-')))
  const publisherDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-publisher-')))

  const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-int-work-')))
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-int-config-')))
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-int-state-')))
  const fakeForgeDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-int-forge-')))
  const wrapDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-gitwrap-')))
  const gitLogDir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-update-gitlog-')))
  const endpoint = createTestIpcEndpoint('update-int')

  const tempDirs = [
    seedDir, originDir, checkoutDir, publisherDir,
    workDir, configDir, stateDir, fakeForgeDir, wrapDir, gitLogDir, endpoint.dir,
  ]

  const binary = join(checkoutDir, 'bin', 'foreman.mts')

  const configPath = join(configDir, 'config.json')
  const dbPath = join(configDir, 'foreman.sqlite')
  const scriptPath = join(fakeForgeDir, 'fake-forge.mjs')
  const recordPath = join(fakeForgeDir, 'recorded-task-run-id.txt')
  const gitLogPath = join(gitLogDir, 'git-invocations.log')

  // Path-intercepting `git` wrapper: only active inside spawned children
  // (PATH is prefixed below), never for the test's own git operations which
  // call `realGit` by absolute path.
  const wrapperScript = [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('node:child_process')",
    "const fs = require('node:fs')",
    'const realGit = process.env.FOREMAN_UPDATE_GIT_REAL || \'git\'',
    'const logPath = process.env.FOREMAN_UPDATE_GIT_LOG',
    'const args = process.argv.slice(2)',
    'const cwd = process.cwd()',
    "if (logPath) { try { fs.appendFileSync(logPath, JSON.stringify({ cwd, args }) + '\\n') } catch (e) {} }",
    'const res = spawnSync(realGit, args, { stdio: \'inherit\', cwd })',
    'if (res.error) { console.error(res.error.message); process.exit(1) }',
    'process.exit(res.status === null ? 1 : res.status)',
    '',
  ].join('\n')
  const wrapperGit = join(wrapDir, 'git')
  writeFileSync(wrapperGit, wrapperScript, 'utf-8')
  chmodSync(wrapperGit, 0o755)

  // Build the isolated Foreman checkout: seed is a recursive copy of the
  // current Foreman checkout (the implementation under test, including
  // uncommitted tracked and untracked files) excluding .git, node_modules, and
  // runtime state/log/coverage/temp artifacts. It is initialized as a clean
  // attached main, pushed to a bare origin, then cloned into the checkout
  // every process runs from. No git command mutates the developer checkout;
  // the seed is built purely from a filesystem copy.
  copyCheckoutInto(repoRoot, seedDir)
  assert.ok(
    existsSync(join(seedDir, 'lib', 'client', 'cli', 'commands', 'update.mts')),
    'seed must contain the current update implementation under test',
  )
  assert.ok(
    existsSync(join(seedDir, 'tests', 'cli-update.integration.test.mts')),
    'seed must contain this integration test file',
  )
  git([realGit, 'init', '-b', 'main', seedDir])
  git([realGit, '-C', seedDir, 'add', '-A'])
  git([realGit, '-C', seedDir, 'commit', '-m', 'seed: isolated foreman implementation'])
  git([realGit, 'init', '--bare', originDir])
  git([realGit, '-C', originDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  git([realGit, '-C', seedDir, 'remote', 'add', 'origin', originDir])
  git([realGit, '-C', seedDir, 'push', 'origin', 'main'])
  git([realGit, 'clone', '-b', 'main', originDir, checkoutDir])
  // Borrow node_modules from the test installation without dirtying git
  // (node_modules/ is git-ignored in the seed). Append an exact local ignore
  // entry to this temporary clone's .git/info/exclude so the symlink never
  // appears as untracked and the real update preflight sees a clean checkout.
  symlinkSync(join(repoRoot, 'node_modules'), join(checkoutDir, 'node_modules'))
  appendFileSync(join(checkoutDir, '.git', 'info', 'exclude'), '\n/node_modules\n', 'utf-8')
  git([realGit, 'clone', '-b', 'main', originDir, publisherDir])

  writeWorkspaceFixture(workDir)
  writeUpdateTaskDefinition(workDir)
  writeFakeForgeScript(scriptPath)

  writeJsonConfig(configPath, {
    service: { enabled: true, bind: `127.0.0.1:${await allocateFreeTcpPort()}`, ipc: { path: endpoint.path } },
    workspace: { root: workDir },
    pet: { enabled: false },
    message: { enabled: false },
    notify: { enabled: false },
  })

  // Isolated, durable, real-process environment. FOREMAN_TASK_RUN_ID is
  // deliberately absent from the driver env: only the daemon injects it onto
  // the task's Forge process, which is how the update command detects task
  // context and auto no-waits.
  const baseEnv: NodeJS.ProcessEnv = {
    FOREMAN_DB_PATH: dbPath,
    XDG_STATE_HOME: stateDir,
    PATH: `${wrapDir}${delimiter}${process.env.PATH ?? ''}`,
    FOREMAN_UPDATE_GIT_REAL: realGit,
    FOREMAN_UPDATE_GIT_LOG: gitLogPath,
    WRENYARD_RUNTIME_BIN: process.execPath,
    WRENYARD_FORGE_ARGS_PREFIX: JSON.stringify([scriptPath]),
    FOREMAN_FAKE_FORGE_CONFIG: configPath,
    FOREMAN_FAKE_FORGE_BINARY: binary,
    FOREMAN_FAKE_FORGE_RECORD: recordPath,
  }

  const recordedPids: number[] = []
  let originalPid: number | undefined
  let replacementPid: number | undefined
  let oldHead: string | undefined
  let publisherCommit: string | undefined

  const runCli = (args: string[]) => runForeman(repoRoot, binary, args, stripDriverTaskContext(baseEnv))

  try {
    // The temporary target checkout must be clean (the symlinked node_modules
    // is covered by the local .git/info/exclude entry) before the isolated
    // daemon — and the real update preflight — start against it.
    const cleanStatus = git([realGit, '-C', checkoutDir, 'status', '--porcelain=v1', '--untracked-files=all']).toString().trim()
    assert.equal(cleanStatus, '', 'temporary target checkout must be clean before starting the isolated daemon')

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

    // The checkout HEAD the update must preserve (old_head) is the seed commit.
    oldHead = git([realGit, '-C', checkoutDir, 'rev-parse', '--verify', 'HEAD']).toString().trim()

    // Only after the isolated daemon is running, publish a harmless tracked
    // marker to temporary origin/main so the detached coordinator can later
    // fast-forward the checkout to it.
    writeFileSync(join(publisherDir, 'publisher-marker.txt'), `published at ${new Date().toISOString()}\n`, 'utf-8')
    git([realGit, '-C', publisherDir, 'add', '-A'])
    git([realGit, '-C', publisherDir, 'commit', '-m', 'publisher: harmless tracked marker'])
    git([realGit, '-C', publisherDir, 'push', 'origin', 'main'])
    publisherCommit = git([realGit, '-C', publisherDir, 'rev-parse', '--verify', 'HEAD']).toString().trim()

    // Run a task whose fake Forge records FOREMAN_TASK_RUN_ID, triggers the
    // real `foreman update` in task context, and emits the scheduled payload
    // as valid Forge Agent Stream terminal output.
    const run = await runCli([
      'task', 'run', 'update-trigger', '-p', 'app', '--config', configPath,
      JSON.stringify({ text: 'trigger-planned-update' }),
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

    // The task output is the scheduled update payload (task-context auto no-wait).
    const firstOutput = await runCli(['task', 'output', taskRunId, '--config', configPath])
    assert.ifError(firstOutput.error)
    assert.equal(firstOutput.status, 0, firstOutput.stderr)
    const firstPayload = JSON.parse(firstOutput.stdout) as {
      task_run_id?: string
      status?: string
      output?: { operation_id?: string; scheduled?: boolean; status_endpoint?: string }
    }
    assert.equal(firstPayload.task_run_id, taskRunId)
    assert.equal(firstPayload.status, 'done')
    const scheduled = firstPayload.output
    assert.ok(scheduled, 'expected scheduled payload in task output')
    const scheduledKeys = Object.keys(scheduled).sort()
    assert.deepEqual(scheduledKeys, ['operation_id', 'scheduled', 'status_endpoint'], 'scheduled output must have exactly operation_id, scheduled, status_endpoint')
    assert.equal(typeof scheduled.operation_id, 'string')
    assert.equal(scheduled.scheduled, true)
    assert.equal(scheduled.status_endpoint, 'wrenyard status --json')

    const scheduledOperationId = scheduled.operation_id as string

    // The task and its execution reached a terminal state while the checkout
    // HEAD is still the old head and the original daemon is alive (the durable
    // output is produced before the drain/pull/restart mutates anything).
    const headBeforeMutate = git([realGit, '-C', checkoutDir, 'rev-parse', '--verify', 'HEAD']).toString().trim()
    assert.equal(headBeforeMutate, oldHead, 'checkout HEAD must not change before the task completes')
    assert.ok(originalPid !== undefined && isProcessAlive(originalPid), 'original daemon must still be alive before the task completes')

    // Poll through the expected IPC restart gap until a different (replacement)
    // daemon pid is healthy AND dispatch has reopened to accepting. The final
    // durable plan is retained after completion (it is not removed on
    // completion), so its terminal outcome is read once after the steady state
    // below rather than raced during the window.
    let sawScheduledOperation = false
    let healthyNewPid = false
    const pollDeadline = Date.now() + 120_000
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
        if (s.mode === 'accepting') break
      }
      await delay(250)
    }
    assert.ok(healthyNewPid, 'replacement daemon never became healthy with a different pid')
    assert.ok(replacementPid !== undefined && replacementPid !== originalPid, 'replacement pid must differ from original')
    recordedPids.push(replacementPid as number)

    // The checkout HEAD must match the publisher commit once the update lands.
    const headAfter = git([realGit, '-C', checkoutDir, 'rev-parse', '--verify', 'HEAD']).toString().trim()
    assert.equal(headAfter, publisherCommit, 'checkout HEAD must equal the publisher commit after the update')

    // The durable plan completed: admission restored, full health gate, a
    // natural zero-active drain, and the exact fast-forward pull recorded.
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

    // The completed plan is retained after a successful handoff: read it once
    // from durable state and assert the terminal outcome (old/new HEAD and
    // completed phase) without racing the intermediate window.
    const retainedPlan = readDurablePlan(stateDir)
    assert.ok(retainedPlan, 'expected the retained planned-update plan after completion')
    assert.equal(retainedPlan?.operation_id, scheduledOperationId, 'durable plan operation id must match the scheduled id')
    assert.equal(retainedPlan?.kind, 'update', 'durable plan kind must be update')
    assert.equal(retainedPlan?.phase, 'completed', 'durable plan phase must be completed')
    assert.equal(retainedPlan?.old_head, oldHead, 'durable plan old_head must match the checkout HEAD before update')
    assert.equal(retainedPlan?.new_head, publisherCommit, 'durable plan new_head must match the publisher commit')
    assert.equal(retainedPlan?.recovery_required, false, 'durable plan must not require recovery')

    // The original task output remains readable from the replacement daemon.
    const secondOutput = await runCli(['task', 'output', taskRunId, '--config', configPath])
    assert.ifError(secondOutput.error)
    assert.equal(secondOutput.status, 0, secondOutput.stderr)
    const secondPayload = JSON.parse(secondOutput.stdout) as {
      task_run_id?: string
      status?: string
      output?: { operation_id?: string; scheduled?: boolean; status_endpoint?: string }
    }
    assert.equal(secondPayload.task_run_id, taskRunId)
    assert.equal(secondPayload.status, 'done')
    assert.deepEqual(secondPayload.output, scheduled, 'scheduled payload must be identical after self-update')

    // Git assertion: the update only ever used temporary-repository fast-forward
    // pull semantics. Every git invocation the update issued used the temp
    // checkout cwd, none used merge/rebase/reset/stash/clean/checkout/push, and
    // none operated on the live test-installation checkout.
    assertGitInvocationContract(gitLogPath, checkoutDir, repoRoot)

    assert.ok(
      sawScheduledOperation,
      'did not observe the durable scheduled planned-update operation during the update window',
    )
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

function writeUpdateTaskDefinition(workDir: string): void {
  writeFileSync(
    join(workDir, 'projects', 'workspace', 'update-trigger.task.ts'),
    `export default defineTask({
  profile: 'test-profile',
  permission: 'readonly',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.any(),
  prompt: ({ text }) => \`Trigger a planned update: \${text}\`,
})
`,
    'utf-8',
  )
}

/**
 * Fake Forge executable. It records the daemon-injected FOREMAN_TASK_RUN_ID,
 * runs the real `bin/foreman.mts update` (which detects task context via the
 * inherited env and auto no-waits), parses the scheduled JSON, and emits that
 * payload as a valid Forge Agent Stream terminal event.
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
    "const update = spawnSync(process.execPath, [binary, 'update', '--config', configPath, '--json'], { encoding: 'utf-8', env: process.env })",
    '',
    'let scheduled',
    'try {',
    '  scheduled = JSON.parse(update.stdout)',
    '} catch (e) {',
    "  scheduled = { parse_error: String(e), stdout: update.stdout, stderr: update.stderr }",
    '}',
    '',
    'function ev(seq, type, data) {',
    "  return { protocol: 'forge.agent.stream', version: 1, run_id: 'fr_update_integration', seq: seq, type: type, timestamp: '2026-06-30T00:00:00.000Z', data: data }",
    '}',
    '',
    'const events = [',
    "  ev(1, 'run_started', { profile: 'test-profile', client_family: 'claude', cwd: process.cwd() }),",
    "  ev(2, 'run_finished', { status: 'done', exit_code: 0, output: '<foreman-task-output><summary>daemon update scheduled from task context</summary><result>' + JSON.stringify(scheduled) + '</result></foreman-task-output>', native_session_id: 'native_update_integration', client_family: 'claude' }),",
    ']',
    '',
    "process.stdout.write(events.map((e) => JSON.stringify(e)).join('\\n') + '\\n')",
    '',
  ]
  writeFileSync(scriptPath, lines.join('\n'), 'utf-8')
}

// ── Git helpers ──────────────────────────────────────────────────────────

interface GitResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

function runGitCommand(
  command: string,
  args: string[],
  options: { cwd?: string; input?: Buffer } = {},
): GitResult {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: options.cwd,
    ...(options.input ? { input: options.input } : {}),
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  }
}

function git(args: string[], options: { cwd?: string; input?: Buffer } = {}): Buffer {
  const result = runGitCommand(args[0], args.slice(1), options)
  if (result.status !== 0) {
    throw new Error(`git failed: ${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
  return Buffer.from(result.stdout, 'utf-8')
}

/**
 * Recursively copy the current Foreman checkout into a temporary seed
 * directory, excluding `.git`, `node_modules`, and runtime
 * state/log/coverage/temp artifacts. This is a plain filesystem copy, so it
 * captures the implementation under test exactly as it exists on disk
 * (committed, modified-then-untracked, or untracked) and never invokes git
 * against the developer checkout. The destination subtree is never copied
 * because every temporary directory lives outside the source checkout.
 */
const SEED_EXCLUDED_PARTS = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
  '.cache',
  'tmp',
  '.tmp',
  'logs',
  '.next',
  '.turbo',
  '.parcel-cache',
  '.output',
])

function copyCheckoutInto(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (SEED_EXCLUDED_PARTS.has(entry.name) || entry.name.endsWith('.log')) continue
    cpSync(join(source, entry.name), join(destination, entry.name), {
      recursive: true,
      filter: (src) => {
        const rel = relative(source, src)
        if (!rel || rel === '.') return true
        const parts = rel.split(/[\\/]/u)
        for (const part of parts) {
          if (SEED_EXCLUDED_PARTS.has(part)) return false
          if (part.endsWith('.log')) return false
        }
        return true
      },
    })
  }
}

const FORBIDDEN_GIT_VERBS = new Set(['merge', 'rebase', 'reset', 'stash', 'clean', 'checkout', 'push'])
const ALLOWED_UPDATE_GIT_VERBS = new Set(['rev-parse', 'symbolic-ref', 'status', 'remote', 'pull', 'merge-base'])

function assertGitInvocationContract(gitLogPath: string, checkoutDir: string, repoRoot: string): void {
  let raw: string
  try {
    raw = readFileSync(gitLogPath, 'utf-8')
  } catch (error) {
    throw new Error(`git invocation log not found at ${gitLogPath}: ${String(error)}`)
  }
  const entries: Array<{ cwd: string; args: string[] }> = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cwd: string; args: string[] })

  assert.ok(entries.length > 0, 'expected at least one git invocation to be recorded by the wrapper')

  let checkoutInvocations = 0
  for (const entry of entries) {
    // The update must never mutate the live test-installation checkout.
    assert.notEqual(entry.cwd, repoRoot, 'update must not operate on the live test-installation checkout')

    // Only the update's own git calls (those operating on the temporary
    // checkout) are in scope for the verb contract. Any other git call (for
    // example, the daemon inspecting workspace checkouts) is unrelated.
    if (entry.cwd !== checkoutDir) continue

    checkoutInvocations += 1
    const verb = entry.args[0]
    // The update must operate exclusively on the temporary checkout cwd.
    assert.equal(entry.cwd, checkoutDir, 'update git commands must use the temporary checkout cwd')
    // The update must only ever use these read-mostly / ff-pull verbs.
    assert.ok(
      ALLOWED_UPDATE_GIT_VERBS.has(verb),
      `update used an unexpected git verb ${JSON.stringify(verb)} (args: ${JSON.stringify(entry.args)})`,
    )
    // The update must never use merge/rebase/reset/stash/clean/checkout/push.
    assert.ok(
      !FORBIDDEN_GIT_VERBS.has(verb),
      `update must never use ${JSON.stringify(verb)} (args: ${JSON.stringify(entry.args)})`,
    )
  }
  assert.ok(checkoutInvocations > 0, 'expected git invocations against the temporary checkout')
}

function readDurablePlan(stateDir: string): {
  operation_id: string
  kind: string
  phase: string
  old_head?: string | null
  new_head?: string | null
  recovery_required: boolean
} | null {
  try {
    const raw = readFileSync(join(stateDir, 'foreman', 'planned-restart.json'), 'utf-8')
    const parsed = JSON.parse(raw) as {
      plan?: {
        operation_id?: string
        kind?: string
        phase?: string
        old_head?: string | null
        new_head?: string | null
        recovery_required?: boolean
      }
    }
    if (!parsed.plan) return null
    return {
      operation_id: parsed.plan.operation_id ?? '',
      kind: parsed.plan.kind ?? '',
      phase: parsed.plan.phase ?? '',
      old_head: parsed.plan.old_head,
      new_head: parsed.plan.new_head,
      recovery_required: Boolean(parsed.plan.recovery_required),
    }
  } catch {
    return null
  }
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
    const child = spawnSync(command, commandArgs, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } })
    resolve({ status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '', ...(child.error ? { error: child.error } : {}) })
  })
}
