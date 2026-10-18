import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveWrenyardStateRoot } from '@wrenyard/paths'
import { assertCleanupDbUsable, getDb, runIncrementalVacuum, setSuspendedCleanupFence } from '../../db/connection.mts'
import type { ForemanDatabase } from '../../db/types.mts'
import { ProjectManager, foremanWorkspaceFromEnv } from '../project/manager.mts'
import type { WorktreeInfo } from '../project/manager.mts'
import type {
  CleanupPreviewResult,
  CleanupRunResult,
  StorageCleanupCategoryId,
  StorageCleanupCategorySummary,
  StorageCleanupOutcome,
  StorageCleanupPathEvidence,
  StorageCleanupPolicy,
  StorageCleanupRunRecord,
} from '../../protocol/methods/storage.mts'

/**
 * Conservative managed-artifact cleanup for the Wrenyard state root.
 *
 * The service inventories five categories (`artifacts`, `logs`, `clients`,
 * `worktrees`, `debug`) and removes only entries whose ownership and
 * inactivity are proven from durable evidence: a terminal task row, an owned
 * `.wrenyard-artifact.json` closed-log or debug marker whose writer/owner is
 * gone, a terminal `.wrenyard-run.json` run home whose recorded child
 * processes are gone, or a completed bot item plus a merged, clean,
 * referenced-nowhere worktree. Two thresholds apply per category: normal
 * retention, and a lower hard floor that is only used when the category
 * exceeds its byte target. Nothing at or below the floor is ever removed.
 * `previewManagedCleanup` never writes; `runManagedCleanup` records a durable
 * audit row before any deletion and revalidates every path at a synchronous
 * deletion boundary. The scanner never follows a symlink and refuses any path
 * whose ancestry is not confined by the real state root.
 */

const MIB = 1024 * 1024

/** DAEMON/Desktop-owned log files; every other writer log stays protected. */
const MANAGED_LOG_FILES: readonly string[] = [
  'daemon.log',
  'desktop-daemon-events.log',
  'wrenyard-error.log',
  'wrenyard-out.log',
]

/** Client families that own per-run homes under `clients/<family>/runs/<id>`. */
const RUN_HOME_FAMILIES = ['codebuddy', 'opencode'] as const

/** Marker written inside an owned per-run client home. */
const RUN_MARKER_FILE = '.wrenyard-run.json'
/** Marker written inside a managed closed-log or debug artifact directory. */
const ARTIFACT_MARKER_FILE = '.wrenyard-artifact.json'
/** State-root debug directories are recognized only by this prefix plus a marker. */
const DEBUG_DIRECTORY_PREFIX = 'gdbg-'
/** Closed logs live under the managed per-directory `logs/closed/<id>` layout. */
const CLOSED_LOG_DIRECTORY = 'closed'

const TASK_ID_RE = /^task_[0-9a-f]{8}$/u
const WORKTREE_ID_RE = /^[A-Za-z0-9_-]{8}$/u

/** Task run statuses that prove a task is finished and will not write more output. */
const TERMINAL_TASK_STATUSES: readonly string[] = ['done', 'failed', 'cancelled', 'interrupted']
/** Task run statuses that mean a task still owns its worktree. */
const ACTIVE_TASK_STATUSES: readonly string[] = ['queued', 'running']
/** Workflow statuses that mean a workflow still owns its worktree. */
const ACTIVE_WORKFLOW_STATUSES: readonly string[] = ['running', 'paused']
/** Execution statuses that mean an execution still owns its working directory. */
const ACTIVE_EXECUTION_STATUSES: readonly string[] = ['queued', 'starting', 'running']

/**
 * Per-category retention/capacity policy. `removes: true` marks a category the
 * service may actually delete from, and only for entries whose ownership and
 * inactivity are proven. `clients` run homes are reclaimed as soon as they are
 * terminal and their recorded processes are gone (retention 0), with no
 * artificial waiting period.
 */
export const MANAGED_CLEANUP_POLICY: StorageCleanupPolicy = {
  categories: [
    { id: 'artifacts', retentionDays: 30, minimumRetentionDays: 7, targetBytes: 512 * MIB, removes: true },
    { id: 'logs', retentionDays: 7, minimumRetentionDays: 1, targetBytes: 256 * MIB, removes: true },
    { id: 'clients', retentionDays: 0, minimumRetentionDays: 0, targetBytes: 1024 * MIB, removes: true },
    { id: 'worktrees', retentionDays: 7, minimumRetentionDays: 7, targetBytes: 5 * 1024 * MIB, removes: true },
    { id: 'debug', retentionDays: 7, minimumRetentionDays: 1, targetBytes: 1024 * MIB, removes: true },
    // Database retention compacts payload rows in place; the byte target is
    // reported for visibility but never triggers capacity-driven eviction of
    // rows inside the retention window (see finalize).
    { id: 'database', retentionDays: 31, minimumRetentionDays: 31, targetBytes: 300 * MIB, removes: true },
  ],
}

/** Small valid-JSON marker that replaces a compacted event payload. */
const RETENTION_EVENT_MARKER = JSON.stringify({ schema_version: 'foreman.event.v1', retention: 'compacted' })
/** Event rows selected per keyset batch during a retention pass. */
const DB_EVENT_BATCH_ROWS = 25
/** Execution rows selected per keyset batch during a retention pass. */
const DB_EXECUTION_BATCH_ROWS = 1
/** Soft byte budget for one retention batch, when row sizes are measurable. */
const DB_BATCH_BYTE_BUDGET = 4 * MIB
/** Freelist pages reclaimed per incremental_vacuum chunk. */
const DB_VACUUM_PAGE_CHUNK = 64

export interface ManagedCleanupOptions {
  /** Injected clock; defaults to `new Date()`. */
  now?: Date
  /** Override the state root; defaults to the resolved Wrenyard state root. */
  stateRoot?: string
  /** Injected database; defaults to the process database when initialized. */
  db?: ForemanDatabase
  /** Injected project manager; defaults to one built from the workspace root or env. */
  projectManager?: ProjectManager
  /** Workspace root for the default project manager; defaults to the workspace env. */
  workspaceRoot?: string
  /** Restrict the operation to these categories; omitted means every category. */
  categories?: StorageCleanupCategoryId[]
  /** Audit attribution for an executed run; defaults to `rpc`. */
  trigger?: string
  /**
   * Override of the database retention window in days. Only a positive finite
   * integer is honoured; 0, negative and non-finite values fall back to the
   * policy default (31).
   */
  retentionDays?: number
}

/**
 * Internal subtype of a candidate within its category. It distinguishes an
 * owned run home from other (future) client state, and a proven closed log or
 * marker-owned debug directory from unrecognized siblings, so the removal path
 * can pick the right proof and never treats a lookalike entry as owned.
 */
type CleanupSubtype = 'run-home' | 'closed-log' | 'debug-dir'

interface RawCandidate {
  id: string
  category: StorageCleanupCategoryId
  path: string
  ownership: string
  logicalBytes: number
  allocatedBytes: number
  isDir: boolean
  safe: boolean
  safeReason: string
  ageDays?: number
  metadataPath?: string
  project?: string
  subtype?: CleanupSubtype
}

interface FinalCandidate extends RawCandidate {
  eligible: boolean
  reason: string
  selectedThreshold?: number
}

interface Measure {
  logicalBytes: number
  allocatedBytes: number
}

// ─── Process liveness + ownership markers ───────────────────────────

/** Probe result for a process or group. `unknown` is never proof of absence. */
type Liveness = 'dead' | 'alive' | 'unknown'

function isProcessId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Probe a PID, or its process group when `group` is set, for liveness. Only
 * `ESRCH` proves the target is gone; `EPERM` and every other error mean the
 * process may still exist, so they protect it. Process groups are not probed
 * on Windows, where there is no reliable tree identity.
 */
function probeLiveness(pid: number | undefined, group = false): Liveness {
  if (!isProcessId(pid)) return 'unknown'
  if (group && process.platform === 'win32') return 'unknown'
  try {
    process.kill(group ? -pid : pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

function describeLiveness(liveness: Liveness): string {
  return liveness === 'alive' ? 'still live' : 'not provably gone'
}

/** `.wrenyard-run.json` as written by the owned run-home lifecycle (version 1). */
interface RunMarker {
  version: 1
  client_family: 'opencode' | 'codebuddy'
  run_id: string
  state: 'active' | 'done' | 'failed'
  created_at: string
  finished_at?: string
  owner_pid?: number
  launch_phase?: 'prepared' | 'spawning' | 'running'
  child_pid?: number
  child_pgid?: number
}

const RUN_LAUNCH_PHASES: readonly string[] = ['prepared', 'spawning', 'running']

/**
 * Validate an already-parsed run-home marker. Markers written before process
 * provenance existed lack `owner_pid`/`launch_phase` and remain valid, so a
 * missing identity is unproven rather than proof that no process ran.
 */
function parseRunMarker(value: unknown): RunMarker | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const marker = value as Record<string, unknown>
  if (marker.version !== 1) return undefined
  if (marker.client_family !== 'opencode' && marker.client_family !== 'codebuddy') return undefined
  if (typeof marker.run_id !== 'string' || marker.run_id === '') return undefined
  if (marker.state !== 'active' && marker.state !== 'done' && marker.state !== 'failed') return undefined
  if (typeof marker.created_at !== 'string' || !Number.isFinite(Date.parse(marker.created_at))) return undefined
  if (marker.finished_at !== undefined && (typeof marker.finished_at !== 'string' || !Number.isFinite(Date.parse(marker.finished_at)))) {
    return undefined
  }
  for (const key of ['owner_pid', 'child_pid', 'child_pgid'] as const) {
    if (marker[key] !== undefined && !isProcessId(marker[key])) return undefined
  }
  if (marker.launch_phase !== undefined && !RUN_LAUNCH_PHASES.includes(marker.launch_phase as string)) return undefined
  return marker as unknown as RunMarker
}

/**
 * Why a run home cannot yet be reclaimed, or `undefined` when it can. A
 * terminal marker is reclaimed as soon as its recorded child processes are
 * gone; `prepared` means no child was spawned, `spawning` is an ambiguous
 * crash window, and a missing owner identity is never treated as proof of
 * death.
 */
function runHomeBlockReason(marker: RunMarker): string | undefined {
  if (marker.state === 'done' || marker.state === 'failed') {
    if (marker.finished_at === undefined) return 'terminal run home has no finish time; protected'
    if (marker.child_pid !== undefined) {
      const child = probeLiveness(marker.child_pid)
      if (child !== 'dead') return `recorded child process is ${describeLiveness(child)}; protected`
    }
    if (marker.child_pgid !== undefined) {
      const group = probeLiveness(marker.child_pgid, true)
      if (group !== 'dead') return `recorded child process group is ${describeLiveness(group)}; protected`
    }
    return undefined
  }

  if (marker.launch_phase === 'prepared') {
    if (marker.owner_pid === undefined) return 'active run home has no owner identity; protected'
    const owner = probeLiveness(marker.owner_pid)
    if (owner !== 'dead') return `owning process is ${describeLiveness(owner)}; protected`
    return undefined
  }
  if (marker.launch_phase === 'running') {
    if (process.platform === 'win32') {
      return 'running run home cannot be recovered on this platform without reliable process-tree proof; protected'
    }
    if (marker.owner_pid === undefined || marker.child_pid === undefined) {
      return 'running run home has incomplete process provenance; protected'
    }
    const owner = probeLiveness(marker.owner_pid)
    if (owner !== 'dead') return `owning process is ${describeLiveness(owner)}; protected`
    const child = probeLiveness(marker.child_pid)
    if (child !== 'dead') return `child process is ${describeLiveness(child)}; protected`
    if (marker.child_pgid !== undefined) {
      const group = probeLiveness(marker.child_pgid, true)
      if (group !== 'dead') return `child process group is ${describeLiveness(group)}; protected`
    }
    return undefined
  }
  return 'active run home is in an unrecoverable launch phase; protected'
}

/**
 * `.wrenyard-artifact.json` as written for a managed closed log directory
 * (`logs/closed/<id>`) or a managed debug directory (`gdbg-*`). The marker, not
 * the entry name, is what establishes ownership.
 */
interface ArtifactMarker {
  version: 1
  kind: 'log' | 'debug'
  state: 'done' | 'failed'
  producer: 'wrenyard'
  created_at: string
  finished_at: string
  owner_pid?: number
  task_id?: string
  taskId?: string
  closed?: boolean
}

function parseArtifactMarker(value: unknown, kind: 'log' | 'debug'): ArtifactMarker | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const marker = value as Record<string, unknown>
  if (marker.version !== 1) return undefined
  if (marker.kind !== kind) return undefined
  if (marker.producer !== 'wrenyard') return undefined
  if (marker.state !== 'done' && marker.state !== 'failed') return undefined
  if (typeof marker.created_at !== 'string' || !Number.isFinite(Date.parse(marker.created_at))) return undefined
  if (typeof marker.finished_at !== 'string' || !Number.isFinite(Date.parse(marker.finished_at))) return undefined
  if (marker.owner_pid !== undefined && !isProcessId(marker.owner_pid)) return undefined
  for (const key of ['task_id', 'taskId'] as const) {
    if (marker[key] !== undefined && (typeof marker[key] !== 'string' || (marker[key] as string) === '')) return undefined
  }
  if (marker.closed !== undefined && typeof marker.closed !== 'boolean') return undefined
  return marker as unknown as ArtifactMarker
}

function artifactTaskId(marker: ArtifactMarker): string | undefined {
  return marker.task_id ?? marker.taskId
}

type MarkerRead =
  | { status: 'ok'; value: unknown }
  | { status: 'absent' }
  | { status: 'invalid' }

/** Read an ownership marker only through validated, symlink-free ancestry. */
async function readMarker(stateRoot: string, markerPath: string): Promise<MarkerRead> {
  const inspection = await inspectPath(stateRoot, markerPath)
  if (inspection.missing) return { status: 'absent' }
  if (inspection.error !== undefined || inspection.stats === undefined || !inspection.stats.isFile()) {
    return { status: 'invalid' }
  }
  try {
    return { status: 'ok', value: JSON.parse(await readFile(markerPath, 'utf8')) as unknown }
  } catch {
    return { status: 'invalid' }
  }
}

// ─── Filesystem helpers ─────────────────────────────────────────────

interface PathInspection {
  stats?: Stats
  missing?: boolean
  error?: string
  /** Set when the refusal is specifically a symlink on the inspected path. */
  symlink?: boolean
}

function isMissingError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Validate every path component from the canonical root without following links. */
async function inspectPath(stateRoot: string, absolute: string): Promise<PathInspection> {
  if (!isAbsolute(absolute)) return { error: 'path is not absolute' }
  const rel = relative(stateRoot, resolve(absolute))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { error: 'path is not a strict descendant of the state root' }
  }

  const components = rel.split(sep)
  let current = stateRoot
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index] as string)
    let stats: Stats
    try {
      stats = await lstat(current)
    } catch (error) {
      return isMissingError(error) ? { missing: true } : { error: 'path inspection failed' }
    }
    const leaf = index === components.length - 1
    if (stats.isSymbolicLink()) {
      return leaf
        ? { stats, error: 'candidate is a symlink', symlink: true }
        : { error: 'path ancestry contains a symlink', symlink: true }
    }
    if (!leaf && !stats.isDirectory()) return { error: 'path ancestry contains a non-directory' }
    if (leaf) return { stats }
  }
  return { error: 'path inspection failed' }
}

interface DirectoryListing {
  names: string[]
  /** Symlink refusal for the directory itself; the caller records it protected. */
  symlinkReason?: string
}

/**
 * List a managed directory only through validated, symlink-free ancestry. A
 * symlink on the directory's own path is returned to the caller so that single
 * entry is reported protected and the rest of the run continues; every other
 * inspection failure still throws, so metadata and genuine filesystem errors
 * keep failing closed instead of silently shrinking the inventory.
 */
async function listDirectory(stateRoot: string, path: string): Promise<DirectoryListing> {
  const inspection = await inspectPath(stateRoot, path)
  if (inspection.missing) return { names: [] }
  if (inspection.error !== undefined) {
    if (inspection.symlink === true) return { names: [], symlinkReason: inspection.error }
    throw new Error(inspection.error)
  }
  if (inspection.stats === undefined || !inspection.stats.isDirectory()) {
    throw new Error('directory inspection failed')
  }
  return { names: await readdir(path) }
}

const MEASURE_PATH_CONCURRENCY = 16

/** Recursively measure a validated path without following symlinks. */
async function measurePath(path: string): Promise<Measure> {
  const result: Measure = { logicalBytes: 0, allocatedBytes: 0 }
  const stack: string[] = [path]
  const inFlight = new Set<Promise<void>>()
  let firstError: { error: unknown } | undefined

  const measureEntry = async (current: string): Promise<void> => {
    const stats = await lstat(current)
    result.logicalBytes += stats.size
    result.allocatedBytes += stats.blocks * 512
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      const names = await readdir(current)
      for (const name of names) stack.push(join(current, name))
    }
  }

  while (firstError === undefined) {
    while (inFlight.size < MEASURE_PATH_CONCURRENCY && stack.length > 0) {
      const current = stack.pop() as string
      const task = measureEntry(current).then(
        () => {
          inFlight.delete(task)
        },
        (error: unknown) => {
          inFlight.delete(task)
          if (firstError === undefined) firstError = { error }
        },
      )
      inFlight.add(task)
    }
    if (inFlight.size === 0) break
    await Promise.race(inFlight)
  }

  if (inFlight.size > 0) await Promise.allSettled([...inFlight])
  if (firstError !== undefined) throw firstError.error
  return result
}

async function inspectAndMeasure(stateRoot: string, path: string): Promise<{ stats?: Stats; measure?: Measure; reason?: string }> {
  const inspection = await inspectPath(stateRoot, path)
  if (inspection.missing) return { reason: 'path is missing' }
  if (inspection.error !== undefined) {
    return {
      ...(inspection.stats === undefined ? {} : { stats: inspection.stats }),
      ...(inspection.stats?.isSymbolicLink()
        ? { measure: { logicalBytes: inspection.stats.size, allocatedBytes: inspection.stats.blocks * 512 } }
        : {}),
      reason: inspection.error,
    }
  }
  if (inspection.stats === undefined) return { reason: 'path inspection failed' }
  try {
    return { stats: inspection.stats, measure: await measurePath(path) }
  } catch {
    return { stats: inspection.stats, reason: 'path contents could not be inspected; protected' }
  }
}

async function isConfined(stateRoot: string, absolute: string): Promise<boolean> {
  const inspection = await inspectPath(stateRoot, absolute)
  return inspection.error === undefined && inspection.stats !== undefined
}

function isSafePathSynchronously(stateRoot: string, absolute: string, leafType: 'directory' | 'file'): boolean {
  if (!isAbsolute(absolute)) return false
  const rel = relative(stateRoot, resolve(absolute))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false

  try {
    const rootStats = lstatSync(stateRoot)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return false
    const components = rel.split(sep)
    let current = stateRoot
    for (let index = 0; index < components.length; index += 1) {
      current = join(current, components[index] as string)
      const stats = lstatSync(current)
      const leaf = index === components.length - 1
      if (stats.isSymbolicLink()) return false
      if (!leaf && !stats.isDirectory()) return false
      if (leaf && (leafType === 'directory' ? !stats.isDirectory() : !stats.isFile())) return false
    }
    return true
  } catch {
    return false
  }
}

/** Re-read a marker synchronously at the deletion boundary; only `ok` is safe. */
function readMarkerSynchronously(stateRoot: string, markerPath: string): MarkerRead {
  if (!isSafePathSynchronously(stateRoot, markerPath, 'file')) return { status: 'invalid' }
  try {
    return { status: 'ok', value: JSON.parse(readFileSync(markerPath, 'utf8')) as unknown }
  } catch {
    return { status: 'invalid' }
  }
}

/**
 * Synchronous deletion-boundary check for an owned client run home. It
 * re-reads the marker and re-probes every recorded process with no `await`
 * between this check and the caller's removal, so a home cannot be removed
 * while a surviving client tree still uses it.
 */
function syncClientRunHomeBlock(stateRoot: string, family: string, runId: string): string | undefined {
  const { path, markerPath } = clientRunHomePaths(stateRoot, family, runId)
  if (!isSafePathSynchronously(stateRoot, path, 'directory')) {
    return 'run home path failed immediate pre-removal validation; protected'
  }
  const markerRead = readMarkerSynchronously(stateRoot, markerPath)
  if (markerRead.status !== 'ok') return 'run home marker became unreadable at the deletion boundary; protected'
  const marker = parseRunMarker(markerRead.value)
  if (marker === undefined) return 'run home marker became invalid at the deletion boundary; protected'
  if (marker.client_family !== family || marker.run_id !== runId) {
    return 'run home marker identity changed at the deletion boundary; protected'
  }
  return runHomeBlockReason(marker)
}

/** Synchronous deletion-boundary check for a managed closed log directory. */
function syncClosedLogBlock(stateRoot: string, closedId: string): string | undefined {
  const path = join(stateRoot, 'logs', CLOSED_LOG_DIRECTORY, closedId)
  const markerPath = join(path, ARTIFACT_MARKER_FILE)
  if (!isSafePathSynchronously(stateRoot, path, 'directory')) {
    return 'closed log path failed immediate pre-removal validation; protected'
  }
  const markerRead = readMarkerSynchronously(stateRoot, markerPath)
  if (markerRead.status !== 'ok') return 'closed log marker became unreadable at the deletion boundary; protected'
  const marker = parseArtifactMarker(markerRead.value, 'log')
  if (marker === undefined) return 'closed log marker became invalid at the deletion boundary; protected'
  if (marker.closed !== true) {
    if (marker.owner_pid === undefined) return 'log writer closure is no longer proven; protected'
    const writer = probeLiveness(marker.owner_pid)
    if (writer !== 'dead') return `log writer process is ${describeLiveness(writer)}; protected`
  }
  return undefined
}

/** Synchronous deletion-boundary check for an owned debug directory. */
function syncDebugBlock(stateRoot: string, db: ForemanDatabase | undefined, name: string): string | undefined {
  const path = join(stateRoot, name)
  const markerPath = join(path, ARTIFACT_MARKER_FILE)
  if (!isSafePathSynchronously(stateRoot, path, 'directory')) {
    return 'debug path failed immediate pre-removal validation; protected'
  }
  const markerRead = readMarkerSynchronously(stateRoot, markerPath)
  if (markerRead.status !== 'ok') return 'debug marker became unreadable at the deletion boundary; protected'
  const marker = parseArtifactMarker(markerRead.value, 'debug')
  if (marker === undefined) return 'debug marker became invalid at the deletion boundary; protected'
  const ownerLiveness = marker.owner_pid === undefined ? 'unknown' : probeLiveness(marker.owner_pid)
  if (marker.owner_pid !== undefined && ownerLiveness !== 'dead') {
    return `owning process is ${describeLiveness(ownerLiveness)}; protected`
  }
  const taskId = artifactTaskId(marker)
  if (!(taskId !== undefined && isTerminalTask(db, taskId)) && ownerLiveness !== 'dead') {
    return 'debug ownership is no longer proven terminal; protected'
  }
  return undefined
}

function ageDaysFromIso(value: string | null | undefined, now: Date): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return undefined
  return (now.getTime() - parsed) / 86_400_000
}

function describeAge(days: number | undefined): string {
  return days === undefined ? 'unknown age' : `age ${days.toFixed(1)}d`
}

// ─── Database helpers ───────────────────────────────────────────────

function tryGetDb(injected: ForemanDatabase | undefined): ForemanDatabase | undefined {
  if (injected !== undefined) return injected
  try {
    return getDb()
  } catch {
    return undefined
  }
}

interface TaskAgeRow {
  status: string
  ended_at: string | null
}

function readTaskRow(db: ForemanDatabase | undefined, id: string): TaskAgeRow | undefined {
  if (db === undefined) return undefined
  try {
    return db.prepare<[string], TaskAgeRow>('SELECT status, ended_at FROM tasks WHERE id = ?').get(id)
  } catch {
    return undefined
  }
}

/** True when a durable task row exists and is terminal (it will write no more). */
function isTerminalTask(db: ForemanDatabase | undefined, id: string): boolean {
  const row = readTaskRow(db, id)
  return row !== undefined && TERMINAL_TASK_STATUSES.includes(row.status)
}

interface BotItemRow {
  state: string
  updated_at: string
  worktree_id: string | null
}

function readBotItem(db: ForemanDatabase | undefined, botId: string, itemId: string): BotItemRow | undefined {
  if (db === undefined) return undefined
  try {
    return db
      .prepare<[string, string], BotItemRow>('SELECT state, updated_at, worktree_id FROM bot_item WHERE bot_id = ? AND id = ?')
      .get(botId, itemId)
  } catch {
    return undefined
  }
}

function countRows(db: ForemanDatabase | undefined, sql: string, params: string[]): number {
  if (db === undefined) return -1
  try {
    const row = db.prepare<string[], { n: number }>(sql).get(...params)
    return row?.n ?? 0
  } catch {
    return -1
  }
}

/**
 * The shared retention window, used identically by preview and run so an
 * automatic scheduled pass and a manual RPC pass agree. Only a positive finite
 * integer override is honoured; anything else falls back to the policy default.
 */
function resolveRetentionDays(options: ManagedCleanupOptions): number {
  const policy = MANAGED_CLEANUP_POLICY.categories.find((category) => category.id === 'database')
  const fallback = policy?.retentionDays ?? 31
  const requested = options.retentionDays
  if (requested === undefined) return fallback
  return Number.isFinite(requested) && Number.isInteger(requested) && requested > 0 ? requested : fallback
}

interface DbPageStats {
  pageCount: number
  freelistCount: number
  pageSize: number
}

/** Cheap PRAGMA reads describing the database file footprint. */
function readDbPageStats(db: ForemanDatabase): DbPageStats | undefined {
  try {
    const pageCount = Number(db.pragma('page_count', { simple: true }))
    const freelistCount = Number(db.pragma('freelist_count', { simple: true }))
    const pageSize = Number(db.pragma('page_size', { simple: true }))
    if (!Number.isFinite(pageCount) || !Number.isFinite(freelistCount) || !Number.isFinite(pageSize)) return undefined
    return { pageCount, freelistCount, pageSize }
  } catch {
    return undefined
  }
}

/** `?, ?, ?` placeholder list for a fixed, small window of bound ids. */
function bindPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/** True when a cleanup path must stop and must not issue another statement. */
function cleanupStopped(): boolean {
  return cleanupStopRequested || !cleanupDbUsable()
}

interface RetentionInventory {
  interrupted: boolean
  eligibleEvents: number
  eligibleExecutions: number
  estimatedEligibleBytes: number
}

/**
 * Bounded, read-only inventory of retention-eligible rows.
 *
 * Every statement is bounded by a fixed raw-row window instead of a
 * full-table aggregate: the inner selection carries no eligibility predicate
 * and reads only the key — `SELECT id FROM events WHERE id > ? ORDER BY id
 * LIMIT n` for events (INTEGER primary key) and `SELECT rowid FROM executions
 * WHERE rowid > ? ORDER BY rowid LIMIT n` for executions, whose id is text —
 * and eligibility, counts and byte estimates are computed only inside that
 * window's keys. Windows advance through raw rows even when nothing in them
 * matches, and the loop yields to the event loop between windows, honouring
 * the cooperative stop token and the database fence before and after every
 * yield. Only lengths and metadata are read; no payload is materialised in JS.
 *
 * Eligibility and the cutoff match the retention pass exactly, so preview and
 * run agree: a NULL event payload carries no payload and is not eligible.
 * Returns `undefined` when the inventory could not be read at all.
 */
async function scanRetentionInventory(db: ForemanDatabase, cutoffIso: string): Promise<RetentionInventory | undefined> {
  const inventory: RetentionInventory = {
    interrupted: false,
    eligibleEvents: 0,
    eligibleExecutions: 0,
    estimatedEligibleBytes: 0,
  }
  try {
    let eventCursor = 0
    for (;;) {
      if (cleanupStopped()) {
        inventory.interrupted = true
        return inventory
      }
      const window = db
        .prepare<[number, number], { id: number }>(`SELECT id FROM events WHERE id > ? ORDER BY id LIMIT ?`)
        .all(eventCursor, DB_EVENT_BATCH_ROWS)
      if (window.length === 0) break
      await yieldToEventLoop()
      if (cleanupStopped()) {
        inventory.interrupted = true
        return inventory
      }
      const ids = window.map((row) => row.id)
      const row = db
        .prepare<unknown[], { n: number; bytes: number }>(
          `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM events
             WHERE id IN (${bindPlaceholders(ids.length)}) AND created_at < ?
               AND type IN ('message','tool_call','tool_result')
               AND data IS NOT NULL AND data != ?`,
        )
        .get(...ids, cutoffIso, RETENTION_EVENT_MARKER)
      inventory.eligibleEvents += row?.n ?? 0
      inventory.estimatedEligibleBytes += row?.bytes ?? 0
      eventCursor = ids[ids.length - 1] as number
      await yieldToEventLoop()
    }

    let executionCursor = 0
    for (;;) {
      if (cleanupStopped()) {
        inventory.interrupted = true
        return inventory
      }
      const window = db
        .prepare<[number, number], { rowid: number }>(`SELECT rowid FROM executions WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .all(executionCursor, DB_EXECUTION_BATCH_ROWS)
      if (window.length === 0) break
      await yieldToEventLoop()
      if (cleanupStopped()) {
        inventory.interrupted = true
        return inventory
      }
      const rowids = window.map((row) => row.rowid)
      const row = db
        .prepare<unknown[], { n: number; bytes: number }>(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(COALESCE(LENGTH(output), 0) + COALESCE(LENGTH(raw_result), 0) + COALESCE(LENGTH(prompt), 0)), 0) AS bytes
             FROM executions
             WHERE rowid IN (${bindPlaceholders(rowids.length)})
               AND status IN ('done','failed','cancelled','timeout','interrupted')
               AND ended_at IS NOT NULL AND ended_at < ?
               AND (output IS NOT NULL OR raw_result IS NOT NULL OR prompt != '')`,
        )
        .get(...rowids, cutoffIso)
      inventory.eligibleExecutions += row?.n ?? 0
      inventory.estimatedEligibleBytes += row?.bytes ?? 0
      executionCursor = rowids[rowids.length - 1] as number
      await yieldToEventLoop()
    }
    return inventory
  } catch {
    return undefined
  }
}

/**
 * Read-only inventory for the `database` category. Awaits the bounded
 * windowed scan above, so no statement issued by preview or run visits more
 * than a small fixed raw-row window; full row payloads are never
 * materialised.
 */
async function assessDatabase(
  stateRoot: string,
  db: ForemanDatabase | undefined,
  retentionDays: number,
  now: Date,
): Promise<RawCandidate> {
  const path = join(stateRoot, 'wrenyard.db')
  const ownership = 'database/wrenyard.db'
  if (db === undefined) {
    return protectedCandidate('wrenyard.db', 'database', path, ownership, 'database is unavailable; protected', { logicalBytes: 0, allocatedBytes: 0 })
  }
  const stats = readDbPageStats(db)
  if (stats === undefined) {
    return protectedCandidate('wrenyard.db', 'database', path, ownership, 'database page stats could not be read; protected', { logicalBytes: 0, allocatedBytes: 0 })
  }
  const allocatedBytes = stats.pageCount * stats.pageSize
  const measure: Measure = { logicalBytes: allocatedBytes, allocatedBytes }
  const cutoffIso = new Date(now.getTime() - retentionDays * 86_400_000).toISOString()
  const inventory = await scanRetentionInventory(db, cutoffIso)
  if (inventory === undefined) {
    return protectedCandidate('wrenyard.db', 'database', path, ownership, 'eligible row inventory could not be read; protected', measure)
  }
  if (inventory.interrupted) {
    return protectedCandidate('wrenyard.db', 'database', path, ownership, 'eligible row inventory was interrupted by daemon shutdown; protected', measure)
  }
  const { eligibleEvents, eligibleExecutions, estimatedEligibleBytes } = inventory
  // ageDays is the retention window itself: the candidate is eligible exactly
  // when rows older than the window exist. finalize treats the database
  // category as eligible only when ageDays >= retentionDays, so reporting the
  // window as the age makes "has eligible rows" the decision.
  const hasEligible = eligibleEvents + eligibleExecutions > 0
  return {
    id: 'wrenyard.db',
    category: 'database',
    path,
    ownership,
    logicalBytes: allocatedBytes,
    allocatedBytes,
    isDir: false,
    safe: true,
    safeReason: `${eligibleEvents} event payloads and ${eligibleExecutions} execution payloads older than ${retentionDays}d (≈${estimatedEligibleBytes} B)`,
    ageDays: hasEligible ? retentionDays : 0,
  }
}

/** Why a worktree is still referenced by live work, or `undefined` when idle. */
function activeReferenceReason(db: ForemanDatabase | undefined, id: string, path: string): string | undefined {
  if (db === undefined) return 'the database is unavailable, so references cannot be checked'
  const like = `${path}${sep}%`
  const taskActive = countRows(
    db,
    `SELECT COUNT(*) AS n FROM tasks WHERE worktree = ? AND status IN ('queued','running')`,
    [id],
  )
  if (taskActive !== 0) {
    return taskActive < 0 ? 'task references could not be read' : 'a queued or running task references this worktree'
  }
  const workflowActive = countRows(
    db,
    `SELECT COUNT(*) AS n FROM workflows
       WHERE (worktree = ? OR working_directory = ? OR working_directory LIKE ?)
         AND status IN ('running','paused')`,
    [id, path, like],
  )
  if (workflowActive !== 0) {
    return workflowActive < 0
      ? 'workflow references could not be read'
      : 'a running or paused workflow references this worktree'
  }
  const executionActive = countRows(
    db,
    `SELECT COUNT(*) AS n FROM executions
       WHERE (cwd = ? OR cwd LIKE ?) AND status IN ('queued','starting','running')`,
    [path, like],
  )
  if (executionActive !== 0) {
    return executionActive < 0
      ? 'execution references could not be read'
      : 'a queued, starting or running execution references this worktree'
  }
  return undefined
}

// ─── Category assessment ────────────────────────────────────────────

function protectedCandidate(
  id: string,
  category: StorageCleanupCategoryId,
  path: string,
  ownership: string,
  safeReason: string,
  measure: Measure,
  extra: { isDir?: boolean; metadataPath?: string; subtype?: CleanupSubtype } = {},
): RawCandidate {
  return {
    id,
    category,
    path,
    ownership,
    logicalBytes: measure.logicalBytes,
    allocatedBytes: measure.allocatedBytes,
    isDir: extra.isDir ?? false,
    safe: false,
    safeReason,
    ...(extra.metadataPath === undefined ? {} : { metadataPath: extra.metadataPath }),
    ...(extra.subtype === undefined ? {} : { subtype: extra.subtype }),
  }
}

async function assessArtifact(
  stateRoot: string,
  db: ForemanDatabase | undefined,
  id: string,
  now: Date,
): Promise<RawCandidate> {
  const path = join(stateRoot, 'artifacts', id)
  const ownership = `artifacts/${id}`
  const inspected = await inspectAndMeasure(stateRoot, path)
  const measure = inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 }
  const isDir = inspected.stats?.isDirectory() ?? false

  if (inspected.reason !== undefined) {
    return protectedCandidate(id, 'artifacts', path, ownership, `${inspected.reason}; protected`, measure, { isDir })
  }
  if (!TASK_ID_RE.test(id)) {
    return protectedCandidate(id, 'artifacts', path, ownership, 'not a managed task id; protected', measure, { isDir })
  }
  if (!isDir) {
    return protectedCandidate(id, 'artifacts', path, ownership, 'artifact path is not a directory; protected', measure, { isDir })
  }
  const row = readTaskRow(db, id)
  if (row === undefined) {
    return protectedCandidate(id, 'artifacts', path, ownership, 'no durable task record; protected', measure, { isDir })
  }
  if (!TERMINAL_TASK_STATUSES.includes(row.status)) {
    return protectedCandidate(id, 'artifacts', path, ownership, `task status '${row.status}' is not terminal; protected`, measure, { isDir })
  }
  const ageDays = ageDaysFromIso(row.ended_at, now)
  if (ageDays === undefined) {
    return protectedCandidate(id, 'artifacts', path, ownership, 'task has no valid terminal time; protected', measure, { isDir })
  }
  return {
    id,
    category: 'artifacts',
    path,
    ownership,
    logicalBytes: measure.logicalBytes,
    allocatedBytes: measure.allocatedBytes,
    isDir,
    safe: true,
    safeReason: `terminal task done at ${row.ended_at ?? 'unknown'}`,
    ageDays,
  }
}

async function assessLog(stateRoot: string, id: string, _now: Date): Promise<RawCandidate | undefined> {
  if (id.startsWith('.') || !MANAGED_LOG_FILES.includes(id)) return undefined
  const path = join(stateRoot, 'logs', id)
  const ownership = `logs/${id}`
  const inspected = await inspectAndMeasure(stateRoot, path)
  if (inspected.stats === undefined && inspected.reason === 'path is missing') return undefined
  const measure = inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 }
  if (inspected.reason !== undefined) {
    return protectedCandidate(id, 'logs', path, ownership, `${inspected.reason}; protected`, measure)
  }
  const isRegular = inspected.stats?.isFile() === true
  return protectedCandidate(
    id,
    'logs',
    path,
    ownership,
    isRegular
      ? 'active writer log; closure is not proven, so it is protected regardless of age'
      : 'managed log is not a regular file; protected',
    measure,
  )
}

/**
 * A closed log directory under `logs/closed/<id>`. Only a terminal marker
 * whose writer is proven gone — or that carries explicit `closed: true`
 * hand-off evidence — is eligible; a bare name or an old mtime proves nothing.
 */
async function assessClosedLog(stateRoot: string, closedId: string, now: Date): Promise<RawCandidate> {
  const path = join(stateRoot, 'logs', CLOSED_LOG_DIRECTORY, closedId)
  const markerPath = join(path, ARTIFACT_MARKER_FILE)
  const id = `${CLOSED_LOG_DIRECTORY}/${closedId}`
  const ownership = `logs/${CLOSED_LOG_DIRECTORY}/${closedId}`
  const extra = { isDir: true, subtype: 'closed-log' as const }
  const inspected = await inspectAndMeasure(stateRoot, path)
  const measure = inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 }
  if (inspected.reason !== undefined) {
    return protectedCandidate(id, 'logs', path, ownership, `${inspected.reason}; protected`, measure, extra)
  }
  if (inspected.stats === undefined || !inspected.stats.isDirectory()) {
    return protectedCandidate(id, 'logs', path, ownership, 'closed log is not a directory; protected', measure, extra)
  }
  const markerRead = await readMarker(stateRoot, markerPath)
  if (markerRead.status !== 'ok') {
    return protectedCandidate(
      id,
      'logs',
      path,
      ownership,
      markerRead.status === 'absent'
        ? 'closed log has no ownership marker; protected'
        : 'closed log marker is unreadable or not a regular file; protected',
      measure,
      extra,
    )
  }
  const marker = parseArtifactMarker(markerRead.value, 'log')
  if (marker === undefined) {
    return protectedCandidate(id, 'logs', path, ownership, 'closed log marker is incomplete or invalid; protected', measure, extra)
  }
  if (marker.closed !== true) {
    if (marker.owner_pid === undefined) {
      return protectedCandidate(id, 'logs', path, ownership, 'log writer closure is not proven; protected', measure, extra)
    }
    const writer = probeLiveness(marker.owner_pid)
    if (writer !== 'dead') {
      return protectedCandidate(id, 'logs', path, ownership, `log writer process is ${describeLiveness(writer)}; protected`, measure, extra)
    }
  }
  const ageDays = ageDaysFromIso(marker.finished_at, now)
  if (ageDays === undefined) {
    return protectedCandidate(id, 'logs', path, ownership, 'closed log has no valid finish time; protected', measure, extra)
  }
  return {
    id,
    category: 'logs',
    path,
    ownership,
    logicalBytes: measure.logicalBytes,
    allocatedBytes: measure.allocatedBytes,
    isDir: true,
    subtype: 'closed-log',
    safe: true,
    safeReason: 'closed log directory with proven writer closure',
    ageDays,
  }
}

/**
 * A state-root `gdbg-*` directory. The name alone proves nothing: eligibility
 * needs a valid `.wrenyard-artifact.json` (version 1, kind `debug`,
 * producer `wrenyard`, terminal state, finish time) whose owning task is a
 * terminal DB row or whose owning process is proven gone. Missing or
 * incomplete markers stay visible but protected, never adopted or fabricated.
 */
async function assessDebug(
  stateRoot: string,
  db: ForemanDatabase | undefined,
  name: string,
  now: Date,
): Promise<RawCandidate> {
  const path = join(stateRoot, name)
  const markerPath = join(path, ARTIFACT_MARKER_FILE)
  const ownership = `debug/${name}`
  const extra = { isDir: true, subtype: 'debug-dir' as const }
  const inspected = await inspectAndMeasure(stateRoot, path)
  const measure = inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 }
  if (inspected.reason !== undefined) {
    return protectedCandidate(name, 'debug', path, ownership, `${inspected.reason}; protected`, measure, extra)
  }
  if (inspected.stats === undefined || !inspected.stats.isDirectory()) {
    return protectedCandidate(name, 'debug', path, ownership, 'debug path is not a directory; protected', measure, extra)
  }
  const markerRead = await readMarker(stateRoot, markerPath)
  if (markerRead.status !== 'ok') {
    return protectedCandidate(
      name,
      'debug',
      path,
      ownership,
      markerRead.status === 'absent'
        ? 'debug directory has no ownership marker; protected'
        : 'debug marker is unreadable or not a regular file; protected',
      measure,
      extra,
    )
  }
  const marker = parseArtifactMarker(markerRead.value, 'debug')
  if (marker === undefined) {
    return protectedCandidate(name, 'debug', path, ownership, 'debug marker is incomplete or invalid; protected', measure, extra)
  }
  const ownerLiveness = marker.owner_pid === undefined ? 'unknown' : probeLiveness(marker.owner_pid)
  if (marker.owner_pid !== undefined && ownerLiveness !== 'dead') {
    return protectedCandidate(name, 'debug', path, ownership, `owning process is ${describeLiveness(ownerLiveness)}; protected`, measure, extra)
  }
  const taskId = artifactTaskId(marker)
  const terminalTask = taskId !== undefined && isTerminalTask(db, taskId)
  if (!terminalTask && ownerLiveness !== 'dead') {
    return protectedCandidate(name, 'debug', path, ownership, 'debug ownership is not proven terminal; protected', measure, extra)
  }
  const ageDays = ageDaysFromIso(marker.finished_at, now)
  if (ageDays === undefined) {
    return protectedCandidate(name, 'debug', path, ownership, 'debug artifact has no valid finish time; protected', measure, extra)
  }
  return {
    id: name,
    category: 'debug',
    path,
    ownership,
    logicalBytes: measure.logicalBytes,
    allocatedBytes: measure.allocatedBytes,
    isDir: true,
    subtype: 'debug-dir',
    safe: true,
    safeReason: terminalTask
      ? `debug directory owned by terminal task ${taskId}`
      : 'debug directory whose owning process is gone',
    ageDays,
  }
}

function clientRunHomePaths(stateRoot: string, family: string, runId: string): { id: string; path: string; markerPath: string } {
  const path = join(stateRoot, 'clients', family, 'runs', runId)
  return { id: `${family}/runs/${runId}`, path, markerPath: join(path, RUN_MARKER_FILE) }
}

/**
 * An owned per-run client home under `clients/<family>/runs/<id>`. Only a home
 * whose marker exactly matches its own family and run id can be reclaimed: a
 * terminal home is reclaimed as soon as its recorded child processes are gone,
 * and an active home only when its recorded owner, child and process group are
 * all proven absent.
 */
async function assessClientRunHome(
  stateRoot: string,
  family: string,
  runId: string,
  now: Date,
): Promise<RawCandidate> {
  const { id, path, markerPath } = clientRunHomePaths(stateRoot, family, runId)
  const ownership = `clients/${family}/runs/${runId}`
  const extra = { isDir: true, subtype: 'run-home' as const }
  const inspected = await inspectAndMeasure(stateRoot, path)
  const measure = inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 }
  if (inspected.reason !== undefined) {
    return protectedCandidate(id, 'clients', path, ownership, `${inspected.reason}; protected`, measure, extra)
  }
  if (inspected.stats === undefined || !inspected.stats.isDirectory()) {
    return protectedCandidate(id, 'clients', path, ownership, 'run home is not a directory; protected', measure, extra)
  }
  const markerRead = await readMarker(stateRoot, markerPath)
  if (markerRead.status !== 'ok') {
    return protectedCandidate(
      id,
      'clients',
      path,
      ownership,
      markerRead.status === 'absent'
        ? 'run home has no ownership marker; protected'
        : 'run home marker is unreadable or not a regular file; protected',
      measure,
      extra,
    )
  }
  const marker = parseRunMarker(markerRead.value)
  if (marker === undefined) {
    return protectedCandidate(id, 'clients', path, ownership, 'run home marker is incomplete or invalid; protected', measure, extra)
  }
  if (marker.client_family !== family || marker.run_id !== runId) {
    return protectedCandidate(id, 'clients', path, ownership, 'run home marker identity does not match its path; protected', measure, extra)
  }
  const block = runHomeBlockReason(marker)
  if (block !== undefined) {
    return protectedCandidate(id, 'clients', path, ownership, block, measure, extra)
  }
  const ageBasis = marker.state === 'active' ? marker.created_at : marker.finished_at
  const ageDays = ageDaysFromIso(ageBasis, now)
  if (ageDays === undefined) {
    return protectedCandidate(id, 'clients', path, ownership, 'run home has no valid age evidence; protected', measure, extra)
  }
  const state = marker.state === 'active' ? 'active' : `terminal ${marker.state}`
  return {
    id,
    category: 'clients',
    path,
    ownership,
    logicalBytes: measure.logicalBytes,
    allocatedBytes: measure.allocatedBytes,
    isDir: true,
    subtype: 'run-home',
    safe: true,
    safeReason: `${state} owned run home (${marker.client_family} run ${marker.run_id}) with no live process`,
    ageDays,
  }
}

/** Any other entry directly under `clients/` is out of scope and protected. */
async function assessClientEntry(stateRoot: string, name: string): Promise<RawCandidate> {
  const path = join(stateRoot, 'clients', name)
  const inspected = await inspectAndMeasure(stateRoot, path)
  return protectedCandidate(
    name,
    'clients',
    path,
    `clients/${name}`,
    inspected.reason === undefined
      ? 'client entry is not a managed owned run home; protected'
      : `${inspected.reason}; protected`,
    inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 },
    { isDir: inspected.stats?.isDirectory() ?? false },
  )
}

function parseBotOwner(owner: string | undefined): { botId: string; itemId: string } | undefined {
  if (owner === undefined || !owner.startsWith('bot:')) return undefined
  const rest = owner.slice('bot:'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  return { botId: rest.slice(0, slash), itemId: rest.slice(slash + 1) }
}

interface WorktreeMetadata {
  id?: unknown
  project?: unknown
  path?: unknown
  owner?: unknown
}

async function readWorktreeMetadata(metadataPath: string): Promise<WorktreeMetadata | undefined> {
  try {
    const text = await readFile(metadataPath, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as WorktreeMetadata
  } catch {
    return undefined
  }
}

function normalizeMetadataPath(configuredRoot: string, stateRoot: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !isAbsolute(value)) return undefined
  const absolute = resolve(value)
  for (const root of [resolve(configuredRoot), stateRoot]) {
    const rel = relative(root, absolute)
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return join(stateRoot, rel)
    }
  }
  return undefined
}

function registeredWorktree(
  pm: ProjectManager | undefined,
  project: string,
  id: string,
  path: string,
  configuredRoot: string,
  stateRoot: string,
): WorktreeInfo | undefined {
  if (pm === undefined) return undefined
  try {
    return pm.listWorktrees(project).find(
      (worktree) => worktree.id === id && normalizeMetadataPath(configuredRoot, stateRoot, worktree.path) === path,
    )
  } catch {
    return undefined
  }
}

async function assessWorktree(
  stateRoot: string,
  configuredRoot: string,
  db: ForemanDatabase | undefined,
  pm: ProjectManager | undefined,
  metadataFileName: string,
  now: Date,
): Promise<RawCandidate | undefined> {
  const id = metadataFileName.slice(0, -'.json'.length)
  const metadataPath = join(stateRoot, 'worktrees', '.foreman', metadataFileName)
  const expectedPath = join(stateRoot, 'worktrees', id)
  const ownership = `worktrees/${id}`
  const metadataInspection = await inspectPath(stateRoot, metadataPath)
  if (
    metadataInspection.missing ||
    metadataInspection.error !== undefined ||
    metadataInspection.stats === undefined ||
    !metadataInspection.stats.isFile()
  ) {
    return protectedCandidate(id, 'worktrees', expectedPath, ownership, 'worktree metadata is not a regular file under validated ancestry; protected', { logicalBytes: 0, allocatedBytes: 0 }, { metadataPath })
  }
  const metadata = await readWorktreeMetadata(metadataPath)

  if (metadata === undefined || metadata.id !== id) {
    return protectedCandidate(id, 'worktrees', expectedPath, ownership, 'worktree metadata is unreadable or mismatched; protected', { logicalBytes: 0, allocatedBytes: 0 }, { metadataPath })
  }
  if (!WORKTREE_ID_RE.test(id)) {
    return protectedCandidate(id, 'worktrees', expectedPath, ownership, 'invalid managed worktree id; protected', { logicalBytes: 0, allocatedBytes: 0 }, { metadataPath })
  }
  const normalizedMetadataPath = normalizeMetadataPath(configuredRoot, stateRoot, metadata.path)
  if (normalizedMetadataPath !== expectedPath) {
    return protectedCandidate(id, 'worktrees', expectedPath, ownership, 'metadata path is not the managed worktree root; protected', { logicalBytes: 0, allocatedBytes: 0 }, { metadataPath })
  }
  const owner = parseBotOwner(typeof metadata.owner === 'string' ? metadata.owner : undefined)
  if (owner === undefined) {
    return protectedCandidate(id, 'worktrees', expectedPath, ownership, 'worktree has no managed bot owner; protected', { logicalBytes: 0, allocatedBytes: 0 }, { metadataPath })
  }

  const inspected = await inspectAndMeasure(stateRoot, expectedPath)
  if (inspected.reason === 'path is missing') {
    return protectedCandidate(id, 'worktrees', expectedPath, ownership, 'directory missing/metadata retained', { logicalBytes: 0, allocatedBytes: 0 }, { metadataPath })
  }
  if (inspected.reason !== undefined) {
    return protectedCandidate(id, 'worktrees', expectedPath, ownership, `${inspected.reason}; protected`, inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 }, { metadataPath })
  }
  if (inspected.stats === undefined || !inspected.stats.isDirectory()) {
    return protectedCandidate(id, 'worktrees', expectedPath, ownership, 'worktree path is not a directory; protected', inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 }, { metadataPath })
  }
  const measure = inspected.measure as Measure
  const protectedAt = (safeReason: string): RawCandidate =>
    protectedCandidate(id, 'worktrees', expectedPath, ownership, safeReason, measure, { isDir: true, metadataPath })

  if (typeof metadata.project !== 'string' || metadata.project.trim() === '') {
    return protectedAt('worktree metadata has no project; protected')
  }
  const project = metadata.project
  if (pm === undefined) {
    return protectedAt('project manager is unavailable, so delivery cannot be proven; protected')
  }
  const info = registeredWorktree(pm, project, id, expectedPath, configuredRoot, stateRoot)
  if (info === undefined) {
    return protectedAt('worktree is not a registered managed worktree; protected')
  }
  const referenceReason = activeReferenceReason(db, id, expectedPath)
  if (referenceReason !== undefined) {
    return protectedAt(referenceReason)
  }
  if (!info.clean) {
    return protectedAt('worktree has uncommitted or untracked changes; protected')
  }
  if (!pm.worktreeIsMergedIntoTarget(project, id)) {
    return protectedAt('worktree HEAD is not merged into the project default branch; protected')
  }
  const item = readBotItem(db, owner.botId, owner.itemId)
  if (item === undefined) {
    return protectedAt('owning bot item could not be read; protected')
  }
  if (item.worktree_id !== id) {
    return protectedAt('owning bot item does not reference this worktree; protected')
  }
  if (item.state !== 'completed') {
    return protectedAt(`owning bot item state '${item.state}' is not completed; protected`)
  }
  const ageDays = ageDaysFromIso(item.updated_at, now)
  if (ageDays === undefined) {
    return protectedAt('owning bot item has no valid completion time; protected')
  }
  return {
    id,
    category: 'worktrees',
    path: expectedPath,
    ownership,
    logicalBytes: measure.logicalBytes,
    allocatedBytes: measure.allocatedBytes,
    isDir: true,
    safe: true,
    safeReason: `merged, clean worktree owned by completed bot item ${owner.botId}/${owner.itemId}`,
    ageDays,
    metadataPath,
    project,
  }
}

async function assessUnrecognized(
  category: 'artifacts' | 'logs' | 'clients',
  stateRoot: string,
  id: string,
): Promise<RawCandidate> {
  const path = join(stateRoot, category, id)
  const inspected = await inspectAndMeasure(stateRoot, path)
  return protectedCandidate(
    id,
    category,
    path,
    `${category}/${id}`,
    inspected.reason === undefined ? 'unrecognized entry; protected' : `${inspected.reason}; protected`,
    inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 },
    { isDir: inspected.stats?.isDirectory() ?? false },
  )
}

/**
 * Inventory-only candidate for a managed directory that cannot be listed
 * because its own path, or an ancestor inside the state tree, is a symlink. The
 * entry stays visible with the inspection reason and is never descended into,
 * so a symlinked ancestor protects everything beneath it instead of aborting
 * the run.
 */
async function assessSymlinkedPath(
  stateRoot: string,
  category: StorageCleanupCategoryId,
  path: string,
  reason: string,
): Promise<RawCandidate> {
  const id = relative(stateRoot, path)
  const inspected = await inspectAndMeasure(stateRoot, path)
  return protectedCandidate(
    id,
    category,
    path,
    id,
    `${reason}; protected`,
    inspected.measure ?? { logicalBytes: 0, allocatedBytes: 0 },
    { isDir: inspected.stats?.isDirectory() ?? false },
  )
}

// ─── Enumeration ────────────────────────────────────────────────────

async function collectRawCandidates(
  stateRoot: string,
  configuredRoot: string,
  db: ForemanDatabase | undefined,
  pm: ProjectManager | undefined,
  now: Date,
  selected: ReadonlySet<StorageCleanupCategoryId>,
  retentionDays: number,
): Promise<RawCandidate[]> {
  const raw: RawCandidate[] = []

  if (selected.has('database')) {
    raw.push(await assessDatabase(stateRoot, db, retentionDays, now))
  }

  if (selected.has('artifacts')) {
    const artifactsDirectory = join(stateRoot, 'artifacts')
    const artifactListing = await listDirectory(stateRoot, artifactsDirectory)
    if (artifactListing.symlinkReason !== undefined) {
      raw.push(await assessSymlinkedPath(stateRoot, 'artifacts', artifactsDirectory, artifactListing.symlinkReason))
    } else {
      for (const name of artifactListing.names) {
        if (name.startsWith('.')) continue
        raw.push(await assessArtifact(stateRoot, db, name, now))
      }
    }
  }

  if (selected.has('logs')) {
    const logsDirectory = join(stateRoot, 'logs')
    const logListing = await listDirectory(stateRoot, logsDirectory)
    if (logListing.symlinkReason !== undefined) {
      raw.push(await assessSymlinkedPath(stateRoot, 'logs', logsDirectory, logListing.symlinkReason))
    } else {
      for (const name of logListing.names) {
        if (name.startsWith('.')) continue
        if (name === CLOSED_LOG_DIRECTORY) {
          const closedDirectory = join(stateRoot, 'logs', CLOSED_LOG_DIRECTORY)
          const closedListing = await listDirectory(stateRoot, closedDirectory)
          if (closedListing.symlinkReason !== undefined) {
            raw.push(await assessSymlinkedPath(stateRoot, 'logs', closedDirectory, closedListing.symlinkReason))
            continue
          }
          for (const closedId of closedListing.names) {
            if (closedId.startsWith('.')) continue
            raw.push(await assessClosedLog(stateRoot, closedId, now))
          }
          continue
        }
        const candidate = await assessLog(stateRoot, name, now)
        if (candidate !== undefined) raw.push(candidate)
        else raw.push(await assessUnrecognized('logs', stateRoot, name))
      }
    }
  }

  if (selected.has('clients')) {
    for (const family of RUN_HOME_FAMILIES) {
      const runsDirectory = join(stateRoot, 'clients', family, 'runs')
      const runListing = await listDirectory(stateRoot, runsDirectory)
      if (runListing.symlinkReason !== undefined) {
        raw.push(await assessSymlinkedPath(stateRoot, 'clients', runsDirectory, runListing.symlinkReason))
        continue
      }
      for (const runId of runListing.names) {
        if (runId.startsWith('.')) continue
        raw.push(await assessClientRunHome(stateRoot, family, runId, now))
      }
    }
    const clientsDirectory = join(stateRoot, 'clients')
    const clientListing = await listDirectory(stateRoot, clientsDirectory)
    if (clientListing.symlinkReason !== undefined) {
      raw.push(await assessSymlinkedPath(stateRoot, 'clients', clientsDirectory, clientListing.symlinkReason))
    } else {
      for (const name of clientListing.names) {
        if (name.startsWith('.') || (RUN_HOME_FAMILIES as readonly string[]).includes(name)) continue
        raw.push(await assessClientEntry(stateRoot, name))
      }
    }
  }

  if (selected.has('debug')) {
    let rootNames: string[] = []
    try {
      rootNames = await readdir(stateRoot)
    } catch {
      rootNames = []
    }
    for (const name of rootNames) {
      if (!name.startsWith(DEBUG_DIRECTORY_PREFIX)) continue
      raw.push(await assessDebug(stateRoot, db, name, now))
    }
  }

  if (selected.has('worktrees')) {
    const metadataDirectory = join(stateRoot, 'worktrees', '.foreman')
    const metadataListing = await listDirectory(stateRoot, metadataDirectory)
    if (metadataListing.symlinkReason !== undefined) {
      raw.push(await assessSymlinkedPath(stateRoot, 'worktrees', metadataDirectory, metadataListing.symlinkReason))
    } else {
      for (const name of metadataListing.names) {
        if (!name.endsWith('.json')) continue
        const candidate = await assessWorktree(stateRoot, configuredRoot, db, pm, name, now)
        if (candidate !== undefined) raw.push(candidate)
      }
    }
  }

  return raw
}

// ─── Finalize (thresholds + summaries) ──────────────────────────────

interface Finalized {
  candidates: FinalCandidate[]
  categories: StorageCleanupCategorySummary[]
  candidatesById: Map<string, FinalCandidate>
}

function finalize(raw: RawCandidate[], policy: StorageCleanupPolicy, dbRetentionDays?: number): Finalized {
  const totals = new Map<StorageCleanupCategoryId, number>()
  for (const candidate of raw) {
    totals.set(candidate.category, (totals.get(candidate.category) ?? 0) + candidate.logicalBytes)
  }

  const candidates: FinalCandidate[] = raw.map((candidate) => ({
    ...candidate,
    eligible: false,
    reason: candidate.safeReason,
  }))
  const overCapacityById = new Map<StorageCleanupCategoryId, boolean>()

  for (const categoryPolicy of policy.categories) {
    const categoryCandidates = candidates.filter((candidate) => candidate.category === categoryPolicy.id)
    const totalBytes = totals.get(categoryPolicy.id) ?? 0
    overCapacityById.set(categoryPolicy.id, totalBytes > categoryPolicy.targetBytes)
    if (!categoryPolicy.removes) continue

    // The database category compares its candidate age against the resolved
    // (possibly overridden) retention window so preview and run agree.
    const effectiveRetention = categoryPolicy.id === 'database' && dbRetentionDays !== undefined
      ? dbRetentionDays
      : categoryPolicy.retentionDays
    const safeCandidates = categoryCandidates.filter((candidate) => candidate.safe && candidate.ageDays !== undefined)
    const retentionCandidates = safeCandidates.filter((candidate) => candidate.ageDays! >= effectiveRetention)
    let remainingBytes = totalBytes

    for (const candidate of retentionCandidates) {
      candidate.eligible = true
      candidate.selectedThreshold = effectiveRetention
      candidate.reason = `${candidate.safeReason}; ${describeAge(candidate.ageDays)} meets the retention threshold of ${effectiveRetention}d`
      remainingBytes -= candidate.logicalBytes
    }

    // The database category never fills down under capacity pressure: rows
    // inside the retention window are never removed just because the DB file
    // is large.
    if (categoryPolicy.id !== 'database' && remainingBytes > categoryPolicy.targetBytes) {
      const capacityCandidates = safeCandidates
        .filter((candidate) => !candidate.eligible && candidate.ageDays! >= categoryPolicy.minimumRetentionDays)
        .sort((a, b) => (b.ageDays! - a.ageDays!) || a.id.localeCompare(b.id))
      for (const candidate of capacityCandidates) {
        if (remainingBytes <= categoryPolicy.targetBytes) break
        candidate.eligible = true
        candidate.selectedThreshold = categoryPolicy.minimumRetentionDays
        candidate.reason = `${candidate.safeReason}; ${describeAge(candidate.ageDays)} meets the over-capacity minimum of ${categoryPolicy.minimumRetentionDays}d`
        remainingBytes -= candidate.logicalBytes
      }
    }

    for (const candidate of categoryCandidates) {
      if (candidate.eligible || !candidate.safe) continue
      if (candidate.ageDays === undefined) {
        candidate.reason = 'no age evidence; protected'
      } else if (candidate.ageDays < categoryPolicy.minimumRetentionDays) {
        candidate.reason = `${candidate.safeReason}; ${describeAge(candidate.ageDays)} is below the minimum diagnostic retention of ${categoryPolicy.minimumRetentionDays}d; protected`
      } else {
        candidate.reason = `${candidate.safeReason}; ${describeAge(candidate.ageDays)} was not selected for capacity; protected`
      }
    }
  }

  const categories: StorageCleanupCategorySummary[] = []
  for (const categoryPolicy of policy.categories) {
    const list = candidates.filter((candidate) => candidate.category === categoryPolicy.id)
    let totalBytes = 0
    let eligibleBytes = 0
    let protectedBytes = 0
    let eligibleCount = 0
    let protectedCount = 0
    for (const candidate of list) {
      totalBytes += candidate.logicalBytes
      if (candidate.eligible) {
        eligibleBytes += candidate.logicalBytes
        eligibleCount += 1
      } else {
        protectedBytes += candidate.logicalBytes
        protectedCount += 1
      }
    }
    categories.push({
      id: categoryPolicy.id,
      totalBytes,
      eligibleBytes,
      protectedBytes,
      candidateCount: list.length,
      eligibleCount,
      protectedCount,
      targetBytes: categoryPolicy.targetBytes,
      overCapacity: overCapacityById.get(categoryPolicy.id) ?? false,
    })
  }

  const candidatesById = new Map<string, FinalCandidate>()
  for (const candidate of candidates) {
    candidatesById.set(`${candidate.category}:${candidate.id}`, candidate)
  }

  return { candidates, categories, candidatesById }
}

function toEvidence(candidate: FinalCandidate): StorageCleanupPathEvidence {
  return {
    id: candidate.id,
    category: candidate.category,
    path: candidate.path,
    ownership: candidate.ownership,
    logicalBytes: candidate.logicalBytes,
    allocatedBytes: candidate.allocatedBytes,
    eligible: candidate.eligible,
    reason: candidate.reason,
  }
}

// ─── Public API ─────────────────────────────────────────────────────

function resolveConfiguredStateRoot(options: ManagedCleanupOptions): string {
  return resolve(options.stateRoot ?? resolveWrenyardStateRoot())
}

async function canonicalizeStateRoot(configuredRoot: string): Promise<string> {
  const stateRoot = await realpath(configuredRoot)
  const stats = await lstat(stateRoot)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('configured state root is not a directory')
  }
  return stateRoot
}

function resolveProjectManager(options: ManagedCleanupOptions, stateRoot: string): ProjectManager | undefined {
  if (options.projectManager !== undefined) return options.projectManager
  const workspaceRoot = options.workspaceRoot ?? foremanWorkspaceFromEnv()
  if (workspaceRoot === null || workspaceRoot === undefined) return undefined
  try {
    return new ProjectManager({ workspaceRoot, stateRoot })
  } catch {
    return undefined
  }
}

/** Categories selected by the caller, always a subset of the recognized ids. */
function selectedCategories(options: ManagedCleanupOptions): Set<StorageCleanupCategoryId> {
  const recognized = new Set<StorageCleanupCategoryId>(MANAGED_CLEANUP_POLICY.categories.map((category) => category.id))
  const requested = options.categories
  if (requested === undefined || requested.length === 0) return recognized
  return new Set(requested.filter((id): id is StorageCleanupCategoryId => recognized.has(id)))
}

/** The reported policy, restricted to the selected categories. */
function filteredPolicy(selected: ReadonlySet<StorageCleanupCategoryId>): StorageCleanupPolicy {
  return { categories: MANAGED_CLEANUP_POLICY.categories.filter((category) => selected.has(category.id)) }
}

/**
 * Read-only inventory of managed artifacts, logs, client state and worktrees.
 * Always scans fresh; never mutates the filesystem or the database.
 */
export async function previewManagedCleanup(options: ManagedCleanupOptions = {}): Promise<CleanupPreviewResult> {
  const now = options.now ?? new Date()
  const db = tryGetDb(options.db)
  const configuredRoot = resolveConfiguredStateRoot(options)
  const stateRoot = await canonicalizeStateRoot(configuredRoot)
  const pm = resolveProjectManager(options, stateRoot)
  const selected = selectedCategories(options)
  const policy = filteredPolicy(selected)
  const retentionDays = resolveRetentionDays(options)
  const raw = await collectRawCandidates(stateRoot, configuredRoot, db, pm, now, selected, retentionDays)
  const finalized = finalize(raw, policy, retentionDays)

  let totalLogicalBytes = 0
  let totalAllocatedBytes = 0
  for (const candidate of finalized.candidates) {
    totalLogicalBytes += candidate.logicalBytes
    totalAllocatedBytes += candidate.allocatedBytes
  }

  return {
    generatedAt: now.toISOString(),
    stateRoot,
    policy,
    candidates: finalized.candidates.map(toEvidence),
    categories: finalized.categories,
    totalLogicalBytes,
    totalAllocatedBytes,
  }
}

/**
 * Cooperative shutdown state for managed cleanup.
 *
 * `cleanupStopping` is the admission cutoff: once daemon close begins, no new
 * run is admitted. `cleanupStopRequested` is the cooperative stop token an
 * in-flight run checks at every DB batch and vacuum yield boundary, so a
 * serialized run interrupts instead of running to completion. The hard fence
 * lives in the connection module and is armed only when the bounded drain
 * deadline expires; from then on no suspended cleanup path may issue another
 * statement, including audit finalization.
 */
let cleanupStopping = false
let cleanupStopRequested = false

/** True while a suspended cleanup path may still issue DB statements. */
function cleanupDbUsable(): boolean {
  try {
    assertCleanupDbUsable('continuation')
    return true
  } catch {
    return false
  }
}

function delayWithUnref(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    timer.unref?.()
  })
}

let activeRun: Promise<CleanupRunResult> | undefined

/**
 * Execute an eligible-only cleanup. Runs are serialized inside the process so
 * two concurrent requests cannot race the same paths. Every removal is
 * preceded by a fresh per-path revalidation; a candidate that is no longer
 * provably safe is protected rather than removed.
 */
export function runManagedCleanup(options: ManagedCleanupOptions = {}): Promise<CleanupRunResult> {
  // Admission cutoff: a close in progress must never queue new cleanup work.
  if (cleanupStopping) {
    return Promise.reject(new Error('cleanup is stopping; no new cleanup run is admitted'))
  }
  const previous = activeRun
  const next = (async (): Promise<CleanupRunResult> => {
    if (previous !== undefined) {
      await previous.catch(() => undefined)
    }
    return runManagedCleanupInner(options)
  })()
  activeRun = next
  return next.finally(() => {
    if (activeRun === next) activeRun = undefined
  })
}

/**
 * Begin cleanup shutdown: refuse admission of any new run and ask the in-flight
 * serialized run to interrupt itself at its next DB batch or vacuum yield
 * boundary. Idempotent, and safe to call when nothing is running.
 */
export function stopManagedCleanup(): void {
  cleanupStopping = true
  cleanupStopRequested = true
}

/**
 * Bounded drain of the serialized cleanup chain, awaited by daemon close before
 * the database is released. Returns true when the chain drained and false when
 * the deadline expired first.
 *
 * The timer only bounds the wait; cancellation is cooperative, driven by the
 * stop token checked at every DB batch and vacuum yield boundary, so this is
 * not a race-only pseudo-cancellation. When the deadline wins, the fence is
 * armed so a suspended run can never resume SQL against a released or closed
 * database.
 */
export async function drainManagedCleanup(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    const pending = activeRun
    if (pending === undefined) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await Promise.race([pending.catch(() => undefined), delayWithUnref(remaining)])
    // The slot advances when a run settles, or holds a newly chained run.
    if (activeRun === pending && Date.now() >= deadline) break
  }
  setSuspendedCleanupFence(true)
  return false
}

/**
 * Clear cleanup shutdown state so a daemon started later in the same process can
 * schedule and admit cleanup again. Close leaves cleanup stopping until this
 * runs.
 */
export function resetManagedCleanupShutdown(): void {
  cleanupStopping = false
  cleanupStopRequested = false
  setSuspendedCleanupFence(false)
}

interface CleanupAuditOutcome {
  path: string
  category: StorageCleanupCategoryId
  status: string
  reason: string
  logicalBytes: number
  allocatedBytes: number
  startedAt: string
  finishedAt: string | null
}

interface CleanupAuditPayload {
  id?: number
  trigger: string
  startedAt: string
  finishedAt: string | null
  removedLogicalBytes: number
  removedAllocatedBytes: number
  outcomes: CleanupAuditOutcome[]
}

async function runManagedCleanupInner(options: ManagedCleanupOptions): Promise<CleanupRunResult> {
  // A run already queued behind another one is interrupted before it touches
  // the database rather than starting work during shutdown.
  if (cleanupStopRequested) throw new Error('cleanup was interrupted by shutdown before any removal')
  const now = options.now ?? new Date()
  const db = tryGetDb(options.db)
  if (db === undefined) throw new Error('cleanup audit database is unavailable; no paths were removed')
  const configuredRoot = resolveConfiguredStateRoot(options)
  const stateRoot = await canonicalizeStateRoot(configuredRoot)
  const pm = resolveProjectManager(options, stateRoot)
  const selected = selectedCategories(options)
  const policy = filteredPolicy(selected)
  const trigger = options.trigger ?? 'rpc'
  const startedAt = now.toISOString()

  const retentionDays = resolveRetentionDays(options)
  const raw = await collectRawCandidates(stateRoot, configuredRoot, db, pm, now, selected, retentionDays)
  const finalized = finalize(raw, policy, retentionDays)
  const auditPayload: CleanupAuditPayload = {
    trigger,
    startedAt,
    finishedAt: null,
    removedLogicalBytes: 0,
    removedAllocatedBytes: 0,
    outcomes: finalized.candidates.map((candidate) => ({
      path: candidate.path,
      category: candidate.category,
      status: candidate.eligible ? 'pending' : 'protected',
      reason: candidate.eligible ? 'removal planned; awaiting revalidation' : candidate.reason,
      logicalBytes: candidate.logicalBytes,
      allocatedBytes: candidate.allocatedBytes,
      startedAt,
      finishedAt: null,
    })),
  }
  const record = insertRunRecord(db, startedAt, trigger, auditPayload)
  auditPayload.id = record.id

  const outcomes: StorageCleanupOutcome[] = []
  let removedLogicalBytes = 0
  let removedAllocatedBytes = 0
  let currentFinishedAt = startedAt

  for (let index = 0; index < finalized.candidates.length; index += 1) {
    // Cooperative interruption between candidates: shutdown stops the run
    // instead of letting it continue through the remaining removals.
    if (cleanupStopRequested) break
    const candidate = finalized.candidates[index] as FinalCandidate
    const auditOutcome = auditPayload.outcomes[index] as CleanupAuditOutcome
    let outcome: StorageCleanupOutcome

    if (candidate.eligible) {
      auditOutcome.status = 'pending'
      auditOutcome.reason = 'removal intent recorded; awaiting immediate revalidation'
      auditOutcome.startedAt = new Date().toISOString()
      auditOutcome.finishedAt = null
      const removal = await removeEligible(stateRoot, configuredRoot, db, pm, candidate, now)
      outcome = removal.outcome
    } else {
      outcome = {
        id: candidate.id,
        category: candidate.category,
        path: candidate.path,
        status: 'protected',
        reason: candidate.reason,
        logicalBytes: 0,
        allocatedBytes: 0,
      }
    }

    outcomes.push(outcome)
    if (outcome.status === 'removed') {
      removedLogicalBytes += outcome.logicalBytes
      removedAllocatedBytes += outcome.allocatedBytes
    }
    currentFinishedAt = new Date().toISOString()
    auditOutcome.path = outcome.path
    auditOutcome.status = outcome.status
    auditOutcome.reason = outcome.reason
    auditOutcome.logicalBytes = outcome.logicalBytes
    auditOutcome.allocatedBytes = outcome.allocatedBytes
    auditOutcome.finishedAt = currentFinishedAt
    auditPayload.removedLogicalBytes = removedLogicalBytes
    auditPayload.removedAllocatedBytes = removedAllocatedBytes
  }

  currentFinishedAt = new Date().toISOString()
  auditPayload.finishedAt = currentFinishedAt
  // A run interrupted by shutdown records every planned-but-unreached removal
  // with the existing compatible vocabulary: 'skipped' is a valid outcome
  // status, and the reason states that the run was interrupted and is partial.
  if (cleanupStopRequested) {
    for (const pending of auditPayload.outcomes) {
      if (pending.status !== 'pending') continue
      pending.status = 'skipped'
      pending.reason = 'cleanup interrupted by daemon shutdown; run finalized as partial'
      pending.finishedAt = currentFinishedAt
    }
  }
  // The database is still live for a cooperative interrupt, so the audit is
  // finalized here. Once the drain deadline has armed the fence, no statement
  // is issued at all.
  if (cleanupDbUsable()) updateRunRecord(db, record.id, auditPayload, currentFinishedAt)
  const finishedRecord = { ...record, finishedAt: currentFinishedAt }

  return {
    runId: `${startedAt}#${trigger}`,
    generatedAt: currentFinishedAt,
    stateRoot,
    trigger,
    policy: policy,
    outcomes,
    categories: finalized.categories,
    removedLogicalBytes,
    removedAllocatedBytes,
    record: finishedRecord,
  }
}

interface RemovalResult {
  outcome: StorageCleanupOutcome
}

async function removeEligible(
  stateRoot: string,
  configuredRoot: string,
  db: ForemanDatabase | undefined,
  pm: ProjectManager | undefined,
  candidate: FinalCandidate,
  now: Date,
): Promise<RemovalResult> {
  const base = { id: candidate.id, category: candidate.category, path: candidate.path }
  const failed = (reason: string): RemovalResult => ({
    outcome: { ...base, status: 'failed', reason, logicalBytes: 0, allocatedBytes: 0 },
  })
  const protectedOutcome = (reason: string): RemovalResult => ({
    outcome: { ...base, status: 'protected', reason, logicalBytes: 0, allocatedBytes: 0 },
  })

  try {
    switch (candidate.category) {
      case 'artifacts': {
        if (!(await isConfined(stateRoot, candidate.path))) return protectedOutcome('path is no longer confined; protected')
        const refreshed = await assessArtifact(stateRoot, db, candidate.id, now)
        if (!refreshed.safe || candidate.selectedThreshold === undefined || refreshed.ageDays === undefined || refreshed.ageDays < candidate.selectedThreshold) {
          return protectedOutcome(`revalidation failed: ${refreshed.safeReason}`)
        }
        if (!isSafePathSynchronously(stateRoot, candidate.path, 'directory')) {
          return protectedOutcome('artifact path failed immediate pre-removal validation; protected')
        }
        rmSync(candidate.path, { recursive: true })
        return removedOutcome(base, { logicalBytes: refreshed.logicalBytes, allocatedBytes: refreshed.allocatedBytes }, 'removed terminal-task artifacts')
      }
      case 'logs': {
        if (candidate.subtype !== 'closed-log') {
          return protectedOutcome('log entry is not a proven closed log directory; protected')
        }
        const prefix = `${CLOSED_LOG_DIRECTORY}/`
        const closedId = candidate.id.startsWith(prefix) ? candidate.id.slice(prefix.length) : ''
        if (closedId === '') return protectedOutcome('closed log identity is invalid; protected')
        if (!(await isConfined(stateRoot, candidate.path))) return protectedOutcome('path is no longer confined; protected')
        const refreshed = await assessClosedLog(stateRoot, closedId, now)
        if (!refreshed.safe || candidate.selectedThreshold === undefined || refreshed.ageDays === undefined || refreshed.ageDays < candidate.selectedThreshold) {
          return protectedOutcome(`revalidation failed: ${refreshed.safeReason}`)
        }
        const block = syncClosedLogBlock(stateRoot, closedId)
        if (block !== undefined) return protectedOutcome(block)
        rmSync(candidate.path, { recursive: true })
        return removedOutcome(
          base,
          { logicalBytes: refreshed.logicalBytes, allocatedBytes: refreshed.allocatedBytes },
          'removed closed log directory with proven writer closure',
        )
      }
      case 'worktrees': {
        if (candidate.metadataPath === undefined || pm === undefined) {
          return protectedOutcome('revalidation failed: missing worktree metadata or project manager')
        }
        const metadataFileName = `${candidate.id}.json`
        const refreshed = await assessWorktree(stateRoot, configuredRoot, db, pm, metadataFileName, now)
        if (refreshed === undefined || !refreshed.safe || candidate.selectedThreshold === undefined || refreshed.ageDays === undefined || refreshed.ageDays < candidate.selectedThreshold) {
          return protectedOutcome(`revalidation failed: ${refreshed?.safeReason ?? 'worktree is no longer eligible'}`)
        }
        if (refreshed.metadataPath !== candidate.metadataPath || refreshed.project === undefined) {
          return protectedOutcome('worktree identity changed during revalidation; protected')
        }
        const worktree = registeredWorktree(pm, refreshed.project, candidate.id, candidate.path, configuredRoot, stateRoot)
        if (worktree === undefined || !worktree.clean) {
          return protectedOutcome('worktree is no longer clean and registered; protected')
        }
        const owner = parseBotOwner(worktree.owner)
        if (owner === undefined) return protectedOutcome('worktree no longer has a managed bot owner; protected')
        const item = readBotItem(db, owner.botId, owner.itemId)
        if (item === undefined || item.worktree_id !== candidate.id || item.state !== 'completed') {
          return protectedOutcome('completed bot ownership no longer matches this worktree; protected')
        }
        const ageDays = ageDaysFromIso(item.updated_at, now)
        if (ageDays === undefined || ageDays < candidate.selectedThreshold) {
          return protectedOutcome('completed bot item is within the retention period; protected')
        }
        if (!pm.worktreeIsMergedIntoTarget(refreshed.project, candidate.id)) {
          return protectedOutcome('worktree HEAD is no longer merged into the project default branch; protected')
        }
        if (
          !isSafePathSynchronously(stateRoot, candidate.path, 'directory') ||
          !isSafePathSynchronously(stateRoot, candidate.metadataPath, 'file')
        ) {
          return protectedOutcome('worktree or metadata path failed immediate pre-removal validation; protected')
        }
        const referenceReason = activeReferenceReason(db, candidate.id, candidate.path)
        if (referenceReason !== undefined) return protectedOutcome(referenceReason)
        const result = await pm.removeWorktree(candidate.id)
        if (!result.removed) {
          return failed(result.error ?? 'worktree removal failed')
        }
        return removedOutcome(
          base,
          { logicalBytes: refreshed.logicalBytes, allocatedBytes: refreshed.allocatedBytes },
          'removed merged, delivered worktree',
        )
      }
      case 'clients': {
        if (candidate.subtype !== 'run-home') {
          return protectedOutcome('client entry is not an owned run home; protected')
        }
        const parts = candidate.id.split('/')
        const family = parts[0]
        const runId = parts[2]
        if (
          parts.length !== 3 || parts[1] !== 'runs' ||
          family === undefined || runId === undefined ||
          !(RUN_HOME_FAMILIES as readonly string[]).includes(family)
        ) {
          return protectedOutcome('run home identity is invalid; protected')
        }
        if (!(await isConfined(stateRoot, candidate.path))) return protectedOutcome('path is no longer confined; protected')
        const refreshed = await assessClientRunHome(stateRoot, family, runId, now)
        if (!refreshed.safe || candidate.selectedThreshold === undefined || refreshed.ageDays === undefined || refreshed.ageDays < candidate.selectedThreshold) {
          return protectedOutcome(`revalidation failed: ${refreshed.safeReason}`)
        }
        const block = syncClientRunHomeBlock(stateRoot, family, runId)
        if (block !== undefined) return protectedOutcome(block)
        rmSync(candidate.path, { recursive: true })
        return removedOutcome(
          base,
          { logicalBytes: refreshed.logicalBytes, allocatedBytes: refreshed.allocatedBytes },
          'removed terminal owned client run home',
        )
      }
      case 'debug': {
        if (candidate.subtype !== 'debug-dir') {
          return protectedOutcome('debug entry is not an owned debug directory; protected')
        }
        if (!(await isConfined(stateRoot, candidate.path))) return protectedOutcome('path is no longer confined; protected')
        const refreshed = await assessDebug(stateRoot, db, candidate.id, now)
        if (!refreshed.safe || candidate.selectedThreshold === undefined || refreshed.ageDays === undefined || refreshed.ageDays < candidate.selectedThreshold) {
          return protectedOutcome(`revalidation failed: ${refreshed.safeReason}`)
        }
        const block = syncDebugBlock(stateRoot, db, candidate.id)
        if (block !== undefined) return protectedOutcome(block)
        rmSync(candidate.path, { recursive: true })
        return removedOutcome(
          base,
          { logicalBytes: refreshed.logicalBytes, allocatedBytes: refreshed.allocatedBytes },
          'removed owned debug directory',
        )
      }
      case 'database': {
        if (db === undefined) return protectedOutcome('database is unavailable; protected')
        const retention = candidate.selectedThreshold ?? resolveRetentionDays({})
        return removeDatabaseCandidate(db, base, retention, now)
      }
      default:
        return protectedOutcome('category does not permit removal')
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolvePromise) => setImmediate(resolvePromise))

/**
 * Bounded, resumable database retention pass. It never routes the database
 * file through rmSync/isSafePathSynchronously; instead it compacts payload
 * columns in place using id-keyset scans inside small transactions, yielding
 * to the event loop between selection and update batches and between
 * reclamation chunks.
 *
 * Events: rows older than the cutoff whose type is exactly 'message',
 * 'tool_call' or 'tool_result' get `data` rewritten to a small valid-JSON
 * retention marker; id, execution_id, task_id, seq, type, timestamp, status,
 * exit_code, is_error and created_at stay untouched so sequence allocation
 * and telemetry dedupe remain stable. No other type is touched.
 *
 * Executions: terminal rows (done/failed/cancelled/timeout/interrupted) with
 * ended_at < cutoff get output = NULL, raw_result = NULL, prompt = '' (prompt
 * is NOT NULL); every other column is left alone. Queued/starting/running
 * rows and completions inside the window are never touched.
 *
 * The pass is idempotent (already-compacted rows no longer match) and bounded:
 * every statement first selects a fixed window of raw rows by key — the
 * INTEGER `id` primary key for events, the SQLite rowid for executions — so
 * LIMIT bounds the raw rows visited rather than the rows matched, eligibility
 * is resolved only inside that window, and updates run in a small transaction
 * capped by a byte budget. The event cursor stops at the last row actually
 * compacted, so an eligible row left unprocessed by the budget is re-selected
 * instead of skipped.
 *
 * Shutdown: the cooperative stop token and the DB fence are checked before
 * every window and after every yield, and reclamation stops at its own yield
 * boundary, so an in-flight pass interrupts as partial while every committed
 * window stays transactional. Once the drain deadline has armed the fence, no
 * further statement is issued.
 */
async function removeDatabaseCandidate(
  db: ForemanDatabase,
  base: { id: string; category: StorageCleanupCategoryId; path: string },
  retentionDays: number,
  now: Date,
): Promise<RemovalResult> {
  const interrupted = (): RemovalResult => ({
    outcome: {
      ...base,
      status: 'skipped',
      reason: 'cleanup interrupted by daemon shutdown; database retention is partial',
      logicalBytes: 0,
      allocatedBytes: 0,
    },
  })
  if (cleanupStopped()) return interrupted()
  const before = readDbPageStats(db)
  const cutoffIso = new Date(now.getTime() - retentionDays * 86_400_000).toISOString()
  let compactedEvents = 0
  let slimmedExecutions = 0

  // Raw-window-first keyset scan: the inner selection carries no eligibility
  // predicate, so LIMIT bounds the raw rows visited rather than the rows
  // matched, and the cursor resumes at the last processed raw row so a crash
  // between windows loses no work and never re-touches a compacted row.
  let lastEventId = 0
  for (;;) {
    if (cleanupStopped()) break
    const window = db
      .prepare<[number, number], { id: number }>(`SELECT id FROM events WHERE id > ? ORDER BY id LIMIT ?`)
      .all(lastEventId, DB_EVENT_BATCH_ROWS)
    if (window.length === 0) break
    await yieldToEventLoop()
    if (cleanupStopped()) break
    const ids = window.map((row) => row.id)
    const rows = db
      .prepare<unknown[], { id: number; bytes: number }>(
        `SELECT id, COALESCE(LENGTH(data), 0) AS bytes FROM events
           WHERE id IN (${bindPlaceholders(ids.length)}) AND created_at < ?
             AND type IN ('message','tool_call','tool_result')
             AND data IS NOT NULL AND data != ?
           ORDER BY id`,
      )
      .all(...ids, cutoffIso, RETENTION_EVENT_MARKER)
    let batchBytes = 0
    let lastUpdatedEventId = lastEventId
    if (rows.length > 0) {
      db.transaction(() => {
        for (const row of rows) {
          if (batchBytes >= DB_BATCH_BYTE_BUDGET) break
          batchBytes += row.bytes
          db.prepare<[string, number]>(`UPDATE events SET data = ? WHERE id = ?`).run(RETENTION_EVENT_MARKER, row.id)
          compactedEvents += 1
          lastUpdatedEventId = row.id
        }
      })()
    }
    // Advance the cursor to the last row actually compacted so an eligible row
    // left unprocessed by the byte budget is re-selected on the next window;
    // when the window matched nothing, or produced no update, the cursor still
    // clears the raw window so the scan always progresses.
    lastEventId = lastUpdatedEventId > lastEventId ? lastUpdatedEventId : (ids[ids.length - 1] as number)
    await yieldToEventLoop()
  }

  // Executions: raw-window-first as well, keyed on SQLite rowid because the
  // execution id is text, with at most one raw row per window (the payload
  // columns can be very large).
  let lastExecutionRowid = 0
  for (;;) {
    if (cleanupStopped()) break
    const window = db
      .prepare<[number, number], { rowid: number }>(`SELECT rowid FROM executions WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .all(lastExecutionRowid, DB_EXECUTION_BATCH_ROWS)
    if (window.length === 0) break
    await yieldToEventLoop()
    if (cleanupStopped()) break
    const rowids = window.map((row) => row.rowid)
    const rows = db
      .prepare<unknown[], { id: string; bytes: number }>(
        `SELECT id,
                COALESCE(LENGTH(output), 0) + COALESCE(LENGTH(raw_result), 0) + COALESCE(LENGTH(prompt), 0) AS bytes
           FROM executions
           WHERE rowid IN (${bindPlaceholders(rowids.length)})
             AND status IN ('done','failed','cancelled','timeout','interrupted')
             AND ended_at IS NOT NULL AND ended_at < ?
             AND (output IS NOT NULL OR raw_result IS NOT NULL OR prompt != '')`,
      )
      .all(...rowids, cutoffIso)
    if (rows.length > 0) {
      db.transaction(() => {
        for (const row of rows) {
          db.prepare<[string]>(
            `UPDATE executions SET output = NULL, raw_result = NULL, prompt = '' WHERE id = ?`,
          ).run(row.id)
          slimmedExecutions += 1
        }
      })()
    }
    lastExecutionRowid = rowids[rowids.length - 1] as number
    await yieldToEventLoop()
  }

  // Reclaim free pages in yielded chunks; incremental_vacuum is safe under WAL
  // and a no-op when the database is not in INCREMENTAL mode.
  try {
    // Reclamation also honours the cooperative stop and the fence at its own
    // yield boundary.
    if (!cleanupStopped()) {
      await runIncrementalVacuum(db, DB_VACUUM_PAGE_CHUNK, () => cleanupStopped())
    }
  } catch {
    // Reclamation failure leaves compaction intact; report what was measured.
  }
  const after = cleanupDbUsable() ? readDbPageStats(db) : undefined
  const removedAllocatedBytes = before !== undefined && after !== undefined
    ? Math.max(0, (before.pageCount - after.pageCount) * after.pageSize)
    : 0
  const freedFreelistBytes = before !== undefined && after !== undefined
    ? Math.max(0, (after.freelistCount - before.freelistCount) * after.pageSize)
    : 0

  if (compactedEvents === 0 && slimmedExecutions === 0) {
    if (cleanupStopRequested) return interrupted()
    return {
      outcome: { ...base, status: 'protected', reason: 'no rows older than the retention window required compaction', logicalBytes: 0, allocatedBytes: 0 },
    }
  }
  const summary = `compacted ${compactedEvents} event payloads and slimmed ${slimmedExecutions} execution payloads older than ${retentionDays}d`
  return removedOutcome(
    base,
    { logicalBytes: removedAllocatedBytes + freedFreelistBytes, allocatedBytes: removedAllocatedBytes },
    cleanupStopRequested ? `${summary} (interrupted by daemon shutdown; run is partial)` : summary,
  )
}

function removedOutcome(
  base: { id: string; category: StorageCleanupCategoryId; path: string },
  measure: Measure,
  reason: string,
): RemovalResult {
  return {
    outcome: {
      ...base,
      status: 'removed',
      reason,
      logicalBytes: measure.logicalBytes,
      allocatedBytes: measure.allocatedBytes,
    },
  }
}

function insertRunRecord(
  db: ForemanDatabase,
  startedAt: string,
  trigger: string,
  payload: CleanupAuditPayload,
): StorageCleanupRunRecord {
  let id: number
  try {
    const result = db
      .prepare<[string, string, string, string]>(`INSERT INTO storage_cleanup_run (started_at, finished_at, trigger, record_json) VALUES (?, ?, ?, ?)`)
      .run(startedAt, startedAt, trigger, JSON.stringify(payload))
    id = Number(result.lastInsertRowid)
  } catch {
    throw new Error('cleanup audit insert failed; no paths were removed')
  }

  const record = { id, startedAt, finishedAt: startedAt, trigger }
  payload.id = id
  updateRunRecord(db, id, payload, startedAt)
  try {
    db.prepare(
      `DELETE FROM storage_cleanup_run WHERE id NOT IN (
         SELECT id FROM storage_cleanup_run ORDER BY id DESC LIMIT 100
       )`,
    ).run()
  } catch {
    throw new Error('cleanup audit retention update failed; no paths were removed')
  }
  return record
}

function updateRunRecord(
  db: ForemanDatabase,
  id: number,
  payload: CleanupAuditPayload,
  finishedAt: string,
): void {
  try {
    const result = db
      .prepare<[string, string, number]>(`UPDATE storage_cleanup_run SET finished_at = ?, record_json = ? WHERE id = ?`)
      .run(finishedAt, JSON.stringify(payload), id)
    if (result.changes !== 1) throw new Error('cleanup audit row was not updated')
  } catch {
    throw new Error(`cleanup audit update failed for run ${id}; no further paths will be removed`)
  }
}
