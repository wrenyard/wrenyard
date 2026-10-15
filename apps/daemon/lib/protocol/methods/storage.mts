import type { JsonSchema } from '../jsonrpc.mts'

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
