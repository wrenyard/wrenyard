import { ForemanIpcClient } from './foreman-ipc-client';
import {
  GRAPH_SLIP_SCHEMA_VERSION,
  normalizeTaskGraphListResult,
  normalizeTaskGraphInspectResult,
  normalizeTaskGraphStatusResult,
  normalizeTaskGraphNodeInspectResult,
  normalizeTaskGraphEventsResult,
  normalizeTaskRunEventsResult,
  normalizeTaskGraphSlipResult,
  normalizeSafeEvent,
  type TaskGraphListResult,
  type TaskGraphInspectResult,
  type TaskGraphStatusResult,
  type TaskGraphNodeInspectResult,
  type TaskGraphEventsResult,
  type TaskRunEventsResult,
  type TaskGraphSlipResult,
  type SafeTranscriptEventData,
  type SafeTaskRunEventsResult,
} from '../shared/taskgraph';

const NODE_INSPECT_CONCURRENCY = 12;
const TASKGRAPH_EVENT_PAGE_SIZE = 1_000;
const MAX_TASKGRAPH_EVENT_PAGES = 100;

export interface TaskGraphSnapshot {
  list: TaskGraphListResult;
  inspect: TaskGraphInspectResult;
  status: TaskGraphStatusResult;
  events: TaskGraphEventsResult;
  nodeInspections: Map<string, TaskGraphNodeInspectResult>;
  // Graph Slip display facts, requested once per load. Absent when the graph
  // has no visible action.type=task nodes; otherwise the fully validated and
  // normalized response bound to the same inspect/status snapshot.
  slip?: TaskGraphSlipResult;
}

export class ForemanTaskGraphReader {
  private readonly client: ForemanIpcClient;

  constructor(client: ForemanIpcClient) {
    this.client = client;
  }

  async listActive(): Promise<TaskGraphListResult> {
    const raw = await this.client.request('taskgraph.list', { states: ['running', 'paused'] });
    const result = normalizeTaskGraphListResult(raw);
    // Validate every returned run is actually running or paused
    for (const run of result.runs) {
      if (run.state !== 'running' && run.state !== 'paused') {
        throw new Error(`TaskGraph: listActive returned invalid state "${run.state}"`);
      }
    }
    return result;
  }

  /**
   * Load only the static graph structure (taskgraph.inspect) — the nodes,
   * deps and schemas needed to draw a Graph Slip. Dynamic state (node state,
   * task run status, telemetry) comes exclusively from the shared activity
   * snapshot, so this performs no per-graph status/slip/events N+1 calls.
   */
  async loadStructure(id: string): Promise<TaskGraphInspectResult> {
    const raw = await this.client.request('taskgraph.inspect', { taskgraph_id: id });
    const inspect = normalizeTaskGraphInspectResult(raw);
    if (inspect.graph.id !== id) {
      throw new Error('TaskGraph: taskgraph.inspect identity mismatch');
    }
    return inspect;
  }

  async loadSnapshot(id: string): Promise<TaskGraphSnapshot> {
    const [inspectRaw, statusRaw, events] = await Promise.all([
      this.client.request('taskgraph.inspect', { taskgraph_id: id }),
      this.client.request('taskgraph.status', { taskgraph_id: id }),
      this.loadGraphEvents(id),
    ]);

    const inspect = normalizeTaskGraphInspectResult(inspectRaw);
    const status = normalizeTaskGraphStatusResult(statusRaw);
    if (inspect.graph.id !== id || status.taskgraph_id !== id) {
      throw new Error('TaskGraph: snapshot identity mismatch');
    }

    // Check generation match
    if (inspect.graph.revision !== status.structure_revision) {
      throw new Error(
        `TaskGraph revision mismatch: inspect ${inspect.graph.revision} vs status ${status.structure_revision}`
      );
    }

    // Reject the round when the fully paginated events and the concurrent
    // status disagree on latest_seq. Otherwise the Slip projection could
    // combine current status/Slip with stale event-derived runtimes.
    if (events.latest_seq !== status.latest_seq) {
      throw new Error(
        `TaskGraph: events/status latest_seq mismatch: ` +
        `events ${events.latest_seq} vs status ${status.latest_seq}`
      );
    }

    // Fetch each node.inspect concurrently — every expected node must have
    // exactly one result with matching id and matching structure_revision.
    // Any failure/missing/extra/mismatch rejects the whole snapshot.
    const nodeIds = Object.keys(inspect.graph.nodes);
    const nodeInspections = new Map<string, TaskGraphNodeInspectResult>();
    const rev = inspect.graph.revision;
    const batches: string[][] = [];
    for (let i = 0; i < nodeIds.length; i += NODE_INSPECT_CONCURRENCY) {
      batches.push(nodeIds.slice(i, i + NODE_INSPECT_CONCURRENCY));
    }
    for (const batch of batches) {
      const results = await Promise.all(
        batch.map((nodeId) =>
          this.client.request('taskgraph.node.inspect', { taskgraph_id: id, node_id: nodeId })
            .then(normalizeTaskGraphNodeInspectResult)
        )
      );
      for (let i = 0; i < batch.length; i++) {
        const nodeId = batch[i];
        const result = results[i];
        if (result.node.id !== nodeId) {
          throw new Error(
            `TaskGraph node.inspect id mismatch: expected "${nodeId}", got "${result.node.id}"`
          );
        }
        if (result.structure_revision !== rev) {
          throw new Error(
            `TaskGraph node.inspect structure_revision mismatch for "${nodeId}": ` +
            `expected ${rev}, got ${result.structure_revision}`
          );
        }
        nodeInspections.set(nodeId, result);
      }
    }

    // Graph Slip: request taskgraph.slip exactly once with every visible
    // action.type=task node id (skipped entirely when there are none). The
    // response must match the same inspect/status snapshot — schema version,
    // graph id, graph state, structure_revision, latest_seq and returned
    // node order/identity/state — or the whole polling round is rejected so
    // the window owner retains its previous complete snapshot. Static and
    // runtime display facts are atomically joined here, never via per-node
    // status/events calls, and raw task output is never parsed.
    const taskNodeIds = nodeIds.filter((nodeId) => inspect.graph.nodes[nodeId].action.type === 'task');
    const slip = taskNodeIds.length > 0
      ? await this.loadGraphSlip(id, taskNodeIds, inspect, status, nodeInspections)
      : undefined;

    return {
      list: { runs: [] },
      inspect,
      status,
      events,
      nodeInspections,
      slip,
    };
  }

  /**
   * Validate a taskgraph.slip response against the current inspect/status
   * snapshot. Any structural mismatch rejects the whole round; per-field
   * display facts are normalized fail-closed inside normalizeTaskGraphSlipResult.
   */
  private async loadGraphSlip(
    id: string,
    taskNodeIds: string[],
    inspect: TaskGraphInspectResult,
    status: TaskGraphStatusResult,
    nodeInspections: Map<string, TaskGraphNodeInspectResult>,
  ): Promise<TaskGraphSlipResult> {
    const raw = await this.client.request('taskgraph.slip', {
      taskgraph_id: id,
      node_ids: taskNodeIds,
    });
    const result = normalizeTaskGraphSlipResult(raw, taskNodeIds.length);

    if (result.schema_version !== GRAPH_SLIP_SCHEMA_VERSION) {
      throw new Error(
        `TaskGraph: taskgraph.slip schema_version mismatch: ` +
        `expected ${GRAPH_SLIP_SCHEMA_VERSION}, got ${result.schema_version}`
      );
    }
    if (result.taskgraph_id !== id) {
      throw new Error('TaskGraph: taskgraph.slip identity mismatch');
    }
    if (result.graph_state !== status.state) {
      throw new Error(
        `TaskGraph: taskgraph.slip state mismatch: expected ${status.state}, got ${result.graph_state}`
      );
    }
    if (result.structure_revision !== inspect.graph.revision) {
      throw new Error(
        `TaskGraph: taskgraph.slip structure_revision mismatch: ` +
        `expected ${inspect.graph.revision}, got ${result.structure_revision}`
      );
    }
    if (result.latest_seq !== status.latest_seq) {
      throw new Error(
        `TaskGraph: taskgraph.slip latest_seq mismatch: ` +
        `expected ${status.latest_seq}, got ${result.latest_seq}`
      );
    }
    if (result.nodes.length !== taskNodeIds.length) {
      throw new Error(
        `TaskGraph: taskgraph.slip node count mismatch: ` +
        `expected ${taskNodeIds.length}, got ${result.nodes.length}`
      );
    }
    for (let i = 0; i < result.nodes.length; i++) {
      const slipNode = result.nodes[i];
      if (slipNode.node_id !== taskNodeIds[i]) {
        throw new Error(
          `TaskGraph: taskgraph.slip node order mismatch at ${i}: ` +
          `expected "${taskNodeIds[i]}", got "${slipNode.node_id}"`
        );
      }
      const inspection = nodeInspections.get(slipNode.node_id);
      if (!inspection || slipNode.state !== inspection.run.state) {
        throw new Error(
          `TaskGraph: taskgraph.slip node state mismatch for "${slipNode.node_id}": ` +
          `expected "${inspection?.run.state}", got "${slipNode.state}"`
        );
      }
    }

    return result;
  }

  private async loadGraphEvents(id: string): Promise<TaskGraphEventsResult> {
    const events: TaskGraphEventsResult['events'] = [];
    let afterSeq = 0;
    let latestSeq = 0;

    for (let page = 0; page < MAX_TASKGRAPH_EVENT_PAGES; page++) {
      const raw = await this.client.request('taskgraph.events', {
        taskgraph_id: id,
        after_seq: afterSeq,
        limit: TASKGRAPH_EVENT_PAGE_SIZE,
      });
      const result = normalizeTaskGraphEventsResult(raw);
      let previousSeq = afterSeq;
      for (const event of result.events) {
        if (event.taskgraph_id !== id) {
          throw new Error('TaskGraph: taskgraph.events identity mismatch');
        }
        if (event.seq <= previousSeq) {
          throw new Error('TaskGraph: taskgraph.events sequence did not advance');
        }
        previousSeq = event.seq;
      }
      if (result.events.length > 0 && result.next_seq !== previousSeq) {
        throw new Error('TaskGraph: taskgraph.events cursor mismatch');
      }
      events.push(...result.events);
      latestSeq = result.latest_seq;
      if (!result.has_more) {
        return {
          events,
          next_seq: result.next_seq,
          latest_seq: latestSeq,
          has_more: false,
        };
      }
      if (result.next_seq <= afterSeq) {
        throw new Error('TaskGraph: taskgraph.events cursor did not advance');
      }
      afterSeq = result.next_seq;
    }

    throw new Error('TaskGraph: taskgraph.events exceeded safe page limit');
  }

  async loadTaskEvents(
    taskRunId: string,
    afterSeq?: number,
    limit: number = 500,
  ): Promise<SafeTaskRunEventsResult> {
    const params: Record<string, unknown> = { task_run_id: taskRunId, limit: Math.min(limit, 500) };
    if (afterSeq !== undefined) {
      params.after_seq = afterSeq;
    }
    const raw = await this.client.request('task.run.events', params);
    const normalized = normalizeTaskRunEventsResult(raw);
    if (normalized.task_run_id !== taskRunId) {
      throw new Error('TaskGraph: task.run.events identity mismatch');
    }
    // Project each event through the strict safe allowlist — unknown/
    // unapproved fields never cross main→renderer.
    return {
      ...normalized,
      events: normalized.events.map(normalizeSafeEvent),
    };
  }

  async taskRunIsTerminal(taskRunId: string): Promise<boolean> {
    const raw = await this.client.request('task.run.status', { task_run_id: taskRunId });
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('TaskGraph: malformed task.run.status response');
    }
    const record = raw as Record<string, unknown>;
    if (record.task_run_id !== taskRunId || typeof record.status !== 'string') {
      throw new Error('TaskGraph: task.run.status identity mismatch');
    }
    return ['done', 'failed', 'cancelled', 'interrupted'].includes(record.status);
  }
}
