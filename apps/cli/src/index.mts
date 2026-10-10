import {handleQuota} from './commands/quota.mts'
import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledSuiteRoot, runningFromBundle } from '@wrenyard/daemon/layout/suite-root'
import suitePackage from '../../../package.json' with { type: 'json' }
import componentVersions from '../../../contracts/versions.json' with { type: 'json' }
import { handleDaemonRun, handleDaemonStop } from './commands/daemon.mts'
import { handleDoctor } from './commands/doctor.mts'
import { handleProject } from './commands/project.mts'
import { handleWorkspace } from './commands/workspace.mts'
import { handleStatus } from './commands/status.mts'
import { handleTask } from './commands/task.mts'
import { handleExec } from './commands/exec.mts'
import { handleTaskgraph } from './commands/taskgraph.mts'
import { launchTui } from './tui-launcher.mts'
import { resolveCliArgs } from './args.mts'
import { errorMessage } from './shared.mts'

export { parsePowerShellForemanArgs, resolveCliArgs } from './args.mts'
export { resolveRepoDir, resolveWorkDir } from './shared.mts'

export async function runForemanCli(argv = process.argv.slice(2), tuiLauncher: () => number = launchTui): Promise<number> {
  const args = resolveCliArgs(argv)
  const command = args[0]
  const subcommand = args[1]

  try {
    if (command === '--help' || command === '-h' || command === 'help') {
      printUsage()
      return 0
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      console.log(versionText())
      return 0
    }

    switch (command) {
      case 'desktop':
        return launchDesktop(args.slice(1))
      case 'quota':
        return handleQuota(args.slice(1))
      case 'daemon':
        if (!subcommand || subcommand === '--help' || subcommand === '-h') {
          console.error(DAEMON_USAGE)
          return subcommand ? 0 : 1
        }
        if (subcommand === 'run') {
          // `daemon run` owns the foreground process and streams lifecycle logs,
          // so it has no JSON result. Accept --json by explaining the stream
          // instead of forwarding it to the strict foreground parser.
          const runArgs = args.slice(2)
          if (runArgs.includes('--json')) {
            console.error('wrenyard daemon run is a foreground log stream; --json does not apply. Lifecycle readiness is reported on stderr and the daemon log.')
          }
          return handleDaemonRun(runArgs.filter((arg) => arg !== '--json'))
        }
        if (subcommand === 'stop') return handleDaemonStop(args.slice(2))
        if (subcommand === 'status') return handleStatus(args.slice(2))
        console.error(DAEMON_USAGE)
        return 1
      case 'task':
        return handleTask(args.slice(1))
      case 'exec':
        return handleExec(args.slice(1))
      case 'project':
        return handleProject(args.slice(1))
      case 'workspace':
        return handleWorkspace(args.slice(1))
      case 'status':
        return handleStatus(args.slice(1))
      case 'doctor':
        return await handleDoctor(args.slice(1))
      case 'taskgraph':
        return handleTaskgraph(args.slice(1))
      default:
        if (args.length === 0) return tuiLauncher()
        printUsage()
        return 1
    }
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }
}

const DAEMON_USAGE = `Usage: wrenyard daemon <run|stop|status>
  run     [--config path] [--work-dir path]   (foreground log stream; --json does not apply)
  stop    [--config path] [--force] [--json]
  status  [--config path] [--json]`

export function printUsage(): void {
  console.log(`Wrenyard v2 - TypeScript task and TaskGraph runtime

Usage:
  wrenyard quota [provider] [--json] [--refresh]
  wrenyard task run <task_id> -p <project> [--config path] [--worktree id] [--json] <json-input>
  wrenyard task cancel <task_run_id> [--config path] [--json]
  wrenyard task list [project_id] [--config path] [--json]
  wrenyard task describe <task_id> [--config path] [-p project] [--json]
  wrenyard task status <task_run_id> [--config path] [--json]
  wrenyard task output <task_run_id> [--config path] [--json]
  wrenyard task runtimes <task_id> [-p project] [--config path] [--json]
  wrenyard task doctor [--config path] [--json]
  wrenyard exec <prompt> --target <provider/model:client> --reasoning-effort <level> [--cwd path] [--resume <session-id>] [--features a,b] [--config path] [--json] [--no-stream]
  wrenyard daemon <run|stop|status> [--config path] [--force] [--json]
  wrenyard -v | --version
  wrenyard desktop
  wrenyard status [--config path] [--json]
  wrenyard doctor [--config path] [--json]
  wrenyard project list [--config path] [--json]
  wrenyard project describe <project> [--config path] [--json]
  wrenyard project status <project> [--config path] [--json]
  wrenyard project pull <project> [--config path] [--json]
  wrenyard project push <project> [--config path] [--json]
  wrenyard project diff <project> [--worktree id] [--staged] [--path p]... [--config path] [--json]
  wrenyard project commit <project> [--worktree id] -m <message> <file>... [--config path] [--json]
  wrenyard project worktree list <project> [--config path] [--json]
  wrenyard project worktree create <project> <worktree_id> [--config path] [--json]
  wrenyard project worktree remove <worktree_id> [--config path] [--json]
  wrenyard project worktree merge <project> <worktree_id> [--config path] [--json]
  wrenyard workspace status [--config path] [--json]
  wrenyard workspace diff [--staged] [--path p]... [--config path] [--json]
  wrenyard workspace commit -m <message> <file>... [--config path] [--json]
  wrenyard workspace push [--config path] [--json]
  wrenyard workspace pull [--config path] [--json]
  wrenyard workspace doc list <project> [--kind <kind>] [--config path] [--json]
  wrenyard workspace doc read <project> <kind> <name> [--config path] [--json]
  wrenyard workspace doc create <project> <kind> <slug> --file <f> [--config path] [--json]
  wrenyard workspace doc update <project> <kind> <name> --file <f> --base <version> [--config path] [--json]
  wrenyard workspace doc edit <project> <kind> <name> --old <text> --new <text> [--base <version>] [--config path] [--json]
  wrenyard workspace doc delete <project> <kind> <name> --base <version> [--config path] [--json]
  wrenyard taskgraph create <json-params> [--config path] [--json]
  wrenyard taskgraph patch <json-params> [--config path] [--json]
  wrenyard taskgraph status <json-params> [--config path] [--json]
  wrenyard taskgraph events <json-params> [--config path] [--json]
  wrenyard taskgraph signal <json-params> [--config path] [--json]
  wrenyard taskgraph inspect <json-params> [--config path] [--json]
  wrenyard taskgraph node inspect <json-params> [--config path] [--json]
  wrenyard taskgraph list <json-params> [--config path] [--json]
  wrenyard taskgraph wait <json-params> [--config path] [--json]
Notes:
  task run waits for the task to reach a terminal lifecycle state by default.
  Use wrenyard task output <task_run_id> to fetch the task result content.
  Every business command accepts --json; those that already emit JSON keep the
  same result shape.
The daemon is owner-managed: run it in the foreground with 'wrenyard daemon run'.
Host: ${hostname()}`)
}

/** Suite version and component versions, embedded at build time. */
export function versionText(): string {
  return [`wrenyard ${suitePackage.version}`, ...Object.entries(componentVersions).map(([name, value]) => `${name}: ${String(value)}`)].join('\n')
}

/** The installed Desktop owning this suite (`<app>/resources/wrenyard`); source runs use `pnpm dev`. */
function launchDesktop(args: string[]): number {
  if (!runningFromBundle) {
    console.error('From source, run the Desktop with `pnpm dev` in the Wrenyard checkout.')
    return 1
  }
  const executable = process.platform === 'win32'
    ? join(bundledSuiteRoot, '..', '..', 'wrenyard-desktop.exe')
    : join(bundledSuiteRoot, '..', '..', 'MacOS', '啾啾工坊')
  if (!existsSync(executable)) {
    console.error(`Unable to locate the Desktop application at ${executable}.`)
    return 1
  }
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return 0
}

export function isCliEntrypoint(entry = process.argv[1]): boolean {
  if (runningFromBundle) return true
  if (!entry) return false
  return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
}

export async function runCliEntrypoint(): Promise<void> {
  const command = resolveCliArgs()[0]
  const code = await runForemanCli()
  if (command === 'daemon' && code === 0) return
  process.exit(code)
}

// Run only when this module is the CLI entrypoint (or the SEA bundle); importing it is inert.
if (isCliEntrypoint()) {
  runCliEntrypoint().catch((error) => {
    console.error(errorMessage(error))
    process.exit(1)
  })
}
