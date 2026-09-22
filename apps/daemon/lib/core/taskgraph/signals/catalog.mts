import type {
  IgnoredReason,
  TaskGraphSignal,
} from '../contracts.mts'
import type {
  JsonObject,
  NodeId,
} from '../model.mts'
import type { TaskGraphProjection } from '../store.mts'

export type SignalDecision =
  | { kind: 'start'; input: JsonObject; startNodeId: NodeId }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'cancel' }
  | { kind: 'resume_checkpoint'; nodeId: NodeId; output: JsonObject }
  | { kind: 'ignore'; reason: IgnoredReason }

export interface SignalValidation {
  startInputValid(input: JsonObject): boolean
  checkpointOutputValid(nodeId: NodeId, output: JsonObject): boolean
}

export function decideTaskGraphSignal(
  projection: TaskGraphProjection,
  signal: TaskGraphSignal,
  validation: SignalValidation,
): SignalDecision {
  switch (signal.type) {
    case 'start_graph': {
      if (projection.run.state !== 'created') {
        return { kind: 'ignore', reason: 'GRAPH_ALREADY_STARTED' }
      }
      if (!validation.startInputValid(signal.input)) {
        return { kind: 'ignore', reason: 'START_INPUT_SCHEMA_MISMATCH' }
      }
      const startNode = Object.values(projection.graph.nodes)
        .find((node) => node.action.type === 'start')
      if (!startNode) return { kind: 'ignore', reason: 'START_INPUT_SCHEMA_MISMATCH' }
      return { kind: 'start', input: signal.input, startNodeId: startNode.id }
    }

    case 'pause_graph':
      if (projection.run.state !== 'running') {
        return {
          kind: 'ignore',
          reason: projection.run.state === 'cancelled'
            ? 'GRAPH_ALREADY_CANCELLED'
            : 'GRAPH_NOT_PAUSED',
        }
      }
      return { kind: 'pause' }

    case 'resume_graph':
      if (projection.run.state !== 'paused') {
        return {
          kind: 'ignore',
          reason: projection.run.state === 'cancelled'
            ? 'GRAPH_ALREADY_CANCELLED'
            : 'GRAPH_NOT_PAUSED',
        }
      }
      return { kind: 'resume' }

    case 'cancel_graph':
      if (projection.run.state === 'cancelled' || projection.run.state === 'done') {
        return { kind: 'ignore', reason: 'GRAPH_ALREADY_CANCELLED' }
      }
      return { kind: 'cancel' }

    case 'resume_checkpoint': {
      const state = Object.hasOwn(projection.nodeStates, signal.node_id)
        ? projection.nodeStates[signal.node_id]
        : undefined
      const node = Object.hasOwn(projection.graph.nodes, signal.node_id)
        ? projection.graph.nodes[signal.node_id]
        : undefined
      if (!node || node.action.type !== 'checkpoint' || state?.state !== 'waiting') {
        return { kind: 'ignore', reason: 'CHECKPOINT_NOT_WAITING' }
      }
      if (!validation.checkpointOutputValid(signal.node_id, signal.output)) {
        return { kind: 'ignore', reason: 'CHECKPOINT_OUTPUT_SCHEMA_MISMATCH' }
      }
      return {
        kind: 'resume_checkpoint',
        nodeId: signal.node_id,
        output: signal.output,
      }
    }
  }
}
