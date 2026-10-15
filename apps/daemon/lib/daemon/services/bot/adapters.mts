import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { killProcessTree, spawnShellProcess } from '../../../adapters/shell/process.mts'
import { redactString } from '../../execution/redaction.mts'
import {
  BOT_ADAPTER_DEFAULT_TIMEOUT_MS,
  BOT_ADAPTER_MAX_TIMEOUT_MS,
  type BotAdapter,
} from './config.mts'

/**
 * Adapter runtime for Bot mode.
 *
 * Every private integration of a bot (its inbox, its notifier) is one of these
 * adapters: a user-local command that exchanges JSON, or an MCP tool. This
 * module is the only place that starts those processes, so timeouts, output
 * caps, process-tree cleanup and redaction are enforced once for every call.
 *
 * Nothing here ever logs or returns raw stdout, stderr, argv or environment
 * values: an error carries a redacted stderr tail and the executable's base
 * name, and the response is parsed JSON.
 */

/** Adapter step result: the parsed response plus how the call went. */
export interface BotAdapterRunResult {
  response: unknown
  durationMs: number
  exitCode: number
}

export type BotAdapterErrorCode =
  | 'adapter.timeout'
  | 'adapter.exit'
  | 'adapter.invalid_json'
  | 'adapter.invalid_response'
  | 'adapter.env_missing'
  | 'adapter.spawn'
  | 'adapter.unsupported'

/**
 * A failed adapter call. The message names the adapter's executable and the
 * failure, never an environment value, a full argv, stdin or raw stdout; any
 * stderr it includes is a redacted tail.
 */
export class BotAdapterError extends Error {
  readonly code: BotAdapterErrorCode

  constructor(code: BotAdapterErrorCode, message: string) {
    super(message)
    this.name = 'BotAdapterError'
    this.code = code
  }
}

export interface RunAdapterOptions {
  /** Aborting kills the adapter's process tree and fails the call as a timeout. */
  signal?: AbortSignal
}

const STDOUT_LIMIT_BYTES = 1024 * 1024
const STDERR_LIMIT_BYTES = 64 * 1024
const STDERR_TAIL_CHARS = 300
const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
/** Env values shorter than this are too small to scrub reliably from a tail. */
const SCRUB_MIN_LENGTH = 4

/**
 * Resolve `${env:NAME}` references in an adapter's environment from `source`.
 * A whole value may be a reference (`"${env:TOKEN}"`) or embed one
 * (`"Bearer ${env:TOKEN}"`). A reference with no value is an error that names
 * only the variable, so a missing secret never prints a neighbouring value.
 */
export function resolveAdapterEnv(
  env: Record<string, string> | undefined,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    resolved[key] = value.replace(ENV_REFERENCE, (_match, name: string) => {
      const referenced = source[name]
      if (referenced === undefined) {
        throw new BotAdapterError('adapter.env_missing', `adapter env references an unset variable: ${name}`)
      }
      return referenced
    })
  }
  return resolved
}

/**
 * Run one adapter call.
 *
 * A `command` adapter is started without a shell: `argv[0]` is the executable
 * and the rest are arguments. The request is one JSON object on stdin (which is
 * then closed) and the response is one JSON object on stdout. The call is
 * bounded by `timeoutMs` and killed as a process tree on timeout or abort.
 * An `mcp` adapter is not implemented yet and fails with `adapter.unsupported`.
 */
export async function runAdapter(
  adapter: BotAdapter,
  request: object,
  options: RunAdapterOptions = {},
): Promise<BotAdapterRunResult> {
  if (adapter.kind === 'mcp') {
    throw new BotAdapterError('adapter.unsupported', 'mcp adapters are not implemented yet')
  }

  const command = adapter.argv[0]
  if (command === undefined || command === '') {
    throw new BotAdapterError('adapter.spawn', 'adapter argv must not be empty')
  }
  const name = basename(command)
  const timeoutMs = clampTimeout(adapter.timeoutMs)
  const adapterEnv = resolveAdapterEnv(adapter.env)
  const envSecrets = Object.values(adapterEnv).filter((value) => value.length >= SCRUB_MIN_LENGTH)
  const startedAt = Date.now()

  const child = spawnShellProcess(command, adapter.argv.slice(1), {
    ...(adapter.cwd === undefined ? {} : { cwd: adapter.cwd }),
    env: { ...process.env, ...adapterEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Leading its own process group is what lets a timeout kill the whole tree
    // (helper children included) instead of only the direct child.
    detached: process.platform !== 'win32',
  })
  const { stdin, stdout: stdoutStream, stderr: stderrStream } = child
  if (stdin === null || stdoutStream === null || stderrStream === null) {
    throw new BotAdapterError('adapter.spawn', `adapter command ${name} did not start with stdin/stdout/stderr pipes`)
  }

  let stdout = ''
  let stdoutOverflow = false
  let stderrTail = ''
  let timedOut = false
  let aborted = false
  let killPromise: Promise<void> | undefined

  const terminate = (): Promise<void> => {
    killPromise ??= (async () => {
      if (child.pid === undefined) return
      try {
        await killProcessTree(child.pid)
      } catch {
        // Best effort: the tree may already be gone, and the call still fails.
      }
    })()
    return killPromise
  }

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })

  const timer = setTimeout(() => {
    timedOut = true
    void terminate()
  }, timeoutMs)
  const onAbort = (): void => {
    aborted = true
    void terminate()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted === true) onAbort()

  stdoutStream.on('data', (chunk: Buffer) => {
    if (stdoutOverflow) return
    stdout += chunk.toString('utf8')
    if (Buffer.byteLength(stdout, 'utf8') > STDOUT_LIMIT_BYTES) {
      stdoutOverflow = true
      stdout = ''
    }
  })
  // Only a bounded tail is kept, and it leaves this module redacted.
  stderrStream.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_LIMIT_BYTES)
  })
  stdin.on('error', () => {
    // The adapter may exit before reading its request; the exit status decides.
  })
  stdin.write(JSON.stringify(request))
  stdin.end()

  let exitInfo: { code: number | null; signal: NodeJS.Signals | null }
  try {
    exitInfo = await exit
  } catch (error) {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    const reason = (error as NodeJS.ErrnoException).code
    throw new BotAdapterError(
      'adapter.spawn',
      `adapter command ${name} could not start${typeof reason === 'string' ? ` (${reason})` : ''}`,
    )
  }
  clearTimeout(timer)
  options.signal?.removeEventListener('abort', onAbort)
  const durationMs = Date.now() - startedAt

  if (timedOut || aborted) {
    await terminate()
    const reason = aborted ? 'was aborted' : 'timed out'
    throw new BotAdapterError('adapter.timeout', `adapter command ${name} ${reason} after ${timeoutMs} ms`)
  }

  if (exitInfo.code !== 0) {
    const status = exitInfo.code === null
      ? `was killed by ${exitInfo.signal ?? 'an unknown signal'}`
      : `exited with code ${exitInfo.code}`
    throw new BotAdapterError('adapter.exit', `adapter command ${name} ${status}${stderrDetail(stderrTail, envSecrets)}`)
  }

  if (stdoutOverflow) {
    throw new BotAdapterError('adapter.invalid_json', `adapter command ${name} wrote more than ${STDOUT_LIMIT_BYTES} bytes to stdout`)
  }

  const text = stdout.trim()
  let response: unknown
  try {
    response = JSON.parse(text) as unknown
  } catch {
    throw new BotAdapterError('adapter.invalid_json', `adapter command ${name} did not write one JSON object on stdout`)
  }
  if (!isRecord(response)) {
    throw new BotAdapterError('adapter.invalid_json', `adapter command ${name} did not write one JSON object on stdout`)
  }
  return { response, durationMs, exitCode: exitInfo.code ?? 0 }
}

/** One inbox item as an adapter reports it. */
export interface InboxItem {
  id: string
  title: string
  body?: string
  project?: string
  url?: string
  updatedAt?: string
}

/** The inbox ops a bot may call; a bot never reads answers out of the inbox. */
export type InboxOp = 'list' | 'get' | 'complete' | 'annotate' | 'release'

export interface InboxClient {
  list(): Promise<{ items: InboxItem[] }>
  get(id: string): Promise<{ item: (InboxItem & { open: boolean }) | null }>
  complete(id: string): Promise<{ ok: boolean }>
  annotate(id: string, text: string): Promise<{ ok: boolean }>
  release(id: string): Promise<{ ok: boolean }>
}

/** Typed inbox client over one adapter; every response shape is validated. */
export function createInboxClient(adapter: BotAdapter, options: RunAdapterOptions = {}): InboxClient {
  async function call(op: InboxOp, request: object): Promise<Record<string, unknown>> {
    const { response } = await runAdapter(adapter, request, options)
    return response as Record<string, unknown>
  }

  return {
    async list() {
      const response = await call('list', { op: 'list' })
      const items = response.items
      if (!onlyKeys(response, ['items']) || !Array.isArray(items) || !items.every(isInboxItem)) {
        throw invalidResponse('list')
      }
      return { items: items.map(toInboxItem) }
    },
    async get(id: string) {
      const response = await call('get', { op: 'get', id })
      const item = response.item
      if (!onlyKeys(response, ['item']) || (item !== null && !isOpenInboxItem(item))) {
        throw invalidResponse('get')
      }
      if (item === null) return { item: null }
      return { item: { ...toInboxItem(item), open: item.open as boolean } }
    },
    async complete(id: string) {
      const response = await call('complete', { op: 'complete', id })
      if (!onlyKeys(response, ['ok']) || typeof response.ok !== 'boolean') throw invalidResponse('complete')
      return { ok: response.ok }
    },
    async annotate(id: string, text: string) {
      const response = await call('annotate', { op: 'annotate', id, text })
      if (!onlyKeys(response, ['ok']) || typeof response.ok !== 'boolean') throw invalidResponse('annotate')
      return { ok: response.ok }
    },
    async release(id: string) {
      const response = await call('release', { op: 'release', id })
      if (!onlyKeys(response, ['ok']) || typeof response.ok !== 'boolean') throw invalidResponse('release')
      return { ok: response.ok }
    },
  }
}

export interface NotifierMedia {
  path: string
  kind: 'image' | 'file'
}

export interface NotifierSendInput {
  text: string
  media?: NotifierMedia[]
}

export interface Notifier {
  send(input: NotifierSendInput): Promise<{ ok: boolean; messageId?: string }>
}

/** Typed notifier over one adapter; the response shape is validated. */
export function createNotifier(adapter: BotAdapter, options: RunAdapterOptions = {}): Notifier {
  return {
    async send(input: NotifierSendInput) {
      const request = input.media === undefined
        ? { op: 'send', text: input.text }
        : { op: 'send', text: input.text, media: input.media }
      const { response } = await runAdapter(adapter, request, options)
      const payload = response as Record<string, unknown>
      if (!onlyKeys(payload, ['ok', 'messageId']) || typeof payload.ok !== 'boolean') {
        throw invalidResponse('send')
      }
      if (payload.messageId !== undefined && typeof payload.messageId !== 'string') {
        throw invalidResponse('send')
      }
      return payload.messageId === undefined
        ? { ok: payload.ok }
        : { ok: payload.ok, messageId: payload.messageId }
    },
  }
}

/**
 * sha256 of an item's title and body. The bot stores it when it dispatches and
 * compares it before completing the source, so an edit mid-flight is detected
 * instead of silently delivering stale work.
 */
export function itemFingerprint(item: { title: string; body?: string }): string {
  return createHash('sha256').update(`${item.title}\n${item.body ?? ''}`).digest('hex')
}

/** Log-safe adapter summary: never argv values beyond the executable, never env. */
export type BotAdapterDescription =
  | { kind: 'command'; command: string }
  | { kind: 'mcp'; tool: string }

export function describeAdapter(adapter: BotAdapter): BotAdapterDescription {
  if (adapter.kind === 'mcp') return { kind: 'mcp', tool: adapter.tool }
  return { kind: 'command', command: basename(adapter.argv[0] ?? '') }
}

function clampTimeout(timeoutMs: number | undefined): number {
  const fallback = timeoutMs ?? BOT_ADAPTER_DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(fallback) || fallback < 1) return BOT_ADAPTER_DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(fallback), BOT_ADAPTER_MAX_TIMEOUT_MS)
}

/** A bounded, redacted stderr tail for an error message, or nothing. */
function stderrDetail(stderrTail: string, envSecrets: readonly string[]): string {
  if (stderrTail.trim() === '') return ''
  let scrubbed = stderrTail
  for (const secret of envSecrets) scrubbed = scrubbed.split(secret).join('[redacted]')
  return `: ${redactString(scrubbed, STDERR_TAIL_CHARS)}`
}

/** Errors name the op only; response contents are never echoed back. */
function invalidResponse(op: InboxOp | 'send'): BotAdapterError {
  return new BotAdapterError('adapter.invalid_response', `adapter response for op '${op}' is invalid`)
}

const INBOX_ITEM_KEYS = ['id', 'title', 'body', 'project', 'url', 'updatedAt'] as const
const INBOX_ITEM_OPTIONAL_KEYS = ['body', 'project', 'url', 'updatedAt'] as const

function isInboxItem(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && itemFieldsOk(value, false)
}

function isOpenInboxItem(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.open === 'boolean' && itemFieldsOk(value, true)
}

function itemFieldsOk(value: Record<string, unknown>, withOpen: boolean): boolean {
  if (!onlyKeys(value, withOpen ? [...INBOX_ITEM_KEYS, 'open'] : INBOX_ITEM_KEYS)) return false
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.title)) return false
  return INBOX_ITEM_OPTIONAL_KEYS.every((key) => value[key] === undefined || typeof value[key] === 'string')
}

function toInboxItem(item: Record<string, unknown>): InboxItem {
  const result: InboxItem = { id: item.id as string, title: item.title as string }
  for (const key of ['body', 'project', 'url', 'updatedAt'] as const) {
    const value = item[key]
    if (typeof value === 'string') result[key] = value
  }
  return result
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
