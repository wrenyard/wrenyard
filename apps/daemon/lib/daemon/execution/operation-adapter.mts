/**
 * Shared operation execution adapter.
 *
 * One boundary turns a caller's requested operation ids into a prepared run:
 * the legacy browser/computer feature ids map onto the two operation components,
 * each requested component is re-verified at execution start, and the result
 * carries the composed prompt, the MCP servers to attach and the environment the
 * run needs. Both the task supervisor and the raw `exec.start` path use it, so
 * tasks and direct executions cannot drift apart.
 *
 * Browser operations run through the `agent-browser` CLI: the adapter puts the
 * resolved executable on PATH and selects a unique session per run so the run
 * never attaches to the user's own browser or to another run's session. Desktop
 * operations attach the Cua Driver MCP server; because the desktop is the user's
 * real, shared session, only one owner may hold it at a time.
 *
 * A component that is not ready fails that run before anything is spawned, with
 * an actionable message that names this host and points at Settings. Nothing
 * here reaches outside the run: daemon startup and unrelated tools are not
 * affected by a missing component.
 */

import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { delimiter, dirname } from 'node:path'
import type { McpServer } from '@wrenyard/exec'
import type {
  OperationComponentId,
  OperationComponentLaunch,
  OperationComponentSnapshot,
  OperationComponents,
} from '../services/operation-components.mts'

const BROWSER_INSTRUCTION = `An agent-browser CLI is available for this run as \`agent-browser\` on PATH. Its browser session is preselected through AGENT_BROWSER_SESSION; do not pass --session, --profile or --auto-connect, and do not attach to the user's own browser or to any browser this run did not start. The only way to attach to an existing debugging endpoint is the global \`--cdp <port>\` flag, placed before the subcommand, for example \`agent-browser --cdp 127.0.0.1:<port> open <url>\` or \`agent-browser --cdp 127.0.0.1:<port> snapshot\`. Use it only for a loopback endpoint (127.0.0.1 or localhost) whose process this run itself launched. The \`agent-browser connect\` subcommand does not attach to an already running browser in this version - it rejects a host:port value and a bare port starts a new managed browser - so never use \`connect\` to reach an existing endpoint. Typical loop against a browser this run started: \`agent-browser open <url>\`, \`agent-browser snapshot\` to list elements with refs such as \`@e1\`, \`agent-browser click @e1\`, \`agent-browser fill @e2 "text"\`, \`agent-browser screenshot <path>\`. To drive the repository's own Electron/Desktop app, launch it as a child of this run with a remote-debugging port bound to 127.0.0.1, then use \`agent-browser --cdp 127.0.0.1:<port> snapshot\` and \`agent-browser --cdp 127.0.0.1:<port> screenshot <path>\` to interact with its window and capture it. Run \`agent-browser skills get core --full\` for the version-matched command guide, and \`agent-browser --help\` for other commands. Quote the exact URL you loaded when reporting results.`

const DESKTOP_INSTRUCTION = `A desktop-control MCP server is attached for this run under the server name \`computer\` (its tools are named like \`mcp__computer__<tool>\`). Use its tools to inspect the screen, move the pointer, click, type, and press keys, then verify each action by re-reading the screen before continuing. Limit interaction to the windows relevant to the task and describe any state you changed. The desktop is the user's real session and is not sandboxed.`

const SENSITIVE_ACTION_INSTRUCTION = `Before any irreversible or sensitive action — purchases or payments, sending messages or posts, submitting credentials or personal data, uploading or downloading user files, deleting data, or changing account or system settings — stop and report that the action needs the user's confirmation instead of performing it.`

/** Legacy task/exec feature ids that map onto the two operation components. */
const LEGACY_OPERATION_IDS: Readonly<Record<string, OperationComponentId>> = {
  browser: 'browser',
  'browser-use': 'browser',
  computer: 'desktop',
  'computer-use': 'desktop',
}

/**
 * Map and validate requested execution feature ids.
 *
 * Legacy ids are accepted so existing task configuration, `exec.start` requests,
 * CLI arguments and the builtin `test` task input keep working; anything else is
 * reported as an unknown execution feature (the exact prefix the exec.start error
 * mapper parses) instead of being silently dropped.
 */
export function toOperationIds(features: readonly string[] | undefined): OperationComponentId[] {
  if (!features || features.length === 0) return []
  const ids: OperationComponentId[] = []
  const unknown: string[] = []
  for (const entry of features) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('Requested execution feature id must be a non-empty string')
    }
    const value = entry.trim()
    const mapped = LEGACY_OPERATION_IDS[value]
    if (!mapped) {
      unknown.push(value)
      continue
    }
    if (!ids.includes(mapped)) ids.push(mapped)
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown execution feature${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`)
  }
  return ids
}

/** The run-facing result of preparing an operation set. */
export interface PreparedOperations {
  prompt: string
  mcpServers?: Record<string, McpServer>
  applyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  release(): Promise<void>
}

export interface PrepareOperationInput {
  prompt: string
  mcpServers?: Readonly<Record<string, McpServer>>
  ids: readonly OperationComponentId[]
  /** Identifies the run; seeds the isolated browser session name. */
  runId: string
  /** Lock owner; the same task retry keeps the same owner. */
  owner: string
  /** Resolved agent client id; selects the per-client discovery hint. */
  clientId?: string
}

// The desktop is a single shared resource across the whole daemon. The lock is
// per owner so structured-output retries of one task are not refused, while a
// different run fails fast instead of fighting over the user's real desktop.
let desktopLockOwner: string | undefined
let desktopLockCount = 0

function acquireDesktopLock(owner: string, host: string): void {
  if (desktopLockOwner !== undefined && desktopLockOwner !== owner) {
    throw new Error(
      `The desktop operation component is in use by another run on host '${host}'. Desktop operations run one at a time; retry after it finishes.`,
    )
  }
  desktopLockOwner = owner
  desktopLockCount += 1
}

function releaseDesktopLock(): void {
  if (desktopLockCount === 0) return
  desktopLockCount -= 1
  if (desktopLockCount === 0) desktopLockOwner = undefined
}

function browserSessionName(runId: string): string {
  return `wy-${runId.replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 48)
}

/** Claude-family clients expose MCP tools as deferred tools found via ToolSearch. */
function isClaudeFamily(clientId: string | undefined): boolean {
  const id = clientId?.trim().toLowerCase()
  return id === 'claude' || id === 'codebuddy'
}

function pathKeyOf(env: NodeJS.ProcessEnv): string | undefined {
  if (typeof env.PATH === 'string') return 'PATH'
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') return key
    }
  }
  return undefined
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function applyBrowserEnv(
  env: NodeJS.ProcessEnv,
  directory: string,
  baseEnv: Record<string, string>,
  session: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  const key = pathKeyOf(next)
  if (key) {
    const parts = (next[key] ?? '').split(delimiter).filter((entry) => entry.length > 0)
    if (!parts.some((entry) => samePath(entry, directory))) parts.unshift(directory)
    next[key] = parts.join(delimiter)
  } else {
    next.PATH = directory
  }
  for (const [name, value] of Object.entries(baseEnv)) next[name] = value
  next.AGENT_BROWSER_SESSION = session
  return next
}

/** Best-effort child run whose failure is never surfaced to the caller. */
function runQuietly(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024, env },
      () => resolve(),
    )
  })
}

export class OperationAdapter {
  readonly #components: OperationComponents

  constructor(components: OperationComponents) {
    this.#components = components
  }

  async prepare(input: PrepareOperationInput): Promise<PreparedOperations> {
    const { prompt, mcpServers, ids, runId, owner, clientId } = input

    if (ids.length === 0) {
      return {
        prompt,
        mcpServers: mcpServers ? { ...mcpServers } : undefined,
        applyEnv: (env) => ({ ...env }),
        release: async () => {},
      }
    }

    const servers: Record<string, McpServer> = { ...(mcpServers ?? {}) }
    const instructions: string[] = []
    const envModifiers: Array<(env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> = []
    const cleanups: Array<() => Promise<void>> = []
    let desktopHeld = false

    try {
      const snapshots = new Map<OperationComponentId, OperationComponentSnapshot>()

      for (const id of ids) {
        const launch: OperationComponentLaunch = await this.#components.resolve(id)
        snapshots.set(id, launch.snapshot)

        if (id === 'browser') {
          const session = browserSessionName(runId)
          const directory = dirname(launch.executable)
          const baseEnv = launch.env
          envModifiers.push((env) => applyBrowserEnv(env, directory, baseEnv, session))
          cleanups.push(() =>
            runQuietly(launch.executable, ['--session', session, 'close'], {
              ...launch.env,
              AGENT_BROWSER_SESSION: session,
            }),
          )
          instructions.push(BROWSER_INSTRUCTION)
          continue
        }

        if (servers.computer) throw new Error(`Duplicate MCP server 'computer'`)
        const server: McpServer =
          launch.mcpServer ?? { transport: 'stdio', command: launch.executable, args: ['mcp'] }
        acquireDesktopLock(owner, launch.host)
        desktopHeld = true
        servers.computer = server
        instructions.push(DESKTOP_INSTRUCTION)
      }

      instructions.push(SENSITIVE_ACTION_INSTRUCTION)
      const environmentBlock = this.#environmentPreamble(clientId, ids, snapshots)
      const instructionSections = instructions
        .map((text, index) => `# Instruction ${index + 1}\n${text}`)
        .join('\n\n')

      const acquired = [...cleanups]
      let released = false
      const release = async (): Promise<void> => {
        if (released) return
        released = true
        if (desktopHeld) {
          releaseDesktopLock()
          desktopHeld = false
        }
        for (const cleanup of acquired) {
          try {
            await cleanup()
          } catch {
            // Closing a browser session is best effort; it must not mask the run.
          }
        }
      }

      return {
        prompt: `${environmentBlock}\n\n${prompt}\n\n${instructionSections}`,
        mcpServers: Object.keys(servers).length > 0 ? servers : undefined,
        applyEnv: (env) => envModifiers.reduce((current, modify) => modify(current), { ...env }),
        release,
      }
    } catch (error) {
      if (desktopHeld) releaseDesktopLock()
      throw error
    }
  }

  /** Short host/platform/component preamble prepended to every operation prompt. */
  #environmentPreamble(
    clientId: string | undefined,
    ids: readonly OperationComponentId[],
    snapshots: ReadonlyMap<OperationComponentId, OperationComponentSnapshot>,
  ): string {
    const lines = ['# Environment']
    lines.push(`Host: ${hostname()} (${process.platform} ${process.arch})`)
    for (const id of ids) {
      const snapshot = snapshots.get(id)
      if (!snapshot) continue
      const version = snapshot.version ? ` ${snapshot.version}` : ''
      const runtime = snapshot.runtimePresent ? ' (browser runtime present)' : ''
      lines.push(`- ${id}: ${snapshot.state}${version}${runtime}`)
    }
    if (ids.includes('desktop')) {
      lines.push('Desktop control MCP server name: `computer`.')
      lines.push(
        isClaudeFamily(clientId)
          ? 'desktop tools may be deferred; search ToolSearch for mcp__computer__ first'
          : 'Computer tools are available directly.',
      )
    }
    if (ids.includes('browser')) {
      lines.push('Run `agent-browser skills get core --full` for the version-matched browser command guide.')
    }
    return lines.join('\n')
  }
}
