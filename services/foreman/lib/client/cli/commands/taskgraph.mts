import { parseArgs } from 'node:util'
import type { TaskGraphCreateParams, TaskGraphPatchParams, TaskGraphStatusParams, TaskGraphEventsParams, TaskGraphSignalParams, TaskGraphNodeInspectParams, TaskGraphInspectParams, TaskGraphListParams, TaskGraphWaitParams } from '../../../protocol/registry.mts'
import type { TaskGraphCreateResult, TaskGraphPatchResult, TaskGraphSignalResult, TaskGraphWaitResult, TaskGraphNodeInspectResult } from '../../../protocol/methods/taskgraph.mts'
import { compactInstallPatchOps, compileCompactTaskGraph } from '../../../core/taskgraph/index.mts'
import {
  connectConfiguredForemanClient,
  isHelpRequest,
  servicePayload,
  writeServicePayload,
} from '../shared.mts'

export async function handleTaskgraph(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error('Usage: wrenyard taskgraph <create|patch|status|events|signal|node|inspect|list|wait|run> ...')
    return subcommand ? 0 : 1
  }
  if (subcommand === 'create') return handleTaskgraphCreate(args.slice(1))
  if (subcommand === 'patch') return handleTaskgraphPatch(args.slice(1))
  if (subcommand === 'status') return handleTaskgraphStatus(args.slice(1))
  if (subcommand === 'events') return handleTaskgraphEvents(args.slice(1))
  if (subcommand === 'signal') return handleTaskgraphSignal(args.slice(1))
  if (subcommand === 'node') return handleTaskgraphNode(args.slice(1))
  if (subcommand === 'inspect') return handleTaskgraphInspect(args.slice(1))
  if (subcommand === 'list') return handleTaskgraphList(args.slice(1))
  if (subcommand === 'wait') return handleTaskgraphWait(args.slice(1))
  if (subcommand === 'run') return handleTaskgraphRun(args.slice(1))
  console.error('Usage: wrenyard taskgraph <create|patch|status|events|signal|node|inspect|list|wait|run> ...')
  return 1
}

async function handleTaskgraphNode(args: string[]): Promise<number> {
  const subcommand = args[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.error('Usage: wrenyard taskgraph node inspect <json-params> [--config path]')
    return subcommand ? 0 : 1
  }
  if (subcommand === 'inspect') return handleTaskgraphNodeInspect(args.slice(1))
  console.error('Usage: wrenyard taskgraph node inspect <json-params> [--config path]')
  return 1
}

async function handleTaskgraphCreate(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph create <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = parseTaskgraphObjectParams<TaskGraphCreateParams>(positionals[0])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.create(params)))
    return 0
  } finally {
    client.close()
  }
}

async function handleTaskgraphPatch(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph patch <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = parseTaskgraphObjectParams<TaskGraphPatchParams>(positionals[0])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.patch(params)))
    return 0
  } finally {
    client.close()
  }
}

async function handleTaskgraphStatus(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph status <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = parseTaskgraphObjectParams<TaskGraphStatusParams>(positionals[0])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.status(params)))
    return 0
  } finally {
    client.close()
  }
}

async function handleTaskgraphEvents(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph events <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = parseTaskgraphObjectParams<TaskGraphEventsParams>(positionals[0])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.events(params)))
    return 0
  } finally {
    client.close()
  }
}

async function handleTaskgraphSignal(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph signal <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = parseTaskgraphObjectParams<TaskGraphSignalParams>(positionals[0])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.signal(params)))
    return 0
  } finally {
    client.close()
  }
}

async function handleTaskgraphNodeInspect(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph node inspect <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = parseTaskgraphObjectParams<TaskGraphNodeInspectParams>(positionals[0])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.node.inspect(params)))
    return 0
  } finally {
    client.close()
  }
}

async function handleTaskgraphInspect(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph inspect <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = parseTaskgraphObjectParams<TaskGraphInspectParams>(positionals[0])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.inspect(params)))
    return 0
  } finally {
    client.close()
  }
}

async function handleTaskgraphList(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph list <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length > 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = positionals.length === 1
    ? parseTaskgraphObjectParams<TaskGraphListParams>(positionals[0])
    : {}
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.list(params)))
    return 0
  } finally {
    client.close()
  }
}

async function handleTaskgraphWait(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph wait <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const params = parseTaskgraphObjectParams<TaskGraphWaitParams>(positionals[0])
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await client.taskgraph.wait(params)))
    return 0
  } finally {
    client.close()
  }
}

/**
 * Minimal client surface used by the compact `run` orchestration. The real IPC
 * ForemanClient satisfies it structurally; tests inject a fake.
 */
export interface CompactTaskGraphRunClient {
  taskgraph: {
    create(params: TaskGraphCreateParams): Promise<TaskGraphCreateResult>
    patch(params: TaskGraphPatchParams): Promise<TaskGraphPatchResult>
    signal(params: TaskGraphSignalParams): Promise<TaskGraphSignalResult>
    wait(params: TaskGraphWaitParams): Promise<TaskGraphWaitResult>
    node: {
      inspect(params: TaskGraphNodeInspectParams): Promise<TaskGraphNodeInspectResult>
    }
  }
}

/** One requested step result: node state plus optional run/output/error facts. */
export interface CompactTaskGraphRunNodeResult {
  state: TaskGraphNodeInspectResult['run']['state']
  task_run_id?: string
  output?: unknown
  error?: unknown
}

/** Shell-only orchestration envelope: the existing wait fields plus `results`. */
export interface CompactTaskGraphRunEnvelope {
  [key: string]: unknown
  results: Record<string, CompactTaskGraphRunNodeResult>
}

/**
 * Orchestrate one compact `wrenyard taskgraph run <json-params>` call through
 * existing ForemanClient methods: create `template: default`, patch compiled
 * steps in, signal start_graph with {}, wait, then node-inspect return nodes.
 *
 * Compact input mistakes are surfaced by the compiler before any client call,
 * so no graph is ever created for malformed input. There is no poll loop,
 * second state machine, or extra protocol method here — only existing calls.
 */
export async function runCompactTaskGraph(
  client: CompactTaskGraphRunClient,
  rawJsonParams: string,
): Promise<CompactTaskGraphRunEnvelope> {
  let value: unknown
  try {
    value = JSON.parse(rawJsonParams)
  } catch (error) {
    throw new Error(`Invalid <json-params>: ${error instanceof Error ? error.message : String(error)}`)
  }
  const compiled = compileCompactTaskGraph(value)

  const created = await client.taskgraph.create({
    template: 'default',
    project: compiled.create.project,
    ...(compiled.create.tg_ctx ? { tg_ctx: compiled.create.tg_ctx } : {}),
    ...(compiled.create.title !== undefined ? { title: compiled.create.title } : {}),
    on_node_failure: compiled.create.on_node_failure,
  })
  const taskgraphId = created.taskgraph.id
  const preview = await client.taskgraph.patch({
    taskgraph_id: taskgraphId,
    operation: {
      type: 'request_patch',
      patch: {
        base_revision: created.taskgraph.revision,
        actor: 'taskgraph-run',
        reason: 'install compact steps',
        created_at: new Date().toISOString(),
        ops: compactInstallPatchOps(compiled.create.graph.nodes),
      },
    },
  })
  if (preview.type !== 'preview') {
    throw new Error(`compact task graph patch was not previewed: ${JSON.stringify(preview)}`)
  }
  const applied = await client.taskgraph.patch({
    taskgraph_id: taskgraphId,
    operation: { type: 'confirm_patch', patch_id: preview.patch_id },
  })
  if (applied.type !== 'applied') {
    throw new Error(`compact task graph patch was not applied: ${JSON.stringify(applied)}`)
  }
  await client.taskgraph.signal({ taskgraph_id: taskgraphId, signal: { type: 'start_graph', input: {} } })
  const waitResult = await client.taskgraph.wait({
    taskgraph_id: taskgraphId,
    ...(compiled.timeout_ms !== undefined ? { timeout_ms: compiled.timeout_ms } : {}),
  })

  const results = Object.create(null) as Record<string, CompactTaskGraphRunNodeResult>
  for (const stepId of compiled.return_nodes) {
    const inspected = await client.taskgraph.node.inspect({ taskgraph_id: taskgraphId, node_id: stepId })
    const entry: CompactTaskGraphRunNodeResult = { state: inspected.run.state }
    if (inspected.run.task_run_id !== undefined) entry.task_run_id = inspected.run.task_run_id
    if (inspected.run.error !== undefined) entry.error = inspected.run.error
    if (inspected.output !== undefined) entry.output = inspected.output
    results[stepId] = entry
  }

  return { ...waitResult, results }
}

async function handleTaskgraphRun(args: string[]): Promise<number> {
  const usage = 'wrenyard taskgraph run <json-params> [--config path]'
  if (isHelpRequest(args)) {
    console.log(`Usage: ${usage}`)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length !== 1) {
    console.error(`Usage: ${usage}`)
    return 1
  }
  const client = await connectConfiguredForemanClient(values.config)
  try {
    writeServicePayload(servicePayload(await runCompactTaskGraph(client, positionals[0])))
    return 0
  } finally {
    client.close()
  }
}

function parseTaskgraphObjectParams<T>(raw: string): T {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Invalid <json-params>: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('<json-params> must be a JSON object')
  }
  return value as T
}
