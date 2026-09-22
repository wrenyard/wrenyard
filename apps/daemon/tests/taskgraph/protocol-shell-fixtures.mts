import type { TaskGraphCreateParams, TaskGraphPatchParams, TaskGraphStatusParams, TaskGraphEventsParams, TaskGraphSignalParams, TaskGraphNodeInspectParams, TaskGraphListParams } from '../../lib/protocol/methods/taskgraph.mts'

export interface TaskGraphProtocolCase {
  method: string
  route: string
  cli: string
  legalParams: unknown
  invalidParams: unknown
}

export const taskgraphProtocolCases: TaskGraphProtocolCase[] = [
  {
    method: 'taskgraph.create',
    route: '/api/v1/taskgraph/create',
    cli: 'create',
    legalParams: {
      template: 'default',
      project: 'test-project',
    } satisfies TaskGraphCreateParams,
    invalidParams: {},
  },
  {
    method: 'taskgraph.patch',
    route: '/api/v1/taskgraph/patch',
    cli: 'patch',
    legalParams: {
      taskgraph_id: 'tg_test',
      operation: {
        type: 'request_patch',
        patch: {
          base_revision: 0,
          actor: 'test',
          reason: 'test patch',
          created_at: '2025-01-01T00:00:00.000Z',
          ops: [],
        },
      },
    } satisfies TaskGraphPatchParams,
    invalidParams: {},
  },
  {
    method: 'taskgraph.status',
    route: '/api/v1/taskgraph/status',
    cli: 'status',
    legalParams: {
      taskgraph_id: 'tg_test',
    } satisfies TaskGraphStatusParams,
    invalidParams: {},
  },
  {
    method: 'taskgraph.events',
    route: '/api/v1/taskgraph/events',
    cli: 'events',
    legalParams: {
      taskgraph_id: 'tg_test',
      after_seq: 0,
      limit: 1,
    } satisfies TaskGraphEventsParams,
    invalidParams: {},
  },
  {
    method: 'taskgraph.signal',
    route: '/api/v1/taskgraph/signal',
    cli: 'signal',
    legalParams: {
      taskgraph_id: 'tg_test',
      signal: { type: 'pause_graph' },
    } satisfies TaskGraphSignalParams,
    invalidParams: {},
  },
  {
    method: 'taskgraph.node.inspect',
    route: '/api/v1/taskgraph/node/inspect',
    cli: 'node inspect',
    legalParams: {
      taskgraph_id: 'tg_test',
      node_id: 'start',
    } satisfies TaskGraphNodeInspectParams,
    invalidParams: {},
  },
  {
    method: 'taskgraph.list',
    route: '/api/v1/taskgraph/list',
    cli: 'list',
    legalParams: {} satisfies TaskGraphListParams,
    invalidParams: {
      limit: 0,
      states: [],
    },
  },
]
