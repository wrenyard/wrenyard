/**
 * LangChain tool wrappers over in-process ports for every locked capability.
 * Enforces the session project subtree guard on every project-bearing
 * execution target. Guards workspace paths against absolute paths,
 * traversal, symlink escape, recursive/mass delete; only allows delete
 * of documents recorded as created by this session.
 *
 * All project guards use canonical-root realpath checks at the actual
 * operation boundary — not lexical-only containment.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { isAbsolute, normalize, sep } from 'node:path'
import type { TaskGraphPort, TaskServicePort, MessagePort, WorkspaceDocPort, ToolRefCallback } from './types.mts'
import { TASK_GRAPH_TEMPLATE_IDS } from '../taskgraph/templates.mts'

export interface ToolPorts {
  taskgraph: TaskGraphPort
  task: TaskServicePort
  message: MessagePort
  workspace: WorkspaceDocPort
  sessionProject: string
  sessionId: string
  workspaceRoot: string
  /** Optional per-runtime async callback to persist graph/task refs. */
  onRefs?: ToolRefCallback
}

// -- Schema helpers --

const projectSchema = z.string().min(1).describe('The project id within the session workspace')
const nonEmptyString = z.string().min(1)

// -- Strict project-id validation (not filesystem path) --

/**
 * Validate a project ID against the locked session project rule:
 * reject absolute IDs, backslashes, empty/dot/parent segments,
 * then require candidate === sessionProject or candidate.startsWith(sessionProject + '/').
 */
function guardProjectId(candidate: string, sessionProject: string): void {
  if (candidate.length === 0) {
    throw new Error('Project ID must not be empty')
  }
  if (candidate.includes('\\')) {
    throw new Error(`Project ID must not contain backslashes: ${candidate}`)
  }
  if (isAbsolute(candidate)) {
    throw new Error(`Project ID must be relative, got absolute: ${candidate}`)
  }
  // Inspect raw slash-separated segments before any normalize call.
  // This catches proj-a/../proj-b before normalize would resolve it away.
  const segments = candidate.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`Project ID must not contain empty, '.' or '..' segments: ${candidate}`)
    }
  }
  // Require project-scope containment
  if (candidate !== sessionProject && !candidate.startsWith(sessionProject + '/')) {
    throw new Error(`Project '${candidate}' is outside session project scope '${sessionProject}'`)
  }
}

// -- TaskGraph tools --

export function createTaskGraphCreateTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'taskgraph_create',
    description: 'Create a new TaskGraph from a named template. Use taskgraph_patch to add or replace nodes.',
    schema: z.object({
      template: z.enum(TASK_GRAPH_TEMPLATE_IDS).describe('Create-time topology template'),
      title: z.string().min(1).max(120).optional(),
      on_node_failure: z.enum(['pause', 'cancel']).optional(),
      tg_ctx: z.record(z.string(), z.unknown()).optional(),
    }),
    func: async (input) => {
      // Inject authoritative session project binding regardless of model input
      const injected = {
        ...input,
        project: ports.sessionProject,
      }
      const result = await ports.taskgraph.create(injected)
      if (result.taskgraph?.id) {
        await ports.onRefs?.([result.taskgraph.id], [])
      }
      return JSON.stringify(result)
    },
  })
}

export function createTaskGraphSignalTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'taskgraph_signal',
    description: 'Send a signal (start, pause, resume, cancel) to a TaskGraph.',
    schema: z.object({
      taskgraph_id: nonEmptyString,
      signal: z.record(z.string(), z.unknown()),
    }),
    func: async (input) => {
      const result = await ports.taskgraph.signal(input)
      return JSON.stringify(result)
    },
  })
}

export function createTaskGraphPatchTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'taskgraph_patch',
    description: 'Apply a patch operation to a TaskGraph.',
    schema: z.object({
      taskgraph_id: nonEmptyString,
      operation: z.record(z.string(), z.unknown()),
    }),
    func: async (input) => {
      const result = await ports.taskgraph.patch(input)
      return JSON.stringify(result)
    },
  })
}

export function createTaskGraphStatusTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'taskgraph_status',
    description: 'Get the current status of a TaskGraph.',
    schema: z.object({
      taskgraph_id: nonEmptyString,
    }),
    func: async (input) => {
      const result = await ports.taskgraph.status(input)
      return JSON.stringify(result)
    },
  })
}

export function createTaskGraphEventsTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'taskgraph_events',
    description: 'Get events for a TaskGraph.',
    schema: z.object({
      taskgraph_id: nonEmptyString,
      after_seq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    }),
    func: async (input) => {
      const result = await ports.taskgraph.events(input)
      return JSON.stringify(result)
    },
  })
}

export function createTaskGraphNodeInspectTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'taskgraph_node_inspect',
    description: 'Inspect a node within a TaskGraph.',
    schema: z.object({
      taskgraph_id: nonEmptyString,
      node_id: nonEmptyString,
    }),
    func: async (input) => {
      const result = await ports.taskgraph.inspect(input)
      return JSON.stringify(result)
    },
  })
}

// -- Task tools (project-scope guarded) --

export function createTaskDescribeTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'task_describe',
    description: 'Describe a task definition. The project must be within the session workspace.',
    schema: z.object({
      task_id: nonEmptyString,
      project: projectSchema.optional(),
    }),
    func: async (input) => {
      const project = input.project ?? ports.sessionProject
      guardProjectId(project, ports.sessionProject)
      const result = await ports.task.describe({ task_id: input.task_id, project })
      return JSON.stringify(result)
    },
  })
}

export function createTaskRunTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'task_run',
    description: 'Run a task. The project must be within the session workspace.',
    schema: z.object({
      task_id: nonEmptyString,
      project: projectSchema,
      input: z.record(z.string(), z.unknown()).optional(),
    }),
    func: async (input) => {
      guardProjectId(input.project, ports.sessionProject)
      const result = await ports.task.run({ taskId: input.task_id, project: input.project, input: input.input })
      if (result.task_run_id) {
        await ports.onRefs?.([], [result.task_run_id])
      }
      return JSON.stringify(result)
    },
  })
}

export function createTaskOutputTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'task_output',
    description: 'Get the output of a task run.',
    schema: z.object({
      task_run_id: nonEmptyString,
    }),
    func: async (input) => {
      // Verify authoritative task project is within session project scope
      if (ports.task.getTaskRun) {
        const taskRun = await ports.task.getTaskRun({ task_run_id: input.task_run_id })
        if (taskRun && taskRun.project) {
          guardProjectId(taskRun.project, ports.sessionProject)
        }
      }
      const result = await ports.task.output(input)
      return JSON.stringify(result)
    },
  })
}

export function createTaskStatusTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'task_status',
    description: 'Get the status of a task run.',
    schema: z.object({
      task_run_id: nonEmptyString,
    }),
    func: async (input) => {
      // Verify authoritative task project is within session project scope
      if (ports.task.getTaskRun) {
        const taskRun = await ports.task.getTaskRun({ task_run_id: input.task_run_id })
        if (taskRun && taskRun.project) {
          guardProjectId(taskRun.project, ports.sessionProject)
        }
      }
      const result = await ports.task.status(input)
      return JSON.stringify(result)
    },
  })
}

export function createTaskCancelTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'task_cancel',
    description: 'Cancel a task run.',
    schema: z.object({
      task_run_id: nonEmptyString,
    }),
    func: async (input) => {
      // Verify authoritative task project is within session project scope
      if (ports.task.getTaskRun) {
        const taskRun = await ports.task.getTaskRun({ task_run_id: input.task_run_id })
        if (taskRun && taskRun.project) {
          guardProjectId(taskRun.project, ports.sessionProject)
        }
      }
      const result = await ports.task.cancel(input)
      return JSON.stringify(result)
    },
  })
}

export function createTaskListTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'task_list',
    description: 'List active task runs, optionally filtered by project.',
    schema: z.object({
      project: projectSchema.optional(),
    }),
    func: async (input) => {
      const project = input.project ?? ports.sessionProject
      guardProjectId(project, ports.sessionProject)
      const result = await ports.task.list(project)
      return JSON.stringify(result)
    },
  })
}

// -- Message tools --

export function createMessageReplyTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'message_reply',
    description: 'Reply to a message on a given channel.',
    schema: z.object({
      to: nonEmptyString,
      text: nonEmptyString,
    }),
    func: async (input) => {
      const result = await ports.message.reply({ to: input.to, text: input.text })
      return JSON.stringify(result)
    },
  })
}

// -- Workspace document tools --

export function guardWorkspacePath(path: string): void {
  if (isAbsolute(path)) {
    throw new Error(`Workspace path must be relative, got absolute path: ${path}`)
  }
  const normalized = normalize(path)
  if (normalized.startsWith('..' + sep) || normalized === '..' || normalized.includes(sep + '..' + sep)) {
    throw new Error(`Workspace path must not traverse above root: ${path}`)
  }
  if (normalized.includes('..')) {
    throw new Error(`Workspace path must not contain parent references: ${path}`)
  }
}

// -- Workspace document tools (delegate to port for authorization) --

export function createWorkspaceDocReadTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'workspace_doc_read',
    description: 'Read a workspace document by path (relative to workspace root).',
    schema: z.object({
      path: nonEmptyString,
    }),
    func: async (input) => {
      guardWorkspacePath(input.path)
      const result = await ports.workspace.read(input.path)
      return JSON.stringify(result)
    },
  })
}

export function createWorkspaceDocWriteTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'workspace_doc_write',
    description: 'Write content to an existing workspace document (relative path).',
    schema: z.object({
      path: nonEmptyString,
      content: nonEmptyString,
    }),
    func: async (input) => {
      guardWorkspacePath(input.path)
      await ports.workspace.write(input.path, input.content)
      return JSON.stringify({ ok: true, path: input.path })
    },
  })
}

export function createWorkspaceDocCreateTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'workspace_doc_create',
    description: 'Create a new workspace document with given content (relative path). The session owns this document — enforcing at the WorkspaceDocPort adapter boundary.',
    schema: z.object({
      path: nonEmptyString,
      content: nonEmptyString,
    }),
    func: async (input) => {
      guardWorkspacePath(input.path)
      const result = await ports.workspace.create(input.path, input.content)
      return JSON.stringify(result)
    },
  })
}

export function createWorkspaceDocDeleteTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'workspace_doc_delete',
    description: 'Delete a workspace document that was created by this session (relative path). Ownership is enforced durably by the port.',
    schema: z.object({
      path: nonEmptyString,
    }),
    func: async (input) => {
      guardWorkspacePath(input.path)
      const ok = await ports.workspace.delete(input.path)
      return JSON.stringify({ ok, path: input.path })
    },
  })
}

export function createWorkspaceDocListTool(ports: ToolPorts): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'workspace_doc_list',
    description: 'List workspace documents in a directory (relative path).',
    schema: z.object({
      path: nonEmptyString,
    }),
    func: async (input) => {
      guardWorkspacePath(input.path)
      const result = await ports.workspace.list(input.path)
      return JSON.stringify(result)
    },
  })
}

// -- All tools factory --

export function createAllFwaTools(ports: ToolPorts): DynamicStructuredTool[] {
  return [
    createTaskGraphCreateTool(ports),
    createTaskGraphSignalTool(ports),
    createTaskGraphPatchTool(ports),
    createTaskGraphStatusTool(ports),
    createTaskGraphEventsTool(ports),
    createTaskGraphNodeInspectTool(ports),
    createTaskDescribeTool(ports),
    createTaskRunTool(ports),
    createTaskOutputTool(ports),
    createTaskStatusTool(ports),
    createTaskCancelTool(ports),
    createTaskListTool(ports),
    createMessageReplyTool(ports),
    createWorkspaceDocReadTool(ports),
    createWorkspaceDocWriteTool(ports),
    createWorkspaceDocCreateTool(ports),
    createWorkspaceDocDeleteTool(ports),
    createWorkspaceDocListTool(ports),
  ]
}
