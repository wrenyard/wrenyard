import type { LedgerEvent } from '@wrenyard/session';
import { isHiddenCallRole } from '../../session/model/describe.js';
import type { CallModel } from '../../session/model/types.js';

export type TraceKind = 'turn' | 'step' | 'reasoning' | 'auxiliary' | 'task' | 'action' | 'content' | 'notice' | 'session';
export interface TraceNode {
  key: string;
  kind: TraceKind;
  label: string;
  status: string;
  id?: string;
  parentId?: string;
  seq: number;
  endSeq?: number;
  startAt?: string;
  endAt?: string;
  model?: string;
  tokens?: { input: number; cached: number; output: number; reasoning: number };
  events: LedgerEvent[];
  children: TraceNode[];
  running: boolean;
}
export interface TraceSummary {
  turns: number;
  reasoning: number;
  auxiliary: number;
  tasks: number;
  actions: number;
  errors: number;
  warnings: number;
  usage: { input: number; cached: number; output: number; reasoning: number };
  startedAt?: string;
  endedAt?: string;
  running: boolean;
}
export interface TraceModel { root: TraceNode; summary: TraceSummary; events: LedgerEvent[] }

type MutableNode = TraceNode & { parentKey?: string };
const usageZero = () => ({ input: 0, cached: 0, output: 0, reasoning: 0 });

function eventRecord(event: LedgerEvent): Record<string, unknown> { return event as unknown as Record<string, unknown>; }
function stringField(event: LedgerEvent, key: string): string | undefined {
  const value = eventRecord(event)[key];
  return typeof value === 'string' ? value : undefined;
}
function usageFor(event: LedgerEvent) {
  const metrics = eventRecord(event).metrics as { usage?: Record<string, unknown> } | undefined;
  const usage = metrics?.usage;
  return {
    input: Number(usage?.inputTokens ?? 0), cached: Number(usage?.cachedInputTokens ?? 0),
    output: Number(usage?.outputTokens ?? 0), reasoning: Number(usage?.reasoningTokens ?? 0),
  };
}
function eventLabel(event: LedgerEvent): string {
  const record = eventRecord(event);
  switch (event.type) {
    case 'turn.started': return `用户：${event.text.slice(0, 90) || '空消息'}`;
    case 'step.started': return `第 ${event.step ?? '?'} 步推理`;
    case 'action.started': return `${event.action.type} · ${event.action.prompt.slice(0, 90)}`;
    case 'action.finished': return `行动结果 · ${event.action.type}`;
    case 'span.started': return event.kind === 'task' ? `任务 · ${event.request.task}` : `${event.kind === 'reasoning' ? '推理' : event.request.role ?? '辅助任务'} · ${event.request.model}`;
    case 'span.finished': return `执行记录 · ${event.kind}`;
    case 'reasoning.completed': return `推理输出 · ${event.text.slice(0, 90)}`;
    case 'reply.sent': return `回复 · ${event.text.slice(0, 90)}${event.source === undefined ? '' : ` · ${event.source}`}`;
    case 'system.error': case 'system.warning': case 'system.info': return event.message.slice(0, 100);
    case 'document.content': return `文档 · ${event.title || event.path}`;
    case 'document.found': return `文档检索 · ${event.understanding.slice(0, 90)}`;
    case 'memory.recalled': return `记忆 · ${event.path}`;
    case 'files.attached': return `附件 · ${event.files.length} 个文件`;
    case 'workspace.changed': return `工作区 · ${event.change} · ${event.target}`;
    case 'turn.finished': return `轮次结束 · ${event.status}`;
    case 'turn.interrupted': return `轮次中断 · ${event.reason}`;
    default: return String(record.type ?? event.type);
  }
}

/** Purely folds a ledger snapshot into an id/parent-linked, seq-ordered tree. */
export function buildTrace(input: readonly LedgerEvent[]): TraceModel {
  const events = [...input].sort((a, b) => a.seq - b.seq);
  const root: MutableNode = { key: 'session', kind: 'session', label: '会话', status: '完成', seq: 0, events: [], children: [], running: false };
  const nodes = new Map<string, MutableNode>([['session', root]]);
  const byId = new Map<string, MutableNode>();
  const parentByKey = new Map<string, string>();
  const hiddenSpanIds = new Set<string>();
  const latestTurn = [...events].reverse().find((event) => event.type === 'turn.started')?.turn;
  const sessionRunning = latestTurn !== undefined && !events.some((event) => (event.type === 'turn.finished' || event.type === 'turn.interrupted') && event.turn === latestTurn);
  root.running = sessionRunning;
  root.status = sessionRunning ? '运行中' : '完成';

  const ensure = (key: string, kind: TraceKind, label: string, parentKey: string, seq: number, fields: Partial<TraceNode> = {}) => {
    let node = nodes.get(key);
    if (!node) {
      node = { key, kind, label, status: '未结束', seq, events: [], children: [], running: false, ...fields };
      nodes.set(key, node);
      parentByKey.set(key, parentKey);
    }
    return node;
  };
  for (const event of events) {
    if (event.type === 'session.created') { root.events.push(event); continue; }
    const turn = event.turn;
    let turnNode: MutableNode | undefined;
    if (turn !== undefined) turnNode = ensure(`turn:${turn}`, 'turn', `轮次 ${turn}`, 'session', event.seq, { id: `t${turn}`, startAt: undefined, status: '未结束' });
    if (event.type === 'turn.started') {
      turnNode = ensure(`turn:${event.turn}`, 'turn', `轮次 ${event.turn}`, 'session', event.seq, { id: event.id, startAt: event.at, status: '运行中' });
      turnNode.startAt = event.at;
      turnNode.events.push(event); continue;
    }
    if (event.type === 'turn.finished' || event.type === 'turn.interrupted') {
      if (turnNode) { turnNode.events.push(event); turnNode.endAt = event.at; turnNode.endSeq = event.seq; turnNode.status = event.type === 'turn.finished' ? event.status : 'interrupted'; }
      continue;
    }
    if (event.type === 'step.started' || event.type === 'step.finished') {
      const stepId = stringField(event, 'id') ?? `t${turn ?? 0}.${event.step ?? 0}`;
      const parentKey = turnNode?.key ?? 'session';
      const stepNode = ensure(`step:${stepId}`, 'step', `第 ${event.step ?? '?'} 步`, parentKey, event.seq, { id: stepId, parentId: stringField(event, 'parent'), startAt: event.type === 'step.started' ? event.at : undefined, status: '运行中' });
      stepNode.events.push(event);
      if (event.type === 'step.finished') { stepNode.endAt = event.at; stepNode.endSeq = event.seq; stepNode.status = event.status; }
      continue;
    }
    if (event.type === 'action.started' || event.type === 'action.finished' || event.type === 'action.titled' || event.type === 'span.started' || event.type === 'span.finished') {
      const id = stringField(event, 'id');
      if (!id) continue;
      if (event.type === 'span.started' && event.kind === 'auxiliary' && isHiddenCallRole(event.request.role as CallModel['role'])) {
        hiddenSpanIds.add(id);
        continue;
      }
      if (event.type === 'span.finished' && hiddenSpanIds.has(id)) continue;
      const start = event.type === 'action.started' || event.type === 'span.started';
      const kind: TraceKind = event.type.startsWith('action.') ? 'action' : event.type === 'span.started' ? event.kind : (byId.get(id)?.kind ?? 'auxiliary');
      const parentId = start ? stringField(event, 'parent') : undefined;
      const parentNode = parentId ? byId.get(parentId) ?? nodes.get(`step:${parentId}`) ?? nodes.get(`turn:${turn}`) ?? (event.type === 'span.started' && event.kind === 'reasoning' ? turnNode : undefined) : turnNode;
      const parentKey = parentNode?.key ?? turnNode?.key ?? 'session';
      const label = event.type === 'action.started' ? `${event.action.type} · ${event.action.prompt}` : event.type === 'action.finished' ? `${event.action.type} · ${event.result.slice(0, 80)}` : event.type === 'action.titled' ? event.title : event.type === 'span.started' ? eventLabel(event) : eventLabel(event);
      const node = ensure(`${kind}:${id}`, kind, label, parentKey, event.seq, { id, parentId: start ? parentId : byId.get(id)?.parentId, startAt: start ? event.at : undefined, model: event.type === 'span.started' && event.kind !== 'task' ? event.request.model : undefined, status: start ? '运行中' : '未结束' });
      byId.set(id, node);
      node.events.push(event);
      if (event.type === 'span.finished' && event.kind === 'task') {
        node.tokens = { ...(node.tokens ?? usageZero()), input: Number(event.metrics?.usage?.inputTokens ?? 0), cached: Number(event.metrics?.usage?.cachedInputTokens ?? 0), output: Number(event.metrics?.usage?.outputTokens ?? 0), reasoning: 0 };
      }
      if (event.type === 'action.titled') node.label = event.title;
      if (event.type === 'action.finished' || event.type === 'span.finished') {
        node.endAt = event.at; node.endSeq = event.seq; node.status = event.status;
        if (event.type === 'span.finished' && event.kind !== 'task') node.tokens = { ...(node.tokens ?? usageZero()), ...usageFor(event) };
      }
      continue;
    }
    const parentId = stringField(event, 'parent');
    // Content of a hidden system span (its recalled memories, its per-request
    // context sample) stays hidden with the span instead of surfacing under the turn.
    if ((parentId !== undefined && hiddenSpanIds.has(parentId))
      || (event.type === 'span.context' && hiddenSpanIds.has(event.id))) continue;
    const parentNode = parentId ? byId.get(parentId) ?? nodes.get(`step:${parentId}`) ?? nodes.get(`turn:${turn}`) : undefined;
    const kind: TraceKind = event.type.startsWith('system.') ? 'notice' : 'content';
    const parentKey = parentNode?.key ?? (turnNode ? turnNode.key : 'session');
    const node: MutableNode = { key: `event:${event.seq}`, kind, label: eventLabel(event), status: '记录', seq: event.seq, endSeq: event.seq, startAt: event.at, events: [event], children: [], running: false, parentId };
    nodes.set(node.key, node); parentByKey.set(node.key, parentKey);
  }
  for (const [key, parentKey] of parentByKey) {
    const node = nodes.get(key);
    const parent = nodes.get(parentKey) ?? root;
    if (node && node !== parent && !parent.children.includes(node)) parent.children.push(node);
  }
  for (const node of nodes.values()) if (!node.endAt) {
    node.running = sessionRunning;
    node.status = sessionRunning ? '运行中' : '未结束';
  }
  const sortTree = (node: MutableNode) => { node.children.sort((a, b) => a.seq - b.seq); for (const child of node.children as MutableNode[]) sortTree(child); };
  sortTree(root);
  const spanNodes = [...nodes.values()].filter((node) => node.kind === 'reasoning' || node.kind === 'auxiliary' || node.kind === 'task');
  const summary: TraceSummary = {
    turns: [...nodes.values()].filter((node) => node.kind === 'turn').length,
    reasoning: spanNodes.filter((node) => node.kind === 'reasoning').length,
    auxiliary: spanNodes.filter((node) => node.kind === 'auxiliary').length,
    tasks: spanNodes.filter((node) => node.kind === 'task').length,
    actions: [...nodes.values()].filter((node) => node.kind === 'action').length,
    errors: events.filter((event) => event.type === 'system.error').length,
    warnings: events.filter((event) => event.type === 'system.warning').length,
    usage: usageZero(), startedAt: events[0]?.at, endedAt: events.at(-1)?.at, running: sessionRunning,
  };
  // Aggregate usage still counts hidden system spans: only their named rows are hidden.
  for (const event of events) {
    if (event.type !== 'span.finished') continue;
    const usage = usageFor(event);
    summary.usage.input += usage.input;
    summary.usage.cached += usage.cached;
    summary.usage.output += usage.output;
    summary.usage.reasoning += usage.reasoning;
  }
  return { root, summary, events };
}
