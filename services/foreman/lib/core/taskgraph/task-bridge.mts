import type { OperationHost } from '../operations/types.mts'
import { TaskService } from '../task/service.mts'
import type {
  JsonObject,
  JsonValue,
  TaskGraphNode,
} from './model.mts'
import type { TaskContext } from '../task/context.mts'

export type TaskGraphTaskTerminalStatus =
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface TaskGraphTaskTerminal {
  status: TaskGraphTaskTerminalStatus
  output?: JsonObject
  error?: string
}

export interface TaskGraphTaskRequest {
  node: TaskGraphNode
  name: string
  project: string
  worktree?: string
  input: JsonValue
  ctx?: TaskContext
}

export interface TaskGraphTaskHandle {
  taskRunId: string
  terminal: Promise<TaskGraphTaskTerminal>
}

export interface TaskGraphTaskBridge {
  start(request: TaskGraphTaskRequest): Promise<TaskGraphTaskHandle>
  reattach(taskRunId: string): TaskGraphTaskHandle
  cancel(taskRunId: string): Promise<void>
}

export interface TaskServiceTaskBridgeOptions {
  workspaceRoot: string
  operations?: OperationHost
  pollIntervalMs?: number
}

export class TaskServiceTaskBridge implements TaskGraphTaskBridge {
  private readonly taskService: TaskService
  private readonly pollIntervalMs: number

  constructor(options: TaskServiceTaskBridgeOptions) {
    this.taskService = new TaskService({
      workspaceRoot: options.workspaceRoot,
      operations: options.operations,
    })
    this.pollIntervalMs = options.pollIntervalMs ?? 100
  }

  async start(request: TaskGraphTaskRequest): Promise<TaskGraphTaskHandle> {
    const response = await this.taskService.run({
      taskId: request.name,
      project: request.project,
      ...(request.worktree ? { worktree: request.worktree } : {}),
      input: request.input,
      ctx: request.ctx,
      allowLegacyTask: true,
    })
    if (!isAcceptedTask(response)) {
      throw new Error(`TaskGraph task dispatch rejected: ${JSON.stringify(response)}`)
    }
    return this.reattach(response.task_run_id)
  }

  reattach(taskRunId: string): TaskGraphTaskHandle {
    return {
      taskRunId,
      terminal: this.waitForTerminal(taskRunId),
    }
  }

  async cancel(taskRunId: string): Promise<void> {
    await this.taskService.cancel(taskRunId)
  }

  private async waitForTerminal(taskRunId: string): Promise<TaskGraphTaskTerminal> {
    for (;;) {
      const status = this.taskService.status(taskRunId)
      if (!status) {
        return { status: 'failed', error: `Task run '${taskRunId}' disappeared` }
      }
      const state = status.status
      if (state === 'done') {
        const result = this.taskService.output(taskRunId)
        const output = normalizeTaskGraphTaskOutput(result?.output)
        if (output === null) {
          return {
            status: 'failed',
            error: `Task run '${taskRunId}' did not produce JSON-compatible output`,
          }
        }
        return { status: 'done', output }
      }
      if (state === 'failed') {
        return {
          status: 'failed',
          error: stringValue(status.error) ?? `Task run '${taskRunId}' failed`,
        }
      }
      if (state === 'cancelled' || state === 'interrupted') {
        return { status: state }
      }
      await delay(this.pollIntervalMs)
    }
  }
}

function isAcceptedTask(value: unknown): value is { task_run_id: string } {
  return isJsonObject(value)
    && typeof value.task_run_id === 'string'
    && value.task_run_id.length > 0
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * TaskGraph node outputs are object-rooted, while Foreman task contracts may
 * legally return any JSON value (for example, the builtin edit task returns an
 * evidence array). Preserve object outputs as-is and wrap every other JSON
 * root under `result` so those tasks remain usable as graph nodes.
 */
export function normalizeTaskGraphTaskOutput(value: unknown): JsonObject | null {
  if (!isJsonValue(value)) return null
  if (isJsonObject(value)) return value
  return { result: value }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isJsonObject(value)) return false
  return Object.values(value).every(isJsonValue)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
