// ── Graph Slip panel ────────────────────────────────────────────────
// Compact read-only graph topology window. Aligns with graphSlipApi
// from graph-slip-preload.ts. No graph id query/use, no graph id in
// openTranscript calls. Pure layout/routing lives in graph-layout.ts and
// icon/language helpers in graph-visuals.ts; this module only renders.

import type { TaskGraphNodeState, GraphSlipNodeDto, GraphSlipSnapshotDto } from '../../shared/taskgraph';
import {
  layoutGraph,
  TASK_WIDTH,
  TASK_HEIGHT,
  CONTROL_SIZE,
  type EdgePoint,
  type LayoutNode,
} from './graph-layout';
import {
  controlAriaLabel,
  controlIconPaths,
  nodeTip,
  nodeTitle,
  taskAriaLabel,
  taskIconPaths,
  fitTagLabelToWidth,
  TAG_LABEL_MAX_WIDTH,
  TAG_LABEL_START_X,
  type IconPart,
  type TipContent,
} from './graph-visuals';

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

// ── State ────────────────────────────────────────────────────────────

let currentSnapshot: GraphSlipSnapshotDto | null = null;

// Revision of the last fully built or reconciled snapshot. Same-revision
// activity refreshes reconcile dynamic node fields in place so every node —
// including a hovered one — keeps its SVG DOM identity and a stationary
// pointer never leaves it; a higher revision triggers a full topology rebuild.
let lastRenderedRevision: number | null = null;
// Node id set of the last built DOM; a same-revision update is only applied
// in place when the visible node set is unchanged.
let renderedNodeIds: Set<string> | null = null;

// Snapshot refreshes that successfully reached the renderer; exposed as a
// data attribute for capture harnesses that must prove hover persistence
// across consecutive 2s refreshes.
let snapshotUpdateCount = 0;

// ── DOM refs ─────────────────────────────────────────────────────────

function getEl<T extends Element = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`#${id}`);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

const dagCanvas = getEl<SVGSVGElement>('dag-canvas');
const graphIdDisplay = getEl('graph-id-display');
const stateMark = getEl('state-mark');
const loadingEl = getEl('loading-overlay');
const errorEl = getEl('error-overlay');
const terminalEl = getEl('terminal-overlay');

function setSlipState(state: 'loading' | 'data' | 'error' | 'terminal'): void {
  document.documentElement.dataset.slipState = state;
}

// ── Header ───────────────────────────────────────────────────────────

// Chinese label map for every taskgraph state plus the stale fallback
// presentation. Every string here is user-visible (state-dot title/aria);
// the CSS state class names stay as technical identifiers.
const GRAPH_SLIP_STATE_LABELS: Readonly<Record<string, string>> = {
  created: '已创建',
  running: '运行中',
  paused: '已暂停',
  done: '已完成',
  cancelled: '已取消',
  stale: '已过期',
};

function graphSlipStateLabel(state: string): string {
  return GRAPH_SLIP_STATE_LABELS[state] ?? '未知';
}

// Fixed Chinese placeholder for a missing create-time title. Never
// exposes tg_ ids in the header.
const GRAPH_SLIP_FALLBACK_TITLE = '未命名任务图';

// Render the 24px drag header: state dot first, then the one-line title.
// Title text is set via textContent only — never innerHTML — so malformed
// daemon data cannot inject markup into the slip window.
function renderSlipHeader(data: GraphSlipSnapshotDto): void {
  const state = data.state;
  const label = graphSlipStateLabel(state);
  const dotClass = state in GRAPH_SLIP_STATE_LABELS ? state : 'stale';

  const title = typeof data.title === 'string' && data.title.length > 0
    ? data.title
    : GRAPH_SLIP_FALLBACK_TITLE;
  graphIdDisplay.textContent = title;
  graphIdDisplay.title = title;
  graphIdDisplay.setAttribute('aria-label', `任务图：${title}`);

  stateMark.className = 'state-mark';
  stateMark.classList.add(dotClass);
  stateMark.setAttribute('role', 'status');
  stateMark.setAttribute('aria-label', `任务图状态：${label}`);
  stateMark.title = `任务图状态：${label}`;
}

// ── DAG rendering ────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function createSvg<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

function fitTaskLabelText(nameEl: SVGTextElement, fullText: string): void {
  const fitted = fitTagLabelToWidth(fullText, TAG_LABEL_MAX_WIDTH, (candidate) => {
    nameEl.textContent = candidate;
    return nameEl.getComputedTextLength();
  });
  nameEl.textContent = fitted;
}

function appendIconPart(g: SVGElement, part: IconPart): void {
  const p = createSvg('path');
  p.setAttribute('d', part.d);
  if (part.fill) {
    p.setAttribute('fill', 'currentColor');
  } else {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
  }
  g.appendChild(p);
}

// Orthogonal M/V/H/V polyline from the routed edge points.
function toPath(points: EdgePoint[]): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const p = points[i];
    if (p.x === prev.x) d += ` V ${p.y}`;
    else if (p.y === prev.y) d += ` H ${p.x}`;
    else d += ` L ${p.x} ${p.y}`;
  }
  return d;
}

function renderDag(): void {
  if (!currentSnapshot) return;
  const nodeIds = new Set(Object.keys(currentSnapshot.nodes));
  if (
    lastRenderedRevision === currentSnapshot.revision &&
    renderedNodeIds !== null &&
    dagCanvas.childElementCount > 0 &&
    nodeIds.size === renderedNodeIds.size &&
    [...nodeIds].every((id) => renderedNodeIds!.has(id))
  ) {
    // Same structure revision: update the dynamic fields on the existing
    // nodes. DOM identity is preserved, so the hit element a stationary
    // pointer hovers is never replaced.
    reconcileNodeFields();
    return;
  }
  buildDagDom();
  lastRenderedRevision = currentSnapshot.revision;
  renderedNodeIds = nodeIds;
}

function buildDagDom(): void {
  if (!currentSnapshot) return;
  dagCanvas.innerHTML = '';
  const layout = layoutGraph(currentSnapshot);
  dagCanvas.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  dagCanvas.setAttribute('width', String(layout.width));
  dagCanvas.setAttribute('height', String(layout.height));
  void window.graphSlipApi.reportContentSize(layout.width, layout.height);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M0,0 L8,3 L0,6 Z');
  arrowPath.setAttribute('fill', '#8B7D6B');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  dagCanvas.appendChild(defs);

  // Orthogonal edges with one arrow marker per target. A split keeps one
  // arrow on every child drop, while a merge shares one final target drop;
  // drawing a marker for every incoming edge would stack identical arrows.
  const arrowedTargets = new Set<string>();
  for (const edge of layout.edges) {
    const g = createSvg('g');
    g.setAttribute('data-edge-id', `${edge.from}->${edge.to}`);
    g.setAttribute('data-source-id', edge.from);
    g.setAttribute('data-target-id', edge.to);
    g.setAttribute('data-edge-label', edge.label);
    g.setAttribute('role', 'graphics-symbol');

    const path = createSvg('path');
    path.setAttribute('class', 'dag-edge');
    path.setAttribute('d', toPath(edge.points));
    if (!arrowedTargets.has(edge.to)) {
      path.setAttribute('marker-end', 'url(#arrowhead)');
      arrowedTargets.add(edge.to);
    }
    g.appendChild(path);
    dagCanvas.appendChild(g);
  }

  // 3px ink solder dots at collapsed join/fanout split/merge junctions.
  for (const junction of layout.junctions) {
    const dot = createSvg('circle');
    dot.setAttribute('class', 'dag-solder');
    dot.setAttribute('cx', String(junction.x));
    dot.setAttribute('cy', String(junction.y));
    dot.setAttribute('r', '1.5');
    dagCanvas.appendChild(dot);
  }

  for (const ln of layout.nodes) {
    const node = currentSnapshot.nodes[ln.id];
    if (!node) continue;
    if (ln.kind === 'task') renderTaskNode(ln, node);
    else renderControlNode(ln, node);
  }
}

// The task is the only node that renders a full paper tag.
function renderTaskNode(ln: LayoutNode, node: GraphSlipNodeDto): void {
  const x = ln.x;
  const y = ln.y;
  const state = node.state;
  const g = createSvg('g');
  g.setAttribute('data-node-id', node.id);
  g.setAttribute('data-action-type', node.action_type);
  g.setAttribute('data-state', node.state);
  g.setAttribute('data-node-kind', 'task');

  // Full paper tag: state lives in the fill/border only. Running adds a
  // moss marching dashed outline; failure stays a static terracotta edge.
  const tag = createSvg('rect');
  tag.setAttribute('class', 'dag-tag');
  tag.setAttribute('x', String(x));
  tag.setAttribute('y', String(y));
  tag.setAttribute('width', String(TASK_WIDTH));
  tag.setAttribute('height', String(TASK_HEIGHT));
  tag.setAttribute('rx', '5');
  tag.setAttribute('fill', tagFillColor(state));
  tag.setAttribute('stroke', tagBorderColor(state));
  tag.setAttribute('stroke-width', '1.5');
  g.appendChild(tag);

  if (state === 'running') {
    const hint = createSvg('rect');
    hint.setAttribute('class', 'dag-running-hint');
    hint.setAttribute('x', String(x));
    hint.setAttribute('y', String(y));
    hint.setAttribute('width', String(TASK_WIDTH));
    hint.setAttribute('height', String(TASK_HEIGHT));
    hint.setAttribute('rx', '5');
    g.appendChild(hint);
  }

  // One 20x20 tile with the unified procedural Agent glyph.
  const tile = createSvg('rect');
  tile.setAttribute('class', 'dag-icon-tile');
  tile.setAttribute('x', String(x + 5));
  tile.setAttribute('y', String(y + 5));
  tile.setAttribute('width', '20');
  tile.setAttribute('height', '20');
  tile.setAttribute('rx', '4');
  g.appendChild(tile);

  const iconG = createSvg('g');
  iconG.setAttribute('class', 'dag-icon');
  iconG.setAttribute('transform', `translate(${x + 7}, ${y + 7})`);
  for (const part of taskIconPaths()) appendIconPart(iconG, part);
  g.appendChild(iconG);

  // Title from validated display_label only; fallback is Chinese '任务'.
  const nameEl = createSvg('text');
  nameEl.setAttribute('class', 'dag-node-name');
  nameEl.setAttribute('x', String(x + TAG_LABEL_START_X));
  nameEl.setAttribute('y', String(y + 19));
  nameEl.textContent = nodeTitle(node);
  g.appendChild(nameEl);

  // Only a task with a matching task_run_id is transcript-clickable.
  // Clickability/ARIA derive from the current snapshot; the handlers are
  // bound once and read the live snapshot, so a retained node always acts on
  // the latest task_run_id and never closes over a stale one.
  syncTaskInteraction(g, node);
  bindNodeInteraction(g, node.id);

  bindTip(g, node.id, 'task', nodeTip(node, 'task'));
  dagCanvas.appendChild(g);
  fitTaskLabelText(nameEl, nodeTitle(node));
}

// Visible controls are icon-only: no title, no tag, no tabindex, no click.
function renderControlNode(ln: LayoutNode, node: GraphSlipNodeDto): void {
  const x = ln.x;
  const y = ln.y;
  const g = createSvg('g');
  g.setAttribute('data-node-id', node.id);
  g.setAttribute('data-action-type', node.action_type);
  g.setAttribute('data-state', node.state);
  g.setAttribute('data-node-kind', 'control');
  g.setAttribute('role', 'graphics-symbol');
  g.setAttribute('aria-label', controlAriaLabel(node.action_type));
  g.style.cursor = 'default';

  const tile = createSvg('rect');
  tile.setAttribute('class', 'dag-icon-tile dag-control-tile');
  tile.setAttribute('x', String(x));
  tile.setAttribute('y', String(y));
  tile.setAttribute('width', String(CONTROL_SIZE));
  tile.setAttribute('height', String(CONTROL_SIZE));
  tile.setAttribute('rx', '4');
  g.appendChild(tile);

  const iconG = createSvg('g');
  iconG.setAttribute('class', 'dag-icon');
  iconG.setAttribute('transform', `translate(${x + 4}, ${y + 4})`);
  for (const part of controlIconPaths(node.action_type)) appendIconPart(iconG, part);
  g.appendChild(iconG);

  // start/end have no tip; condition/checkpoint/convert get state/runtime.
  bindTip(g, node.id, 'control', nodeTip(node, 'control'));
  dagCanvas.appendChild(g);
}

// ── Same-revision in-place reconciliation ────────────────────────────
// A snapshot refresh whose structure revision is unchanged updates the
// dynamic fields on the existing SVG nodes instead of rebuilding the DAG.
// Every node keeps its DOM identity, so a stationary pointer stays hovered
// over the same element and the tooltip survives without a synthetic
// re-hover. Only a higher structure revision rebuilds the topology (see
// renderDag / buildDagDom).

function reconcileNodeFields(): void {
  const snapshot = currentSnapshot!;
  const anchors = dagCanvas.querySelectorAll<SVGElement>('g[data-node-id]');
  for (let i = 0; i < anchors.length; i++) {
    const g = anchors.item(i);
    const nodeId = g.getAttribute('data-node-id');
    if (!nodeId) continue;
    const node = snapshot.nodes[nodeId];
    if (!node) {
      // Defensive: a node vanished without a structure-revision bump; drop
      // the stale element and let preserveHoverAfterRender hide its tip.
      g.remove();
      continue;
    }
    g.setAttribute('data-state', node.state);
    if (g.getAttribute('data-node-kind') === 'task') reconcileTaskNodeFields(g, node);
  }
}

function reconcileTaskNodeFields(g: SVGElement, node: GraphSlipNodeDto): void {
  const tag = g.querySelector<SVGRectElement>('.dag-tag');
  if (tag) {
    tag.setAttribute('fill', tagFillColor(node.state));
    tag.setAttribute('stroke', tagBorderColor(node.state));
  }
  syncRunningHint(g, tag, node.state);
  const nameEl = g.querySelector<SVGTextElement>('.dag-node-name');
  if (nameEl) fitTaskLabelText(nameEl, nodeTitle(node));
  syncTaskInteraction(g, node);
}

// The moss marching outline lives on a task node only while its state is
// 'running'; add/remove it in place so the transition never rebuilds the
// node or steals pointer hover.
function syncRunningHint(g: SVGElement, tag: SVGRectElement | null, state: TaskGraphNodeState): void {
  const hint = g.querySelector<SVGRectElement>('.dag-running-hint');
  if (state === 'running' && !hint && tag) {
    const h = createSvg('rect');
    h.setAttribute('class', 'dag-running-hint');
    h.setAttribute('x', tag.getAttribute('x') ?? '');
    h.setAttribute('y', tag.getAttribute('y') ?? '');
    h.setAttribute('width', tag.getAttribute('width') ?? '');
    h.setAttribute('height', tag.getAttribute('height') ?? '');
    h.setAttribute('rx', tag.getAttribute('rx') ?? '');
    // Paint directly above the tag, below the tile/icon/label as in a
    // fresh build.
    g.insertBefore(h, tag.nextSibling);
  } else if (state !== 'running' && hint) {
    hint.remove();
  }
}

// Keep clickability/ARIA on the retained node aligned with the current
// snapshot so a task_run_id appearing, changing, or disappearing updates the
// node in place. The click/keydown handlers themselves are bound once and
// read the live snapshot (bindNodeInteraction), so no rebind is needed here.
function syncTaskInteraction(g: SVGElement, node: GraphSlipNodeDto): void {
  if (node.task_run_id) {
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    g.style.cursor = 'pointer';
  } else {
    g.setAttribute('role', 'graphics-symbol');
    g.removeAttribute('tabindex');
    g.style.cursor = '';
  }
  g.setAttribute('aria-label', taskAriaLabel(node));
}

// Bound exactly once per node element at build time and never re-bound on
// same-revision updates: the handler reads the current snapshot at event
// time so it always acts on the latest task_run_id.
function bindNodeInteraction(g: SVGElement, nodeId: string): void {
  g.addEventListener('click', () => {
    const node = currentSnapshot?.nodes[nodeId];
    if (!node?.task_run_id) return;
    window.graphSlipApi.openTranscript(nodeId, node.task_run_id);
  });
  g.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const node = currentSnapshot?.nodes[nodeId];
    if (!node?.task_run_id) return;
    e.preventDefault();
    window.graphSlipApi.openTranscript(nodeId, node.task_run_id);
  });
}

// ── Tooltip ──────────────────────────────────────────────────────────
// A single lightweight bounded (<=240px) paper tip. Content is built with
// textContent only — never innerHTML. Rows are omitted when invalid.
// Hover is tracked semantically by node id. Same-revision snapshot refreshes
// reconcile node fields in place (reconcileNodeFields), so the hovered node
// keeps its DOM identity and the same reusable tip stays anchored while its
// content re-renders. Only a higher-revision topology rebuild replaces nodes;
// the tip is then re-anchored by preserveHoverAfterRender and disappears
// when the node disappears or the pointer actually leaves.

let tooltipEl: HTMLDivElement | null = null;
let hoveredNodeId: string | null = null;
let hoveredKind: 'task' | 'control' | null = null;
let lastPointerX = 0;
let lastPointerY = 0;
let pendingLeaveNodeId: string | null = null;
let pendingLeaveKind: 'task' | 'control' | null = null;

function ensureTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.setAttribute('data-role', 'graph-slip-tooltip');
    tooltipEl.className = 'dag-tip';
    tooltipEl.style.cssText =
      'position:fixed;max-width:240px;min-width:140px;background:#FBF7EA;' +
      'color:#2E2018;border:1px solid #D4C9A8;border-radius:4px;font-size:11px;' +
      'pointer-events:none;z-index:1000;padding:6px 8px;' +
      'box-shadow:0 1px 3px rgba(46,32,24,0.18);';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function renderTip(el: HTMLDivElement, tip: TipContent): void {
  el.textContent = '';
  if (tip.firstLine) {
    const line = document.createElement('div');
    line.className = 'dag-tip-title';
    line.textContent = tip.firstLine;
    el.appendChild(line);
  }
  for (const row of tip.rows) {
    const line = document.createElement('div');
    line.className = 'dag-tip-row';
    const label = document.createElement('span');
    label.className = 'dag-tip-label';
    label.textContent = row.label;
    const value = document.createElement('span');
    value.className = 'dag-tip-value';
    value.textContent = row.value;
    line.appendChild(label);
    line.appendChild(value);
    el.appendChild(line);
  }
  if (tip.summary !== undefined) {
    // Separate full-width bordered done-summary region, unlabeled (no 结果摘要
    // row). Built with textContent only; the stylesheet clamps it to eight
    // lines with ellipsis, overflow hidden and no scrollbar.
    const region = document.createElement('div');
    region.className = 'dag-tip-summary';
    region.textContent = tip.summary;
    el.appendChild(region);
  }
}

// Re-render content and re-anchor the reusable tip to the hovered node.
// K3 placement: right +8 preferred with a left fallback, 4px viewport
// clamp, and the tip sits fully beside the anchor node — never on top of it.
function anchorTipToNode(nodeId: string, tip: TipContent): void {
  const el = ensureTooltip();
  renderTip(el, tip);
  const anchor = document.querySelector<SVGElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
  if (!anchor) {
    hideTooltip();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  el.style.display = 'block';
  const tipW = el.offsetWidth;
  const tipH = el.offsetHeight;
  const maxX = vw - tipW - 4;
  const maxY = vh - tipH - 4;
  const top = Math.max(4, Math.min(rect.top, Math.max(4, maxY)));
  let left = rect.right + 8;
  if (left > maxX) left = rect.left - 8 - tipW;
  left = Math.max(4, Math.min(left, Math.max(4, maxX)));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.display = 'block';
}

function showTipForNode(nodeId: string, kind: 'task' | 'control'): void {
  if (!currentSnapshot) return;
  const node = currentSnapshot.nodes[nodeId];
  if (!node) return;
  const tip = nodeTip(node, kind);
  if (!tip) return;
  hoveredNodeId = nodeId;
  hoveredKind = kind;
  anchorTipToNode(nodeId, tip);
}

// Whether the last known pointer position still lies inside the current
// (post-rebuild) rect of a node. Used to tell a genuine pointer leave from a
// mouseleave fired synchronously while a snapshot refresh replaced the anchor.
function isPointerOverNode(nodeId: string): boolean {
  const anchor = document.querySelector<Element>(`[data-node-id="${CSS.escape(nodeId)}"]`);
  if (!anchor) return false;
  const rect = anchor.getBoundingClientRect();
  return (
    lastPointerX >= rect.left && lastPointerX <= rect.right &&
    lastPointerY >= rect.top && lastPointerY <= rect.bottom
  );
}

function checkPendingLeave(): void {
  if (pendingLeaveNodeId === null) return;
  const nodeId = pendingLeaveNodeId;
  const kind = pendingLeaveKind;
  pendingLeaveNodeId = null;
  pendingLeaveKind = null;
  if (hoveredNodeId !== nodeId) return; // another node owns the hover now
  if (isPointerOverNode(nodeId)) {
    // The leave raced a DOM rebuild under a stationary pointer: keep and
    // refresh the same semantic hover.
    if (kind) showTipForNode(nodeId, kind);
    return;
  }
  hoveredNodeId = null;
  hoveredKind = null;
  hideTooltip();
}

function hideTipForNode(nodeId: string): void {
  if (hoveredNodeId !== nodeId) return;
  // Defer the leave decision until the rebuilt DOM is in place: a mouseleave
  // can fire synchronously while renderDag replaces the hovered anchor, so
  // only a pointer that is genuinely outside the node's current rect clears
  // the semantic hover.
  pendingLeaveNodeId = nodeId;
  pendingLeaveKind = hoveredKind;
  setTimeout(checkPendingLeave, 0);
}

function hideTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

// After a snapshot refresh rebuilds the DAG DOM, keep one semantic hover:
// if the hovered node still exists, update and re-anchor the same tip; if
// it disappeared, hide it (the pointer can no longer be on it).
function preserveHoverAfterRender(): void {
  if (hoveredNodeId === null || hoveredKind === null) return;
  const node = currentSnapshot?.nodes[hoveredNodeId];
  if (!node) {
    hoveredNodeId = null;
    hoveredKind = null;
    hideTooltip();
    return;
  }
  const tip = nodeTip(node, hoveredKind);
  if (!tip) {
    hoveredNodeId = null;
    hoveredKind = null;
    hideTooltip();
    return;
  }
  anchorTipToNode(hoveredNodeId, tip);
}

function bindTip(g: SVGElement, nodeId: string, kind: 'task' | 'control', tip: TipContent | null): void {
  if (!tip) return;
  const show = () => showTipForNode(nodeId, kind);
  const leave = () => hideTipForNode(nodeId);
  g.addEventListener('mouseenter', show);
  g.addEventListener('mousemove', show);
  g.addEventListener('mouseleave', leave);
  g.addEventListener('focus', show);
  g.addEventListener('blur', leave);
}

// ── Helpers ──────────────────────────────────────────────────────────

// State is encoded subtly in the paper-tag fill and border. Only "running"
// adds a visible animated hint (see .dag-running-hint in index.html).
function tagFillColor(state: TaskGraphNodeState): string {
  switch (state) {
    case 'planned': return '#F4EDDA';
    case 'running': return '#E6F1E2';
    case 'waiting': return '#F7EBD3';
    case 'done': return '#FBF7EA';
    case 'failed': return '#F6E1DC';
    case 'interrupted': return '#F2E3D5';
    case 'cancelled': return '#F3E2E2';
    default: return '#F4F0E2';
  }
}

function tagBorderColor(state: TaskGraphNodeState): string {
  switch (state) {
    case 'running': return '#6B9A62';
    case 'done': return '#8A8A7A';
    case 'failed': return '#B0655A';
    case 'interrupted': return '#A57950';
    case 'cancelled': return '#B0655A';
    case 'waiting': return '#C89B58';
    case 'planned': return '#A8A494';
    default: return '#8B7D6B';
  }
}

// ── Init ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  try {
    const api = window.graphSlipApi;

    // Close button wiring
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        api.close();
      });
    }

    // Escape key closes after hiding tooltip
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hoveredNodeId = null;
        hoveredKind = null;
        hideTooltip();
        api.close();
      }
    });

    // Track the pointer so a snapshot refresh that rebuilds the hovered node
    // can tell a genuine leave (pointer outside the rebuilt rect) from a
    // mouseleave emitted while the old anchor was removed.
    document.addEventListener('mousemove', (e: MouseEvent) => {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
    });

    api.onSnapshot((data) => {
      currentSnapshot = data;
      errorEl.classList.add('hidden');
      terminalEl.classList.add('hidden');
      loadingEl.classList.add('hidden');
      setSlipState('data');
      // Rebuild the DAG DOM, then preserve any semantic hover: the rebuilt
      // anchor is re-located by node id and the same reusable tip updates in
      // place instead of being dismissed by the refresh.
      renderDag();
      renderSlipHeader(data);
      preserveHoverAfterRender();
      // Observable snapshot-update counter so capture harnesses can prove a
      // hover survived N consecutive 2s refreshes (never part of rendering).
      snapshotUpdateCount += 1;
      document.documentElement.dataset.slipUpdates = String(snapshotUpdateCount);
    });

    api.onError((message) => {
      // Dismiss any active task tooltip before entering the error state:
      // the DAG DOM stays under the overlay, so the hovered anchor emits no
      // pointerleave/focusout. Only an explicit hide clears the stale tip.
      hoveredNodeId = null;
      hoveredKind = null;
      hideTooltip();
      errorEl.classList.remove('hidden');
      errorEl.textContent = message;
      loadingEl.classList.add('hidden');
      setSlipState('error');
    });

    loadingEl.classList.remove('hidden');
    setSlipState('loading');
    document.documentElement.dataset.slipReady = '1';
  } catch (e) {
    console.error('[graph-slip] init failed:', e);
  }
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', init);
}
