/**
 * Typed JSON-RPC params/results and JSON schemas for the client.list method.
 *
 * client.list is a read-only listing of the daemon's supported agent clients:
 * each entry reports the detected installation, version and executable path
 * plus a derived readiness state. No method here installs, upgrades or
 * reconfigures a client.
 */

import type { JsonSchema } from '../jsonrpc.mts'

// ─── client.list ───────────────────────────────────────────────────

export type ClientListParams = Record<string, never>

/** The derived readiness state of one agent client. */
export type ClientReadiness = 'ready' | 'not_installed' | 'disabled' | 'error'

export interface ClientListEntry {
  /** Stable client id (e.g. 'codex', 'claude'). */
  id: string
  /** Human-facing display name. */
  name: string
  /** Whether the client executable was detected on the daemon host. */
  installed: boolean
  /** Detected client version; absent when it could not be read. */
  version?: string
  /** Resolved executable path; absent when no executable was detected. */
  path?: string
  /** Whether the client is enabled for daemon use. */
  enabled: boolean
  /** Derived readiness state. */
  readiness: ClientReadiness
  /** Human-readable reason for a non-ready state; never a credential leak. */
  reason?: string
}

export interface ClientListResult {
  clients: ClientListEntry[]
}

const clientListEntrySchema = {
  type: 'object',
  required: ['id', 'name', 'installed', 'enabled', 'readiness'],
  properties: {
    id: { type: 'string', description: 'The stable client id.' },
    name: { type: 'string', description: 'The human-facing display name.' },
    installed: { type: 'boolean', description: 'Whether a client executable was detected.' },
    version: { type: 'string', description: 'The detected client version.' },
    path: { type: 'string', description: 'The resolved executable path.' },
    enabled: { type: 'boolean', description: 'Whether the client is enabled for daemon use.' },
    readiness: {
      type: 'string',
      enum: ['ready', 'not_installed', 'disabled', 'error'],
      description: 'The derived readiness state.',
    },
    reason: { type: 'string', description: 'The human-readable reason for a non-ready state.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const clientListParamsSchema = {
  type: 'object',
  description: 'List every supported agent client with its detected installation and readiness. Read-only.',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema

export const clientListResultSchema = {
  type: 'object',
  description: 'Every supported agent client with its detected installation and readiness.',
  required: ['clients'],
  properties: {
    clients: { type: 'array', description: 'The client entries.', items: clientListEntrySchema },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
