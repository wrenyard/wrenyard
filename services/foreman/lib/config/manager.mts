import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  type ConfigRecord,
  createDefaultForemanConfigData,
  type ForemanConfigData,
  mergeForemanConfigData,
} from './data.mts'
import {
  resolveForemanConfigPath,
  resolveWriteForemanConfigPath,
} from './path.mts'
import { migrateForemanChatGPTReferences } from './chatgpt-migration.mts'
import {
  normalizeForemanServiceConfig,
  type NormalizeForemanConfigOptions,
} from './normalize.mts'
import type { ForemanServiceConfig } from './types.mts'

export interface ForemanConfigStore {
  read(configPath: string): ConfigRecord | null
  write(configPath: string, data: ConfigRecord): void
}

export class JsonForemanConfigStore implements ForemanConfigStore {
  read(configPath: string): ConfigRecord | null {
    if (!existsSync(configPath)) return null

    const content = readFileSync(configPath, 'utf-8')
    const trimmed = content.trim()
    if (!trimmed) return {}

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (cause) {
      throw new Error(
        `Invalid config JSON at ${configPath}`,
        cause instanceof Error ? { cause } : undefined,
      )
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error(
        `Invalid config JSON at ${configPath}: root must be an object`,
      )
    }

    // Migrate persisted ChatGPT identity references (legacy codex/codex-spark
    // target refs and exclusion ids) to their canonical chatgpt form. The
    // migration only touches known identity fields; unrelated data is left
    // unchanged. When something changed it is persisted exactly once through
    // the existing atomic write so task pins/exclusions resolve canonically.
    const migrated = migrateForemanChatGPTReferences(parsed)
    if (migrated.changed) {
      const record = migrated.record as ConfigRecord
      this.write(configPath, record)
      return record
    }

    return parsed as ConfigRecord
  }

  write(configPath: string, data: ConfigRecord): void {
    const dir = dirname(configPath)
    mkdirSync(dir, { recursive: true })
    // Atomic same-filesystem write: serialize to a private temp file (restrictive
    // mode where supported), fsync-free rename over the target, and clean up the
    // temp file on any failure so readers never observe a partially written
    // config. The formatted JSON shape (+ trailing newline) is unchanged.
    const tempPath = join(dir, `.${basename(configPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      })
      renameSync(tempPath, configPath)
    } catch (error) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        // Best-effort cleanup only; the original error is the failure to report.
      }
      throw error
    }
  }
}

export interface LoadServiceConfigResult {
  configPath: string
  config: ForemanServiceConfig
}

export interface LoadDataResult {
  configPath: string
  data: ForemanConfigData
}

export class ForemanConfigManager {
  private store: ForemanConfigStore
  private env: NodeJS.ProcessEnv

  constructor(options?: { store?: ForemanConfigStore; env?: NodeJS.ProcessEnv }) {
    this.store = options?.store ?? new JsonForemanConfigStore()
    this.env = options?.env ?? process.env
  }

  resolvePath(configPathValue?: unknown): string {
    return resolveForemanConfigPath(configPathValue, this.env)
  }

  // Read resolution may fall back to the legacy config; write resolution never
  // does. Implicit writes always target the primary Wrenyard config directory.
  resolveWritePath(configPathValue?: unknown): string {
    return resolveWriteForemanConfigPath(configPathValue, this.env)
  }

  loadUserData(configPathValue?: unknown): LoadDataResult {
    const configPath = this.resolvePath(configPathValue)
    const raw = this.store.read(configPath)
    const data = raw ?? {}
    return { configPath, data: data as ForemanConfigData }
  }

  loadData(configPathValue?: unknown): LoadDataResult {
    const configPath = this.resolvePath(configPathValue)
    const defaults = createDefaultForemanConfigData({ env: this.env })
    const raw = this.store.read(configPath)
    const overlay = raw ?? ({} as ForemanConfigData)
    const data = mergeForemanConfigData(defaults, overlay)
    return { configPath, data }
  }

  loadServiceConfig(configPathValue?: unknown): LoadServiceConfigResult {
    const configPath = this.resolvePath(configPathValue)
    const { data } = this.loadData(configPathValue)
    const configDir = dirname(configPath)
    const config = normalizeForemanServiceConfig(data as ConfigRecord, {
      configDir,
      env: this.env,
    } satisfies NormalizeForemanConfigOptions)
    return { configPath, config }
  }

  saveUserData(configPathValue: unknown, data: ForemanConfigData): void {
    const configPath = this.resolveWritePath(configPathValue)
    this.store.write(configPath, data as ConfigRecord)
  }

  updateUserData(
    configPathValue: unknown,
    updater: (data: ForemanConfigData) => void,
  ): void {
    // Reads may fall back to the legacy config, but writes always target the
    // primary Wrenyard path and never overwrite the legacy file.
    const { data } = this.loadUserData(configPathValue)
    updater(data)
    this.store.write(this.resolveWritePath(configPathValue), data as ConfigRecord)
  }
}
