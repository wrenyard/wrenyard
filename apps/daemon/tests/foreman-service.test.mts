import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { resetRegistry } from '../lib/workspace/task-loader.mts'
import { CANONICAL_PRINCIPALS } from '../lib/message/principal.mts'
import { createTestIpcEndpoint } from './helpers/ipc-endpoint.mts'
import { installIsolatedForemanEnv, type IsolatedForemanEnv } from './helpers/isolated-env.mts'

let isolatedEnv: IsolatedForemanEnv | undefined

beforeEach(() => {
  isolatedEnv = installIsolatedForemanEnv('foreman-service-test-env')
})

afterEach(() => {
  isolatedEnv?.restore()
  isolatedEnv = undefined
})

test('service exposes orchestration and message tools from one MCP endpoint', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'foreman-service-mcp-'))
  const workspaceProject = join(workDir, 'projects', 'workspace')
  mkdirSync(workspaceProject, { recursive: true })
  writeFileSync(
    join(workspaceProject, 'workspace.fmproj'),
    'name: workspace\ndescription: Workspace shared resources\n',
    'utf-8',
  )

  const running = await createTestService(workDir)
  try {
    const address = running.httpServer.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    const health = await getJson(`${baseUrl}/health`) as { status: string; uptime: number; startedAt: number; tasksActive: number }
    assert.equal(health.status, 'ok')
    assert.equal(typeof health.uptime, 'number')
    assert.equal(typeof health.startedAt, 'number')
    assert.equal(health.tasksActive, 0)

    const orchestrationTools = await mcpToolNames(`${baseUrl}/mcp`)
    assert.deepEqual(
      orchestrationTools.filter((name) => ['status', 'task_run', 'task_list', 'send_message'].includes(name)),
      ['status', 'task_run', 'task_list', 'send_message'],
    )
    assert.equal(orchestrationTools.some((name) => name.startsWith('pet_') || name === 'pet'), false)

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }),
    })
    assert.equal(initialized.status, 202)
    assert.equal(await initialized.text(), '')
  } finally {
    await running.stop()
    resetRegistry()
    rmSync(workDir, { recursive: true, force: true })
  }
})

function createTestService(workDir: string, deps?: any) {
  const endpoint = createTestIpcEndpoint('service')
  return import('../lib/daemon/daemon.mts').then(async ({ startForemanDaemon }) => {
    const running = await startForemanDaemon({
      service: {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'http://127.0.0.1:0',
        ipc: { path: endpoint.path },
      },
      workspaceRoot: workDir,
      message: testMessageConfig(),
      messageDelivery: {
        enabled: false,
        default: ['system'],
        channels: {},
      },
    }, deps)
    const stop = running.stop.bind(running)
    let endpointCleaned = false
    const cleanupEndpoint = (): void => {
      if (endpointCleaned) return
      endpointCleaned = true
      rmSync(endpoint.dir, { recursive: true, force: true })
    }

    // startForemanDaemon now returns the ForemanDaemon instance itself; its
    // resources live behind getters (not own enumerable props), so expose the
    // fields the tests read explicitly instead of spreading the instance.
    return {
      httpServer: running.httpServer,
      ipcPath: running.ipcPath,
      async stop() {
        try {
          await stop()
        } finally {
          cleanupEndpoint()
        }
      },
    }
  }).catch((error) => {
    rmSync(endpoint.dir, { recursive: true, force: true })
    throw error
  })
}

function testMessageConfig(): import('../lib/config/normalize.mts').NormalizedMessageConfig {
  return {
    enabled: true,
    principals: {
      ...CANONICAL_PRINCIPALS,
      operator: {
        id: 'operator',
        kind: 'human',
        canSend: true,
        canReceive: true,
        grants: [{ name: 'message.send' }],
        deliveryRoute: 'operator.telegram',
      },
      relay: {
        id: 'relay',
        kind: 'agent',
        canSend: true,
        canReceive: true,
        grants: [{ name: 'message.send' }],
        deliveryRoute: 'relay.openclaw',
      },
    },
    routes: {
      'relay.openclaw': {
        transport: 'openclaw',
        address: {
          target: '1682807251',
          channel: 'telegram',
          mode: 'agent',
          session_key: 'agent:main:telegram:direct:1682807251',
        },
        format: 'markdown',
      },
      'operator.telegram': {
        transport: 'telegram',
        address: {
          chat_id: '1682807251',
        },
        format: 'telegram-html',
      },
    },
  }
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  return response.json()
}

async function mcpToolNames(url: string): Promise<string[]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    }),
  })
  const text = await response.text()
  const payload = parseSseJson(text) as { result?: { tools?: Array<{ name: string }> } }
  return payload.result?.tools?.map((tool) => tool.name) ?? []
}

function parseSseJson(text: string): unknown {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  assert.ok(dataLine, `expected SSE data line, received ${text}`)
  return JSON.parse(dataLine.slice('data: '.length))
}
