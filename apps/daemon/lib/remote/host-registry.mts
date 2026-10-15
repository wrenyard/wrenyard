import {
  normalizeRemoteHostRegistry,
  MAX_REMOTE_HOSTS,
  type ForemanConfigData,
  type RemoteHostRecordData,
} from '../config/data.mts'
import { ForemanConfigManager } from '../config/manager.mts'
import type {
  RemoteHostListResult,
  RemoteHostRecord,
  RemoteHostSaveParams,
} from '../protocol/registry.mts'

/**
 * Daemon-owned remote host registry.
 *
 * It owns the saved-connection list that backs the `remote.host.*` IPC methods:
 * list saved hosts, remember a host only after a validated, compatible, ready
 * remote connection, and rename a display name. Persistence goes through
 * the daemon config manager, so every write is the same atomic mode-`0600`
 * write used for the rest of the daemon config.
 *
 * It never stores, logs or returns a password, private key, passphrase or any
 * other secret: a record holds only the SSH alias and verified metadata, and
 * every value read back is re-normalized to the same shape.
 */

/** Stable error codes surfaced to the RPC layer. */
export type RemoteHostRegistryErrorCode =
  | 'invalid_alias'
  | 'not_found'
  | 'registry_full'

export class RemoteHostRegistryError extends Error {
  readonly code: RemoteHostRegistryErrorCode

  constructor(code: RemoteHostRegistryErrorCode, message: string) {
    super(message)
    this.name = 'RemoteHostRegistryError'
    this.code = code
  }
}

/**
 * A concrete SSH host alias: a `Host` name the user configured. Wildcard,
 * negated and otherwise non-concrete patterns are rejected so they can never be
 * recorded as connectable hosts, and control characters/leading options are
 * rejected so an alias can never be smuggled into a shell command or an argv
 * entry.
 */
function normalizeAlias(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RemoteHostRegistryError('invalid_alias', 'SSH 别名无效')
  }
  const alias = value.trim()
  if (
    alias === ''
    || alias.length > 255
    || alias.startsWith('-')
    || /[\s*?!]/.test(alias)
    || /[\u0000-\u001f\u007f]/.test(alias)
  ) {
    throw new RemoteHostRegistryError('invalid_alias', `SSH 别名无效：${value}`)
  }
  return alias
}

function normalizeDisplayName(value: unknown, fallback: string): string {
  const displayName = typeof value === 'string' ? value.trim() : ''
  return (displayName || fallback).slice(0, 255)
}

function normalizeMetadata(value: unknown, max: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, max) : undefined
}

/** Project a persisted record to the IPC presentation shape. */
function toRecord(record: RemoteHostRecordData): RemoteHostRecord {
  const alias = record.alias
  return {
    alias,
    displayName: normalizeDisplayName(record.displayName, alias),
    ...(record.platform ? { platform: record.platform } : {}),
    ...(record.arch ? { arch: record.arch } : {}),
    ...(record.daemonVersion ? { daemonVersion: record.daemonVersion } : {}),
  }
}

export interface RemoteHostRegistryOptions {
  /** Injected config manager; defaults to the canonical daemon config manager. */
  manager?: ForemanConfigManager
  /** Explicit config path; omitted means the canonical Wrenyard config location. */
  configPath?: string
}

export class RemoteHostRegistryService {
  private readonly manager: ForemanConfigManager
  private readonly configPath: string | undefined

  constructor(options: RemoteHostRegistryOptions = {}) {
    this.manager = options.manager ?? new ForemanConfigManager()
    this.configPath = options.configPath
  }

  /** Read the saved host list. Never throws on a malformed document. */
  list(): RemoteHostListResult {
    const { data } = this.manager.loadUserData(this.configPath)
    const registry = normalizeRemoteHostRegistry(data.remote?.hosts)
    return { hosts: registry.hosts.map(toRecord) }
  }

  /**
   * Remember a host. `ready` must be `true`: the caller attests that the
   * candidate was validated and that the remote daemon is compatible and ready.
   * A failed probe or confirmation must never call this method.
   */
  save(params: RemoteHostSaveParams): RemoteHostListResult {
    if (params.ready !== true) {
      throw new RemoteHostRegistryError(
        'invalid_alias',
        '只有在连接校验成功后才可保存该主机',
      )
    }
    const alias = normalizeAlias(params.alias)
    const platform = normalizeMetadata(params.platform, 64)
    const arch = normalizeMetadata(params.arch, 64)
    const daemonVersion = normalizeMetadata(params.daemonVersion, 64)
    if (!platform || !arch || !daemonVersion) {
      throw new RemoteHostRegistryError('invalid_alias', '远程主机元数据不完整')
    }
    const displayName = normalizeDisplayName(params.displayName, alias)
    return this.mutate((hosts) => {
      const index = hosts.findIndex((host) => host.alias === alias)
      const record: RemoteHostRecordData = {
        alias,
        displayName,
        platform,
        arch,
        daemonVersion,
      }
      if (index >= 0) hosts[index] = record
      else if (hosts.length < MAX_REMOTE_HOSTS) hosts.push(record)
      else throw new RemoteHostRegistryError('registry_full', '已保存的远程主机数量已达上限')
    })
  }

  /** Rename one saved host's display name. */
  rename(aliasValue: string, displayNameValue: string): RemoteHostListResult {
    const alias = normalizeAlias(aliasValue)
    const displayName = normalizeDisplayName(displayNameValue, alias)
    return this.mutate((hosts) => {
      const host = hosts.find((entry) => entry.alias === alias)
      if (!host) {
        throw new RemoteHostRegistryError('not_found', `未找到已保存的主机：${alias}`)
      }
      host.displayName = displayName
    })
  }

  /**
   * Apply one mutation to the normalized registry and persist it atomically.
   * The updater never sees raw config values: it receives the normalized,
   * secret-free host list, so a hand-edited document cannot leak an unexpected
   * field into the write. The registry is written back through the same
   * normalizer, so the persisted document is always the identical
   * `RemoteHostRegistryData` shape the read path produces.
   */
  private mutate(update: (hosts: RemoteHostRecordData[]) => void): RemoteHostListResult {
    let result: RemoteHostRecordData[] = []
    this.manager.updateUserData(this.configPath, (data: ForemanConfigData) => {
      const hosts = normalizeRemoteHostRegistry(data.remote?.hosts).hosts
      update(hosts)
      result = hosts
      data.remote = { hosts: normalizeRemoteHostRegistry({ hosts }) }
    })
    return { hosts: result.map(toRecord) }
  }
}
