import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Session } from '@wrenyard/session'
import type {
  ScheduleCreateParams,
  ScheduleListResult,
  ScheduleRecord,
  ScheduleState,
} from '../../protocol/methods/schedule.mts'

/** How often due schedules are checked. */
const TICK_MS = 5_000
/** A recurring schedule is created seven days ahead and expires then. */
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000
/** At most this many active or paused schedules may exist per session. */
const MAX_PER_SESSION = 50
const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 10_080
const MAX_PROMPT_LENGTH = 4_000

/** Diagnostic sink; wired to the daemon log by the caller. */
export type SchedulerLog = (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void

export interface CreateSchedulerOptions {
  /** JSON state file holding `{ version: 1, schedules: [...] }`. */
  statePath: string
  /** The session feature the scheduler sends prompts through. */
  session: Pick<Session, 'send' | 'listSessions'>
  /**
   * Workspace root this scheduler instance serves. Every schedule is associated
   * with the workspace that owned it; a scheduler never lists or fires a
   * schedule belonging to any other workspace, so a hot switch cannot make one
   * workspace's scheduled prompt fire into another workspace's sessions.
   */
  workspaceRoot: string
  log?: SchedulerLog
  /**
   * Admission gate checked at tick entry and again immediately before every
   * send. The daemon returns false while a hot switch or shutdown is staging,
   * so a suppressed scheduler cannot start a prompt after isIdle was observed.
   */
  canRun?: () => boolean
}

export interface Scheduler {
  /**
   * Load persisted schedules and prepare the workspace association without
   * firing any schedule or arming the poll timer, so a hot switch can stage
   * this before it publishes.
   */
  prepare(): Promise<void>
  /** Fire any due schedules once, then poll every 5s. Prepare must precede it. */
  start(): Promise<void>
  /** Stop polling and make later ticks no-ops. */
  stop(): void
  /** True while a tick is firing due schedules; the daemon treats it as in-flight work. */
  readonly ticking: boolean
  /** Await every queued write; rejects when the latest write failed. */
  flush(): Promise<void>
  list(sessionId?: string): ScheduleListResult
  create(input: ScheduleCreateParams): ScheduleRecord
  update(id: string, state: 'active' | 'paused', sessionId?: string): ScheduleRecord
  run(id: string, sessionId?: string): ScheduleRecord
  remove(id: string, sessionId?: string): void
}

interface SchedulerStateFile {
  version: 1
  schedules: ScheduleRecord[]
  /**
   * Original workspace root per schedule id. A store written before workspace
   * switching existed has no map; every record in it is associated with the
   * workspace active at its first load and persisted there, so a later switch
   * can never re-home a legacy schedule. Entries for removed schedules are
   * dropped on the next write.
   */
  workspaces?: Record<string, string>
}

function copyRecord(record: ScheduleRecord): ScheduleRecord {
  return { ...record, model: { ...record.model } }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** A structurally valid persisted record, or undefined for anything malformed. */
function readRecord(value: unknown): ScheduleRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const model = record.model
  if (
    typeof record.id !== 'string'
    || typeof record.sessionId !== 'string'
    || typeof record.prompt !== 'string'
    || typeof record.intervalMinutes !== 'number'
    || typeof record.recurring !== 'boolean'
    || typeof record.createdAt !== 'string'
    || typeof record.runCount !== 'number'
    || (record.state !== 'active' && record.state !== 'paused' && record.state !== 'finished' && record.state !== 'failed')
    || !model || typeof model !== 'object' || Array.isArray(model)
  ) {
    return undefined
  }
  const { provider, model: modelId, reasoningEffort } = model as Record<string, unknown>
  if (typeof provider !== 'string' || typeof modelId !== 'string' || typeof reasoningEffort !== 'string') return undefined
  return {
    id: record.id,
    sessionId: record.sessionId,
    prompt: record.prompt,
    intervalMinutes: record.intervalMinutes,
    recurring: record.recurring,
    model: { provider, model: modelId, reasoningEffort: reasoningEffort as ScheduleRecord['model']['reasoningEffort'] },
    state: record.state,
    createdAt: record.createdAt,
    ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.nextRunAt === 'string' ? { nextRunAt: record.nextRunAt } : {}),
    ...(typeof record.lastRunAt === 'string' ? { lastRunAt: record.lastRunAt } : {}),
    ...(typeof record.lastTurn === 'number' ? { lastTurn: record.lastTurn } : {}),
    ...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
    runCount: record.runCount,
  }
}

/**
 * Daemon-owned scheduled-prompt service. It keeps schedules in memory, persists
 * every mutation through one serialized write chain, and fires due schedules
 * into their owning session on a 5 second timer.
 */
export function createScheduler(options: CreateSchedulerOptions): Scheduler {
  const { statePath, session, log, workspaceRoot, canRun } = options
  let schedules: ScheduleRecord[] = []
  /** Original workspace root per schedule id (see SchedulerStateFile.workspaces). */
  const scheduleWorkspaces = new Map<string, string>()
  /** Set when load() had to associate at least one record with this workspace. */
  let associationDirty = false
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let ticking = false
  /** Set once the state file was loaded and its association prepared. */
  let prepared = false
  let persistChain: Promise<void> = Promise.resolve()

  /** The workspace that owns one stored record; an unassociated record belongs here. */
  function recordWorkspace(record: ScheduleRecord): string {
    return scheduleWorkspaces.get(record.id) ?? workspaceRoot
  }

  /** Atomically write the state file: temp file plus rename, temp removed on failure. */
  async function writeState(records: ScheduleRecord[], associations: Map<string, string>): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true })
    const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    const known = new Set(records.map(record => record.id))
    const workspaces: Record<string, string> = {}
    for (const [id, root] of associations) {
      if (known.has(id)) workspaces[id] = root
    }
    const payload = JSON.stringify({ version: 1, schedules: records, workspaces } satisfies SchedulerStateFile)
    try {
      await writeFile(tempPath, payload, 'utf-8')
      await rename(tempPath, statePath)
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      throw error
    }
  }

  /**
   * Serialize every mutation's write so two persists never interleave. A normal
   * mutation's failed write is logged, never thrown; flush() observes the same
   * chain's rejection for the workspace-switch path.
   */
  function persist(): void {
    const snapshot = schedules.map(copyRecord)
    const associations = new Map(scheduleWorkspaces)
    persistChain = persistChain
      .then(() => writeState(snapshot, associations), () => writeState(snapshot, associations))
    void persistChain.catch((error: unknown) => {
      log?.('warn', 'scheduler failed to persist schedules', error)
    })
  }

  /** Await every queued write; rejects when the latest write failed. */
  async function flush(): Promise<void> {
    await persistChain
  }

  /** Load the state file; a missing file is empty, unreadable or invalid logs. */
  async function load(): Promise<ScheduleRecord[]> {
    let raw: string
    try {
      raw = await readFile(statePath, 'utf-8')
    } catch (error) {
      if (isMissingFile(error)) return []
      log?.('warn', `scheduler could not read ${statePath}; starting with an empty schedule list`, error)
      return []
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      const list = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { schedules?: unknown }).schedules
        : undefined
      if (!Array.isArray(list)) throw new Error('invalid schedule store')
      // Read the persisted original-workspace association. A store written
      // before workspace switching existed has none; each of its records is
      // associated with THIS workspace — the one active at its first load after
      // the upgrade — and the association is persisted so a later switch can no
      // longer re-home a legacy schedule.
      const storedWorkspaces = new Map<string, string>()
      const rawWorkspaces = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { workspaces?: unknown }).workspaces
        : undefined
      if (rawWorkspaces && typeof rawWorkspaces === 'object' && !Array.isArray(rawWorkspaces)) {
        for (const [id, root] of Object.entries(rawWorkspaces as Record<string, unknown>)) {
          if (typeof root === 'string' && root !== '') storedWorkspaces.set(id, root)
        }
      }
      const records: ScheduleRecord[] = []
      for (const entry of list) {
        const record = readRecord(entry)
        if (!record) continue
        records.push(record)
        const assigned = storedWorkspaces.get(record.id) ?? workspaceRoot
        if (storedWorkspaces.get(record.id) !== assigned) associationDirty = true
        storedWorkspaces.set(record.id, assigned)
      }
      scheduleWorkspaces.clear()
      for (const [id, root] of storedWorkspaces) scheduleWorkspaces.set(id, root)
      return records
    } catch (error) {
      log?.('warn', `scheduler found invalid content in ${statePath}; starting with an empty schedule list`, error)
      return []
    }
  }

  /**
   * Resolve one stored record by id, rejecting an unknown id, a session mismatch
   * or a record owned by another workspace. A scheduler never mutates a
   * schedule that does not belong to the workspace it serves.
   */
  function findRecord(id: string, sessionId?: string): ScheduleRecord {
    const record = schedules.find(candidate => candidate.id === id)
    if (!record || recordWorkspace(record) !== workspaceRoot
      || (sessionId !== undefined && record.sessionId !== sessionId)) {
      throw new Error(`unknown schedule: ${id}`)
    }
    return record
  }

  /** A fresh unique 8 lowercase hex characters id. */
  function nextId(): string {
    let id = randomBytes(4).toString('hex')
    while (schedules.some(record => record.id === id)) id = randomBytes(4).toString('hex')
    return id
  }

  /** One polling pass: fire every active record whose nextRunAt has passed. */
  async function tick(): Promise<void> {
    // Admission gate at tick entry: while a hot switch or shutdown is staging,
    // the daemon suppresses the whole pass so no send can start after isIdle.
    if (stopped || ticking || canRun?.() === false) return
    ticking = true
    try {
      const now = Date.now()
      // Snapshot the ids that are due now. Each live record is re-read before
      // its send, because an earlier awaited send in this same tick may have
      // left the store paused, resumed or deleted. A record owned by another
      // workspace is never due here: its scheduled prompt must not fire into
      // this workspace's sessions.
      const dueIds = schedules
        .filter(record =>
          recordWorkspace(record) === workspaceRoot
          && record.state === 'active'
          && record.nextRunAt !== undefined
          && Date.parse(record.nextRunAt) <= now)
        .map(record => record.id)
      if (dueIds.length === 0) return
      const summaries = new Map(session.listSessions().map(summary => [summary.sessionId, summary]))
      const firedSessions = new Set<string>()
      let changed = false
      for (const id of dueIds) {
        if (stopped) break
        // Re-read the live record: skip it when it was paused, deleted,
        // rescheduled into the future or otherwise left the active state while
        // another send in this tick was awaited.
        const record = schedules.find(candidate => candidate.id === id)
        if (!record || record.state !== 'active' || record.nextRunAt === undefined
          || Date.parse(record.nextRunAt) > now) {
          continue
        }
        // One fire per session per tick: a second due record of the same session
        // keeps its own nextRunAt and is re-evaluated on the next tick.
        if (firedSessions.has(record.sessionId)) continue
        const summary = summaries.get(record.sessionId)
        // A running session is busy: leave the record due so missed fires
        // collapse into a single run once the current turn finishes.
        if (summary?.running === true) continue
        if (!summary) {
          record.state = 'failed'
          record.lastError = `unknown session: ${record.sessionId}`
          delete record.nextRunAt
          changed = true
          continue
        }
        firedSessions.add(record.sessionId)
        const fireAt = new Date()
        let turn: number | undefined
        let fireError: unknown
        // Admission gate re-checked immediately before the send: a scheduler
        // suppressed by an in-progress switch or shutdown must not start a
        // prompt after the daemon was observed idle.
        if (canRun?.() === false) break
        try {
          const result = await session.send(record.sessionId, { text: record.prompt, model: record.model })
          turn = result.turn
        } catch (error) {
          fireError = error
        }
        // A stop request during the awaited send aborts the rest of this tick
        // without persisting anything: a shutdown rejection must not be stored.
        if (stopped) return
        // Re-read the live record: it may have been paused or deleted while the
        // send above was awaited. A deleted record writes nothing.
        const after = schedules.find(candidate => candidate.id === id)
        if (!after) continue
        if (turn === undefined) {
          // A pause during the send keeps the paused state; only an active
          // record is overwritten with the failure.
          if (after.state === 'active') {
            after.state = 'failed'
            delete after.nextRunAt
          }
          after.lastError = fireError instanceof Error ? fireError.message : String(fireError)
          changed = true
          log?.('warn', `scheduler failed to fire schedule ${after.id} for session ${after.sessionId}`, fireError)
          continue
        }
        // The run happened: always record the counters and the next run time,
        // but keep a pause that arrived during the send.
        after.runCount += 1
        after.lastRunAt = fireAt.toISOString()
        after.lastTurn = turn
        delete after.lastError
        if (after.recurring) {
          const next = new Date(fireAt.getTime() + after.intervalMinutes * 60_000)
          if (after.expiresAt !== undefined && next.getTime() > Date.parse(after.expiresAt)) {
            if (after.state === 'active') {
              after.state = 'finished'
              delete after.nextRunAt
            }
          } else {
            after.nextRunAt = next.toISOString()
          }
        } else if (after.state === 'active') {
          after.state = 'finished'
          delete after.nextRunAt
        }
        changed = true
        log?.('info', `scheduler fired schedule ${after.id} for session ${after.sessionId} (turn ${turn})`)
      }
      if (changed) persist()
    } finally {
      ticking = false
    }
  }

  /**
   * Load the state file and prepare the workspace association without firing
   * anything or arming the poll timer, so a hot switch can stage this before it
   * publishes. A prepare after stop() is a no-op.
   */
  async function prepareStore(): Promise<void> {
    if (stopped || prepared) return
    schedules = await load()
    prepared = true
    // Persist the first-load workspace association of any legacy schedule, so a
    // later switch reads it back instead of re-homing the record into the
    // switched-to workspace.
    if (associationDirty) {
      associationDirty = false
      persist()
    }
  }

  /** Fire due schedules once, then poll every 5s. A run after stop() is a no-op. */
  async function beginTicking(): Promise<void> {
    if (stopped) return
    await tick()
    if (stopped) return
    timer = setInterval(() => { void tick() }, TICK_MS)
    timer.unref()
  }

  return {
    get ticking(): boolean { return ticking },
    prepare: prepareStore,
    // A start after stop() does nothing: no store load, no initial tick and no
    // interval, so a late start cannot revive a stopped scheduler.
    async start(): Promise<void> {
      await prepareStore()
      await beginTicking()
    },
    flush,
    stop(): void {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
    list(sessionId?: string): ScheduleListResult {
      const titles = new Map(session.listSessions().map(summary => [summary.sessionId, summary.title]))
      // Only this workspace's schedules are ever listed; another workspace's
      // schedules stay owned by that workspace and its sessions.
      const filtered = schedules.filter(record =>
        recordWorkspace(record) === workspaceRoot
        && (sessionId === undefined || record.sessionId === sessionId))
      const sorted = [...filtered].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      return {
        schedules: sorted.map(record => {
          const title = titles.get(record.sessionId)
          return { ...copyRecord(record), ...(title === undefined ? {} : { sessionTitle: title }) }
        }),
      }
    },
    create(input: ScheduleCreateParams): ScheduleRecord {
      const prompt = input.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must not be empty')
      if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`)
      if (!Number.isInteger(input.intervalMinutes)
        || input.intervalMinutes < MIN_INTERVAL_MINUTES
        || input.intervalMinutes > MAX_INTERVAL_MINUTES) {
        throw new Error(`intervalMinutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`)
      }
      if (!session.listSessions().some(summary => summary.sessionId === input.sessionId)) {
        throw new Error(`unknown session: ${input.sessionId}`)
      }
      const activeCount = schedules.filter(record =>
        record.sessionId === input.sessionId && (record.state === 'active' || record.state === 'paused')).length
      if (activeCount >= MAX_PER_SESSION) throw new Error(`schedule limit reached (${MAX_PER_SESSION} per session)`)
      const now = new Date()
      const record: ScheduleRecord = {
        id: nextId(),
        sessionId: input.sessionId,
        prompt,
        intervalMinutes: input.intervalMinutes,
        recurring: input.recurring,
        model: { ...input.model },
        state: 'active',
        createdAt: now.toISOString(),
        nextRunAt: new Date(now.getTime() + input.intervalMinutes * 60_000).toISOString(),
        ...(input.recurring ? { expiresAt: new Date(now.getTime() + EXPIRY_MS).toISOString() } : {}),
        runCount: 0,
      }
      schedules.push(record)
      // The record belongs to this scheduler's workspace for its whole life.
      scheduleWorkspaces.set(record.id, workspaceRoot)
      persist()
      return copyRecord(record)
    },
    update(id: string, state: 'active' | 'paused', sessionId?: string): ScheduleRecord {
      const record = findRecord(id, sessionId)
      const previous: ScheduleState = record.state
      if (previous !== 'active' && previous !== 'paused') throw new Error(`schedule ${id} is ${previous}`)
      if (state === 'paused') {
        record.state = 'paused'
      } else {
        record.state = 'active'
        const due = record.nextRunAt === undefined ? Number.NaN : Date.parse(record.nextRunAt)
        if (record.nextRunAt === undefined || due <= Date.now()) {
          record.nextRunAt = new Date(Date.now() + record.intervalMinutes * 60_000).toISOString()
        }
      }
      persist()
      return copyRecord(record)
    },
    run(id: string, sessionId?: string): ScheduleRecord {
      const record = findRecord(id, sessionId)
      record.state = 'active'
      delete record.lastError
      record.nextRunAt = new Date().toISOString()
      persist()
      return copyRecord(record)
    },
    remove(id: string, sessionId?: string): void {
      const record = findRecord(id, sessionId)
      schedules = schedules.filter(candidate => candidate.id !== record.id)
      scheduleWorkspaces.delete(record.id)
      persist()
    },
  }
}
