import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { readSourceDevLock } from './source-dev-lock.mts'

/**
 * While `pnpm dev` runs, the installed CLI hands every invocation to the source
 * CLI recorded in dev.lock so callers get the CLI that matches the source
 * daemon. Returns the exit code, or undefined when this CLI should run itself.
 * `WRENYARD_INSTALLED_CLI=1` forces the installed CLI when the source CLI is broken.
 */
export function delegateToSourceCli(args: string[], env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env.WRENYARD_INSTALLED_CLI === '1') return undefined
  const cli = readSourceDevLock()?.cli
  if (!cli) return undefined
  const paths = cli.filter((part, index) => index === 0 || isAbsolute(part))
  if (!paths.every((path) => existsSync(path))) return undefined
  const childEnv = { ...env }
  // The source CLI resolves its own suite; inherited installed-suite pointers would misdirect it.
  delete childEnv.WRENYARD_ROOT
  delete childEnv.WRENYARD_NODE_BIN
  const result = spawnSync(cli[0], [...cli.slice(1), ...args], { stdio: 'inherit', env: childEnv, shell: false })
  if (result.error) {
    process.stderr.write(`wrenyard: cannot run the pnpm dev source CLI (${result.error.message}); using the installed CLI.\n`)
    return undefined
  }
  return result.status ?? 1
}
