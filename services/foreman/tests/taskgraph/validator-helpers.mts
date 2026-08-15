// @ts-nocheck
/**
 * Shared helpers for TaskGraph validator tests.
 *
 * Exports fixture factories used across validator tests.
 * task-contract-validation.test.mts.
 */

import type {
  TaskGraph,
  TaskGraphNode,
  TaskGraphAutoSchemaResolver,
  NodeId,
  JsonObject,
} from '../../lib/core/taskgraph/index.mts'

/** Build a minimal valid resolver that resolves task/llm. */
export function makeResolver(
  overrides?: Partial<TaskGraphAutoSchemaResolver>,
): TaskGraphAutoSchemaResolver {
  return {
    resolveActionSchema(type, _params) {
      if (type === 'task') {
        return {
          input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
          output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        }
      }
      return null
    },
    resolveLlmInputSchema(_params) {
      return { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }
    },
    resolveLlmStructuredOpts(_params) {
      return null
    },
    ...overrides,
  }
}

export function emptyGraph(id = 'g-test'): TaskGraph {
  return { id, revision: 0, nodes: {} }
}

export function startNode(id: NodeId, overrides?: Partial<TaskGraphNode>): TaskGraphNode {
  return {
    id,
    name: `start-${id}`,
    action: { type: 'start', params: {} },
    deps: [],
    input: [],
    input_schema: { type: 'object', properties: {} },
    output_schema: { type: 'object', properties: { out: { type: 'string' } }, required: ['out'] },
    ...overrides,
  } as TaskGraphNode
}

export function taskNode(id: NodeId, overrides?: Partial<TaskGraphNode>): TaskGraphNode {
  return {
    id,
    name: `task-${id}`,
    action: { type: 'task', params: { command: 'echo', msg: 'default-msg' } },
    deps: [],
    input: [],
    input_schema: { type: 'object', properties: {} },
    output_schema: { type: 'object', properties: {} },
    ...overrides,
  } as TaskGraphNode
}

export function endNode(id: NodeId, overrides?: Partial<TaskGraphNode>): TaskGraphNode {
  return {
    id,
    name: `end-${id}`,
    action: { type: 'end', params: {} },
    deps: [],
    input: [],
    input_schema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] },
    output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    ...overrides,
  } as TaskGraphNode
}
