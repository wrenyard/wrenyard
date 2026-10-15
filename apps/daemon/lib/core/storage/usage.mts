import { lstat, readdir, realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { resolveWrenyardConfigRoot, resolveWrenyardStateRoot } from '@wrenyard/paths'
import type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageUsageResult,
  StorageUsageSnapshot,
  StorageUsageStatus,
} from '../../protocol/methods/storage.mts'

/**
 * Read-only Wrenyard data-directory usage scanner.
 *
 * It reports the apparent on-disk footprint of the daemon's own STATE and
 * CONFIG roots, never the wider user workspace. It is strictly read-only: it
 * only resolves, lists and stats; it never creates, writes, opens for writing,
 * truncates, chmods, utimes or removes any file, and never creates a missing
 * root.
 *
 * One scanner lives per daemon process (a module singleton), with no timers and
 * no persistence. The scan runs in the background off the request hot path so a
 * large tree never blocks the daemon from serving other requests, and the RPC
 * handler never awaits it.
 */

const CATEGORY_IDS: readonly StorageCategoryId[] = [
  'sessions',
  'records',
  'files',
  'worktrees',
  'logs',
  'clients',
  'other',
]

const MAX_UNREADABLE_SAMPLES = 5
/** Directory entries stat'd in parallel, so a huge directory yields to the loop. */
const ENTRY_BATCH_SIZE = 64

interface CategoryCounter {
  bytes: number
  fileCount: number
  unreadable: number
}

interface StorageUsageScanState {
  status: StorageUsageStatus
  startedAt?: string
  scannedAt?: string
  error?: string
  result?: StorageUsageSnapshot
}

const scanState: StorageUsageScanState = { status: 'scanning' }
let scanStarted = false
let scanInFlight = false

/**
 * Report the current snapshot and, when appropriate, kick off a background scan.
 *
 * - First call ever: start a scan and immediately answer `scanning`.
 * - While a scan runs: any call (refresh or not) answers `scanning` and starts
 *   no second scan.
 * - Idle with `refresh: true`: start a new scan, answer `scanning`, and keep
 *   carrying the previous `result`.
 */
export function readStorageUsage(refresh = false): StorageUsageResult {
  if (!scanStarted) {
    startStorageUsageScan()
  } else if (refresh && !scanInFlight) {
    startStorageUsageScan()
  }
  return currentStorageUsageResult()
}

function startStorageUsageScan(): void {
  scanStarted = true
  scanInFlight = true
  scanState.status = 'scanning'
  scanState.startedAt = new Date().toISOString()
  scanState.error = undefined
  // Never await the scan here: the handler must answer immediately and the
  // background promise owns its own success/failure bookkeeping.
  void performStorageUsageScan().then(
    (snapshot) => {
      scanState.result = snapshot
      scanState.scannedAt = new Date().toISOString()
      scanState.status = 'ready'
    },
    (error: unknown) => {
      // Keep the previous `result` untouched; only record the failure.
      scanState.error = error instanceof Error ? error.message : String(error)
      scanState.status = 'failed'
    },
  ).finally(() => {
    scanInFlight = false
  })
}

function currentStorageUsageResult(): StorageUsageResult {
  return {
    device: { hostname: hostname(), platform: process.platform },
    roots: [
      { kind: 'state', path: resolveWrenyardStateRoot() },
      { kind: 'config', path: resolveWrenyardConfigRoot() },
    ],
    status: scanState.status,
    ...(scanState.startedAt === undefined ? {} : { startedAt: scanState.startedAt }),
    ...(scanState.scannedAt === undefined ? {} : { scannedAt: scanState.scannedAt }),
    ...(scanState.error === undefined ? {} : { error: scanState.error }),
    ...(scanState.result === undefined ? {} : { result: scanState.result }),
  }
}

/**
 * Walk both roots once and return the exclusive per-category footprint. Exposed
 * so an isolated harness can scan synchronously; production callers use
 * `readStorageUsage`.
 */
export async function performStorageUsageScan(): Promise<StorageUsageSnapshot> {
  const counts = createCategoryCounters()
  const samples: string[] = []
  const seenInodes = new Set<string>()
  let unreadable = 0
  let skippedLinks = 0

  const noteUnreadable = (category: StorageCategoryId, path: string): void => {
    unreadable += 1
    counts[category].unreadable += 1
    if (samples.length < MAX_UNREADABLE_SAMPLES) samples.push(path)
  }

  const stateRoot = await resolveRootPath(resolveWrenyardStateRoot(), noteUnreadable)
  const configRoot = await resolveRootPath(resolveWrenyardConfigRoot(), noteUnreadable)

  const categoryOf = (path: string): StorageCategoryId =>
    stateRoot === undefined ? 'other' : categoryForPath(path, stateRoot)

  // Stat one entry. Returns the path only for a real directory to descend into.
  const visitEntry = async (path: string): Promise<string | undefined> => {
    try {
      const stats = await lstat(path)
      // Never follow a symlink or Windows junction (lstat reports both here), so
      // worktree `.git` files and pnpm `node_modules` links never pull a user's
      // repository (or anything outside the WY roots) into Wrenyard's footprint.
      if (stats.isSymbolicLink()) {
        skippedLinks += 1
        return undefined
      }
      if (stats.isDirectory()) return path
      if (!stats.isFile()) return undefined
      if (stats.nlink > 1) {
        // Dedupe real inodes across the whole scan, keeping Windows inode
        // precision via bigint, so a hard-linked file is counted exactly once.
        const big = await lstat(path, { bigint: true })
        const inodeKey = `${big.dev}:${big.ino}`
        if (seenInodes.has(inodeKey)) return undefined
        seenInodes.add(inodeKey)
      }
      const category = categoryOf(path)
      counts[category].bytes += stats.size
      counts[category].fileCount += 1
      return undefined
    } catch (error) {
      // A vanished entry is not an error; anything else is honestly reported.
      if (!isEnoent(error)) noteUnreadable(categoryOf(path), path)
      return undefined
    }
  }

  const traverse = async (root: string): Promise<void> => {
    // Explicit stack, no deep recursion, so a deep tree cannot overflow.
    const directories: string[] = [root]
    while (directories.length > 0) {
      const directory = directories.pop() as string
      try {
        const names = await readdir(directory)
        for (let offset = 0; offset < names.length; offset += ENTRY_BATCH_SIZE) {
          const batch = names.slice(offset, offset + ENTRY_BATCH_SIZE)
          // Stat one batch in parallel, so a huge directory yields to the event
          // loop between batches and other requests keep being served.
          const children = await Promise.all(batch.map((name) => visitEntry(join(directory, name))))
          for (const child of children) {
            if (child !== undefined) directories.push(child)
          }
        }
      } catch (error) {
        if (!isEnoent(error)) noteUnreadable(categoryOf(directory), directory)
      }
    }
  }

  for (const root of pickTraversalRoots(stateRoot, configRoot)) {
    await traverse(root)
  }

  const categories: StorageCategoryUsage[] = CATEGORY_IDS.map((id) => ({
    id,
    bytes: counts[id].bytes,
    fileCount: counts[id].fileCount,
    unreadable: counts[id].unreadable,
  }))
  let totalBytes = 0
  let fileCount = 0
  for (const category of categories) {
    totalBytes += category.bytes
    fileCount += category.fileCount
  }

  return {
    totalBytes,
    fileCount,
    categories,
    unreadable,
    unreadableSamples: samples,
    skippedLinks,
  }
}

function createCategoryCounters(): Record<StorageCategoryId, CategoryCounter> {
  return {
    sessions: { bytes: 0, fileCount: 0, unreadable: 0 },
    records: { bytes: 0, fileCount: 0, unreadable: 0 },
    files: { bytes: 0, fileCount: 0, unreadable: 0 },
    worktrees: { bytes: 0, fileCount: 0, unreadable: 0 },
    logs: { bytes: 0, fileCount: 0, unreadable: 0 },
    clients: { bytes: 0, fileCount: 0, unreadable: 0 },
    other: { bytes: 0, fileCount: 0, unreadable: 0 },
  }
}

/**
 * Classify one absolute path by its first segment relative to the STATE root.
 * Anything not under the state root (e.g. the separate config root) is `other`.
 */
function categoryForPath(path: string, stateRoot: string): StorageCategoryId {
  const rel = relative(stateRoot, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'other'
  return categorizeSegment(rel.split(sep)[0])
}

function categorizeSegment(segment: string): StorageCategoryId {
  switch (segment) {
    case 'session':
      // Per-workspace session ledger and index.
      return 'sessions'
    case 'wrenyard.db':
    case 'wrenyard.db-wal':
    case 'wrenyard.db-shm':
      // The SQLite database and its sidecars.
      return 'records'
    case 'sessions':
    case 'artifacts':
      // Session attachments and task artifacts.
      return 'files'
    case 'worktrees':
      return 'worktrees'
    case 'logs':
      return 'logs'
    case 'clients':
    case 'quota':
    case 'desktop':
      return 'clients'
    default:
      return 'other'
  }
}

/**
 * Choose the roots to traverse. When both real paths coincide, or one contains
 * the other, walk the outer one only so nothing is counted twice.
 */
function pickTraversalRoots(stateRoot: string | undefined, configRoot: string | undefined): string[] {
  if (stateRoot && configRoot) {
    if (stateRoot === configRoot) return [stateRoot]
    if (isWithin(stateRoot, configRoot)) return [stateRoot]
    if (isWithin(configRoot, stateRoot)) return [configRoot]
    return [stateRoot, configRoot]
  }
  if (stateRoot) return [stateRoot]
  if (configRoot) return [configRoot]
  return []
}

async function resolveRootPath(
  requested: string,
  noteUnreadable: (category: StorageCategoryId, path: string) => void,
): Promise<string | undefined> {
  try {
    return await realpath(requested)
  } catch (error) {
    if (!isEnoent(error)) noteUnreadable('other', requested)
    return undefined
  }
}

/** True when `candidate` is `parent` itself or lives inside it. */
function isWithin(parent: string, candidate: string): boolean {
  if (candidate === parent) return true
  const rel = relative(parent, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
