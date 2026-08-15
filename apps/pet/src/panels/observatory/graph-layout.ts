// ── Graph Slip layout & routing (pure, DOM-free) ─────────────────────
// Refactored out of index.ts so the DAG geometry is independently
// testable. Stable top-down longest-path layers with heterogeneous
// natural sizes, join/fanout transit-node collapsing, deterministic
// Manhattan M/V/H/V edge routing in bounded per-layer slots, and 3px
// ink solder dots at split/merge junctions.

import type { GraphSlipNodeDto, GraphSlipSnapshotDto } from '../../shared/taskgraph';

// Heterogeneous natural sizes: full paper tasks and icon-only controls.
// K3 compact paper tag 148x28; control chips stay 24x24.
export const TASK_WIDTH = 148;
export const TASK_HEIGHT = 28;
export const CONTROL_SIZE = 24;
export const ROW_GAP = 48;
export const STRAIGHT_ROW_GAP = ROW_GAP / 2;
export const NODE_GAP = 12;
export const PADDING = 16;

// Number of horizontal lanes available inside one inter-layer slot band.
const LANES_PER_BAND = 6;
const SLOT_STEP = 4;
// The 8px arrowhead needs a clear vertical target approach. A 20px inset
// keeps the marker fully on the drop instead of letting it overlap the
// horizontal branch/merge bus.
const SLOT_BASE = 20;

export type NodeKind = 'task' | 'control' | 'transit';

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  kind: Exclude<NodeKind, 'transit'>;
}

export interface EdgePoint {
  x: number;
  y: number;
}

export interface RoutedEdge {
  from: string;
  to: string;
  label: string;
  lane: number;
  points: EdgePoint[];
}

export interface JunctionDot {
  id: string;
  kind: 'split' | 'merge';
  x: number;
  y: number;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: RoutedEdge[];
  junctions: JunctionDot[];
  width: number;
  height: number;
}

export interface CollapsedGraph {
  nodes: Record<string, GraphSlipNodeDto>;
  edges: Array<{ from: string; to: string; label: string }>;
  junctions: Array<{
    id: string;
    kind: 'split' | 'merge';
    upstream: string[];
    downstream: string[];
  }>;
}

// ── Node classification ──────────────────────────────────────────────

/** Classify a slip node by its validated action type only. */
export function nodeKind(node: GraphSlipNodeDto): NodeKind {
  switch (node.action_type) {
    case 'join':
    case 'fanout':
      return 'transit';
    case 'task':
      return 'task';
    default:
      return 'control';
  }
}

/**
 * Collapse join/fanout transit nodes out of the graph. A user semantic
 * "join" is a one-to-many split and a "fanout" is a many-to-one merge;
 * both render as hidden transit chains with a 3px solder dot at the
 * junction instead of a node. Visible predecessors/successors are
 * reconnected through the hidden chains, preserving the true DAG shape.
 */
export function collapseTransit(snapshot: GraphSlipSnapshotDto): CollapsedGraph {
  const ids = Object.keys(snapshot.nodes).sort();
  const visible: Record<string, GraphSlipNodeDto> = {};
  const transitKinds = new Map<string, 'split' | 'merge'>();
  for (const id of ids) {
    const node = snapshot.nodes[id];
    if (nodeKind(node) === 'transit') {
      transitKinds.set(id, node.action_type === 'join' ? 'split' : 'merge');
    } else {
      visible[id] = node;
    }
  }

  // Adjacency over the original node set (deps are predecessors).
  const succs = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  for (const id of ids) {
    succs.set(id, []);
    preds.set(id, []);
  }
  for (const id of ids) {
    for (const dep of snapshot.nodes[id].deps) {
      if (!succs.has(dep) || !preds.has(id)) continue;
      succs.get(dep)!.push(id);
      preds.get(id)!.push(dep);
    }
  }
  for (const list of succs.values()) list.sort();
  for (const list of preds.values()) list.sort();

  const edgeLabel = new Map<string, string>();
  for (const e of snapshot.edges) edgeLabel.set(`${e.from}->${e.to}`, e.label);

  const isTransit = (id: string): boolean => transitKinds.has(id);

  /** First visible nodes reachable through a transit chain, with the
   *  label of the first hop on the chain. */
  function walkForward(start: string): Array<{ id: string; label: string }> {
    const seenTransit = new Set<string>();
    const found = new Map<string, string>();
    const queue: Array<{ id: string; label: string }> = [{ id: start, label: '' }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const s of succs.get(cur.id) ?? []) {
        const label = cur.label !== '' ? cur.label : (edgeLabel.get(`${cur.id}->${s}`) ?? 'data');
        if (isTransit(s)) {
          if (!seenTransit.has(s)) {
            seenTransit.add(s);
            queue.push({ id: s, label });
          }
        } else if (!found.has(s)) {
          found.set(s, label);
        }
      }
    }
    return [...found.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** First visible nodes reachable by walking backward through a chain. */
  function walkBackward(start: string): string[] {
    const seenTransit = new Set<string>();
    const found = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const p of preds.get(cur) ?? []) {
        if (isTransit(p)) {
          if (!seenTransit.has(p)) {
            seenTransit.add(p);
            queue.push(p);
          }
        } else {
          found.add(p);
        }
      }
    }
    return [...found].sort();
  }

  // Reconnect visible predecessors/successors through hidden chains.
  const edgeSet = new Map<string, string>();
  for (const id of Object.keys(visible).sort()) {
    for (const hop of walkForward(id)) {
      const key = `${id}->${hop.id}`;
      if (!edgeSet.has(key)) edgeSet.set(key, hop.label || 'data');
    }
  }
  const edges = [...edgeSet.entries()].map(([key, label]) => {
    const arrow = key.indexOf('->');
    return { from: key.slice(0, arrow), to: key.slice(arrow + 2), label };
  });

  const junctions: CollapsedGraph['junctions'] = [];
  for (const [id, kind] of transitKinds) {
    const upstream = walkBackward(id);
    const downstream = walkForward(id).map((h) => h.id);
    if (upstream.length === 0 || downstream.length === 0) continue;
    junctions.push({ id, kind, upstream, downstream });
  }

  return { nodes: visible, edges, junctions };
}

// ── Longest-path layering ────────────────────────────────────────────

/**
 * Stable top-down longest-path layers: sources sit in layer 0 and every
 * node is one layer below its deepest predecessor. Parallel DAG chains
 * stay side by side instead of collapsing onto a central trunk.
 */
export function assignLayers(
  nodeIds: string[],
  edges: Array<{ from: string; to: string }>,
): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const id of nodeIds) incoming.set(id, []);
  for (const e of edges) {
    if (!incoming.has(e.from) || !incoming.has(e.to)) continue;
    incoming.get(e.to)!.push(e.from);
  }
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // deterministic cycle guard
    visiting.add(id);
    let max = -1;
    for (const dep of incoming.get(id) ?? []) {
      max = Math.max(max, visit(dep));
    }
    visiting.delete(id);
    const layer = max + 1;
    layers.set(id, layer);
    return layer;
  };
  for (const id of [...nodeIds].sort()) visit(id);
  return layers;
}

// ── Full layout ──────────────────────────────────────────────────────

export function layoutGraph(snapshot: GraphSlipSnapshotDto): GraphLayout {
  const collapsed = collapseTransit(snapshot);
  const ids = Object.keys(collapsed.nodes).sort();
  const empty: GraphLayout = { nodes: [], edges: [], junctions: [], width: 0, height: 0 };
  if (ids.length === 0) return empty;

  const layers = assignLayers(ids, collapsed.edges);

  const sizes = new Map<string, { w: number; h: number; kind: Exclude<NodeKind, 'transit'> }>();
  for (const id of ids) {
    const rawKind = nodeKind(collapsed.nodes[id]);
    const kind: Exclude<NodeKind, 'transit'> = rawKind === 'transit' ? 'control' : rawKind;
    const isTask = kind === 'task';
    sizes.set(id, {
      w: isTask ? TASK_WIDTH : CONTROL_SIZE,
      h: isTask ? TASK_HEIGHT : CONTROL_SIZE,
      kind,
    });
  }

  const layerMap = new Map<number, string[]>();
  for (const id of ids) {
    const l = layers.get(id)!;
    if (!layerMap.has(l)) layerMap.set(l, []);
    layerMap.get(l)!.push(id);
  }
  const layerIndex = [...layerMap.keys()].sort((a, b) => a - b);

  // Stable ordering inside a layer: incoming predecessor layer averages,
  // then id for full determinism.
  const incoming = new Map<string, string[]>();
  for (const id of ids) incoming.set(id, []);
  for (const e of collapsed.edges) incoming.get(e.to)!.push(e.from);
  for (const list of incoming.values()) list.sort();
  for (const l of layerIndex) {
    layerMap.get(l)!.sort((a, b) => {
      const aDep = incoming.get(a) ?? [];
      const bDep = incoming.get(b) ?? [];
      const aAvg = aDep.length > 0
        ? aDep.reduce((s, d) => s + (layers.get(d) ?? 0), 0) / aDep.length
        : -1;
      const bAvg = bDep.length > 0
        ? bDep.reduce((s, d) => s + (layers.get(d) ?? 0), 0) / bDep.length
        : -1;
      if (aAvg !== bAvg) return aAvg - bAvg;
      return a.localeCompare(b);
    });
  }

  // Vertical: each layer occupies a band as tall as its tallest node. A
  // boundary carrying exactly one centred, adjacent edge is a pure vertical
  // chain and uses half the normal gap. Branches, merges and cross-layer
  // routes keep the full routing band for their horizontal lanes.
  const bandHeights = layerIndex.map((l) =>
    Math.max(1, ...layerMap.get(l)!.map((id) => sizes.get(id)!.h)),
  );
  const layerGaps = layerIndex.slice(0, -1).map((sourceLayer, index) => {
    const targetLayer = layerIndex[index + 1];
    const sourceIds = layerMap.get(sourceLayer)!;
    const targetIds = layerMap.get(targetLayer)!;
    if (sourceIds.length !== 1 || targetIds.length !== 1) return ROW_GAP;

    const crossing = collapsed.edges.filter((edge) => {
      const fromLayer = layers.get(edge.from)!;
      const toLayer = layers.get(edge.to)!;
      return fromLayer <= sourceLayer && toLayer >= targetLayer;
    });
    return crossing.length === 1
      && crossing[0].from === sourceIds[0]
      && crossing[0].to === targetIds[0]
      ? STRAIGHT_ROW_GAP
      : ROW_GAP;
  });
  const layerTop = new Map<number, number>();
  let cursorY = PADDING;
  layerIndex.forEach((l, i) => {
    layerTop.set(l, cursorY);
    cursorY += bandHeights[i];
    if (i < layerGaps.length) cursorY += layerGaps[i];
  });
  const height = cursorY + PADDING;

  // Bottom edge of every layer band; a gutter route's horizontal clearance
  // runs in the (always empty) row gap immediately below the source band.
  const bandBottom = new Map<number, number>();
  layerIndex.forEach((l, i) => bandBottom.set(l, layerTop.get(l)! + bandHeights[i]));

  // Horizontal: center each layer; the canvas is as wide as the widest
  // layer so wide rows scroll horizontally instead of shrinking.
  const layerWidths = layerIndex.map((l) => {
    const list = layerMap.get(l)!;
    return (
      list.reduce((s, id) => s + sizes.get(id)!.w, 0)
      + Math.max(0, list.length - 1) * NODE_GAP
    );
  });
  const width = Math.max(1, ...layerWidths) + PADDING * 2;

  const layoutNodes: LayoutNode[] = [];
  const byId = new Map<string, LayoutNode>();
  layerIndex.forEach((l, i) => {
    const list = layerMap.get(l)!;
    const startX = (width - layerWidths[i]) / 2;
    let cursor = startX;
    for (const id of list) {
      const { w, h, kind } = sizes.get(id)!;
      const x = cursor;
      const y = layerTop.get(l)! + (bandHeights[i] - h) / 2;
      const n: LayoutNode = { id, x, y, width: w, height: h, layer: l, kind };
      byId.set(id, n);
      layoutNodes.push(n);
      cursor += w + NODE_GAP;
    }
  });

  // ── Manhattan routing ──────────────────────────────────────────────
  // Every visible edge is an orthogonal M/V/H/V polyline that begins at the
  // exact source bottom midpoint and ends at the exact target top midpoint.
  // When an occupied intermediate layer blocks the direct descent, a
  // deterministic side gutter carries the edge via an explicit horizontal
  // clearance segment below the source band. The arrow marker is drawn only
  // on the final (target) segment and no segment passes through a visible
  // node rect.

  const byTargetLayer = new Map<number, Array<{ from: string; to: string; label: string }>>();
  for (const e of collapsed.edges) {
    const tl = layers.get(e.to)!;
    if (!byTargetLayer.has(tl)) byTargetLayer.set(tl, []);
    byTargetLayer.get(tl)!.push(e);
  }
  for (const list of byTargetLayer.values()) {
    list.sort((a, b) => {
      const ax = byId.get(a.from)!.x;
      const bx = byId.get(b.from)!.x;
      if (ax !== bx) return ax - bx;
      const atx = byId.get(a.to)!.x;
      const btx = byId.get(b.to)!.x;
      if (atx !== btx) return atx - btx;
      return (a.from + a.to).localeCompare(b.from + b.to);
    });
  }

  const edges: RoutedEdge[] = [];
  for (const [tl, list] of byTargetLayer) {
    const bandTop = layerTop.get(tl)!;
    const lanes = assignRoutingLanes(list);
    list.forEach((e, i) => {
      const src = byId.get(e.from)!;
      const dst = byId.get(e.to)!;
      const lane = lanes[i];
      const laneY = bandTop - SLOT_BASE - lane * SLOT_STEP;
      edges.push({
        from: e.from,
        to: e.to,
        label: e.label,
        lane,
        points: routeEdge(src, dst, laneY, tl, layers, layoutNodes, bandBottom.get(src.layer)!),
      });
    });
  }

  // ── Solder dots ────────────────────────────────────────────────────
  // Small ink dots at the split (join) exit and merge (fanout) entry
  // junctions where collapsed transit chains used to live.
  const junctions: JunctionDot[] = collapsed.junctions.map((j) => {
    const up = j.upstream.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    const down = j.downstream.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    const x = average(
      (j.kind === 'split' ? up : down).map((n) => n.x + n.width / 2),
    );
    const y = j.kind === 'split'
      ? Math.max(...up.map((n) => n.y + n.height)) + 3
      : Math.min(...down.map((n) => n.y)) - 3;
    return { id: j.id, kind: j.kind, x, y };
  });

  // ── Natural SVG bounds ────────────────────────────────────────────
  // A side-gutter clearance can step past the natural canvas, so the final
  // width/height is expanded to contain every routed point and solder dot
  // (shifting the whole layout when a point would land at a negative offset).
  let maxX = width;
  let maxY = height;
  let minX = 0;
  let minY = 0;
  const absorb = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const edge of edges) {
    for (const p of edge.points) absorb(p.x, p.y);
  }
  for (const dot of junctions) absorb(dot.x, dot.y);
  const shiftX = minX < 0 ? -minX : 0;
  const shiftY = minY < 0 ? -minY : 0;
  if (shiftX !== 0 || shiftY !== 0) {
    for (const n of layoutNodes) {
      n.x += shiftX;
      n.y += shiftY;
    }
    for (const edge of edges) {
      for (const p of edge.points) {
        p.x += shiftX;
        p.y += shiftY;
      }
    }
    for (const dot of junctions) {
      dot.x += shiftX;
      dot.y += shiftY;
    }
  }

  return {
    nodes: layoutNodes,
    edges,
    junctions,
    width: Math.max(width, maxX + shiftX),
    height: Math.max(height, maxY + shiftY),
  };
}

/**
 * Assign one lane to every connected split/merge group in a target band.
 * Edges sharing a source form a split and edges sharing a target form a
 * merge, so their horizontal bus must stay on one y coordinate instead of
 * stair-stepping across per-edge slots. Transitive groups (for example a
 * small bipartite branch) also stay on one plane for visual continuity.
 */
function assignRoutingLanes(
  edges: Array<{ from: string; to: string }>,
): number[] {
  const parent = edges.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const firstBySource = new Map<string, number>();
  const firstByTarget = new Map<string, number>();
  edges.forEach((edge, index) => {
    const sourceMatch = firstBySource.get(edge.from);
    if (sourceMatch === undefined) firstBySource.set(edge.from, index);
    else union(index, sourceMatch);

    const targetMatch = firstByTarget.get(edge.to);
    if (targetMatch === undefined) firstByTarget.set(edge.to, index);
    else union(index, targetMatch);
  });

  const laneByRoot = new Map<number, number>();
  let nextLane = 0;
  return edges.map((_, index) => {
    const root = find(index);
    let lane = laneByRoot.get(root);
    if (lane === undefined) {
      lane = nextLane % LANES_PER_BAND;
      laneByRoot.set(root, lane);
      nextLane++;
    }
    return lane;
  });
}

/**
 * Choose the x at which an edge descends from its source so the vertical
 * segment never passes through a visible node rectangle. Prefers the
 * source centre, then steps outward symmetrically into the nearest free
 * gutter. The search is unbounded but provably finite: the node set is
 * finite, so stepping past the outermost node rectangle is guaranteed to
 * find a free lane — a coordinate already proven blocked is never returned.
 */
function findFreeDescentX(
  src: LayoutNode,
  laneY: number,
  targetLayer: number,
  layers: Map<string, number>,
  nodes: LayoutNode[],
): number {
  const center = src.x + src.width / 2;
  if (!descentHitsNode(center, src.y + src.height, laneY, targetLayer, layers, nodes, src.id)) {
    return center;
  }
  // Deterministic unbounded symmetric gutter search. Every lane strictly
  // outside the outermost visible node rectangle is collision-free, so the
  // outward scan provably terminates on the finite node set (a lane beyond
  // occupiedMin/occupiedMax is returned on sight) instead of a fixed probe
  // cap that could exhaust and fall back to a blocked coordinate.
  const occupiedMin = Math.min(...nodes.map((n) => n.x));
  const occupiedMax = Math.max(...nodes.map((n) => n.x + n.width));
  let step = 1;
  for (;;) {
    const left = src.x - step * SLOT_STEP;
    const right = src.x + src.width + step * SLOT_STEP;
    if (left <= occupiedMin || !descentHitsNode(left, src.y + src.height, laneY, targetLayer, layers, nodes, src.id)) {
      return left;
    }
    if (right >= occupiedMax || !descentHitsNode(right, src.y + src.height, laneY, targetLayer, layers, nodes, src.id)) {
      return right;
    }
    step++;
  }
}

function descentHitsNode(
  x: number,
  fromY: number,
  toY: number,
  targetLayer: number,
  layers: Map<string, number>,
  nodes: LayoutNode[],
  sourceId: string,
): boolean {
  const low = Math.min(fromY, toY);
  const high = Math.max(fromY, toY);
  for (const n of nodes) {
    if (n.id === sourceId) continue;
    if ((layers.get(n.id) ?? 0) >= targetLayer) continue;
    if (x <= n.x || x >= n.x + n.width) continue;
    if (low >= n.y + n.height || high <= n.y) continue;
    return true;
  }
  return false;
}

/**
 * Deterministic Manhattan route for one visible edge. Always begins at the
 * exact source bottom midpoint and ends at the exact target top midpoint so
 * every edge is visibly attached at both ends. When an occupied intermediate
 * layer blocks the direct descent at the source centre, the offset is
 * expressed as an explicit horizontal clearance segment in the (always empty)
 * row gap below the source band plus a gutter descent — never by detaching
 * the endpoint. The target approach is inherently clear because it stays
 * inside the target layer's own row gap, and the arrowhead always rides the
 * final vertical drop into the target.
 */
function routeEdge(
  src: LayoutNode,
  dst: LayoutNode,
  laneY: number,
  targetLayer: number,
  layers: Map<string, number>,
  nodes: LayoutNode[],
  sourceBandBottom: number,
): EdgePoint[] {
  const start = { x: src.x + src.width / 2, y: src.y + src.height };
  const target = { x: dst.x + dst.width / 2, y: dst.y };
  if (!descentHitsNode(start.x, start.y, laneY, targetLayer, layers, nodes, src.id)) {
    return dedupePoints([start, { x: start.x, y: laneY }, { x: target.x, y: laneY }, target]);
  }
  const gutterX = findFreeDescentX(src, laneY, targetLayer, layers, nodes);
  return dedupePoints([
    start,
    { x: start.x, y: sourceBandBottom },
    { x: gutterX, y: sourceBandBottom },
    { x: gutterX, y: laneY },
    { x: target.x, y: laneY },
    target,
  ]);
}

/** Drop consecutive duplicate points so no zero-length segment is drawn. */
function dedupePoints(points: EdgePoint[]): EdgePoint[] {
  const out: EdgePoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
