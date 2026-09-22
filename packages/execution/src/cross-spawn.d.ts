declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process'

  export default function spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess
}
