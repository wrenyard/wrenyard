// ── Graph Slip panel (React Flow + dagre) ───────────────────────────
// Compact read-only taskgraph topology window. dagre computes the layered
// layout and React Flow owns edges, pan and zoom. Node state lives in the
// shared card/badge tokens; the area outside the cards stays transparent so
// the window remains a click-through overlay.
//
// openTranscript(nodeId, taskRunId) stays sender-owned: the slip window only
// forwards the ids it received in the current snapshot and never carries a
// graph id, list or mutation method.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import { Badge } from '@/renderer/components/ui/badge';
import { Card } from '@/renderer/components/ui/card';
import type {
  GraphSlipNodeDto,
  GraphSlipSnapshotDto,
  TaskGraphNodeState,
  TaskRunStatus,
} from '../shared/taskgraph';

interface GraphSlipApi {
  onSnapshot: (cb: (data: GraphSlipSnapshotDto) => void) => () => void;
  onError: (cb: (message: string) => void) => () => void;
  openTranscript: (nodeId: string, taskRunId: string) => Promise<void>;
  reportContentSize: (width: number, height: number) => Promise<void>;
  close: () => Promise<void>;
}

declare global {
  interface Window {
    graphSlipApi: GraphSlipApi;
  }
}

// ── Display helpers (ported from the removed graph-visuals module) ───

const DEFAULT_TASK_TITLE = '任务';

const GRAPH_STATE_LABELS: Readonly<Record<string, string>> = {
  created: '已创建',
  running: '运行中',
  paused: '已暂停',
  done: '已完成',
  cancelled: '已取消',
  stale: '已过期',
};

function graphStateLabel(state: string): string {
  return GRAPH_STATE_LABELS[state] ?? '未知';
}

const NODE_STATE_LABELS: Readonly<Record<TaskGraphNodeState, string>> = {
  planned: '计划',
  running: '运行中',
  waiting: '等待中',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
  cancelled: '已取消',
};

const TASK_STATUS_LABELS: Readonly<Record<TaskRunStatus, string>> = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/** Task run status takes display precedence over the node state. */
function statusLabel(node: GraphSlipNodeDto): string {
  const status = node.task_status;
  return status !== undefined
    ? (TASK_STATUS_LABELS[status] ?? NODE_STATE_LABELS[node.state])
    : NODE_STATE_LABELS[node.state];
}

/** Validated static task_title, then display_label, finally '任务'. */
function nodeTitle(node: GraphSlipNodeDto): string {
  return node.task_title ?? node.display_label ?? DEFAULT_TASK_TITLE;
}

function formatDurationZh(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}小时${minutes > 0 ? `${minutes}分` : ''}${seconds > 0 ? `${seconds}秒` : ''}`;
  }
  if (minutes > 0) return `${minutes}分${seconds > 0 ? `${seconds}秒` : ''}`;
  return `${seconds}秒`;
}

interface TipRow {
  label: string;
  value: string;
}

interface TipContent {
  firstLine?: string;
  rows: TipRow[];
  summary?: string;
}

/** Bounded tooltip content for a task/control node; start/end have none. */
function nodeTip(node: GraphSlipNodeDto, kind: 'task' | 'control'): TipContent | null {
  if (kind === 'control' && (node.action_type === 'start' || node.action_type === 'end')) return null;
  const label = statusLabel(node);
  const duration = node.runtime_ms !== undefined ? formatDurationZh(node.runtime_ms) : null;
  const inlineElapsed = kind === 'task' && label === '已完成' && duration !== null;
  const rows: TipRow[] = [{ label: '状态', value: inlineElapsed ? `已完成 · ${duration}` : label }];

  if (kind === 'task') {
    if (node.task_id !== undefined) rows.push({ label: '任务 ID', value: node.task_id });
    if (!inlineElapsed && duration !== null) rows.push({ label: '耗时', value: duration });
    if (node.profile !== undefined) rows.push({ label: '运行配置', value: node.profile });
    if (node.tool_call_count !== undefined) rows.push({ label: '工具调用', value: String(node.tool_call_count) });
    if (node.tps !== undefined) rows.push({ label: '输出速度', value: node.tps.toFixed(2) });
    const summary = node.state === 'done' && node.summary !== undefined
      ? node.summary.replace(/\s+/gu, ' ').trim()
      : undefined;
    return { firstLine: nodeTitle(node), rows, ...(summary !== undefined ? { summary } : {}) };
  }
  if (duration !== null) rows.push({ label: '耗时', value: duration });
  return { rows };
}

function stateTone(state: TaskGraphNodeState): string {
  switch (state) {
    case 'running': return 'border-success/60';
    case 'failed': return 'border-destructive/60';
    case 'interrupted': return 'border-warning/60';
    case 'cancelled': return 'border-destructive/50';
    case 'waiting': return 'border-warning/50';
    default: return 'border-border';
  }
}

function stateBadgeTone(state: TaskGraphNodeState): string {
  switch (state) {
    case 'running': return 'text-success';
    case 'failed': return 'text-destructive';
    case 'interrupted': return 'text-warning';
    case 'cancelled': return 'text-destructive';
    case 'waiting': return 'text-warning';
    default: return 'text-muted-foreground';
  }
}

// ── dagre layout ─────────────────────────────────────────────────────

const TASK_WIDTH = 176;
const TASK_HEIGHT = 44;
const CONTROL_SIZE = 32;

interface SlipNodeData {
  node: GraphSlipNodeDto;
  kind: 'task' | 'control';
  [key: string]: unknown;
}

type SlipFlowNode = Node<SlipNodeData>;

interface FlowLayout {
  nodes: SlipFlowNode[];
  edges: Edge[];
  width: number;
  height: number;
}

function isTask(node: GraphSlipNodeDto): boolean {
  return node.action_type === 'task';
}

function buildLayout(snapshot: GraphSlipSnapshotDto): FlowLayout {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 48, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));

  const entries = Object.values(snapshot.nodes);
  for (const node of entries) {
    const task = isTask(node);
    graph.setNode(node.id, {
      width: task ? TASK_WIDTH : CONTROL_SIZE,
      height: task ? TASK_HEIGHT : CONTROL_SIZE,
    });
  }
  for (const edge of snapshot.edges) {
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) graph.setEdge(edge.from, edge.to);
  }
  dagre.layout(graph);

  const nodes: SlipFlowNode[] = entries.map((node) => {
    const point = graph.node(node.id) as { x: number; y: number; width: number; height: number };
    const task = isTask(node);
    return {
      id: node.id,
      type: task ? 'slipTask' : 'slipControl',
      position: { x: point.x - point.width / 2, y: point.y - point.height / 2 },
      data: { node, kind: task ? 'task' : 'control' },
      draggable: false,
      selectable: false,
      connectable: false,
    };
  });

  const edges: Edge[] = snapshot.edges.map((edge) => ({
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: 'smoothstep',
    label: edge.label && edge.label !== 'data' ? edge.label : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { stroke: 'var(--color-border)' },
    selectable: false,
  }));

  const info = graph.graph() as { width?: number; height?: number };
  return { nodes, edges, width: info.width ?? 0, height: info.height ?? 0 };
}

// ── Custom nodes ─────────────────────────────────────────────────────

function NodeTooltip({ tip }: { tip: TipContent | null }): ReactElement | null {
  if (!tip) return null;
  return (
    <Card
      size="sm"
      className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden w-60 bg-popover/95 text-xs group-hover:block"
    >
      {tip.firstLine !== undefined && (
        <div className="px-3 pb-1 font-medium text-popover-foreground">{tip.firstLine}</div>
      )}
      <div className="flex flex-col gap-0.5 px-3">
        {tip.rows.map((row) => (
          <div key={row.label} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{row.label}</span>
            <span className="text-popover-foreground">{row.value}</span>
          </div>
        ))}
      </div>
      {tip.summary !== undefined && (
        <div className="mx-3 mt-1 line-clamp-8 rounded-sm border border-border bg-muted/20 p-1.5 text-popover-foreground">
          {tip.summary}
        </div>
      )}
    </Card>
  );
}

function SlipTaskNode({ data }: NodeProps): ReactElement {
  const { node } = data as unknown as SlipNodeData;
  const clickable = node.task_run_id !== undefined;
  const tip = nodeTip(node, 'task');
  return (
    <div className="group relative">
      <Card
        size="sm"
        role={clickable ? 'button' : 'graphics-symbol'}
        tabIndex={clickable ? 0 : undefined}
        aria-label={nodeTitle(node)}
        onClick={() => {
          if (clickable) void window.graphSlipApi.openTranscript(node.id, node.task_run_id!);
        }}
        onKeyDown={(event) => {
          if (!clickable) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          void window.graphSlipApi.openTranscript(node.id, node.task_run_id!);
        }}
        className={`w-44 gap-1.5 border bg-popover/95 py-2 shadow-sm ${stateTone(node.state)} ${clickable ? 'cursor-pointer' : ''}`}
      >
        <div className="flex items-center gap-1.5 px-3">
          <span className="truncate text-xs font-medium text-foreground">{nodeTitle(node)}</span>
        </div>
        <div className="flex items-center gap-1.5 px-3">
          <Badge variant="outline" className={`h-4 px-1.5 text-[10px] ${stateBadgeTone(node.state)}`}>
            {statusLabel(node)}
          </Badge>
          {node.runtime_ms !== undefined && formatDurationZh(node.runtime_ms) !== null && (
            <span className="truncate text-[10px] text-muted-foreground">{formatDurationZh(node.runtime_ms)}</span>
          )}
        </div>
      </Card>
      <NodeTooltip tip={tip} />
    </div>
  );
}

function SlipControlNode({ data }: NodeProps): ReactElement {
  const { node } = data as unknown as SlipNodeData;
  const tip = nodeTip(node, 'control');
  return (
    <div className="group relative">
      <Card
        size="sm"
        role="graphics-symbol"
        aria-label={node.action_type}
        className={`h-8 w-8 items-center justify-center border bg-popover/95 p-0 shadow-sm ${stateTone(node.state)}`}
      >
        <span className={`text-[10px] ${stateBadgeTone(node.state)}`}>{node.action_type.slice(0, 1).toUpperCase()}</span>
      </Card>
      <NodeTooltip tip={tip} />
    </div>
  );
}

const NODE_TYPES: NodeTypes = {
  slipTask: SlipTaskNode,
  slipControl: SlipControlNode,
};

// ── Panel ────────────────────────────────────────────────────────────

type SlipState = 'loading' | 'data' | 'error';

export function GraphSlip(): ReactElement {
  const [snapshot, setSnapshot] = useState<GraphSlipSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updates = useRef(0);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.slipState = 'loading';
    root.dataset.slipReady = '1';
    return () => {
      delete root.dataset.slipReady;
    };
  }, []);

  useEffect(() => {
    const api = window.graphSlipApi;
    if (!api) return;
    const disposeSnapshot = api.onSnapshot((data) => {
      setSnapshot(data);
      setError(null);
      updates.current += 1;
      document.documentElement.dataset.slipUpdates = String(updates.current);
      document.documentElement.dataset.slipState = 'data';
    });
    const disposeError = api.onError((message) => {
      setError(message);
      document.documentElement.dataset.slipState = 'error';
    });
    return () => {
      disposeSnapshot();
      disposeError();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void window.graphSlipApi.close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const layout = useMemo(() => (snapshot ? buildLayout(snapshot) : null), [snapshot]);

  useEffect(() => {
    if (!layout) return;
    void window.graphSlipApi.reportContentSize(layout.width, layout.height);
  }, [layout]);

  const state: SlipState = error ? 'error' : snapshot ? 'data' : 'loading';
  const title = snapshot?.title && snapshot.title.length > 0 ? snapshot.title : '未命名任务图';
  const graphState = snapshot?.state ?? 'stale';

  return (
    <div className="relative h-screen w-screen bg-transparent text-xs text-foreground">
      <div className="flex h-6 items-center gap-1.5 border-b border-border bg-popover/95 px-2 pr-6 [-webkit-app-region:drag]">
        <span
          role="status"
          aria-label={`任务图状态：${graphStateLabel(graphState)}`}
          title={`任务图状态：${graphStateLabel(graphState)}`}
          className={`h-2 w-2 shrink-0 rounded-full border border-foreground/35 ${graphState === 'running' ? 'bg-success' : graphState === 'paused' ? 'bg-warning' : 'bg-muted-foreground'}`}
        />
        <span
          className="flex-1 truncate font-semibold"
          title={title}
          aria-label={`任务图：${title}`}
        >
          {title}
        </span>
        <button
          type="button"
          aria-label="关闭"
          onClick={() => void window.graphSlipApi.close()}
          className="absolute right-1 top-0.5 flex h-4 w-4 items-center justify-center text-base leading-none text-muted-foreground [-webkit-app-region:no-drag] hover:text-foreground"
        >
          ×
        </button>
      </div>

      <div className="h-[calc(100vh-1.5rem)] w-full bg-transparent">
        {snapshot && (
          <ReactFlow
            nodes={layout?.nodes ?? []}
            edges={layout?.edges ?? []}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnScroll
            proOptions={{ hideAttribution: true }}
            className="bg-transparent"
          />
        )}
      </div>

      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-transparent text-muted-foreground">
          加载中…
        </div>
      )}
      {state === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-transparent px-4 text-center text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
