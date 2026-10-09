import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { resolveWrenyardConfigPath } from '@wrenyard/paths'

export type WrenyardIpcEnvironment = NodeJS.ProcessEnv

export interface WrenyardIpcPathOptions {
  /**
   * Already-loaded config. When provided it is authoritative: the resolver
   * never re-reads the config file, even when no IPC path is configured.
   */
  config?: { service?: { ipc?: { path?: unknown } } }
  /** Explicit config file path honoured only when `config` is not provided. */
  configPath?: string
}

function isWindowsPipePath(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\')
}

function normalizePipeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-')
}

/**
 * Normalize a socket name/endpoint with the exact platform semantics the daemon
 * IPC server used before this module was shared:
 * - Windows: a full `\\.\pipe\...` path is kept verbatim; any other name is
 *   reduced to a pipe name (`[\\/:*?"<>|]` -> `-`) and prefixed with
 *   `\\.\pipe\`.
 * - Unix: an absolute path is kept verbatim; a relative name with a base
 *   directory becomes `<baseDir>/<name>.sock`; otherwise it is kept verbatim.
 */
export function normalizeWrenyardIpcPath(name: string, baseDir?: string): string {
  if (process.platform === 'win32') {
    if (isWindowsPipePath(name)) return name
    return `\\\\.\\pipe\\${normalizePipeName(name)}`
  }

  if (isAbsolute(name)) return name
  if (baseDir) return join(baseDir, `${name}.sock`)
  return name
}

/**
 * Canonical short IPC base directory for Unix defaults: the real `/tmp` when it
 * resolves, otherwise the platform tmpdir. Windows has no base directory.
 */
function shortIpcBaseDir(): string | undefined {
  if (process.platform === 'win32') return undefined

  try {
    return realpathSync('/tmp')
  } catch {
    return realpathSync(tmpdir())
  }
}

/** The shared default control socket for the Wrenyard daemon. */
export function defaultWrenyardIpcPath(): string {
  return normalizeWrenyardIpcPath('wrenyard', shortIpcBaseDir())
}

function readWrenyardConfigJson(
  configPath: string | undefined,
  env: WrenyardIpcEnvironment,
): unknown {
  const path = resolveWrenyardConfigPath(configPath, env)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid config JSON at ${path}`, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config JSON at ${path}`)
  }
  return parsed
}

function configuredIpcPath(config: unknown): string | undefined {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined
  const service = (config as { service?: unknown }).service
  if (service === null || typeof service !== 'object' || Array.isArray(service)) return undefined
  const ipc = (service as { ipc?: unknown }).ipc
  if (ipc === null || typeof ipc !== 'object' || Array.isArray(ipc)) return undefined
  const path = (ipc as { path?: unknown }).path
  return typeof path === 'string' && path.trim() ? path.trim() : undefined
}

/**
 * Resolve the Wrenyard control socket, shared by every surface. Precedence:
 * 1. non-blank `WRENYARD_IPC_PATH` (normalized and returned without touching
 *    the config file);
 * 2. an explicitly provided `config` (used verbatim, never re-read), else the
 *    JSON read synchronously from `resolveWrenyardConfigPath(options.configPath,
 *    env)`; a non-blank `config.service.ipc.path` is normalized and returned;
 * 3. the platform default (`defaultWrenyardIpcPath`).
 *
 * The read is read-only: a missing file means no config, a blank file means an
 * empty object, malformed JSON is a contextual error, and permission/other IO
 * errors propagate. Env and configured values share the same normalization.
 */
export function resolveWrenyardIpcPath(
  env: WrenyardIpcEnvironment = process.env,
  options: WrenyardIpcPathOptions = {},
): string {
  const envPath = env.WRENYARD_IPC_PATH?.trim()
  if (envPath) return normalizeWrenyardIpcPath(envPath, shortIpcBaseDir())

  const config = options.config !== undefined
    ? options.config
    : readWrenyardConfigJson(options.configPath, env)
  const path = configuredIpcPath(config)
  if (path !== undefined) return normalizeWrenyardIpcPath(path, shortIpcBaseDir())

  return defaultWrenyardIpcPath()
}
