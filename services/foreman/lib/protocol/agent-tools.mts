/** Canonical typed agent tool registry shared by MCP clients. */

import type { ForemanMethod } from './registry.mts'

export interface ProtocolToolSpec {
  name: string
  method: ForemanMethod
  description: string
  result?: (value: unknown) => unknown
  params?: (args: Record<string, unknown>) => Record<string, unknown>
  /** JSON Schema input schema for agent presentation; omits privileged/meta fields. */
  inputSchema?: Record<string, unknown>
}

/**
 * Complete MCP business tool surface — all Foreman domain methods that MCP
 * exposes as tools.
 */
export const mcpProtocolTools: ProtocolToolSpec[] = [
  {
    name: 'task_status',
    method: 'task.run.status',
    description: 'Get Foreman task lifecycle status without task output.',
  },
  {
    name: 'task_output',
    method: 'task.run.output',
    description: 'Get the full output/content for one Foreman task run.',
  },
  {
    name: 'task_run',
    method: 'task.run.create',
    description: 'Run a Foreman task by definition name. MCP returns id/task_run_id plus a concise hint for status/output lookup. If no input is provided, returns an input_required error with the expected schema.',
  },
  {
    name: 'task_cancel',
    method: 'task.run.cancel',
    description: 'Cancel a running Foreman task run by its task_run_id.',
  },
  {
    name: 'task_list',
    method: 'task.definition.list',
    description: 'List available Foreman task definitions. Without a project, returns only generic/common tasks. With a project, returns generic plus project-specific tasks.',
    result: (value) => ({ tasks: value }),
  },
  {
    name: 'task_describe',
    method: 'task.definition.describe',
    description: 'Get detailed schema and contract for a Foreman task.',
  },
  {
    name: 'status',
    method: 'project.status',
    description: 'Show configured project and worktree status.',
  },
  {
    name: 'worktree_create',
    method: 'project.worktree.create',
    description: 'Create a git worktree for a configured project.',
  },
  {
    name: 'worktree_remove',
    method: 'project.worktree.remove',
    description: 'Remove a managed git worktree by id.',
  },
  {
    name: 'git_push',
    method: 'project.push',
    description: 'Push the current branch of a configured project or managed worktree to origin. Requires a clean checkout and never force-pushes or pushes tags.',
  },
  {
    name: 'worktree_merge',
    method: 'project.worktree.merge',
    description: 'Strictly merge a managed git worktree into the project target branch and remove it after a successful merge.',
  },
  {
    name: 'send_message',
    method: 'message.send',
    description: 'Send a plain text message to a configured Foreman message role. This is always asynchronous.',
  },
  {
    name: 'pm_ticket_create',
    method: 'pm.ticket.create',
    description: 'Create a project management ticket (main or sub). Main tickets can have an assignee; sub-tickets require a parent main ticket and cannot have an assignee.',
  },
  {
    name: 'pm_ticket_get',
    method: 'pm.ticket.get',
    description: 'Get a PM ticket by id.',
  },
  {
    name: 'pm_ticket_list',
    method: 'pm.ticket.list',
    description: 'List PM tickets filtered by project_id with optional kind/status/parent_id/assignee_session_id.',
  },
  {
    name: 'pm_ticket_update',
    method: 'pm.ticket.update',
    description: 'Update a PM ticket: edit title/description/assignee or set_status with transition validation.',
  },
  {
    name: 'pm_ticket_delete',
    method: 'pm.ticket.delete',
    description: 'Delete a PM ticket. Main tickets with children cannot be deleted.',
  },
  {
    name: 'taskgraph_create',
    method: 'taskgraph.create',
    description: 'Create a TaskGraph from a named template (default, parallel-explore, parallel-edit, change-test, implement, closeout). Use taskgraph_patch to add or replace nodes. Full IR is not accepted on create.',
  },
  {
    name: 'taskgraph_patch',
    method: 'taskgraph.patch',
    description: 'Apply a structural patch to an existing TaskGraph.',
  },
  {
    name: 'taskgraph_status',
    method: 'taskgraph.status',
    description: 'Get the current status and structure revision of a TaskGraph.',
  },
  {
    name: 'taskgraph_events',
    method: 'taskgraph.events',
    description: 'Stream events from a TaskGraph by sequence number.',
  },
  {
    name: 'taskgraph_signal',
    method: 'taskgraph.signal',
    description: 'Send a lifecycle signal (pause/resume/cancel) to a TaskGraph.',
  },
  {
    name: 'taskgraph_node_inspect',
    method: 'taskgraph.node.inspect',
    description: 'Inspect a specific node\'s current state within a TaskGraph.',
  },
  {
    name: 'taskgraph_inspect',
    method: 'taskgraph.inspect',
    description: 'Read a stored TaskGraph structural skeleton: returns all nodes with dependency topology expressed via each node\'s deps field. For run data, use taskgraph_status for lifecycle state and taskgraph_node_inspect for individual node state.',
  },
  {
    name: 'taskgraph_wait',
    method: 'taskgraph.wait',
    description: 'Wait once for a TaskGraph to settle without polling: done, cancelled, paused, or an active waiting checkpoint. Returns a stable status/result shape; specify timeout_ms for a bounded wait.',
  },
  {
    name: 'taskgraph_list',
    method: 'taskgraph.list',
    description: 'List TaskGraph runs. Optional filters: project, states (created|running|paused|done|cancelled), limit 1–100.',
  },
]
