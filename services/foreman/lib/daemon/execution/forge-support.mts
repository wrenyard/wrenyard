import { resolveForgeEnv } from '../../adapters/forge/exec.mts'
import { killProcessTree } from '../../adapters/shell/process.mts'

export function resolveDaemonForgeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return resolveForgeEnv(env)
}

export function killDaemonProcessTree(pid: number, pgid?: number): Promise<void> {
  return killProcessTree(pid, pgid)
}
