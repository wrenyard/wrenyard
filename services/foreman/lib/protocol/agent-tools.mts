/**
 * Canonical typed agent tool registry shared by MCP and Work projections.
 *
 * One source of truth for tool names, method mappings, descriptions, and
 * projection functions. MCP and Work import their respective projections
 * from here; there is no second tool catalog.
 */

import type { ForemanMethod } from './registry.mts'

export type ToolExecutionMode = 'inline' | 'delegation'

// ─── Typed agent event projections ────────────────────────────────────

/**
 * Public agent event projection shared by IPC clients. Every event row
 * carries turn_seq so clients can group by turn without polling.
 * reasoning_content and chain of thought are never exposed.
 */
export interface AgentEventProjection {
  seq: number
  turn_seq: number
  kind: string
  payload: unknown
  created_at: string
}

/**
 * Safe activity summary — available only when explicitly returned by the
 * model or derived server-side. Never contains raw reasoning content.
 */
export interface ActivitySummaryProjection {
  turn_seq: number
  summary: string
  action_count: number
}

/**
 * Delegation lifecycle — started events carry tool metadata; terminal
 * events carry the resource_id outcome.
 */
export interface DelegationStartedProjection {
  turn_seq: number
  delegation_id: string
  tool_name: string
  resource_id: string
}

export interface DelegationTerminalProjection {
  turn_seq: number
  delegation_id: string
  resource_id: string
  status: 'terminal'
}

export interface SystemCompletionProjection {
  turn_seq: number
  origin_delegation_id: string
  text: string
}

/**
 * Attachment input descriptor — what callers send.
 * Contains only the local filesystem path; validation is server-side.
 */
export interface AttachmentInput {
  path: string
}

/**
 * Normalized attachment result — the validated/ingested response.
 * Never contains bytes, base64, data URLs, or absolute storage paths.
 */
export interface AttachmentResult {
  path: string
  status: 'accepted' | 'rejected'
  mime_type?: string
  size?: number
  sha256?: string
  storage_ref?: string
  error?: 'file_not_found' | 'invalid_path' | 'not_regular_file' | 'too_large' | 'unsupported_content_type' | 'read_failed'
}

/**
 * Work send message payload with typed attachment inputs.
 */
export interface WorkSendPayload {
  from: string
  text: string
  message_id?: string
  attachments?: AttachmentInput[]
}

/**
 * Work transcript entry with typed attachment results.
 */
export interface WorkTranscriptEntry {
  seq: number
  turn_seq: number
  kind: string
  payload: unknown
  attachments?: AttachmentResult[]
  created_at: string
}

export interface ProtocolToolSpec {
  name: string
  method: ForemanMethod
  description: string
  result?: (value: unknown) => unknown
  params?: (args: Record<string, unknown>) => Record<string, unknown>
  /** JSON Schema input schema for agent presentation; omits privileged/meta fields. */
  inputSchema?: Record<string, unknown>
  /**
   * How the runtime executes a call to this tool.
   * - 'inline': invoked in-turn; its result feeds back into the model and the
   *   turn loop continues (default).
   * - 'delegation': hands off to a background agent. The runtime records a
   *   fixed-text result (no ids) and ends the turn immediately with no second
   *   model invocation.
   */
  executionMode?: ToolExecutionMode
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
    executionMode: 'delegation',
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

/**
 * Explicit Work agent tool allowlist — the only tools the Work LLM agent may
 * call. The Work agent is a front-desk dispatcher, so the surface is limited to:
 * - OBSERVATION: project list/describe/status, commit log, worktree list,
 *   agent.list, agent.model.list, workspace doc list/read, PM ticket get/list,
 *   FWA list/transcript/status, TaskGraph list/status/inspect/events,
 * - DISPATCH: pm.ticket.create, pm.ticket.update, fwa.assign, message send
 * - SHORT READ-ONLY QUERIES: task_run (restricted to readonly definitions at
 *   runtime), task_list, task_describe.
 * Every work-execution capability (TaskGraph mutation, git writes, workspace
 * doc writes, task cancellation, and anything that mutates state beyond ticket
 * dispatch) is excluded by design. System/generic tools (daemon,
 * pet, MCP sessions, bash, shell, filesystem) are also excluded.
 */
export const workAgentTools: ProtocolToolSpec[] = [
  {
    name: 'project_list',
    method: 'project.list',
    description: 'List all configured Foreman projects.',
  },
  {
    name: 'project_describe',
    method: 'project.describe',
    description: 'Describe a configured Foreman project by name.',
  },
  {
    name: 'project_status',
    method: 'project.status',
    description: 'Show status of a configured project or all projects.',
  },
  {
    name: 'project_commit_log',
    method: 'project.commitLog',
    description: 'Get a bounded commit history for a configured project checkout.',
  },
  {
    name: 'worktree_list',
    method: 'project.worktree.list',
    description: 'List managed worktrees for a configured project.',
  },
  {
    name: 'agent_list',
    method: 'agent.list',
    description: 'List all Foreman agents with their kind, status, queue, and model.',
  },
  {
    name: 'agent_model_list',
    method: 'agent.model.list',
    description: 'List the current and available model ids for the Foreman agents.',
  },
  {
    name: 'workspace_doc_list',
    method: 'workspace.doc.list',
    description: 'List workspace documentation files.',
  },
  {
    name: 'workspace_doc_read',
    method: 'workspace.doc.read',
    description: 'Read a workspace documentation file.',
  },
  {
    name: 'task_list',
    method: 'task.definition.list',
    description: 'List available Foreman task definitions.',
    result: (value) => ({ tasks: value }),
  },
  {
    name: 'task_describe',
    method: 'task.definition.describe',
    description: 'Get detailed schema and contract for a Foreman task.',
  },
  {
    name: 'task_run',
    method: 'task.run.create',
    description: 'Run a readonly Foreman task by definition name. Only tasks whose definition permission is readonly can be run directly; write work must be dispatched via pm.ticket.create + fwa.assign.',
    executionMode: 'delegation',
  },
  {
    name: 'pm_ticket_create',
    method: 'pm.ticket.create',
    description: 'Create a project management ticket (main or sub).',
  },
  {
    name: 'pm_ticket_get',
    method: 'pm.ticket.get',
    description: 'Get a PM ticket by id.',
  },
  {
    name: 'pm_ticket_list',
    method: 'pm.ticket.list',
    description: 'List PM tickets filtered by project_id.',
  },
  {
    name: 'pm_ticket_update',
    method: 'pm.ticket.update',
    description: 'Update a PM ticket.',
  },
  {
    name: 'fwa_assign',
    method: 'fwa.assign',
    description: 'Assign a Foreman Work Agent (FWA) to a PM ticket with a prompt.',
    executionMode: 'delegation',
  },
  {
    name: 'fwa_list',
    method: 'fwa.list',
    description: 'List all active FWA sessions.',
  },
  {
    name: 'fwa_status',
    method: 'fwa.status',
    description: 'Get status of an FWA session.',
  },
  {
    name: 'fwa_transcript',
    method: 'fwa.transcript',
    description: 'Get the transcript of an FWA session.',
  },
  {
    name: 'taskgraph_list',
    method: 'taskgraph.list',
    description: 'List TaskGraphs.',
  },
  {
    name: 'taskgraph_inspect',
    method: 'taskgraph.inspect',
    description: 'Read a stored TaskGraph structural skeleton.',
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
    name: 'taskgraph_node_inspect',
    method: 'taskgraph.node.inspect',
    description: 'Inspect a specific node\'s current state within a TaskGraph.',
  },
  {
    name: 'send_message',
    method: 'message.send',
    description: 'Send a plain text message to a configured Foreman message role. Sender is bound by RPC context and cannot be overridden.',
    inputSchema: {
      type: 'object',
      required: ['to', 'text'],
      properties: {
        to: { type: 'string', description: 'Target message role' },
        text: { type: 'string', description: 'Message text' },
        client_message_id: { type: 'string', description: 'Optional client-provided idempotency key' },
      },
      additionalProperties: false,
    },
    params: (args) => {
      // Never accept or forward sender from model input; it is bound by RPC context.
      const { sender: _unused, ...rest } = args as Record<string, unknown> & { sender?: unknown }
      return rest
    },
  },
]
