import type { JsonSchema } from '../common/jsonrpc'

// ─── client.list ───────────────────────────────────────────────────

export interface ClientListParams {
  /** When true, also fetch the latest published npm version and compute updateAvailable. */
  checkUpdates?: boolean
}

/** The derived readiness state of one agent client. */
export type ClientReadiness = 'ready' | 'not_installed' | 'disabled' | 'error'

/** Host identity reported alongside a client list. */
export interface ClientListHost {
  hostname: string
  platform: string
}

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
  /** Where the client was installed from: an npm-managed package or manual. */
  source?: 'npm' | 'manual'
  /** The npm package that installs this client, when one is known. */
  npmPackage?: string
  /** Latest published npm version, when checkUpdates was requested. */
  latestVersion?: string
  /** True when an installed npm client is behind latestVersion. */
  updateAvailable?: boolean
  /** A background install/upgrade currently running for this client. */
  busy?: 'install' | 'upgrade'
  /** The last install/upgrade failure message, when one was recorded. */
  lastError?: string
}

export interface ClientListResult {
  clients: ClientListEntry[]
  host: ClientListHost
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
    source: {
      type: 'string',
      enum: ['npm', 'manual'],
      description: 'Where the client was installed from.',
    },
    npmPackage: { type: 'string', description: 'The npm package that installs this client.' },
    latestVersion: { type: 'string', description: 'The latest published npm version.' },
    updateAvailable: { type: 'boolean', description: 'Whether an installed npm client is behind latestVersion.' },
    busy: {
      type: 'string',
      enum: ['install', 'upgrade'],
      description: 'A background install/upgrade currently running for this client.',
    },
    lastError: { type: 'string', description: 'The last install/upgrade failure message.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

const clientListHostSchema = {
  type: 'object',
  required: ['hostname', 'platform'],
  properties: {
    hostname: { type: 'string', description: 'The daemon host hostname.' },
    platform: { type: 'string', description: 'The daemon host platform (process.platform).' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const clientListParamsSchema = {
  type: 'object',
  description: 'List every supported agent client with its detected installation, install/upgrade state and host. Read-only.',
  properties: {
    checkUpdates: { type: 'boolean', description: 'Also fetch the latest npm version and compute updateAvailable.' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const clientListResultSchema = {
  type: 'object',
  description: 'Every supported agent client with its detected installation, install/upgrade state and host.',
  required: ['clients', 'host'],
  properties: {
    clients: { type: 'array', description: 'The client entries.', items: clientListEntrySchema },
    host: clientListHostSchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema

// ─── client.action ─────────────────────────────────────────────────

/** A client lifecycle action the daemon can perform. */
export type ClientAction = 'install' | 'upgrade'

export interface ClientActionParams {
  /** The stable client id to act on. */
  id: string
  /** The action to perform. */
  action: ClientAction
}

export interface ClientActionResult {
  client: ClientListEntry
}

export const clientActionParamsSchema = {
  type: 'object',
  description: 'Install or upgrade an agent client through its npm package as a background job.',
  required: ['id', 'action'],
  properties: {
    id: { type: 'string', description: 'The stable client id.' },
    action: {
      type: 'string',
      enum: ['install', 'upgrade'],
      description: 'The action to perform.',
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const clientActionResultSchema = {
  type: 'object',
  description: 'The refreshed client entry after the install/upgrade action.',
  required: ['client'],
  properties: {
    client: clientListEntrySchema,
  },
  additionalProperties: false,
} as const satisfies JsonSchema
