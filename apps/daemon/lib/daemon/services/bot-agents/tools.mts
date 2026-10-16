/**
 * Bot agent tools.
 *
 * The specs the model is offered and the executor behind them. Every tool is a
 * thin adapter over a daemon service the bot may not touch directly: the
 * workspace session service, the workspace todo service, and the kernel itself
 * for a message to another bot. The executor never throws — a bad argument
 * payload, an unknown operation or a service failure becomes a `failed` result
 * the model reads and can correct.
 */

import type { AuxiliaryRoute, Session, ToolSpec, TurnModel } from '@wrenyard/session'
import type { TodoStatus, WorkspaceTodoService } from '../workspace-todo-service.mts'
import type { AgentToolName } from './config.mts'

/** One ranked model route a bot may run a session on. */
export interface AgentModelRoute {
  provider: string
  model: string
  /** Explicit public reasoning level the route runs at. */
  reasoningEffort: AuxiliaryRoute['reasoningEffort']
}

/**
 * The kernel surface the executors call back into. The kernel owns the wake
 * queue, the watches and the other bots, so a tool never reaches them directly.
 */
export interface AgentToolContext {
  /** The bot that owns the running turn; the sender of a `message` call. */
  botId: string
  /** Watch one session: its next finished turn after `afterTurn` wakes this bot. */
  watch(sessionId: string, afterTurn: number): void
  /** Wake another bot with a message; throws when the target cannot be woken. */
  message(to: string, text: string): void
  /** Models this bot may not run a session on, as configured. */
  denyModels: readonly string[]
  /** The ranked model routes this bot may run on, best first. */
  selectModels(): Promise<readonly AgentModelRoute[]>
}

/** What one tool call returns: a JSON payload, or the failure text. */
type ToolOutcome = { status: 'done' | 'failed'; result: string }

/** How many workspace sessions one `list` call reports. */
const MAX_LISTED_SESSIONS = 30
/** How many of the newest conversation entries one `read` call reports. */
const MAX_READ_MESSAGES = 6
/** Longest text one `read` entry may carry. */
const MAX_MESSAGE_CHARS = 1_500

const SESSION_TOOL: ToolSpec = {
  name: 'session',
  description: [
    'Manage the Wrenyard work sessions of this workspace.',
    'A session is a full work session: it can read registered projects, dispatch tasks and edit code,',
    'so state the project and the worktree you want it to work in inside the message text.',
    'Sessions you create or message are watched: when such a session finishes its next turn you are woken',
    'with its outcome, so after starting work end your turn instead of polling.',
    'Models on this bot deny list are refused, both when named explicitly and when inherited from the session.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'create', 'send', 'read', 'stop'],
        description: 'list the newest sessions, create one, send it a message, read its last messages, or stop its running turn.',
      },
      sessionId: {
        type: 'string',
        description: 'The session to act on; required for send, read and stop, and returned by list and create.',
      },
      text: {
        type: 'string',
        description: 'Message text: the first message for create, or the next message for send.',
      },
      model: {
        type: 'string',
        description: "Optional public model id in 'provider/model' form. Defaults to the model the session already uses, otherwise automatic routing.",
      },
      reasoningEffort: {
        type: 'string',
        description: "Optional reasoning level for the chosen model; defaults to the route's own level.",
      },
    },
    required: ['op'],
  },
}

const TODO_TOOL: ToolSpec = {
  name: 'todo',
  description: [
    'Manage the built-in workspace todos, the same store the `wrenyard todo` command uses.',
    'A todo carries a title, a request and its acceptance criteria; its status moves from open through',
    'in_progress and done to accepted, or to cancelled.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'show', 'add', 'set_status', 'annotate'],
        description: 'list every todo, show one in full, add a new one, change one status, or record an execution summary on one.',
      },
      id: {
        type: 'string',
        description: 'Todo id; required for show, set_status and annotate.',
      },
      title: {
        type: 'string',
        description: 'Title of the new todo; required for add.',
      },
      request: {
        type: 'string',
        description: 'What the todo asks for, the Request section; add only.',
      },
      acceptance: {
        type: 'string',
        description: 'How completion is judged, the Acceptance criteria section; add only.',
      },
      project: {
        type: 'string',
        description: 'Optional registered project the todo belongs to; add only.',
      },
      status: {
        type: 'string',
        enum: ['open', 'in_progress', 'done', 'accepted', 'cancelled'],
        description: 'New status; required for set_status.',
      },
      text: {
        type: 'string',
        description: 'The result summary to record; required for annotate.',
      },
    },
    required: ['op'],
  },
}

const MESSAGE_TOOL: ToolSpec = {
  name: 'message',
  description: [
    'Send a message to another bot by its id.',
    'The target bot is woken with the message and both conversations record it.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Id of the target bot.' },
      text: { type: 'string', description: 'The message text the target bot is woken with.' },
    },
    required: ['to', 'text'],
  },
}

const TOOL_SPECS: Readonly<Record<AgentToolName, ToolSpec>> = {
  session: SESSION_TOOL,
  todo: TODO_TOOL,
  message: MESSAGE_TOOL,
}

/** The specs of the enabled tools, in the order the config lists them. */
export function agentToolSpecs(tools: readonly AgentToolName[]): ToolSpec[] {
  const specs: ToolSpec[] = []
  for (const name of tools) {
    const spec = TOOL_SPECS[name]
    if (spec !== undefined) specs.push(spec)
  }
  return specs
}

/**
 * Build the tool executor over the daemon services. The returned function maps
 * one model tool call onto one `done` payload or one `failed` message and never
 * throws.
 */
export function createAgentToolRunner(deps: {
  sessions: Session
  todos: WorkspaceTodoService
}): (call: { name: string; arguments: string }, ctx: AgentToolContext) => Promise<ToolOutcome> {
  return async (call, ctx) => {
    try {
      switch (call.name) {
        case 'session':
          return await runSessionTool(parseArguments(call.arguments), deps, ctx)
        case 'todo':
          return await runTodoTool(parseArguments(call.arguments), deps)
        case 'message':
          return runMessageTool(parseArguments(call.arguments), ctx)
        default:
          return failed(`unknown tool: ${call.name}`)
      }
    } catch (error) {
      return failed(errorText(error))
    }
  }
}

// ─── Shared helpers ────────────────────────────────────────────────────────

function done(payload: unknown): ToolOutcome {
  return { status: 'done', result: JSON.stringify(payload) }
}

function failed(message: string): ToolOutcome {
  return { status: 'failed', result: message }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one call's raw arguments; malformed JSON and a non-object payload fail. */
function parseArguments(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim() === '' ? '{}' : raw)
  } catch {
    throw new Error('arguments must be valid JSON')
  }
  if (!isPlainObject(parsed)) throw new Error('arguments must be a JSON object')
  return parsed
}

function requireString(args: Record<string, unknown>, key: string, message: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message)
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} must be a nonempty string`)
  return value
}

function truncate(text: string): string {
  return text.length <= MAX_MESSAGE_CHARS ? text : text.slice(0, MAX_MESSAGE_CHARS)
}

// ─── session tool ──────────────────────────────────────────────────────────

interface SessionListRow {
  sessionId: string
  title: string
  running: boolean
  lastTurn: string | null
  updatedAt: string
}

interface SessionReadResult {
  running: boolean
  lastTurn: string | null
  messages: { role: 'user' | 'reply'; text: string }[]
}

async function runSessionTool(
  args: Record<string, unknown>,
  deps: { sessions: Session },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  switch (args.op) {
    case 'list':
      return done(listSessions(deps.sessions))
    case 'create': {
      const text = optionalString(args, 'text')
      const { sessionId } = await deps.sessions.createSession()
      if (text === undefined) return done({ sessionId })
      try {
        const model = await resolveSessionModel(deps.sessions, sessionId, args, ctx)
        const { turn } = await deps.sessions.send(sessionId, { text, model })
        ctx.watch(sessionId, turn - 1)
        return done({ sessionId, turn })
      } catch (error) {
        // A create whose first message fails must leave no empty orphan session
        // behind: delete the session just created and report the original
        // failure. A failed delete is ignored and never replaces that error.
        await deps.sessions.deleteSession(sessionId).catch(() => {})
        return failed(errorText(error))
      }
    }
    case 'send': {
      const sessionId = requireString(args, 'sessionId', 'send requires sessionId')
      const text = requireString(args, 'text', 'send requires text')
      const model = await resolveSessionModel(deps.sessions, sessionId, args, ctx)
      const { turn } = await deps.sessions.send(sessionId, { text, model })
      ctx.watch(sessionId, turn - 1)
      return done({ turn })
    }
    case 'read': {
      const sessionId = requireString(args, 'sessionId', 'read requires sessionId')
      return done(readSession(deps.sessions, sessionId))
    }
    case 'stop': {
      const sessionId = requireString(args, 'sessionId', 'stop requires sessionId')
      return done(await stopSession(deps.sessions, sessionId))
    }
    default:
      return failed(`unsupported session op: ${String(args.op)}`)
  }
}

/** The newest sessions of the workspace, newest first. */
function listSessions(sessions: Session): SessionListRow[] {
  return sessions
    .listSessions()
    .map(summary => ({
      sessionId: summary.sessionId,
      title: summary.title,
      running: summary.running === true,
      lastTurn: summary.lastTurn === undefined ? null : summary.lastTurn.status,
      updatedAt: summary.updatedAt,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_LISTED_SESSIONS)
}

/**
 * Status plus the tail of one session's conversation. Whether the session is
 * running is derived from the ledger the same way the session feature derives a
 * turn's number: a `turn.started` whose number has no matching `turn.finished`
 * is still in flight, and the newest such number is the turn to stop.
 */
function readSession(sessions: Session, sessionId: string): SessionReadResult {
  const events = sessions.readLedger(sessionId)
  const started = new Set<number>()
  const finished = new Set<number>()
  const messages: { role: 'user' | 'reply'; text: string }[] = []
  for (const event of events) {
    if (event.type === 'turn.started') {
      if (event.turn !== undefined) started.add(event.turn)
      messages.push({ role: 'user', text: truncate(event.text) })
    } else if (event.type === 'turn.finished') {
      if (event.turn !== undefined) finished.add(event.turn)
    } else if (event.type === 'reply.sent') {
      messages.push({ role: 'reply', text: truncate(event.text) })
    }
  }
  let running = false
  for (const turn of started) {
    if (!finished.has(turn)) {
      running = true
      break
    }
  }
  const summary = sessions.listSessions().find(candidate => candidate.sessionId === sessionId)
  return {
    running,
    lastTurn: summary?.lastTurn === undefined ? null : summary.lastTurn.status,
    messages: messages.slice(-MAX_READ_MESSAGES),
  }
}

/** Interrupt the newest turn that started and never finished. */
async function stopSession(sessions: Session, sessionId: string): Promise<{ stopped: boolean }> {
  const started = new Set<number>()
  const finished = new Set<number>()
  for (const event of sessions.readLedger(sessionId)) {
    if (event.turn === undefined) continue
    if (event.type === 'turn.started') started.add(event.turn)
    else if (event.type === 'turn.finished') finished.add(event.turn)
  }
  let latest: number | undefined
  for (const turn of started) {
    if (finished.has(turn)) continue
    if (latest === undefined || turn > latest) latest = turn
  }
  if (latest === undefined) return { stopped: false }
  await sessions.interrupt(sessionId, latest)
  return { stopped: true }
}

/**
 * The model one send runs on. An explicit `model` argument wins unless the bot
 * denies it, then the model the session's newest started turn already used
 * unless the bot denies that too, then the first ranked route the bot allows.
 * The reasoning level is the explicit argument, then the chosen route's own
 * level, then `medium`; with no allowed route the send fails.
 */
async function resolveSessionModel(
  sessions: Session,
  sessionId: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<AgentModelRoute> {
  const explicitModel = optionalString(args, 'model')
  const explicitEffort = effortOf(optionalString(args, 'reasoningEffort'))
  // The ranked routes are fetched at most once, and only when routing is used.
  let ranked: readonly AgentModelRoute[] | undefined
  const rankedRoutes = async (): Promise<readonly AgentModelRoute[]> => {
    if (ranked === undefined) ranked = await ctx.selectModels()
    return ranked
  }
  const allowedRoute = async (): Promise<AgentModelRoute | undefined> =>
    (await rankedRoutes()).find(route => !isDenied(route, ctx.denyModels))

  if (explicitModel !== undefined) {
    const split = splitModelId(explicitModel)
    if (split === undefined) throw new Error("model must be a 'provider/model' id")
    if (isDenied(split, ctx.denyModels)) throw new Error(`model ${explicitModel} is denied for this bot`)
    // The reasoning level belongs to the named model alone: an unrelated route
    // never lends its level to an explicitly chosen model. When the named model
    // has no route of its own the neutral default applies.
    const ownEffort = explicitEffort === undefined
      ? (await rankedRoutes()).find(route => `${route.provider}/${route.model}` === explicitModel)?.reasoningEffort
      : undefined
    return {
      provider: split.provider,
      model: split.model,
      reasoningEffort: explicitEffort ?? ownEffort ?? 'medium',
    }
  }

  const current = currentSessionModel(sessions, sessionId)
  if (current !== undefined && !isDenied(current, ctx.denyModels)) {
    return {
      provider: current.provider,
      model: current.model,
      reasoningEffort: explicitEffort ?? current.reasoningEffort ?? (await allowedRoute())?.reasoningEffort ?? 'medium',
    }
  }

  const route = await allowedRoute()
  if (route === undefined) throw new Error('no allowed model available')
  return route
}

/**
 * Whether one model is on the bot's deny list. An entry in `provider/model`
 * form matches the whole id and a bare entry matches the model id alone; both
 * comparisons ignore case.
 */
export function isDenied(model: { provider: string; model: string }, denyModels: readonly string[]): boolean {
  const full = `${model.provider}/${model.model}`.toLowerCase()
  const bare = model.model.toLowerCase()
  for (const entry of denyModels) {
    const candidate = entry.toLowerCase()
    if (candidate.includes('/') ? candidate === full : candidate === bare) return true
  }
  return false
}

/** The model a session's newest started turn ran on, as `turn.started` recorded it. */
function currentSessionModel(sessions: Session, sessionId: string): TurnModel | undefined {
  let newestTurn: number | undefined
  let newest: TurnModel | undefined
  for (const event of sessions.readLedger(sessionId)) {
    if (event.type !== 'turn.started' || event.turn === undefined) continue
    if (newestTurn === undefined || event.turn > newestTurn) {
      newestTurn = event.turn
      newest = event.model
    }
  }
  return newest
}

/** Split one public `provider/model` id at its first slash. */
function splitModelId(value: string): { provider: string; model: string } | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/** Read an explicit effort argument onto the session effort vocabulary. */
function effortOf(value: string | undefined): AuxiliaryRoute['reasoningEffort'] | undefined {
  return value === undefined ? undefined : (value as AuxiliaryRoute['reasoningEffort'])
}

// ─── todo tool ─────────────────────────────────────────────────────────────

async function runTodoTool(
  args: Record<string, unknown>,
  deps: { todos: WorkspaceTodoService },
): Promise<ToolOutcome> {
  switch (args.op) {
    case 'list': {
      const todos = await deps.todos.listTodos()
      return done(todos.map(todo => ({
        id: todo.id,
        title: todo.title,
        status: todo.status,
        project: todo.project ?? null,
        updated: todo.updated,
      })))
    }
    case 'show': {
      const id = requireString(args, 'id', 'show requires id')
      const todo = await deps.todos.getTodo(id)
      return done({
        id: todo.id,
        title: todo.title,
        status: todo.status,
        project: todo.project ?? null,
        request: todo.request,
        acceptance: todo.acceptance,
        resultSummary: todo.resultSummary ?? null,
        updated: todo.updated,
      })
    }
    case 'add': {
      const title = requireString(args, 'title', 'add requires title')
      const request = optionalString(args, 'request')
      const acceptance = optionalString(args, 'acceptance')
      const project = optionalString(args, 'project')
      const todo = await deps.todos.createTodo({
        title,
        ...(request === undefined ? {} : { request }),
        ...(acceptance === undefined ? {} : { acceptance }),
        ...(project === undefined ? {} : { project }),
      })
      return done({ id: todo.id, status: todo.status })
    }
    case 'set_status': {
      const id = requireString(args, 'id', 'set_status requires id')
      const status = requireString(args, 'status', 'set_status requires status')
      const todo = await deps.todos.updateTodo({ id, status: status as TodoStatus })
      return done({ id: todo.id, status: todo.status })
    }
    case 'annotate': {
      const id = requireString(args, 'id', 'annotate requires id')
      const text = requireString(args, 'text', 'annotate requires text')
      await deps.todos.annotateTodo(id, text)
      return done({ id })
    }
    default:
      return failed(`unsupported todo op: ${String(args.op)}`)
  }
}

// ─── message tool ──────────────────────────────────────────────────────────

/** Wake another bot. A target the kernel refuses to wake surfaces as a failure. */
function runMessageTool(args: Record<string, unknown>, ctx: AgentToolContext): ToolOutcome {
  const to = requireString(args, 'to', 'message requires to')
  const text = requireString(args, 'text', 'message requires text')
  ctx.message(to, text)
  return done({ to })
}
