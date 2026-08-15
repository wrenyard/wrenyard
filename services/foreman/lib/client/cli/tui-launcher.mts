import { errorMessage } from './shared.mts'
import { spawnSync } from 'node:child_process'

export interface SpawnSyncResult {
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error | null
}

export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: import('node:child_process').SpawnSyncOptions,
) => SpawnSyncResult

export function defaultSpawnSync(
  command: string,
  args: readonly string[],
  options: import('node:child_process').SpawnSyncOptions,
): SpawnSyncResult {
  const result = spawnSync(command, [...args], options)
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
  }
}

export function launchTui(spawn: SpawnSyncFn = defaultSpawnSync): number {
  let result: SpawnSyncResult
  try {
    result = spawn('foreman-tui', [], {
      shell: false,
      stdio: 'inherit',
    })
  } catch (error) {
    console.error(`Failed to launch foreman-tui: ${errorMessage(error)}`)
    return 1
  }

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('foreman-tui was not found on PATH. Install the TUI package to continue.')
    } else {
      console.error(`Failed to launch foreman-tui: ${result.error.message}`)
    }
    return 1
  }

  if (result.signal) {
    console.error(`foreman-tui exited due to signal ${result.signal}`)
    return 1
  }

  return result.status ?? 1
}
