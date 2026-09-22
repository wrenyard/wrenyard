/**
 * Public JSON-RPC wire contract for runtime alias CRUD over the daemon IPC
 * surface: runtime.alias.snapshot, runtime.alias.put, and runtime.alias.remove.
 *
 * Every schema is strict and closed (additionalProperties: false), strings and
 * arrays are bounded, and only JSON-safe values are admitted. The DTOs never
 * carry credentials or provider endpoints: targets are canonical
 * "provider/model:client" run strings and the only path exposed is the alias
 * store config_path.
 */

import type { JsonSchema } from '../jsonrpc.mts'

/** runtime.alias.snapshot carries no params; the current store state is returned. */
export interface RuntimeAliasSnapshotParams {
  // Empty: snapshot is read-only and needs no inputs.
}

export const runtimeAliasSnapshotParamsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

/** A usable alias entry: validated name plus its canonical run target. */
export interface RuntimeAliasEntry {
  name: string
  /** Canonical "provider/model:client" run string. */
  target: string
}

/**
 * A per-entry store issue. `name` is the raw persisted alias name (which may be
 * malformed) and `value`, when present, is the raw persisted value projected to
 * a JSON scalar so no nested document is ever leaked.
 */
export interface RuntimeAliasIssue {
  name: string
  value?: string | number | boolean | null
  message: string
}

/** Snapshot of the whole runtime alias store, shared by all three methods. */
export interface RuntimeAliasSnapshotResult {
  config_path: string
  /** Non-negative integer revision; CAS guards increment it on every write. */
  revision: number
  aliases: RuntimeAliasEntry[]
  issues: RuntimeAliasIssue[]
}

const aliasEntrySchema = {
  type: 'object',
  required: ['name', 'target'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
    },
    target: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const

const aliasIssueSchema = {
  type: 'object',
  required: ['name', 'message'],
  additionalProperties: false,
  properties: {
    // The raw persisted name may itself be invalid, so no pattern/minLength.
    name: { type: 'string', maxLength: 1024 },
    // value is optional and only JSON scalars are admitted.
    value: { type: ['string', 'number', 'boolean', 'null'] },
    message: { type: 'string', minLength: 1, maxLength: 2048 },
  },
} as const

export const runtimeAliasSnapshotResultSchema = {
  type: 'object',
  required: ['config_path', 'revision', 'aliases', 'issues'],
  additionalProperties: false,
  properties: {
    config_path: { type: 'string', minLength: 1, maxLength: 4096 },
    revision: { type: 'integer', minimum: 0 },
    aliases: {
      type: 'array',
      maxItems: 2048,
      items: aliasEntrySchema,
    },
    issues: {
      type: 'array',
      maxItems: 2048,
      items: aliasIssueSchema,
    },
  },
} as const satisfies JsonSchema

/** runtime.alias.put params: name, target, and the expected CAS revision. */
export interface RuntimeAliasPutParams {
  name: string
  target: string
  expected_revision: number
}

export const runtimeAliasPutParamsSchema = {
  type: 'object',
  required: ['name', 'target', 'expected_revision'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
    },
    target: { type: 'string', minLength: 1, maxLength: 512 },
    expected_revision: { type: 'integer', minimum: 0 },
  },
} as const satisfies JsonSchema

/** runtime.alias.remove params: name and the expected CAS revision. */
export interface RuntimeAliasRemoveParams {
  name: string
  expected_revision: number
}

export const runtimeAliasRemoveParamsSchema = {
  type: 'object',
  required: ['name', 'expected_revision'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
    },
    expected_revision: { type: 'integer', minimum: 0 },
  },
} as const satisfies JsonSchema

// put/remove both answer with a fresh store snapshot, so they share the
// snapshot result schema and result type.
export const runtimeAliasPutResultSchema = runtimeAliasSnapshotResultSchema
export const runtimeAliasRemoveResultSchema = runtimeAliasSnapshotResultSchema
export type RuntimeAliasPutResult = RuntimeAliasSnapshotResult
export type RuntimeAliasRemoveResult = RuntimeAliasSnapshotResult
