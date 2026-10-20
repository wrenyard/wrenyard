import type { JsonSchema } from '../common/jsonrpc'

/** Which Wrenyard root a reported path is: the state root or the config root. */
export type StorageRootKind = 'state' | 'config'

/**
 * Mutually exclusive usage buckets, keyed by the first path segment relative to
 * the STATE root. `sessions` holds the per-workspace session ledger and index;
 * `records` the SQLite database and its WAL/SHM sidecars; `files` the session
 * attachments and task artifacts; `clients` every other per-client state
 * (clients/quota/desktop); `other` is the catch-all for anything else under the
 * state root and everything under the config root.
 */
export type StorageCategoryId =
  | 'sessions'
  | 'records'
  | 'files'
  | 'worktrees'
  | 'logs'
  | 'clients'
  | 'other'

export type StorageUsageStatus = 'scanning' | 'ready' | 'failed'

export interface StorageUsageParams {
  /**
   * Start a fresh scan when none is running. Ignored while a scan is already in
   * flight; every call while scanning reports `scanning` and never starts a
   * second scan.
   */
  refresh?: boolean
}

/** The daemon's own device identity, so a remote daemon reports its host. */
export interface StorageDeviceIdentity {
  hostname: string
  platform: string
}

/** One resolved root the daemon reports usage for. */
export interface StorageRootInfo {
  kind: StorageRootKind
  path: string
}

export interface StorageCategoryUsage {
  id: StorageCategoryId
  bytes: number
  fileCount: number
  unreadable: number
}

/** The last completed scan. Retained across a running or failed re-scan. */
export interface StorageUsageSnapshot {
  totalBytes: number
  fileCount: number
  categories: StorageCategoryUsage[]
  unreadable: number
  unreadableSamples: string[]
  skippedLinks: number
}

export interface StorageUsageResult {
  device: StorageDeviceIdentity
  roots: StorageRootInfo[]
  status: StorageUsageStatus
  /** ISO time the current or most recent scan started. */
  startedAt?: string
  /** ISO time the scan that produced `result` finished. */
  scannedAt?: string
  /** Top-level failure message of the last scan, present when `status` is `failed`. */
  error?: string
  /** The last successful scan; kept while a new scan runs or after a failed re-scan. */
  result?: StorageUsageSnapshot
}

const storageCategoryUsageSchema = {
  type: 'object',
  required: ['id', 'bytes', 'fileCount', 'unreadable'],
  properties: {
    id: { enum: ['sessions', 'records', 'files', 'worktrees', 'logs', 'clients', 'other'] },
    bytes: { type: 'number', minimum: 0 },
    fileCount: { type: 'integer', minimum: 0 },
    unreadable: { type: 'integer', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const storageUsageParamsSchema = {
  type: 'object',
  properties: {
    refresh: { type: 'boolean' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const storageUsageResultSchema = {
  type: 'object',
  required: ['device', 'roots', 'status'],
  properties: {
    device: {
      type: 'object',
      required: ['hostname', 'platform'],
      properties: {
        hostname: { type: 'string' },
        platform: { type: 'string' },
      },
      additionalProperties: true,
    },
    roots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'path'],
        properties: {
          kind: { enum: ['state', 'config'] },
          path: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    status: { enum: ['scanning', 'ready', 'failed'] },
    startedAt: { type: 'string' },
    scannedAt: { type: 'string' },
    error: { type: 'string' },
    result: {
      type: 'object',
      required: ['totalBytes', 'fileCount', 'categories', 'unreadable', 'unreadableSamples', 'skippedLinks'],
      properties: {
        totalBytes: { type: 'number', minimum: 0 },
        fileCount: { type: 'integer', minimum: 0 },
        categories: {
          // Always the seven exclusive buckets in a fixed order.
          type: 'array',
          minItems: 7,
          maxItems: 7,
          items: storageCategoryUsageSchema,
        },
        unreadable: { type: 'integer', minimum: 0 },
        unreadableSamples: { type: 'array', items: { type: 'string' } },
        skippedLinks: { type: 'integer', minimum: 0 },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

/**
 * Managed-artifact categories the cleanup service may inventory and act on.
 * `artifacts`, `logs` (proven closed directories only), `worktrees`, `clients`
 * (owned run homes only), `debug` (marker-owned `gdbg-*` directories only) and
 * `database` (retention compaction of old event/execution payload rows) may be
 * acted on once their ownership and inactivity are proven; every other entry is
 * reported as protected.
 */
export type StorageCleanupCategoryId = 'artifacts' | 'logs' | 'clients' | 'worktrees' | 'debug' | 'database'

/** One category's retention/capacity policy, reported so protection is visible. */
export interface StorageCleanupCategoryPolicy {
  id: StorageCleanupCategoryId
  /** Age at or beyond which a proven-safe candidate is removed by retention. */
  retentionDays: number
  /**
   * Hard floor: nothing younger than this is ever removed, even when the
   * category is over its capacity target.
   */
  minimumRetentionDays: number
  /** Soft per-category logical-byte target; protected excess is reported, not force-evicted. */
  targetBytes: number
  /** Whether `storage.cleanup.run` may actually delete in this category. */
  removes: boolean
}

export interface StorageCleanupPolicy {
  categories: StorageCleanupCategoryPolicy[]
}

/** One enumerated path with its ownership evidence and eligibility decision. */
export interface StorageCleanupPathEvidence {
  id: string
  category: StorageCleanupCategoryId
  path: string
  /** Short, privacy-safe ownership evidence (never file contents). */
  ownership: string
  /** Apparent size from `lstat` (bytes). */
  logicalBytes: number
  /** Allocated size from `lstat` blocks*512 (bytes). */
  allocatedBytes: number
  eligible: boolean
  /** Why the path is eligible, protected or skipped. */
  reason: string
}

/** Per-category byte aggregates, including protected over-capacity bytes. */
export interface StorageCleanupCategorySummary {
  id: StorageCleanupCategoryId
  totalBytes: number
  eligibleBytes: number
  protectedBytes: number
  candidateCount: number
  eligibleCount: number
  protectedCount: number
  targetBytes: number
  /** True when the category exceeds its target and protection blocks reclaim. */
  overCapacity: boolean
}

export interface CleanupPreviewParams {
  /** Accepted for symmetry with `storage.usage`; the scan is always fresh. */
  refresh?: boolean
  /** Restrict the scan to these categories; omitted means every category. */
  categories?: StorageCleanupCategoryId[]
  /** Optional override of the database retention window in days (>= 1). */
  retentionDays?: number
}

export interface CleanupPreviewResult {
  generatedAt: string
  stateRoot: string
  policy: StorageCleanupPolicy
  candidates: StorageCleanupPathEvidence[]
  categories: StorageCleanupCategorySummary[]
  totalLogicalBytes: number
  totalAllocatedBytes: number
}

/** `storage.cleanup.run` takes only the optional category filter and window override. */
export interface CleanupRunParams {
  /** Restrict the run to these categories; omitted means every category. */
  categories?: StorageCleanupCategoryId[]
  /** Optional override of the database retention window in days (>= 1). */
  retentionDays?: number
}

export type StorageCleanupOutcomeStatus = 'removed' | 'protected' | 'skipped' | 'failed'

/** One path's result from an executed cleanup. */
export interface StorageCleanupOutcome {
  id: string
  category: StorageCleanupCategoryId
  path: string
  status: StorageCleanupOutcomeStatus
  reason: string
  /** Measured logical bytes freed (0 when not removed). */
  logicalBytes: number
  /** Measured allocated bytes freed (0 when not removed). */
  allocatedBytes: number
}

/** The bounded audit row persisted for one executed cleanup. */
export interface StorageCleanupRunRecord {
  id: number
  startedAt: string
  finishedAt: string
  trigger: string
}

export interface CleanupRunResult {
  runId: string
  generatedAt: string
  stateRoot: string
  trigger: string
  policy: StorageCleanupPolicy
  outcomes: StorageCleanupOutcome[]
  categories: StorageCleanupCategorySummary[]
  /** Sum of measured logical bytes actually removed. */
  removedLogicalBytes: number
  /** Sum of measured allocated bytes actually removed. */
  removedAllocatedBytes: number
  record: StorageCleanupRunRecord
}
