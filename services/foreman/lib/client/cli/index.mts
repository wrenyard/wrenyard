import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleDaemonDispatchStatus, handleDaemonDrain, handleDaemonFreeze, handleDaemonRestart, handleDaemonStart, handleDaemonStop, handleDaemonThaw } from './commands/daemon.mts'
import { handleDoctor } from './commands/doctor.mts'
import { handleMessage } from './commands/message.mts'
import { handlePet } from './commands/pet.mts'
import { handlePm } from './commands/pm.mts'
import { handleProject } from './commands/project.mts'
import { handleStatus } from './commands/status.mts'
import { handleUpdate } from './commands/update.mts'
import { handleTask } from './commands/task.mts'
import { handleTaskgraph } from './commands/taskgraph.mts'
import { handleFwa } from './commands/fwa.mts'
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
      case 'daemon':
      case 'deamon':
        if (!subcommand || subcommand === '--help' || subcommand === '-h') {
          console.error('Usage: wrenyard daemon <start|stop|restart|status|freeze|thaw|drain|dispatch-status> [--config path] [--host addr] [--port n] [--no-wait] [--json]')
          return subcommand ? 0 : 1
        }
        if (subcommand === 'start') return handleDaemonStart(args.slice(2))
        if (subcommand === 'stop') return handleDaemonStop(args.slice(2))
        if (subcommand === 'restart') return handleDaemonRestart(args.slice(2))
        if (subcommand === 'status') return handleStatus(args.slice(2))
        if (subcommand === 'freeze') return handleDaemonFreeze(args.slice(2))
        if (subcommand === 'thaw') return handleDaemonThaw(args.slice(2))
        if (subcommand === 'drain') return handleDaemonDrain(args.slice(2))
        if (subcommand === 'dispatch-status') return handleDaemonDispatchStatus(args.slice(2))
        console.error('Usage: wrenyard daemon <start|stop|restart|status|freeze|thaw|drain|dispatch-status> [--config path] [--host addr] [--port n] [--no-wait] [--json]')
        return 1
      case 'task':
        return handleTask(args.slice(1))
      case 'project':
        return handleProject(args.slice(1))
      case 'status':
        return handleStatus(args.slice(1))
      case 'update':
        return handleUpdate(args.slice(1))
      case 'doctor':
        return await handleDoctor(args.slice(1))
      case 'message':
        return handleMessage(args.slice(1))
      case 'pet':
        return handlePet(args.slice(1))
      case 'pm':
        return handlePm(args.slice(1))
      case 'taskgraph':
        return handleTaskgraph(args.slice(1))
      case 'fwa':
        return handleFwa(args.slice(1))
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

export function printUsage(): void {
  console.log(`Wrenyard v2 - TypeScript task and TaskGraph runtime

Usage:
  wrenyard task run <task_id> -p <project> [--config path] [--worktree id] <json-input>
  wrenyard task cancel <task_run_id> [--config path]
  wrenyard task list [project_id] [--config path] [--json]
  wrenyard task describe <task_id> [--config path] [-p project]
  wrenyard task status <task_run_id> [--config path]
  wrenyard task output <task_run_id> [--config path]
  wrenyard task doctor [--config path] [--json]
  wrenyard daemon <start|stop|restart|status|freeze|thaw|drain|dispatch-status> [--config path] [--host 0.0.0.0] [--port 8787] [--no-wait] [--json]
  wrenyard -v | --version
  wrenyard pet <enable|disable|restart> [--config path] [--json]
  wrenyard status [--config path] [--json]
  wrenyard update [--config path] [--no-wait] [--json]
  wrenyard doctor [--config path]
  wrenyard project list [--config path]
  wrenyard project describe <project> [--config path]
  wrenyard project status <project> [--config path]
  wrenyard project pull <project> [--config path]
  wrenyard project push <project> [--config path]
  wrenyard project worktree list <project> [--config path]
  wrenyard project worktree create <project> <worktree_id> [--config path]
  wrenyard project worktree remove <worktree_id> [--config path]
  wrenyard project worktree merge <project> <worktree_id> [--config path]
  wrenyard pm ticket create --kind <main|sub> -p <project> --title <title> [--description text] [--parent id] [--assignee session] [--config path]
  wrenyard pm ticket get <ticket_id> [--config path]
  wrenyard pm ticket list -p <project> [--kind main|sub] [--status todo|in_progress|done|blocked] [--parent id] [--assignee session] [--config path]
  wrenyard pm ticket update <ticket_id> [--title text] [--description text|--clear-description] [--assignee session|--clear-assignee] [--config path]
  wrenyard pm ticket status <ticket_id> <todo|in_progress|done|blocked> [--config path]
  wrenyard pm ticket delete <ticket_id> [--config path]
  wrenyard pm ticket delete <ticket_id> [--config path]
  wrenyard message send -m "<message>" --sender <role-id> --to <role-id> [--config path]
  wrenyard taskgraph create <json-params> [--config path]
  wrenyard taskgraph patch <json-params> [--config path]
  wrenyard taskgraph status <json-params> [--config path]
  wrenyard taskgraph events <json-params> [--config path]
  wrenyard taskgraph signal <json-params> [--config path]
  wrenyard taskgraph signal <json-params> [--config path]
  wrenyard taskgraph inspect <json-params> [--config path]
  wrenyard taskgraph node inspect <json-params> [--config path]
  wrenyard taskgraph list <json-params> [--config path]
  wrenyard taskgraph wait <json-params> [--config path]
  wrenyard fwa assign <ticket_id> <project_id> <prompt> [--config path] [--json]
  wrenyard fwa list [--config path] [--json]
  wrenyard fwa status <session_id> [--config path] [--json]
  wrenyard fwa transcript <session_id> [--config path] [--json]

Notes:
  task run waits for the task to reach a terminal lifecycle state by default.
  Use wrenyard task output <task_run_id> to fetch the task result content.
All endpoints on a single port when the daemon is running:
  http://<host>:<port>/mcp           - Unified orchestration + message MCP
  http://<host>:<port>/health        - Health check
  http://<host>:<port>/tasks/:id     - Task status
Host: ${hostname()}`)
}

export function isCliEntrypoint(entry = process.argv[1]): boolean {
  if (!entry) return false
  const resolvedEntry = resolve(entry)
  return resolvedEntry.endsWith('/bin/foreman')
    || resolvedEntry.endsWith('/bin/foreman.mts')
    || resolvedEntry.endsWith('\\bin\\foreman')
    || resolvedEntry.endsWith('\\bin\\foreman.mts')
    || resolvedEntry === fileURLToPath(import.meta.url)
}

export async function runCliEntrypoint(): Promise<void> {
  const command = resolveCliArgs()[0]
  const code = await runForemanCli()
  if (command === 'daemon' && code === 0) return
  process.exit(code)
}
