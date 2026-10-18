/**
 * Bot agent kernel.
 *
 * A bot is an LLM agent assembled from one JSON config file. The kernel owns
 * everything around it: one wake queue per bot, one turn at a time per bot, the
 * watches that wake a bot when a work session finishes a turn, the rounds a
 * routine fire opens, and the persisted state that lets all of it survive a
 * daemon restart. Bots run concurrently and know nothing about each other
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
/** Longest watched-session reply excerpt carried into a wake. */
const SESSION_REPLY_CHARS = 600

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
  /** Delivery attempts so far; a restart retries a wake that has only one. */
  attempts: number
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
  /** The round's last final reply, delivered to `deliver` when the round closes. */
  lastReply?: string
}

/** One bot's persisted runtime state. */
interface BotState {
  /** Ledger session of this bot's private context. */
  sessionId?: string
  queue: Wake[]
  inflight?: Wake
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

/** What one wake produced, for the last-wake bookkeeping. */
interface WakeOutcome {
  sessionId?: string
  turn?: number
  /** Final status of the turn, so a stop can tell a finished turn from a cut one. */
  status?: TurnStatus
  error?: string
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
    'Each user message is a wake event tagged [wake:user], [wake:routine <id>], [wake:session <sessionId> <status>] or [wake:message from <bot>].',
    'Handle it, then end the turn with a short text reply.',
    'You have no file or shell access and act only through the listed tools; with no tools, answer in text only.',
    'After starting work in a session, end the turn: its completion wakes you.',
  ].join(' ')
  return `${fixed}\n\n${config.instructions}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * The context-input threshold above which a bot's own conversation rotates to a
 * fresh session. It is the smaller of a fixed 100k ceiling and half the
 * smallest finite positive context window among the routes the bot may run,
 * so a route is always left enough room for its own output. A route with no
 * resolved window falls back to the 100k ceiling.
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
    attempts: typeof value.attempts === 'number' ? value.attempts : 0,
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
  return {
    botId,
    routineId,
    deliver: deliver as RoutineDeliver,
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
      const inflight = readWake(value.inflight)
      state.bots[id] = {
        queue,
        ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
        ...(inflight === undefined ? {} : { inflight }),
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
  /** Bots whose pump loop is currently running. */
  const pumping = new Set<string>()
  /** Live pump chains, awaited by stop() so an interrupted wake can settle. */
  const pumps = new Set<Promise<void>>()
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
      run: call => runTools(call, toolContext(botId)),
    }
  }

  function toolContext(botId: string): AgentToolContext {
    return {
      botId,
      denyModels: entries.get(botId)?.config?.denyModels ?? [],
      watch: (sessionId, afterTurn, todoIds) => addWatch(botId, sessionId, afterTurn, todoIds),
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
    else if (bot?.inflight !== undefined) status = 'running'
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
      attempts: 0,
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

  function addWatch(botId: string, sessionId: string, afterTurn: number, todoIds?: readonly string[]): void {
    // A watch created by the running turn inherits that turn's round.
    const round = state.bots[botId]?.inflight?.round
    // A re-watch of a session the bot already follows keeps the prior todo
    // association when the caller omits one, so rotation recovery is stable.
    const inherited = todoIds === undefined
      ? state.watches.find(watch => watch.botId === botId && watch.sessionId === sessionId && watch.todoIds !== undefined)
      : undefined
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
    enqueue(botId, {
      source: 'session',
      text: `[wake:session ${sessionId} ${event.status}] ${truncate(reply ?? '', SESSION_REPLY_CHARS)}`,
      ...(watch.round === undefined ? {} : { round: watch.round }),
    })
    persist()
    pump(botId)
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
      await runTurn(newSessionId, lines.join('\n'), route)
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
    if (bot !== undefined && (bot.inflight?.round === roundId || bot.queue.some(wake => wake.round === roundId))) return
    // The target's wake is enqueued before the round is dropped, so the delivery
    // and the round removal reach the file in one transition. A target that
    // cannot be woken is reported as an error: its reply is never silently lost
    // and no delivery is fabricated.
    let target: string | undefined
    if (round.deliver !== 'none') {
      const reply = round.lastReply
      if (reply === undefined || reply === '') {
        log('warn', `bot agent round ${roundId} of bot ${round.botId} closed without a reply to deliver to ${round.deliver}`)
      } else {
        try {
          target = round.deliver.slice('bot:'.length)
          enqueueMessage(round.botId, target, reply)
        } catch (error) {
          target = undefined
          log('error', `bot agent round ${roundId} could not deliver its reply to ${round.deliver}: ${errorText(error)}`)
        }
      }
    }
    delete state.rounds[roundId]
    persist()
    if (target !== undefined) pump(target)
  }

  /** Enqueue one message wake on the target bot; throws unless it is runnable. */
  function enqueueMessage(from: string, to: string, text: string): void {
    if (to === from) throw new BotAgentError('agent_invalid', 'a bot cannot message itself')
    requireBot(to)
    enqueue(to, { source: 'message', text: `[wake:message from ${from}] ${text}` })
  }

  function sendMessage(from: string, to: string, text: string): void {
    enqueueMessage(from, to, text)
    persist()
    pump(to)
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

  /**
   * Send one wake text into the bot context and wait for exactly that turn's
   * `turn.finished`. The subscription is armed before the send so a finish is
   * never missed, but every event is ignored until `send` has returned the turn
   * number: a cold or restarted context session appends `turn.finished` for a
   * dangling prior turn while `send` is still awaiting. After the send the
   * ledger is read back for that exact turn, so a finish that landed in between
   * is not lost either. The timeout and the subscription are released only once
   * that turn settles.
   */
  async function runTurn(sessionId: string, text: string, route: AgentModelRoute): Promise<TurnOutcome> {
    const session = contextSession()
    let settled = false
    let target: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolve: (outcome: TurnOutcome) => void = () => {}
    const finished = new Promise<TurnOutcome>(settle => { resolve = settle })
    const done = (outcome: TurnOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const unsubscribe = session.subscribe(sessionId, event => {
      if (target === undefined) return
      if (event.type !== 'turn.finished' || event.turn === undefined) return
      if (event.turn !== target) return
      done({
        turn: event.turn,
        status: event.status,
        ...(event.error === undefined ? {} : { error: event.error }),
      })
    })
    try {
      const { turn } = await session.send(sessionId, { text, model: route })
      target = turn
      const recorded = finishedTurnOf(session, sessionId, turn)
      if (recorded !== undefined) done(recorded)
      timer = setTimeout(() => {
        void session.interrupt(sessionId, turn).catch(error => {
          log('warn', `bot agent could not interrupt turn ${turn} of session ${sessionId}: ${errorText(error)}`)
        })
        timer = setTimeout(() => {
          done({ turn, status: 'interrupted', error: 'turn timed out after 20 minutes' })
        }, INTERRUPT_GRACE_MS)
        timer.unref()
      }, TURN_TIMEOUT_MS)
      timer.unref()
      return await finished
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }

  function finishWake(botId: string, wake: Wake, outcome: WakeOutcome): void {
    const bot = ensureBotState(botId)
    // Graceful shutdown interrupts the running turn. Leave the wake in-flight so
    // the next start() requeues it once (attempts < 2), and do not touch the
    // round: a wake that shutdown cut short must neither be consumed nor deliver
    // a partial result. A turn that already completed keeps normal bookkeeping,
    // so finished work is never duplicated on the restart.
    if (stopped && outcome.status !== 'completed') {
      persist()
      return
    }
    bot.inflight = undefined
    bot.lastWakeAt = new Date().toISOString()
    if (outcome.error === undefined) delete bot.lastError
    else bot.lastError = outcome.error
    if (wake.round !== undefined && outcome.sessionId !== undefined && outcome.turn !== undefined) {
      const round = state.rounds[wake.round]
      if (round !== undefined) {
        // The round's reply is always exactly the reply of the turn that just
        // ended. A turn that published none clears the record instead of leaving
        // an earlier turn's text behind: a stale reply must never be delivered.
        const reply = turnAnswerOf(contextSession(), outcome.sessionId, outcome.turn)
        if (reply === undefined || reply === '') {
          delete round.lastReply
          log('warn', `bot agent round ${wake.round} of bot ${botId} turn ${outcome.turn} published no reply`)
        } else {
          round.lastReply = reply
        }
      }
    }
    persist()
    if (wake.round !== undefined) closeRound(wake.round)
  }

  /** Run one wake to completion: one turn, with a bounded fallback on another route. */
  async function runWake(botId: string, wake: Wake): Promise<void> {
    const outcome: WakeOutcome = {}
    try {
      if (entries.get(botId)?.config?.enabled === true) {
        const bot = ensureBotState(botId)
        const sessionId = await ensureContext(botId)
        outcome.sessionId = sessionId
        // Shutdown begun: start no model call, and let finally keep the wake.
        if (stopped) return
        const denyModels = entries.get(botId)?.config?.denyModels ?? []
        const routes = (await options.selectModels()).filter(route => !isDenied(route, denyModels))
        // The route ranking is awaited too: check again before the first send.
        if (stopped) return
        if (routes.length === 0) {
          // No high-intelligence model this bot may use is available right now:
          // drop the wake and surface it, instead of running a bot on a model
          // it may not use.
          outcome.error = 'no allowed high-intelligence model available'
        } else {
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
          if (estimatedInput !== undefined && estimatedInput > rotationThreshold(routes) && !stopped) {
            const fresh = await contextSession().createSession()
            await seedRotatedContext(fresh.sessionId, primary, botId)
            bot.sessionId = fresh.sessionId
            activeSessionId = fresh.sessionId
            persist()
          }
          // The route-fit check runs against the input of the session that will
          // actually run the turn. After a rotation the fresh session has a
          // different (seeded) ledger, so re-inspect it once seeding has
          // finished; otherwise reuse the pre-rotation estimate. The wake text
          // is again included so a large wake cannot overflow an admitted route.
          const fittingInput = activeSessionId === sessionId
            ? estimatedInput
            : await estimateInput(activeSessionId, modelId, wake.text)
          // Admit only routes whose window can hold that input plus an output
          // reservation; iterate them in rank order and fall back one step on a
          // genuine model failure. Too-small routes are skipped, not retried,
          // and when none fit the wake reports the truth.
          const fitting = routes.filter(route => routeFits(route, fittingInput))
          if (fitting.length === 0) {
            outcome.error = 'no allowed route fits the bot context within its context window'
          } else {
            // Record the session the turn will actually run on before dispatch,
            // so finishWake's round-reply lookup reads the ledger that produced
            // outcome.turn rather than the pre-rotation session.
            outcome.sessionId = activeSessionId
            let result = await runTurn(activeSessionId, wake.text, fitting[0])
            if (result.status === 'failed' && fitting[1] !== undefined && !stopped) {
              result = await runTurn(activeSessionId, wake.text, fitting[1])
            }
            outcome.status = result.status
            outcome.turn = result.turn
            if (result.status !== 'completed') {
              outcome.error = result.error ?? `turn ${result.status}`
            }
          }
        }
      }
    } catch (error) {
      outcome.error = errorText(error)
      log('error', `bot agent wake ${wake.id} of bot ${botId} failed: ${outcome.error}`)
    } finally {
      finishWake(botId, wake, outcome)
    }
  }

  /** Process a bot's queue one wake at a time until it is empty or unfit to run. */
  async function pumpLoop(botId: string): Promise<void> {
    for (;;) {
      if (stopped || entries.get(botId)?.config?.enabled !== true) return
      const bot = ensureBotState(botId)
      if (bot.inflight !== undefined || bot.queue.length === 0) return
      const wake = bot.queue.shift()
      if (wake === undefined) return
      wake.attempts += 1
      bot.inflight = wake
      persist()
      await runWake(botId, wake)
    }
  }

  function pump(botId: string): void {
    if (stopped || pumping.has(botId)) return
    pumping.add(botId)
    const running = pumpLoop(botId)
      .catch(error => { log('error', `bot agent pump of ${botId} failed: ${errorText(error)}`) })
      .finally(() => {
        pumping.delete(botId)
        pumps.delete(running)
        // A wake enqueued while this loop was winding down must not be lost.
        const bot = state.bots[botId]
        if (!stopped && entries.get(botId)?.config?.enabled === true
          && bot !== undefined && bot.inflight === undefined && bot.queue.length > 0) {
          pump(botId)
        }
      })
    // Track the settling chain so stop() can wait for an interrupted wake.
    pumps.add(running)
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
    for (const id of entries.keys()) pump(id)
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /** Fire a persisted watch whose turn already finished, or re-subscribe it. */
  async function restoreWatches(): Promise<void> {
    const kept: Watch[] = []
    for (const watch of state.watches) {
      let finished: TurnOutcome | undefined
      try {
        // Only the exact watched turn fires the wake; any other finish leaves
        // the watch in place for its own turn.
        finished = finishedTurnOf(options.sessions, watch.sessionId, watch.afterTurn + 1)
      } catch (error) {
        log('warn', `bot agent kernel could not read watched session ${watch.sessionId}: ${errorText(error)}`)
      }
      if (finished === undefined) {
        kept.push(watch)
        continue
      }
      const reply = turnAnswerOf(options.sessions, watch.sessionId, finished.turn)
      enqueue(watch.botId, {
        source: 'session',
        text: `[wake:session ${watch.sessionId} ${finished.status}] ${truncate(reply ?? '', SESSION_REPLY_CHARS)}`,
        ...(watch.round === undefined ? {} : { round: watch.round }),
      })
    }
    state.watches = kept
    for (const watch of kept) subscribeWatch(watch.botId, watch.sessionId)
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
      // A wake interrupted by the restart is retried once; after that it is
      // dropped, so one poisoned wake can never spin forever.
      for (const [botId, bot] of Object.entries(state.bots)) {
        const inflight = bot.inflight
        if (inflight === undefined) continue
        bot.inflight = undefined
        if (inflight.attempts < 2) bot.queue.unshift(inflight)
        else log('warn', `bot agent kernel dropped interrupted wake ${inflight.id} of bot ${botId}`)
      }
      await reloadConfigs()
      await restoreWatches()
      persist()
      for (const id of entries.keys()) pump(id)
      pollTimer = setInterval(() => {
        void reloadConfigs().catch(error => {
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
        // Close the private context before waiting on the pumps: closing it
        // interrupts a running turn, which is what releases the awaiting pump
        // instead of leaving it stuck on an in-flight model call. The reference
        // is kept until the pumps settle, because finishWake still reads a
        // completed turn's reply out of that same context.
        const session = context
        if (session !== undefined) {
          await session.close().catch(error => {
            log('warn', `bot agent kernel could not close its bot context: ${errorText(error)}`)
          })
        }
        // An interrupted wake has now run its finally and been kept in-flight.
        await Promise.allSettled([...pumps])
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
      enqueue(id, { source: 'user', text: `[wake:user] ${text}` })
      persist()
      pump(id)
      const bot = state.bots[id]
      return { queued: (bot?.queue.length ?? 0) + (bot?.inflight === undefined ? 0 : 1) }
    },

    removeWatches(sessionId: string): void {
      removeWatches(sessionId)
    },

    async wakeRoutine(routine: RoutineRecord): Promise<void> {
      const entry = requireBot(routine.botId)
      const roundId = randomUUID()
      state.rounds[roundId] = { botId: entry.id, routineId: routine.id, deliver: routine.deliver }
      enqueue(entry.id, {
        source: 'routine',
        text: `[wake:routine ${routine.id}] ${routine.prompt}`,
        round: roundId,
        routineId: routine.id,
      })
      persist()
      pump(entry.id)
    },

    routineBusy(routine: RoutineRecord): boolean {
      const bot = state.bots[routine.botId]
      if (bot === undefined) return false
      // A session-result continuation wake carries its round without a
      // routineId, so resolve it through the round it belongs to.
      const matches = (wake: Wake): boolean => wake.routineId === routine.id
        || (wake.round !== undefined && state.rounds[wake.round]?.routineId === routine.id)
      if (bot.inflight !== undefined && matches(bot.inflight)) return true
      return bot.queue.some(matches)
    },
  }
}
