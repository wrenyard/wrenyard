import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveForemanConfigPath } from '../config/path.mts'
import { loadForemanServiceConfig } from '../config/reader.mts'
import { foremanStateRoot } from '../config/state.mts'
import type { ForemanServiceConfig } from '../config/types.mts'
import { resolveForemanServiceIpcPath } from '../control/ipc-server.mts'
import { resolveDependencyPackageRoot } from '../layout/suite-root.mts'

/**
 * Minimal, layout-agnostic daemon invocation resolution for the single owner
 * entrypoint `daemon run`. It resolves the same config path the daemon itself
 * uses and returns the argv that runs the control CLI (`apps/cli/src/index.mts`)
 * with `daemon run`, so the command lives in one place. It never derives a
 * package from this module's own location: the caller supplies the roots, since
 * Electron bundles this file.
 */
export interface DaemonLaunchOptions {
  /** Root of the @wrenyard/daemon package that owns the tsx loader. */
  daemonRoot: string
  /** Root of the @wrenyard/cli package whose `src/index.mts` runs `daemon run`. */
  cliRoot: string
  /** Node runtime that runs the control tree; defaults to process.execPath. */
  runtimeNode?: string
  /**
   * Explicit config path, used verbatim so a caller's already-resolved path is
   * never rewritten. When absent, resolveForemanConfigPath(env) supplies the
   * same default (legacy fallback included) the CLI daemon uses.
   */
  config?: string
  /** Environment for config/state resolution and the child env base. */
  env?: NodeJS.ProcessEnv
  /** CLI flag overrides forwarded to `daemon run` (work-dir only). */
  cli?: Record<string, unknown>
  /** Pre-resolved service config; loaded via loadForemanServiceConfig when absent. */
  serviceConfig?: ForemanServiceConfig
  /** Child-env entries merged last (Desktop pins WRENYARD_ROOT/WRENYARD_NODE_BIN). */
  envOverrides?: NodeJS.ProcessEnv
}

export interface DaemonLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Resolved config path handed to the daemon. */
  configPath: string
  config: ForemanServiceConfig
  /** IPC endpoint the daemon serves; the supervisor probes and shuts this down. */
  ipcPath: string
  /** Durable daemon state directory (`foremanStateRoot`). */
  stateDir: string
}

export function resolveDaemonLaunch(options: DaemonLaunchOptions): DaemonLaunch {
  const env = options.env ?? process.env
  const explicitConfig = options.config?.trim()
  const configPath = explicitConfig ? explicitConfig : resolveForemanConfigPath(undefined, env)
  const config = options.serviceConfig ?? loadForemanServiceConfig(configPath, { env })

  const tsxPackageRoot = resolveDependencyPackageRoot(options.daemonRoot, 'tsx')
  const preflightPath = join(tsxPackageRoot, 'dist', 'preflight.cjs')
  const loaderPath = join(tsxPackageRoot, 'dist', 'loader.mjs')
  if (!existsSync(preflightPath) || !existsSync(loaderPath)) {
    throw new Error('Local tsx loader files were not found. Run pnpm install at the Wrenyard suite root.')
  }

  const args = [
    '--require',
    preflightPath,
    '--import',
    pathToFileURL(loaderPath).href,
    join(options.cliRoot, 'src', 'index.mts'),
    'daemon',
    'run',
    '--config',
    configPath,
  ]
  appendStringOverride(args, '--work-dir', options.cli?.['work-dir'])

  return {
    command: options.runtimeNode ?? process.execPath,
    args,
    cwd: options.cliRoot,
    env: {
      ...env,
      WRENYARD_CONFIG: configPath,
      ...options.envOverrides,
    },
    configPath,
    config,
    ipcPath: resolveForemanServiceIpcPath({ path: config.service.ipc?.path }),
    stateDir: foremanStateRoot(env),
  }
}

function appendStringOverride(args: string[], flag: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    args.push(flag, value)
  }
}
