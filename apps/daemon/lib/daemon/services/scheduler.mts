import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  RoutineCreateParams,
  RoutineListResult,
  RoutineRecord,
  RoutineState,
} from '../../protocol/methods/routine.mts'
import { validateRoutine, writeRoutine, removeRoutine, type RoutineDefinition } from './bot-agents/routine-files.mts'

/** How often due routines are checked. */
const TICK_MS = 5_000
/** At most this many active or paused routines may exist per bot. */
const MAX_PER_BOT = 50
const MAX_PROMPT_LENGTH = 4_000

/** Diagnostic sink; wired to the daemon log by the caller. */
export type SchedulerLog = (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void

/**
 * A due routine wakes its owning bot agent through this callback instead of
 * sending into a session. A rejection (for example an unknown or disabled bot)
 * records `lastError` on the routine; a resolved call counts as a run.
 */
export type RoutineWake = (routine: RoutineRecord, text?: string) => void | Promise<void>

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
  /**
   * The directory of one bot's routine files on this device. Routine files are
   * the definitions: create, update and remove write them, and {@link
   * Scheduler.sync} adopts them. Without it routines live only in the store.
   */
  routinesDir?: (botId: string) => string
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
  update(id: string, patch: import('../../protocol/methods/routine.mts').RoutineUpdateParams): RoutineRecord
  todoChanged(changes: readonly { todoId: string; event: string; author: string }[]): Promise<void>
  run(id: string): RoutineRecord
  remove(id: string): void
  /**
   * Adopt one bot's routine files: create, change or drop its stored routines
   * so they match, keeping run state for the same ids. `undefined` means the
   * bot has no routines directory yet; its stored routines are then written out
   * as files once, so nothing is lost on the move to files.
   */
  sync(botId: string, definitions: readonly RoutineDefinition[] | undefined): void
  /** One bot's recorded last-run timestamps, by routine id. */
  lastRunAt(botId: string): ReadonlyMap<string, string>
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
    || (record.intervalMinutes !== undefined && typeof record.intervalMinutes !== 'number')
    || (record.on !== undefined && record.on !== 'todo')
    || (record.match !== undefined && (!Array.isArray(record.match) || record.match.some(item => typeof item !== 'string')))
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
    ...(typeof record.intervalMinutes === 'number' ? { intervalMinutes: record.intervalMinutes } : {}),
    ...(record.on === 'todo' ? { on: 'todo', match: record.match as string[] } : {}),
    // A routine an older store ended (finished or failed) comes back paused.
    state: record.state === 'active' ? 'active' : 'paused',
    createdAt: record.createdAt,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
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
function ruleMatches(rule: string, event: string): boolean {
  if (rule === event) return true
  const wildcard = /^([+-][^*]+)\*$/u.exec(rule)
  return wildcard !== null && event.startsWith(wildcard[1]!)
}

export function createScheduler(options: CreateSchedulerOptions): Scheduler {
  const { statePath, wake, log, workspaceRoot, canRun, busy, routinesDir } = options
  /** The latest routine files per bot, applied again after the store loads. */
  const definitions = new Map<string, readonly RoutineDefinition[] | undefined>()
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
    const persisted = records.filter(record => record.intervalMinutes !== undefined).map(record => {
      const copy = copyRecord(record)
      delete copy.on
      delete copy.match
      return copy
    })
    const known = new Set(persisted.map(record => record.id))
    const workspaces: Record<string, string> = {}
    for (const [id, root] of associations) {
      if (known.has(id)) workspaces[id] = root
    }
    const payload = JSON.stringify({ version: 1, routines: persisted, workspaces } satisfies SchedulerStateFile)
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
          && record.intervalMinutes !== undefined
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
          // A wake rejection (unknown or disabled bot) skips the run, records
          // the failure and retries on the next interval.
          after.lastError = wakeError instanceof Error ? wakeError.message : String(wakeError)
          if (after.intervalMinutes !== undefined) after.nextRunAt = new Date(fireAt.getTime() + after.intervalMinutes * 60_000).toISOString()
          changed = true
          log?.('warn', `scheduler failed to wake bot ${after.botId} for routine ${after.id}`, wakeError)
          continue
        }
        // The wake happened: always record the counters and the next run time,
        // but keep a pause that arrived during the wake.
        after.runCount += 1
        after.lastRunAt = fireAt.toISOString()
        delete after.lastError
        if (after.intervalMinutes !== undefined) after.nextRunAt = new Date(fireAt.getTime() + after.intervalMinutes * 60_000).toISOString()
        changed = true
        log?.('info', `scheduler fired routine ${after.id} for bot ${after.botId}`)
      }
      if (changed) persist()
    } finally {
      ticking = false
    }
  }

  /** Write one record's definition file; a failure is logged, never thrown. */
  function saveFile(record: RoutineRecord): void {
    if (routinesDir === undefined || (record.state !== 'active' && record.state !== 'paused')) return
    void writeRoutine(routinesDir(record.botId), {
      id: record.id,
      ...(record.name === undefined ? {} : { name: record.name }),
      ...(record.intervalMinutes === undefined ? {} : { intervalMinutes: record.intervalMinutes }),
      ...(record.on === undefined ? {} : { on: record.on, match: record.match }),
      state: record.state,
      prompt: record.prompt,
    }).catch(error => log?.('warn', `scheduler could not write routine file ${record.id}`, error))
  }

  /** Make one bot's stored routines match its files. */
  function applyDefinitions(botId: string, files: readonly RoutineDefinition[] | undefined): void {
    const owned = routines.filter(record => record.botId === botId && recordWorkspace(record) === workspaceRoot)
    if (files === undefined) {
      for (const record of owned) saveFile(record)
      return
    }
    const now = Date.now()
    const wanted = new Map(files.map(file => [file.id, file]))
    let changed = false
    for (const record of owned) {
      if (wanted.has(record.id)) continue
      routines = routines.filter(candidate => candidate !== record)
      routineWorkspaces.delete(record.id)
      changed = true
    }
    for (const file of files) {
      const record = routines.find(candidate => candidate.id === file.id)
      if (record !== undefined && record.botId !== botId) {
        log?.('warn', `routine ${file.id} of bot ${botId} clashes with a routine of bot ${record.botId}; skipped`)
        continue
      }
      const next = file.intervalMinutes === undefined ? undefined : new Date(now + file.intervalMinutes * 60_000).toISOString()
      if (record === undefined) {
        routines.push({
          id: file.id,
          botId,
          ...(file.name === undefined ? {} : { name: file.name }),
          prompt: file.prompt,
          ...(file.intervalMinutes === undefined ? {} : { intervalMinutes: file.intervalMinutes }),
          ...(file.on === undefined ? {} : { on: file.on, match: file.match }),
          state: file.state,
          createdAt: new Date(now).toISOString(),
          ...(file.state === 'active' && next !== undefined ? { nextRunAt: next } : {}),
          runCount: 0,
        })
        routineWorkspaces.set(file.id, workspaceRoot)
        changed = true
        continue
      }
      const before = JSON.stringify(record)
      const priorInterval = record.intervalMinutes
      record.prompt = file.prompt
      if (file.intervalMinutes === undefined) delete record.intervalMinutes
      else record.intervalMinutes = file.intervalMinutes
      if (file.on === undefined) { delete record.on; delete record.match }
      else { record.on = file.on; record.match = file.match }
      if (file.name === undefined) delete record.name
      else record.name = file.name
      if (priorInterval !== file.intervalMinutes && file.intervalMinutes !== undefined
        && record.nextRunAt !== undefined && next !== undefined && Date.parse(record.nextRunAt) > Date.parse(next)) {
        record.nextRunAt = next
      }
      if (file.intervalMinutes === undefined) delete record.nextRunAt
      if (file.state === 'paused') {
        record.state = 'paused'
      } else if (record.state !== 'active') {
        record.state = 'active'
        if (next !== undefined && (record.nextRunAt === undefined || Date.parse(record.nextRunAt) <= now)) record.nextRunAt = next
      } else if (record.nextRunAt === undefined) {
        if (next !== undefined) record.nextRunAt = next
      }
      if (JSON.stringify(record) !== before) changed = true
    }
    if (changed) persist()
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
    for (const [botId, files] of definitions) applyDefinitions(botId, files)
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
      const definition: RoutineDefinition = { id: nextId(), ...(input.name === undefined ? {} : { name: input.name }), ...(input.intervalMinutes === undefined ? {} : { intervalMinutes: input.intervalMinutes }), ...(input.on === undefined ? {} : { on: input.on }), ...(input.match === undefined ? {} : { match: input.match }), state: 'active', prompt }
      const valid = validateRoutine(definition)
      const activeCount = routines.filter(record => record.botId === input.botId).length
      if (activeCount >= MAX_PER_BOT) throw new Error(`routine limit reached (${MAX_PER_BOT} per bot)`)
      const now = new Date()
      const name = input.name?.trim()
      const record: RoutineRecord = {
        id: valid.id,
        botId: input.botId,
        ...(name !== undefined && name !== '' ? { name } : {}),
        prompt,
        ...(valid.intervalMinutes === undefined ? {} : { intervalMinutes: valid.intervalMinutes }),
        ...(valid.on === undefined ? {} : { on: valid.on, match: valid.match }),
        state: 'active',
        createdAt: now.toISOString(),
        ...(valid.intervalMinutes === undefined ? {} : { nextRunAt: new Date(now.getTime() + valid.intervalMinutes * 60_000).toISOString() }),
        runCount: 0,
      }
      routines.push(record)
      // The record belongs to this scheduler's workspace for its whole life.
      routineWorkspaces.set(record.id, workspaceRoot)
      persist()
      saveFile(record)
      return copyRecord(record)
    },
    update(id: string, patch: import('../../protocol/methods/routine.mts').RoutineUpdateParams): RoutineRecord {
      const record = findRecord(id)
      if (patch.intervalMinutes !== undefined && (patch.on !== undefined || patch.match !== undefined)) {
        throw new Error('on/match and intervalMinutes are mutually exclusive')
      }
      if (patch.match !== undefined && patch.on === undefined && record.on === undefined) {
        throw new Error('match requires an event routine')
      }
      const definition = validateRoutine({
        id: record.id,
        ...(patch.name ?? record.name ? { name: patch.name ?? record.name } : {}),
        ...(patch.intervalMinutes !== undefined
          ? { intervalMinutes: patch.intervalMinutes }
          : patch.on !== undefined ? { on: patch.on, match: patch.match ?? (patch.on === record.on ? record.match : undefined) }
            : record.on !== undefined ? { on: record.on, match: patch.match ?? record.match }
              : { intervalMinutes: record.intervalMinutes }),
        state: patch.state ?? record.state,
        prompt: patch.prompt ?? record.prompt,
      })
      record.prompt = definition.prompt
      if (definition.name === undefined) delete record.name
      else record.name = definition.name
      if (definition.intervalMinutes === undefined) { delete record.intervalMinutes; delete record.nextRunAt }
      else record.intervalMinutes = definition.intervalMinutes
      if (definition.on === undefined) { delete record.on; delete record.match }
      else { record.on = definition.on; record.match = definition.match }
      const state = patch.state ?? record.state
      if (state === 'paused') {
        record.state = 'paused'
      } else {
        record.state = 'active'
        const due = record.nextRunAt === undefined ? Number.NaN : Date.parse(record.nextRunAt)
        if (record.nextRunAt === undefined || due <= Date.now()) {
          if (record.intervalMinutes !== undefined) record.nextRunAt = new Date(Date.now() + record.intervalMinutes * 60_000).toISOString()
        }
      }
      persist()
      saveFile(record)
      return copyRecord(record)
    },
    async todoChanged(changes): Promise<void> {
      if (stopped || canRun?.() === false) return
      const candidates = routines.filter(record => recordWorkspace(record) === workspaceRoot
        && record.state === 'active' && record.on === 'todo' && record.match !== undefined)
      for (const record of candidates) {
        const selected = record.match!.flatMap(matched => {
          const change = changes.find(item => item.author !== record.botId && ruleMatches(matched, item.event))
          return change === undefined ? [] : [{ change, matched }]
        })[0]
        if (selected === undefined || stopped || canRun?.() === false) continue
        const transient = copyRecord(record)
        const text = `[wake:todo ${selected.change.todoId} ${selected.matched} by ${selected.change.author}] ${record.prompt}`
        try { await wake(transient, text) }
        catch (error) { log?.('warn', `scheduler failed to wake bot ${record.botId} for todo event`, error) }
      }
    },
    run(id: string): RoutineRecord {
      const record = findRecord(id)
      if (record.intervalMinutes === undefined) throw new Error('event routines cannot be run by timer')
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
      if (routinesDir !== undefined) {
        void removeRoutine(routinesDir(record.botId), record.id)
          .catch(error => log?.('warn', `scheduler could not remove routine file ${record.id}`, error))
      }
    },
    sync(botId: string, files: readonly RoutineDefinition[] | undefined): void {
      definitions.set(botId, files)
      if (prepared && !stopped) applyDefinitions(botId, files)
    },
    lastRunAt(botId: string): ReadonlyMap<string, string> {
      const runs = new Map<string, string>()
      for (const record of routines) {
        if (record.botId === botId && record.lastRunAt !== undefined) runs.set(record.id, record.lastRunAt)
      }
      return runs
    },
  }
}
