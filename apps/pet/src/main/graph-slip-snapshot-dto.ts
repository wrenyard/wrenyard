// ── Graph Slip snapshot DTO projection ──────────────────────────────
// Strict projection: never leaks raw action params, schemas, or arbitrary
// object fields across the main→renderer boundary.

import type {
  GraphSlipSnapshotDto,
  GraphSlipNodeDto,
  GraphSlipEdgeDto,
  ServerDisplayPolicy,
  TaskGraphNodeState,
  TaskGraphSlipNode,
  TaskGraphInspectResult,
} from '../shared/taskgraph';
import { normalizeServerDisplayString, normalizeTaskTitle, projectTaskSlipDisplayFields } from '../shared/taskgraph';
import type { ActivityTaskGraphPresence } from '../shared/activity-snapshot';
import type { TaskGraphSnapshot } from './foreman-taskgraph-reader';

/**
 * Check whether a stored snapshot authorises opening a transcript for a
 * specific (nodeId, taskRunId) pair.  The caller must supply the active
 * graph id — this function does NOT accept a renderer-supplied graph id.
 */
export function snapshotAllowsTranscript(
  snapshot: TaskGraphSnapshot | null,
  graphId: string | null,
  nodeId: string,
  taskRunId: string,
): boolean {
  if (!snapshot || !graphId || snapshot.inspect.graph.id !== graphId) return false;
  // Only a validated task card may open a transcript: the inspected node must
  // exist, its action must be exactly `task`, and its run must carry the
  // matching task_run_id. A matching id on start/end/condition/checkpoint/
  // convert/join/fanout controls must never authorize IPC.
  const rawNode = snapshot.inspect.graph.nodes[nodeId];
  if (!rawNode || rawNode.action.type !== 'task') return false;
  const inspection = snapshot.nodeInspections.get(nodeId);
  return inspection?.run.task_run_id === taskRunId;
}

/**
 * Project a full TaskGraphSnapshot into a minimal GraphSlipSnapshotDto.
 * - Computes real runtime ms from fully paginated taskgraph events: terminal
 *   nodes use end-start, still-running nodes use trusted start to nowMs
 *   (rejecting negative/invalid elapsed).
 * - Derives edge labels from the target node's input binding name,
 *   input_schema title, or output_schema title (in that order).
 * - Projects only validated taskgraph.slip display facts onto matching
 *   task nodes, keyed by node id (never by name/id substring mapping).
 * - Projects the Pet-only task_title from the cached static node.name after
 *   single-line/CJK/48 validation; invalid names are omitted fail-closed.
 * - Never copies action.params, input_schema, output_schema, event payloads,
 *   unrecognized slip wire keys, or raw task output.
 * - Never serialises arbitrary objects or strings.
 */
export function projectGraphSlipSnapshot(
  snapshot: TaskGraphSnapshot,
  nowMs: number,
): GraphSlipSnapshotDto {
  const graphId = snapshot.inspect.graph.id;
  const graphNodes = snapshot.inspect.graph.nodes;
  const runtimes = nodeRuntimesFromEntries(snapshot.events.events, nowMs);
  const nodes: Record<string, GraphSlipNodeDto> = {};

  // The slip response only ever contains the requested action.type=task node
  // ids, so a non-task node can never receive slip display facts.
  const slipNodes = new Map<string, TaskGraphSlipNode>();
  for (const slipNode of snapshot.slip?.nodes ?? []) {
    slipNodes.set(slipNode.node_id, slipNode);
  }

  for (const [nodeId, rawNode] of Object.entries(graphNodes)) {
    const inspection = snapshot.nodeInspections.get(nodeId);
    const taskRunId = inspection?.run.task_run_id;
    const slipNode = slipNodes.get(nodeId);
    const node: GraphSlipNodeDto = {
      id: nodeId,
      action_type: rawNode.action.type,
      deps: rawNode.deps.slice(),
      state: (inspection?.run.state ?? 'planned') as TaskGraphNodeState,
      task_run_id: taskRunId,
      runtime_ms: runtimes[nodeId],
      ...(slipNode ? projectTaskSlipDisplayFields(slipNode) : {}),
    };
    const taskTitle = normalizeTaskTitle(rawNode.name);
    if (taskTitle !== undefined) node.task_title = taskTitle;
    nodes[nodeId] = node;
  }

  // Build edges with derived labels, never leaking raw schemas
  const edges: GraphSlipEdgeDto[] = [];
  for (const targetNode of Object.values(graphNodes)) {
    for (const sourceId of targetNode.deps) {
      const sourceNode = graphNodes[sourceId];
      if (sourceNode) {
        edges.push({
          from: sourceId,
          to: targetNode.id,
          label: deriveEdgeLabel(targetNode, sourceNode, sourceId),
        });
      }
    }
  }

  return {
    graph_id: graphId,
    revision: snapshot.inspect.graph.revision,
    state: snapshot.status.state,
    nodes,
    edges,
    // Optional display title, already normalized (or omitted) at the
    // taskgraph.status boundary. Legacy snapshots carry no synthetic title.
    ...(snapshot.status.title !== undefined ? { title: snapshot.status.title } : {}),
  };
}

/**
 * Derive a display label for an edge from the target node's input binding
 * and source node's output schema.
 * Priority: input binding name (enriched with input_schema.properties[name].title
 * when present) → target input_schema title → source output_schema title →
 * source output_schema type → 'data'.
 * Every candidate is validated through the shared server display string
 * primitive (normalizeServerDisplayString) under the edge-label policy (d-2):
 * max 32 UTF-16 code units, single-line, whitespace collapse, with the
 * ORIGINAL string validated before any transformation. C0/C1 controls, DEL,
 * unpaired surrogates, and U+2028/U+2029 are rejected outright, so a
 * malformed binding/schema string can never be sanitized into a caption.
 * Invalid candidates are skipped in priority order and 'data' is the fixed
 * safe fallback. Raw schema content is never forwarded and labels are never
 * produced by slicing raw surrogate/control data.
 */
function deriveEdgeLabel(
  targetNode: { input?: Array<{ name: string; source: string }>; input_schema?: unknown },
  sourceNode: { output_schema?: unknown; action?: { type?: string } },
  sourceId: string,
): string {
  // 1) Input binding name matching the source, enriched with property title
  const binding = (targetNode.input ?? []).find(
    (inp) => typeof inp.source === 'string' && inp.source.startsWith(sourceId + '.'),
  );
  if (binding?.name) {
    const nameLabel = normalizeServerDisplayString(binding.name, EDGE_LABEL_POLICY);
    const propertyTitle = readInputPropertyTitle(targetNode.input_schema, binding.name);
    if (nameLabel !== undefined) {
      if (propertyTitle !== undefined) {
        const titleLabel = normalizeServerDisplayString(propertyTitle, EDGE_LABEL_POLICY);
        if (titleLabel !== undefined) {
          const combined = normalizeServerDisplayString(`${nameLabel} · ${titleLabel}`, EDGE_LABEL_POLICY);
          if (combined !== undefined) return combined;
        }
      }
      return nameLabel;
    }
  }

  // 2) target input_schema title
  const inputSchemaTitle = normalizeServerDisplayString(readSchemaTitle(targetNode.input_schema), EDGE_LABEL_POLICY);
  if (inputSchemaTitle !== undefined) return inputSchemaTitle;

  // 3) source output_schema title
  const outputSchemaTitle = normalizeServerDisplayString(readSchemaTitle(sourceNode.output_schema), EDGE_LABEL_POLICY);
  if (outputSchemaTitle !== undefined) return outputSchemaTitle;

  // 4) source output_schema type
  const outputSchemaType = normalizeServerDisplayString(readSchemaType(sourceNode.output_schema), EDGE_LABEL_POLICY);
  if (outputSchemaType !== undefined) return outputSchemaType;

  // Fixed safe fallback for the compact Graph Slip caption.
  return 'data';
}

/**
 * Edge-label display policy (architecture decision d-2): max 32 UTF-16 code
 * units, single-line, whitespace collapse. Applied through the shared
 * normalizeServerDisplayString primitive — the single display-string source
 * of truth — so the Graph Slip projection keeps no duplicate Unicode/control
 * validators. The original string is validated before any transformation.
 */
const EDGE_LABEL_POLICY: ServerDisplayPolicy = {
  maxCodeUnits: 32,
  singleLine: true,
  whitespace: 'collapse',
};

/**
 * Safely read a "title" string from an unknown schema value.
 * Returns undefined for non-object, missing, or non-string title.
 */
function readSchemaTitle(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const rec = schema as Record<string, unknown>;
  return typeof rec.title === 'string' && rec.title.length > 0 ? rec.title : undefined;
}

/**
 * Safely read a property-level "title" from input_schema.properties[name].
 * Returns undefined for non-object, missing, or non-string title.
 */
function readInputPropertyTitle(schema: unknown, propName: string): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const rec = schema as Record<string, unknown>;
  const props = rec.properties;
  if (typeof props !== 'object' || props === null) return undefined;
  const prop = (props as Record<string, unknown>)[propName];
  if (typeof prop !== 'object' || prop === null) return undefined;
  const propRec = prop as Record<string, unknown>;
  return typeof propRec.title === 'string' && propRec.title.length > 0 ? propRec.title : undefined;
}

/**
 * Safely read a "type" string from an unknown schema value.
 * Returns undefined for non-object, missing, or non-string type.
 */
function readSchemaType(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const rec = schema as Record<string, unknown>;
  return typeof rec.type === 'string' && rec.type.length > 0 ? rec.type : undefined;
}

/**
 * Compute per-node runtimes from fully paginated events.
 * A terminal node keeps its end-start runtime; a node that only has a
 * trusted started event (still running) gets the truthfully growing elapsed
 * time from that start to nowMs. Negative or invalid elapsed values are
 * rejected — the node simply keeps no runtime_ms — and nowMs must be a
 * finite number or no running runtime is derived.
 */
function nodeRuntimesFromEntries(
  events: ReadonlyArray<{ type: string; occurred_at: string; refs?: { node_id?: string } }>,
  nowMs: number,
): Record<string, number> {
  const runtimes: Record<string, number> = {};
  const starts: Record<string, number> = {};
  const finished = new Set<string>();
  for (const ev of events) {
    const nodeId = ev.refs?.node_id;
    if (!nodeId) continue;
    const ts = new Date(ev.occurred_at).getTime();
    if (isNaN(ts)) continue;
    if (ev.type === 'taskgraph.node.started') {
      starts[nodeId] = ts;
      finished.delete(nodeId);
    } else if (
      ev.type === 'taskgraph.node.completed'
      || ev.type === 'taskgraph.node.failed'
      || ev.type === 'taskgraph.node.interrupted'
      || ev.type === 'taskgraph.node.cancelled'
    ) {
      const start = starts[nodeId];
      if (start !== undefined) {
        runtimes[nodeId] = ts - start;
      }
      finished.add(nodeId);
    }
  }
  if (Number.isFinite(nowMs)) {
    for (const [nodeId, startTs] of Object.entries(starts)) {
      if (finished.has(nodeId)) continue;
      const elapsed = nowMs - startTs;
      if (Number.isFinite(elapsed) && elapsed >= 0) {
        runtimes[nodeId] = elapsed;
      }
    }
  }
  return runtimes;
}

// ── Activity-snapshot-driven Graph Slip projection ──────────────────
// The static structure (nodes/edges/labels) is cached from taskgraph.inspect
// by structure_revision; every dynamic field — node state, task run id,
// task run status and the safe telemetry fields — comes from the single
// activity snapshot. No per-graph status/slip/events requests happen here.

/**
 * Project a Graph Slip DTO from the cached static structure plus the current
 * activity graph presence. The structure must already match the presence
 * structure_revision (the caller reloads inspect when they diverge).
 * `task_title` is projected from the cached same-revision static node.name
 * after single-line/CJK/48 validation — the activity snapshot stays the sole
 * dynamic SSOT.
 */
export function projectGraphSlipFromActivity(
  structure: TaskGraphInspectResult,
  graph: ActivityTaskGraphPresence,
): GraphSlipSnapshotDto {
  const graphNodes = structure.graph.nodes;
  const presenceNodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const nodes: Record<string, GraphSlipNodeDto> = {};

  for (const [nodeId, rawNode] of Object.entries(graphNodes)) {
    const presence = presenceNodes.get(nodeId);
    const dto: GraphSlipNodeDto = {
      id: nodeId,
      action_type: rawNode.action.type,
      deps: rawNode.deps.slice(),
      state: (presence?.state ?? 'planned') as TaskGraphNodeState,
    };
    if (presence?.taskRunId !== undefined) dto.task_run_id = presence.taskRunId;
    if (presence?.taskId !== undefined) dto.task_id = presence.taskId;
    if (presence?.taskStatus !== undefined) dto.task_status = presence.taskStatus;
    if (presence?.taskCategoryId !== undefined) dto.task_category = presence.taskCategoryId;
    // Pet-only task-tip heading: the cached same-revision static node.name
    // after single-line/CJK/48 validation; invalid names are omitted so the
    // renderer falls back to display_label then '任务'.
    const taskTitle = normalizeTaskTitle(rawNode.name);
    if (taskTitle !== undefined) dto.task_title = taskTitle;
    const displayLabel = presence?.taskCategoryLabel ?? presence?.displayLabel;
    if (displayLabel !== undefined) dto.display_label = displayLabel;
    if (presence?.description !== undefined) dto.description = presence.description;
    if (presence?.requestedAgentRuntime !== undefined) dto.agent_runtime = presence.requestedAgentRuntime;
    if (presence?.resolvedProfile !== undefined) dto.profile = presence.resolvedProfile;
    if (presence?.toolCallCount !== undefined) dto.tool_call_count = presence.toolCallCount;
    if (presence?.runtimeMs !== undefined) dto.runtime_ms = presence.runtimeMs;
    if (presence?.tps !== undefined) dto.tps = presence.tps;
    if (presence?.summary !== undefined) dto.summary = presence.summary;
    nodes[nodeId] = dto;
  }

  const edges: GraphSlipEdgeDto[] = [];
  for (const targetNode of Object.values(graphNodes)) {
    for (const sourceId of targetNode.deps) {
      const sourceNode = graphNodes[sourceId];
      if (sourceNode) {
        edges.push({
          from: sourceId,
          to: targetNode.id,
          label: deriveEdgeLabel(targetNode, sourceNode, sourceId),
        });
      }
    }
  }

  const dto: GraphSlipSnapshotDto = {
    graph_id: structure.graph.id,
    revision: structure.graph.revision,
    state: graph.state,
    nodes,
    edges,
  };
  if (graph.title !== undefined) dto.title = graph.title;
  return dto;
}

/**
 * Authorize opening a transcript for (nodeId, taskRunId) from the activity
 * snapshot projection. The caller supplies the active graph id — never a
 * renderer-supplied id. Only a task action node whose activity presence
 * carries the matching task run id may open a transcript.
 */
export function activityAllowsTranscript(
  structure: TaskGraphInspectResult | null,
  graph: ActivityTaskGraphPresence | null,
  graphId: string | null,
  nodeId: string,
  taskRunId: string,
): boolean {
  if (!structure || !graph || !graphId) return false;
  if (structure.graph.id !== graphId || graph.taskgraphId !== graphId) return false;
  const rawNode = structure.graph.nodes[nodeId];
  if (!rawNode || rawNode.action.type !== 'task') return false;
  return graph.nodes.some((node) => node.nodeId === nodeId && node.taskRunId === taskRunId);
}
