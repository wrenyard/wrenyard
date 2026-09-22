import type { TaskWorkflowRunHost } from '../types.mts'

let taskWorkflowRunHost: TaskWorkflowRunHost | undefined

export function setTaskWorkflowRunHost(host: TaskWorkflowRunHost | undefined): void {
  taskWorkflowRunHost = host
}

export function getTaskWorkflowRunHost(): TaskWorkflowRunHost {
  if (!taskWorkflowRunHost) {
    throw new Error(
      'TaskWorkflowRunHost has not been injected. Call setTaskWorkflowRunHost(host) during Foreman service bootstrap before starting task runs.',
    )
  }
  return taskWorkflowRunHost
}

export function setTaskWorkflowRunner(host: TaskWorkflowRunHost | undefined): void {
  setTaskWorkflowRunHost(host)
}

export function getTaskWorkflowRunner(): TaskWorkflowRunHost {
  return getTaskWorkflowRunHost()
}
