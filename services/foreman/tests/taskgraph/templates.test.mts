import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  TASK_GRAPH_TEMPLATE_IDS,
  TaskGraphTemplateError,
  compactInstallPatchOps,
  expandTaskGraphTemplate,
  toServiceCreateParams,
} from '../../lib/core/taskgraph/index.mts'
import { taskgraphCreateParamsSchema } from '../../lib/protocol/methods/taskgraph.mts'

describe('TaskGraph create templates', () => {
  it('keeps protocol schema enum aligned with expander ids', () => {
    const schemaEnum = taskgraphCreateParamsSchema.properties.template.enum
    assert.deepEqual([...schemaEnum], [...TASK_GRAPH_TEMPLATE_IDS])
  })

  it('expands default to start → end without requiring project', () => {
    const graph = expandTaskGraphTemplate('default')
    assert.deepEqual(Object.keys(graph.nodes), ['start', 'end'])
    assert.equal(graph.nodes.start.action.type, 'start')
    assert.deepEqual(graph.nodes.start.deps, [])
    assert.equal(graph.nodes.end.action.type, 'end')
    assert.deepEqual(graph.nodes.end.deps, ['start'])
  })

  it('requires project for every task-bearing template', () => {
    for (const template of TASK_GRAPH_TEMPLATE_IDS.filter((id) => id !== 'default')) {
      assert.throws(
        () => expandTaskGraphTemplate(template),
        (error: unknown) => error instanceof TaskGraphTemplateError && error.code === 'PROJECT_REQUIRED',
      )
    }
  })

  it('rejects unknown template ids', () => {
    assert.throws(
      () => expandTaskGraphTemplate('grow'),
      (error: unknown) => error instanceof TaskGraphTemplateError && error.code === 'UNKNOWN_TEMPLATE',
    )
  })

  it('seeds parallel-explore with three explore tasks and omits params.input', () => {
    const graph = expandTaskGraphTemplate('parallel-explore', 'app')
    assert.deepEqual(Object.keys(graph.nodes), ['start', 'explore-1', 'explore-2', 'explore-3', 'end'])
    for (const id of ['explore-1', 'explore-2', 'explore-3']) {
      assert.equal(graph.nodes[id].action.type, 'task')
      assert.deepEqual(graph.nodes[id].action.params, { name: 'explore', project: 'app' })
      assert.deepEqual(graph.nodes[id].deps, ['start'])
      assert.deepEqual(graph.nodes[id].input, [])
    }
    assert.deepEqual(graph.nodes.end.deps, ['explore-1', 'explore-2', 'explore-3'])
  })

  it('wires implement as explore → edit → test', () => {
    const graph = expandTaskGraphTemplate('implement', 'app')
    assert.deepEqual(graph.nodes.explore.deps, ['start'])
    assert.deepEqual(graph.nodes.edit.deps, ['explore'])
    assert.deepEqual(graph.nodes.test.deps, ['edit'])
    assert.deepEqual(graph.nodes.end.deps, ['test'])
    assert.equal(graph.nodes.explore.action.params.name, 'explore')
    assert.equal(graph.nodes.edit.action.params.name, 'edit')
    assert.equal(graph.nodes.test.action.params.name, 'test')
  })

  it('wires closeout as test → commit → deploy without input', () => {
    const graph = expandTaskGraphTemplate('closeout', 'app')
    assert.deepEqual(graph.nodes.test.deps, ['start'])
    assert.deepEqual(graph.nodes.commit.deps, ['test'])
    assert.deepEqual(graph.nodes.deploy.deps, ['commit'])
    assert.deepEqual(graph.nodes.end.deps, ['deploy'])
    assert.equal(Object.hasOwn(graph.nodes.deploy.action.params, 'input'), false)
  })

  it('maps protocol create params onto service IR', () => {
    const params = toServiceCreateParams({
      template: 'change-test',
      project: 'app',
      title: '改一处再测',
      on_node_failure: 'pause',
    })
    assert.equal(params.project, 'app')
    assert.equal(params.title, '改一处再测')
    assert.equal(params.on_node_failure, 'pause')
    assert.ok(params.graph.nodes.edit)
    assert.ok(params.graph.nodes.test)
  })

  it('builds compact install ops as AddNode steps then ReplaceNode end', () => {
    const graph = expandTaskGraphTemplate('change-test', 'app')
    const ops = compactInstallPatchOps(graph.nodes)
    assert.deepEqual(ops.map((op) => `${op.op}:${op.node.id}`), ['AddNode:edit', 'AddNode:test', 'ReplaceNode:end'])
  })
})
