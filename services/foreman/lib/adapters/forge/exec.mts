import type { SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  resolveRuntimeBin,
  type ResolveRuntimeBinOptions,
} from '../../layout/runtime-bin.mts'
import {
  resolveWindowsHideOption,
  spawnShellProcess,
} from '../shell/process.mts'

const DEFAULT_FORGE_PATH_DIRS = process.platform === 'win32'
  ? []
  : [join(homedir(), '.local', 'bin')]

function forgeArgsPrefix(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.WRENYARD_FORGE_ARGS_PREFIX?.trim() || env.FOREMAN_FORGE_ARGS_PREFIX?.trim()
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === 'string')) return parsed
  } catch {
    // Fall through to the validation error below.
  }

  throw new Error('WRENYARD_FORGE_ARGS_PREFIX must be a JSON array of strings')
}

export function resolveForgeInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const command = resolveRuntimeBin(env)
  return { command, args: [...forgeArgsPrefix(env), ...args] }
}

export { resolveRuntimeBin, type ResolveRuntimeBinOptions }

export function resolveForgeSpawnInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const invocation = resolveForgeInvocation(args, env)
  const resolvedEnv = resolveForgeEnv(env)
  const windowsCmdShim = resolveWindowsCmdShim(invocation.command, resolvedEnv)
  if (!windowsCmdShim) return invocation

  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', windowsCmdShim, ...invocation.args],
  }
}

function pathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return 'PATH'
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
}

export function resolveForgeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const key = pathEnvKey(env)
  const currentPath = env[key] ?? ''
  const parts = currentPath.split(delimiter).filter(Boolean)
  const seen = new Set(parts)
  const prepended = DEFAULT_FORGE_PATH_DIRS.filter((dir) => !seen.has(dir))
  return {
    ...env,
    [key]: [...prepended, ...parts].join(delimiter),
  }
}

function resolveWindowsCmdShim(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== 'win32') return undefined

  const commandHasPath = /[\\/]/.test(command)
  if (command.toLowerCase().endsWith('.cmd')) {
    return command
  }

  if (commandHasPath) {
    const candidate = `${command}.cmd`
    return existsSync(candidate) ? candidate : undefined
  }

  const key = pathEnvKey(env)
  const currentPath = env[key] ?? ''
  for (const dir of currentPath.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, `${command}.cmd`)
    if (existsSync(candidate)) return candidate
  }

  return undefined
}

export function spawnForge(args: string[], options: SpawnOptions = {}) {
  const env = resolveForgeEnv(options.env ?? process.env)
  const invocation = resolveForgeSpawnInvocation(args, env)
  return spawnShellProcess(invocation.command, invocation.args, {
    ...options,
    env,
    windowsHide: resolveWindowsHideOption(options),
  })
}

export { resolveWindowsHideOption }
