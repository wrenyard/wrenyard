// ─── Named TaskGraph create templates ─────────────────────────────────────────
//
// Protocol `taskgraph.create` accepts a template id, not a full IR graph.
// This module expands the six create-time templates into the existing
// service-layer graph IR (empty wiring schemas, omitted task `params.input`).
// Patch remains AddNode / RemoveNode / ReplaceNode.

import type { TaskGraphCreateParams } from './contracts.mts'
import type { JsonObject, NodeId, ObjectJsonSchema, TaskGraphNode } from './model.mts'
import type { TaskContext } from '../task/context.mts'
import { compileCompactTaskGraph } from './compile.mts'

export const TASK_GRAPH_TEMPLATE_IDS = [
  'default',
  'parallel-explore',
  'parallel-edit',
  'change-test',
  'implement',
  'closeout',
] as const

export type TaskGraphTemplateId = (typeof TASK_GRAPH_TEMPLATE_IDS)[number]

export type TaskGraphTemplateErrorCode = 'UNKNOWN_TEMPLATE' | 'PROJECT_REQUIRED'

export class TaskGraphTemplateError extends Error {
  readonly code: TaskGraphTemplateErrorCode

  constructor(code: TaskGraphTemplateErrorCode, message: string) {
    super(message)
    this.name = 'TaskGraphTemplateError'
    this.code = code
  }
}

export interface TaskGraphTemplateCreateInput {
  template: string
  project?: string
  tg_ctx?: TaskContext
  title?: string
  on_node_failure?: 'pause' | 'cancel'
}

const EMPTY_INPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const EMPTY_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

function controlNode(id: 'start' | 'end', name: string, deps: NodeId[]): TaskGraphNode {
  return {
    id,
    name,
    action: { type: id, params: {} },
    deps,
    input: [],
    input_schema: EMPTY_INPUT_SCHEMA,
    output_schema: EMPTY_OUTPUT_SCHEMA,
  }
}

function defaultGraph(): { nodes: Record<NodeId, TaskGraphNode> } {
  const nodes = Object.create(null) as Record<NodeId, TaskGraphNode>
  nodes.start = controlNode('start', '开始', [])
  nodes.end = controlNode('end', '结束', ['start'])
  return { nodes }
}

interface TemplateStep {
  id: string
  task: string
  name: string
  deps?: string[]
}

const TEMPLATE_STEPS: Record<Exclude<TaskGraphTemplateId, 'default'>, TemplateStep[]> = {
  'parallel-explore': [
    { id: 'explore-1', task: 'explore', name: '探索 1' },
    { id: 'explore-2', task: 'explore', name: '探索 2' },
    { id: 'explore-3', task: 'explore', name: '探索 3' },
  ],
  'parallel-edit': [
    { id: 'edit-1', task: 'edit', name: '编辑 1' },
    { id: 'edit-2', task: 'edit', name: '编辑 2' },
    { id: 'edit-3', task: 'edit', name: '编辑 3' },
  ],
  'change-test': [
    { id: 'edit', task: 'edit', name: '编辑' },
    { id: 'test', task: 'test', name: '测试', deps: ['edit'] },
  ],
  implement: [
    { id: 'explore', task: 'explore', name: '探索' },
    { id: 'edit', task: 'edit', name: '编辑', deps: ['explore'] },
    { id: 'test', task: 'test', name: '测试', deps: ['edit'] },
  ],
  closeout: [
    { id: 'test', task: 'test', name: '测试' },
    { id: 'commit', task: 'commit', name: '提交', deps: ['test'] },
    { id: 'deploy', task: 'deploy', name: '部署', deps: ['commit'] },
  ],
}

export function isTaskGraphTemplateId(value: string): value is TaskGraphTemplateId {
  return (TASK_GRAPH_TEMPLATE_IDS as readonly string[]).includes(value)
}

/**
 * Expand a create-time template into service-layer graph IR.
 *
 * `default` is start → end and does not require `project`. Every other
 * template seeds task nodes and therefore requires a non-empty project.
 * Task `action.params.input` is omitted so create-time payload validation
 * does not demand the definition's required fields; authors fill those
 * later with ReplaceNode.
 */
export function expandTaskGraphTemplate(
  template: string,
  project?: string,
): { nodes: Record<NodeId, TaskGraphNode> } {
  if (!isTaskGraphTemplateId(template)) {
    throw new TaskGraphTemplateError(
      'UNKNOWN_TEMPLATE',
      `unknown TaskGraph template "${template}"`,
    )
  }
  if (template === 'default') {
    return defaultGraph()
  }
  const trimmed = typeof project === 'string' ? project.trim() : ''
  if (!trimmed) {
    throw new TaskGraphTemplateError(
      'PROJECT_REQUIRED',
      `project is required for template "${template}"`,
    )
  }
  return compileCompactTaskGraph({
    project: trimmed,
    steps: TEMPLATE_STEPS[template],
  }).create.graph
}

export function toServiceCreateParams(params: TaskGraphTemplateCreateInput): TaskGraphCreateParams {
  const graph = expandTaskGraphTemplate(params.template, params.project)
  const project = typeof params.project === 'string' && params.project.trim()
    ? params.project.trim()
    : undefined
  return {
    graph,
    ...(project ? { project } : {}),
    ...(params.tg_ctx ? { tg_ctx: params.tg_ctx } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.on_node_failure ? { on_node_failure: params.on_node_failure } : {}),
  }
}

export function compactInstallPatchOps(
  nodes: Record<NodeId, TaskGraphNode>,
): Array<{ op: 'AddNode'; node: TaskGraphNode } | { op: 'ReplaceNode'; node: TaskGraphNode }> {
  const adds: Array<{ op: 'AddNode'; node: TaskGraphNode }> = []
  let endNode: TaskGraphNode | undefined
  for (const node of Object.values(nodes)) {
    if (node.id === 'start') continue
    if (node.id === 'end') {
      endNode = node
      continue
    }
    adds.push({ op: 'AddNode', node })
  }
  return endNode ? [...adds, { op: 'ReplaceNode', node: endNode }] : adds
}
