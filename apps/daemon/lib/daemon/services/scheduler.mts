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
  log?: SchedulerLog
}

export interface Scheduler {
  /** Load persisted schedules, fire any that are due, then poll every 5s. */
  start(): Promise<void>
  /** Stop polling and make later ticks no-ops. */
  stop(): void
  list(sessionId?: string): ScheduleListResult
  create(input: ScheduleCreateParams): ScheduleRecord
  update(id: string, state: 'active' | 'paused', sessionId?: string): ScheduleRecord
  run(id: string, sessionId?: string): ScheduleRecord
  remove(id: string, sessionId?: string): void
}

interface SchedulerStateFile {
  version: 1
  schedules: ScheduleRecord[]
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
  const { statePath, session, log } = options
  let schedules: ScheduleRecord[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let ticking = false
  let persistChain: Promise<void> = Promise.resolve()

  /** Atomically write the state file: temp file plus rename, temp removed on failure. */
  async function writeState(records: ScheduleRecord[]): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true })
    const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    const payload = JSON.stringify({ version: 1, schedules: records } satisfies SchedulerStateFile)
    try {
      await writeFile(tempPath, payload, 'utf-8')
      await rename(tempPath, statePath)
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      throw error
    }
  }

  /** Serialize every mutation's write so two persists never interleave. */
  function persist(): void {
    const snapshot = schedules.map(copyRecord)
    persistChain = persistChain
      .then(() => writeState(snapshot), () => writeState(snapshot))
      .catch((error: unknown) => {
        log?.('warn', 'scheduler failed to persist schedules', error)
      })
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
      const records: ScheduleRecord[] = []
      for (const entry of list) {
        const record = readRecord(entry)
        if (record) records.push(record)
      }
      return records
    } catch (error) {
      log?.('warn', `scheduler found invalid content in ${statePath}; starting with an empty schedule list`, error)
      return []
    }
  }

  /** Resolve one stored record by id, rejecting an unknown id or a session mismatch. */
  function findRecord(id: string, sessionId?: string): ScheduleRecord {
    const record = schedules.find(candidate => candidate.id === id)
    if (!record || (sessionId !== undefined && record.sessionId !== sessionId)) {
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
    if (stopped || ticking) return
    ticking = true
    try {
      const now = Date.now()
      // Snapshot the ids that are due now. Each live record is re-read before
      // its send, because an earlier awaited send in this same tick may have
      // left the store paused, resumed or deleted.
      const dueIds = schedules
        .filter(record =>
          record.state === 'active'
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

  return {
    async start(): Promise<void> {
      // A start after stop() does nothing: no store load, no initial tick and
      // no interval, so a late start cannot revive a stopped scheduler.
      if (stopped) return
      schedules = await load()
      if (stopped) return
      await tick()
      if (stopped) return
      timer = setInterval(() => { void tick() }, TICK_MS)
      timer.unref()
    },
    stop(): void {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
    list(sessionId?: string): ScheduleListResult {
      const titles = new Map(session.listSessions().map(summary => [summary.sessionId, summary.title]))
      const filtered = sessionId === undefined
        ? schedules
        : schedules.filter(record => record.sessionId === sessionId)
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
      persist()
    },
  }
}
