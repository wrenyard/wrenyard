import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDependencyPackageRoot as resolveDependencyPackageRootFromLayout } from '../../layout/suite-root.mts'

/**
 * One durable step of suite preparation. Each command runs with no shell,
 * inherited stdio, and the window hidden so the detached updater surfaces
 * output on the parent terminal while staying deterministic across platforms.
 */
export interface SuitePreparationCommand {
  command: string
  args: string[]
  cwd: string
  shell: false
  stdio: 'inherit'
  windowsHide: true
}

/** A runner executes one {@link SuitePreparationCommand} and reports its exit. */
export interface SuitePreparationRunner {
  run(command: SuitePreparationCommand): Promise<SuitePreparationRunResult>
}

export interface SuitePreparationRunResult {
  status: number | null
  signal: NodeJS.Signals | null
}

export interface SuitePreparationOptions {
  /** Path to the pinned pnpm CLI (`bin/pnpm.cjs`); defaults to resolving the pnpm package from the checkout's node_modules. */
  pnpmCliPath?: string
  /** Command runner; defaults to spawn-based execution. Tests inject a recording runner. */
  runner?: SuitePreparationRunner
}

/** The suite preparation seam: given a checkout path, make it runnable. */
export interface SuiteUpdatePreparer {
  prepare(checkoutPath: string): Promise<void>
}

/**
 * Stable error raised by suite preparation. Callers match on `code`, never on
 * message text; `command` names the executable that failed (when applicable).
 */
export class SuitePreparationError extends Error {
  readonly code: string
  readonly command?: string

  constructor(code: string, message: string, command?: string) {
    super(message)
    this.name = 'SuitePreparationError'
    this.code = code
    if (command !== undefined) this.command = command
  }
}

/**
 * Markers that identify a Wrenyard source checkout. Validated up front so a
 * wrong checkout fails before any command (or download) runs.
 */
const SUITE_MARKERS = [
  'pnpm-workspace.yaml',
  'release-manifest.json',
  join('runtime', 'forge', 'go.mod'),
  join('services', 'foreman', 'package.json'),
] as const

/**
 * Resolve the root of an installed npm package (e.g. `pnpm`) inside the
 * checkout via standard Node package resolution (createRequire), not pnpm's
 * private store layout. Delegates to the layout resolver and maps any
 * resolution failure onto a {@link SuitePreparationError}.
 */
export function resolveDependencyPackageRoot(checkoutPath: string, name: string): string {
  try {
    return resolveDependencyPackageRootFromLayout(checkoutPath, name)
  } catch (error) {
    if (error instanceof SuitePreparationError) throw error
    throw new SuitePreparationError(
      'dependency_package_not_found',
      `cannot resolve '${name}' package from '${checkoutPath}' (run 'pnpm install' first): ${error instanceof Error ? error.message : String(error)}`,
      name,
    )
  }
}

function forgeArtifactName(): string {
  return process.platform === 'win32' ? 'forge.exe' : 'forge'
}

/**
 * Build the exact preparation command sequence for a source checkout:
 *
 *   1. `node <pnpm> install --frozen-lockfile`  — lockfile-honoring deps
 *   2. `node <pnpm> run typecheck`              — TS packages + Pet
 *   3. `node <pnpm> run build`                  — TS packages + Pet
 *   4. `go -C <runtime/forge> build -o <runtime/forge/bin/forge> ./cmd/forge`
 *   5. `<runtime/forge/bin/forge> setup --self-install` — replay-safe local stable runtime
 *
 * No git pull and no network beyond the lockfile-bounded pnpm install.
 */
export function buildSuitePreparationCommands(
  checkoutPath: string,
  options: SuitePreparationOptions = {},
): SuitePreparationCommand[] {
  for (const marker of SUITE_MARKERS) {
    if (!existsSync(join(checkoutPath, marker))) {
      throw new SuitePreparationError(
        'missing_suite_marker',
        `suite checkout '${checkoutPath}' is missing required marker '${marker}'`,
        marker,
      )
    }
  }

  const pnpmCliPath = options.pnpmCliPath
    ?? join(resolveDependencyPackageRoot(checkoutPath, 'pnpm'), 'bin', 'pnpm.cjs')
  if (!existsSync(pnpmCliPath)) {
    throw new SuitePreparationError(
      'dependency_package_not_found',
      `resolved pnpm CLI '${pnpmCliPath}' does not exist (run 'pnpm install' first)`,
      pnpmCliPath,
    )
  }
  const forgeRuntimeDir = join(checkoutPath, 'runtime', 'forge')
  const forgeBinaryPath = join(forgeRuntimeDir, 'bin', forgeArtifactName())

  const makeCommand = (command: string, args: string[]): SuitePreparationCommand => ({
    command,
    args,
    cwd: checkoutPath,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  })

  return [
    makeCommand(process.execPath, [pnpmCliPath, 'install', '--frozen-lockfile']),
    makeCommand(process.execPath, [pnpmCliPath, 'run', 'typecheck']),
    makeCommand(process.execPath, [pnpmCliPath, 'run', 'build']),
    makeCommand('go', ['-C', forgeRuntimeDir, 'build', '-o', forgeBinaryPath, './cmd/forge']),
    makeCommand(forgeBinaryPath, ['setup', '--self-install']),
  ]
}

function describeCommand(command: SuitePreparationCommand): string {
  return `${command.command} ${command.args.join(' ')}`
}

/** Default runner: spawn each command with no shell, inherited stdio, hidden window. */
const defaultRunner: SuitePreparationRunner = {
  run(command: SuitePreparationCommand): Promise<SuitePreparationRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        shell: command.shell,
        stdio: command.stdio,
        windowsHide: command.windowsHide,
      })
      child.once('error', reject)
      child.once('exit', (status, signal) => resolve({ status, signal }))
    })
  },
}

/**
 * Prepare a source checkout in place: run every {@link buildSuitePreparationCommands}
 * step in order, fail-fast on the first nonzero/signal/startup error, and stop
 * issuing further commands. Repeatable: a re-run (including replay after a
 * crash) proceeds from the already-resolved lockfile and the idempotent Forge
 * self-install.
 */
export async function prepareWrenyardSuite(
  checkoutPath: string,
  deps: SuitePreparationOptions = {},
): Promise<void> {
  const runner = deps.runner ?? defaultRunner
  const commands = buildSuitePreparationCommands(checkoutPath, deps)
  for (const command of commands) {
    let result: SuitePreparationRunResult
    try {
      result = await runner.run(command)
    } catch (error) {
      if (error instanceof SuitePreparationError) throw error
      throw new SuitePreparationError(
        'suite_command_error',
        `suite preparation command '${describeCommand(command)}' failed to start: ${error instanceof Error ? error.message : String(error)}`,
        command.command,
      )
    }
    if (result.signal !== null) {
      throw new SuitePreparationError(
        'suite_command_signal',
        `suite preparation command '${describeCommand(command)}' was terminated by signal ${result.signal}`,
        command.command,
      )
    }
    if (result.status !== 0) {
      throw new SuitePreparationError(
        'suite_command_failed',
        `suite preparation command '${describeCommand(command)}' exited with status ${result.status}`,
        command.command,
      )
    }
  }
}
