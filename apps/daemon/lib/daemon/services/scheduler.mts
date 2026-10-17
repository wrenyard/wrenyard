import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  RoutineCreateParams,
  RoutineDeliver,
  RoutineListResult,
  RoutineRecord,
  RoutineState,
} from '../../protocol/methods/routine.mts'

/** How often due routines are checked. */
const TICK_MS = 5_000
/** A recurring routine is created seven days ahead and expires then. */
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000
/** At most this many active or paused routines may exist per bot. */
const MAX_PER_BOT = 50
const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 10_080
const MAX_PROMPT_LENGTH = 4_000

/** Diagnostic sink; wired to the daemon log by the caller. */
export type SchedulerLog = (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void

/**
 * A due routine wakes its owning bot agent through this callback instead of
 * sending into a session. A rejection (for example an unknown or disabled bot)
 * records `lastError` on the routine; a resolved call counts as a run.
 */
export type RoutineWake = (routine: RoutineRecord) => void | Promise<void>

const DELIVER_PATTERN = /^(none|bot:[a-z0-9][a-z0-9-]{0,31})$/

export function parseRoutineDeliver(value: string | undefined): RoutineDeliver {
  if (value === undefined || value === 'none') return 'none'
  if (!DELIVER_PATTERN.test(value)) throw new Error(`deliver must be 'none' or 'bot:<id>'`)
  return value as RoutineDeliver
}

/**
 * One routine declared in a bot config file. The kernel reconciles these into
 * the routine store: they are created, updated or removed to match the config,
 * and unlike Desktop-created routines they are named and never expire.
 */
export interface RoutineConfig {
  name: string
  prompt: string
  intervalMinutes: number
  deliver: RoutineDeliver
}

export interface CreateSchedulerOptions {
  /** JSON state file holding `{ version: 1, routines: [...] }`. */
  statePath: string
  /** Wakes the owning bot agent when a routine fires. */
  wake: RoutineWake
  /**
   * Workspace root this scheduler instance serves. Every routine is associated
   * with the workspace that owned it; a scheduler never lists or fires a
   * routine belonging to any other workspace, so a hot switch cannot make one
   * workspace's routine fire into another workspace's bots.
   */
  workspaceRoot: string
  log?: SchedulerLog
  /**
   * Admission gate checked at tick entry and again immediately before every
   * wake. The daemon returns false while a hot switch or shutdown is staging,
   * so a suppressed scheduler cannot start a wake after isIdle was observed.
   */
  canRun?: () => boolean
  /**
   * Optional per-bot busy gate. When it returns true for a due routine, the
   * tick skips that routine without touching its nextRunAt or runCount, so it
   * fires on a later tick once the routine has no wake being processed or
   * queued. Open rounds waiting on watched sessions do not count as busy.
   * Manual `run(id)` also honors this gate.
   */
  busy?: (routine: RoutineRecord) => boolean
}

export interface Scheduler {
  /**
   * Load persisted routines and prepare the workspace association without
   * firing any routine or arming the poll timer, so a hot switch can stage
   * this before it publishes.
   */
  prepare(): Promise<void>
  /** Fire any due routines once, then poll every 5s. Prepare must precede it. */
  start(): Promise<void>
  /** Stop polling and make later ticks no-ops. */
  stop(): void
  /** True while a tick is firing due routines; the daemon treats it as in-flight work. */
  readonly ticking: boolean
  /** Await every queued write; rejects when the latest write failed. */
  flush(): Promise<void>
  list(botId?: string): RoutineListResult
  create(input: RoutineCreateParams): RoutineRecord
  update(id: string, state: 'active' | 'paused'): RoutineRecord
  run(id: string): RoutineRecord
  remove(id: string): void
  /**
   * Reconcile the config-declared routines of one bot with the store. Among
   * this workspace's records for the bot that carry a `name`, missing ones are
   * created (recurring, active, never expiring), changed prompt / interval /
   * deliver are updated (nextRunAt is recomputed only when the interval
   * changed, and a finished or failed routine is reactivated), and records
   * whose name is no longer declared are deleted. Records without a `name` are
   * left untouched, and the store is persisted once when anything changed.
   */
  reconcile(botId: string, routines: readonly RoutineConfig[]): Promise<void>
}

interface SchedulerStateFile {
  version: 1
  routines: RoutineRecord[]
  /**
   * Original workspace root per routine id. A store written before workspace
   * switching existed has no map; every record in it is associated with the
   * workspace active at its first load and persisted there, so a later switch
   * can never re-home a legacy routine. Entries for removed routines are
   * dropped on the next write.
   */
  workspaces?: Record<string, string>
}

function copyRecord(record: RoutineRecord): RoutineRecord {
  return { ...record }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** A structurally valid persisted record, or undefined for anything malformed. */
function readRecord(value: unknown): RoutineRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string'
    || typeof record.botId !== 'string'
    || typeof record.prompt !== 'string'
    || typeof record.intervalMinutes !== 'number'
    || typeof record.recurring !== 'boolean'
    || typeof record.deliver !== 'string'
    || !DELIVER_PATTERN.test(record.deliver)
    || typeof record.createdAt !== 'string'
    || typeof record.runCount !== 'number'
    || (record.state !== 'active' && record.state !== 'paused' && record.state !== 'finished' && record.state !== 'failed')
    || (record.name !== undefined && typeof record.name !== 'string')
  ) {
    return undefined
  }
  return {
    id: record.id,
    botId: record.botId,
    prompt: record.prompt,
    intervalMinutes: record.intervalMinutes,
    recurring: record.recurring,
    state: record.state,
    deliver: record.deliver as RoutineDeliver,
    createdAt: record.createdAt,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.nextRunAt === 'string' ? { nextRunAt: record.nextRunAt } : {}),
    ...(typeof record.lastRunAt === 'string' ? { lastRunAt: record.lastRunAt } : {}),
    ...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
    runCount: record.runCount,
  }
}

/**
 * Daemon-owned routine service. Routines belong to bots: the store keeps them
 * in memory, persists every mutation through one serialized write chain, and a
 * 5 second timer wakes each due routine's owning bot agent.
 */
export function createScheduler(options: CreateSchedulerOptions): Scheduler {
  const { statePath, wake, log, workspaceRoot, canRun, busy } = options
  let routines: RoutineRecord[] = []
  /** Original workspace root per routine id (see SchedulerStateFile.workspaces). */
  const routineWorkspaces = new Map<string, string>()
  /** Set when load() had to associate at least one record with this workspace. */
  let associationDirty = false
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let ticking = false
  /** Set once the state file was loaded and its association prepared. */
  let prepared = false
  let persistChain: Promise<void> = Promise.resolve()

  /** The workspace that owns one stored record; an unassociated record belongs here. */
  function recordWorkspace(record: RoutineRecord): string {
    return routineWorkspaces.get(record.id) ?? workspaceRoot
  }

  /** Atomically write the state file: temp file plus rename, temp removed on failure. */
  async function writeState(records: RoutineRecord[], associations: Map<string, string>): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true })
    const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    const known = new Set(records.map(record => record.id))
    const workspaces: Record<string, string> = {}
    for (const [id, root] of associations) {
      if (known.has(id)) workspaces[id] = root
    }
    const payload = JSON.stringify({ version: 1, routines: records, workspaces } satisfies SchedulerStateFile)
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
    const snapshot = routines.map(copyRecord)
    const associations = new Map(routineWorkspaces)
    persistChain = persistChain
      .then(() => writeState(snapshot, associations), () => writeState(snapshot, associations))
    void persistChain.catch((error: unknown) => {
      log?.('warn', 'scheduler failed to persist routines', error)
    })
  }

  /** Await every queued write; rejects when the latest write failed. */
  async function flush(): Promise<void> {
    await persistChain
  }

  /** Load the state file; a missing file is empty, unreadable or invalid logs. */
  async function load(): Promise<RoutineRecord[]> {
    let raw: string
    try {
      raw = await readFile(statePath, 'utf-8')
    } catch (error) {
      if (isMissingFile(error)) {
        // Session-owned schedules are not migrated: a leftover legacy store is
        // ignored with one log line and routines start from an empty list.
        const legacyPath = join(dirname(statePath), 'schedules.json')
        if (await stat(legacyPath).then(() => true, error => !isMissingFile(error))) {
          log?.('warn', `ignoring legacy schedule store ${legacyPath}; session-owned schedules are not migrated`)
        }
        return []
      }
      log?.('warn', `scheduler could not read ${statePath}; starting with an empty routine list`, error)
      return []
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      const list = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { routines?: unknown }).routines
        : undefined
      if (!Array.isArray(list)) throw new Error('invalid routine store')
      // Read the persisted original-workspace association. A store written
      // before workspace switching existed has none; each of its records is
      // associated with THIS workspace — the one active at its first load after
      // the upgrade — and the association is persisted so a later switch can no
      // longer re-home a legacy routine.
      const storedWorkspaces = new Map<string, string>()
      const rawWorkspaces = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { workspaces?: unknown }).workspaces
        : undefined
      if (rawWorkspaces && typeof rawWorkspaces === 'object' && !Array.isArray(rawWorkspaces)) {
        for (const [id, root] of Object.entries(rawWorkspaces as Record<string, unknown>)) {
          if (typeof root === 'string' && root !== '') storedWorkspaces.set(id, root)
        }
      }
      const records: RoutineRecord[] = []
      for (const entry of list) {
        const record = readRecord(entry)
        if (!record) continue
        records.push(record)
        const assigned = storedWorkspaces.get(record.id) ?? workspaceRoot
        if (storedWorkspaces.get(record.id) !== assigned) associationDirty = true
        storedWorkspaces.set(record.id, assigned)
      }
      routineWorkspaces.clear()
      for (const [id, root] of storedWorkspaces) routineWorkspaces.set(id, root)
      return records
    } catch (error) {
      log?.('warn', `scheduler found invalid content in ${statePath}; starting with an empty routine list`, error)
      return []
    }
  }

  /**
   * Resolve one stored record by id, rejecting an unknown id or a record owned
   * by another workspace. A scheduler never mutates a routine that does not
   * belong to the workspace it serves.
   */
  function findRecord(id: string): RoutineRecord {
    const record = routines.find(candidate => candidate.id === id)
    if (!record || recordWorkspace(record) !== workspaceRoot) {
      throw new Error(`unknown routine: ${id}`)
    }
    return record
  }

  /** A fresh unique 8 lowercase hex characters id. */
  function nextId(): string {
    let id = randomBytes(4).toString('hex')
    while (routines.some(record => record.id === id)) id = randomBytes(4).toString('hex')
    return id
  }

  /** One polling pass: fire every active record whose nextRunAt has passed. */
  async function tick(): Promise<void> {
    // Admission gate at tick entry: while a hot switch or shutdown is staging,
    // the daemon suppresses the whole pass so no wake can start after isIdle.
    if (stopped || ticking || canRun?.() === false) return
    ticking = true
    try {
      const now = Date.now()
      // Snapshot the ids that are due now. Each live record is re-read before
      // its wake, because an earlier awaited wake in this same tick may have
      // left the store paused, resumed or deleted. A record owned by another
      // workspace is never due here: its wake must not fire into this
      // workspace's bots.
      const dueIds = routines
        .filter(record =>
          recordWorkspace(record) === workspaceRoot
          && record.state === 'active'
          && record.nextRunAt !== undefined
          && Date.parse(record.nextRunAt) <= now)
        .map(record => record.id)
      if (dueIds.length === 0) return
      let changed = false
      for (const id of dueIds) {
        if (stopped) break
        // Re-read the live record: skip it when it was paused, deleted,
        // rescheduled into the future or otherwise left the active state while
        // another wake in this tick was awaited.
        const record = routines.find(candidate => candidate.id === id)
        if (!record || record.state !== 'active' || record.nextRunAt === undefined
          || Date.parse(record.nextRunAt) > now) {
          continue
        }
        // Busy gate: skip while this same routine already has a wake being
        // processed or queued. An open round waiting on watched sessions is
        // not busy, so unrelated routines are not blocked. The record keeps
        // its past nextRunAt and its runCount, so it stays due and fires on a
        // later tick once the routine is free.
        if (busy?.(record)) continue
        const fireAt = new Date()
        let wakeError: unknown
        // Admission gate re-checked immediately before the wake: a scheduler
        // suppressed by an in-progress switch or shutdown must not start a
        // wake after the daemon was observed idle.
        if (canRun?.() === false) break
        try {
          await wake(copyRecord(record))
        } catch (error) {
          wakeError = error
        }
        // A stop request during the awaited wake aborts the rest of this tick
        // without persisting anything: a shutdown rejection must not be stored.
        if (stopped) return
        // Re-read the live record: it may have been paused or deleted while the
        // wake above was awaited. A deleted record writes nothing.
        const after = routines.find(candidate => candidate.id === id)
        if (!after) continue
        if (wakeError !== undefined) {
          // A wake rejection (unknown or disabled bot) skips the run and
          // records the failure: a recurring routine retries on its next
          // interval, a one-shot routine fails outright.
          after.lastError = wakeError instanceof Error ? wakeError.message : String(wakeError)
          if (after.recurring) {
            after.nextRunAt = new Date(fireAt.getTime() + after.intervalMinutes * 60_000).toISOString()
          } else if (after.state === 'active') {
            after.state = 'failed'
            delete after.nextRunAt
          }
          changed = true
          log?.('warn', `scheduler failed to wake bot ${after.botId} for routine ${after.id}`, wakeError)
          continue
        }
        // The wake happened: always record the counters and the next run time,
        // but keep a pause that arrived during the wake.
        after.runCount += 1
        after.lastRunAt = fireAt.toISOString()
        delete after.lastError
        if (after.recurring) {
          const next = new Date(fireAt.getTime() + after.intervalMinutes * 60_000)
          // Config-declared (named) routines never expire: only unnamed
          // routines are bounded by their expiresAt.
          if (after.name === undefined && after.expiresAt !== undefined && next.getTime() > Date.parse(after.expiresAt)) {
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
        log?.('info', `scheduler fired routine ${after.id} for bot ${after.botId}`)
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
    routines = await load()
    prepared = true
    // Persist the first-load workspace association of any legacy routine, so a
    // later switch reads it back instead of re-homing the record into the
    // switched-to workspace.
    if (associationDirty) {
      associationDirty = false
      persist()
    }
  }

  /** Fire due routines once, then poll every 5s. A run after stop() is a no-op. */
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
    list(botId?: string): RoutineListResult {
      // Only this workspace's routines are ever listed; another workspace's
      // routines stay owned by that workspace and its bots.
      const filtered = routines.filter(record =>
        recordWorkspace(record) === workspaceRoot
        && (botId === undefined || record.botId === botId))
      const sorted = [...filtered].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      return { routines: sorted.map(copyRecord) }
    },
    create(input: RoutineCreateParams): RoutineRecord {
      const prompt = input.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must not be empty')
      if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`)
      if (!Number.isInteger(input.intervalMinutes)
        || input.intervalMinutes < MIN_INTERVAL_MINUTES
        || input.intervalMinutes > MAX_INTERVAL_MINUTES) {
        throw new Error(`intervalMinutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`)
      }
      const deliver = parseRoutineDeliver(input.deliver)
      const activeCount = routines.filter(record =>
        record.botId === input.botId && (record.state === 'active' || record.state === 'paused')).length
      if (activeCount >= MAX_PER_BOT) throw new Error(`routine limit reached (${MAX_PER_BOT} per bot)`)
      const now = new Date()
      const record: RoutineRecord = {
        id: nextId(),
        botId: input.botId,
        prompt,
        intervalMinutes: input.intervalMinutes,
        recurring: input.recurring,
        state: 'active',
        deliver,
        createdAt: now.toISOString(),
        nextRunAt: new Date(now.getTime() + input.intervalMinutes * 60_000).toISOString(),
        ...(input.recurring ? { expiresAt: new Date(now.getTime() + EXPIRY_MS).toISOString() } : {}),
        runCount: 0,
      }
      routines.push(record)
      // The record belongs to this scheduler's workspace for its whole life.
      routineWorkspaces.set(record.id, workspaceRoot)
      persist()
      return copyRecord(record)
    },
    update(id: string, state: 'active' | 'paused'): RoutineRecord {
      const record = findRecord(id)
      const previous: RoutineState = record.state
      if (previous !== 'active' && previous !== 'paused') throw new Error(`routine ${id} is ${previous}`)
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
    run(id: string): RoutineRecord {
      const record = findRecord(id)
      record.state = 'active'
      delete record.lastError
      record.nextRunAt = new Date().toISOString()
      persist()
      // Fire the due record right away; tick enforces the stopped, ticking,
      // canRun and busy gates itself.
      void tick()
      return copyRecord(record)
    },
    remove(id: string): void {
      const record = findRecord(id)
      routines = routines.filter(candidate => candidate.id !== record.id)
      routineWorkspaces.delete(record.id)
      persist()
    },
    async reconcile(botId: string, configs: readonly RoutineConfig[]): Promise<void> {
      // Validate each declared entry with the same limits create enforces; an
      // invalid entry is skipped with a warn log and never touches the store.
      const valid: RoutineConfig[] = []
      for (const config of configs) {
        const prompt = config.prompt.trim()
        if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
          log?.('warn', `scheduler skipped routine config ${config.name}: prompt must be 1..${MAX_PROMPT_LENGTH} characters`)
          continue
        }
        if (!Number.isInteger(config.intervalMinutes)
          || config.intervalMinutes < MIN_INTERVAL_MINUTES
          || config.intervalMinutes > MAX_INTERVAL_MINUTES) {
          log?.('warn', `scheduler skipped routine config ${config.name}: intervalMinutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`)
          continue
        }
        let deliver: RoutineDeliver
        try {
          deliver = parseRoutineDeliver(config.deliver)
        } catch (error) {
          log?.('warn', `scheduler skipped routine config ${config.name}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        valid.push({ name: config.name, prompt, intervalMinutes: config.intervalMinutes, deliver })
      }

      const now = Date.now()
      let changed = false

      // Create missing and update changed config-declared routines of this bot.
      for (const config of valid) {
        const existing = routines.find(candidate =>
          recordWorkspace(candidate) === workspaceRoot
          && candidate.botId === botId
          && candidate.name === config.name)
        if (!existing) {
          const record: RoutineRecord = {
            id: nextId(),
            botId,
            name: config.name,
            prompt: config.prompt,
            intervalMinutes: config.intervalMinutes,
            recurring: true,
            state: 'active',
            deliver: config.deliver,
            createdAt: new Date(now).toISOString(),
            nextRunAt: new Date(now + config.intervalMinutes * 60_000).toISOString(),
            runCount: 0,
          }
          routines.push(record)
          routineWorkspaces.set(record.id, workspaceRoot)
          changed = true
          continue
        }
        const intervalChanged = existing.intervalMinutes !== config.intervalMinutes
        const reactivating = existing.state === 'finished' || existing.state === 'failed'
        if (existing.prompt === config.prompt
          && !intervalChanged
          && existing.deliver === config.deliver
          && !reactivating) {
          continue
        }
        existing.prompt = config.prompt
        existing.intervalMinutes = config.intervalMinutes
        existing.deliver = config.deliver
        if (reactivating) existing.state = 'active'
        // Only an interval change reschedules a live routine; a reactivated
        // routine needs a fresh nextRunAt because finishing cleared it.
        if (intervalChanged || existing.nextRunAt === undefined) {
          existing.nextRunAt = new Date(now + config.intervalMinutes * 60_000).toISOString()
        }
        changed = true
      }

      // Delete this bot's config-declared routines whose name is no longer
      // declared. A name still present in the config — even when that entry was
      // rejected as invalid above — keeps its routine. Records without a name
      // (Desktop-created) are never reconciled.
      const declaredNames = new Set(configs.map(config => config.name))
      const before = routines.length
      routines = routines.filter(record =>
        recordWorkspace(record) !== workspaceRoot
        || record.botId !== botId
        || record.name === undefined
        || declaredNames.has(record.name))
      if (routines.length !== before) {
        const live = new Set(routines.map(record => record.id))
        for (const id of [...routineWorkspaces.keys()]) {
          if (!live.has(id)) routineWorkspaces.delete(id)
        }
        changed = true
      }

      if (changed) persist()
    },
  }
}
