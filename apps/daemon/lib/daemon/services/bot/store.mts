import { randomBytes } from 'node:crypto'
import type { ForemanDatabase } from '../../../db/types.mts'
import type {
  BotAcceptanceCheck,
  BotHealthError,
  BotItemRecord,
  BotLogRecord,
  BotMode,
  BotModel,
  BotRecord,
  BotState,
} from '../../../protocol/methods/bot.mts'
import {
  assertItemTransition,
  requiresDeliveryLane,
  type BotItemState,
  type BotStepKind,
  type BotStepStatus,
} from './machine.mts'

/**
 * Store for Bot mode over the daemon database: bots, their items, the
 * idempotent step journal, the bounded per-bot log and the per-project delivery
 * lane.
 *
 * `beginStep` and `finishStep` are transactional internally: a pending step and
 * the item's state are written in one transaction, and the step's terminal
 * status plus the next item state in another, so a crash can never leave a
 * recorded effect without its state (or the reverse). Transitions are validated
 * through the machine module, so an illegal move throws instead of being stored.
 *
 * This store is the single owner of the delivery-lane rule: every item state
 * write (`transitionItem`, `patchItem`, `beginStep` and `finishStep` patches)
 * acquires the lane when the item enters the lane range (`accepting`..
 * `completing`) from outside it, or throws {@link BotLaneBusyError} without
 * writing, and releases it when the item leaves the lane range. Because the
 * rule always runs inside the same transaction as the state write, no caller
 * can move an item into or out of a lane state without keeping the lane
 * consistent.
 */

/** One journal row. */
export interface BotStepRecord {
  id: string
  itemId: string
  idemKey: string
  kind: BotStepKind
  status: BotStepStatus
  input?: string
  output?: string
  error?: string
  startedAt?: string
  finishedAt?: string
}

/** One held project delivery lane. */
export interface BotLaneRecord {
  workspaceRoot: string
  project: string
  botId: string
  itemId: string
  acquiredAt: string
}

/** Mutable item columns. `null` clears a nullable column. */
export interface BotItemPatch {
  state?: BotItemState
  parkedFrom?: BotItemState | null
  question?: string | null
  answer?: string | null
  project?: string | null
  class?: string | null
  fingerprint?: string | null
  title?: string | null
  body?: string | null
  sessionId?: string | null
  sessionModel?: BotModel | null
  worktreeId?: string | null
  branch?: string | null
  headSha?: string | null
  mergedSha?: string | null
  acceptance?: BotAcceptanceCheck[] | null
  counters?: Record<string, number> | null
  error?: string | null
  dryRun?: boolean
}

/** Mutable bot columns. */
export interface BotPatch {
  name?: string
  configPath?: string | null
  configHash?: string | null
  state?: BotState
  mode?: BotMode
  lastTickAt?: string | null
  nextPollAt?: string | null
}

export interface BotHealthCounters {
  itemsByState: Record<string, number>
  stepsFailed24h: number
  adapterErrors24h: number
  escalations24h: number
  lastError?: BotHealthError
}

export interface CreateBotStoreOptions {
  db: ForemanDatabase
  /** Workspace root this store instance serves; another root's bots are invisible. */
  workspaceRoot: string
  /** Bounded per-bot log retention; defaults to 5000 entries. */
  logRetention?: number
  now?: () => Date
  idGenerator?: () => string
}

/**
 * Raised when a project's delivery lane is already held by another item, so a
 * state write that would enter the lane range is refused without writing.
 */
export class BotLaneBusyError extends Error {
  constructor(readonly project: string) {
    super(`delivery lane for project ${project} is held by another item`)
    this.name = 'BotLaneBusyError'
  }
}

export interface BotStore {
  readonly workspaceRoot: string
  listBots(): BotRecord[]
  getBot(botId: string): BotRecord
  createBot(input: { name: string; configPath?: string; mode?: BotMode; state?: BotState }): BotRecord
  updateBot(botId: string, patch: BotPatch): BotRecord
  deleteBot(botId: string): void
  findItemBySource(botId: string, sourceId: string): BotItemRecord | undefined
  nextGeneration(botId: string, sourceId: string): number
  createItem(input: {
    botId: string
    sourceId: string
    generation?: number
    fingerprint?: string
    title?: string
    body?: string
    project?: string
    class?: string
    state?: BotItemState
    dryRun?: boolean
  }): BotItemRecord
  listItems(botId: string, state?: BotItemState): BotItemRecord[]
  getItem(botId: string, itemId: string): BotItemRecord
  deleteItem(itemId: string): void
  transitionItem(itemId: string, to: BotItemState, patch?: BotItemPatch): BotItemRecord
  patchItem(itemId: string, patch: BotItemPatch): BotItemRecord
  beginStep(input: {
    itemId: string
    kind: BotStepKind
    idemKey: string
    input?: unknown
    patch?: BotItemPatch
  }): { step: BotStepRecord; item: BotItemRecord }
  finishStep(stepId: string, input: {
    status: Exclude<BotStepStatus, 'pending'>
    output?: unknown
    error?: string
    patch?: BotItemPatch
  }): BotItemRecord
  markStepStarted(stepId: string): void
  markStepStatus(stepId: string, status: BotStepStatus, patch?: { output?: unknown; error?: string }): void
  findStepByIdemKey(idemKey: string): BotStepRecord | undefined
  listPendingSteps(botId: string): BotStepRecord[]
  acquireLane(input: { project: string; botId: string; itemId: string }): boolean
  releaseLane(input: { project: string; itemId?: string }): boolean
  getLane(project: string): BotLaneRecord | undefined
  appendLog(input: {
    botId: string
    itemId?: string
    level: 'debug' | 'info' | 'warn' | 'error'
    code?: string
    message: string
  }): BotLogRecord
  listLog(botId: string, afterSeq: number, limit?: number): BotLogRecord[]
  healthCounters(botId: string): BotHealthCounters
}

const DEFAULT_LOG_RETENTION = 5_000
const DAY_MS = 24 * 60 * 60 * 1_000
/** Adapter failures are logged with a code carrying this prefix. */
const ADAPTER_ERROR_CODE_PREFIX = 'adapter.'
/** Escalations are logged with this code. */
const ESCALATION_CODE = 'escalation'

interface BotRow {
  id: string
  workspace_root: string
  name: string
  config_path: string | null
  config_hash: string | null
  state: string
  mode: string
  last_tick_at: string | null
  next_poll_at: string | null
  created_at: string
  updated_at: string
}

interface BotItemRow {
  id: string
  bot_id: string
  source_id: string
  generation: number
  fingerprint: string | null
  title: string | null
  body: string | null
  project: string | null
  class: string | null
  state: string
  parked_from: string | null
  question: string | null
  answer: string | null
  session_id: string | null
  session_model: string | null
  worktree_id: string | null
  branch: string | null
  head_sha: string | null
  merged_sha: string | null
  acceptance: string | null
  counters: string | null
  error: string | null
  dry_run: number
  created_at: string
  updated_at: string
}

interface BotStepRow {
  id: string
  item_id: string
  idem_key: string
  kind: string
  status: string
  input: string | null
  output: string | null
  error: string | null
  started_at: string | null
  finished_at: string | null
}

interface BotLogRow {
  seq: number
  bot_id: string
  item_id: string | null
  at: string
  level: string
  code: string | null
  message: string
}

interface BotLaneRow {
  workspace_root: string
  project: string
  bot_id: string
  item_id: string
  acquired_at: string
}

/** Item patch key -> database column. */
const ITEM_COLUMNS: Record<string, string> = {
  state: 'state',
  parkedFrom: 'parked_from',
  question: 'question',
  answer: 'answer',
  project: 'project',
  class: 'class',
  fingerprint: 'fingerprint',
  title: 'title',
  body: 'body',
  sessionId: 'session_id',
  sessionModel: 'session_model',
  worktreeId: 'worktree_id',
  branch: 'branch',
  headSha: 'head_sha',
  mergedSha: 'merged_sha',
  acceptance: 'acceptance',
  counters: 'counters',
  error: 'error',
  dryRun: 'dry_run',
}

const ITEM_JSON_FIELDS = new Set(['sessionModel', 'acceptance', 'counters'])

/**
 * Classify one restart probe so a pending step is never re-executed blindly.
 * A probe that proves the effect already happened marks the step done; a probe
 * that proves it did not (or cannot say) leaves the step pending for a retry,
 * except for effects that can never be probed, which become `unknown` and are
 * never retried automatically.
 */
export function classifyStepProbe(probe: 'done' | 'not-done' | 'unavailable'): 'done' | 'retry' | 'unknown' {
  if (probe === 'done') return 'done'
  if (probe === 'unavailable') return 'unknown'
  return 'retry'
}

/** Effects that cannot be probed at all, so a pending one is never resent. */
export const UNPROBEABLE_STEP_KINDS: readonly BotStepKind[] = ['notify']

function parseJson<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function optional(value: string | null): string | undefined {
  return value === null || value === undefined ? undefined : value
}

function rowToBot(row: BotRow): BotRecord {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    name: row.name,
    ...(optional(row.config_path) === undefined ? {} : { configPath: row.config_path as string }),
    ...(optional(row.config_hash) === undefined ? {} : { configHash: row.config_hash as string }),
    state: row.state as BotState,
    mode: row.mode as BotMode,
    ...(optional(row.last_tick_at) === undefined ? {} : { lastTickAt: row.last_tick_at as string }),
    ...(optional(row.next_poll_at) === undefined ? {} : { nextPollAt: row.next_poll_at as string }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToItem(row: BotItemRow): BotItemRecord {
  const sessionModel = parseJson<BotModel>(row.session_model)
  const acceptance = parseJson<BotAcceptanceCheck[]>(row.acceptance)
  const counters = parseJson<Record<string, number>>(row.counters)
  return {
    id: row.id,
    botId: row.bot_id,
    sourceId: row.source_id,
    generation: row.generation,
    ...(optional(row.fingerprint) === undefined ? {} : { fingerprint: row.fingerprint as string }),
    ...(optional(row.title) === undefined ? {} : { title: row.title as string }),
    ...(optional(row.body) === undefined ? {} : { body: row.body as string }),
    ...(optional(row.project) === undefined ? {} : { project: row.project as string }),
    ...(optional(row.class) === undefined ? {} : { class: row.class as string }),
    state: row.state as BotItemState,
    ...(optional(row.parked_from) === undefined ? {} : { parkedFrom: row.parked_from as BotItemState }),
    ...(optional(row.question) === undefined ? {} : { question: row.question as string }),
    ...(optional(row.answer) === undefined ? {} : { answer: row.answer as string }),
    ...(optional(row.session_id) === undefined ? {} : { sessionId: row.session_id as string }),
    ...(sessionModel === undefined ? {} : { sessionModel }),
    ...(optional(row.worktree_id) === undefined ? {} : { worktreeId: row.worktree_id as string }),
    ...(optional(row.branch) === undefined ? {} : { branch: row.branch as string }),
    ...(optional(row.head_sha) === undefined ? {} : { headSha: row.head_sha as string }),
    ...(optional(row.merged_sha) === undefined ? {} : { mergedSha: row.merged_sha as string }),
    ...(acceptance === undefined ? {} : { acceptance }),
    ...(counters === undefined ? {} : { counters }),
    ...(optional(row.error) === undefined ? {} : { error: row.error as string }),
    dryRun: row.dry_run === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToStep(row: BotStepRow): BotStepRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    idemKey: row.idem_key,
    kind: row.kind as BotStepKind,
    status: row.status as BotStepStatus,
    ...(optional(row.input) === undefined ? {} : { input: row.input as string }),
    ...(optional(row.output) === undefined ? {} : { output: row.output as string }),
    ...(optional(row.error) === undefined ? {} : { error: row.error as string }),
    ...(optional(row.started_at) === undefined ? {} : { startedAt: row.started_at as string }),
    ...(optional(row.finished_at) === undefined ? {} : { finishedAt: row.finished_at as string }),
  }
}

function rowToLog(row: BotLogRow): BotLogRecord {
  return {
    seq: row.seq,
    botId: row.bot_id,
    ...(optional(row.item_id) === undefined ? {} : { itemId: row.item_id as string }),
    at: row.at,
    level: row.level,
    ...(optional(row.code) === undefined ? {} : { code: row.code as string }),
    message: row.message,
  }
}

function serializeItemValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (key === 'dryRun') return value === true ? 1 : 0
  if (ITEM_JSON_FIELDS.has(key)) return JSON.stringify(value)
  return value
}

export function createBotStore(options: CreateBotStoreOptions): BotStore {
  const { db, workspaceRoot } = options
  const logRetention = options.logRetention ?? DEFAULT_LOG_RETENTION
  const now = options.now ?? (() => new Date())
  const newId = options.idGenerator ?? (() => randomBytes(8).toString('hex'))
  const timestamp = (): string => now().toISOString()

  function botRow(botId: string): BotRow | undefined {
    return db.prepare<[string, string], BotRow>(
      'SELECT * FROM bot WHERE id = ? AND workspace_root = ?',
    ).get(botId, workspaceRoot)
  }

  function requireBot(botId: string): BotRecord {
    const row = botRow(botId)
    if (!row) throw new Error(`unknown bot: ${botId}`)
    return rowToBot(row)
  }

  function itemRow(itemId: string): BotItemRow | undefined {
    return db.prepare<[string], BotItemRow>('SELECT * FROM bot_item WHERE id = ?').get(itemId)
  }

  function requireItem(botId: string, itemId: string): BotItemRow {
    const row = itemRow(itemId)
    if (!row || row.bot_id !== botId) throw new Error(`unknown bot item: ${itemId}`)
    return row
  }

  /** Write one item patch and return the fresh record. Caller owns validation. */
  function writeItemPatchRow(itemId: string, patch: BotItemPatch): BotItemRecord {
    const keys = Object.keys(ITEM_COLUMNS).filter(key => key in patch)
    if (keys.length === 0) {
      const row = itemRow(itemId)
      if (!row) throw new Error(`unknown bot item: ${itemId}`)
      return rowToItem(row)
    }
    const sets = keys.map(key => `${ITEM_COLUMNS[key]} = ?`)
    const values = keys.map(key => serializeItemValue(key, (patch as Record<string, unknown>)[key]))
    db.prepare<unknown[], unknown>(
      `UPDATE bot_item SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
    ).run(...values, timestamp(), itemId)
    const row = itemRow(itemId)
    if (!row) throw new Error(`unknown bot item: ${itemId}`)
    return rowToItem(row)
  }

  /**
   * Apply the one delivery-lane rule for an item state write. MUST run inside
   * the same transaction as the item write: entering the lane range from a
   * non-lane state acquires the lane for (workspace_root, project) or throws
   * {@link BotLaneBusyError} (rolling the transaction back without writing);
   * leaving the lane range releases the lane. An item that already holds the
   * lane, or a projectless item (which never takes a lane), is a no-op.
   */
  function applyLaneRule(current: BotItemRow, nextState: BotItemState | undefined): void {
    if (nextState === undefined || nextState === current.state) return
    const project = current.project
    if (project === null || project.trim() === '') return
    const fromLane = requiresDeliveryLane(current.state as BotItemState)
    const toLane = requiresDeliveryLane(nextState)
    if (toLane && !fromLane) {
      const held = db.prepare<[string, string], BotLaneRow>(
        'SELECT * FROM bot_lane WHERE workspace_root = ? AND project = ?',
      ).get(workspaceRoot, project)
      if (held !== undefined) {
        if (held.item_id !== current.id) throw new BotLaneBusyError(project)
        return
      }
      db.prepare<unknown[], unknown>(
        `INSERT INTO bot_lane (workspace_root, project, bot_id, item_id, acquired_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(workspaceRoot, project, current.bot_id, current.id, timestamp())
      return
    }
    if (fromLane && !toLane) {
      db.prepare<[string, string, string], unknown>(
        'DELETE FROM bot_lane WHERE workspace_root = ? AND project = ? AND item_id = ?',
      ).run(workspaceRoot, project, current.id)
    }
  }

  /** Validate, apply the lane rule and write one item patch in one transaction. */
  function applyItemWrite(itemId: string, patch: BotItemPatch): BotItemRecord {
    const current = itemRow(itemId)
    if (!current) throw new Error(`unknown bot item: ${itemId}`)
    validateStateChange(current, patch)
    return db.transaction(() => {
      applyLaneRule(current, patch.state)
      return writeItemPatchRow(itemId, patch)
    })()
  }

  /** Reject a state change the machine does not allow, before any write. */
  function validateStateChange(current: BotItemRow, patch: BotItemPatch): void {
    if (patch.state === undefined || patch.state === current.state) return
    const parkedFrom = (patch.parkedFrom ?? current.parked_from ?? undefined) as BotItemState | undefined
    assertItemTransition(
      current.state as BotItemState,
      patch.state,
      parkedFrom === undefined ? {} : { parkedFrom },
    )
  }

  function trimLog(botId: string): void {
    db.prepare<[string, string, number], unknown>(
      'DELETE FROM bot_log WHERE bot_id = ? AND seq <= (SELECT MAX(seq) FROM bot_log WHERE bot_id = ?) - ?',
    ).run(botId, botId, logRetention)
  }

  function uniqueBotId(): string {
    let id = newId().slice(0, 8)
    while (db.prepare<[string], { id: string }>('SELECT id FROM bot WHERE id = ?').get(id)) {
      id = newId().slice(0, 8)
    }
    return id
  }

  return {
    workspaceRoot,

    listBots(): BotRecord[] {
      return db.prepare<[string], BotRow>(
        'SELECT * FROM bot WHERE workspace_root = ? ORDER BY created_at DESC, id DESC',
      ).all(workspaceRoot).map(rowToBot)
    },

    getBot(botId: string): BotRecord {
      return requireBot(botId)
    },

    createBot(input): BotRecord {
      const name = input.name.trim()
      if (name === '') throw new Error('bot name must not be empty')
      const at = timestamp()
      const id = uniqueBotId()
      db.prepare<[string, string, string, string | null, string, string, string, string], unknown>(
        `INSERT INTO bot (id, workspace_root, name, config_path, state, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        workspaceRoot,
        name,
        input.configPath?.trim() || null,
        input.state ?? 'stopped',
        input.mode ?? 'dryRun',
        at,
        at,
      )
      return requireBot(id)
    },

    updateBot(botId: string, patch: BotPatch): BotRecord {
      requireBot(botId)
      const sets: string[] = []
      const values: unknown[] = []
      const assign = (column: string, value: unknown): void => {
        sets.push(`${column} = ?`)
        values.push(value)
      }
      if (patch.name !== undefined) assign('name', patch.name.trim())
      if (patch.configPath !== undefined) assign('config_path', patch.configPath === null ? null : patch.configPath.trim())
      if (patch.configHash !== undefined) assign('config_hash', patch.configHash)
      if (patch.state !== undefined) assign('state', patch.state)
      if (patch.mode !== undefined) assign('mode', patch.mode)
      if (patch.lastTickAt !== undefined) assign('last_tick_at', patch.lastTickAt)
      if (patch.nextPollAt !== undefined) assign('next_poll_at', patch.nextPollAt)
      if (sets.length > 0) {
        db.prepare<unknown[], unknown>(
          `UPDATE bot SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND workspace_root = ?`,
        ).run(...values, timestamp(), botId, workspaceRoot)
      }
      return requireBot(botId)
    },

    deleteBot(botId: string): void {
      const bot = requireBot(botId)
      if (bot.state !== 'stopped') throw new Error(`bot ${botId} must be stopped before it can be deleted`)
      db.transaction(() => {
        // Bot rows only: worktrees, sessions and branches are never touched.
        db.prepare<[string], unknown>(
          'DELETE FROM bot_step WHERE item_id IN (SELECT id FROM bot_item WHERE bot_id = ?)',
        ).run(botId)
        db.prepare<[string], unknown>('DELETE FROM bot_item WHERE bot_id = ?').run(botId)
        db.prepare<[string], unknown>('DELETE FROM bot_lane WHERE bot_id = ?').run(botId)
        db.prepare<[string], unknown>('DELETE FROM bot_log WHERE bot_id = ?').run(botId)
        db.prepare<[string, string], unknown>('DELETE FROM bot WHERE id = ? AND workspace_root = ?').run(botId, workspaceRoot)
      })()
    },

    findItemBySource(botId: string, sourceId: string): BotItemRecord | undefined {
      const row = db.prepare<[string, string], BotItemRow>(
        'SELECT * FROM bot_item WHERE bot_id = ? AND source_id = ? ORDER BY generation DESC LIMIT 1',
      ).get(botId, sourceId)
      return row === undefined ? undefined : rowToItem(row)
    },

    nextGeneration(botId: string, sourceId: string): number {
      const row = db.prepare<[string, string], { max_generation: number | null }>(
        'SELECT MAX(generation) AS max_generation FROM bot_item WHERE bot_id = ? AND source_id = ?',
      ).get(botId, sourceId)
      return (row?.max_generation ?? 0) + 1
    },

    createItem(input): BotItemRecord {
      requireBot(input.botId)
      const at = timestamp()
      const id = newId()
      db.prepare<unknown[], unknown>(
        `INSERT INTO bot_item (
           id, bot_id, source_id, generation, fingerprint, title, body, project, class, state,
           dry_run, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.botId,
        input.sourceId,
        input.generation ?? 1,
        input.fingerprint ?? null,
        input.title ?? null,
        input.body ?? null,
        input.project ?? null,
        input.class ?? null,
        input.state ?? 'discovered',
        input.dryRun === true ? 1 : 0,
        at,
        at,
      )
      return rowToItem(requireItem(input.botId, id))
    },

    listItems(botId: string, state?: BotItemState): BotItemRecord[] {
      requireBot(botId)
      const rows = state === undefined
        ? db.prepare<[string], BotItemRow>(
            'SELECT * FROM bot_item WHERE bot_id = ? ORDER BY created_at DESC, id DESC',
          ).all(botId)
        : db.prepare<[string, string], BotItemRow>(
            'SELECT * FROM bot_item WHERE bot_id = ? AND state = ? ORDER BY created_at DESC, id DESC',
          ).all(botId, state)
      return rows.map(rowToItem)
    },

    getItem(botId: string, itemId: string): BotItemRecord {
      return rowToItem(requireItem(botId, itemId))
    },

    deleteItem(itemId: string): void {
      db.transaction(() => {
        // Cleanup leaves no lane row behind: deleting a terminal item must never
        // block its project's next delivery.
        db.prepare<[string], unknown>('DELETE FROM bot_lane WHERE item_id = ?').run(itemId)
        db.prepare<[string], unknown>('DELETE FROM bot_step WHERE item_id = ?').run(itemId)
        db.prepare<[string], unknown>('DELETE FROM bot_item WHERE id = ?').run(itemId)
      })()
    },

    transitionItem(itemId: string, to: BotItemState, patch: BotItemPatch = {}): BotItemRecord {
      return applyItemWrite(itemId, { ...patch, state: to })
    },

    patchItem(itemId: string, patch: BotItemPatch): BotItemRecord {
      return applyItemWrite(itemId, patch)
    },

    beginStep(input): { step: BotStepRecord; item: BotItemRecord } {
      const current = itemRow(input.itemId)
      if (!current) throw new Error(`unknown bot item: ${input.itemId}`)
      if (input.patch !== undefined) validateStateChange(current, input.patch)
      const existing = db.prepare<[string], BotStepRow>(
        'SELECT * FROM bot_step WHERE idem_key = ?',
      ).get(input.idemKey)
      if (existing) {
        // At-most-once: a key that already exists is never re-inserted.
        return { step: rowToStep(existing), item: rowToItem(current) }
      }
      const stepId = newId()
      const inputJson = input.input === undefined ? null : JSON.stringify(input.input)
      // A queued step is inserted pending with no `started_at`: it has not run
      // yet, so a restart never mistakes it for an effect that may be in flight.
      const item = db.transaction(() => {
        applyLaneRule(current, input.patch?.state)
        db.prepare<unknown[], unknown>(
          `INSERT INTO bot_step (id, item_id, idem_key, kind, status, input)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        ).run(stepId, input.itemId, input.idemKey, input.kind, inputJson)
        return input.patch === undefined ? rowToItem(current) : writeItemPatchRow(input.itemId, input.patch)
      })()
      const step = db.prepare<[string], BotStepRow>('SELECT * FROM bot_step WHERE id = ?').get(stepId)
      if (!step) throw new Error(`bot step ${stepId} was not persisted`)
      return { step: rowToStep(step), item }
    },

    finishStep(stepId, input): BotItemRecord {
      const step = db.prepare<[string], BotStepRow>('SELECT * FROM bot_step WHERE id = ?').get(stepId)
      if (!step) throw new Error(`unknown bot step: ${stepId}`)
      const current = itemRow(step.item_id)
      if (!current) throw new Error(`unknown bot item: ${step.item_id}`)
      if (input.patch !== undefined) validateStateChange(current, input.patch)
      const at = timestamp()
      const output = input.output === undefined ? null : JSON.stringify(input.output)
      // The lane rule and the terminal step status share one transaction: a busy
      // lane aborts before anything is written, and a state that leaves the lane
      // range releases the lane atomically with the step outcome.
      return db.transaction(() => {
        applyLaneRule(current, input.patch?.state)
        db.prepare<unknown[], unknown>(
          'UPDATE bot_step SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?',
        ).run(input.status, output, input.error ?? null, at, stepId)
        return input.patch === undefined ? rowToItem(current) : writeItemPatchRow(step.item_id, input.patch)
      })()
    },

    markStepStarted(stepId: string): void {
      db.transaction(() => {
        const step = db.prepare<[string], BotStepRow>('SELECT * FROM bot_step WHERE id = ?').get(stepId)
        if (!step) throw new Error(`unknown bot step: ${stepId}`)
        // First write wins: a step that already started keeps its original time.
        db.prepare<[string, string], unknown>(
          'UPDATE bot_step SET started_at = COALESCE(started_at, ?) WHERE id = ?',
        ).run(timestamp(), stepId)
      })()
    },

    markStepStatus(stepId, status, patch = {}): void {
      const step = db.prepare<[string], BotStepRow>('SELECT * FROM bot_step WHERE id = ?').get(stepId)
      if (!step) throw new Error(`unknown bot step: ${stepId}`)
      const output = patch.output === undefined ? null : JSON.stringify(patch.output)
      const finishedAt = status === 'pending' ? null : timestamp()
      db.prepare<unknown[], unknown>(
        `UPDATE bot_step SET status = ?, output = COALESCE(?, output), error = COALESCE(?, error),
           finished_at = COALESCE(?, finished_at) WHERE id = ?`,
      ).run(status, output, patch.error ?? null, finishedAt, stepId)
    },

    findStepByIdemKey(idemKey: string): BotStepRecord | undefined {
      const row = db.prepare<[string], BotStepRow>('SELECT * FROM bot_step WHERE idem_key = ?').get(idemKey)
      return row === undefined ? undefined : rowToStep(row)
    },

    listPendingSteps(botId: string): BotStepRecord[] {
      return db.prepare<[string], BotStepRow>(
        `SELECT s.* FROM bot_step s
         JOIN bot_item i ON i.id = s.item_id
         WHERE i.bot_id = ? AND s.status = 'pending'
         ORDER BY s.started_at, s.id`,
      ).all(botId).map(rowToStep)
    },

    acquireLane(input): boolean {
      const project = input.project.trim()
      if (project === '') return false
      const held = db.prepare<[string, string], BotLaneRow>(
        'SELECT * FROM bot_lane WHERE workspace_root = ? AND project = ?',
      ).get(workspaceRoot, project)
      if (held) return held.item_id === input.itemId
      try {
        db.prepare<unknown[], unknown>(
          `INSERT INTO bot_lane (workspace_root, project, bot_id, item_id, acquired_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(workspaceRoot, project, input.botId, input.itemId, timestamp())
        return true
      } catch {
        // The primary key lost a race: another item of this project holds it.
        return false
      }
    },

    releaseLane(input): boolean {
      if (input.itemId === undefined) {
        const result = db.prepare<[string, string], unknown>(
          'DELETE FROM bot_lane WHERE workspace_root = ? AND project = ?',
        ).run(workspaceRoot, input.project)
        return result.changes > 0
      }
      const result = db.prepare<[string, string, string], unknown>(
        'DELETE FROM bot_lane WHERE workspace_root = ? AND project = ? AND item_id = ?',
      ).run(workspaceRoot, input.project, input.itemId)
      return result.changes > 0
    },

    getLane(project: string): BotLaneRecord | undefined {
      const row = db.prepare<[string, string], BotLaneRow>(
        'SELECT * FROM bot_lane WHERE workspace_root = ? AND project = ?',
      ).get(workspaceRoot, project)
      if (!row) return undefined
      return {
        workspaceRoot: row.workspace_root,
        project: row.project,
        botId: row.bot_id,
        itemId: row.item_id,
        acquiredAt: row.acquired_at,
      }
    },

    appendLog(input): BotLogRecord {
      const at = timestamp()
      const info = db.prepare<unknown[], unknown>(
        'INSERT INTO bot_log (bot_id, item_id, at, level, code, message) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(input.botId, input.itemId ?? null, at, input.level, input.code ?? null, input.message)
      const seq = Number(info.lastInsertRowid)
      trimLog(input.botId)
      return {
        seq,
        botId: input.botId,
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        at,
        level: input.level,
        ...(input.code === undefined ? {} : { code: input.code }),
        message: input.message,
      }
    },

    listLog(botId: string, afterSeq: number, limit = 500): BotLogRecord[] {
      return db.prepare<[string, number, number], BotLogRow>(
        'SELECT * FROM bot_log WHERE bot_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      ).all(botId, afterSeq, limit).map(rowToLog)
    },

    healthCounters(botId: string): BotHealthCounters {
      const itemsByState: Record<string, number> = {}
      for (const row of db.prepare<[string], { state: string; count: number }>(
        'SELECT state, COUNT(*) AS count FROM bot_item WHERE bot_id = ? GROUP BY state',
      ).all(botId)) {
        itemsByState[row.state] = row.count
      }
      const cutoff = new Date(now().getTime() - DAY_MS).toISOString()
      const failed = db.prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) AS count FROM bot_step s
         JOIN bot_item i ON i.id = s.item_id
         WHERE i.bot_id = ? AND s.status = 'failed' AND s.finished_at >= ?`,
      ).get(botId, cutoff)
      const adapterErrors = db.prepare<[string, string, string], { count: number }>(
        'SELECT COUNT(*) AS count FROM bot_log WHERE bot_id = ? AND code LIKE ? AND at >= ?',
      ).get(botId, `${ADAPTER_ERROR_CODE_PREFIX}%`, cutoff)
      const escalations = db.prepare<[string, string, string], { count: number }>(
        'SELECT COUNT(*) AS count FROM bot_log WHERE bot_id = ? AND code = ? AND at >= ?',
      ).get(botId, ESCALATION_CODE, cutoff)
      const lastErrorRow = db.prepare<[string], BotLogRow>(
        "SELECT * FROM bot_log WHERE bot_id = ? AND level = 'error' ORDER BY seq DESC LIMIT 1",
      ).get(botId)
      return {
        itemsByState,
        stepsFailed24h: failed?.count ?? 0,
        adapterErrors24h: adapterErrors?.count ?? 0,
        escalations24h: escalations?.count ?? 0,
        ...(lastErrorRow === undefined ? {} : {
          lastError: {
            at: lastErrorRow.at,
            code: lastErrorRow.code ?? 'error',
            message: lastErrorRow.message,
          } satisfies BotHealthError,
        }),
      }
    },
  }
}
