import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ForemanClient,
  type ForemanClientRpc,
  type ForemanRequestOptions,
} from '../../lib/client/foreman-client.mts'
import { JsonRpcClient, type JsonRpcClientTransport } from '../../lib/client/jsonrpc-client.mts'
import { connectIpcForemanClient } from '../../lib/client/ipc-foreman-client.mts'
import {
  DAEMON_UNAVAILABLE,
  ProtocolError,
} from '../../lib/protocol/errors.mts'
import { RpcRouter } from '../../lib/server/rpc-router.mts'
import {
  createIpcServer,
  type IpcServer,
} from '../../lib/transport/ipc-server.mts'
import {
  createTestIpcEndpoint,
  type TestIpcEndpoint,
} from '../helpers/ipc-endpoint.mts'
import { taskgraphProtocolCases } from '../taskgraph/protocol-shell-fixtures.mts'
import type {
  TaskGraphCreateParams,
  TaskGraphPatchParams,
  TaskGraphStatusParams,
  TaskGraphEventsParams,
  TaskGraphSignalParams,
  TaskGraphNodeInspectParams,
  TaskGraphInspectParams,
} from '../../lib/protocol/registry.mts'

class FakeRpc implements ForemanClientRpc {
  readonly requests: Array<{ method: string, params: unknown, options?: ForemanRequestOptions }> = []
  closedWith?: Error
  disposedWith?: Error

  constructor(private readonly result: unknown) {}

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: ForemanRequestOptions,
  ): Promise<TResult> {
    this.requests.push(options === undefined ? { method, params } : { method, params, options })
    return this.result as TResult
  }

  close(error?: Error): void {
    this.closedWith = error
  }

  dispose(error?: Error): void {
    this.disposedWith = error
  }
}

class HangingTransport implements JsonRpcClientTransport {
  readonly frames: string[] = []

  send(frame: string): void {
    this.frames.push(frame)
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await delay(5)
  }
}

function assertRequest(
  rpc: FakeRpc,
  index: number,
  method: string,
  params: unknown,
): void {
  assert.equal(rpc.requests[index]?.method, method)
  assert.equal(rpc.requests[index]?.params, params)
}

async function createHealthServer(
  endpoint: TestIpcEndpoint,
  onPing: () => Promise<{ ok: true }> | { ok: true } = () => ({ ok: true }),
): Promise<IpcServer> {
  const router = new RpcRouter()
  router.register('health.ping', onPing)
  return createIpcServer({
    path: endpoint.path,
    onMessage: (message) => router.handleMessage(message),
  })
}

describe('ForemanClient', () => {
  it('health.ping() delegates to health.ping JSON-RPC method', async () => {
    const rpc = new FakeRpc({ ok: true })
    const client = new ForemanClient(rpc)

    assert.deepEqual(await client.health.ping(), { ok: true })
    assert.deepEqual(rpc.requests, [{ method: 'health.ping', params: {} }])
  })

  it('stats.today delegates to stats.today JSON-RPC method', async () => {
    const result = { dayKey: '2026-07-19', startAt: '2026-07-19T00:00:00.000Z', endAt: '2026-07-20T00:00:00.000Z', dispatchCount: 3, inputTokens: 100, outputTokens: 50, totalTokens: 150, source: 'sqlite' }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)

    assert.deepEqual(await client.stats.today(), result)
    assert.deepEqual(rpc.requests, [{ method: 'stats.today', params: {} }])
  })

  it('stats.summary delegates to stats.summary JSON-RPC method with params', async () => {
    const result = {
      source: 'sqlite',
      today: { dayKey: '2026-07-19', startAt: '2026-07-19T00:00:00.000Z', endAt: '2026-07-20T00:00:00.000Z', dispatchCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, outcomes: { done: 0, failed: 0, cancelled: 0 } },
      byProfile: [{ profile: 'unknown', dispatchCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }],
      byTask: [{ taskName: 'unknown', dispatchCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }],
      daily: [{ dayKey: '2026-07-19', dispatchCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }],
      totalTaskDurationMs: 0,
      byTaskDuration: [],
    }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)

    assert.deepEqual(await client.stats.summary({ days: 3, limit: 10 }), result)
    assert.deepEqual(rpc.requests, [{ method: 'stats.summary', params: { days: 3, limit: 10 } }])
  })

  it('stats.summary sends empty params when omitted', async () => {
    const rpc = new FakeRpc({ source: 'sqlite', today: { dayKey: '2026-07-19', startAt: '', endAt: '', dispatchCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, outcomes: { done: 0, failed: 0, cancelled: 0 } }, byProfile: [], byTask: [], daily: [], totalTaskDurationMs: 0, byTaskDuration: [] })
    const client = new ForemanClient(rpc)

    await client.stats.summary()

    assert.deepEqual(rpc.requests, [{ method: 'stats.summary', params: {} }])
  })

  it('daemon.shutdown() delegates to daemon.shutdown JSON-RPC method', async () => {
    const result = { ok: true, shutting_down: true, reason: 'test stop' }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)

    assert.equal(await client.daemon.shutdown({ reason: 'test stop' }), result)
    assert.deepEqual(rpc.requests, [{ method: 'daemon.shutdown', params: { reason: 'test stop' } }])
  })

  it('task wrappers delegate to the matching JSON-RPC methods with original params', async () => {
    const result = { ok: true }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)
    const definitionListParams = { project: 'foreman' }
    const definitionDescribeParams = { task_id: 'commit', project: 'foreman' }
    const runCreateParams = { task_id: 'commit', project: 'foreman', input: { changes_to_commit: { 'src/x.ts': 'all' } } }
    const runListParams = {}
    const runStatusParams = { task_run_id: 'task_1234' }
    const runOutputParams = { task_run_id: 'task_1234' }
    const runCancelParams = { task_run_id: 'task_1234' }

    assert.equal(await client.task.definition.list(definitionListParams), result)
    assert.equal(await client.task.definition.describe(definitionDescribeParams), result)
    assert.equal(await client.task.run.create(runCreateParams), result)
    assert.equal(await client.task.run.list(runListParams), result)
    assert.equal(await client.task.run.status(runStatusParams), result)
    assert.equal(await client.task.run.output(runOutputParams), result)
    assert.equal(await client.task.run.cancel(runCancelParams), result)

    assertRequest(rpc, 0, 'task.definition.list', definitionListParams)
    assertRequest(rpc, 1, 'task.definition.describe', definitionDescribeParams)
    assertRequest(rpc, 2, 'task.run.create', runCreateParams)
    assertRequest(rpc, 3, 'task.run.list', runListParams)
    assertRequest(rpc, 4, 'task.run.status', runStatusParams)
    assertRequest(rpc, 5, 'task.run.output', runOutputParams)
    assertRequest(rpc, 6, 'task.run.cancel', runCancelParams)
  })

  it('task.definition.list() sends empty params when omitted', async () => {
    const rpc = new FakeRpc([])
    const client = new ForemanClient(rpc)

    await client.task.definition.list()

    assert.deepEqual(rpc.requests, [{ method: 'task.definition.list', params: {} }])
  })

  it('message wrapper delegates to the matching JSON-RPC method with original params', async () => {
    const result = { ok: true }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)
    const messageParams = {
      to: 'relay',
      text: 'hello from client',
      sender: { role: 'codex' },
    }

    assert.equal(await client.message.send(messageParams), result)

    assertRequest(rpc, 0, 'message.send', messageParams)
  })

  it('pet wrappers delegate to daemon IPC JSON-RPC methods', async () => {
    const result = {
      ok: true,
      status: {
        state: 'running',
        enabled: true,
        running: true,
        transport: 'ipc-jsonrpc',
        command: 'npm',
        args: ['start'],
        cwd: '/tmp/foreman-pet',
      },
    }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)

    assert.equal(await client.pet.status(), result)
    assert.equal(await client.pet.start(), result)
    assert.equal(await client.pet.stop(), result)
    assert.equal(await client.pet.restart(), result)

    assert.deepEqual(rpc.requests, [
      { method: 'pet.status', params: {} },
      { method: 'pet.start', params: {} },
      { method: 'pet.stop', params: {} },
      { method: 'pet.restart', params: {} },
    ])
  })

  it('project wrappers delegate to the matching JSON-RPC methods with original params', async () => {
    const result = { ok: true }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)
    const listParams = {}
    const describeParams = { project: 'foreman' }
    const statusParams = { project: 'foreman' }
    const pullParams = { project: 'foreman' }
    const pushParams = { project: 'foreman' }
    const worktreeListParams = { project: 'foreman' }
    const worktreeCreateParams = { project: 'foreman', worktree_id: 'deadbeef' }
    const worktreeRemoveParams = { worktree_id: 'deadbeef' }
    const worktreeMergeParams = { project: 'foreman', worktree_id: 'deadbeef' }

    assert.equal(await client.project.list(listParams), result)
    assert.equal(await client.project.describe(describeParams), result)
    assert.equal(await client.project.status(statusParams), result)
    assert.equal(await client.project.pull(pullParams), result)
    assert.equal(await client.project.push(pushParams), result)
    assert.equal(await client.project.worktree.list(worktreeListParams), result)
    assert.equal(await client.project.worktree.create(worktreeCreateParams), result)
    assert.equal(await client.project.worktree.remove(worktreeRemoveParams), result)
    assert.equal(await client.project.worktree.merge(worktreeMergeParams), result)

    assertRequest(rpc, 0, 'project.list', listParams)
    assertRequest(rpc, 1, 'project.describe', describeParams)
    assertRequest(rpc, 2, 'project.status', statusParams)
    assertRequest(rpc, 3, 'project.pull', pullParams)
    assertRequest(rpc, 4, 'project.push', pushParams)
    assertRequest(rpc, 5, 'project.worktree.list', worktreeListParams)
    assertRequest(rpc, 6, 'project.worktree.create', worktreeCreateParams)
    assertRequest(rpc, 7, 'project.worktree.remove', worktreeRemoveParams)
    assertRequest(rpc, 8, 'project.worktree.merge', worktreeMergeParams)
  })

  it('taskgraph wrappers delegate to the matching JSON-RPC methods with original params', async () => {
    const result = { ok: true }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)

    const createParams = taskgraphProtocolCases[0].legalParams
    const patchParams = taskgraphProtocolCases[1].legalParams
    const statusParams = taskgraphProtocolCases[2].legalParams
    const eventsParams = taskgraphProtocolCases[3].legalParams
    const signalParams = taskgraphProtocolCases[4].legalParams
    const nodeInspectParams = taskgraphProtocolCases[5].legalParams
    const inspectParams = { taskgraph_id: 'tg_test' }

    assert.equal(await client.taskgraph.create(createParams as TaskGraphCreateParams), result)
    assert.equal(await client.taskgraph.patch(patchParams as TaskGraphPatchParams), result)
    assert.equal(await client.taskgraph.status(statusParams as TaskGraphStatusParams), result)
    assert.equal(await client.taskgraph.events(eventsParams as TaskGraphEventsParams), result)
    assert.equal(await client.taskgraph.signal(signalParams as TaskGraphSignalParams), result)
    assert.equal(await client.taskgraph.node.inspect(nodeInspectParams as TaskGraphNodeInspectParams), result)
    assert.equal(await client.taskgraph.inspect(inspectParams as TaskGraphInspectParams), result)

    assertRequest(rpc, 0, 'taskgraph.create', createParams)
    assertRequest(rpc, 1, 'taskgraph.patch', patchParams)
    assertRequest(rpc, 2, 'taskgraph.status', statusParams)
    assertRequest(rpc, 3, 'taskgraph.events', eventsParams)
    assertRequest(rpc, 4, 'taskgraph.signal', signalParams)
    assertRequest(rpc, 5, 'taskgraph.node.inspect', nodeInspectParams)
    assertRequest(rpc, 6, 'taskgraph.inspect', inspectParams)
  })

  it('taskgraph.wait sets the request deadline to the normalized server wait plus margin', async () => {
    const result = { ok: true }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)

    // Omitted timeout_ms falls back to the server default (60000) plus margin.
    const omittedParams = { taskgraph_id: 'tg_wait_omitted' }
    await client.taskgraph.wait(omittedParams)

    // Explicit in-range timeout_ms keeps the value plus margin.
    const inRangeParams = { taskgraph_id: 'tg_wait_in_range', timeout_ms: 120_000 }
    await client.taskgraph.wait(inRangeParams)

    // Oversized timeout_ms is bounded to the server maximum (600000) plus margin.
    const oversizedParams = { taskgraph_id: 'tg_wait_oversized', timeout_ms: 10_000_000 }
    await client.taskgraph.wait(oversizedParams)

    assertRequest(rpc, 0, 'taskgraph.wait', omittedParams)
    assert.deepEqual(rpc.requests[0]?.options, { timeoutMs: 65_000 })
    assertRequest(rpc, 1, 'taskgraph.wait', inRangeParams)
    assert.deepEqual(rpc.requests[1]?.options, { timeoutMs: 125_000 })
    assertRequest(rpc, 2, 'taskgraph.wait', oversizedParams)
    assert.deepEqual(rpc.requests[2]?.options, { timeoutMs: 605_000 })
  })

  it('activity.snapshot delegates to activity.snapshot JSON-RPC method', async () => {
    const result = { schema_version: 'foreman.activity.snapshot.v1', sampled_at: '2026-08-05T00:00:00.000Z', tasks: [], taskgraphs: [] }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)

    const params = { tracked_taskgraph_ids: ['tg_1'] }
    assert.deepEqual(await client.activity.snapshot(params), result)
    assertRequest(rpc, 0, 'activity.snapshot', params)

    await client.activity.snapshot()
    assert.equal(rpc.requests[1]?.method, 'activity.snapshot')
    assert.deepEqual(rpc.requests[1]?.params, {})
  })

  it('fwa wrappers delegate to the matching JSON-RPC methods with original params', async () => {
    const result = { ok: true }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)

    const assignParams = {
      ticket_id: 'ticket_abc',
      project_id: 'proj_xyz',
      prompt: 'implement the search feature',
    }
    const listParams = {}
    const statusParams = { session_id: 'session_123' }
    const transcriptParams = { session_id: 'session_123' }

    assert.equal(await client.fwa.assign(assignParams), result)
    assert.equal(await client.fwa.list(listParams), result)
    assert.equal(await client.fwa.status(statusParams), result)
    assert.equal(await client.fwa.transcript(transcriptParams), result)

    assertRequest(rpc, 0, 'fwa.assign', assignParams)
    assertRequest(rpc, 1, 'fwa.list', listParams)
    assertRequest(rpc, 2, 'fwa.status', statusParams)
    assertRequest(rpc, 3, 'fwa.transcript', transcriptParams)
  })

  it('fwa.list() sends empty params when omitted', async () => {
    const rpc = new FakeRpc([])
    const client = new ForemanClient(rpc)

    await client.fwa.list()

    assert.deepEqual(rpc.requests, [{ method: 'fwa.list', params: {} }])
  })

  it('agent wrappers delegate to the daemon conversation RPC methods', async () => {
    const result = { ok: true }
    const rpc = new FakeRpc(result)
    const client = new ForemanClient(rpc)
    const sync = { address: 'foreman-work', after_seq: 12, wait_ms: 1_000 }
    const compact = { address: 'foreman-work' }
    const review = {
      address: 'foreman-work',
      graph_id: 'tg_1',
      patch_id: 'patch_1',
      decision: 'reject' as const,
      client_action_id: 'action_1',
    }

    assert.equal(await client.agent.list(), result)
    assert.equal(await client.agent.sync(sync), result)
    assert.equal(await client.agent.compact(compact), result)
    assert.equal(await client.agent.graph.review(review), result)
    assert.deepEqual(rpc.requests[0], { method: 'agent.list', params: {} })
    assertRequest(rpc, 1, 'agent.sync', sync)
    assertRequest(rpc, 2, 'agent.compact', compact)
    assertRequest(rpc, 3, 'agent.graph.review', review)
  })

  it('connectIpcForemanClient connects health.ping over IPC to RpcRouter', async () => {
    const endpoint = createTestIpcEndpoint('health')
    const server = await createHealthServer(endpoint)
    const client = await connectIpcForemanClient({
      path: endpoint.path,
      timeoutMs: 1_000,
    })

    try {
      assert.deepEqual(await client.health.ping(), { ok: true })
    } finally {
      client.close()
      await server.close()
      rmSync(endpoint.dir, { recursive: true, force: true })
    }
  })

  it('close() rejects pending requests and closes the optional transport', async () => {
    const rpc = new JsonRpcClient({
      transport: new HangingTransport(),
      idFactory: () => 'close-test',
    })
    const lifecycle = {
      closeCount: 0,
      close(): void {
        this.closeCount += 1
      },
    }
    const client = new ForemanClient(rpc, { transport: lifecycle })
    const pending = client.health.ping()

    assert.equal(rpc.pendingCount, 1)
    client.close()

    await assert.rejects(pending, /ForemanClient closed/)
    assert.equal(rpc.pendingCount, 0)
    assert.equal(lifecycle.closeCount, 1)
  })

  it('dispose() rejects pending requests and disposes the optional transport', async () => {
    const rpc = new JsonRpcClient({
      transport: new HangingTransport(),
      idFactory: () => 'dispose-test',
    })
    const lifecycle = {
      disposeCount: 0,
      dispose(): void {
        this.disposeCount += 1
      },
    }
    const client = new ForemanClient(rpc, { transport: lifecycle })
    const pending = client.health.ping()

    assert.equal(rpc.pendingCount, 1)
    client.dispose()

    await assert.rejects(pending, /ForemanClient disposed/)
    assert.equal(rpc.pendingCount, 0)
    assert.equal(lifecycle.disposeCount, 1)
  })

  it('rejects pending IPC requests when the server closes the socket', async () => {
    const endpoint = createTestIpcEndpoint('server-close')
    let pingStarted = false
    let releasePing: (() => void) | undefined
    const server = await createHealthServer(endpoint, async () => {
      pingStarted = true
      await new Promise<void>((resolve) => {
        releasePing = resolve
      })
      return { ok: true }
    })
    const client = await connectIpcForemanClient({
      path: endpoint.path,
      timeoutMs: 1_000,
    })

    try {
      const pending = client.health.ping()
      await waitFor(() => pingStarted)
      await server.close()

      await assert.rejects(
        Promise.race([
          pending,
          delay(500).then(() => {
            throw new Error('pending request did not reject after IPC close')
          }),
        ]),
        (error) => {
          assert(error instanceof ProtocolError)
          assert.equal(error.code, DAEMON_UNAVAILABLE.code)
          return true
        },
      )
    } finally {
      releasePing?.()
      client.close()
      rmSync(endpoint.dir, { recursive: true, force: true })
    }
  })

  it('does not expose removed or future method groups yet', () => {
    const client = new ForemanClient(new FakeRpc({ ok: true }))
    const clientShape = client as unknown as Record<string, unknown>

    assert.equal(typeof clientShape.task, 'object')
    assert.equal(clientShape.workflow, undefined)
    assert.equal(typeof clientShape.project, 'object')
    assert.equal(typeof clientShape.message, 'object')
    assert.equal(typeof clientShape.daemon, 'object')
    assert.equal(typeof clientShape.pet, 'object')
    assert.equal(typeof clientShape.fwa, 'object')
    assert.equal(clientShape.messageDelivery, undefined)
    assert.equal(clientShape.session, undefined)
    assert.equal(clientShape.worker, undefined)
  })

  it('keeps new client modules free of runtime imports', () => {
    const clientRoot = join(process.cwd(), 'lib', 'client')
    const files = [
      join(clientRoot, 'foreman-client.mts'),
      join(clientRoot, 'ipc-foreman-client.mts'),
    ]
    const forbiddenRuntimePath = /(^|\/|\\)(cli|daemon|service|server|db|executor|notify|config|mcp)(\/|\\|\.mts$)/

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const importSpecifiers = [...source.matchAll(/\b(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1])

      for (const specifier of importSpecifiers) {
        const crossesClientBoundary = specifier.startsWith('../') || specifier.startsWith('..\\')
        assert(
          !(crossesClientBoundary && forbiddenRuntimePath.test(specifier)),
          `${file} imports forbidden runtime dependency ${specifier}`,
        )
      }
    }
  })
})
