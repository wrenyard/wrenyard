import type { JsonSchema } from '../jsonrpc.mts'

/** Which Wrenyard root a reported path is: the state root or the config root. */

export type {
  StorageRootKind,
  StorageCategoryId,
  StorageUsageStatus,
  StorageUsageParams,
  StorageDeviceIdentity,
  StorageRootInfo,
  StorageCategoryUsage,
  StorageUsageSnapshot,
  StorageUsageResult,
  StorageCleanupCategoryId,
  StorageCleanupCategoryPolicy,
  StorageCleanupPolicy,
  StorageCleanupPathEvidence,
  StorageCleanupCategorySummary,
  CleanupPreviewParams,
  CleanupPreviewResult,
  CleanupRunParams,
  StorageCleanupOutcomeStatus,
  StorageCleanupOutcome,
  StorageCleanupRunRecord,
  CleanupRunResult,
} from '@wrenyard/protocol/storage'

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

const storageCleanupCategoryPolicySchema = {
  type: 'object',
  required: ['id', 'retentionDays', 'minimumRetentionDays', 'targetBytes', 'removes'],
  properties: {
    id: { enum: ['artifacts', 'logs', 'clients', 'worktrees', 'debug', 'database'] },
    retentionDays: { type: 'number', minimum: 0 },
    minimumRetentionDays: { type: 'number', minimum: 0 },
    targetBytes: { type: 'number', minimum: 0 },
    removes: { type: 'boolean' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const storageCleanupPolicySchema = {
  type: 'object',
  required: ['categories'],
  properties: {
    categories: { type: 'array', items: storageCleanupCategoryPolicySchema },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const storageCleanupPathEvidenceSchema = {
  type: 'object',
  required: ['id', 'category', 'path', 'ownership', 'logicalBytes', 'allocatedBytes', 'eligible', 'reason'],
  properties: {
    id: { type: 'string' },
    category: { enum: ['artifacts', 'logs', 'clients', 'worktrees', 'debug', 'database'] },
    path: { type: 'string' },
    ownership: { type: 'string' },
    logicalBytes: { type: 'number', minimum: 0 },
    allocatedBytes: { type: 'number', minimum: 0 },
    eligible: { type: 'boolean' },
    reason: { type: 'string' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const storageCleanupCategorySummarySchema = {
  type: 'object',
  required: ['id', 'totalBytes', 'eligibleBytes', 'protectedBytes', 'candidateCount', 'eligibleCount', 'protectedCount', 'targetBytes', 'overCapacity'],
  properties: {
    id: { enum: ['artifacts', 'logs', 'clients', 'worktrees', 'debug', 'database'] },
    totalBytes: { type: 'number', minimum: 0 },
    eligibleBytes: { type: 'number', minimum: 0 },
    protectedBytes: { type: 'number', minimum: 0 },
    candidateCount: { type: 'integer', minimum: 0 },
    eligibleCount: { type: 'integer', minimum: 0 },
    protectedCount: { type: 'integer', minimum: 0 },
    targetBytes: { type: 'number', minimum: 0 },
    overCapacity: { type: 'boolean' },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

/** Optional allowlist restricting a cleanup call to recognized categories. */
const storageCleanupCategoriesSchema = {
  type: 'array',
  minItems: 1,
  items: { enum: ['artifacts', 'logs', 'clients', 'worktrees', 'debug', 'database'] },
} as const satisfies JsonSchema

export const storageCleanupPreviewParamsSchema = {
  type: 'object',
  properties: {
    refresh: { type: 'boolean' },
    categories: storageCleanupCategoriesSchema,
    retentionDays: { type: 'integer', minimum: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const storageCleanupPreviewResultSchema = {
  type: 'object',
  required: ['generatedAt', 'stateRoot', 'policy', 'candidates', 'categories', 'totalLogicalBytes', 'totalAllocatedBytes'],
  properties: {
    generatedAt: { type: 'string' },
    stateRoot: { type: 'string' },
    policy: storageCleanupPolicySchema,
    candidates: { type: 'array', items: storageCleanupPathEvidenceSchema },
    categories: { type: 'array', items: storageCleanupCategorySummarySchema },
    totalLogicalBytes: { type: 'number', minimum: 0 },
    totalAllocatedBytes: { type: 'number', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const storageCleanupRunParamsSchema = {
  type: 'object',
  properties: {
    categories: storageCleanupCategoriesSchema,
    retentionDays: { type: 'integer', minimum: 1 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

const storageCleanupOutcomeSchema = {
  type: 'object',
  required: ['id', 'category', 'path', 'status', 'reason', 'logicalBytes', 'allocatedBytes'],
  properties: {
    id: { type: 'string' },
    category: { enum: ['artifacts', 'logs', 'clients', 'worktrees', 'debug', 'database'] },
    path: { type: 'string' },
    status: { enum: ['removed', 'protected', 'skipped', 'failed'] },
    reason: { type: 'string' },
    logicalBytes: { type: 'number', minimum: 0 },
    allocatedBytes: { type: 'number', minimum: 0 },
  },
  additionalProperties: true,
} as const satisfies JsonSchema

export const storageCleanupRunResultSchema = {
  type: 'object',
  required: ['runId', 'generatedAt', 'stateRoot', 'trigger', 'policy', 'outcomes', 'categories', 'removedLogicalBytes', 'removedAllocatedBytes', 'record'],
  properties: {
    runId: { type: 'string' },
    generatedAt: { type: 'string' },
    stateRoot: { type: 'string' },
    trigger: { type: 'string' },
    policy: storageCleanupPolicySchema,
    outcomes: { type: 'array', items: storageCleanupOutcomeSchema },
    categories: { type: 'array', items: storageCleanupCategorySummarySchema },
    removedLogicalBytes: { type: 'number', minimum: 0 },
    removedAllocatedBytes: { type: 'number', minimum: 0 },
    record: {
      type: 'object',
      required: ['id', 'startedAt', 'finishedAt', 'trigger'],
      properties: {
        id: { type: 'integer' },
        startedAt: { type: 'string' },
        finishedAt: { type: 'string' },
        trigger: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
} as const satisfies JsonSchema
