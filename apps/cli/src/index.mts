import {handleQuota} from './commands/quota.mts'
import { hostname } from 'node:os'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleDaemonRun, handleDaemonStop } from './commands/daemon.mts'
import { handleDoctor } from './commands/doctor.mts'
import { handleProject } from './commands/project.mts'
import { handleStatus } from './commands/status.mts'
import { handleTask } from './commands/task.mts'
import { handleExec } from './commands/exec.mts'
import { handleTaskgraph } from './commands/taskgraph.mts'
import { launchTui } from './tui-launcher.mts'
import { resolveCliArgs } from './args.mts'
import { errorMessage, readLocalPackageVersion } from './shared.mts'

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
    if (command === '--version' || command === '-v') {
      console.log(readLocalPackageVersion())
      return 0
    }

    switch (command) {
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
  wrenyard exec <prompt> --target <provider/model:client> [--cwd path] [--resume <session-id>] [--thinking <level>] [--features a,b] [--config path] [--json] [--no-stream]
  wrenyard daemon <run|stop|status> [--config path] [--force] [--json]
  wrenyard -v | --version
  wrenyard status [--config path] [--json]
  wrenyard doctor [--config path] [--json]
  wrenyard project list [--config path] [--json]
  wrenyard project describe <project> [--config path] [--json]
  wrenyard project status <project> [--config path] [--json]
  wrenyard project pull <project> [--config path] [--json]
  wrenyard project push <project> [--config path] [--json]
  wrenyard project worktree list <project> [--config path] [--json]
  wrenyard project worktree create <project> <worktree_id> [--config path] [--json]
  wrenyard project worktree remove <worktree_id> [--config path] [--json]
  wrenyard project worktree merge <project> <worktree_id> [--config path] [--json]
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

export function isCliEntrypoint(entry = process.argv[1]): boolean {
  if (!entry) return false
  return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
}

export async function runCliEntrypoint(): Promise<void> {
  const command = resolveCliArgs()[0]
  const code = await runForemanCli()
  if (command === 'daemon' && code === 0) return
  process.exit(code)
}

// Run only when this module is the CLI entrypoint; importing it is inert. The
// product CLI (`src/index.ts`) spawns this file for the internal commands.
if (isCliEntrypoint()) {
  runCliEntrypoint().catch((error) => {
    console.error(errorMessage(error))
    process.exit(1)
  })
}
