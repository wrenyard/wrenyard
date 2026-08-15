import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ForemanMcpServer } from '../lib/server/mcp/server.mts'
import { RpcRouter } from '../lib/server/rpc-router.mts'
import { query as dbQuery, run as dbRun } from '../lib/db/connection.mts'
import { getDb } from '../lib/db/connection.mts'
import { resetRegistry } from '../lib/workspace/task-loader.mts'
import { methodRegistry, type ForemanMethod } from '../lib/protocol/registry.mts'
import { taskgraphProtocolCases } from './taskgraph/protocol-shell-fixtures.mts'
import { setAgentExecutionSupervisor } from '../lib/core/operations/primitives/agent.mts'
import { setTaskWorkflowRunner } from '../lib/core/operations/primitives/runner.mts'
import type { AgentExecutionHost } from '../lib/core/operations/types.mts'
import { TaskWorkflowRunner } from '../lib/daemon/execution/task-workflow-runner.mts'
import { closeTestDb, initTestDb } from './helpers/test-db.mts'

type TestServer = {
  toolDefinitions: () => Array<{ name: string; inputSchema?: { required?: string[]; properties?: Record<string, unknown> } }>
  handleToolCall: (name: string, args: Record<string, unknown>, context?: string | { sender?: { role: string }; connectingId?: string }) => Promise<unknown>
  handleLine: (line: string, context?: string | { sender?: { role: string }; connectingId?: string }) => Promise<{ jsonrpc: string; id?: unknown; result?: unknown; error?: { code: number; message: string } } | null>
}

let tempDirs: string[] = []
let oldWorkspace: string | undefined
let oldWorkDir: string | undefined

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeServer(workspace: string): TestServer {
  process.env.FOREMAN_WORKSPACE = workspace
  process.env.FOREMAN_TEST_WORK_DIR = workspace
  return new ForemanMcpServer() as unknown as TestServer
}

function installRunnerSupervisor(host: AgentExecutionHost): void {
  setAgentExecutionSupervisor(host)
  setTaskWorkflowRunner(new TaskWorkflowRunner({
    db: getDb(),
    agentExecutionHost: host,
  }))
}

function deliveryOutput(result: Record<string, unknown>, summary = 'Task complete.'): string {
  return `<foreman-task-output>
<summary>
${summary}
</summary>
<result>
${JSON.stringify(result)}
</result>
</foreman-task-output>`
}

function writeTask(dir: string, name: string, profile = 'test-profile'): void {
  writeFileSync(
    join(dir, `${name}.task.ts`),
    `export default defineTask({
  profile: ${JSON.stringify(profile)},
  permission: 'readonly',
  description: 'test task',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => \`Task says: \${text}\`,
})
`,
    'utf-8',
  )
}

function writeStructuredTask(dir: string, name: string, profile = 'test-profile'): void {
  writeFileSync(
    join(dir, `${name}.task.ts`),
    `export default defineTask({
  profile: ${JSON.stringify(profile)},
  permission: 'readonly',
  description: 'structured test task',
  input: foremanSchemas.z.object({ text: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ label: foremanSchemas.z.string() }).strict(),
  prompt: ({ text }) => \`Classify: \${text}\`,
})
`,
    'utf-8',
  )
}

function writeProjectDefinitions(workspace: string): string {
  return writeFmproj(workspace, 'app')
}

function writeFmproj(workspace: string, projectId: string, options: { git?: boolean; hostPath?: string } = {}): string {
  const parts = projectId.split('/')
  const name = parts.at(-1)
  assert.ok(name)
  const projectDir = join(workspace, 'projects', ...parts)
  mkdirSync(projectDir, { recursive: true })
  const gitBlock = options.git
    ? `git:
  remote: https://example.test/${name}.git
  default_branch: main
`
    : ''
  writeFileSync(
    join(projectDir, `${name}.fmproj`),
    `name: ${name}
description: Test project ${projectId}
${gitBlock}hosts:
  ${hostname()}: ${options.hostPath ?? projectDir}
`,
    'utf-8',
  )
  return projectDir
}

async function waitForTaskStatus(server: TestServer, taskRunId: string): Promise<unknown> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await server.handleToolCall('task_status', { task_run_id: taskRunId }) as { status?: string }
    if (status.status === 'done' || status.status === 'failed' || status.status === 'cancelled' || status.status === 'interrupted') return status
    await sleep(25)
  }
  return server.handleToolCall('task_status', { task_run_id: taskRunId })
}


beforeEach(() => {
  oldWorkspace = process.env.FOREMAN_WORKSPACE
  oldWorkDir = process.env.FOREMAN_TEST_WORK_DIR
  delete process.env.FOREMAN_WORKSPACE
  delete process.env.FOREMAN_TEST_WORK_DIR
  setAgentExecutionSupervisor(undefined as never)
  setTaskWorkflowRunner(undefined)
  resetRegistry()
})

afterEach(() => {
  if (oldWorkspace === undefined) delete process.env.FOREMAN_WORKSPACE
  else process.env.FOREMAN_WORKSPACE = oldWorkspace
  if (oldWorkDir === undefined) delete process.env.FOREMAN_TEST_WORK_DIR
  else process.env.FOREMAN_TEST_WORK_DIR = oldWorkDir
  setAgentExecutionSupervisor(undefined as never)
  setTaskWorkflowRunner(undefined)
  resetRegistry()
  closeTestDb()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('ForemanMcpServer v2 tools', () => {

  it('exposes and dispatches TaskGraph MCP protocol tools', async () => {
    initTestDb()
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const server = makeServer(workspace)
    const defs = server.toolDefinitions()
    const taskgraphTools = defs.filter((t) => t.name.startsWith('taskgraph_'))

    assert.equal(taskgraphTools.length, 9)

    // Each tool inputSchema matches the associated methodRegistry params schema,
    // apart from the MCP-only project discovery description.
    const mcpToMethod = {
      taskgraph_create: 'taskgraph.create',
      taskgraph_patch: 'taskgraph.patch',
      taskgraph_status: 'taskgraph.status',
      taskgraph_events: 'taskgraph.events',
      taskgraph_signal: 'taskgraph.signal',
      taskgraph_node_inspect: 'taskgraph.node.inspect',
      taskgraph_inspect: 'taskgraph.inspect',
      taskgraph_wait: 'taskgraph.wait',
      taskgraph_list: 'taskgraph.list',
    } as const satisfies Record<string, ForemanMethod>
    for (const tool of taskgraphTools) {
      const method = (mcpToMethod as Record<string, ForemanMethod>)[tool.name]
      assert.ok(method)
      const expectedSchema = methodRegistry[method].params as Record<string, unknown>
      const actualSchema = structuredClone(tool.inputSchema) as {
        properties?: { project?: { description?: string } }
      }
      if (actualSchema.properties?.project) {
        assert.equal(typeof actualSchema.properties.project.description, 'string')
        delete actualSchema.properties.project.description
      }
      assert.deepEqual(actualSchema, expectedSchema)
    }

    const created = await server.handleToolCall(
      'taskgraph_create',
      taskgraphProtocolCases[0].legalParams as Record<string, unknown>,
    ) as { taskgraph: { id: string; status: string } }
    const taskgraphId = created.taskgraph.id
    assert.equal(created.taskgraph.status, 'created')

    const status = await server.handleToolCall('taskgraph_status', {
      taskgraph_id: taskgraphId,
    }) as { state: string }
    assert.equal(status.state, 'created')

    const listed = await server.handleToolCall('taskgraph_list', {
      states: ['created'],
    }) as { runs: Array<{ taskgraph_id: string; state: string }> }
    assert.ok(Array.isArray(listed.runs))
    assert.ok(listed.runs.some((run) => run.taskgraph_id === taskgraphId && run.state === 'created'))

    const inspected = await server.handleToolCall('taskgraph_node_inspect', {
      taskgraph_id: taskgraphId,
      node_id: 'start',
    }) as { run: { state: string } }
    assert.equal(inspected.run.state, 'planned')

    const graphInspect = await server.handleToolCall('taskgraph_inspect', {
      taskgraph_id: taskgraphId,
    }) as { graph: { id: string; revision: number; nodes: Record<string, unknown> } }
    assert.equal(graphInspect.graph.id, taskgraphId)
    assert.equal(graphInspect.graph.revision, 1)
    assert.ok(graphInspect.graph.nodes)
    assert.ok(graphInspect.graph.nodes['start'])

    // taskgraph_inspect description must claim skeleton+topology, not edges or current runtime state
    const taskgraphInspectDef = defs.find((t) => t.name === 'taskgraph_inspect')
    assert.ok(taskgraphInspectDef)
    const inspectDesc = (taskgraphInspectDef as { name: string; description?: string; inputSchema?: unknown }).description
    assert.ok(typeof inspectDesc === 'string')
    assert.doesNotMatch(inspectDesc as string, /\bedges?\b/i)
    assert.doesNotMatch(inspectDesc as string, /current\s+(runtime\s+)?state/i)

    const preview = await server.handleToolCall('taskgraph_patch', {
      taskgraph_id: taskgraphId,
      operation: {
        type: 'request_patch',
        patch: {
          base_revision: 1,
          actor: 'mcp-test',
          reason: 'no-op',
          created_at: new Date().toISOString(),
          ops: [],
        },
      },
    }) as { type: string; patch_id: string }
    assert.equal(preview.type, 'preview')
    assert.deepEqual(await server.handleToolCall('taskgraph_patch', {
      taskgraph_id: taskgraphId,
      operation: { type: 'confirm_patch', patch_id: preview.patch_id },
    }), { type: 'applied', revision: 2 })

    assert.deepEqual(await server.handleToolCall('taskgraph_signal', {
      taskgraph_id: taskgraphId,
      signal: { type: 'start_graph', input: {} },
    }), { accepted: true })
    const events = await server.handleToolCall('taskgraph_events', {
      taskgraph_id: taskgraphId,
      after_seq: 0,
      limit: 100,
    }) as { events: unknown[] }
    assert.ok(events.events.length >= 2)

    // Invalid tool arguments are rejected by the shared protocol schema.
    for (const tc of taskgraphProtocolCases) {
      const mcpName = Object.entries(mcpToMethod).find(([, m]) => m === tc.method)?.[0] ?? ''
      if (!mcpName) continue
      const invalidResponse = await server.handleLine(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: mcpName, arguments: tc.invalidParams },
      }))
      assert.ok(invalidResponse?.result, `expected result for ${tc.method} invalid`)
      const invalidResult = invalidResponse.result as { isError?: boolean; content?: Array<{ text?: string }> }
      assert.equal(invalidResult.isError, true, `expected error for ${tc.method} invalid`)
      assert.match(invalidResult.content?.[0]?.text ?? '', /Invalid params/u)
    }

    // Injected router: params forwarded unchanged through MCP dispatch
    const injectedWorkspace = makeTempDir('foreman-mcp-workspace-')
    const router = new RpcRouter()
    const calls: Array<{ method: string; params: unknown }> = []
    for (const tc of taskgraphProtocolCases) {
      router.register(tc.method, async (params) => {
        calls.push({ method: tc.method, params })
        return { ok: true }
      })
    }
    const injectedServer = new ForemanMcpServer({ workspaceRoot: injectedWorkspace, rpcRouter: router }) as unknown as TestServer
    calls.length = 0
    const mcpCases = taskgraphProtocolCases
    for (const tc of mcpCases) {
      const mcpName = Object.entries(mcpToMethod).find(([, m]) => m === tc.method)?.[0] ?? ''
      try {
        await injectedServer.handleToolCall(mcpName, tc.legalParams as Record<string, unknown>)
      } catch {
        // Expected: result validation rejects { ok: true }, but handler was called
      }
    }
    assert.equal(calls.length, mcpCases.length)
    for (let i = 0; i < calls.length; i++) {
      assert.equal(calls[i].method, mcpCases[i].method)
      assert.deepEqual(calls[i].params, mcpCases[i].legalParams)
    }
  })

  it('send_message is a unified MCP tool backed by the RPC router', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const calls: unknown[] = []
    const router = new RpcRouter()
    router.register('message.send', async (params, _message, context) => {
      calls.push({ params, context })
      return { accepted: true, message_id: 'msg_test', delivery: { ok: true } }
    })
    const server = new ForemanMcpServer({
      workspaceRoot: workspace,
      rpcRouter: router,
    }) as unknown as TestServer

    const result = await server.handleToolCall('send_message', {
      to: 'foreman-work',
      text: 'hello work',
    }, {
      sender: { role: 'relay' },
    })

    assert.deepEqual(calls, [{
      params: { to: 'foreman-work', text: 'hello work' },
      context: { sender: { role: 'relay' }, transport: 'mcp' },
    }])
    assert.deepEqual(result, {
      accepted: true,
      message_id: 'msg_test',
      delivery: { ok: true },
    })

    const initialized = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      result?: {
        serverInfo?: {
          name?: string
        }
      }
    } | null
    assert.equal(initialized?.result?.serverInfo?.name, 'foreman')
  })

  it('send_message explains unified MCP sender configuration when sender metadata is missing', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const server = new ForemanMcpServer({ workspaceRoot: workspace }) as unknown as TestServer

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'send_message',
        arguments: { to: 'foreman-work', text: 'hello without sender' },
      },
    }))

    assert.equal(response?.result && typeof response.result === 'object', true)
    const result = response?.result as { isError?: boolean; content?: Array<{ text?: string }> }
    assert.equal(result.isError, true)
    assert.match(result.content?.[0]?.text ?? '', /from principal/)
  })



  it('does not expose legacy generated task wrappers', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    writeTask(workspaceProject, 'echo')
    writeTask(workspaceProject, 'run_echo')
    writeFmproj(workspace, 'app')

    const server = makeServer(workspace)
    await server.handleToolCall('task_list', { project: 'app' })
    const toolNames = server.toolDefinitions().map((tool) => tool.name)

    assert.equal(toolNames.includes('task_echo'), false)
    assert.equal(toolNames.includes('task_run_echo'), false)
    assert.equal(toolNames.includes('foreman_task_echo'), false)
    assert.equal(toolNames.includes('foreman_task_run_echo'), false)
  })


  it('lists .task.ts files and rejects standalone task without service supervisor', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    writeTask(workspaceProject, 'echo')
    const server = makeServer(workspace)

    const listed = await server.handleToolCall('task_list', { project: 'app' }) as { tasks?: Array<{ name: string; source: string; project?: string }> }
    assert.ok(listed.tasks?.some((task) => task.source === 'project' && task.project === 'app' && task.name === 'echo'))

    await assert.rejects(
      () => server.handleToolCall('task_run', {
        task_id: 'echo',
        project: 'app',
        input: { text: 'hello' },
      }),
      /requires a daemon-owned task workflow runner/u,
    )
  })

  it('returns fuzzy project suggestions through task tools', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    writeFmproj(workspace, 'ure/knowledge')
    const server = makeServer(workspace)

    await assert.rejects(
      () => server.handleToolCall('task_list', { project: 'knowledge' }),
      /Did you mean: ure\/knowledge/u,
    )
  })

  it('does not generate workspace task wrappers', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    writeFileSync(
      join(workspaceProject, 'project-aware.task.ts'),
      `export default defineTask({
  profile: 'test-profile',
  permission: 'readonly',
  description: 'task with project in payload',
  input: foremanSchemas.z.object({
    issue: foremanSchemas.z.string(),
    project: foremanSchemas.z.string().describe('payload target project label'),
  }),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }).strict(),
  prompt: ({ issue, project }) => \`Project \${project}: \${issue}\`,
})
`,
      'utf-8',
    )
    const server = makeServer(workspace)

    const response = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    const tools = (response?.result as { tools: Array<{ name: string; inputSchema?: { required?: string[]; properties?: Record<string, unknown> } }> }).tools
    const tool = tools.find((entry) => entry.name === 'task_project-aware')

    assert.equal(tool, undefined)
    assert.equal(tools.some((entry) => entry.name === 'foreman_task_project-aware'), false)
  })

  it('task_run returns task run ids and keeps output behind task_output', async () => {
    initTestDb()
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    writeTask(workspaceProject, 'echo')
    installRunnerSupervisor({
      async startExecution(opts: { prompt: string }) {
        return {
          executionId: 'exec_test_echo',
          async wait() {
            return {
              executionId: 'exec_test_echo',
              status: 'done' as const,
              output: deliveryOutput({ result: 'Task says: hello' }, 'Echoed hello.'),
            }
          },
          async cancel() {},
        }
      },
      getExecution() {
        return undefined
      },
    } as never)
    const server = makeServer(workspace)

    const result = await server.handleToolCall('task_run', {
      project: 'app',
      task_id: 'echo',
      input: { text: 'hello' },
    }) as { id?: string; task_run_id?: string; task_id?: string; status?: string; status_tool?: string; output_tool?: string; output?: string; hint?: string }

    assert.match(result.task_run_id ?? '', /^task_/u)
    assert.equal(result.id, result.task_run_id)
    assert.equal(result.task_id, undefined)
    assert.equal(result.status, undefined)
    assert.equal(result.status_tool, undefined)
    assert.equal(result.output_tool, undefined)
    assert.equal(result.output, undefined)
    assert.match(result.hint ?? '', /task_status/u)
    assert.match(result.hint ?? '', /task_output/u)
    assert.match(result.hint ?? '', /Do not poll repeatedly/u)

    const status = await waitForTaskStatus(server, result.task_run_id ?? '') as { status?: string; output?: string; has_output?: boolean }
    assert.equal(status.status, 'done')
    assert.equal(status.output, undefined)
    assert.equal(status.has_output, true)

    const output = await server.handleToolCall('task_output', { task_run_id: result.task_run_id }) as {
      output?: Record<string, unknown>
      status?: string
      summary?: string
    }
    assert.equal(output.status, 'done')
    assert.equal(output.summary, 'Echoed hello.')
    assert.deepEqual(output.output, { result: 'Task says: hello' })
  })


  it('stores requested execute project for a generic workspace task run', async () => {
    initTestDb()
    const workspace = makeTempDir('foreman-mcp-workspace-task-')
    const workspaceProject = writeProjectDefinitions(workspace)
    const appHostDir = makeTempDir('foreman-mcp-app-host-')
    writeFmproj(workspace, 'app', { hostPath: appHostDir })
    writeTask(workspaceProject, 'echo')
    const seenCwds: string[] = []
    installRunnerSupervisor({
      async startExecution(opts: { prompt: string; cwd?: string }) {
        seenCwds.push(opts.cwd ?? '')
        return {
          executionId: 'exec_generic_workspace_task',
          async wait() {
            return {
              executionId: 'exec_generic_workspace_task',
              status: 'done' as const,
              output: deliveryOutput({ result: 'Task says: hi' }, 'Echoed.'),
            }
          },
          async cancel() {},
        }
      },
      getExecution() {
        return undefined
      },
    } as never)
    const server = makeServer(workspace)

    const result = await server.handleToolCall('task_run', {
      project: 'app',
      task_id: 'echo',
      input: { text: 'hi' },
    }) as { task_run_id?: string }

    assert.match(result.task_run_id ?? '', /^task_/u)
    const status = await waitForTaskStatus(server, result.task_run_id ?? '') as { status?: string }
    assert.equal(status.status, 'done')

    const rows = dbQuery<{ project: string }>(
      'SELECT project FROM tasks WHERE id = ?',
      result.task_run_id ?? '',
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].project, 'app')
    assert.equal(seenCwds.length, 1)
    assert.equal(seenCwds[0], appHostDir)
  })

  it('rejects standalone structured task without service supervisor', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    writeStructuredTask(workspaceProject, 'classify')
    const server = makeServer(workspace)

    await assert.rejects(
      () => server.handleToolCall('task_run', {
        task_id: 'classify',
        project: 'app',
        input: { text: 'hello' },
      }),
      /requires a daemon-owned task workflow runner/u,
    )
  })

  it('validates task project before requiring the service supervisor', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    mkdirSync(join(workspace, 'projects', 'docs'), { recursive: true })
    writeTask(workspaceProject, 'echo')
    const server = makeServer(workspace)

    await assert.rejects(
      () => server.handleToolCall('task_run', {
        task_id: 'echo',
        project: 'missing/docs',
        input: { text: 'hello' },
      }),
      /Project 'missing\/docs' is not registered/u,
    )
  })

  it('explains that projects without .fmproj git.remote cannot create worktrees', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    writeFmproj(workspace, 'docs')
    const server = makeServer(workspace)

    await assert.rejects(
      () => server.handleToolCall('worktree_create', { project: 'docs' }),
      /Project "docs" does not declare git\.remote in its \.fmproj metadata/u,
    )
  })

  it('dispatches worktree_merge through the managed worktree core', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    writeFmproj(workspace, 'app', { git: true })
    const server = makeServer(workspace)

    const result = await server.handleToolCall('worktree_merge', {
      project: 'app',
      worktree_id: 'deadbeef',
    }) as { project?: string; worktree_id?: string; merged?: boolean; removed?: boolean; reason?: string; error?: string }

    assert.deepEqual(result, {
      project: 'app',
      worktree_id: 'deadbeef',
      merged: false,
      removed: false,
      reason: 'worktree_metadata_missing',
      error: "Worktree 'deadbeef' metadata was not found",
    })
  })

  it('dispatches local project MCP tools through the RpcRouter protocol layer', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const router = new RpcRouter()
    const calls: Array<{ method: string; params: unknown }> = []
    router.register('project.status', async (params) => {
      calls.push({ method: 'project.status', params })
      return { name: params.project ?? 'all', path: '/tmp/app', worktrees: [] }
    })
    router.register('project.worktree.create', async (params) => {
      calls.push({ method: 'project.worktree.create', params })
      return {
        project: params.project,
        worktree_id: params.worktree_id ?? 'feedbeef',
        path: '/tmp/wt',
        branch: params.branch ?? 'wrenyard/feedbeef',
      }
    })
    router.register('project.worktree.remove', async (params) => {
      calls.push({ method: 'project.worktree.remove', params })
      return {
        worktree_id: params.worktree_id,
        removed: true,
        project: params.project,
        path: '/tmp/wt',
      }
    })
    router.register('project.push', async (params) => {
      calls.push({ method: 'project.push', params })
      return {
        pushed: true,
        project: params.project,
        worktree_id: params.worktree_id,
        summary: 'pushed',
      }
    })
    const server = new ForemanMcpServer({ workspaceRoot: workspace, rpcRouter: router }) as unknown as TestServer

    assert.deepEqual(await server.handleToolCall('status', { project: 'app' }), {
      name: 'app',
      path: '/tmp/app',
      worktrees: [],
    })
    assert.deepEqual(await server.handleToolCall('worktree_create', {
      project: 'app',
      branch: 'feature/test',
    }), {
      project: 'app',
      worktree_id: 'feedbeef',
      path: '/tmp/wt',
      branch: 'feature/test',
    })
    assert.deepEqual(await server.handleToolCall('worktree_remove', {
      project: 'app',
      worktree_id: 'deadbeef',
    }), {
      worktree_id: 'deadbeef',
      removed: true,
      project: 'app',
      path: '/tmp/wt',
    })

    assert.deepEqual(await server.handleToolCall('git_push', {
      project: 'app',
      worktree_id: 'deadbeef',
    }), {
      pushed: true,
      project: 'app',
      worktree_id: 'deadbeef',
      summary: 'pushed',
    })
    assert.deepEqual(calls, [
      { method: 'project.status', params: { project: 'app' } },
      { method: 'project.worktree.create', params: { project: 'app', branch: 'feature/test' } },
      { method: 'project.worktree.remove', params: { project: 'app', worktree_id: 'deadbeef' } },
      { method: 'project.push', params: { project: 'app', worktree_id: 'deadbeef' } },
    ])
  })

  it('dispatches pm.ticket MCP tools through the RpcRouter protocol layer', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const router = new RpcRouter()
    const calls: Array<{ method: string; params: unknown }> = []
    router.register('pm.ticket.create', async (params) => {
      calls.push({ method: 'pm.ticket.create', params })
      return { ticket: { id: 'pm_abc', kind: 'main', project_id: 'foreman', title: 'Test', status: 'todo', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' } }
    })
    router.register('pm.ticket.get', async (params) => {
      calls.push({ method: 'pm.ticket.get', params })
      return { ticket: { id: params.id, kind: 'main', project_id: 'foreman', title: 'Test', status: 'todo', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' } }
    })
    router.register('pm.ticket.list', async (params) => {
      calls.push({ method: 'pm.ticket.list', params })
      return { tickets: [], count: 0 }
    })
    router.register('pm.ticket.update', async (params) => {
      calls.push({ method: 'pm.ticket.update', params })
      return { ticket: { id: 'pm_abc', kind: 'main', project_id: 'foreman', title: 'Updated', status: 'in_progress', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' } }
    })
    router.register('pm.ticket.delete', async (params) => {
      calls.push({ method: 'pm.ticket.delete', params })
      return { deleted: true, id: params.id }
    })
    const server = new ForemanMcpServer({ workspaceRoot: workspace, rpcRouter: router }) as unknown as TestServer

    const createResult = await server.handleToolCall('pm_ticket_create', {
      kind: 'main',
      project_id: 'foreman',
      title: 'Test ticket',
    }) as { ticket?: { id?: string } }
    assert.ok(createResult.ticket?.id)

    const getResult = await server.handleToolCall('pm_ticket_get', { id: 'pm_abc' }) as { ticket?: { id?: string } }
    assert.equal(getResult.ticket?.id, 'pm_abc')

    const listResult = await server.handleToolCall('pm_ticket_list', { project_id: 'foreman' }) as { tickets?: unknown[]; count?: number }
    assert.deepEqual(listResult.tickets, [])
    assert.equal(listResult.count, 0)

    const updateResult = await server.handleToolCall('pm_ticket_update', { id: 'pm_abc', action: 'set_status', status: 'in_progress' }) as { ticket?: { title?: string; status?: string } }
    assert.equal(updateResult.ticket?.status, 'in_progress')

    const deleteResult = await server.handleToolCall('pm_ticket_delete', { id: 'pm_abc' }) as { deleted?: boolean; id?: string }
    assert.equal(deleteResult.deleted, true)
    assert.equal(deleteResult.id, 'pm_abc')

    assert.deepEqual(calls, [
      { method: 'pm.ticket.create', params: { kind: 'main', project_id: 'foreman', title: 'Test ticket' } },
      { method: 'pm.ticket.get', params: { id: 'pm_abc' } },
      { method: 'pm.ticket.list', params: { project_id: 'foreman' } },
      { method: 'pm.ticket.update', params: { id: 'pm_abc', action: 'set_status', status: 'in_progress' } },
      { method: 'pm.ticket.delete', params: { id: 'pm_abc' } },
    ])

    // schema exposes required project_id/title fields for create
    const defs = server.toolDefinitions()
    const createTool = defs.find((t) => t.name === 'pm_ticket_create')
    assert.ok(createTool?.inputSchema?.required?.includes('project_id'))
    assert.ok(createTool?.inputSchema?.required?.includes('title'))

    const listTool = defs.find((t) => t.name === 'pm_ticket_list')
    assert.ok(listTool?.inputSchema?.required?.includes('project_id'))
  })

  it('validates project names before MCP tool processing and suggests close matches', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    writeProjectDefinitions(workspace)
    writeFmproj(workspace, 'foreman')
    writeFmproj(workspace, 'forge')
    const server = makeServer(workspace)

    for (const name of ['status', 'worktree_create', 'worktree_remove'] as const) {
      await assert.rejects(
        () => server.handleToolCall(name, { project: 'foremn', worktree_id: 'deadbeef' }),
        /Project 'foremn' is not registered/u,
      )
    }
    const pushResult = await server.handleToolCall('git_push', { project: 'foremn' }) as {
      project?: string
      pushed?: boolean
      reason?: string
      error?: string
      summary?: string
    }
    assert.equal(pushResult.project, 'foremn')
    assert.equal(pushResult.pushed, false)
    assert.equal(pushResult.reason, 'project_missing')
    assert.match(pushResult.error ?? '', /Project 'foremn' is not registered/u)
    assert.equal(pushResult.summary, 'Push failed for project foremn: project_missing.')
    const mergeResult = await server.handleToolCall('worktree_merge', { project: 'foremn', worktree_id: 'deadbeef' }) as {
      project?: string
      worktree_id?: string
      merged?: boolean
      removed?: boolean
      reason?: string
      error?: string
    }
    assert.equal(mergeResult.project, 'foremn')
    assert.equal(mergeResult.worktree_id, 'deadbeef')
    assert.equal(mergeResult.merged, false)
    assert.equal(mergeResult.removed, false)
    assert.equal(mergeResult.reason, 'project_missing')
    assert.match(mergeResult.error ?? '', /Project 'foremn' is not registered/u)
  })

  it('rejects invalid task input before dispatch', async () => {
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    writeTask(workspaceProject, 'echo')
    const server = makeServer(workspace)

    const result = await server.handleToolCall('task_run', {
      task_id: 'echo',
      project: 'app',
      input: { text: 123 },
    }) as { error_type?: string; errors?: string[] }

    assert.equal(result.error_type, 'input_validation_failed')
    assert.match(result.errors?.join('\n') ?? '', /must be string/u)
  })


  it('task_cancel marks active task as cancelled and prevents late overwrite', async () => {
    initTestDb()
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    writeTask(workspaceProject, 'echo')
    installRunnerSupervisor({
      async startExecution() {
        return {
          executionId: 'exec_cancel_test',
          async wait() {
            await sleep(200)
            return {
              executionId: 'exec_cancel_test',
              status: 'done' as const,
              output: deliveryOutput({ result: 'completed late' }, 'Late completion after cancel.'),
            }
          },
          async cancel() {},
        }
      },
      getExecution() { return undefined },
    } as never)
    const server = makeServer(workspace)

    const runResult = await server.handleToolCall('task_run', {
      project: 'app',
      task_id: 'echo',
      input: { text: 'hello' },
    }) as { task_run_id?: string; task_id?: string }

    const taskRunId = runResult.task_run_id ?? ''
    assert.match(taskRunId, /^task_/u)
    assert.equal(runResult.task_id, undefined)

    const cancelResult = await server.handleToolCall('task_cancel', {
      task_run_id: taskRunId,
    }) as { ok?: boolean; status?: string; task_run_id?: string; task_id?: string }

    assert.equal(cancelResult.ok, true)
    assert.equal(cancelResult.status, 'cancelled')
    assert.equal(cancelResult.task_run_id, taskRunId)
    assert.equal(cancelResult.task_id, undefined)

    // Wait for async execution to complete (agent 200ms sleep + processing) so
    // the late-path updateTaskRowTerminal has a chance to fire. The WHERE guard
    // on cancelled/interrupted rows must prevent the overwrite.
    await sleep(500)

    const statusResult = await server.handleToolCall('task_status', { task_run_id: taskRunId }) as { status?: string; error?: string }
    assert.equal(statusResult.status, 'cancelled', 'task must remain cancelled after late agent completion')
    assert.equal(statusResult.error, 'Task run cancelled', 'cancellation marker must be recorded in error field')

    const events = dbQuery<{ type: string }>(
      `SELECT type FROM events WHERE task_id = ? ORDER BY rowid`,
      taskRunId,
    )
    assert.deepEqual(events
      .map((event) => event.type)
      .filter((type) => type === 'task.started'), ['task.started'])
  })

  it('task_cancel returns ok when supervisor cancellation wins the race', async () => {
    initTestDb()
    const workspace = makeTempDir('foreman-mcp-workspace-')
    writeProjectDefinitions(workspace)
    const now = new Date().toISOString()
    dbRun(
      `INSERT INTO executions (
        id, task_id, profile, permission, cwd, prompt, status, created_at, updated_at
      ) VALUES ('exec_cancel_race', NULL, 'test-profile', 'readonly', ?, 'prompt', 'running', ?, ?)`,
      workspace,
      now,
      now,
    )
    dbRun(
      `INSERT INTO tasks (
        id, template, project, input, status, structured, execution_id, created_at, updated_at
      ) VALUES ('task_cancel_race', 'echo', 'workspace', '{}', 'running', 1, 'exec_cancel_race', ?, ?)`,
      now,
      now,
    )
    installRunnerSupervisor({
      async cancelExecution(executionId: string) {
        assert.equal(executionId, 'exec_cancel_race')
        const endedAt = new Date().toISOString()
        dbRun(
          `UPDATE tasks
          SET status = 'cancelled', error = 'cancelled by supervisor', ended_at = ?, updated_at = ?
          WHERE id = 'task_cancel_race' AND status IN ('queued', 'running')`,
          endedAt,
          endedAt,
        )
        dbRun(
          `UPDATE executions
          SET status = 'cancelled', error = 'cancelled by supervisor', kill_reason = 'cancel', ended_at = ?, updated_at = ?
          WHERE id = 'exec_cancel_race' AND status IN ('queued', 'running', 'starting')`,
          endedAt,
          endedAt,
        )
      },
      async startExecution() {
        throw new Error('not used')
      },
      getExecution() {
        return undefined
      },
    } as never)
    const server = makeServer(workspace)

    const result = await server.handleToolCall('task_cancel', {
      task_run_id: 'task_cancel_race',
    }) as { ok?: boolean; status?: string; message?: string }

    assert.equal(result.ok, true)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.message, undefined)

    // A successful cancel must leave both the task and its linked execution cancelled,
    // with no active execution remaining.
    const taskRow = dbQuery<{ status: string }>(
      `SELECT status FROM tasks WHERE id = 'task_cancel_race'`,
    )[0]
    assert.equal(taskRow?.status, 'cancelled', 'linked task must be cancelled')

    const execRow = dbQuery<{ status: string }>(
      `SELECT status FROM executions WHERE id = 'exec_cancel_race'`,
    )[0]
    assert.equal(execRow?.status, 'cancelled', 'linked execution must be cancelled')

    const activeCount = dbQuery<{ c: number }>(
      `SELECT COUNT(*) AS c FROM executions WHERE status IN ('queued', 'running', 'starting')`,
    )[0]?.c ?? 0
    assert.equal(activeCount, 0, 'no active execution should remain')
  })

  it('task_cancel errors surface as MCP tool errors', async () => {
    initTestDb()
    const workspace = makeTempDir('foreman-mcp-workspace-')
    writeProjectDefinitions(workspace)
    const server = makeServer(workspace)

    const response = await server.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'task_cancel',
        arguments: { task_run_id: 'task_missing' },
      },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } } | null

    assert.equal(response?.result?.isError, true)
    assert.match(response?.result?.content?.[0]?.text ?? '', /requires a daemon-owned task workflow runner/u)
  })

  it('persists stopped agent results as cancelled task runs', async () => {
    initTestDb()
    const workspace = makeTempDir('foreman-mcp-workspace-')
    const workspaceProject = writeProjectDefinitions(workspace)
    writeTask(workspaceProject, 'echo')
    installRunnerSupervisor({
      async startExecution() {
        return {
          executionId: 'exec_agent_cancelled',
          async wait() {
            return {
              executionId: 'exec_agent_cancelled',
              status: 'cancelled' as const,
              output: '',
              error: 'cancelled',
            }
          },
          async cancel() {},
        }
      },
      getExecution() {
        return undefined
      },
    } as never)
    const server = makeServer(workspace)

    const runResult = await server.handleToolCall('task_run', {
      project: 'app',
      task_id: 'echo',
      input: { text: 'hello' },
    }) as { task_run_id?: string; task_id?: string }
    const taskRunId = runResult.task_run_id ?? ''
    assert.equal(runResult.task_id, undefined)
    const status = await waitForTaskStatus(server, taskRunId) as { status?: string; error?: string }
    const events = dbQuery<{ type: string }>(
      `SELECT type FROM events WHERE task_id = ? ORDER BY rowid`,
      taskRunId,
    )

    assert.equal(status.status, 'cancelled')
    assert.match(status.error ?? '', /cancelled/u)
    assert.deepEqual(events
      .map((event) => event.type)
      .filter((type) => type === 'task.started'), ['task.started'])
  })
})
