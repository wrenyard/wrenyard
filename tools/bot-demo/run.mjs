#!/usr/bin/env node
// Bot mode end-to-end dry-run demo driver.
//
// Runs one bot end to end against a disposable, fully isolated daemon: a temp
// root with its own state home, config home, IPC socket, workspace, git
// project and a local bare origin for that project. Inbox and notifier are the
// fake command adapters next to this script, so the run needs no private
// tools, accounts or chat targets.
//
// The bot runs in `dryRun` mode, which means the run must end with the item
// completed but with the source item still open, no notification written and
// neither the project's main branch nor its bare origin moved. Those facts are
// asserted at the end; the process exits 0 only when every one of them holds.
//
// See docs/guides/bot-mode.md for the configuration reference.
//
// Usage:
//   node tools/bot-demo/run.mjs --session-model <provider>/<model>/<effort> [options]
//
// Options:
//   --judgment-target <provider>/<model>:<client>     explicit run target for judgment task runs
//   --acceptance-target <provider>/<model>:<client>   explicit run target for acceptance task runs
//   --provider-config-from <dir>                      copy provider credential/runtime subtrees into the temp config home
//   --timeout-minutes <n>                             overall wall-clock budget (default 30)
//   --keep                                            keep the temp root for inspection

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'bin', 'wrenyard.mjs')
const INBOX_SCRIPT = join(SCRIPT_DIR, 'fake-inbox.mjs')
const NOTIFIER_SCRIPT = join(SCRIPT_DIR, 'fake-notifier.mjs')

/** Mirrors WRENYARD_PROTOCOL_VERSION (packages/control/src/transport/types.ts). */
const PROTOCOL_VERSION = 2
const REQUEST_TIMEOUT_MS = 120_000
const STARTUP_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 15_000
/** How often the driver prints progress: bot.items/bot.health reads only. */
const POLL_INTERVAL_MS = 2_000
/**
 * How often the driver asks the bot for a pass. `bot.tick` forces an inbox
 * poll, so ticking every couple of seconds floods the bot log and makes the
 * tick counters meaningless; the bot itself also throttles forced polls.
 */
const TICK_INTERVAL_MS = 15_000

const SOURCE_ID = 'demo-1'
const PROJECT_ID = 'demo'
/** Item states with no further automatic work. */
const TERMINAL_STATES = new Set(['completed', 'dismissed', 'withdrawn', 'failed'])

function log(message) {
  process.stderr.write(`[bot-demo] ${message}\n`)
}

function die(message) {
  process.stderr.write(`[bot-demo] error: ${message}\n`)
  process.exit(2)
}

function printUsage() {
  process.stderr.write(
    'Usage: node tools/bot-demo/run.mjs --session-model <provider>/<model>/<effort> [options]\n'
    + '  --judgment-target <provider>/<model>:<client>\n'
    + '  --acceptance-target <provider>/<model>:<client>\n'
    + '  --provider-config-from <dir>\n'
    + '  --timeout-minutes <n>   (default 30)\n'
    + '  --keep\n',
  )
}

function parseArgs(argv) {
  const options = {
    sessionModel: undefined,
    judgmentTarget: undefined,
    acceptanceTarget: undefined,
    providerConfigFrom: undefined,
    timeoutMinutes: 30,
    keep: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) die(`${flag} needs a value`)
      return argv[index]
    }
    switch (flag) {
      case '--session-model': options.sessionModel = next(); break
      case '--judgment-target': options.judgmentTarget = next(); break
      case '--acceptance-target': options.acceptanceTarget = next(); break
      case '--provider-config-from': options.providerConfigFrom = next(); break
      case '--timeout-minutes': options.timeoutMinutes = Number(next()); break
      case '--keep': options.keep = true; break
      case '--help':
      case '-h': printUsage(); process.exit(0)
      default: die(`unknown option: ${flag}`)
    }
  }
  if (!options.sessionModel) {
    printUsage()
    die('--session-model is required')
  }
  const parts = options.sessionModel.split('/')
  if (parts.length !== 3 || parts.some((part) => part.trim() === '')) {
    die('--session-model must look like <provider>/<model>/<effort>')
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    die('--timeout-minutes must be a positive number')
  }
  options.routing = { provider: parts[0], model: parts[1], reasoningEffort: parts[2] }
  return options
}

/** A dependency-free NDJSON JSON-RPC 2.0 client over the daemon's IPC socket. */
class IpcClient {
  constructor(socketPath) {
    this.socketPath = socketPath
    this.pending = new Map()
    this.buffer = ''
    this.nextId = 1
    this.socket = undefined
    this.handshake = undefined
  }

  connect() {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = createConnection(this.socketPath)
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        this.buffer += chunk
        let newline = this.buffer.indexOf('\n')
        while (newline !== -1) {
          const frame = this.buffer.slice(0, newline)
          this.buffer = this.buffer.slice(newline + 1)
          this.handleFrame(frame)
          newline = this.buffer.indexOf('\n')
        }
      })
      socket.on('error', (error) => {
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        rejectConnect(error)
      })
      socket.once('connect', () => {
        this.socket = socket
        resolveConnect()
      })
    })
  }

  handleFrame(frame) {
    if (frame.trim() === '') return
    let message
    try {
      message = JSON.parse(frame)
    } catch {
      return
    }
    const pending = this.pending.get(Number(message.id))
    if (!pending) return
    this.pending.delete(Number(message.id))
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new Error(`RPC error ${message.error.code ?? 0}: ${message.error.message ?? 'unknown'}`))
      return
    }
    pending.resolve(message.result)
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return this.ensureHandshake().then(() => this.send(method, params, timeoutMs))
  }

  /** The first request completes the version-checked health.ping handshake. */
  ensureHandshake() {
    this.handshake ??= this.send('health.ping', { protocolVersion: PROTOCOL_VERSION }, REQUEST_TIMEOUT_MS)
      .then((result) => {
        const version = result && typeof result === 'object' ? result.protocolVersion : undefined
        if (version !== PROTOCOL_VERSION) {
          throw new Error(`daemon protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${String(version)}`)
        }
      })
    return this.handshake
  }

  send(method, params, timeoutMs) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolveSend, rejectSend) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id)
        rejectSend(new Error(`request timed out (method: ${method})`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer })
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  close() {
    this.socket?.destroy()
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/** Run one git command in a temp repo; throws with the captured stderr. */
function git(repoDir, args) {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
  return (result.stdout ?? '').trim()
}

function commitIdentity(repoDir, args) {
  return git(repoDir, ['-c', 'user.name=Bot Demo', '-c', 'user.email=bot-demo@example.invalid', ...args])
}

/** The IPC endpoint: a socket path on Unix, a pipe name on Windows. */
function ipcPathFor(root) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wrenyard-bot-demo-${process.pid}`
    : join(root, 'daemon.sock')
}

function createTempLayout() {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-bot-demo-'))
  const layout = {
    root,
    stateDir: join(root, 'state'),
    configDir: join(root, 'config'),
    workspaceDir: join(root, 'workspace'),
    repoDir: join(root, 'demo-project'),
    bareRepoDir: join(root, 'demo-origin.git'),
    inboxFile: join(root, 'inbox.json'),
    notifyLogFile: join(root, 'notify.log'),
  }
  layout.ipcPath = ipcPathFor(root)
  layout.configFile = join(layout.configDir, 'config.json')
  layout.botConfigFile = join(layout.configDir, 'bots', 'demo.json')
  for (const dir of [layout.stateDir, layout.configDir, join(layout.configDir, 'bots'), layout.workspaceDir]) {
    mkdirSync(dir, { recursive: true })
  }
  return layout
}

/**
 * Copy only the provider credential/runtime subtrees the daemon needs for model
 * access. File contents are never read or printed here.
 */
function copyProviderSubtrees(sourceDir, configDir) {
  for (const relative of ['providers/auth.json', 'runtime']) {
    const from = join(sourceDir, relative)
    if (!existsSync(from)) continue
    const to = join(configDir, relative)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
    log(`copied provider subtree: ${relative}`)
  }
}

/**
 * Create the demo project repository and a local bare origin for it.
 *
 * The origin matters: `project.register` records `git.remote` from the
 * checkout's `origin` remote (or from the explicit `git_remote` field), and
 * the daemon only creates managed worktrees for a project that declares
 * `git.remote`. A project without it is treated as non-git, which is exactly
 * what the bot's dispatch needs. The bare repo lives inside the temp root, so
 * the demo stays self-contained and never reaches a real remote.
 */
function createDemoRepo(repoDir, originDir) {
  mkdirSync(repoDir, { recursive: true })
  git(repoDir, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(repoDir, 'greeting.txt'), 'hello\n', 'utf8')
  commitIdentity(repoDir, ['add', 'greeting.txt'])
  commitIdentity(repoDir, ['commit', '--quiet', '-m', 'seed greeting'])

  mkdirSync(originDir, { recursive: true })
  git(originDir, ['init', '--quiet', '--bare', '--initial-branch=main'])
  git(repoDir, ['remote', 'add', 'origin', originDir])
  git(repoDir, ['push', '--quiet', '--set-upstream', 'origin', 'main'])
}

function writeDemoConfig(layout) {
  writeFileSync(layout.configFile, `${JSON.stringify({
    service: { enabled: true, ipc: { path: layout.ipcPath } },
    workspace: { root: layout.workspaceDir },
  }, null, 2)}\n`, 'utf8')
}

function seedInbox(layout) {
  writeFileSync(layout.inboxFile, `${JSON.stringify({
    items: [{
      id: SOURCE_ID,
      title: 'Change greeting to hello, bot',
      body: 'greeting.txt should read "hello, bot". Acceptance: in the worktree, running `cat greeting.txt` prints exactly hello, bot.',
      project: PROJECT_ID,
      open: true,
    }],
  }, null, 2)}\n`, 'utf8')
}

function writeBotConfig(layout, options) {
  // Adapter env values are references, never literals: the demo paths only
  // exist at run time and stay out of the config file.
  const adapterEnv = (name, value) => ({ env: { [name]: value } })
  const routingEntry = (target) => ({
    provider: options.routing.provider,
    model: options.routing.model,
    reasoningEffort: options.routing.reasoningEffort,
    ...(target ? { target } : {}),
  })
  const config = {
    name: 'demo',
    mode: 'dryRun',
    inbox: {
      kind: 'command',
      argv: [process.execPath, INBOX_SCRIPT],
      ...adapterEnv('BOT_DEMO_INBOX', '${env:BOT_DEMO_INBOX}'),
      timeoutMs: 20_000,
    },
    notifier: {
      kind: 'command',
      argv: [process.execPath, NOTIFIER_SCRIPT],
      ...adapterEnv('BOT_DEMO_NOTIFY_LOG', '${env:BOT_DEMO_NOTIFY_LOG}'),
      timeoutMs: 20_000,
    },
    projects: [{ id: PROJECT_ID, match: [PROJECT_ID], merge: true, push: true, release: { enabled: false } }],
    routing: {
      default: routingEntry(undefined),
      judgment: routingEntry(options.judgmentTarget),
      acceptance: routingEntry(options.acceptanceTarget),
    },
    cadence: { tickSeconds: 10, pollMinutes: 1 },
  }
  mkdirSync(dirname(layout.botConfigFile), { recursive: true })
  writeFileSync(layout.botConfigFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function startDaemon(layout, childEnv) {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, 'daemon', 'run', '--config', layout.configFile, '--work-dir', layout.workspaceDir],
    { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  // The driver owns stdout for its report; daemon output is echoed to stderr.
  child.stdout.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`))
  return child
}

async function connectWhenReady(ipcPath, deadline) {
  let lastError
  while (Date.now() < deadline) {
    const client = new IpcClient(ipcPath)
    try {
      await client.connect()
      await client.request('health.ping', { protocolVersion: PROTOCOL_VERSION })
      return client
    } catch (error) {
      lastError = error
      client.close()
      await sleep(500)
    }
  }
  throw new Error(`daemon IPC was not ready in time: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/** IPC stop, then SIGTERM, then SIGKILL after the bounded grace period. */
async function stopDaemon(ipc, child) {
  try {
    await ipc.request('daemon.shutdown', {}, REQUEST_TIMEOUT_MS)
  } catch (error) {
    log(`graceful IPC stop did not confirm: ${error instanceof Error ? error.message : String(error)}`)
  }
  ipc.close()
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return
  log('daemon did not exit after the IPC stop; sending SIGTERM')
  child.kill('SIGTERM')
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return
  log('daemon did not exit after SIGTERM; sending SIGKILL')
  child.kill('SIGKILL')
  await waitForExit(child, STOP_TIMEOUT_MS)
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

function formatHealth(health) {
  const host = health.host ?? {}
  const components = Array.isArray(health.components) && health.components.length > 0
    ? health.components.map((component) => `${component.id}=${component.state}`).join(' ')
    : 'none'
  return [
    `ticks=${health.ticks}`,
    `tickLagMs.last=${health.tickLagMs?.last ?? 'n/a'}`,
    `tickLagMs.max=${health.tickLagMs?.max ?? 'n/a'}`,
    `items=${JSON.stringify(health.itemsByState ?? {})}`,
    `stepsFailed24h=${health.stepsFailed24h}`,
    `adapterErrors24h=${health.adapterErrors24h}`,
    `escalations24h=${health.escalations24h}`,
    `host=${host.mode ?? 'n/a'}/${host.daemonVersion ?? 'n/a'}`,
    `components=${components}`,
    health.lastError ? `lastError=${health.lastError.code}: ${health.lastError.message}` : 'lastError=none',
  ].join('  ')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (!existsSync(CLI_ENTRY)) die(`the source CLI entry was not found at ${CLI_ENTRY}`)
  if (!existsSync(INBOX_SCRIPT) || !existsSync(NOTIFIER_SCRIPT)) {
    die('the fake inbox and notifier scripts must sit next to this driver')
  }

  const layout = createTempLayout()
  if (!resolve(layout.root).startsWith(resolve(tmpdir()))) {
    die('refusing to run outside the system temp directory')
  }
  log(`temp root: ${layout.root}`)

  // Everything the daemon writes stays under the temp root; the real config and
  // state homes are never touched.
  const childEnv = {
    ...process.env,
    WRENYARD_STATE_HOME: layout.stateDir,
    WRENYARD_CONFIG_HOME: layout.configDir,
    WRENYARD_IPC_PATH: layout.ipcPath,
    WRENYARD_WORKSPACE: layout.workspaceDir,
    BOT_DEMO_INBOX: layout.inboxFile,
    BOT_DEMO_NOTIFY_LOG: layout.notifyLogFile,
  }

  createDemoRepo(layout.repoDir, layout.bareRepoDir)
  const mainBefore = commitIdentity(layout.repoDir, ['rev-parse', 'main'])
  log(`demo-project main before: ${mainBefore}`)
  const originMainBefore = git(layout.bareRepoDir, ['rev-parse', 'main'])
  log(`demo-origin main before: ${originMainBefore}`)

  writeDemoConfig(layout)
  seedInbox(layout)
  writeBotConfig(layout, options)
  if (options.providerConfigFrom) copyProviderSubtrees(options.providerConfigFrom, layout.configDir)

  const daemon = startDaemon(layout, childEnv)
  const assertions = []
  let ipc

  try {
    ipc = await connectWhenReady(layout.ipcPath, Date.now() + STARTUP_TIMEOUT_MS)
    log('daemon IPC ready')

    // `git_remote` and `default_branch` are recorded in the generated
    // `<workspace>/projects/demo/demo.fmproj` metadata; declaring the remote is
    // what makes the project worktree-capable.
    await ipc.request('project.register', {
      project: PROJECT_ID,
      description: 'Bot mode demo project',
      checkout_path: layout.repoDir,
      git_remote: layout.bareRepoDir,
      default_branch: 'main',
    })
    log(`registered project ${PROJECT_ID}`)

    const validation = await ipc.request('bot.config.validate', { configPath: layout.botConfigFile })
    if (!validation.valid) die(`bot config validation failed: ${validation.error ?? 'unknown reason'}`)

    const created = await ipc.request('bot.create', {
      name: 'demo',
      configPath: layout.botConfigFile,
      mode: 'dryRun',
    })
    const botId = created.bot.id
    log(`created bot ${botId} (${created.bot.state}/${created.bot.mode})`)
    const started = await ipc.request('bot.control', { botId, action: 'start' })
    log(`bot ${started.bot.state}`)

    const deadline = Date.now() + options.timeoutMinutes * 60_000
    let lastSeq = 0
    let lastState
    let item
    let health

    // Ask for a pass only on the tick cadence; the progress print below still
    // runs on every poll and only reads state.
    let nextTickAt = 0
    while (Date.now() < deadline) {
      if (Date.now() >= nextTickAt) {
        nextTickAt = Date.now() + TICK_INTERVAL_MS
        await ipc.request('bot.tick', { botId })
      }
      const items = await ipc.request('bot.items', { botId })
      item = items.items.find((candidate) => candidate.sourceId === SOURCE_ID)
      const entries = await ipc.request('bot.log', { botId, afterSeq: lastSeq })
      for (const entry of entries.entries) {
        lastSeq = entry.seq
        log(`log ${entry.level} ${entry.code ?? '-'} ${entry.message}`)
      }
      health = await ipc.request('bot.health', { botId })
      if (!item) {
        log('no item recorded yet')
      } else if (item.state !== lastState) {
        lastState = item.state
        log(`${new Date().toISOString()} item ${item.sourceId} -> ${item.state}`)
      }
      log(formatHealth(health))
      if (item && TERMINAL_STATES.has(item.state)) break
      await sleep(POLL_INTERVAL_MS)
    }

    if (!item) {
      const items = await ipc.request('bot.items', { botId })
      item = items.items.find((candidate) => candidate.sourceId === SOURCE_ID)
    }
    if (item && !TERMINAL_STATES.has(item.state)) log(`stopped waiting: item still ${item.state} at the deadline`)

    const finalState = item?.state ?? '(no item)'
    assertions.push({
      name: 'item reached completed',
      ok: item?.state === 'completed',
      detail: item?.state === 'completed'
        ? `state=${finalState}`
        : `state=${finalState} error=${item?.error ?? 'none'} lastLogCodes=${(await ipc.request('bot.log', { botId, afterSeq: 0 })).entries.slice(-5).map((entry) => entry.code ?? '-').join(',')}`,
    })

    const inboxState = JSON.parse(readFileSync(layout.inboxFile, 'utf8'))
    const sourceItem = inboxState.items.find((candidate) => candidate.id === SOURCE_ID)
    assertions.push({
      name: 'fake inbox item is still open',
      ok: sourceItem?.open === true && sourceItem?.released !== true,
      detail: `open=${sourceItem?.open} released=${sourceItem?.released === true}`,
    })

    const notifyLogPresent = existsSync(layout.notifyLogFile)
    const notifyLogEmpty = !notifyLogPresent || readFileSync(layout.notifyLogFile, 'utf8').trim() === ''
    assertions.push({
      name: 'fake notifier log is empty or absent',
      ok: notifyLogEmpty,
      detail: notifyLogPresent ? (notifyLogEmpty ? 'absent (no file)' : 'present with content') : 'absent (no file)',
    })

    const mainAfter = commitIdentity(layout.repoDir, ['rev-parse', 'main'])
    assertions.push({
      name: 'demo-project main head is unchanged',
      ok: mainAfter === mainBefore,
      detail: `before=${mainBefore.slice(0, 12)} after=${mainAfter.slice(0, 12)}`,
    })

    // A dry run must not push either, so the bare origin's main stays put.
    const originMainAfter = git(layout.bareRepoDir, ['rev-parse', 'main'])
    assertions.push({
      name: 'demo-origin main head is unchanged',
      ok: originMainAfter === originMainBefore,
      detail: `before=${originMainBefore.slice(0, 12)} after=${originMainAfter.slice(0, 12)}`,
    })

    // Final forensic snapshot before the verdict: the item record read back
    // through bot.item.get and the health snapshot, both as JSON on stdout.
    const finalItem = item ? (await ipc.request('bot.item.get', { botId, itemId: item.id })).item : null
    const finalHealth = await ipc.request('bot.health', { botId })
    process.stdout.write(`${JSON.stringify({ item: finalItem, health: finalHealth }, null, 2)}\n`)
    if (health) log(`bot.health ${formatHealth(health)}`)
  } finally {
    if (ipc) await stopDaemon(ipc, daemon)
    else daemon.kill('SIGTERM')
    if (!options.keep) {
      try {
        rmSync(layout.root, { recursive: true, force: true })
      } catch (error) {
        log(`could not remove the temp root: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      log(`kept temp root: ${layout.root}`)
    }
  }

  const failed = assertions.filter((assertion) => !assertion.ok)
  for (const assertion of assertions) log(`${assertion.ok ? 'PASS' : 'FAIL'} ${assertion.name} (${assertion.detail})`)
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, assertions }, null, 2)}\n`)
  if (failed.length > 0) {
    process.stderr.write(`[bot-demo] failed assertion: ${failed[0].name}\n`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`[bot-demo] error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
