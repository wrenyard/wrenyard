import { join } from 'node:path'

export interface PackagedDaemonLaunch {
  command: string
  args: string[]
  cwd: string
}

/**
 * The one way an installed suite starts its daemon: the bundled Node runs the
 * daemon bundle in the foreground. Shared by the packaged Desktop and CLI.
 */
export function packagedDaemonLaunch(suiteRoot: string, configPath: string): PackagedDaemonLaunch {
  const node = join(suiteRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  return {
    command: node,
    args: [join(suiteRoot, 'daemon', 'daemon.mjs'), 'run', '--config', configPath],
    cwd: suiteRoot,
  }
}
