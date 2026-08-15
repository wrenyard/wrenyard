// ─── Bounded static task-node slip snapshot ──────────────────────────────────
// Server-authored display metadata for taskgraph task nodes. A slip is the
// only per-node projection allowed to surface definition-level metadata
// through the taskgraph.slip RPC: category id/displayLabel, one-line
// description, and the resolved requested agent runtime. Everything here is
// bounded and derived from the resolved task definition at graph create /
// AddNode / ReplaceNode time; definition hot reloads never mutate an existing
// graph revision, and legacy graphs without a slip degrade by omitting the
// static fields.

import type { ResolvedDefinitionContract } from './task-contract-resolver.mts'
import type { NodeRunStateType } from './model.mts'

// ─── Bounds ────────────────────────────────────────────────────────────────

const MAX_DESCRIPTION = 280
const MAX_AGENT_RUNTIME = 128
const MAX_TASK_ID = 128

// ─── Slip snapshot type ─────────────────────────────────────────────────────

export interface TaskNodeSlip {
  /** Validated category; both fields present together. */
  category?: { id: string; displayLabel: string }
  /** One-line description, normalized to <=280 UTF-16 units. */
  description?: string
  /** Resolved requested agent runtime, normalized to <=128 UTF-16 units. */
  agentRuntime?: string
  /**
   * Authoritative resolved Foreman task definition name (e.g. 'commit',
   * 'forge-deploy', 'investigate'), normalized to <=128 UTF-16 units. This is
   * distinct from the runtime task_run_id and is never inferred from the
   * user-facing node name or action params at read time.
   */
  taskId?: string
}

/** Collapse any whitespace/newlines to a single line and cap UTF-16 length. */
export function singleLine(value: string, max: number): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return collapsed.slice(0, max)
}

/**
 * Build the bounded slip snapshot for a resolved task definition contract.
 * Returns undefined when no bounded static metadata can be derived (unknown
 * definition, contract validation disabled, or no metadata present).
 */
export function buildTaskNodeSlip(
  contract: ResolvedDefinitionContract | null | undefined,
): TaskNodeSlip | undefined {
  if (!contract) return undefined
  const slip: TaskNodeSlip = {}
  if (
    contract.category
    && typeof contract.category === 'object'
    && typeof contract.category.id === 'string'
    && typeof contract.category.displayLabel === 'string'
  ) {
    slip.category = {
      id: contract.category.id,
      displayLabel: contract.category.displayLabel,
    }
  }
  if (typeof contract.description === 'string' && contract.description.trim()) {
    slip.description = singleLine(contract.description, MAX_DESCRIPTION)
  }
  if (typeof contract.agentRuntime === 'string' && contract.agentRuntime.trim()) {
    slip.agentRuntime = singleLine(contract.agentRuntime, MAX_AGENT_RUNTIME)
  }
  if (typeof contract.definitionId === 'string' && contract.definitionId.trim()) {
    slip.taskId = singleLine(contract.definitionId, MAX_TASK_ID)
  }
  if (Object.keys(slip).length === 0) return undefined
  return slip
}

// ─── taskgraph.slip DTO node builder ────────────────────────────────────────

export interface TaskSlipNodeOutput {
  node_id: string
  state: NodeRunStateType
  task_category?: string
  display_label?: string
  description?: string
  agent_runtime?: string
  /** Authoritative resolved task definition name; omitted when unresolved. */
  task_id?: string
}

/**
 * Build one fail-closed taskgraph.slip node DTO. `node_id`/`state` are always
 * present; every optional field is bounded and omitted when unknown or
 * invalid — never null, never partial. Telemetry fields (tool call count, tps,
 * execution summary) are intentionally not surfaced yet: they stay omitted
 * until telemetry work lands.
 */
export function buildTaskSlipNode(input: {
  nodeId: string
  state: NodeRunStateType
  slip?: TaskNodeSlip
}): TaskSlipNodeOutput {
  const output: TaskSlipNodeOutput = {
    node_id: input.nodeId,
    state: input.state,
  }
  const slip = input.slip
  if (slip) {
    if (slip.category && typeof slip.category.id === 'string' && slip.category.id) {
      output.task_category = slip.category.id
    }
    if (slip.category && typeof slip.category.displayLabel === 'string' && slip.category.displayLabel) {
      output.display_label = slip.category.displayLabel
    }
    if (typeof slip.description === 'string' && slip.description.trim()) {
      output.description = singleLine(slip.description, MAX_DESCRIPTION)
    }
    if (typeof slip.agentRuntime === 'string' && slip.agentRuntime.trim()) {
      output.agent_runtime = singleLine(slip.agentRuntime, MAX_AGENT_RUNTIME)
    }
    if (typeof slip.taskId === 'string' && slip.taskId.trim()) {
      output.task_id = singleLine(slip.taskId, MAX_TASK_ID)
    }
  }
  return output
}
