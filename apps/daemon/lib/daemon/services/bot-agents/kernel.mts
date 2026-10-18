/**
 * Bot agent kernel.
 *
 * A bot is an LLM agent assembled from one JSON config file. The kernel owns
 * everything around it: immediate message delivery, the watches that wake a
 * bot when a work session finishes a turn, the rounds a routine fire opens,
 * and the persisted state that lets admission survive a daemon restart. Bots
 * run concurrently and know nothing about each other
 * except the `message` tool.
 *
 * Each bot talks to its own context: a private session engine rooted in the
 * kernel's own state directory, so a bot conversation never appears in the
 * workspace session list. The reason turn runs on the host's agent tool port,
 * which is what makes the bot a tool-using agent rather than a work session.
 *
 * Nothing here throws out of the daemon: a failed config disables one bot, a
 * failed model call is recorded on that bot, and a failed wake is dropped.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSession,
  estimateTokens,
  type AgentToolPort,
  type LedgerEvent,
  type Session,
  type SessionHost,
  type SessionSummary,
  type TurnStatus,
} from '@wrenyard/session'
import type { RoutineDeliver, RoutineRecord } from '../../../protocol/methods/routine.mts'
import type { Scheduler } from '../scheduler.mts'
import type { WorkspaceTodoService } from '../workspace-todo-service.mts'
import { loadBotAgentConfigs, type BotAgentConfig, type BotAgentEntry } from './config.mts'
import { TurnAnswerIndex } from './turn-answer.mts'
import {
  agentToolSpecs,
  createAgentToolRunner,
  isDenied,
  type AgentModelRoute,
  type AgentToolContext,
} from './tools.mts'

export type { AgentModelRoute } from './tools.mts'

/** How many tool calls one bot turn may make before the port refuses more. */
const MAX_TOOL_CALLS = 24
/** How long one bot turn may run before it is interrupted. */
const TURN_TIMEOUT_MS = 20 * 60_000
/** How long an interrupted turn may take to settle before the wake gives up. */
const INTERRUPT_GRACE_MS = 60_000
/** How often the config directory is polled for new, changed or removed files. */
const CONFIG_POLL_MS = 5_000

/** Where a wake came from; it decides the tag the bot reads in the text. */
type WakeSource = 'user' | 'routine' | 'session' | 'message'

/** One queued wakeup of one bot. */
interface Wake {
  id: string
  botId: string
  source: WakeSource
  /** The exact text the bot turn is started with. */
  text: string
  /** The round this wake belongs to, when a routine opened one. */
  round?: string
  /** The routine that fired this wake, read by the per-routine busy gate. */
  routineId?: string
  createdAt: string
}

/** One watched work session: its next finished turn after `afterTurn` wakes the bot. */
interface Watch {
  sessionId: string
  botId: string
  afterTurn: number
  round?: string
  /** Workspace todo ids this session works on, kept so a context rotation can recover them. */
  todoIds?: string[]
}

/** One routine round: every wake and watch it started inherits its delivery. */
interface Round {
  botId: string
  routineId: string
  deliver: RoutineDeliver
  /** Turns to which this round has been admitted. */
  turns?: { sessionId: string; turn: number }[]
  /** The round's last final reply, delivered to `deliver` when the round closes. */
  lastReply?: string
}

/** One bot's persisted runtime state. */
interface BotState {
  /** Ledger session of this bot's private context. */
  sessionId?: string
  /** Wakes awaiting session.send admission; admitted messages live in the ledger. */
  queue: Wake[]
  lastWakeAt?: string
  lastError?: string
}

/** Everything the kernel persists in one file. */
interface KernelState {
  version: 1
  bots: Record<string, BotState>
  watches: Watch[]
  rounds: Record<string, Round>
}

/** One finished turn as the kernel reads it back from a ledger. */
interface TurnOutcome {
  turn: number
  status: TurnStatus
  error?: string
}

interface TrackedTurn {
  sessionId: string
  turn: number
  botId: string
  handlers: Set<(outcome: TurnOutcome) => void>
  timer?: ReturnType<typeof setTimeout>
  unsubscribe?: () => void
}

export interface AgentBotSummary {
  id: string
  name: string
  enabled: boolean
  status: 'idle' | 'running' | 'error' | 'disabled'
  error?: string
  configPath: string
  tools: string[]
  lastWakeAt?: string
  queued: number
  sessionId?: string
}

/** A refused bot operation; the code is what the protocol maps to a status. */
export class BotAgentError extends Error {
  constructor(readonly code: 'agent_not_found' | 'agent_disabled' | 'agent_invalid', message: string) {
    super(message)
    this.name = 'BotAgentError'
  }
}

export interface CreateBotAgentKernelOptions {
  workspaceRoot: string
  /** `<config root>/bot-agents`: one `<id>.json` per bot. */
  configDir: string
  /** `<state root>/bot-agents/<sha256(workspaceRoot)>`: state and bot ledgers. */
  stateDir: string
  /** The daemon session host; the kernel derives its private bot host from it. */
  host: SessionHost
  /** The workspace session service the `session` tool and the watches use. */
  sessions: Session
  todos: WorkspaceTodoService
  /** The routine store, used only to reconcile config-declared routines. */
  routines: Pick<Scheduler, 'reconcile'>
  /** The ranked high-intelligence routes a bot may run on, best first. */
  selectModels(): Promise<readonly AgentModelRoute[]>
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface BotAgentKernel {
  start(): Promise<void>
  stop(): Promise<void>
  list(): AgentBotSummary[]
  get(id: string): { bot: AgentBotSummary; config: string }
  context(id: string): { session: Session; sessionId: string } | undefined
  wake(id: string, text: string): { queued: number }
  /** Drop every watch of one session, in memory and in the persisted state. */
  removeWatches(sessionId: string): void
  wakeRoutine(routine: RoutineRecord): Promise<void>
  routineBusy(routine: RoutineRecord): boolean
}

/** The fixed instruction prefix every bot runs on, before its config text. */
function botSystemPrompt(config: BotAgentConfig): string {
  const fixed = [
    `You are the Wrenyard bot "${config.name}" (${config.id}).`,
    'You are driven by messages: routine triggers, user input, other bots\' messages and work-session updates.',
    'One message may carry several [wake:user], [wake:routine <id>], [wake:session <sessionId> <status>] or [wake:message from <bot>] entries; handle every one of them in this turn.',
    'Your only levers are the bot tools (session list/create/send/interrupt, todo, message).',
    'You never run code, searches, documents or tasks yourself; you delegate them to work sessions in natural language.',
    'You have no file or shell access; with no tools, answer in text only.',
  ].join(' ')
  return `${fixed}\n\n${config.instructions}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The context-input threshold above which a bot's own conversation rotates to a
 * fresh session. It is the smaller of a fixed 100k ceiling and half the
 * smallest finite positive context window among the routes a wake may run on
 * (the primary and the single fallback runWake tries), so a route is always
 * left enough room for its own output. A route with no resolved window falls
 * back to the 100k ceiling.
 */
function rotationThreshold(routes: readonly AgentModelRoute[]): number {
  const windows = routes
    .map(route => route.contextWindow)
    .filter((window): window is number => typeof window === 'number' && window > 0)
  const limit = windows.length > 0 ? Math.floor(0.5 * Math.min(...windows)) : 100_000
  return Math.min(100_000, limit)
}

/** The output-token reservation one route needs beside the estimated input. */
function outputReservation(route: AgentModelRoute): number {
  const max = typeof route.maxOutputTokens === 'number' && route.maxOutputTokens > 0 ? route.maxOutputTokens : undefined
  return Math.min(8_192, max ?? 8_192)
}

/**
 * Whether one route's context window can hold the estimated input plus its
 * output reservation. An unknown window or an unknown estimate never disqualifies
 * a route; only a window that is provably too small does.
 */
function routeFits(route: AgentModelRoute, estimatedInput: number | undefined): boolean {
  if (route.contextWindow === undefined || estimatedInput === undefined) return true
  return route.contextWindow >= estimatedInput + outputReservation(route)
}

function emptyState(): KernelState {
  return { version: 1, bots: {}, watches: [], rounds: {} }
}

function readWake(value: unknown): Wake | undefined {
  if (!isPlainObject(value)) return undefined
  const { id, botId, text, source } = value
  if (typeof id !== 'string' || typeof botId !== 'string' || typeof text !== 'string') return undefined
  if (source !== 'user' && source !== 'routine' && source !== 'session' && source !== 'message') return undefined
  return {
    id,
    botId,
    source,
    text,
    ...(typeof value.round === 'string' ? { round: value.round } : {}),
    ...(typeof value.routineId === 'string' ? { routineId: value.routineId } : {}),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  }
}

function readWatch(value: unknown): Watch | undefined {
  if (!isPlainObject(value)) return undefined
  const { sessionId, botId, afterTurn } = value
  if (typeof sessionId !== 'string' || typeof botId !== 'string' || typeof afterTurn !== 'number') return undefined
  const watch: Watch = { sessionId, botId, afterTurn, ...(typeof value.round === 'string' ? { round: value.round } : {}) }
  if (Array.isArray(value.todoIds)) {
    const ids = value.todoIds.filter((id): id is string => typeof id === 'string')
    if (ids.length > 0) watch.todoIds = ids
  }
  return watch
}

function readRound(value: unknown): Round | undefined {
  if (!isPlainObject(value)) return undefined
  const { botId, routineId, deliver } = value
  if (typeof botId !== 'string' || typeof routineId !== 'string' || typeof deliver !== 'string') return undefined
  const turns = Array.isArray(value.turns)
    ? value.turns.filter((turn): turn is { sessionId: string; turn: number } =>
      isPlainObject(turn) && typeof turn.sessionId === 'string' && typeof turn.turn === 'number')
    : []
  return {
    botId,
    routineId,
    deliver: deliver as RoutineDeliver,
    ...(turns.length === 0 ? {} : { turns }),
    ...(typeof value.lastReply === 'string' ? { lastReply: value.lastReply } : {}),
  }
}

/** Read a persisted kernel file, dropping every entry that no longer parses. */
function parseState(raw: string): KernelState {
  const state = emptyState()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return state
  }
  if (!isPlainObject(parsed)) return state
  if (isPlainObject(parsed.bots)) {
    for (const [id, value] of Object.entries(parsed.bots)) {
      if (!isPlainObject(value)) continue
      const queue = Array.isArray(value.queue)
        ? value.queue.map(readWake).filter((wake): wake is Wake => wake !== undefined)
        : []
      // One-shot migration of a legacy HEAD `inflight` entry: replay it only
      // while its raw attempts are below HEAD's replay cap of 2.
      if (isPlainObject(value.inflight)) {
        const attempts = typeof value.inflight.attempts === 'number' ? value.inflight.attempts : 0
        const inflight = readWake(value.inflight)
        if (attempts < 2 && inflight !== undefined && !queue.some(wake => wake.id === inflight.id)) {
          queue.unshift(inflight)
        }
      }
      state.bots[id] = {
        queue,
        ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
        ...(typeof value.lastWakeAt === 'string' ? { lastWakeAt: value.lastWakeAt } : {}),
        ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
      }
    }
  }
  if (Array.isArray(parsed.watches)) {
    for (const value of parsed.watches) {
      const watch = readWatch(value)
      if (watch !== undefined) state.watches.push(watch)
    }
  }
  if (isPlainObject(parsed.rounds)) {
    for (const [id, value] of Object.entries(parsed.rounds)) {
      const round = readRound(value)
      if (round !== undefined) state.rounds[id] = round
    }
  }
  return state
}

/**
 * `turn.finished` of exactly one turn of one ledger, if it is already recorded.
 * Matching one exact turn keeps a watch, and a sent turn, from settling on a
 * different turn that happened to finish first.
 */
function finishedTurnOf(session: Session, sessionId: string, turn: number): TurnOutcome | undefined {
  for (const event of session.readLedger(sessionId)) {
    if (event.type !== 'turn.finished' || event.turn !== turn) continue
    return {
      turn,
      status: event.status,
      ...(event.error === undefined ? {} : { error: event.error }),
    }
  }
  return undefined
}

/**
 * The answer one exact turn of one ledger ended on, as the shared index reads
 * it: the turn's closing reply, else the worker output of its terminal
 * reasoning step, else its last published reply.
 */
function turnAnswerOf(session: Session, sessionId: string, turn: number): string | undefined {
  const index = new TurnAnswerIndex()
  // Every content event carries its own `turn`; no turn cursor is tracked.
  for (const event of session.readLedger(sessionId)) index.feed(event)
  return index.answerOf(turn)
}

export function createBotAgentKernel(options: CreateBotAgentKernelOptions): BotAgentKernel {
  const log = options.log
  const statePath = join(options.stateDir, 'kernel.json')
  const state = emptyState()
  /** Config files as last applied, by id. */
  const entries = new Map<string, BotAgentEntry>()
  /** `path -> mtimeMs` of the last applied load, for the 5 second poll. */
  let appliedMtimes = new Map<string, number>()
  /** Wakes currently resolving session.send admission, awaited only at shutdown. */
  const admissions = new Set<Promise<void>>()
  /** Avoid dispatching the same persisted pending wake twice in this process. */
  const admitting = new Set<string>()
  /** Active context turns used for status and routine watch association. */
  const activeTurns = new Map<string, Set<number>>()
  const trackedTurns = new Map<string, TrackedTurn>()
  /** Pending seed-turn waits, settled by stop() before it awaits admissions. */
  const seedWaits = new Set<() => void>()
  const turnRounds = new Map<string, Set<string>>()
  /** Live ledger subscriptions, keyed by bot and watched session. */
  const watchSubs = new Map<string, () => void>()
  const runTools = createAgentToolRunner({ sessions: options.sessions, todos: options.todos })
  let context: Session | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let persistChain: Promise<void> = Promise.resolve()
  let stopPromise: Promise<void> | undefined
  let started = false
  let stopped = false

  // ─── Services ────────────────────────────────────────────────────────────

  /**
   * The bot context host: the daemon session host with every member forwarded
   * under its own `this`, except that bot ledgers live in the kernel state
   * directory and only a bot's own sessions run on that bot's tool port.
   */
  const botHost: SessionHost = new Proxy(options.host, {
    get(target, property) {
      if (property === 'stateRoot') return options.stateDir
      if (property === 'agentTools') return (sessionId: string) => portForSession(sessionId)
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })

  function contextSession(): Session {
    if (context === undefined) context = createSession(botHost)
    return context
  }

  /** The tool port of the bot owning one context session, if any. */
  function portForSession(sessionId: string): AgentToolPort | undefined {
    for (const [botId, bot] of Object.entries(state.bots)) {
      if (bot.sessionId === sessionId) return portFor(botId)
    }
    return undefined
  }

  function portFor(botId: string): AgentToolPort | undefined {
    const config = entries.get(botId)?.config
    if (config === undefined) return undefined
    return {
      system: botSystemPrompt(config),
      tools: agentToolSpecs(config.tools),
      maxToolCalls: MAX_TOOL_CALLS,
      // The invoking context session and turn decide which routine round a
      // watch inherits; a turn admitted before a rotation keeps its own round.
      run: (call, ctx) => runTools(call, toolContext(botId, ctx.sessionId, ctx.turn)),
    }
  }

  function turnKey(sessionId: string, turn: number): string {
    return `${sessionId}\n${turn}`
  }

  /**
   * The per-call context of one bot tool call. `invokingSessionId` and
   * `invokingTurn` identify the bot context turn that invoked the call,
   * reported by the port host; a watch created here inherits that turn's
   * routine round, even after a rotation moved the bot to a new session.
   */
  function toolContext(botId: string, invokingSessionId?: string, invokingTurn?: number): AgentToolContext {
    return {
      botId,
      denyModels: entries.get(botId)?.config?.denyModels ?? [],
      watch: (sessionId, afterTurn, todoIds) =>
        addWatch(botId, sessionId, afterTurn, todoIds, invokingSessionId, invokingTurn),
      message: (to, text) => sendMessage(botId, to, text),
      removeWatches: sessionId => removeWatches(sessionId),
      selectModels: () => options.selectModels(),
    }
  }

  // ─── State helpers ───────────────────────────────────────────────────────

  function ensureBotState(botId: string): BotState {
    const existing = state.bots[botId]
    if (existing !== undefined) return existing
    const created: BotState = { queue: [] }
    state.bots[botId] = created
    return created
  }

  /** The configured, enabled bot, or the error the caller must surface. */
  function requireBot(id: string): BotAgentEntry {
    const entry = entries.get(id)
    if (entry === undefined) throw new BotAgentError('agent_not_found', `unknown bot: ${id}`)
    if (entry.config === undefined) throw new BotAgentError('agent_invalid', `bot ${id} has an invalid config`)
    if (!entry.config.enabled) throw new BotAgentError('agent_disabled', `bot ${id} is disabled`)
    return entry
  }

  function summaryOf(entry: BotAgentEntry): AgentBotSummary {
    const config = entry.config
    const bot = state.bots[entry.id]
    const error = entry.error ?? bot?.lastError
    let status: AgentBotSummary['status']
    if (config !== undefined && !config.enabled) status = 'disabled'
    else if (config === undefined || bot?.lastError !== undefined) status = 'error'
    else if (bot?.sessionId !== undefined && (activeTurns.get(entry.id)?.size ?? 0) > 0) status = 'running'
    else status = 'idle'
    return {
      id: entry.id,
      name: config?.name ?? entry.id,
      enabled: config?.enabled === true,
      status,
      ...(error === undefined ? {} : { error }),
      configPath: entry.path,
      tools: config?.tools ?? [],
      ...(bot?.lastWakeAt === undefined ? {} : { lastWakeAt: bot.lastWakeAt }),
      queued: bot?.queue.length ?? 0,
      ...(bot?.sessionId === undefined ? {} : { sessionId: bot.sessionId }),
    }
  }

  function enqueue(
    botId: string,
    input: { source: WakeSource; text: string; round?: string; routineId?: string },
  ): Wake {
    const wake: Wake = {
      id: randomUUID(),
      botId,
      source: input.source,
      text: input.text,
      createdAt: new Date().toISOString(),
      ...(input.round === undefined ? {} : { round: input.round }),
      ...(input.routineId === undefined ? {} : { routineId: input.routineId }),
    }
    ensureBotState(botId).queue.push(wake)
    return wake
  }

  function persist(): void {
    const payload = JSON.stringify(state)
    const write = async (): Promise<void> => {
      await mkdir(options.stateDir, { recursive: true })
      const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(tempPath, payload, 'utf-8')
        await rename(tempPath, statePath)
      } catch (error) {
        await unlink(tempPath).catch(() => {})
        throw error
      }
    }
    // One serialized write chain: two persists never interleave, and a failed
    // write is logged rather than thrown into a wake.
    persistChain = persistChain.then(write, write).catch(error => {
      log('error', `bot agent kernel failed to persist ${statePath}: ${errorText(error)}`)
    })
  }

  // ─── Watches ─────────────────────────────────────────────────────────────

  function watchKey(botId: string, sessionId: string): string {
    return `${botId}\n${sessionId}`
  }

  function subscribeWatch(botId: string, sessionId: string): void {
    const key = watchKey(botId, sessionId)
    if (watchSubs.has(key)) return
    watchSubs.set(key, options.sessions.subscribe(sessionId, event => { onWatchedTurn(botId, sessionId, event) }))
  }

  /** Drop the subscription once no watch of that bot and session is left. */
  function releaseWatch(botId: string, sessionId: string): void {
    if (state.watches.some(watch => watch.botId === botId && watch.sessionId === sessionId)) return
    const key = watchKey(botId, sessionId)
    const unsubscribe = watchSubs.get(key)
    if (unsubscribe === undefined) return
    unsubscribe()
    watchSubs.delete(key)
  }

  function addWatch(
    botId: string,
    sessionId: string,
    afterTurn: number,
    todoIds?: readonly string[],
    invokingSessionId?: string,
    invokingTurn?: number,
  ): void {
    // The round is the one of the session and turn that actually ran the tool
    // call; a turn still running on a pre-rotation session keeps its round.
    const rounds = invokingSessionId === undefined || invokingTurn === undefined
      ? undefined
      : turnRounds.get(turnKey(invokingSessionId, invokingTurn))
    // A re-watch of a session the bot already follows keeps the prior todo
    // association when the caller omits one, so rotation recovery is stable.
    const inherited = todoIds === undefined
      ? state.watches.find(watch => watch.botId === botId && watch.sessionId === sessionId && watch.todoIds !== undefined)
      : undefined
    // At most one pending watch per bot and session: a new send supersedes the
    // earlier watch, so only the newest sent turn can wake the bot.
    const superseded = state.watches.filter(watch => watch.botId === botId && watch.sessionId === sessionId)
    state.watches = state.watches.filter(watch => watch.botId !== botId || watch.sessionId !== sessionId)
    const ownRound = rounds !== undefined && rounds.size > 0 ? [...rounds][0] : undefined
    const lastSuperseded = superseded.length > 0 ? superseded[superseded.length - 1] : undefined
    const round = ownRound ?? lastSuperseded?.round
    const next: Watch = { sessionId, botId, afterTurn, ...(round === undefined ? {} : { round }) }
    if (todoIds !== undefined && todoIds.length > 0) next.todoIds = [...todoIds]
    else if (inherited !== undefined) next.todoIds = inherited.todoIds
    state.watches.push(next)
    subscribeWatch(botId, sessionId)
    persist()
  }

  /**
   * Drop every watch of one session, whoever created it. Removing the records
   * also releases the ledger subscription, so a session about to be stopped can
   * no longer wake a bot.
   */
  function removeWatches(sessionId: string): void {
    const removed = state.watches.filter(watch => watch.sessionId === sessionId)
    if (removed.length === 0) return
    state.watches = state.watches.filter(watch => watch.sessionId !== sessionId)
    for (const watch of removed) releaseWatch(watch.botId, sessionId)
    persist()
  }

  function onWatchedTurn(botId: string, sessionId: string, event: LedgerEvent): void {
    if (event.type !== 'turn.finished') return
    const turn = event.turn
    if (turn === undefined) return
    // A watch matches exactly the turn after `afterTurn`; any other finish
    // leaves the watch in place.
    const index = state.watches.findIndex(watch =>
      watch.botId === botId && watch.sessionId === sessionId && watch.afterTurn + 1 === turn)
    if (index < 0) return
    const watch = state.watches[index]
    state.watches.splice(index, 1)
    releaseWatch(botId, sessionId)
    const reply = turnAnswerOf(options.sessions, sessionId, turn)
    const wake = enqueue(botId, {
      source: 'session',
      text: `[wake:session ${sessionId} ${event.status}] ${reply ?? ''}`,
      ...(watch.round === undefined ? {} : { round: watch.round }),
    })
    persist()
    dispatchWake(botId, wake)
  }

  // ─── Context rotation ────────────────────────────────────────────────

  /**
   * Estimate the token size of one bot context session's next main-reasoning
   * view, using the inspection instrument the session feature exposes, plus the
   * pending wake text the next turn will actually send on top of it. A failed
   * inspect is reported as unknown rather than blocking a wake.
   */
  async function estimateInput(sessionId: string, modelId: string, wakeText?: string): Promise<number | undefined> {
    try {
      const inspection = await contextSession().inspectContext({ sessionId, model: modelId })
      if (wakeText === undefined || wakeText === '') return inspection.totalTokens
      // The next turn sends the wake text on top of the inspected prompt
      // layers; add its token cost with the same o200k estimator the session
      // feature uses, so a large wake can never overflow an admitted route's
      // window.
      return inspection.totalTokens + estimateTokens(wakeText)
    } catch (error) {
      log('warn', `bot agent kernel could not inspect context of session ${sessionId}: ${errorText(error)}`)
      return undefined
    }
  }

  /** The first user message of one workspace session, bounded for a projection. */
  function shortBriefOf(sessionId: string): string {
    try {
      for (const event of options.sessions.readLedger(sessionId)) {
        if (event.type !== 'turn.started' || typeof event.text !== 'string') continue
        return event.text.length <= 200 ? event.text : `${event.text.slice(0, 200)}…`
      }
    } catch {
      // The session may be gone; fall through to the unavailable marker.
    }
    return '(brief unavailable)'
  }

  /** A bounded title/request summary of one workspace todo, when it still exists. */
  async function todoBriefOf(todoId: string): Promise<string | undefined> {
    try {
      const todo = await options.todos.getTodo(todoId)
      const base = todo.title ?? todoId
      const request = typeof todo.request === 'string' && todo.request !== '' ? ` — ${todo.request}` : ''
      const text = `${base}${request}`
      return text.length <= 200 ? text : `${text.slice(0, 200)}…`
    } catch {
      return undefined
    }
  }

  /**
   * Seed a freshly rotated bot context with a compact, deterministic projection
   * of the work still in flight: every session the bot watches, its associated
   * todo ids and a bounded original brief of each. Nothing is deleted or
   * archived — the old context ledger, the watches, rounds, routines and queued
   * wakes all remain; only the bot's own context pointer moves.
   */
  async function seedRotatedContext(newSessionId: string, route: AgentModelRoute, botId: string): Promise<void> {
    const lines = [
      '[context-rotation] This is a fresh context session. The following work is still in progress and being watched; continue it as before.',
    ]
    for (const watch of state.watches.filter(watch => watch.botId === botId)) {
      const todoIds = watch.todoIds ?? []
      const todoText = todoIds.length > 0 ? ` (todos: ${todoIds.join(', ')})` : ''
      lines.push(`- session ${watch.sessionId}${todoText}: ${shortBriefOf(watch.sessionId)}`)
      for (const todoId of todoIds) {
        const brief = await todoBriefOf(todoId)
        if (brief !== undefined) lines.push(`  - todo ${todoId}: ${brief}`)
      }
    }
    try {
      const { turn } = await contextSession().send(newSessionId, { text: lines.join('\n'), model: route })
      await new Promise<void>(resolve => {
        const settle = (): void => {
          if (!seedWaits.delete(settle)) return
          resolve()
        }
        seedWaits.add(settle)
        trackTurn(botId, newSessionId, turn, settle)
      })
    } catch (error) {
      log('warn', `bot agent kernel could not seed rotated context for bot ${botId}: ${errorText(error)}`)
    }
  }

  // ─── Rounds ──────────────────────────────────────────────────────────────

  /** Close a round once nothing of it is left, and deliver its final reply. */
  function closeRound(roundId: string): void {
    const round = state.rounds[roundId]
    if (round === undefined) return
    if (state.watches.some(watch => watch.round === roundId)) return
    const bot = state.bots[round.botId]
    if ((round.turns?.length ?? 0) > 0 || bot?.queue.some(wake => wake.round === roundId)) return
    // The target's wake is enqueued before the round is dropped, so the delivery
    // and the round removal reach the file in one transition. A target that
    // cannot be woken is reported as an error: its reply is never silently lost
    // and no delivery is fabricated.
    let delivery: Wake | undefined
    if (round.deliver !== 'none') {
      const reply = round.lastReply
      if (reply === undefined || reply === '') {
        log('warn', `bot agent round ${roundId} of bot ${round.botId} closed without a reply to deliver to ${round.deliver}`)
      } else {
        try {
          const target = round.deliver.slice('bot:'.length)
          delivery = enqueueMessage(round.botId, target, reply)
        } catch (error) {
          log('error', `bot agent round ${roundId} could not deliver its reply to ${round.deliver}: ${errorText(error)}`)
        }
      }
    }
    delete state.rounds[roundId]
    persist()
    if (delivery !== undefined) dispatchWake(delivery.botId, delivery)
  }

  /** Enqueue one message wake on the target bot; throws unless it is runnable. */
  function enqueueMessage(from: string, to: string, text: string): Wake {
    if (to === from) throw new BotAgentError('agent_invalid', 'a bot cannot message itself')
    requireBot(to)
    return enqueue(to, { source: 'message', text: `[wake:message from ${from}] ${text}` })
  }

  function sendMessage(from: string, to: string, text: string): void {
    const wake = enqueueMessage(from, to, text)
    persist()
    dispatchWake(to, wake)
  }

  // ─── Turn loop ───────────────────────────────────────────────────────────

  /** Create the bot's context ledger session on first use and persist its id. */
  async function ensureContext(botId: string): Promise<string> {
    const bot = ensureBotState(botId)
    if (bot.sessionId !== undefined) return bot.sessionId
    const { sessionId } = await contextSession().createSession()
    bot.sessionId = sessionId
    persist()
    return sessionId
  }

  function trackTurn(
    botId: string,
    sessionId: string,
    turn: number,
    onFinished: (outcome: TurnOutcome) => void,
  ): void {
    const key = turnKey(sessionId, turn)
    const existing = trackedTurns.get(key)
    if (existing !== undefined) {
      existing.handlers.add(onFinished)
      return
    }
    const tracked: TrackedTurn = { sessionId, turn, botId, handlers: new Set([onFinished]) }
    const settle = (outcome: TurnOutcome): void => {
      if (trackedTurns.get(key) !== tracked) return
      trackedTurns.delete(key)
      if (tracked.timer !== undefined) clearTimeout(tracked.timer)
      tracked.unsubscribe?.()
      const turns = activeTurns.get(botId)
      turns?.delete(turn)
      if (turns?.size === 0) activeTurns.delete(botId)
      for (const handler of tracked.handlers) handler(outcome)
    }
    tracked.unsubscribe = contextSession().subscribe(sessionId, event => {
      if (event.type !== 'turn.finished' || event.turn !== turn) return
      settle({
        turn,
        status: event.status,
        ...(event.error === undefined ? {} : { error: event.error }),
      })
    })
    trackedTurns.set(key, tracked)
    const turns = activeTurns.get(botId) ?? new Set<number>()
    turns.add(turn)
    activeTurns.set(botId, turns)
    const recorded = finishedTurnOf(contextSession(), sessionId, turn)
    if (recorded !== undefined) {
      settle(recorded)
      return
    }
    if (trackedTurns.get(key) !== tracked) return
    tracked.timer = setTimeout(() => {
      void contextSession().interrupt(sessionId, turn).catch(error => {
        log('warn', `bot agent could not interrupt turn ${turn} of session ${sessionId}: ${errorText(error)}`)
      })
      tracked.timer = setTimeout(() => {
        settle({ turn, status: 'interrupted', error: 'turn timed out after 20 minutes' })
      }, INTERRUPT_GRACE_MS)
      tracked.timer.unref()
    }, TURN_TIMEOUT_MS)
    tracked.timer.unref()
  }

  function recordRoundTurn(wake: Wake, sessionId: string, turn: number): void {
    if (wake.round === undefined) return
    const round = state.rounds[wake.round]
    if (round === undefined) return
    const ref = { sessionId, turn }
    round.turns ??= []
    if (!round.turns.some(item => item.sessionId === sessionId && item.turn === turn)) round.turns.push(ref)
    const key = turnKey(sessionId, turn)
    const rounds = turnRounds.get(key) ?? new Set<string>()
    rounds.add(wake.round)
    turnRounds.set(key, rounds)
  }

  function removeRoundTurn(roundId: string, sessionId: string, turn: number): void {
    const round = state.rounds[roundId]
    if (round?.turns !== undefined) {
      round.turns = round.turns.filter(item => item.sessionId !== sessionId || item.turn !== turn)
      if (round.turns.length === 0) delete round.turns
    }
    const key = turnKey(sessionId, turn)
    const rounds = turnRounds.get(key)
    rounds?.delete(roundId)
    if (rounds?.size === 0) turnRounds.delete(key)
  }

  function finishRoundTurn(botId: string, roundId: string, sessionId: string, outcome: TurnOutcome): void {
    const round = state.rounds[roundId]
    if (round === undefined) return
    const reply = turnAnswerOf(contextSession(), sessionId, outcome.turn)
    if (reply === undefined || reply === '') {
      delete round.lastReply
      log('warn', `bot agent round ${roundId} of bot ${botId} turn ${outcome.turn} published no reply`)
    } else {
      round.lastReply = reply
    }
    removeRoundTurn(roundId, sessionId, outcome.turn)
    persist()
    closeRound(roundId)
  }

  function finishWakeTurn(botId: string, wake: Wake, sessionId: string, outcome: TurnOutcome): void {
    const bot = ensureBotState(botId)
    bot.lastWakeAt = new Date().toISOString()
    if (outcome.error === undefined) delete bot.lastError
    else bot.lastError = outcome.error
    persist()
    if (wake.round !== undefined) finishRoundTurn(botId, wake.round, sessionId, outcome)
  }

  function pendingWake(botId: string, wake: Wake): void {
    const bot = ensureBotState(botId)
    if (!bot.queue.some(item => item.id === wake.id)) bot.queue.push(wake)
    persist()
  }

  function removePendingWake(botId: string, wakeId: string): void {
    const bot = ensureBotState(botId)
    bot.queue = bot.queue.filter(wake => wake.id !== wakeId)
  }

  async function retryWake(
    botId: string,
    wake: Wake,
    sessionId: string,
    failedTurn: number,
    route: AgentModelRoute,
  ): Promise<void> {
    // Hold the wake id while it is re-queued and sent again: the first
    // admission released it from `admitting`, so without this the periodic
    // pending-wake poll would dispatch the same wake a second time.
    admitting.add(wake.id)
    try {
      pendingWake(botId, wake)
      await persistChain
      if (stopped) return
      const { turn } = await contextSession().send(sessionId, { text: wake.text, model: route })
      removePendingWake(botId, wake.id)
      recordRoundTurn(wake, sessionId, turn)
      if (wake.round !== undefined) removeRoundTurn(wake.round, sessionId, failedTurn)
      persist()
      trackTurn(botId, sessionId, turn, outcome => finishWakeTurn(botId, wake, sessionId, outcome))
    } catch (error) {
      removePendingWake(botId, wake.id)
      finishWakeTurn(botId, wake, sessionId, { turn: failedTurn, status: 'failed', error: errorText(error) })
    } finally {
      admitting.delete(wake.id)
    }
  }

  async function sendWake(
    botId: string,
    wake: Wake,
    sessionId: string,
    route: AgentModelRoute,
    fallback?: AgentModelRoute,
  ): Promise<void> {
    const { turn } = await contextSession().send(sessionId, { text: wake.text, model: route })
    removePendingWake(botId, wake.id)
    recordRoundTurn(wake, sessionId, turn)
    persist()
    trackTurn(botId, sessionId, turn, outcome => {
      if (outcome.status === 'failed' && fallback !== undefined && !stopped) {
        const retry = retryWake(botId, wake, sessionId, turn, fallback)
        admissions.add(retry)
        void retry.finally(() => admissions.delete(retry))
        return
      }
      finishWakeTurn(botId, wake, sessionId, outcome)
    })
  }

  /** Prepare context and admit one wake without awaiting its turn to finish. */
  async function runWake(botId: string, wake: Wake): Promise<void> {
    try {
      await persistChain
      if (stopped || entries.get(botId)?.config?.enabled !== true) return
      const bot = ensureBotState(botId)
      const sessionId = await ensureContext(botId)
      if (stopped) return
      const denyModels = entries.get(botId)?.config?.denyModels ?? []
      const routes = (await options.selectModels()).filter(route => !isDenied(route, denyModels))
      if (stopped) return
      if (routes.length === 0) throw new Error('no allowed high-intelligence model available')
      const primary = routes[0]
      const modelId = `${primary.provider}/${primary.model}`
      // Estimate the active context input before any dispatch decision. A
      // failed inspect is treated as unknown and never blocks a wake. The
      // wake text is included so the estimate reflects the input the next
      // turn will actually send.
      const estimatedInput = await estimateInput(sessionId, modelId, wake.text)
      // Rotate the bot's own context when its input outgrows the room the
      // routes can offer, seeding the fresh session with what is still in
      // flight. The old ledger and every watch/round/routine stays intact.
      let activeSessionId = sessionId
      // The threshold covers only the routes a turn can run: the primary
      // and the single fallback runWake tries below.
      if (estimatedInput !== undefined && estimatedInput > rotationThreshold(routes.slice(0, 2)) && !stopped) {
        const fresh = await contextSession().createSession()
        // Bind and persist the fresh session before seeding so the seed
        // turn resolves the bot's tool port like every other bot turn.
        bot.sessionId = fresh.sessionId
        activeSessionId = fresh.sessionId
        persist()
        // Let the queued write reach disk before the seed turn starts.
        await persistChain
        await seedRotatedContext(fresh.sessionId, primary, botId)
      }
      // The route-fit check runs against the input of the session that will
      // actually run the turn. After a rotation the fresh session has a
      // different (seeded) ledger, so re-inspect it once seeding has
      // finished; otherwise reuse the pre-rotation estimate. The wake text
      // is again included so a large wake cannot overflow an admitted route.
      const fittingInput = activeSessionId === sessionId
        ? estimatedInput
        : await estimateInput(activeSessionId, modelId, wake.text)
      const fitting = routes.filter(route => routeFits(route, fittingInput))
      if (fitting.length === 0) throw new Error('no allowed route fits the bot context within its context window')
      if (stopped) return
      await sendWake(botId, wake, activeSessionId, fitting[0], fitting[1])
    } catch (error) {
      if (stopped) return
      removePendingWake(botId, wake.id)
      ensureBotState(botId).lastError = errorText(error)
      log('error', `bot agent wake ${wake.id} of bot ${botId} failed: ${errorText(error)}`)
      persist()
      if (wake.round !== undefined) closeRound(wake.round)
    }
  }

  function dispatchWake(botId: string, wake: Wake): void {
    if (stopped || admitting.has(wake.id) || entries.get(botId)?.config?.enabled !== true) return
    admitting.add(wake.id)
    let task: Promise<void>
    task = runWake(botId, wake).finally(() => {
      admitting.delete(wake.id)
      admissions.delete(task)
    })
    admissions.add(task)
  }

  // ─── Config ──────────────────────────────────────────────────────────────

  function mtimesOf(loaded: readonly BotAgentEntry[]): Map<string, number> {
    return new Map(loaded.map(entry => [entry.path, entry.mtimeMs]))
  }

  function sameMtimes(left: Map<string, number>, right: Map<string, number>): boolean {
    if (left.size !== right.size) return false
    for (const [path, mtimeMs] of left) {
      if (right.get(path) !== mtimeMs) return false
    }
    return true
  }

  /**
   * Adopt a fresh config load: reconcile the routines of every changed valid
   * bot, drop those of a bot whose file was removed, and leave an invalid file
   * owning only its own error.
   */
  async function applyConfigs(loaded: BotAgentEntry[], previous: Map<string, number>): Promise<void> {
    const removed = [...entries.keys()].filter(id => !loaded.some(entry => entry.id === id))
    entries.clear()
    for (const entry of loaded) entries.set(entry.id, entry)
    for (const entry of loaded) {
      if (entry.config === undefined || previous.get(entry.path) === entry.mtimeMs) continue
      try {
        await options.routines.reconcile(entry.id, entry.config.routines)
      } catch (error) {
        log('warn', `bot agent kernel could not reconcile the routines of ${entry.id}: ${errorText(error)}`)
      }
    }
    for (const id of removed) {
      try {
        await options.routines.reconcile(id, [])
      } catch (error) {
        log('warn', `bot agent kernel could not drop the routines of removed bot ${id}: ${errorText(error)}`)
      }
    }
  }

  async function reloadConfigs(): Promise<void> {
    const loaded = await loadBotAgentConfigs(options.configDir)
    const next = mtimesOf(loaded)
    if (sameMtimes(next, appliedMtimes)) return
    const previous = appliedMtimes
    appliedMtimes = next
    await applyConfigs(loaded, previous)
  }

  function dispatchPendingWakes(): void {
    for (const [id, bot] of Object.entries(state.bots)) {
      for (const wake of bot.queue) dispatchWake(id, wake)
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /** Wake one bot for a finished watched turn: read the answer, then enqueue once. */
  function wakeWatch(watch: Watch, status: TurnStatus): void {
    let reply: string | undefined
    try {
      reply = turnAnswerOf(options.sessions, watch.sessionId, watch.afterTurn + 1)
    } catch (error) {
      log('warn', `bot agent kernel could not read watched session ${watch.sessionId}: ${errorText(error)}`)
    }
    const wake = enqueue(watch.botId, {
      source: 'session',
      text: `[wake:session ${watch.sessionId} ${status}] ${reply ?? ''}`,
      ...(watch.round === undefined ? {} : { round: watch.round }),
    })
    persist()
    dispatchWake(watch.botId, wake)
  }

  /**
   * Fire every persisted watch whose turn already finished, and re-subscribe
   * the rest. Startup reads index metadata only: the summary records the newest
   * finished turn, so a watch the index proves finished is recognized without
   * parsing its timeline, and the reply excerpt — the only part that needs the
   * body — is read on a later tick, so readiness is never held behind it.
   */
  async function restoreWatches(): Promise<void> {
    // At most one pending watch per bot and session survives a restart: the
    // newest turn wins, and a superseded duplicate cannot fire a second wake.
    const newest = new Map<string, Watch>()
    for (const watch of state.watches) {
      const key = watchKey(watch.botId, watch.sessionId)
      const current = newest.get(key)
      if (current === undefined || watch.afterTurn >= current.afterTurn) newest.set(key, watch)
    }
    const kept: Watch[] = []
    let summaries = new Map<string, SessionSummary>()
    try {
      summaries = new Map(options.sessions.listSessions().map(summary => [summary.sessionId, summary]))
    } catch (error) {
      log('warn', `bot agent kernel could not list sessions while restoring watches: ${errorText(error)}`)
    }
    /** Watches the index already proves finished, with that turn's status. */
    const fires: { watch: Watch; status: TurnStatus }[] = []
    /** Watches whose exact turn only the timeline can settle. */
    const unsettled: Watch[] = []
    for (const watch of newest.values()) {
      const watched = watch.afterTurn + 1
      const summary = summaries.get(watch.sessionId)
      // A summary without a tail position or a pending-turn list is a
      // placeholder, a legacy entry or one its timeline outgrew: it cannot
      // prove the outcome of any turn.
      const trustworthy = summary !== undefined
        && summary.lastSeq !== undefined
        && summary.pendingTurns !== undefined
      const lastTurn = summary?.lastTurn
      if (trustworthy && lastTurn !== undefined && lastTurn.turn === watched) {
        fires.push({ watch, status: lastTurn.status })
        continue
      }
      // A watched turn still ahead of the newest finished one has not finished,
      // and when the index is trustworthy nothing else can have settled it.
      if (trustworthy && (lastTurn === undefined || lastTurn.turn < watched)) {
        kept.push(watch)
        continue
      }
      // Missing, stale or later-turn metadata: the index cannot prove this
      // exact turn's outcome, so the body decides on a later tick. The watch
      // stays subscribed meanwhile, so a live `turn.finished` is not missed.
      kept.push(watch)
      unsettled.push(watch)
    }
    // Subscribe before any deferred body check, so an event landing while the
    // check is queued still reaches the watch.
    state.watches = kept
    for (const watch of kept) subscribeWatch(watch.botId, watch.sessionId)
    for (const fire of fires) {
      const timer = setImmediate(() => {
        if (stopped) return
        wakeWatch(fire.watch, fire.status)
      })
      timer.unref()
    }
    for (const watch of unsettled) {
      const timer = setImmediate(() => {
        if (stopped) return
        const index = state.watches.indexOf(watch)
        // A live `turn.finished` already woke this bot; never wake it twice.
        if (index < 0) return
        let finished: TurnOutcome | undefined
        try {
          finished = finishedTurnOf(options.sessions, watch.sessionId, watch.afterTurn + 1)
        } catch (error) {
          log('warn', `bot agent kernel could not read watched session ${watch.sessionId}: ${errorText(error)}`)
        }
        // Only the exact watched turn fires the wake; any other finish leaves
        // the watch in place for its own turn.
        if (finished === undefined) return
        state.watches.splice(index, 1)
        releaseWatch(watch.botId, watch.sessionId)
        wakeWatch(watch, finished.status)
      })
      timer.unref()
    }
  }

  function restoreRoundTurns(): void {
    for (const [roundId, round] of Object.entries(state.rounds)) {
      for (const ref of [...(round.turns ?? [])]) {
        const outcome = finishedTurnOf(contextSession(), ref.sessionId, ref.turn)
        if (outcome !== undefined) {
          finishRoundTurn(round.botId, roundId, ref.sessionId, outcome)
          continue
        }
        const key = turnKey(ref.sessionId, ref.turn)
        const rounds = turnRounds.get(key) ?? new Set<string>()
        rounds.add(roundId)
        turnRounds.set(key, rounds)
        trackTurn(round.botId, ref.sessionId, ref.turn, finished => {
          finishRoundTurn(round.botId, roundId, ref.sessionId, finished)
        })
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (started || stopped) return
      started = true
      try {
        await readFile(statePath, 'utf-8').then(raw => {
          const loaded = parseState(raw)
          state.bots = loaded.bots
          state.watches = loaded.watches
          state.rounds = loaded.rounds
        })
      } catch {
        // No state yet (or an unreadable one): every bot starts with an empty queue.
      }
      await reloadConfigs()
      await restoreWatches()
      restoreRoundTurns()
      persist()
      dispatchPendingWakes()
      pollTimer = setInterval(() => {
        void reloadConfigs().then(dispatchPendingWakes).catch(error => {
          log('warn', `bot agent kernel could not reload bot configs: ${errorText(error)}`)
        })
      }, CONFIG_POLL_MS)
      pollTimer.unref()
    },

    stop(): Promise<void> {
      // requestShutdown and the workspace teardown both call stop(): they must
      // share one attempt, so the context is closed exactly once.
      if (stopPromise !== undefined) return stopPromise
      stopPromise = (async () => {
        stopped = true
        if (pollTimer !== undefined) {
          clearInterval(pollTimer)
          pollTimer = undefined
        }
        for (const unsubscribe of watchSubs.values()) unsubscribe()
        watchSubs.clear()
        const session = context
        if (session !== undefined) {
          await session.close().catch(error => {
            log('warn', `bot agent kernel could not close its bot context: ${errorText(error)}`)
          })
        }
        for (const tracked of trackedTurns.values()) {
          if (tracked.timer !== undefined) clearTimeout(tracked.timer)
          tracked.unsubscribe?.()
        }
        trackedTurns.clear()
        activeTurns.clear()
        // A rotation seed may still be waiting for its turn; resolve it now so
        // shutdown cannot deadlock on an admission that never finishes.
        for (const settle of [...seedWaits]) settle()
        await Promise.allSettled([...admissions])
        persist()
        await persistChain
        // Only now drop the context: nothing may create or recreate a private
        // session while a stop is running.
        context = undefined
      })()
      return stopPromise
    },

    list(): AgentBotSummary[] {
      return [...entries.values()].sort((left, right) => left.id.localeCompare(right.id)).map(summaryOf)
    },

    get(id: string): { bot: AgentBotSummary; config: string } {
      const entry = entries.get(id)
      if (entry === undefined) throw new BotAgentError('agent_not_found', `unknown bot: ${id}`)
      return { bot: summaryOf(entry), config: entry.text }
    },

    context(id: string): { session: Session; sessionId: string } | undefined {
      const bot = state.bots[id]
      if (bot?.sessionId === undefined) return undefined
      return { session: contextSession(), sessionId: bot.sessionId }
    },

    wake(id: string, text: string): { queued: number } {
      requireBot(id)
      const wake = enqueue(id, { source: 'user', text: `[wake:user] ${text}` })
      persist()
      dispatchWake(id, wake)
      return { queued: state.bots[id]?.queue.length ?? 0 }
    },

    removeWatches(sessionId: string): void {
      removeWatches(sessionId)
    },

    async wakeRoutine(routine: RoutineRecord): Promise<void> {
      const entry = requireBot(routine.botId)
      const roundId = randomUUID()
      state.rounds[roundId] = { botId: entry.id, routineId: routine.id, deliver: routine.deliver }
      const wake = enqueue(entry.id, {
        source: 'routine',
        text: `[wake:routine ${routine.id}] ${routine.prompt}`,
        round: roundId,
        routineId: routine.id,
      })
      persist()
      dispatchWake(entry.id, wake)
    },

    routineBusy(routine: RoutineRecord): boolean {
      return Object.values(state.rounds).some(round =>
        round.botId === routine.botId && round.routineId === routine.id)
    },
  }
}
