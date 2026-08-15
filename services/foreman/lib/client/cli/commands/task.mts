
import { parseArgs } from 'node:util'
import {
  connectConfiguredForemanClient,
  field,
  isHelpRequest,
  isTaskRunRejectionPayload,
  isTaskRunSuccess,
  parseJsonInput,
  printTaskInputRequiredHint,
  servicePayload,
  taskFinalStatusPayload,
  taskListRows,
  taskRunIdFromPayload,
  waitForTaskCompletionViaIpc,
  writeServicePayload,
  workspaceRootForRuntime,
  errorMessage,
} from '../shared.mts'
import { ensureDiscovered, getLoadErrors, type DuplicateDefinitionLoadError } from '../../../workspace/task-loader.mts'

export async function handleTaskList(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task list [project_id] [--config path] [--json]')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      project: { type: 'string', short: 'p' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length > 1 || (positionals.length === 1 && typeof values.project === 'string')) {
    console.error('Usage: wrenyard task list [project_id] [--config path] [--json]')
    return 1
  }

  const project = positionals[0] ?? (typeof values.project === 'string' ? values.project : undefined)
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const tasks = await client.task.definition.list(project ? { project } : {})
    const payload = servicePayload(project ? { tasks, project } : { tasks })
    if (values.json) {
      writeServicePayload(payload)
      return 0
    }
    const rows = taskListRows(payload.value)
    if (rows.length === 0) {
      console.log('No tasks')
      return 0
    }
    console.log('ID                            Project                       Timeout              Description')
    console.log('-'.repeat(99))
    for (const task of rows) {
      console.log(`${field(task, ['name', 'id']).padEnd(30)}${field(task, ['project']).padEnd(30)}${formatTaskTimeout(task).padEnd(21)}${field(task, ['description'])}`)
    }
    return 0
  } finally {
    client.close()
  }
}

export async function handleTaskDescribe(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task describe <task_id> [--config path] [-p project]')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      project: { type: 'string', short: 'p' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error('Usage: wrenyard task describe <task_id> [--config path] [-p project]')
    return 1
  }

  const project = typeof values.project === 'string' ? values.project : undefined
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.task.definition.describe({
      task_id: positionals[0],
      ...(project ? { project } : {}),
    })))
    return 0
  } finally {
    client.close()
  }
}

export async function handleTaskRun(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task run <task_id> -p <project> [--config path] [--worktree id] <json-input>')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      project: { type: 'string', short: 'p' },
      worktree: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  const taskId = positionals[0]
  const project = typeof values.project === 'string' ? values.project : undefined
  const worktree = typeof values.worktree === 'string' ? values.worktree : undefined
  if (!taskId || !project || positionals.length !== 2) {
    console.error('Usage: wrenyard task run <task_id> -p <project> [--config path] [--worktree id] <json-input>')
    if (taskId && project && positionals.length < 2) await printTaskInputRequiredHint(taskId, project, values.config)
    return 1
  }

  const input = parseJsonInput(positionals[1])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const accepted = servicePayload(await client.task.run.create({
      task_id: taskId,
      project,
      ...(worktree ? { worktree } : {}),
      input,
    }))
    const taskRunId = taskRunIdFromPayload(accepted.value)
    if (!taskRunId) {
      writeServicePayload(accepted)
      return isTaskRunRejectionPayload(accepted.value) ? 1 : 0
    }

    const status = servicePayload(await waitForTaskCompletionViaIpc(client, taskRunId))
    writeServicePayload(taskFinalStatusPayload(taskRunId, status))
    return isTaskRunSuccess(status.value) ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleTaskCancel(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task cancel <task_run_id> [--config path]')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error('Usage: wrenyard task cancel <task_run_id> [--config path]')
    return 1
  }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.task.run.cancel({ task_run_id: positionals[0] })))
  } finally {
    client.close()
  }
  return 0
}

export async function handleTaskStatus(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task status <task_run_id> [--config path]')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error('Usage: wrenyard task status <task_run_id> [--config path]')
    return 1
  }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.task.run.status({ task_run_id: positionals[0] })))
  } finally {
    client.close()
  }
  return 0
}

export async function handleTaskOutput(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task output <task_run_id> [--config path]')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error('Usage: wrenyard task output <task_run_id> [--config path]')
    return 1
  }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.task.run.output({ task_run_id: positionals[0] })))
  } finally {
    client.close()
  }
  return 0
}

export async function handleTaskDoctor(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task doctor [--config path] [--json]')
    return 0
  }

  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })

  const workspaceRoot = workspaceRootForRuntime()
  try {
    await ensureDiscovered(workspaceRoot)
  } catch (error) {
    console.error(`Definitions: failed (${errorMessage(error)})`)
    return 1
  }

  const duplicates = getLoadErrors(workspaceRoot).filter(
    (e): e is DuplicateDefinitionLoadError => e.kind === 'duplicate_definition',
  )

  if (values.json) {
    writeServicePayload(servicePayload({
      duplicate_definitions: duplicates,
      count: duplicates.length,
    }))
    return duplicates.length > 0 ? 1 : 0
  }

  if (duplicates.length === 0) {
    console.log('No duplicate definitions')
    return 0
  }

  console.log(`Duplicate definitions (${duplicates.length}):`)
  for (const duplicate of duplicates) {
    console.log(`  ${duplicate.id} [${duplicate.scope}]: ${duplicate.sourcePath}`)
    console.log(`    ${duplicate.message}`)
  }
  return 1
}

export async function handleTask(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error('Usage: wrenyard task <run|cancel|list|describe|status|output|doctor> ...')
    return subcommand ? 0 : 1
  }
  if (subcommand === 'run') return handleTaskRun(args.slice(1))
  if (subcommand === 'cancel') return handleTaskCancel(args.slice(1))
  if (subcommand === 'list') return handleTaskList(args.slice(1))
  if (subcommand === 'describe') return handleTaskDescribe(args.slice(1))
  if (subcommand === 'status') return handleTaskStatus(args.slice(1))
  if (subcommand === 'output') return handleTaskOutput(args.slice(1))
  if (subcommand === 'doctor') return handleTaskDoctor(args.slice(1))
  console.error('Usage: wrenyard task <run|cancel|list|describe|status|output|doctor> ...')
  return 1
}

function formatTaskTimeout(task: Record<string, unknown>): string {
  const initial = numberField(task.effectiveTimeoutMs)
  const retry = numberField(task.structuredRetryTimeoutMs)
  if (initial === undefined && retry === undefined) return ''
  if (initial !== undefined && retry !== undefined) return `${formatDuration(initial)} / retry ${formatDuration(retry)}`
  if (initial !== undefined) return formatDuration(initial)
  return `retry ${formatDuration(retry ?? 0)}`
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}
