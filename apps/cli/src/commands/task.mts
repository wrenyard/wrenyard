
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
  taskListRows,
  taskRunIdFromPayload,
  writeServicePayload,
  writeText,
  workspaceRootForRuntime,
  errorMessage,
} from '../shared.mts'
import type {
  TaskRunCompileResult,
  TaskSettingsLayer,
} from '@wrenyard/daemon/protocol/methods/task'
import { ensureDiscovered, getLoadErrors, type DuplicateDefinitionLoadError } from '@wrenyard/daemon/workspace/task-loader'

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
      console.log(`${taskListEffectiveId(task).padEnd(30)}${field(task, ['project']).padEnd(30)}${formatTaskTimeout(task).padEnd(21)}${field(task, ['description'])}`)
    }
    return 0
  } finally {
    client.close()
  }
}

export async function handleTaskDescribe(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task describe <task_id> [--config path] [-p project] [--json]')
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
  if (positionals.length !== 1) {
    console.error('Usage: wrenyard task describe <task_id> [--config path] [-p project] [--json]')
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

const TASK_RUN_USAGE = 'Usage: wrenyard task run <task_id> -p <project> [--config path] [--worktree id] [--fast | --no-fast] [--settings-json json] [--json | --structured] <json-input>'

const TASK_RUN_FLAGS_HELP = [
  'Output flags:',
  '  (none)         the run report followed by the facts the daemon collected',
  '  --json         the report and the facts as one {report, facts} object',
  '  --structured   run the compile step and print the schema-valid output, or',
  '                 the compile error together with the report and the facts',
].join('\n')

export async function handleTaskRun(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log(TASK_RUN_USAGE)
    console.log(TASK_RUN_FLAGS_HELP)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      project: { type: 'string', short: 'p' },
      worktree: { type: 'string' },
      fast: { type: 'boolean' },
      'no-fast': { type: 'boolean' },
      'settings-json': { type: 'string' },
      json: { type: 'boolean' },
      structured: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const taskId = positionals[0]
  const project = typeof values.project === 'string' ? values.project : undefined
  const worktree = typeof values.worktree === 'string' ? values.worktree : undefined
  if (!taskId || !project || positionals.length !== 2) {
    console.error(TASK_RUN_USAGE)
    if (taskId && project && positionals.length < 2) await printTaskInputRequiredHint(taskId, project, values.config)
    return 1
  }

  if (values.fast === true && values['no-fast'] === true) {
    console.error('--fast and --no-fast cannot be used together')
    return 1
  }
  const outputMode = taskOutputMode(values.json === true, values.structured === true)
  if (outputMode === 'rejected') {
    console.error('--json and --structured cannot be used together')
    return 1
  }
  const fast = values.fast === true ? true : values['no-fast'] === true ? false : undefined

  const input = parseJsonInput(positionals[1])
  const invocationSettings = withFastSelection(parseOptionalInvocationSettings(values['settings-json']), fast)
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const accepted = servicePayload(await client.task.run.create({
      task_id: taskId,
      project,
      ...(worktree ? { worktree } : {}),
      input,
      ...(invocationSettings === undefined ? {} : { invocation_settings: invocationSettings }),
    }))
    const taskRunId = taskRunIdFromPayload(accepted.value)
    if (!taskRunId) {
      writeServicePayload(accepted)
      return isTaskRunRejectionPayload(accepted.value) ? 1 : 0
    }

    const result = servicePayload(await client.task.run.wait({ task_run_id: taskRunId }))
    const succeeded = isTaskRunSuccess(result.value)
    if (outputMode === 'structured') {
      const compiled = await client.task.run.compile({ task_run_id: taskRunId })
      writeTaskRunCompile(compiled)
      return succeeded && compiled.ok ? 0 : 1
    }
    writeTaskRunResult(result.value, outputMode)
    return succeeded ? 0 : 1
  } finally {
    client.close()
  }
}

export async function handleTaskCancel(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log('Usage: wrenyard task cancel <task_run_id> [--config path] [--json]')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error('Usage: wrenyard task cancel <task_run_id> [--config path] [--json]')
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
    console.log('Usage: wrenyard task status <task_run_id> [--config path] [--json]')
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error('Usage: wrenyard task status <task_run_id> [--config path] [--json]')
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

const TASK_OUTPUT_USAGE = 'Usage: wrenyard task output <task_run_id> [--config path] [--json | --structured]'

export async function handleTaskOutput(args: string[]): Promise<number> {
  if (isHelpRequest(args)) {
    console.log(TASK_OUTPUT_USAGE)
    console.log(TASK_RUN_FLAGS_HELP)
    return 0
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      structured: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(TASK_OUTPUT_USAGE)
    return 1
  }
  const outputMode = taskOutputMode(values.json === true, values.structured === true)
  if (outputMode === 'rejected') {
    console.error('--json and --structured cannot be used together')
    return 1
  }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    const taskRunId = positionals[0]
    if (outputMode === 'structured') {
      const compiled = await client.task.run.compile({ task_run_id: taskRunId })
      writeTaskRunCompile(compiled)
      return compiled.ok ? 0 : 1
    }
    writeTaskRunResult(await client.task.run.output({ task_run_id: taskRunId }), outputMode)
  } finally {
    client.close()
  }
  return 0
}

/**
 * How one finished run is printed. `text` is the default: the run's report
 * followed by the facts the daemon collected, as plain text. `json` prints the
 * same two values as one `{report, facts}` object. `structured` runs the
 * task-output compile step and prints the schema-valid output it produced, or,
 * when the compile failed, the compile error together with the report and the
 * facts.
 */
type TaskOutputMode = 'text' | 'json' | 'structured'

/** Rejects the mutually exclusive flag combination before any daemon call. */
function taskOutputMode(json: boolean, structured: boolean): TaskOutputMode | 'rejected' {
  if (json && structured) return 'rejected'
  if (structured) return 'structured'
  if (json) return 'json'
  return 'text'
}

function writeTaskRunResult(value: unknown, mode: Exclude<TaskOutputMode, 'structured'>): void {
  const report = taskRunReport(value)
  const facts = taskRunFacts(value)
  if (mode === 'json') {
    writeServicePayload(servicePayload({ report, facts: facts ?? null }))
    return
  }
  writeText(renderTaskRunResult(report, facts))
}

/**
 * The run's own report: a plain output string, the `report` the run recorded
 * next to a failed compile, or, when a run recorded only a compiled value, the
 * summary (the report's first line). Nothing is rephrased or invented.
 */
function taskRunReport(value: unknown): string {
  const record = asRecord(value)
  if (!record) return ''
  const output = record['output']
  if (typeof output === 'string') return output
  const outputRecord = asRecord(output)
  const report = outputRecord === undefined ? '' : field(outputRecord, ['report'])
  if (report) return report
  return typeof record['summary'] === 'string' ? record['summary'] : ''
}

/** The facts of the run, from the run record or from a recorded compile result. */
function taskRunFacts(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const facts = asRecord(record['facts'])
  if (facts) return facts
  const output = asRecord(record['output'])
  return output === undefined ? undefined : asRecord(output['facts'])
}

/**
 * The result of the task-output compile step: the schema-valid output, or, when
 * the compile failed, the compile error together with the report and the facts
 * it could not compile.
 */
function writeTaskRunCompile(compiled: TaskRunCompileResult): void {
  if (compiled.ok) {
    writeServicePayload(servicePayload(compiled.output ?? null))
    return
  }
  writeServicePayload(servicePayload({
    compileError: compiled.compile_error ?? '',
    report: compiled.report,
    facts: compiled.facts ?? null,
  }))
}

/** One run's report followed by its facts, as plain text. */
function renderTaskRunResult(report: string, facts?: Record<string, unknown>): string {
  const rendered = facts === undefined ? '' : renderRunFacts(facts)
  if (rendered === '') return report
  return report.trim() === '' ? rendered : `${report}\n\n${rendered}`
}

/** The facts of one run as a flat bullet list; absent facts are omitted. */
function renderRunFacts(facts: Record<string, unknown>): string {
  const lines: string[] = [`- status: ${field(facts, ['status'])}`]
  const failure = field(facts, ['failure_category'])
  if (failure) lines.push(`- failure: ${failure}`)
  const duration = numberField(facts['duration_ms'])
  if (duration !== undefined) lines.push(`- duration: ${duration} ms`)
  lines.push(`- timed out: ${facts['timed_out'] === true ? 'yes' : 'no'}`)
  const worktree = field(facts, ['worktree_id'])
  const checkout = field(facts, ['checkout_path'])
  if (worktree) lines.push(`- worktree: ${worktree}`)
  else if (checkout) lines.push(`- checkout: ${checkout}`)
  writeFactList(lines, 'changed files', stringList(facts['changed_files']))
  writeFactList(lines, 'commits', commitList(facts['commits']))
  writeFactList(lines, 'artifact files', artifactList(facts['artifact_files']))
  return lines.join('\n')
}

function writeFactList(lines: string[], label: string, entries: string[]): void {
  if (entries.length === 0) return
  lines.push(`- ${label}:`)
  for (const entry of entries) lines.push(`  - ${entry}`)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function commitList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const commit = asRecord(entry)
    if (!commit) return []
    return [`${field(commit, ['sha'])} ${field(commit, ['subject'])}`.trim()]
  })
}

function artifactList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const file = asRecord(entry)
    if (!file) return []
    const path = field(file, ['path'])
    const bytes = numberField(file['bytes'])
    return [bytes === undefined ? path : `${path} (${bytes} bytes)`]
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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

/**
 * Effective id rendered in the human task list. The service row keeps the
 * authoritative id and project/source; a definition that carries an inheritance
 * chain gets a readable English marker instead of a rewritten id.
 */
export function taskListEffectiveId(task: Record<string, unknown>): string {
  const id = field(task, ['name', 'id'])
  return Array.isArray(task.inheritanceChain) ? `${id} (inherited)` : id
}

function formatTaskTimeout(task: Record<string, unknown>): string {
  const initial = numberField(task.effectiveTimeoutMs)
  if (initial === undefined) return ''
  return formatDuration(initial)
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

/**
 * Parse an optional --settings-json value into the canonical TaskSettingsLayer
 * shape (the same public object as task.run.create.invocation_settings).
 * JSON syntax errors and non-object values (null/array/scalar) fail up front,
 * before any task is created, using the CLI's existing JSON input error style.
 * Omission returns undefined so the create request keeps its exact shape.
 */
function parseOptionalInvocationSettings(raw: string | undefined): TaskSettingsLayer | undefined {
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Invalid --settings-json: ${errorMessage(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--settings-json must be a JSON object')
  }
  return value as TaskSettingsLayer
}

/**
 * Merge an explicit --fast/--no-fast selection into the invocation settings
 * automatic layer. `undefined` leaves the parsed settings untouched; an
 * explicit false is preserved so it reaches the resolver as an off value.
 */
function withFastSelection(
  settings: TaskSettingsLayer | undefined,
  fast: boolean | undefined,
): TaskSettingsLayer | undefined {
  if (fast === undefined) return settings
  return {
    ...(settings ?? {}),
    automatic: { ...(settings?.automatic ?? {}), fast },
  }
}
