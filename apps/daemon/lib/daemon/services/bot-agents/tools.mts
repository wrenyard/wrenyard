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

import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createWorkspaceMemory,
  type AuxiliaryRoute,
  type Session,
  type ToolSpec,
  type TurnModel,
  type WorkspaceMemoryPort,
} from '@wrenyard/session'
import { errorTooltip } from '@wrenyard/session/session-status'
import type { TodoStatus, WorkspaceTodoService } from '../workspace-todo-service.mts'
import {
  assertRealInside,
  formatIdentity,
  parseIdentity,
  type AgentToolName,
  type BotAgentIdentity,
} from './config.mts'
import { newRoutineId, readRoutines, removeRoutine, writeRoutine, type RoutineDefinition } from './routine-files.mts'

/** One ranked model route a bot may run a session on. */
export interface AgentModelRoute {
  provider: string
  model: string
  /** Explicit public reasoning level the route runs at. */
  reasoningEffort: AuxiliaryRoute['reasoningEffort']
  /** Smallest known context window of the route's model, when resolved. */
  contextWindow?: number
  /** Largest output the route's model may produce, when resolved. */
  maxOutputTokens?: number
}

/**
 * The kernel surface the executors call back into. The kernel owns the wake
 * queue, the watches and the other bots, so a tool never reaches them directly.
 */
export interface AgentToolContext {
  /** The bot that owns the running turn; the sender of a `message` call. */
  botId: string
  /** The bot definition directory; identity and memory live inside it. */
  directory: string
  /** This device's routine files of the bot. */
  routinesDir: string
  /** The workspace root the `workspace` tool operates on. */
  workspaceRoot: string
  /** Adopt a freshly written identity in the running kernel. */
  refreshIdentity(identity: BotAgentIdentity): void
  /** Watch one session: its next finished turn after `afterTurn` wakes this bot. */
  watch(sessionId: string, afterTurn: number, todoIds?: string[]): void
  /** Wake another bot with a message; throws when the target cannot be woken. */
  message(to: string, text: string): void
  /** Drop every watch of one session, so its turns can no longer wake this bot. */
  removeWatches(sessionId: string): void
  /** The ranked model routes this bot may run on, best first. */
  selectModels(): Promise<readonly AgentModelRoute[]>
  /** True when a session model's route may be called now. */
  isModelUsable(provider: string, model: string): boolean
}

/** What one tool call returns: a JSON payload, or the failure text. */
type ToolOutcome = { status: 'done' | 'failed'; result: string }

/** How many workspace sessions one `list` call reports. */
const MAX_LISTED_SESSIONS = 30

const SESSION_TOOL: ToolSpec = {
  name: 'session',
  description: [
    'Manage the Wrenyard work sessions of this workspace.',
    'A session is a full work session: it can read registered projects, dispatch tasks and edit code,',
    'so state the project and the worktree you want it to work in inside the message text.',
    'Sessions you create or message are watched: when such a session finishes its next turn you are woken',
    'with its full turn answer.',
    'When a session carries one or more workspace todos, pass their ids in todoIds (a single id or an array)',
    'so the watch records that association and it survives a context rotation of your own conversation.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'create', 'send', 'interrupt'],
        description: 'list the newest sessions, create one, send it a message, or interrupt its running turn.',
      },
      sessionId: {
        type: 'string',
        description: 'The session to act on; required for send and interrupt, and returned by list and create.',
      },
      text: {
        type: 'string',
        description: 'Message text: the first message for create, or the next message for send.',
      },
      todoIds: {
        anyOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: "Optional todo id(s) this session works on, as a single id or an array; recorded on the watch so the association survives a context rotation.",
      },
    },
    required: ['op'],
  },
}

const TODO_TOOL: ToolSpec = {
  name: 'todo',
  description: [
    'Manage the built-in workspace todos, the same store the `wrenyard todo` command uses.',
    'A todo carries descriptions, metadata, tags and an append-only comment timeline; descriptions require exact old text when changed.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'show', 'add', 'set_status', 'update', 'comment', 'delete_comment', 'tag', 'untag'],
        description: 'List, show, create, change status, update descriptions with old text, append/delete own comments, or add/remove tags.',
      },
      id: {
        type: 'string',
        description: 'Todo id for the operation.',
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
        enum: ['open', 'in_progress', 'done', 'cancelled'],
        description: 'New status; required for set_status.',
      },
      text: {
        type: 'string',
        description: 'Comment text for comment, or the new full description text for update.',
      },
      commentId: { type: 'string', description: 'Six character comment id for delete_comment.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add.' },
      old_title: { type: 'string', description: 'Exact current title when title changes.' },
      old_request: { type: 'string', description: 'Exact current request when request changes.' },
      old_acceptance: { type: 'string', description: 'Exact current acceptance when acceptance changes.' },
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

const MEMORY_TOOL: ToolSpec = {
  name: 'memory',
  description: [
    'Keep your own long-lived memory and identity.',
    'memories are Markdown files in your private memory directory; `list` and `read` show them,',
    '`save` creates one by name, `update` replaces an existing one, `remove` deletes one and drops',
    'its index line, and `identity` reads or rewrites your name, icon, description and role text.',
    'An updated or removed memory must carry its exact current body as `previous`;',
    'your switches are not editable here.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'read', 'save', 'update', 'remove', 'identity'],
        description: 'List memories, read one, create one, replace one, delete one, or read/update your identity.',
      },
      name: {
        type: 'string',
        description: 'Memory name for read/save/update/remove, or the new identity name for identity.',
      },
      description: {
        type: 'string',
        description: 'One-line memory description, or the identity description.',
      },
      type: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference'],
        description: 'Memory type; save and update only.',
      },
      content: {
        type: 'string',
        description: 'The memory body; save and update only.',
      },
      previous: {
        type: 'string',
        description: 'Exact current body of an existing memory; required when updating or removing it.',
      },
      icon: {
        type: 'string',
        description: 'Identity icon of at most two grapheme clusters.',
      },
      body: {
        type: 'string',
        description: 'The identity role text.',
      },
    },
    required: ['op'],
  },
}

const ROUTINE_TOOL: ToolSpec = {
  name: 'routine',
  description: [
    'Manage your own routines on this device: each fires on its interval as a [wake:routine <id>] message.',
    '`list` shows them, `create` adds one, `update` changes the given fields of one, `remove` deletes one.',
    'Keep the text a short trigger and put procedure details in a memory that the text names.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['list', 'create', 'update', 'remove'] },
      id: { type: 'string', description: 'Routine id (8 hex characters); update and remove only.' },
      name: { type: 'string', description: 'Short routine name.' },
      text: { type: 'string', description: 'The trigger text the routine wakes you with.' },
      intervalMinutes: { type: 'integer', description: 'Minutes between runs (1 to 10080); required to create.' },
      state: { type: 'string', enum: ['active', 'paused'], description: 'New routines start active.' },
    },
    required: ['op'],
  },
}

const WORKSPACE_TOOL: ToolSpec = {
  name: 'workspace',
  description: [
    'Version control of the workspace repository itself: status, diff, commit, push and pull,',
    'run through the workspace vcs auxiliary in this conversation.',
    'You may commit and push workspace changes you made yourself (your memory, your identity, todos you created or updated).',
    'Name the exact files you changed and never commit files you did not change; a commit with foreign or mismatched staged files is refused.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'A natural-language instruction, for example: commit bots/main/memory/foo.md with message "...", then push.',
      },
    },
    required: ['request'],
  },
}

const TOOL_SPECS: Readonly<Record<AgentToolName, ToolSpec>> = {
  session: SESSION_TOOL,
  todo: TODO_TOOL,
  message: MESSAGE_TOOL,
  memory: MEMORY_TOOL,
  routine: ROUTINE_TOOL,
  workspace: WORKSPACE_TOOL,
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
}): (
  call: { name: string; arguments: string },
  ctx: AgentToolContext,
) => Promise<ToolOutcome> {
  return async (call, ctx) => {
    try {
      const spec = (TOOL_SPECS as Readonly<Record<string, ToolSpec | undefined>>)[call.name]
      if (spec === undefined) return failed(`unknown tool: ${call.name}`)
      const args = parseArguments(call.arguments)
      // An argument the tool does not declare is refused, never silently
      // ignored, so a stale instruction surfaces at once.
      const declared = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const unknown = Object.keys(args).filter(key => !Object.hasOwn(declared, key))
      if (unknown.length > 0) return failed(`unknown argument: ${unknown.join(', ')}`)
      switch (call.name) {
        case 'session':
          return await runSessionTool(args, deps, ctx)
        case 'todo':
          return await runTodoTool(args, deps, ctx)
        case 'message':
          return runMessageTool(args, ctx)
        case 'memory':
          return await runMemoryTool(args, ctx)
        case 'routine':
          return await runRoutineTool(args, ctx)
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

/**
 * Optional todo id association for a watched session: a single id string or an
 * array of id strings. Empty and non-string entries are dropped; when nothing
 * usable remains the association is left undefined so an existing one is kept.
 */
function optionalTodoIds(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined
  if (entries === undefined) throw new Error(`${key} must be a todo id or an array of todo ids`)
  const ids = entries.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  return ids.length > 0 ? ids : undefined
}

// ─── session tool ──────────────────────────────────────────────────────────

interface SessionListRow {
  sessionId: string
  title: string
  running: boolean
  lastTurn: string | null
  errorKind?: string
  errorMessage?: string
  retryAt?: string
  failureDescription?: string
  updatedAt: string
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
        const model = await resolveSessionModel(deps.sessions, sessionId, ctx)
        const { turn } = await deps.sessions.send(sessionId, { text, model, sender: { botId: ctx.botId } })
        ctx.watch(sessionId, turn - 1, optionalTodoIds(args, 'todoIds'))
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
      const model = await resolveSessionModel(deps.sessions, sessionId, ctx)
      const { turn } = await deps.sessions.send(sessionId, { text, model, sender: { botId: ctx.botId } })
      ctx.watch(sessionId, turn - 1, optionalTodoIds(args, 'todoIds'))
      return done({ turn })
    }
    case 'interrupt': {
      const sessionId = requireString(args, 'sessionId', 'interrupt requires sessionId')
      return done(await stopSession(deps.sessions, sessionId, ctx))
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
      ...(summary.lastTurn?.status === 'failed' ? {
        errorKind: summary.lastTurn.errorKind,
        errorMessage: summary.lastTurn.errorMessage,
        retryAt: summary.lastTurn.retryAt,
        failureDescription: errorTooltip(summary.lastTurn),
      } : {}),
      updatedAt: summary.updatedAt,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_LISTED_SESSIONS)
}

/**
 * Interrupt the newest turn that started and never finished. Every watch of the
 * session is dropped first: a stopped session must not wake the bot afterwards,
 * and the interrupted turn therefore never arrives as a `[wake:session]`.
 */
async function stopSession(
  sessions: Session,
  sessionId: string,
  ctx: AgentToolContext,
): Promise<{ stopped: boolean }> {
  ctx.removeWatches(sessionId)
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
 * The model one send runs on. A session keeps its current model and effort
 * while that model is usable. A session without one, or whose model is now
 * excluded, exhausted or blocked, gets the first route of the system's
 * automatic selection, exactly as if a person switched the model before
 * sending; with no route the send fails. A running turn never switches model.
 */
async function resolveSessionModel(
  sessions: Session,
  sessionId: string,
  ctx: AgentToolContext,
): Promise<AgentModelRoute> {
  const current = currentSessionModel(sessions, sessionId)
  if (current !== undefined && ctx.isModelUsable(current.provider, current.model)) {
    return {
      provider: current.provider,
      model: current.model,
      reasoningEffort: current.reasoningEffort ?? 'high',
    }
  }

  const route = (await ctx.selectModels())[0]
  if (route === undefined) throw new Error('no model available from automatic routing')
  return route
}

/** The model a session's newest started turn ran on, as `turn.started` recorded it. */
function currentSessionModel(sessions: Session, sessionId: string): TurnModel | undefined {
  const events = sessions.readLedger(sessionId)
  const started = [...events].reverse().find(event => event.type === 'turn.started')
  if (started?.type !== 'turn.started') return undefined
  let model = `${started.model.provider}/${started.model.model}`
  for (const event of events) {
    if (event.turn === started.turn && event.type === 'span.finished' && event.kind === 'reasoning' && event.requestModel !== undefined) model = event.requestModel
  }
  const [provider, ...parts] = model.split('/')
  return {
    ...started.model,
    provider: provider!,
    model: parts.join('/'),
  }
}

// ─── todo tool ─────────────────────────────────────────────────────────────

async function runTodoTool(
  args: Record<string, unknown>,
  deps: { todos: WorkspaceTodoService },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  switch (args.op) {
    case 'list': {
      const tag = optionalString(args, 'tag')
      const todos = await deps.todos.listTodos(tag === undefined ? undefined : { tag })
      return done(todos.map(todo => ({
        id: todo.id,
        title: todo.title,
        status: todo.status,
        project: todo.project ?? null,
        updated: todo.updated,
        tags: todo.tags,
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
        tags: todo.tags,
        comments: todo.comments,
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
    case 'update': {
      const id = requireString(args, 'id', 'update requires id')
      const title = optionalString(args, 'title')
      const request = optionalString(args, 'request')
      const acceptance = optionalString(args, 'acceptance')
      const oldTitle = optionalString(args, 'old_title')
      const oldRequest = optionalString(args, 'old_request')
      const oldAcceptance = optionalString(args, 'old_acceptance')
      const status = optionalString(args, 'status')
      const input = {
        id,
        ...(title === undefined ? {} : { title, old_title: oldTitle }),
        ...(request === undefined ? {} : { request, old_request: oldRequest }),
        ...(acceptance === undefined ? {} : { acceptance, old_acceptance: oldAcceptance }),
        ...(status === undefined ? {} : { status: status as TodoStatus }),
      }
      const todo = await deps.todos.updateTodo(input)
      return done({ id, status: todo.status })
    }
    case 'comment': {
      const id = requireString(args, 'id', 'comment requires id')
      const text = requireString(args, 'text', 'comment requires text')
      return done(await deps.todos.appendTodoComment(id, ctx.botId, text))
    }
    case 'delete_comment': {
      const id = requireString(args, 'id', 'delete_comment requires id')
      const commentId = requireString(args, 'commentId', 'delete_comment requires commentId')
      return done(await deps.todos.deleteTodoComment(id, commentId, ctx.botId))
    }
    case 'tag': {
      const id = requireString(args, 'id', 'tag requires id')
      const tags = Array.isArray(args.tags) ? args.tags.map((tag) => {
        if (typeof tag !== 'string') throw new Error('tags must contain only strings')
        return tag
      }) : [requireString(args, 'tag', 'tag requires tag or tags')]
      return done(await deps.todos.addTodoTags(id, tags))
    }
    case 'untag': {
      const id = requireString(args, 'id', 'untag requires id')
      const tag = requireString(args, 'tag', 'untag requires tag')
      return done(await deps.todos.removeTodoTag(id, tag))
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

// ─── memory tool ───────────────────────────────────────────────────────────

/**
 * The memory store of one bot. The shared writer owns containment, symlink
 * refusal, atomic writes, the exact-previous-body guard and the index; its
 * `memory` directory name is what places the files inside this bot definition.
 * Every name is kebab-case, so it can never traverse or overwrite bot.json or
 * identity.md.
 */
function memoryOf(ctx: AgentToolContext): WorkspaceMemoryPort {
  return createWorkspaceMemory(ctx.directory, 'memory')
}

async function runMemoryTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolOutcome> {
  switch (args.op) {
    case 'list':
      return done(memoryOf(ctx).list())
    case 'read':
      return done(memoryOf(ctx).read(requireString(args, 'name', 'read requires name')))
    case 'save': {
      const name = requireString(args, 'name', 'save requires name')
      const description = requireString(args, 'description', 'save requires description')
      const type = requireString(args, 'type', 'save requires type')
      const content = requireString(args, 'content', 'save requires content')
      const previous = optionalString(args, 'previous')
      await memoryOf(ctx).save(
        { name, description, type, content, ...(previous === undefined ? {} : { previous }) },
        async () => {},
      )
      return done({ name })
    }
    case 'update': {
      const name = requireString(args, 'name', 'update requires name')
      const description = requireString(args, 'description', 'update requires description')
      const type = requireString(args, 'type', 'update requires type')
      const content = requireString(args, 'content', 'update requires content')
      const previous = optionalString(args, 'previous')
      const memory = memoryOf(ctx)
      // An update only rewrites a memory that already exists, and only when its
      // exact current body was supplied, so a blind write cannot drop content.
      if (!memory.list().some(entry => entry.name === name)) {
        throw new Error(`memory ${name} does not exist; use save to create it`)
      }
      if (previous === undefined) throw new Error('update requires previous, the exact current body')
      await memory.save({ name, description, type, content, previous }, async () => {})
      return done({ name })
    }
    case 'remove': {
      const name = requireString(args, 'name', 'remove requires name')
      const previous = optionalString(args, 'previous')
      await memoryOf(ctx).remove(
        { name, ...(previous === undefined ? {} : { previous }) },
        async () => {},
      )
      return done({ name })
    }
    case 'identity':
      return await runIdentityTool(args, ctx)
    default:
      return failed(`unsupported memory op: ${String(args.op)}`)
  }
}

type RoutineRead = NonNullable<Awaited<ReturnType<typeof readRoutines>>>

/** Resolve one routine id against the latest directory read. */
function requireRoutineId(id: string, read: RoutineRead | undefined): RoutineDefinition {
  const routine = read?.routines.find(candidate => candidate.id === id)
  if (routine !== undefined) return routine
  if (read?.invalidIds.includes(id) === true) {
    const warning = read.errors.find(message => message.startsWith(`routine ${id}.md:`))
    throw new Error(warning ?? `routine ${id}.md exists but is invalid`)
  }
  throw new Error(`routine ${id} does not exist`)
}

/**
 * The bot's own routines on this device. Each change writes or removes one
 * routine file; the scheduler picks it up on the next poll.
 */
async function runRoutineTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolOutcome> {
  const read = await readRoutines(ctx.routinesDir)
  const existing = read?.routines ?? []
  switch (args.op) {
    case 'list':
      return done(existing)
    case 'create':
    case 'update':
      return done(await writeOwnRoutine(args, read, ctx))
    case 'remove': {
      const id = requireString(args, 'id', 'remove requires id')
      requireRoutineId(id, read)
      await removeRoutine(ctx.routinesDir, id)
      return done({ removed: id })
    }
    default:
      return failed(`unsupported routine op: ${String(args.op)}`)
  }
}

/** Create a routine, or change the given fields of an existing one. */
async function writeOwnRoutine(
  args: Record<string, unknown>,
  read: RoutineRead | undefined,
  ctx: AgentToolContext,
): Promise<RoutineDefinition> {
  const existing = read?.routines ?? []
  const id = args.op === 'update' ? requireString(args, 'id', 'update requires id') : undefined
  const name = optionalString(args, 'name')
  const prompt = optionalString(args, 'text')
  const interval = args.intervalMinutes
  if (interval !== undefined && typeof interval !== 'number') throw new Error('intervalMinutes must be an integer')
  const state = optionalString(args, 'state')
  if (state !== undefined && state !== 'active' && state !== 'paused') throw new Error('state must be active or paused')
  if (id === undefined) {
    if (prompt === undefined) throw new Error('create requires text')
    if (interval === undefined) throw new Error('create requires intervalMinutes')
    return await writeRoutine(ctx.routinesDir, {
      id: newRoutineId(existing.map(routine => routine.id)),
      ...(name === undefined ? {} : { name }),
      intervalMinutes: interval,
      state: state ?? 'active',
      prompt,
    })
  }
  const current = requireRoutineId(id, read)
  return await writeRoutine(ctx.routinesDir, {
    ...current,
    ...(name === undefined ? {} : { name }),
    ...(interval === undefined ? {} : { intervalMinutes: interval }),
    ...(state === undefined ? {} : { state }),
    ...(prompt === undefined ? {} : { prompt }),
  })
}

/**
 * Read identity.md, or atomically rewrite only the supplied fields. It writes
 * nothing but identity.md and never touches bot.json.
 */
async function runIdentityTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolOutcome> {
  const path = join(ctx.directory, 'identity.md')
  const info = await lstat(path)
  if (!info.isFile()) throw new Error('identity.md is a symlink or not a regular file')
  await assertRealInside(ctx.directory, path)
  const current = parseIdentity(await readFile(path, 'utf-8'))

  const hasName = args.name !== undefined
  const hasIcon = args.icon !== undefined
  const hasDescription = args.description !== undefined
  const hasBody = args.body !== undefined
  if (!hasName && !hasIcon && !hasDescription && !hasBody) {
    return done(current)
  }

  let name = current.name
  if (hasName) {
    if (typeof args.name !== 'string' || args.name.trim() === '' || /[\r\n\0]/u.test(args.name)) {
      throw new Error('identity name must be one nonempty line')
    }
    name = args.name.trim()
  }
  let icon = current.icon
  if (hasIcon) {
    if (typeof args.icon !== 'string') throw new Error('identity icon must be a string')
    icon = args.icon.trim() === '' ? undefined : args.icon.trim()
  }
  let description = current.description
  if (hasDescription) {
    if (typeof args.description !== 'string' || /[\r\n\0]/u.test(args.description)) {
      throw new Error('identity description must be one line')
    }
    description = args.description.trim() === '' ? undefined : args.description.trim()
  }
  const body = hasBody
    ? (typeof args.body === 'string' ? args.body.trim() : '')
    : current.body
  const next: BotAgentIdentity = {
    name,
    ...(icon === undefined ? {} : { icon }),
    ...(description === undefined ? {} : { description }),
    body,
  }
  const text = formatIdentity(next)
  // Re-parse what is about to be written so the same validation the loader
  // applies also guards the write.
  const validated = parseIdentity(text)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  ctx.refreshIdentity(validated)
  return done(validated)
}
