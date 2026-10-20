import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { foremanStateRoot as resolveWrenyardStateRoot } from '@wrenyard/daemon/config/state'
import { requireNoPositionals } from '../helpers.mts'
import { connectConfiguredForemanClient, errorMessage } from '../shared.mts'

const USAGE = `Usage: wrenyard clients <list | prune>
  list    [--config path] [--json]
  prune   [--dry-run | --apply] [--older-than-days N] [--config path] [--json]`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const FAMILIES = ['opencode', 'codebuddy', 'pi'] as const

// Shared, never-pruned client state homes that live beside the owned `runs` root.
const SHARED_CLIENT_DIRS: Record<typeof FAMILIES[number], readonly string[]> = {
  opencode: ['config'],
  codebuddy: ['agent-config'],
  pi: ['agent', 'sessions'],
}

interface Marker {
  version: 1
  client_family: typeof FAMILIES[number]
  run_id: string
  state: 'active' | 'done' | 'failed'
  created_at: string
  finished_at?: string
  owner_pid?: number
  launch_phase?: 'prepared' | 'spawning' | 'running'
  child_pid?: number
  child_pgid?: number
}

interface Candidate {
  path: string
  family: string
  finished_at: string
  bytes: number
  markerPath: string
}

interface ScanResult {
  candidates: Candidate[]
  skipped: Array<{ path: string; reason: string }>
}

export async function handleClients(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error(USAGE)
    return subcommand ? 0 : 1
  }
  if (subcommand === 'list') return handleClientsList(args.slice(1))
  if (subcommand === 'prune') return handleClientsPrune(args.slice(1))
  console.error(USAGE)
  return 1
}

const CLIENT_READINESS_LABELS: Record<string, string> = {
  ready: 'ready',
  not_installed: 'not installed',
  disabled: 'disabled',
  error: 'error',
}

async function handleClientsList(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        config: { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    })
    requireNoPositionals(positionals, USAGE)
    const client = await connectConfiguredForemanClient(values.config)
    try {
      const { clients } = await client.clients.list()
      if (values.json) console.log(JSON.stringify(clients, null, 2))
      else for (const entry of clients) {
        const version = entry.version ?? 'unknown'
        const state = CLIENT_READINESS_LABELS[entry.readiness] ?? entry.readiness
        const path = entry.path ?? '-'
        const reason = entry.reason === undefined ? '' : ` (${entry.reason})`
        console.log(`${entry.name} ${version} [${state}] ${path}${reason}`)
      }
      return 0
    } finally {
      client.close()
    }
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }
}

async function handleClientsPrune(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        'dry-run': { type: 'boolean' },
        apply: { type: 'boolean' },
        'older-than-days': { type: 'string' },
        config: { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    })
    requireNoPositionals(positionals, USAGE)
    if (values.apply && values['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive')
    const rawDays = values['older-than-days']
    const days = rawDays === undefined ? 7 : Number(rawDays)
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0 || (typeof rawDays === 'string' && rawDays.trim() === '')) {
      throw new Error('--older-than-days must be a finite, nonnegative number')
    }

    const stateRoot = resolveWrenyardStateRoot(process.env)
    const trustedRoot = await canonicalizeTrustedStateRoot(stateRoot)
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const result = await scanRuns(trustedRoot, cutoff)
    const removed: Array<{ path: string; family: string; finished_at: string; bytes: number }> = []
    if (values.apply) {
      for (const candidate of result.candidates) {
        const reason = await validateCandidate(trustedRoot, candidate.path, candidate.family, cutoff)
        if (reason) {
          result.skipped.push({ path: candidate.path, reason: `revalidation failed: ${reason}` })
          continue
        }
        await rm(candidate.path, { recursive: true, force: false })
        removed.push({ path: candidate.path, family: candidate.family, finished_at: candidate.finished_at, bytes: candidate.bytes })
      }
    }
    const eligibleBytes = result.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0)
    const removedBytes = removed.reduce((sum, candidate) => sum + candidate.bytes, 0)
    const payload = {
      mode: values.apply ? 'apply' : 'dry-run',
      older_than_days: days,
      candidates: values.apply ? removed : result.candidates,
      total_eligible_bytes: eligibleBytes,
      total_removed_bytes: removedBytes,
      skipped: result.skipped,
    }
    if (values.json) console.log(JSON.stringify(payload, null, 2))
    else {
      for (const candidate of payload.candidates) {
        console.log(`${values.apply ? 'Removed' : 'Would remove'} ${candidate.path} (${candidate.family}, ${candidate.bytes} bytes, ended ${candidate.finished_at})`)
      }
      console.log(`${values.apply ? 'Removed' : 'Eligible'} total: ${values.apply ? removedBytes : eligibleBytes} bytes`)
      for (const skipped of result.skipped) console.log(`Skipped ${skipped.path}: ${skipped.reason}`)
    }
    return 0
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }
}

// The trusted state root may be reached through a platform alias (macOS /var -> /private/var).
// Resolve it once, read-only, so an alias of the root is accepted while symlinks below it stay rejected.
async function canonicalizeTrustedStateRoot(stateRoot: string): Promise<string> {
  const resolved = resolve(stateRoot)
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

async function scanRuns(stateRoot: string, cutoff: number): Promise<ScanResult> {
  const candidates: Candidate[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  for (const family of FAMILIES) {
    await collectNonRunChildren(stateRoot, family, skipped)
    const runsRoot = join(stateRoot, 'clients', family, 'runs')
    const rootReason = await validateDirectoryAncestry(stateRoot, runsRoot)
    if (rootReason) {
      skipped.push({ path: runsRoot, reason: rootReason })
      continue
    }
    let entries
    try {
      entries = await readdir(runsRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) continue
      skipped.push({ path: runsRoot, reason: `cannot read run directory: ${errorMessage(error)}` })
      continue
    }
    for (const entry of entries) {
      const runPath = join(runsRoot, entry.name)
      if (!UUID.test(entry.name)) {
        skipped.push({ path: runPath, reason: 'unproven/unknown: directory name is not a UUID' })
        continue
      }
      const reason = await validateCandidate(stateRoot, runPath, family, cutoff)
      if (reason) {
        skipped.push({ path: runPath, reason })
        continue
      }
      try {
        const markerPath = join(runPath, '.wrenyard-run.json')
        const marker = await readMarker(markerPath)
        const bytes = await sumRegularFileBytes(runPath)
        // Abnormal-exit runs have no finished_at; created_at is their age basis.
        candidates.push({ path: runPath, family, finished_at: marker.finished_at ?? marker.created_at, bytes, markerPath })
      } catch (error) {
        skipped.push({ path: runPath, reason: `cannot account for run: ${errorMessage(error)}` })
      }
    }
  }
  return { candidates, skipped }
}

// Report every direct child of the client state directory other than `runs`, whether or not the
// `runs` root exists. Names and reasons only: no recursion, no byte accounting, never deletable.
async function collectNonRunChildren(stateRoot: string, family: typeof FAMILIES[number], skipped: Array<{ path: string; reason: string }>): Promise<void> {
  const familyRoot = join(stateRoot, 'clients', family)
  let entries
  try {
    entries = await readdir(familyRoot, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return
    skipped.push({ path: familyRoot, reason: `cannot read client state directory: ${errorMessage(error)}` })
    return
  }
  for (const entry of entries) {
    if (entry.name === 'runs') continue
    const path = join(familyRoot, entry.name)
    const reason = SHARED_CLIENT_DIRS[family].includes(entry.name)
      ? 'shared client data: never pruned'
      : 'legacy/unproven: not an owned run directory'
    skipped.push({ path, reason })
  }
}

type Liveness = 'alive' | 'dead' | 'unknown'

// Only ESRCH proves death; any other probe outcome stays protected.
function probeLiveness(pid: number, group = false): Liveness {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  if (group && process.platform === 'win32') return 'unknown'
  try {
    process.kill(group ? -pid : pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

function describeLiveness(value: Liveness): string {
  return value === 'unknown' ? 'unknown' : value
}

/**
 * Decide whether a run with this marker may still be executing.
 *
 * `prepared` never had a child, so only its recorded owner can keep it alive.
 * `running` is reclaimable only when its owner and child (and optional child
 * process group) are all proven dead. `spawning` or a missing launch phase is
 * an ambiguous crash window that is never reclaimed.
 */
function runStillInUse(marker: Marker): string | null {
  if (marker.state === 'done' || marker.state === 'failed') {
    if (typeof marker.finished_at !== 'string') return 'terminal run has no finished_at; protected'
    if (marker.child_pid !== undefined) {
      const liveness = probeLiveness(marker.child_pid)
      if (liveness !== 'dead') return `recorded child process is ${describeLiveness(liveness)}; protected`
    }
    if (marker.child_pgid !== undefined) {
      const liveness = probeLiveness(marker.child_pgid, true)
      if (liveness !== 'dead') return `recorded child process group is ${describeLiveness(liveness)}; protected`
    }
    return null
  }
  if (marker.launch_phase === 'prepared') {
    if (typeof marker.owner_pid !== 'number') return 'active run has no owner identity; protected'
    const liveness = probeLiveness(marker.owner_pid)
    if (liveness === 'dead') return null
    return `active run: owning process is ${describeLiveness(liveness)}`
  }
  if (marker.launch_phase === 'running') {
    if (process.platform === 'win32') return 'active run: running marker cannot be proven ended on this platform; protected'
    if (typeof marker.owner_pid !== 'number' || typeof marker.child_pid !== 'number') return 'active run has incomplete process provenance; protected'
    const owner = probeLiveness(marker.owner_pid)
    if (owner !== 'dead') return `active run: owning process is ${describeLiveness(owner)}`
    const child = probeLiveness(marker.child_pid)
    if (child !== 'dead') return `active run: child process is ${describeLiveness(child)}`
    if (marker.child_pgid !== undefined) {
      const group = probeLiveness(marker.child_pgid, true)
      if (group !== 'dead') return `active run: child process group is ${describeLiveness(group)}`
    }
    return null
  }
  return 'active run is in an ambiguous crash window (spawning or no launch phase); protected'
}

async function validateCandidate(stateRoot: string, runPath: string, family: string, cutoff: number): Promise<string | null> {
  const ancestryReason = await validateDirectoryAncestry(stateRoot, runPath)
  if (ancestryReason) return ancestryReason
  const runName = runPath.slice(runPath.lastIndexOf(sep) + 1)
  if (!UUID.test(runName)) return 'unproven/unknown: directory name is not a UUID'
  let marker: Marker
  try {
    marker = await readMarker(join(runPath, '.wrenyard-run.json'))
  } catch (error) {
    return `unproven/unknown: ${errorMessage(error)}`
  }
  if (marker.run_id !== runName || marker.client_family !== family) return 'invalid identity: marker family or run_id does not match its path'
  const inUse = runStillInUse(marker)
  if (inUse) return inUse
  // Terminal runs age from finished_at; abnormal-exit survivors keep state 'active', so they age from created_at.
  const ended = Date.parse(marker.state === 'active' ? marker.created_at : (marker.finished_at ?? ''))
  if (!Number.isFinite(ended)) return 'invalid timestamp: run end evidence is missing or invalid'
  if (ended >= cutoff) return 'too recent: run end is not older than the cutoff'
  return null
}

async function readMarker(path: string): Promise<Marker> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('ownership marker is not a regular file')
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    throw new Error('ownership marker is missing or invalid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ownership marker has invalid shape')
  const marker = value as Partial<Marker>
  if (marker.version !== 1 || typeof marker.client_family !== 'string' || !FAMILIES.includes(marker.client_family as typeof FAMILIES[number]) || typeof marker.run_id !== 'string' || !UUID.test(marker.run_id) || !['active', 'done', 'failed'].includes(String(marker.state)) || typeof marker.created_at !== 'string' || !Number.isFinite(Date.parse(marker.created_at))) {
    throw new Error('ownership marker has invalid shape')
  }
  if ((marker.state === 'done' || marker.state === 'failed') && typeof marker.finished_at !== 'string') throw new Error('terminal marker has no finished_at')
  return marker as Marker
}

async function validateDirectoryAncestry(stateRoot: string, target: string): Promise<string | null> {
  const root = resolve(stateRoot)
  const absolute = resolve(target)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== absolute) return 'path is outside the state root'
  const components = [root, ...rel.split(sep).filter(Boolean).reduce<string[]>((acc, part) => {
    acc.push(acc.length ? join(acc[acc.length - 1], part) : join(root, part))
    return acc
  }, [])]
  for (const component of components) {
    let info
    try { info = await lstat(component) } catch (error) {
      if (isMissing(error)) return 'directory or an ancestor is missing'
      return `cannot inspect path: ${errorMessage(error)}`
    }
    if (info.isSymbolicLink()) return 'symlink in candidate ancestry'
    if (!info.isDirectory()) return 'candidate ancestry is not a regular directory'
  }
  return null
}

async function sumRegularFileBytes(root: string): Promise<number> {
  let total = 0
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await walk(path)
      else if (info.isFile()) total += info.size
    }
  }
  await walk(root)
  return total
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')
}
