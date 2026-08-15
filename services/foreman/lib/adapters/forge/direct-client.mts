import type { ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { spawnForge as spawnResolvedForge } from './exec.mts'
import { parseAgentRuntime } from '../../core/agent-runtime.mts'

export type ForgeDirectPermission = 'readonly' | 'edit' | 'yolo'

export interface ForgeCommandOptions {
  profile: string
  permission: ForgeDirectPermission
  cwd: string
  prompt: string
  resume?: string
  /** If set, use this as the concrete profile for retry/resume, overriding
   *  any agentRuntime classification. */
  resolvedProfile?: string
  /** Selected Forge capability pack ids; each emits one --cap pair before
   *  the prompt/stdin boundary. When absent or empty, argv is unchanged. */
  capabilities?: readonly string[]
}

export interface ForgeSpawnOptions extends ForgeCommandOptions {
  env?: NodeJS.ProcessEnv
}

export interface ForgeSpawnResult {
  child: ChildProcess
  pid: number
  pgid: number | undefined
}

export type ForgeStreamJsonEvent = Record<string, unknown>

const DEFAULT_STREAM_JSON_MAX_LINE_BYTES = 1024 * 1024
const LEGACY_FORGE_TASK_SESSION_ID = /^fg_\d{8}_[0-9a-f]{4}$/u

export interface ReadStreamJsonOptions {
  maxLineBytes?: number
}

export function buildForgeCommand(opts: ForgeCommandOptions): string[] {
  const cwd = assertAbsoluteCwd(opts.cwd)
  const resume = assertNativeResumeId(opts.resume)
  const profileArgs = buildProfileArgs(opts)
  const args = [
    ...profileArgs,
    '--permission',
    opts.permission,
    '-C',
    cwd,
    '-f',
    'stream-json',
    ...(resume ? ['-r', resume] : []),
    ...buildCapArgs(opts.capabilities),
  ]

  return args
}

function buildProfileArgs(opts: ForgeCommandOptions): string[] {
  if (opts.resolvedProfile) {
    return ['--profile', opts.resolvedProfile]
  }
  try {
    const rt = parseAgentRuntime(opts.profile)
    if (rt.isPolicy) {
      return ['--profile-policy', rt.configId]
    }
    return ['--profile', rt.configId]
  } catch (error) {
    if (opts.profile.includes('/')) throw error
    // Fallback for legacy profile strings that aren't in agentRuntime format
    return ['--profile', opts.profile]
  }
}

function buildCapArgs(capabilities: readonly string[] | undefined): string[] {
  if (!capabilities || capabilities.length === 0) return []
  const args: string[] = []
  for (const id of capabilities) {
    args.push('--cap', id)
  }
  return args
}

export function spawnForge(opts: ForgeSpawnOptions): ForgeSpawnResult {
  const cwd = assertAbsoluteCwd(opts.cwd)
  const child = spawnResolvedForge(buildForgeCommand(opts), {
    cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // detached:true creates a new process group so kill(-pgid) can terminate the whole tree;
    // lifecycle binding is via pipe SIGPIPE on parent death + explicit service-shutdown kill, not unref().
    detached: process.platform !== 'win32',
    windowsHide: true,
  })

  if (!child.pid) {
    child.once('error', () => {
      // Prevent an unhandled async spawn error after surfacing the sync failure.
    })
    throw new Error('Failed to spawn forge process')
  }

  if (child.stdin) {
    child.stdin.on('error', () => {
      // The process may exit before reading stdin; terminal handling surfaces the real failure.
    })
    child.stdin.end(opts.prompt)
  }

  return {
    child,
    pid: child.pid,
    pgid: process.platform === 'win32' ? undefined : child.pid,
  }
}

export async function* readStreamJson(
  child: ChildProcess,
  opts: ReadStreamJsonOptions = {},
): AsyncGenerator<ForgeStreamJsonEvent, void, void> {
  if (!child.stdout) {
    throw new Error('Forge child stdout is not readable')
  }

  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_STREAM_JSON_MAX_LINE_BYTES
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new Error(`Forge stream-json max line bytes must be a positive safe integer; received ${maxLineBytes}`)
  }

  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let bufferBytes = 0
  let discardingOversizedLine = false

  for await (const chunk of child.stdout) {
    const text = decodeChunk(decoder, chunk)

    for (const event of appendStreamJsonText(text)) {
      yield event
    }
  }

  for (const event of appendStreamJsonText(decoder.end())) {
    yield event
  }

  if (buffer.trim()) {
    console.warn('[foreman] Dropping incomplete forge stream-json line at EOF')
  }

  function appendStreamJsonText(text: string): ForgeStreamJsonEvent[] {
    const events: ForgeStreamJsonEvent[] = []
    let start = 0

    while (start < text.length) {
      const newlineIndex = text.indexOf('\n', start)
      const hasNewline = newlineIndex !== -1
      const segmentEnd = hasNewline ? newlineIndex : text.length
      const segment = text.slice(start, segmentEnd)

      if (discardingOversizedLine) {
        if (hasNewline) {
          discardingOversizedLine = false
        }
        start = hasNewline ? newlineIndex + 1 : text.length
        continue
      }

      const segmentBytes = Buffer.byteLength(segment)
      const lineBytes = bufferBytes + segmentBytes
      if (lineBytes > maxLineBytes) {
        warnOversizedStreamJsonLine(lineBytes, maxLineBytes)
        buffer = ''
        bufferBytes = 0
        discardingOversizedLine = !hasNewline
        start = hasNewline ? newlineIndex + 1 : text.length
        continue
      }

      if (hasNewline) {
        const line = buffer + segment
        buffer = ''
        bufferBytes = 0

        const event = parseStreamJsonLine(line, 'Skipping malformed forge stream-json line')
        if (event) events.push(event)
      } else {
        buffer += segment
        bufferBytes = lineBytes
      }

      start = hasNewline ? newlineIndex + 1 : text.length
    }

    return events
  }
}

function assertAbsoluteCwd(cwd: string): string {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Forge cwd must be an absolute path for -C; received ${JSON.stringify(cwd)}`)
  }
  return cwd
}

function assertNativeResumeId(resume: string | undefined): string | undefined {
  if (!resume) return undefined
  if (LEGACY_FORGE_TASK_SESSION_ID.test(resume)) {
    throw new Error(`Forge direct runtime resume requires a downstream native session id, not legacy Forge task-session id ${JSON.stringify(resume)}`)
  }
  return resume
}

function warnOversizedStreamJsonLine(lineBytes: number, maxLineBytes: number): void {
  console.warn(
    `[foreman] Dropping oversized forge stream-json line: ${lineBytes} bytes exceeds ${maxLineBytes} byte limit`,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function decodeChunk(decoder: StringDecoder, chunk: unknown): string {
  if (Buffer.isBuffer(chunk)) return decoder.write(chunk)
  if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk))
  return String(chunk)
}

function parseStreamJsonLine(line: string, warningPrefix: string): ForgeStreamJsonEvent | undefined {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!text.trim()) return undefined

  try {
    const parsed = JSON.parse(text) as unknown
    if (isJsonObject(parsed)) return parsed
    console.warn(`[foreman] ${warningPrefix}: expected object`)
    return undefined
  } catch (error) {
    console.warn(`[foreman] ${warningPrefix}: ${errorMessage(error)}`)
    return undefined
  }
}

function isJsonObject(value: unknown): value is ForgeStreamJsonEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
