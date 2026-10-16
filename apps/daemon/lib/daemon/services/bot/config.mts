import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { resolveWrenyardConfigRoot } from '@wrenyard/paths'
import { REASONING_EFFORTS, parseRunSyntax, type ReasoningEffort } from '@wrenyard/providers/catalog'

/**
 * Bot configuration loader.
 *
 * A bot's configuration is user-local: it lives in `<configHome>/bots/<name>.json`
 * and never in a workspace or repository. The daemon stores only the path and a
 * content hash; this module turns that file into the validated, default-complete
 * `BotConfig` the host runs with, so every other bot module can rely on the
 * shape instead of re-checking it.
 *
 * Secrets are never written in the file. Adapter environment values may
 * reference variables as `"${env:NAME}"`, resolved at execution time by
 * `adapters.mts`; the file itself stays free of credentials.
 */

export type BotConfigMode = 'live' | 'dryRun'

/** Adapter timeout bounds; also enforced by the adapter runner. */
export const BOT_ADAPTER_DEFAULT_TIMEOUT_MS = 20_000
export const BOT_ADAPTER_MAX_TIMEOUT_MS = 300_000

const DEFAULT_MAX_ACTIVE_ITEMS = 3
const DEFAULT_MAX_DISPATCH_PER_TICK = 1
const DEFAULT_TICK_SECONDS = 60
const MIN_TICK_SECONDS = 10
const DEFAULT_POLL_MINUTES = 10
const MIN_POLL_MINUTES = 1
const DEFAULT_QUIET_HOURS_DEFER = ['notify']
const DEFAULT_MAX_CORRECTIONS = 3
const DEFAULT_MAX_ACCEPTANCE_ATTEMPTS = 2
const DEFAULT_MAX_ITEM_HOURS = 8
const DEFAULT_MAX_ITEMS_PER_DAY = 20
const DEFAULT_LOAD_MAX_ACTIVE_EXECUTIONS = 8
const DEFAULT_QUEUED_EXECUTION_MINUTES = 5
const DEFAULT_TASK_RUN_MINUTES = { verify: 20, review: 20, accept: 60 } as const
const DEFAULT_SESSION_SILENT_MINUTES = 30
const DEFAULT_TICK_LAG_WARN_MS = 10_000
const DEFAULT_COMPONENT_CHECK_MINUTES = 30

/** A `command` adapter: argv only, one JSON request on stdin, one JSON on stdout. */
export interface BotCommandAdapter {
  kind: 'command'
  argv: string[]
  cwd?: string
  /** Literal values, possibly referencing the daemon environment as `${env:NAME}`. */
  env?: Record<string, string>
  timeoutMs: number
}

/** An `mcp` adapter: one tool of a configured MCP server. */
export interface BotMcpAdapter {
  kind: 'mcp'
  server: Record<string, unknown>
  tool: string
  timeoutMs: number
}

/** A daemon-native workspace todo inbox; it has no caller-supplied settings. */
export interface BotWorkspaceAdapter {
  kind: 'workspace'
}

export type BotNotifierAdapter = BotCommandAdapter | BotMcpAdapter
export type BotAdapter = BotNotifierAdapter | BotWorkspaceAdapter

/** Per-project standing authorization for the bot. */
export interface BotProjectPolicy {
  id: string
  match: string[]
  /** Defaults to false: merging is never implicit. */
  merge: boolean
  /** Defaults to false: pushing is never implicit. */
  push: boolean
  /** Defaults to disabled, and is the last stage of the feature. */
  release: { enabled: boolean }
}

export interface BotRoutingEntry {
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
  /**
   * Optional canonical run target `<provider>/<model>:<client>`. When present,
   * task runs of this class select it explicitly; absent means automatic
   * routing.
   */
  target?: string
}

/** Routing by item class; `default`, `acceptance` and `judgment` are required. */
export type BotRouting = {
  default: BotRoutingEntry
  acceptance: BotRoutingEntry
  judgment: BotRoutingEntry
} & Record<string, BotRoutingEntry>

export interface BotConcurrency {
  maxActiveItems: number
  maxDispatchPerTick: number
}

export interface BotCadence {
  tickSeconds: number
  pollMinutes: number
}

export interface BotQuietHours {
  timeZone: string
  start: string
  end: string
  /** Actions held during quiet hours; defaults to `['notify']`. */
  defer: string[]
}

export interface BotBudgets {
  maxCorrections: number
  maxAcceptanceAttempts: number
  maxItemHours: number
  maxItemsPerDay: number
}

/** Per-kind wall-clock budget for a detached verify/review/accept task run. */
export interface BotTaskRunMinutes {
  verify: number
  review: number
  accept: number
}

/**
 * Watchdog thresholds and load back-off limits. Every value has a default, so
 * the whole section is optional; an unknown key inside it is still rejected.
 */
export interface BotWatchdogs {
  /** Back new work off at or above this many active daemon executions. */
  loadMaxActiveExecutions: number
  /** Back off (and warn) when an execution has been queued this many minutes. */
  queuedExecutionMinutes: number
  /** Cancel a detached task run that outlives its kind's budget, in minutes. */
  taskRunMinutes: BotTaskRunMinutes
  /** Warn when a session runs a turn with no new ledger event for this long. */
  sessionSilentMinutes: number
  /** Warn when the last tick started later than this, in milliseconds. */
  tickLagWarnMs: number
  /** Re-check acceptance components at most this often, in minutes. */
  componentCheckMinutes: number
}

/**
 * The neutral watchdog defaults, also used by the host for a bot that has no
 * readable config, so the thresholds are defined in exactly one place.
 */
export const DEFAULT_BOT_WATCHDOGS: BotWatchdogs = {
  loadMaxActiveExecutions: DEFAULT_LOAD_MAX_ACTIVE_EXECUTIONS,
  queuedExecutionMinutes: DEFAULT_QUEUED_EXECUTION_MINUTES,
  taskRunMinutes: { ...DEFAULT_TASK_RUN_MINUTES },
  sessionSilentMinutes: DEFAULT_SESSION_SILENT_MINUTES,
  tickLagWarnMs: DEFAULT_TICK_LAG_WARN_MS,
  componentCheckMinutes: DEFAULT_COMPONENT_CHECK_MINUTES,
}

/** The complete, default-applied bot configuration. */
export interface BotConfig {
  name: string
  /** `dryRun` keeps every outward effect in the journal instead of performing it. */
  mode: BotConfigMode
  inbox: BotAdapter
  notifier: BotNotifierAdapter
  projects: BotProjectPolicy[]
  routing: BotRouting
  concurrency: BotConcurrency
  cadence: BotCadence
  quietHours?: BotQuietHours
  watchdogs: BotWatchdogs
  budgets: BotBudgets
}

export type BotConfigValidation =
  | { ok: true; config: BotConfig }
  | { ok: false; issues: string[] }

const TOP_LEVEL_KEYS = [
  'name',
  'mode',
  'inbox',
  'notifier',
  'projects',
  'routing',
  'concurrency',
  'cadence',
  'quietHours',
  'watchdogs',
  'budgets',
] as const
const COMMAND_ADAPTER_KEYS = ['kind', 'argv', 'cwd', 'env', 'timeoutMs'] as const
const MCP_ADAPTER_KEYS = ['kind', 'server', 'tool', 'timeoutMs'] as const
const WORKSPACE_ADAPTER_KEYS = ['kind'] as const
const PROJECT_KEYS = ['id', 'match', 'merge', 'push', 'release'] as const
const ROUTING_ENTRY_KEYS = ['provider', 'model', 'reasoningEffort', 'target'] as const
const CONCURRENCY_KEYS = ['maxActiveItems', 'maxDispatchPerTick'] as const
const CADENCE_KEYS = ['tickSeconds', 'pollMinutes'] as const
const QUIET_HOURS_KEYS = ['timeZone', 'start', 'end', 'defer'] as const
const WATCHDOG_KEYS = [
  'loadMaxActiveExecutions',
  'queuedExecutionMinutes',
  'taskRunMinutes',
  'sessionSilentMinutes',
  'tickLagWarnMs',
  'componentCheckMinutes',
] as const
const TASK_RUN_MINUTES_KEYS = ['verify', 'review', 'accept'] as const
const BUDGET_KEYS = ['maxCorrections', 'maxAcceptanceAttempts', 'maxItemHours', 'maxItemsPerDay'] as const
const REQUIRED_ROUTING_CLASSES = ['default', 'acceptance', 'judgment'] as const
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Resolve a bot config path and require that it lives in the config home's
 * `bots/` directory. Shared with the host's `bot.config.validate` so the rule
 * exists in exactly one place.
 */
export function resolveBotConfigPath(configPath: string): string {
  const botsDir = resolve(resolveWrenyardConfigRoot(), 'bots')
  const resolved = resolve(configPath)
  if (resolved !== botsDir && !resolved.startsWith(`${botsDir}${sep}`)) {
    throw new Error('bot config path must live in the config home bots/ directory')
  }
  return resolved
}

/** Read, parse and validate one bot config file. Throws with every issue listed. */
export function loadBotConfig(configPath: string): BotConfig {
  const resolved = resolveBotConfigPath(configPath)
  const text = readFileSync(resolved, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`bot config ${resolved} is not valid JSON: ${reason}`)
  }
  const result = validateBotConfig(parsed)
  if (!result.ok) throw new Error(`bot config ${resolved} is invalid: ${result.issues.join('; ')}`)
  return result.config
}

/** sha256 of the config file text, stored on the bot so edits are detectable. */
export function botConfigHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Structural validation with defaults applied. Unknown keys are rejected, like
 * the daemon's other config validators, so a typo is an issue instead of a
 * silently ignored setting.
 */
export function validateBotConfig(value: unknown): BotConfigValidation {
  if (!isRecord(value)) return { ok: false, issues: ['config must be a JSON object'] }

  const issues: string[] = []
  pushUnknownKeys(issues, '', value, TOP_LEVEL_KEYS)

  const name = readString(issues, 'name', value.name, { required: true })
  const mode = readMode(issues, value.mode)
  const inbox = value.inbox === undefined
    ? { kind: 'workspace' as const }
    : validateAdapter(issues, 'inbox', value.inbox, { required: true, allowWorkspace: true })
  const notifier = validateAdapter(issues, 'notifier', value.notifier, { required: true })
  const projects = validateProjects(issues, value.projects)
  const routing = validateRouting(issues, value.routing)
  const quietHours = validateQuietHours(issues, 'quietHours', value.quietHours)

  const watchdogsRaw = readSection(issues, 'watchdogs', value.watchdogs, WATCHDOG_KEYS)
  const taskRunRaw = readSection(issues, 'watchdogs.taskRunMinutes', watchdogsRaw.taskRunMinutes, TASK_RUN_MINUTES_KEYS)
  const watchdogs: BotWatchdogs = {
    loadMaxActiveExecutions: readNumberOrDefault(issues, 'watchdogs.loadMaxActiveExecutions', watchdogsRaw.loadMaxActiveExecutions, DEFAULT_LOAD_MAX_ACTIVE_EXECUTIONS, { min: 1, integer: true }),
    queuedExecutionMinutes: readNumberOrDefault(issues, 'watchdogs.queuedExecutionMinutes', watchdogsRaw.queuedExecutionMinutes, DEFAULT_QUEUED_EXECUTION_MINUTES, { min: 0 }),
    taskRunMinutes: {
      verify: readNumberOrDefault(issues, 'watchdogs.taskRunMinutes.verify', taskRunRaw.verify, DEFAULT_TASK_RUN_MINUTES.verify, { min: 0 }),
      review: readNumberOrDefault(issues, 'watchdogs.taskRunMinutes.review', taskRunRaw.review, DEFAULT_TASK_RUN_MINUTES.review, { min: 0 }),
      accept: readNumberOrDefault(issues, 'watchdogs.taskRunMinutes.accept', taskRunRaw.accept, DEFAULT_TASK_RUN_MINUTES.accept, { min: 0 }),
    },
    sessionSilentMinutes: readNumberOrDefault(issues, 'watchdogs.sessionSilentMinutes', watchdogsRaw.sessionSilentMinutes, DEFAULT_SESSION_SILENT_MINUTES, { min: 0 }),
    tickLagWarnMs: readNumberOrDefault(issues, 'watchdogs.tickLagWarnMs', watchdogsRaw.tickLagWarnMs, DEFAULT_TICK_LAG_WARN_MS, { min: 0 }),
    componentCheckMinutes: readNumberOrDefault(issues, 'watchdogs.componentCheckMinutes', watchdogsRaw.componentCheckMinutes, DEFAULT_COMPONENT_CHECK_MINUTES, { min: 0 }),
  }

  const concurrencyRaw = readSection(issues, 'concurrency', value.concurrency, CONCURRENCY_KEYS)
  const concurrency: BotConcurrency = {
    maxActiveItems: readNumberOrDefault(issues, 'concurrency.maxActiveItems', concurrencyRaw.maxActiveItems, DEFAULT_MAX_ACTIVE_ITEMS, { min: 1, integer: true }),
    maxDispatchPerTick: readNumberOrDefault(issues, 'concurrency.maxDispatchPerTick', concurrencyRaw.maxDispatchPerTick, DEFAULT_MAX_DISPATCH_PER_TICK, { min: 1, integer: true }),
  }

  const cadenceRaw = readSection(issues, 'cadence', value.cadence, CADENCE_KEYS)
  const cadence: BotCadence = {
    tickSeconds: readNumberOrDefault(issues, 'cadence.tickSeconds', cadenceRaw.tickSeconds, DEFAULT_TICK_SECONDS, { min: MIN_TICK_SECONDS, integer: true }),
    pollMinutes: readNumberOrDefault(issues, 'cadence.pollMinutes', cadenceRaw.pollMinutes, DEFAULT_POLL_MINUTES, { min: MIN_POLL_MINUTES, integer: true }),
  }

  const budgetsRaw = readSection(issues, 'budgets', value.budgets, BUDGET_KEYS)
  const budgets: BotBudgets = {
    maxCorrections: readNumberOrDefault(issues, 'budgets.maxCorrections', budgetsRaw.maxCorrections, DEFAULT_MAX_CORRECTIONS, { min: 0, integer: true }),
    maxAcceptanceAttempts: readNumberOrDefault(issues, 'budgets.maxAcceptanceAttempts', budgetsRaw.maxAcceptanceAttempts, DEFAULT_MAX_ACCEPTANCE_ATTEMPTS, { min: 0, integer: true }),
    maxItemHours: readNumberOrDefault(issues, 'budgets.maxItemHours', budgetsRaw.maxItemHours, DEFAULT_MAX_ITEM_HOURS, { min: 0 }),
    maxItemsPerDay: readNumberOrDefault(issues, 'budgets.maxItemsPerDay', budgetsRaw.maxItemsPerDay, DEFAULT_MAX_ITEMS_PER_DAY, { min: 0, integer: true }),
  }

  if (issues.length > 0) return { ok: false, issues }
  if (name === undefined || inbox === undefined || notifier === undefined || projects === undefined || routing === undefined) {
    return { ok: false, issues: ['config is invalid'] }
  }
  return { ok: true, config: { name, mode, inbox, notifier, projects, routing, concurrency, cadence, ...(quietHours === undefined ? {} : { quietHours }), watchdogs, budgets } }
}

/**
 * True while `now` is inside the quiet-hours window, evaluated in the window's
 * own time zone. Windows whose `end` is earlier than their `start` cross
 * midnight.
 */
export function isInQuietHours(quiet: BotQuietHours, now: Date): boolean {
  const start = clockMinutes(quiet.start)
  const end = clockMinutes(quiet.end)
  if (start === end) return false
  const minutes = minutesInTimeZone(quiet.timeZone, now)
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

function clockMinutes(clock: string): number {
  if (!CLOCK_PATTERN.test(clock)) throw new Error(`quiet-hours time must be HH:MM: ${clock}`)
  const [hour, minute] = clock.split(':')
  return Number(hour) * 60 + Number(minute)
}

/** Minutes since local midnight in `timeZone`, from `Intl`, not the host zone. */
function minutesInTimeZone(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`could not read the local time in time zone ${timeZone}`)
  }
  return hour * 60 + minute
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function validateAdapter(
  issues: string[],
  path: string,
  value: unknown,
  options: { required?: boolean; allowWorkspace: true },
): BotAdapter | undefined
function validateAdapter(
  issues: string[],
  path: string,
  value: unknown,
  options?: { required?: boolean; allowWorkspace?: false },
): BotNotifierAdapter | undefined
function validateAdapter(
  issues: string[],
  path: string,
  value: unknown,
  options: { required?: boolean; allowWorkspace?: boolean } = {},
): BotAdapter | undefined {
  if (value === undefined) {
    if (options.required === true) issues.push(`${path} is required`)
    return undefined
  }
  if (!isRecord(value)) {
    issues.push(`${path} must be an adapter object`)
    return undefined
  }
  if (value.kind === 'workspace') {
    if (options.allowWorkspace !== true) {
      issues.push(`${path}.kind must be 'command' or 'mcp'`)
      return undefined
    }
    pushUnknownKeys(issues, path, value, WORKSPACE_ADAPTER_KEYS)
    return { kind: 'workspace' }
  }
  if (value.kind !== 'command' && value.kind !== 'mcp') {
    issues.push(`${path}.kind must be 'command' or 'mcp'${options.allowWorkspace === true ? " or 'workspace'" : ''}`)
    return undefined
  }

  const timeoutMs = readNumberOrDefault(issues, `${path}.timeoutMs`, value.timeoutMs, BOT_ADAPTER_DEFAULT_TIMEOUT_MS, {
    min: 1,
    max: BOT_ADAPTER_MAX_TIMEOUT_MS,
    integer: true,
  })

  if (value.kind === 'mcp') {
    pushUnknownKeys(issues, path, value, MCP_ADAPTER_KEYS)
    const tool = readString(issues, `${path}.tool`, value.tool, { required: true })
    if (!isRecord(value.server)) issues.push(`${path}.server must be an MCP server object`)
    if (tool === undefined || !isRecord(value.server)) return undefined
    return { kind: 'mcp', server: value.server, tool, timeoutMs }
  }

  pushUnknownKeys(issues, path, value, COMMAND_ADAPTER_KEYS)
  const argv = readArgv(issues, `${path}.argv`, value.argv)
  const cwd = readString(issues, `${path}.cwd`, value.cwd)
  const env = validateAdapterEnv(issues, `${path}.env`, value.env)
  if (argv === undefined || env === false) return undefined
  return { kind: 'command', argv, ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }), timeoutMs }
}

/** `argv` must name an executable and any arguments, with no shell involved. */
function readArgv(issues: string[], path: string, value: unknown): string[] | undefined {
  if (value === undefined) {
    issues.push(`${path} is required`)
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path} must be a non-empty array of strings`)
    return undefined
  }
  const argv: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      issues.push(`${path} must be a non-empty array of strings`)
      return undefined
    }
    argv.push(entry)
  }
  return argv
}

/** Returns the env map, `undefined` when absent, or `false` when invalid. */
function validateAdapterEnv(issues: string[], path: string, value: unknown): Record<string, string> | undefined | false {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    issues.push(`${path} must be an object of strings`)
    return false
  }
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      issues.push(`${path}.${key} must be a string`)
      return false
    }
    env[key] = entry
  }
  return env
}

function validateProjects(issues: string[], value: unknown): BotProjectPolicy[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push('projects must be a non-empty array')
    return undefined
  }
  const projects: BotProjectPolicy[] = []
  let ok = true
  value.forEach((entry, index) => {
    const path = `projects[${index}]`
    if (!isRecord(entry)) {
      issues.push(`${path} must be an object`)
      ok = false
      return
    }
    pushUnknownKeys(issues, path, entry, PROJECT_KEYS)
    const id = readString(issues, `${path}.id`, entry.id, { required: true })
    const match = entry.match === undefined ? [] : readStringArray(issues, `${path}.match`, entry.match)
    const release = validateRelease(issues, `${path}.release`, entry.release)
    if (id === undefined || match === undefined || release === undefined) {
      ok = false
      return
    }
    projects.push({
      id,
      match,
      merge: readBoolean(issues, `${path}.merge`, entry.merge, false),
      push: readBoolean(issues, `${path}.push`, entry.push, false),
      release,
    })
  })
  return ok ? projects : undefined
}

function validateRelease(issues: string[], path: string, value: unknown): { enabled: boolean } | undefined {
  if (value === undefined) return { enabled: false }
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`)
    return undefined
  }
  pushUnknownKeys(issues, path, value, ['enabled'])
  return { enabled: readBoolean(issues, `${path}.enabled`, value.enabled, false) }
}

function validateRouting(issues: string[], value: unknown): BotRouting | undefined {
  if (!isRecord(value)) {
    issues.push('routing must be an object')
    return undefined
  }
  const routing: Record<string, BotRoutingEntry> = {}
  let ok = true
  for (const [className, entry] of Object.entries(value)) {
    const path = `routing.${className}`
    if (className.trim() === '') {
      issues.push('routing keys must be non-empty item class names')
      ok = false
      continue
    }
    if (!isRecord(entry)) {
      issues.push(`${path} must be an object`)
      ok = false
      continue
    }
    pushUnknownKeys(issues, path, entry, ROUTING_ENTRY_KEYS)
    const provider = readString(issues, `${path}.provider`, entry.provider, { required: true })
    const model = readString(issues, `${path}.model`, entry.model, { required: true })
    const reasoningEffort = readReasoningEffort(issues, `${path}.reasoningEffort`, entry.reasoningEffort)
    const target = readRunTarget(issues, `${path}.target`, entry.target)
    if (provider === undefined || model === undefined || reasoningEffort === undefined) {
      ok = false
      continue
    }
    routing[className] = { provider, model, reasoningEffort, ...(target === undefined ? {} : { target }) }
  }
  for (const required of REQUIRED_ROUTING_CLASSES) {
    if (!(required in value)) {
      issues.push(`routing.${required} is required`)
      ok = false
    }
  }
  return ok ? (routing as BotRouting) : undefined
}

function readReasoningEffort(issues: string[], path: string, value: unknown): ReasoningEffort | undefined {
  if (value === undefined) {
    issues.push(`${path} is required`)
    return undefined
  }
  if (typeof value !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
    issues.push(`${path} must be one of ${REASONING_EFFORTS.join(', ')}`)
    return undefined
  }
  return value as ReasoningEffort
}

/**
 * Optional canonical run target `<provider>/<model>:<client>`, validated with
 * the same parser the task dispatcher uses, so a routing entry can only name a
 * target the daemon could actually select.
 */
function readRunTarget(issues: string[], path: string, value: unknown): string | undefined {
  const target = readString(issues, path, value)
  if (target === undefined) return undefined
  try {
    parseRunSyntax(target)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    issues.push(`${path} must be a run target like <provider>/<model>:<client> (${reason})`)
    return undefined
  }
  return target
}

function validateQuietHours(issues: string[], path: string, value: unknown): BotQuietHours | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`)
    return undefined
  }
  pushUnknownKeys(issues, path, value, QUIET_HOURS_KEYS)
  const timeZone = readString(issues, `${path}.timeZone`, value.timeZone, { required: true })
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
    issues.push(`${path}.timeZone must be a valid IANA time zone`)
  }
  const start = readClock(issues, `${path}.start`, value.start)
  const end = readClock(issues, `${path}.end`, value.end)
  const defer = value.defer === undefined
    ? DEFAULT_QUIET_HOURS_DEFER
    : readStringArray(issues, `${path}.defer`, value.defer, { allowEmpty: true })
  if (timeZone === undefined || start === undefined || end === undefined || defer === undefined) return undefined
  return { timeZone, start, end, defer }
}

function readClock(issues: string[], path: string, value: unknown): string | undefined {
  if (value === undefined) {
    issues.push(`${path} is required`)
    return undefined
  }
  if (typeof value !== 'string' || !CLOCK_PATTERN.test(value)) {
    issues.push(`${path} must be an HH:MM local time`)
    return undefined
  }
  return value
}

/** One optional config section; unknown keys inside it are issues. */
function readSection(
  issues: string[],
  path: string,
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`)
    return {}
  }
  pushUnknownKeys(issues, path, value, keys)
  return value
}

function readMode(issues: string[], value: unknown): BotConfigMode {
  if (value === undefined) return 'dryRun'
  if (value === 'live' || value === 'dryRun') return value
  issues.push("mode must be 'live' or 'dryRun'")
  return 'dryRun'
}

function readString(
  issues: string[],
  path: string,
  value: unknown,
  options: { required?: boolean } = {},
): string | undefined {
  if (value === undefined) {
    if (options.required === true) issues.push(`${path} is required`)
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${path} must be a non-empty string`)
    return undefined
  }
  return value.trim()
}

function readStringArray(
  issues: string[],
  path: string,
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of non-empty strings`)
    return undefined
  }
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(`${path} must be an array of non-empty strings`)
      return undefined
    }
    entries.push(entry.trim())
  }
  if (entries.length === 0 && options.allowEmpty !== true) {
    issues.push(`${path} must not be empty`)
    return undefined
  }
  return entries
}

function readBoolean(issues: string[], path: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    issues.push(`${path} must be true or false`)
    return fallback
  }
  return value
}

function readBoundedNumber(
  issues: string[],
  path: string,
  value: unknown,
  options: { min: number; max?: number; integer?: boolean },
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${path} must be a number`)
    return undefined
  }
  if (options.integer === true && !Number.isInteger(value)) {
    issues.push(`${path} must be an integer`)
    return undefined
  }
  if (value < options.min) {
    issues.push(`${path} must be at least ${options.min}`)
    return undefined
  }
  if (options.max !== undefined && value > options.max) {
    issues.push(`${path} must be at most ${options.max}`)
    return undefined
  }
  return value
}

function readNumberOrDefault(
  issues: string[],
  path: string,
  value: unknown,
  fallback: number,
  options: { min: number; max?: number; integer?: boolean },
): number {
  if (value === undefined) return fallback
  return readBoundedNumber(issues, path, value, options) ?? fallback
}

function pushUnknownKeys(
  issues: string[],
  path: string,
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) issues.push(`${path === '' ? '' : `${path}.`}${key} is not a supported key`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
