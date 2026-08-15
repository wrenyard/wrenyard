import type {
  ExecutionOptions,
  TaskExecutionResult,
} from '../../types.mts'
import {
  executeTaskInDaemon,
  runTaskOutputInDaemon,
} from './execution-kernel.mts'

export interface TaskRunner {
  execute(name: string, input: unknown, options: ExecutionOptions): Promise<TaskExecutionResult>
  run(name: string, input: unknown, options: ExecutionOptions): Promise<unknown>
}

export class DaemonTaskRunner implements TaskRunner {
  async execute(name: string, input: unknown, options: ExecutionOptions): Promise<TaskExecutionResult> {
    return executeTaskInDaemon(name, input, options)
  }

  async run(name: string, input: unknown, options: ExecutionOptions): Promise<unknown> {
    return runTaskOutputInDaemon(name, input, options)
  }
}
