#!/usr/bin/env tsx
/**
 * Isolated real-source daemon startup probe.
 *
 * This is NOT a syntax check. It starts the actual `ForemanDaemon` from the
 * working tree against a throwaway config (empty workspace, disabled message
 * routing/backends, 127.0.0.1:0 HTTP, a unique IPC endpoint), then proves HTTP
 * and IPC health through the current control client before closing the daemon.
 *
 * The parent (`tools/dev/lib/daemon-preflight.mjs`) has already established a
 * fully isolated environment BEFORE this process imports anything: every home,
 * state/config directory, database, Desktop user-data root and IPC endpoint is
 * inside a unique temp root. This script asserts that isolation, then imports
 * the daemon modules dynamically so no module-level side effect can run while
 * the process is still un-isolated. Only a single success marker on stdout plus
 * exit code 0 tells the parent that it is safe to stop the live stack.
 *
 * No paid model request, no Desktop process, no real task recovery, no planned
 * restart state, no user client-configuration writes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const SUCCESS_MARKER = 'WRENYARD_PREFLIGHT_OK'
const CONNECT_TIMEOUT_MS = 5_000
const HTTP_TIMEOUT_MS = 5_000

const scriptDir = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(scriptDir, '..', '..')
const DAEMON_CONFIG_MODULE = join(checkout, 'apps', 'daemon', 'lib', 'config', 'index.mts')
const DAEMON_MODULE = join(checkout, 'apps', 'daemon', 'lib', 'index.mts')

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function exitWith(code: number, text: string): void {
  const line = text.endsWith('\n') ? text : `${text}\n`
  // Natural exit proves teardown released the handles; the parent bounds hangs.
  process.exitCode = code
  process.stdout.write(line)
}

interface ProbeArgs {
  probeRoot: string
  sourceConfig: string
}

function parseProbeArgs(argv: string[]): ProbeArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'probe-root': { type: 'string' },
      'source-config': { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  })
  const probeRoot = values['probe-root']?.trim()
  const sourceConfig = values['source-config']?.trim()
  if (!probeRoot) throw new Error('missing required --probe-root')
  if (!sourceConfig) throw new Error('missing required --source-config')
  if (positionals.length > 0) throw new Error(`unexpected positional argument: ${positionals[0]}`)
  return { probeRoot: resolve(probeRoot), sourceConfig: resolve(sourceConfig) }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Refuse to run unless the parent isolated every writable/contactable path. */
function assertIsolatedEnv(probeRoot: string): void {
  const isolatedKeys = [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'WRENYARD_STATE_HOME',
    'WRENYARD_CONFIG_HOME',
    'WRENYARD_DESKTOP_USER_DATA',
    'FOREMAN_DB_PATH',
    'CODEX_HOME',
  ]
  for (const key of isolatedKeys) {
    const value = process.env[key]
    if (!value || !isInside(resolve(value), probeRoot)) {
      throw new Error(`refusing to probe: ${key} is not inside the probe root (${value ?? 'unset'})`)
    }
  }
  // The IPC endpoint is a named pipe on Windows, so it is checked by identity
  // rather than containment in the filesystem probe root.
  const ipc = process.env.WRENYARD_IPC_PATH?.trim()
  const ipcIsolated = Boolean(ipc)
    && (ipc!.startsWith('\\\\.\\pipe\\') ? ipc!.includes('wrenyard-preflight-') : isInside(resolve(ipc!), probeRoot))
  if (!ipcIsolated) {
    throw new Error(`refusing to probe: WRENYARD_IPC_PATH is not a probe-owned endpoint (${ipc ?? 'unset'})`)
  }
  if (process.env.WRENYARD_SOURCE_DEV === '1' || process.env.WRENYARD_DEV_SUPERVISED === '1') {
    throw new Error('refusing to probe: inherited source-development instance identifiers are present')
  }
}

/**
 * Read-only validation of the real source config: parse and normalize it so a
 * broken config is reported before anything live is touched, but never write it
 * back (the config manager's migration write is deliberately not used here).
 */
function validateSourceConfig(
  normalizeForemanServiceConfig: (data: Record<string, unknown>, options: { configDir: string; env: NodeJS.ProcessEnv }) => unknown,
  sourceConfig: string,
): void {
  if (!existsSync(sourceConfig)) {
    process.stdout.write(`source config is absent (${sourceConfig}); validating isolation only\n`)
    return
  }
  const raw = JSON.parse(readFileSync(sourceConfig, 'utf8')) as unknown
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') {
    throw new Error(`source config is not a JSON object: ${sourceConfig}`)
  }
  normalizeForemanServiceConfig(raw as Record<string, unknown>, {
    configDir: dirname(sourceConfig),
    env: process.env,
  })
}

interface DaemonLike {
  start(): Promise<void>
  close(): Promise<void>
  readonly ipcPath: string
  readonly httpServer: { address(): { port?: number } | string | null }
}

async function checkHttpHealth(daemon: DaemonLike): Promise<boolean> {
  const address = daemon.httpServer.address()
  const port = address && typeof address === 'object' ? address.port : undefined
  if (!port) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    if (!response.ok) return false
    const body = (await response.json()) as { status?: string }
    return body?.status === 'ok'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  let args: ProbeArgs
  try {
    args = parseProbeArgs(process.argv.slice(2))
  } catch (error) {
    exitWith(1, `probe arguments invalid: ${message(error)}`)
    return
  }
  try {
    assertIsolatedEnv(args.probeRoot)
  } catch (error) {
    exitWith(1, message(error))
    return
  }

  // Dynamic imports: the isolated environment is proven before any daemon
  // module (and its module-level side effects) is loaded.
  await import(pathToFileURL(join(checkout, 'tools/dev/lib/supervisor.mjs')).href)
  await import(pathToFileURL(join(checkout, 'tools/dev/lib/launcher.mjs')).href)
  const configModule = (await import(pathToFileURL(DAEMON_CONFIG_MODULE).href)) as {
    normalizeForemanServiceConfig: (
      data: Record<string, unknown>,
      options: { configDir: string; env: NodeJS.ProcessEnv },
    ) => Record<string, any>
  }
  try {
    validateSourceConfig(configModule.normalizeForemanServiceConfig, args.sourceConfig)
  } catch (error) {
    exitWith(1, `source config is invalid: ${message(error)}`)
    return
  }

  const scratchRoot = join(args.probeRoot, 'scratch')
  const scratchConfigPath = join(scratchRoot, 'config.json')
  const workspaceRoot = join(args.probeRoot, 'workspace')
  mkdirSync(scratchRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })

  const ipcPath = process.env.WRENYARD_IPC_PATH?.trim()
    || (process.platform === 'win32'
      ? `\\\\.\\pipe\\wrenyard-preflight-${process.pid}`
      : join(args.probeRoot, 'run', 'daemon.sock'))

  // Scratch config: empty workspace (no registered real projects are scanned),
  // message routing/channels/backends disabled, loopback HTTP, unique IPC.
  const scratchData = {
    service: { enabled: true, bind: '127.0.0.1:8787', ipc: { path: ipcPath } },
    workspace: { root: workspaceRoot },
    message: { enabled: false, principals: {}, delivery: { enabled: false } },
  }
  writeFileSync(scratchConfigPath, `${JSON.stringify(scratchData, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

  const config = configModule.normalizeForemanServiceConfig(scratchData, {
    configDir: scratchRoot,
    env: process.env,
  })
  // Host/port are applied directly (the same way the daemon CLI overrides them):
  // port 0 binds an ephemeral port, and the real bound port is read back from
  // the daemon's own httpServer below.
  config.service.host = '127.0.0.1'
  config.service.port = 0

  const daemonModule = (await import(pathToFileURL(DAEMON_MODULE).href)) as {
    ForemanDaemon: new (options: { config: unknown; configPath: string }) => DaemonLike
    connectIpcForemanClient: (options: { path: string; timeoutMs?: number }) => Promise<{
      health: { ping(params?: unknown): Promise<{ ok?: boolean }> }
      close(): void
    }>
  }

  const daemon = new daemonModule.ForemanDaemon({ config, configPath: scratchConfigPath })
  let client: Awaited<ReturnType<typeof daemonModule.connectIpcForemanClient>> | undefined
  let healthy = false
  let failure = ''

  try {
    await daemon.start()
    const httpOk = await checkHttpHealth(daemon)
    client = await daemonModule.connectIpcForemanClient({ path: daemon.ipcPath, timeoutMs: CONNECT_TIMEOUT_MS })
    const ping = await client.health.ping({})
    const ipcOk = ping?.ok === true
    healthy = httpOk && ipcOk
    if (!healthy) failure = `health check failed (http=${httpOk}, ipc=${ipcOk})`
  } catch (error) {
    failure = message(error)
  } finally {
    try {
      client?.close()
    } catch {
      // Closing the control client must never mask the probe outcome.
    }
    try {
      await daemon.close()
    } catch (error) {
      failure = failure || `daemon close failed: ${message(error)}`
      healthy = false
    }
  }

  if (healthy) {
    exitWith(0, SUCCESS_MARKER)
    return
  }
  exitWith(1, `daemon probe failed: ${failure || 'unknown error'}`)
}

main().catch((error) => {
  exitWith(1, `daemon probe crashed: ${message(error)}`)
})
