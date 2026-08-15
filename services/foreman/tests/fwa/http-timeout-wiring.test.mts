import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FwaService, type FwaServiceOptions } from '../../lib/daemon/services/fwa/service.mts'
import { FwaSessionStore } from '../../lib/core/fwa/session-store.mts'
import { AgentEventStore } from '../../lib/core/agent/agent-event-store.mts'
import type { RawForgeExecutor } from '../../lib/core/fwa/forge-chat-model.mts'
import { initDb, closeDb } from '../../lib/db/connection.mts'
import { bootstrapSchema } from '../../lib/db/schema.mts'
import type { ForemanDatabase } from '../../lib/db/types.mts'

let db: ForemanDatabase
let tmpDir: string

function createService(
  store: FwaSessionStore,
  httpTimeoutMsOverride?: number,
  captureParams?: (params: Parameters<RawForgeExecutor>[0]) => void,
): FwaService {
  const captured: Parameters<RawForgeExecutor>[0][] = []
  const captureFn = captureParams ?? ((p: Parameters<RawForgeExecutor>[0]) => { captured.push(p) })

  const rawExecutor: RawForgeExecutor = async (params) => {
    captureFn(params)
    return {
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok', tool_calls: [] },
        finish_reason: 'stop',
      }],
    }
  }

  const llm: FwaServiceOptions['config']['llm'] = {
    model: 'foreman-public/fwa-test',
        turn_timeout_ms: 30000,
  }
  if (httpTimeoutMsOverride !== undefined) {
    llm.http_timeout_ms = httpTimeoutMsOverride
  }

  const options: FwaServiceOptions = {
    config: {
      workspaceRoot: tmpDir,
      llm,
    },
    messageService: { send: async () => ({ accepted: true }) } as any,
    taskgraphService: {
      create: async () => ({ taskgraph: { id: 'tg-wiring', revision: 1 } }),
      signal: async () => ({ accepted: true }),
      patch: async () => ({ type: 'applied', revision: 2 }),
      status: async () => ({
        taskgraph_id: 'tg-wiring', state: 'running',
        structure_revision: 1, latest_seq: 0,
        node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
      }),
      events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
      inspect: async () => ({}),
    } as any,
    taskService: {
      run: async () => ({ task_run_id: 'tr-wiring', status: 'created' }),
      describe: async () => ({}),
      output: async () => ({}),
      status: async () => ({}),
      cancel: async () => ({}),
      list: async () => [],
    } as any,
    store,
    agentEventStore: new AgentEventStore(db),
    rawExecutor,
    workspaceRoot: tmpDir,
  }
  return new FwaService(options)
}

void describe('http-timeout-wiring', () => {
  before(() => {
    db = initDb(':memory:')
    bootstrapSchema(db)
    tmpDir = mkdtempSync(join(tmpdir(), 'fwa-http-timeout-test-'))
    writeFileSync(join(tmpDir, 'FWA.md'), '# Policy\n')
  })

  after(() => {
    closeDb()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  void it('omitted http_timeout_ms defaults to 120000 in executor params', async () => {
    const store = new FwaSessionStore(db)
    const receivedParams: Parameters<RawForgeExecutor>[0][] = []
    const service = createService(store, undefined, (p) => { receivedParams.push(p) })

    await service.assign({
      ticket_id: 'ticket-wiring-default',
      project_id: 'proj-wiring-default',
      prompt: 'Test default timeout',
    })

    await new Promise<void>(resolve => setImmediate(resolve))

    assert.ok(receivedParams.length > 0, 'raw executor should have been called')
    assert.equal(receivedParams[0].timeout_ms, 120_000,
      `expected default timeout_ms 120000, got ${receivedParams[0].timeout_ms}`)

    await service.close()
  })

  void it('explicit http_timeout_ms override reaches executor params', async () => {
    const store = new FwaSessionStore(db)
    const receivedParams: Parameters<RawForgeExecutor>[0][] = []
    const service = createService(store, 30_000, (p) => { receivedParams.push(p) })

    await service.assign({
      ticket_id: 'ticket-wiring-override',
      project_id: 'proj-wiring-override',
      prompt: 'Test override timeout',
    })

    await new Promise<void>(resolve => setImmediate(resolve))

    assert.ok(receivedParams.length > 0, 'raw executor should have been called')
    assert.equal(receivedParams[0].timeout_ms, 30_000,
      `expected override timeout_ms 30000, got ${receivedParams[0].timeout_ms}`)

    await service.close()
  })
})
