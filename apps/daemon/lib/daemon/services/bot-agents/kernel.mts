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
  type ReplySentEvent,
  type Session,
  type SessionHost,
  type SessionSummary,
  type TurnStatus,
} from '@wrenyard/session'
import type { RoutineDeliver, RoutineRecord } from '../../../protocol/methods/routine.mts'
import type { Scheduler } from '../scheduler.mts'
import type { WorkspaceTodoService } from '../workspace-todo-service.mts'
import { loadBotAgentConfigs, type BotAgentConfig, type BotAgentEntry } from './config.mts'
import {
  GROUP_PROMPT_GUIDANCE,
  groupSourceKey,
  parseMentions,
  type GroupBot,
  type GroupMessage,
} from './group.mts'
import { TurnAnswerIndex } from './turn-answer.mts'
import {
  agentToolSpecs,
  createAgentToolRunner,
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
/** Default page size of the shared group transcript. */
const GROUP_PAGE_SIZE = 100
/** Hard cap on one group transcript page. */
const GROUP_PAGE_MAX = 500
/** How many published reply source keys are remembered for deduplication. */
const GROUP_PUBLISHED_MAX = 2_000

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

/** One transcript entry as persisted; `sourceKey` is the reply dedup key. */
export interface GroupTranscriptEntry extends GroupMessage {
  sourceKey?: string
}

/**
 * How far one bot context ledger has been read for group publication. Keyed by
 * context session id, so a session left behind by a rotation keeps its cursor.
 */
interface GroupReplyCursor {
  botId: string
  lastSeq: number
}

/** One mention-derived wake recorded until its queue entry is admitted. */
interface GroupPeerWake {
  wakeId: string
  botId: string
  text: string
  createdAt: string
}

/** One in-memory transcript append and the mention targets it derived. */
interface AppendedGroupMessage {
  entry: GroupTranscriptEntry
  /** Enabled bots the text mentions, in mention order; empty when none. */
  targets: string[]
}

/** What one ledger event did to the group state, before it is persisted. */
interface GroupEventNote {
  /** Whether the event appended a transcript entry that must reach the file. */
  published: boolean
  /** Wakes the published entry derived, to dispatch after the snapshot. */
  wakes: Wake[]
}

/** The durable shared group conversation and its publication bookkeeping. */
export interface GroupState {
  /** Highest transcript seq already assigned; 0 for an empty transcript. */
  seq: number
  messages: GroupTranscriptEntry[]
  /** Last ledger event read for group publication, by context session id. */
  cursors: Record<string, GroupReplyCursor>
  /** Reply source keys already published, oldest first, bounded. */
  published: string[]
  /** Peer wakes enqueued from group mentions and not yet admitted. */
  peerWakes: Record<string, GroupPeerWake>
}

/** Everything the kernel persists in one file. */
interface KernelState {
  version: 1
  bots: Record<string, BotState>
  watches: Watch[]
  rounds: Record<string, Round>
  group: GroupState
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
  /** The ladder-ranked routes a bot may run on, best first. */
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
  /** Read one bounded page of the shared group transcript. */
  groupEvents(input: GroupEventsInput): GroupEventsPage
  /** Post one user message to the group and wake the bots it mentions. */
  groupSend(text: string): GroupSendResult
}

export interface GroupEventsInput {
  afterSeq?: number
  limit?: number
}

export interface GroupEventsPage {
  messages: GroupMessage[]
  lastSeq: number
}

export interface GroupSendResult {
  message: GroupMessage
  awakened: string[]
}

/**
 * The fixed instruction prefix every bot runs on, before its config text, and
 * the enabled peers it may address in the group. The roster is appended after
 * the prefix, the group guidance and the config instructions, all verbatim.
 */
function botSystemPrompt(config: BotAgentConfig, all: Iterable<BotAgentEntry>): string {
  const fixed = [
    `You are the Wrenyard bot "${config.name}" (${config.id}).`,
    'You are driven by messages: routine triggers, user input, other bots\' messages and work-session updates.',
    'One message may carry several [wake:user], [wake:routine <id>], [wake:session <sessionId> <status>] or [wake:message from <bot>] entries; handle every one of them in this turn.',
    'Your levers are the bot tools (session list/create/send/interrupt, todo, message).',
    'Answer directly in text when no work is needed: acknowledgements, status from this conversation, and questions you can answer without running anything.',
    'You never run code, searches, documents or tasks yourself; delegate such work to a work session in natural language and create one only for it.',
    'You have no file or shell access.',
  ].join(' ')
  const peers: BotAgentConfig[] = []
  for (const entry of all) {
    const peer = entry.config
    if (peer === undefined || !peer.enabled || peer.id === config.id) continue
    peers.push(peer)
  }
  peers.sort((left, right) => left.id.localeCompare(right.id))
  const roster = peers.length === 0
    ? 'No other bot is enabled in this group right now.'
    : [
      'Other bots enabled in this group; address one with @id or @name:',
      ...peers.map(peer => `- @${peer.id} (${peer.name})`),
    ].join('\n')
  return `${fixed}\n\n${GROUP_PROMPT_GUIDANCE}\n\n${config.instructions}\n\n${roster}`
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

function emptyGroupState(): GroupState {
  return { seq: 0, messages: [], cursors: {}, published: [], peerWakes: {} }
}

function emptyState(): KernelState {
  return { version: 1, bots: {}, watches: [], rounds: {}, group: emptyGroupState() }
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

function readGroupMessage(value: unknown): GroupTranscriptEntry | undefined {
  if (!isPlainObject(value)) return undefined
  const { seq, at, author, text } = value
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return undefined
  if (typeof at !== 'string' || at === '' || typeof text !== 'string') return undefined
  if (author !== 'user' && author !== 'bot') return undefined
  return {
    seq,
    at,
    author,
    text,
    ...(typeof value.botId === 'string' && value.botId !== '' ? { botId: value.botId } : {}),
    ...(typeof value.name === 'string' && value.name !== '' ? { name: value.name } : {}),
    ...(typeof value.sourceKey === 'string' && value.sourceKey !== '' ? { sourceKey: value.sourceKey } : {}),
  }
}

function readGroupCursor(value: unknown): GroupReplyCursor | undefined {
  if (!isPlainObject(value)) return undefined
  const { botId, lastSeq } = value
  if (typeof botId !== 'string' || botId === '') return undefined
  if (typeof lastSeq !== 'number' || !Number.isInteger(lastSeq) || lastSeq < 0) return undefined
  return { botId, lastSeq }
}

function readGroupPeerWake(value: unknown): GroupPeerWake | undefined {
  if (!isPlainObject(value)) return undefined
  const { wakeId, botId, text, createdAt } = value
  if (typeof wakeId !== 'string' || wakeId === '') return undefined
  if (typeof botId !== 'string' || botId === '') return undefined
  if (typeof text !== 'string' || typeof createdAt !== 'string') return undefined
  return { wakeId, botId, text, createdAt }
}

/**
 * Read the persisted group block. A state file written before the group
 * existed has no `group` key at all and migrates to an empty transcript.
 */
function readGroupState(value: unknown): GroupState {
  if (!isPlainObject(value)) return emptyGroupState()
  const group = emptyGroupState()
  if (Array.isArray(value.messages)) {
    for (const entry of value.messages) {
      const message = readGroupMessage(entry)
      if (message !== undefined) group.messages.push(message)
    }
  }
  let highest = 0
  for (const message of group.messages) highest = Math.max(highest, message.seq)
  group.seq = typeof value.seq === 'number' && Number.isInteger(value.seq) && value.seq > highest
    ? value.seq
    : highest
  if (isPlainObject(value.cursors)) {
    for (const [sessionId, cursor] of Object.entries(value.cursors)) {
      const read = readGroupCursor(cursor)
      if (read !== undefined) group.cursors[sessionId] = read
    }
  }
  if (Array.isArray(value.published)) {
    group.published = value.published.filter((key): key is string => typeof key === 'string' && key !== '')
    if (group.published.length > GROUP_PUBLISHED_MAX) {
      group.published = group.published.slice(-GROUP_PUBLISHED_MAX)
    }
  }
  if (isPlainObject(value.peerWakes)) {
    for (const [wakeId, record] of Object.entries(value.peerWakes)) {
      const read = readGroupPeerWake(record)
      if (read !== undefined) group.peerWakes[wakeId] = read
    }
  }
  return group
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
  state.group = readGroupState(parsed.group)
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

/**
 * The visible answer of one turn for group publication: its closing reply, else
 * the text of its terminal reasoning step, else its last published reply.
 * Unlike `turnAnswerOf` it never reads `workerOutput`, so the raw action intents
 * of a turn can never leak into the shared group. The watch path keeps its
 * existing worker-output semantics.
 */
function visibleTurnAnswerOf(session: Session, sessionId: string, turn: number): string | undefined {
  let final: string | undefined
  let reasoning: string | undefined
  let last: string | undefined
  for (const event of session.readLedger(sessionId)) {
    if (event.turn !== turn) continue
    if (event.type === 'reply.sent') {
      last = event.text
      if (event.kind === 'final') final = event.text
      continue
    }
    if (event.type === 'reasoning.completed') reasoning = event.text
  }
  return final ?? reasoning ?? last
}

export function createBotAgentKernel(options: CreateBotAgentKernelOptions): BotAgentKernel {
  const log = options.log
  const statePath = join(options.stateDir, 'kernel.json')
  const state = emptyState()
  /** Config files as last applied, by id. */
  const entries = new Map<string, BotAgentEntry>()
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
  /** Live reply-publication subscriptions, keyed by bot context session. */
  const replySubs = new Map<string, () => void>()
  /** Turns that only seed a rotated context and must never reach the group. */
  const seedTurns = new Set<string>()
  const runTools = createAgentToolRunner({ sessions: options.sessions, todos: options.todos })
  let context: Session | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  /** The config reload in flight, if any; a refresh is single-flight. */
  let refreshPromise: Promise<void> | undefined
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

  /**
   * Verbatim kernel facts appended to a bot's context after compaction: the
   * sessions it watches with their todos, its configured routines, and the
   * enabled roster. Undefined when every section would be empty.
   */
  function kernelFactsFor(config: BotAgentConfig): string | undefined {
    const sections: string[] = []
    const watches = state.watches.filter(watch => watch.botId === config.id)
    if (watches.length > 0) {
      sections.push([
        '## watches',
        ...watches.map(watch => `- ${watch.sessionId}${
          watch.todoIds === undefined || watch.todoIds.length === 0 ? '' : ` (todos: ${watch.todoIds.join(', ')})`
        }`),
      ].join('\n'))
    }
    if (config.routines.length > 0) {
      sections.push([
        '## routines',
        ...config.routines.map(routine => `- ${routine.name}: every ${routine.intervalMinutes} min; last run unavailable`),
      ].join('\n'))
    }
    const peers: BotAgentConfig[] = []
    for (const entry of entries.values()) {
      const peer = entry.config
      if (peer === undefined || !peer.enabled || peer.id === config.id) continue
      peers.push(peer)
    }
    peers.sort((left, right) => left.id.localeCompare(right.id))
    if (peers.length > 0) {
      sections.push(['## roster', ...peers.map(peer => `- @${peer.id} (${peer.name})`)].join('\n'))
    }
    return sections.length === 0 ? undefined : sections.join('\n\n')
  }

  function portFor(botId: string): AgentToolPort | undefined {
    const config = entries.get(botId)?.config
    if (config === undefined) return undefined
    return {
      system: botSystemPrompt(config, entries.values()),
      tools: agentToolSpecs(config.tools),
      maxToolCalls: MAX_TOOL_CALLS,
      kernelFacts: () => kernelFactsFor(config),
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
    dispatchAfterPersist([wake])
  }

  // ─── Group conversation ──────────────────────────────────────────────────

  /** Every enabled bot, as mention resolution sees it. */
  function enabledRoster(): GroupBot[] {
    const roster: GroupBot[] = []
    for (const entry of entries.values()) {
      if (entry.config?.enabled !== true) continue
      roster.push({ id: entry.id, name: entry.config.name, enabled: true })
    }
    return roster
  }

  /** Advance one context session's reply cursor; it never moves backwards. */
  function noteGroupCursor(botId: string, sessionId: string, seq: number): void {
    const existing = state.group.cursors[sessionId]
    if (existing === undefined) {
      state.group.cursors[sessionId] = { botId, lastSeq: seq }
      return
    }
    existing.botId = botId
    if (seq > existing.lastSeq) existing.lastSeq = seq
  }

  function toWireMessage(entry: GroupTranscriptEntry): GroupMessage {
    return {
      seq: entry.seq,
      at: entry.at,
      author: entry.author,
      text: entry.text,
      ...(entry.botId === undefined ? {} : { botId: entry.botId }),
      ...(entry.name === undefined ? {} : { name: entry.name }),
    }
  }

  /**
   * Append one transcript entry under the next monotonic seq, entirely in
   * memory. A bot entry carries a source key; a key already published is
   * dropped, which is what makes startup and rotation recovery exactly-once.
   * The entry and the mention targets it derives are returned; the caller owns
   * the single snapshot that makes them durable.
   */
  function appendGroupMessage(input: {
    author: 'user' | 'bot'
    text: string
    at?: string
    botId?: string
    name?: string
    sourceKey?: string
    /** Resolve `@` mentions against this roster as part of the append. */
    mentions?: { roster: readonly GroupBot[]; selfId?: string }
  }): AppendedGroupMessage | undefined {
    if (input.sourceKey !== undefined) {
      if (state.group.published.includes(input.sourceKey)) return undefined
      state.group.published.push(input.sourceKey)
      if (state.group.published.length > GROUP_PUBLISHED_MAX) {
        state.group.published.splice(0, state.group.published.length - GROUP_PUBLISHED_MAX)
      }
    }
    const seq = state.group.seq + 1
    state.group.seq = seq
    const entry: GroupTranscriptEntry = {
      seq,
      at: input.at ?? new Date().toISOString(),
      author: input.author,
      text: input.text,
      ...(input.botId === undefined ? {} : { botId: input.botId }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.sourceKey === undefined ? {} : { sourceKey: input.sourceKey }),
    }
    state.group.messages.push(entry)
    const targets = input.mentions === undefined
      ? []
      : parseMentions(input.text, input.mentions.roster, {
        ...(input.mentions.selfId === undefined ? {} : { selfId: input.mentions.selfId }),
      })
    return { entry, targets }
  }

  /**
   * Enqueue the mentions of one published reply through the existing bot
   * message path, entirely in memory. Only an enabled sender with the `message`
   * tool reaches peers, and a target that cannot be woken is logged rather than
   * allowed to drop the reply or fail the turn that produced it. The returned
   * wakes are dispatched by the caller after its snapshot is durable.
   */
  function deliverMentions(from: string, text: string, targets: readonly string[]): Wake[] {
    const wakes: Wake[] = []
    const entry = entries.get(from)
    if (entry?.config?.enabled !== true) return wakes
    if (!entry.config.tools.includes('message')) return wakes
    for (const target of targets) {
      try {
        const wake = enqueueMessage(from, target, text)
        state.group.peerWakes[wake.id] = {
          wakeId: wake.id,
          botId: target,
          text: wake.text,
          createdAt: wake.createdAt,
        }
        wakes.push(wake)
      } catch (error) {
        log('warn', `bot agent kernel could not deliver a mention from ${from} to ${target}: ${errorText(error)}`)
      }
    }
    return wakes
  }

  /**
   * Dispatch wakes only after the snapshot that carries them has reached disk.
   * A crash before that leaves them queued in the persisted state instead of
   * admitting a turn whose publication was never written.
   */
  function dispatchAfterPersist(wakes: readonly Wake[]): void {
    if (wakes.length === 0) return
    void persistChain.then(() => {
      if (stopped) return
      for (const wake of wakes) dispatchWake(wake.botId, wake)
    })
  }

  /**
   * Publish one actual ledger reply, keyed by its session and event seq, and
   * enqueue the mentions it derives. Everything is in memory; the caller
   * persists the publication and its wakes in one snapshot. `undefined` means
   * this event published nothing.
   */
  function publishBotReply(botId: string, sessionId: string, event: ReplySentEvent): Wake[] | undefined {
    if (event.turn !== undefined && seedTurns.has(turnKey(sessionId, event.turn))) return undefined
    const published = appendGroupMessage({
      author: 'bot',
      botId,
      name: entries.get(botId)?.config?.name ?? botId,
      text: event.text,
      at: event.at,
      sourceKey: groupSourceKey(sessionId, event.seq),
      mentions: { roster: enabledRoster(), selfId: botId },
    })
    if (published === undefined) return undefined
    return deliverMentions(botId, event.text, published.targets)
  }

  /**
   * A completed turn that published no reply still carries visible final text
   * (its terminal reasoning prose). Publish it once, by turn rather than by
   * event seq, and never the raw tool intents of the turn. Its mentions are
   * delivered exactly like an actual reply's, in memory, for the caller's
   * single snapshot. `undefined` means the turn published nothing.
   */
  function publishTurnFallback(botId: string, sessionId: string, turn: number): Wake[] | undefined {
    const sourceKey = `${sessionId}:turn:${turn}:final`
    try {
      if (seedTurns.has(turnKey(sessionId, turn))) return undefined
      if (state.group.published.includes(sourceKey)) return undefined
      const events = contextSession().readLedger(sessionId)
      if (events.some(event => event.type === 'reply.sent' && event.turn === turn)) return undefined
      const text = visibleTurnAnswerOf(contextSession(), sessionId, turn)
      if (text === undefined || text.trim() === '') return undefined
      const published = appendGroupMessage({
        author: 'bot',
        botId,
        name: entries.get(botId)?.config?.name ?? botId,
        text,
        sourceKey,
        mentions: { roster: enabledRoster(), selfId: botId },
      })
      if (published === undefined) return undefined
      return deliverMentions(botId, text, published.targets)
    } catch (error) {
      log('warn', `bot agent kernel could not publish the fallback reply of ${botId}: ${errorText(error)}`)
      return undefined
    }
  }

  /**
   * Read one ledger event into the group state: advance its cursor and, for a
   * reply or a completed turn's visible answer, append the entry and enqueue
   * the mentions it derives. Nothing is persisted here; the caller writes one
   * snapshot so a cursor can never advance past an entry or wake that is not
   * durable with it.
   */
  function noteGroupEvent(botId: string, sessionId: string, event: LedgerEvent): GroupEventNote {
    noteGroupCursor(botId, sessionId, event.seq)
    let wakes: Wake[] | undefined
    if (event.type === 'reply.sent') {
      // Intermediate process updates are not group messages: one turn may emit
      // several of them, each with its own seq, so publishing them would
      // defeat the per-event dedup. Only the closing reply is published; a
      // record without `kind` predates the field and stays publishable.
      if (event.kind === 'progress') return { published: false, wakes: [] }
      wakes = publishBotReply(botId, sessionId, event)
    } else if (event.type === 'turn.finished' && event.status === 'completed' && event.turn !== undefined) {
      wakes = publishTurnFallback(botId, sessionId, event.turn)
    }
    return wakes === undefined ? { published: false, wakes: [] } : { published: true, wakes }
  }

  /** Replay a context ledger after its persisted cursor, publishing only new replies. */
  function processGroupEvents(botId: string, sessionId: string, events: readonly LedgerEvent[]): void {
    const from = state.group.cursors[sessionId]?.lastSeq ?? 0
    let last = from
    const wakes: Wake[] = []
    for (const event of events) {
      if (event.seq <= last) continue
      last = event.seq
      for (const wake of noteGroupEvent(botId, sessionId, event).wakes) wakes.push(wake)
    }
    if (last === from) return
    // One snapshot carries the advanced cursor, every publication of the batch
    // and every wake they derived; the wakes are admitted only afterwards.
    persist()
    dispatchAfterPersist(wakes)
  }

  /**
   * Follow one bot context ledger. It is attached before a wake is sent so no
   * reply can be produced before its publication path exists. A pure cursor
   * advance is not written on its own: replay re-reads it harmlessly. A
   * publication writes one snapshot holding the cursor, the entry and its
   * derived wakes, so a live event can never durably move the cursor past an
   * unpublished reply.
   */
  function subscribeGroupReplies(botId: string, sessionId: string): void {
    if (replySubs.has(sessionId)) return
    replySubs.set(sessionId, contextSession().subscribe(sessionId, event => {
      if (event.seq <= (state.group.cursors[sessionId]?.lastSeq ?? 0)) return
      const note = noteGroupEvent(botId, sessionId, event)
      if (!note.published) return
      persist()
      dispatchAfterPersist(note.wakes)
    }))
  }

  function lastLedgerSeq(sessionId: string): number {
    try {
      return contextSession().readLedger(sessionId).at(-1)?.seq ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Resume every known context ledger after its persisted cursor. A context
   * that predates the group transcript is primed to its current end instead, so
   * old private history is never replayed into the group.
   */
  function restoreGroupReplies(): void {
    for (const [botId, bot] of Object.entries(state.bots)) {
      if (bot.sessionId === undefined) continue
      if (state.group.cursors[bot.sessionId] === undefined) {
        noteGroupCursor(botId, bot.sessionId, lastLedgerSeq(bot.sessionId))
      }
    }
    for (const [sessionId, cursor] of Object.entries({ ...state.group.cursors })) {
      subscribeGroupReplies(cursor.botId, sessionId)
      try {
        processGroupEvents(cursor.botId, sessionId, contextSession().readLedger(sessionId))
      } catch (error) {
        log('warn', `bot agent kernel could not recover replies of session ${sessionId}: ${errorText(error)}`)
      }
    }
  }

  /**
   * Peer wakes are already in their bot queues; the record only bridges a
   * restart that happened between enqueue and admission. Reconstruct a queue
   * entry that is missing, then let the normal pending-wake dispatch run.
   */
  function restorePeerWakes(): void {
    for (const record of Object.values(state.group.peerWakes)) {
      const bot = state.bots[record.botId]
      if (bot === undefined) continue
      if (bot.queue.some(wake => wake.id === record.wakeId)) continue
      bot.queue.push({
        id: record.wakeId,
        botId: record.botId,
        source: 'message',
        text: record.text,
        createdAt: record.createdAt,
      })
    }
    state.group.peerWakes = {}
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
      seedTurns.add(turnKey(newSessionId, turn))
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
    // The seed is kernel bookkeeping, not conversation: mark everything it
    // wrote as already read, then follow the fresh ledger for real replies.
    noteGroupCursor(botId, newSessionId, lastLedgerSeq(newSessionId))
    subscribeGroupReplies(botId, newSessionId)
    persist()
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
    // Attach the publication path before any turn can run on the new ledger.
    subscribeGroupReplies(botId, sessionId)
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
    if (state.group.peerWakes[wakeId] !== undefined) delete state.group.peerWakes[wakeId]
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
      // A turn that already published its final answer is never re-sent: the
      // retry would produce a fresh reply and publish it to the group again.
      const alreadyPublished = contextSession().readLedger(sessionId)
        .some(event => event.type === 'reply.sent' && event.turn === failedTurn && event.kind !== 'progress')
      if (alreadyPublished) {
        removePendingWake(botId, wake.id)
        finishWakeTurn(botId, wake, sessionId, {
          turn: failedTurn,
          status: 'failed',
          error: 'the failed turn already published its final reply',
        })
        return
      }
      pendingWake(botId, wake)
      await persistChain
      if (stopped) return
      subscribeGroupReplies(botId, sessionId)
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
    subscribeGroupReplies(botId, sessionId)
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
      const routes = await options.selectModels()
      if (stopped) return
      if (routes.length === 0) throw new Error('no bot model available from automatic routing')
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

  /**
   * Whether one loaded entry carries the same signature and error as the entry
   * applied before. A changed signature includes a file that was unreadable and
   * now reads, so a recovered error reconciles like an edit.
   */
  function sameEntry(previous: BotAgentEntry | undefined, entry: BotAgentEntry): boolean {
    if (previous === undefined) return false
    return previous.error === entry.error
      && previous.signature.mtimeMs === entry.signature.mtimeMs
      && previous.signature.ctimeMs === entry.signature.ctimeMs
      && previous.signature.size === entry.signature.size
      && previous.signature.ino === entry.signature.ino
  }

  /**
   * Adopt a fresh config load: reconcile the routines of every changed valid
   * bot, drop those of a bot whose file was removed, and leave an invalid file
   * owning only its own error.
   */
  async function applyConfigs(loaded: BotAgentEntry[], previous: ReadonlyMap<string, BotAgentEntry>): Promise<void> {
    const loadedIds = new Set(loaded.map(entry => entry.id))
    const removed = [...previous.keys()].filter(id => !loadedIds.has(id))
    entries.clear()
    for (const entry of loaded) entries.set(entry.id, entry)
    for (const entry of loaded) {
      // A stop that began while this load ran applies no further config.
      if (stopped) return
      if (entry.config === undefined || sameEntry(previous.get(entry.id), entry)) continue
      try {
        await options.routines.reconcile(entry.id, entry.config.routines)
      } catch (error) {
        log('warn', `bot agent kernel could not reconcile the routines of ${entry.id}: ${errorText(error)}`)
      }
    }
    for (const id of removed) {
      if (stopped) return
      try {
        await options.routines.reconcile(id, [])
      } catch (error) {
        log('warn', `bot agent kernel could not drop the routines of removed bot ${id}: ${errorText(error)}`)
      }
    }
  }

  /**
   * Reload the config directory once. Concurrent callers share the in-flight
   * load; the previous entries are handed to the loader so unchanged files are
   * returned, not read again.
   */
  function reloadConfigs(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (refreshPromise !== undefined) return refreshPromise
    const running = (async (): Promise<void> => {
      const previous = new Map(entries)
      const loaded = await loadBotAgentConfigs(options.configDir, [...previous.values()])
      if (stopped) return
      const unchanged = previous.size === loaded.length
        && loaded.every(entry => previous.get(entry.id) === entry)
      if (unchanged) return
      await applyConfigs(loaded, previous)
    })()
    refreshPromise = running
    const settle = (): void => {
      if (refreshPromise === running) refreshPromise = undefined
    }
    void running.then(settle, settle)
    return running
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
    dispatchAfterPersist([wake])
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
          state.group = loaded.group
        })
      } catch {
        // No state yet (or an unreadable one): every bot starts with an empty queue.
      }
      await reloadConfigs()
      // A stop may have begun while the configs were loading: schedule no
      // watches, wakes or poll timer after it.
      if (stopped) return
      await restoreWatches()
      if (stopped) return
      restoreRoundTurns()
      restoreGroupReplies()
      restorePeerWakes()
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
        // A reload already reading the directory settles before stop returns;
        // it starts no reconcile once `stopped` is set.
        const refresh = refreshPromise
        if (refresh !== undefined) {
          await refresh.catch(error => {
            log('warn', `bot agent kernel could not finish a config reload during stop: ${errorText(error)}`)
          })
        }
        for (const unsubscribe of replySubs.values()) unsubscribe()
        replySubs.clear()
        seedTurns.clear()
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

    groupEvents(input: GroupEventsInput): GroupEventsPage {
      const afterSeq = typeof input.afterSeq === 'number' && Number.isInteger(input.afterSeq) && input.afterSeq > 0
        ? input.afterSeq
        : 0
      const requested = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
        ? input.limit
        : GROUP_PAGE_SIZE
      const limit = Math.min(GROUP_PAGE_MAX, requested)
      const messages = state.group.messages
        .filter(message => message.seq > afterSeq)
        .slice(0, limit)
        .map(toWireMessage)
      const lastSeq = messages.length > 0
        ? messages[messages.length - 1]!.seq
        : Math.min(afterSeq, state.group.seq)
      return { messages, lastSeq }
    },

    groupSend(text: string): GroupSendResult {
      // The user message and every wake it derives are one in-memory
      // transition: a single snapshot publishes both, or neither.
      const published = appendGroupMessage({ author: 'user', text, mentions: { roster: enabledRoster() } })
      if (published === undefined) {
        throw new BotAgentError('agent_invalid', 'the group message could not be published')
      }
      const awakened: string[] = []
      const wakes: Wake[] = []
      for (const target of published.targets) {
        try {
          requireBot(target)
          const wake = enqueue(target, { source: 'user', text: `[wake:user] ${text}` })
          wakes.push(wake)
          awakened.push(target)
        } catch (error) {
          log('warn', `bot agent kernel could not wake ${target} for a group message: ${errorText(error)}`)
        }
      }
      persist()
      dispatchAfterPersist(wakes)
      return { message: toWireMessage(published.entry), awakened }
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
