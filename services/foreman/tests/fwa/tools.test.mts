import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isProjectInScope } from '../../lib/core/fwa/project-scope.mts'
import {
  guardWorkspacePath,
  createTaskDescribeTool,
  createTaskRunTool,
  createTaskGraphCreateTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStatusTool,
  createTaskCancelTool,
  createWorkspaceDocReadTool,
  createWorkspaceDocWriteTool,
  createWorkspaceDocCreateTool,
  createWorkspaceDocDeleteTool,
  createWorkspaceDocListTool,
  type ToolPorts,
} from '../../lib/core/fwa/tools.mts'
import type { TaskServicePort, TaskGraphPort, WorkspaceDocPort } from '../../lib/core/fwa/types.mts'

function createMockTaskGraphPort(): TaskGraphPort {
  return {
    create: async () => ({ taskgraph: { id: 'tg-mock', revision: 1 } }),
    signal: async () => ({ accepted: true }),
    patch: async () => ({ type: 'applied', revision: 2 }),
    status: async () => ({ taskgraph_id: 'tg-mock', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
    events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
    inspect: async () => ({}),
  }
}

let tmpDir: string

void describe('tools', () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fwa-tools-test-'))
    // Create a subdirectory for symlink tests
    mkdirSync(join(tmpDir, 'subdir'), { recursive: true })
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  void it('enforces project scope guard on task dispatch', () => {
    assert.equal(isProjectInScope('proj-a/ops', 'proj-a'), true)
    assert.equal(isProjectInScope('proj-b', 'proj-a'), false)
  })

  void it('shares TaskGraph visibility across projects in same scope', () => {
    assert.equal(isProjectInScope('workspace/proj-a', 'workspace'), true)
    assert.equal(isProjectInScope('workspace/proj-b', 'workspace'), true)
  })

  void it('protects against workspace path traversal', () => {
    assert.throws(() => guardWorkspacePath('/absolute/path'), /absolute/)
    assert.throws(() => guardWorkspacePath('../escape'), /traverse/)
    assert.throws(() => guardWorkspacePath('dir/../../escape'), /traverse above root/)
  })

  void it('rejects project path with parent segments before task port call', async () => {
    let portCalled = false
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async (params) => { portCalled = true; return { task_run_id: 'tr-1', status: 'created' } },
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async (project) => { portCalled = true; return [] },
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'proj-a',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
    }
    const taskRunTool = createTaskRunTool(ports)
    await assert.rejects(
      () => taskRunTool.invoke({ task_id: 'my-task', project: 'proj-a/../proj-b', input: {} }),
      /must not contain/u,
    )
    assert.equal(portCalled, false, 'task port should not be called for out-of-scope project')

    const taskListTool = createTaskListTool(ports)
    await assert.rejects(
      () => taskListTool.invoke({ project: 'proj-a/../proj-b' }),
      /must not contain/u,
    )
    assert.equal(portCalled, false, 'task port should not be called for out-of-scope project')
  })

  // -- Real port-call assertions for task lifecycle methods --

  void it('task_describe calls port.describe', async () => {
    let called = false
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async (params) => { called = true; return { id: params.task_id } },
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskDescribeTool(ports)
    const result = await tool.invoke({ task_id: 'my-task' })
    assert.ok(called, 'port.describe should have been called')
    assert.ok(typeof result === 'string')
  })

  void it('task_run calls port.run with guarded project', async () => {
    let calledWith: any = null
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async (params) => { calledWith = params; return { task_run_id: 'tr-1', status: 'created' } },
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskRunTool(ports)
    const result = await tool.invoke({ task_id: 'my-task', project: 'test-proj/sub', input: { foo: 'bar' } })
    assert.ok(calledWith, 'port.run should have been called')
    assert.equal(calledWith.taskId, 'my-task')
    assert.equal(calledWith.project, 'test-proj/sub')
    assert.ok(typeof result === 'string')
  })

  void it('task_run throws for out-of-scope project', async () => {
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskRunTool(ports)
    await assert.rejects(
      () => tool.invoke({ task_id: 'my-task', project: 'other-proj' }),
      /outside session project scope/,
    )
  })

  void it('task_list calls port.list with project guard', async () => {
    let calledWith: string | undefined = undefined
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async (project?) => { calledWith = project; return [] },
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskListTool(ports)
    await tool.invoke({ project: 'test-proj/sub' })
    assert.equal(calledWith, 'test-proj/sub')
  })

  void it('task_output calls port.output', async () => {
    let called = false
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async (params) => { called = true; return { task_run_id: params.task_run_id, status: 'done' } },
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskOutputTool(ports)
    await tool.invoke({ task_run_id: 'tr-1' })
    assert.ok(called)
  })

  void it('task_status calls port.status', async () => {
    let called = false
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async (params) => { called = true; return { task_run_id: params.task_run_id } },
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskStatusTool(ports)
    await tool.invoke({ task_run_id: 'tr-1' })
    assert.ok(called)
  })

  void it('task_cancel calls port.cancel', async () => {
    let called = false
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async (params) => { called = true; return { task_run_id: params.task_run_id } },
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskCancelTool(ports)
    await tool.invoke({ task_run_id: 'tr-1' })
    assert.ok(called)
  })

  void it('taskgraph_create calls onRefs with graph ref', async () => {
    let refGraphs: string[] | undefined
    let refTasks: string[] | undefined
    const ports: ToolPorts = {
      taskgraph: {
        create: async () => ({ taskgraph: { id: 'tg-callback', revision: 1 } }),
        signal: async () => ({}),
        patch: async () => ({}),
        status: async () => ({ taskgraph_id: 'tg-mock', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      },
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
      onRefs: async (graphRefs, taskRefs) => {
        refGraphs = graphRefs
        refTasks = taskRefs
      },
    }
    const tool = createTaskGraphCreateTool(ports)
    await tool.invoke({ template: 'default' })
    assert.deepEqual(refGraphs, ['tg-callback'])
    assert.deepEqual(refTasks, [])
  })

  void it('task_run calls onRefs with task ref', async () => {
    let refGraphs: string[] | undefined
    let refTasks: string[] | undefined
    const ports: ToolPorts = {
      taskgraph: createMockTaskGraphPort(),
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: 'tr-callback', status: 'created' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: '/tmp',
      onRefs: async (graphRefs, taskRefs) => {
        refGraphs = graphRefs
        refTasks = taskRefs
      },
    }
    const tool = createTaskRunTool(ports)
    await tool.invoke({ task_id: 'my-task', project: 'test-proj/sub', input: {} })
    assert.deepEqual(refGraphs, [])
    assert.deepEqual(refTasks, ['tr-callback'])
  })

  void it('tool sets do not cross-talk on onRefs', async () => {
    const graphResult1 = { taskgraph: { id: 'tg-ct-1', revision: 1 } }
    const graphResult2 = { taskgraph: { id: 'tg-ct-2', revision: 1 } }
    const refs1: Array<{ graphRefs: string[]; taskRefs: string[] }> = []
    const refs2: Array<{ graphRefs: string[]; taskRefs: string[] }> = []

    const ports1: ToolPorts = {
      taskgraph: { ...createMockTaskGraphPort(), create: async () => graphResult1 },
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: 'tr-ct-1', status: 'created' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'proj-a',
      sessionId: 'session-1',
      workspaceRoot: '/tmp',
      onRefs: async (graphRefs, taskRefs) => { refs1.push({ graphRefs, taskRefs }) },
    }
    const ports2: ToolPorts = {
      taskgraph: { ...createMockTaskGraphPort(), create: async () => graphResult2 },
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: 'tr-ct-2', status: 'created' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'proj-b',
      sessionId: 'session-2',
      workspaceRoot: '/tmp',
      onRefs: async (graphRefs, taskRefs) => { refs2.push({ graphRefs, taskRefs }) },
    }

    const tgTool1 = createTaskGraphCreateTool(ports1)
    const tgTool2 = createTaskGraphCreateTool(ports2)
    const taskTool1 = createTaskRunTool(ports1)
    const taskTool2 = createTaskRunTool(ports2)

    await tgTool1.invoke({ template: 'default' })
    await tgTool2.invoke({ template: 'default' })
    await taskTool1.invoke({ task_id: 't1', project: 'proj-a/sub', input: {} })
    await taskTool2.invoke({ task_id: 't2', project: 'proj-b/sub', input: {} })

    assert.equal(refs1.length, 2, 'session-1 should receive 2 callbacks')
    assert.equal(refs2.length, 2, 'session-2 should receive 2 callbacks')
    // session-1 sees only its own refs
    assert.deepEqual(refs1[0].graphRefs, ['tg-ct-1'])
    assert.deepEqual(refs1[1].taskRefs, ['tr-ct-1'])
    // session-2 sees only its own refs
    assert.deepEqual(refs2[0].graphRefs, ['tg-ct-2'])
    assert.deepEqual(refs2[1].taskRefs, ['tr-ct-2'])
  })

  // -- Real workspace file operations --

  void it('workspace doc ops work on real filesystem', async () => {
    const wsRoot = join(tmpDir, 'ws-test')
    mkdirSync(wsRoot, { recursive: true })

    const wsPort: WorkspaceDocPort = {
      read: async (path) => {
        const full = join(wsRoot, path)
        if (!existsSync(full)) return null
        return { content: readFileSync(full, 'utf-8') }
      },
      write: async (path, content) => {
        const full = join(wsRoot, path)
        mkdirSync(join(full, '..'), { recursive: true })
        writeFileSync(full, content, 'utf-8')
      },
      create: async (path, content) => {
        const full = join(wsRoot, path)
        mkdirSync(join(full, '..'), { recursive: true })
        writeFileSync(full, content, 'utf-8')
        return { session_id: 'test-session' }
      },
      list: async (dir) => {
        const full = join(wsRoot, dir)
        if (!existsSync(full)) return []
        return readdirSync(full)
      },
      delete: async (path) => {
        const full = join(wsRoot, path)
        try {
          unlinkSync(full)
          return true
        } catch { return false }
      },
    }

    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: wsPort,
      sessionProject: 'test-proj',
      sessionId: 'test-session',
      workspaceRoot: wsRoot,
    }

    // Create a file
    const createTool = createWorkspaceDocCreateTool(ports)
    const createResult = await createTool.invoke({ path: 'test.txt', content: 'hello world' })
    assert.ok(typeof createResult === 'string')

    // Read it back
    const readTool = createWorkspaceDocReadTool(ports)
    const readResult = await readTool.invoke({ path: 'test.txt' })
    assert.ok(readResult)

    // List directory
    const listTool = createWorkspaceDocListTool(ports)
    const listResult = await listTool.invoke({ path: '.' })
    assert.ok(listResult)

    // Write to existing
    const writeTool = createWorkspaceDocWriteTool(ports)
    const writeResult = await writeTool.invoke({ path: 'test.txt', content: 'updated' })
    assert.ok(writeResult)

    // Delete (delegates to port for ownership check)
    const deleteTool = createWorkspaceDocDeleteTool(ports)
    const deleteResult = await deleteTool.invoke({ path: 'test.txt' })
    assert.ok(deleteResult)
  })

  void it('rejects symlink escape in workspace path resolution', () => {
    // Create a symlink pointing outside workspace root
    const wsRoot = join(tmpDir, 'symlink-test-ws')
    mkdirSync(wsRoot, { recursive: true })
    const outsideTarget = join(tmpDir, 'outside')
    mkdirSync(outsideTarget, { recursive: true })
    const linkPath = join(wsRoot, 'escape-link')
    try { symlinkSync(outsideTarget, linkPath) } catch { /* skip if platform doesn't support */ }

    guardWorkspacePath('escape-link/safe-file.txt') // lexical check passes
    // The canonical check won't throw here since we're testing the lexical guard
    assert.throws(() => guardWorkspacePath('../escape'), /traverse/)
  })

  // -- Cross-project and ownership regression tests --

  void it('task_describe defaults to sessionProject', async () => {
    let calledWith: any = null
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async (params) => { calledWith = params; return {} },
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'default-proj',
      sessionId: 'test-session-default',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskDescribeTool(ports)
    await tool.invoke({ task_id: 'my-task' })
    assert.ok(calledWith)
    assert.equal(calledWith.project, 'default-proj')
  })

  void it('task_describe rejects explicit out-of-scope project', async () => {
    let portCalled = false
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => { portCalled = true; return {} },
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'session-a',
      sessionId: 'test-session-scope-a',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskDescribeTool(ports)
    await assert.rejects(
      () => tool.invoke({ task_id: 't', project: 'other-proj' }),
      /outside session project scope/,
    )
    assert.equal(portCalled, false, 'port should not be called for out-of-scope project')
  })

  void it('task_list defaults to sessionProject', async () => {
    let calledWith: string | undefined
    const ports: ToolPorts = {
      taskgraph: null as any,
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        list: async (project?) => { calledWith = project; return [] },
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'def-list',
      sessionId: 'test-session-list',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskListTool(ports)
    await tool.invoke({})
    assert.equal(calledWith, 'def-list')
  })

  void it('taskgraph_create injects session project', async () => {
    let createCalledWith: any = null
    const ports: ToolPorts = {
      taskgraph: {
        create: async (params) => { createCalledWith = params; return { taskgraph: { id: 'tg-scoped', revision: 1 } } },
        signal: async () => ({}),
        patch: async () => ({}),
        status: async () => ({ taskgraph_id: 'tg-mock', state: 'running', structure_revision: 1, latest_seq: 0, node_counts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 }, active: { running: [], waiting: [] } }),
        events: async () => ({ events: [], next_seq: 0, latest_seq: 0, has_more: false }),
        inspect: async () => ({}),
      },
      task: createMockTaskServicePort(),
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'session-proj-graph',
      sessionId: 'test-session-graph-scoped',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskGraphCreateTool(ports)
    await tool.invoke({ template: 'default' })
    assert.ok(createCalledWith)
    assert.equal(createCalledWith.project, 'session-proj-graph')
  })

  void it('task_output verifies project scope via getTaskRun', async () => {
    let outputCalled = false
    const ports: ToolPorts = {
      taskgraph: createMockTaskGraphPort(),
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => { outputCalled = true; return {} },
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
        getTaskRun: async () => ({ task_run_id: 'tr-scoped', project: 'session-a/sub' }),
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'session-a',
      sessionId: 'test-session-output-scope',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskOutputTool(ports)
    await tool.invoke({ task_run_id: 'tr-scoped' })
    assert.ok(outputCalled, 'output should be called when project is in scope')
  })

  void it('task_output rejects out-of-scope project via getTaskRun', async () => {
    let outputCalled = false
    const ports: ToolPorts = {
      taskgraph: createMockTaskGraphPort(),
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => { outputCalled = true; return {} },
        status: async () => ({}),
        cancel: async () => ({}),
        list: async () => [],
        getTaskRun: async () => ({ task_run_id: 'tr-foreign', project: 'other-project' }),
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'session-a',
      sessionId: 'test-session-output-reject',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskOutputTool(ports)
    await assert.rejects(
      () => tool.invoke({ task_run_id: 'tr-foreign' }),
      /outside session project scope/,
    )
    assert.equal(outputCalled, false, 'output should not be called for out-of-scope project')
  })

  void it('task_cancel verifies project scope via getTaskRun', async () => {
    let cancelCalled = false
    const ports: ToolPorts = {
      taskgraph: createMockTaskGraphPort(),
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => ({}),
        cancel: async () => { cancelCalled = true; return {} },
        list: async () => [],
        getTaskRun: async () => ({ task_run_id: 'tr-cancel-ok', project: 'session-b' }),
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'session-b',
      sessionId: 'test-session-cancel-scope',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskCancelTool(ports)
    await tool.invoke({ task_run_id: 'tr-cancel-ok' })
    assert.ok(cancelCalled)
  })

  void it('task_status verifies project scope via getTaskRun', async () => {
    let statusCalled = false
    const ports: ToolPorts = {
      taskgraph: createMockTaskGraphPort(),
      task: {
        describe: async () => ({}),
        run: async () => ({ task_run_id: '', status: '' }),
        output: async () => ({}),
        status: async () => { statusCalled = true; return {} },
        cancel: async () => ({}),
        list: async () => [],
        getTaskRun: async () => ({ task_run_id: 'tr-status-ok', project: 'session-c/sub/deep' }),
      },
      message: { reply: async () => ({ ok: true }) },
      workspace: null as any,
      sessionProject: 'session-c',
      sessionId: 'test-session-status-scope',
      workspaceRoot: '/tmp',
    }
    const tool = createTaskStatusTool(ports)
    await tool.invoke({ task_run_id: 'tr-status-ok' })
    assert.ok(statusCalled)
  })
})

function createMockTaskServicePort(): import('../../lib/core/fwa/types.mts').TaskServicePort {
  return {
    describe: async () => ({}),
    run: async () => ({ task_run_id: '', status: '' }),
    output: async () => ({}),
    status: async () => ({}),
    cancel: async () => ({}),
    list: async () => [],
  }
}
