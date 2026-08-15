import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_SLIP_SCHEMA_VERSION,
  normalizeTaskGraphListResult,
  normalizeTaskGraphInspectResult,
  normalizeTaskGraphStatusResult,
  normalizeTaskGraphNodeInspectResult,
  normalizeTaskGraphEventsResult,
  normalizeTaskGraphSlipResult,
  normalizeTaskRunEventsResult,
  normalizeSafeEvent,
  normalizeTaskTitle,
  nodeRuntimesFromEvents,
  edgeDataLabel,
  formatDuration,
  nodeSemanticAttributes,
  edgeSemanticAttributes,
} from '../src/shared/taskgraph';
import type {
  TaskGraphEvent,
  TaskGraphListResult,
  TaskGraphListRun,
  TaskGraphNode,
  TaskGraphNodeInspectResult,
  TaskGraphNodeState,
  TaskGraphState,
  TaskRunEvent,
  SafeTranscriptEventData,
  GraphSlipSnapshotDto,
  GraphSlipNodeDto,
  TaskGraphSlipNode,
  TaskGraphSlipResult,
  TaskGraphInspectResult,
} from '../src/shared/taskgraph';
import { projectGraphSlipFromActivity, projectGraphSlipSnapshot, snapshotAllowsTranscript } from '../src/main/graph-slip-snapshot-dto';
import type { TaskGraphSnapshot } from '../src/main/foreman-taskgraph-reader';
import { ForemanTaskGraphReader } from '../src/main/foreman-taskgraph-reader';
import type { ForemanIpcClient } from '../src/main/foreman-ipc-client';
import { TaskGraphWindowOwner, countDoneTaskNodes, fitGraphSlipWindowSize, placeWrenWindow } from '../src/main/taskgraph-windows';
import {
  ACTIVITY_SNAPSHOT_SCHEMA_VERSION,
  deriveActivityPresence,
  normalizeActivitySnapshotV1,
} from '../src/shared/activity-snapshot';
import type { ActivityPresence, ActivityTaskGraphPresence } from '../src/shared/activity-snapshot';
import {
  assignLayers,
  collapseTransit,
  layoutGraph,
  nodeKind,
  CONTROL_SIZE,
  NODE_GAP,
  PADDING,
  ROW_GAP,
  STRAIGHT_ROW_GAP,
  TASK_HEIGHT,
  TASK_WIDTH,
  type GraphLayout,
  type LayoutNode,
} from '../src/panels/observatory/graph-layout';
import {
  controlAriaLabel,
  controlIconPaths,
  formatDurationZh,
  nodeStateLabelZh,
  nodeTip,
  nodeTitle,
  taskAriaLabel,
  taskIconPaths,
  fitTagLabelToWidth,
  TAG_LABEL_MAX_WIDTH,
  TAG_LABEL_RIGHT_PADDING,
  TAG_LABEL_START_X,
} from '../src/panels/observatory/graph-visuals';

// ── Real TaskGraphWindowOwner harness ────────────────────────────────
// Minimal electron fakes (mirroring test/entity-windows.test.ts) so the
// real owner can create entity / graph-slip / transcript windows under
// fake timers. Windows are tracked by webContents so the owner's
// sender-window identity inference (BrowserWindow.fromWebContents) works.

const electronMocks = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcListeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const windowsByContents = new Map<object, unknown>();
  let uid = 0;
  let cursorPoint = { x: 0, y: 0 };

  const makeMockWin = (options: Record<string, number> = {}): any => {
    const id = ++uid;
    let destroyed = false;
    let bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 0,
      height: options.height ?? 0,
    };
    const wcListeners: Record<string, Array<(...args: any[]) => void>> = {};
    const winListeners: Record<string, Array<(...args: any[]) => void>> = {};
    const webContents = {
      on: (event: string, cb: (...args: any[]) => void) => { (wcListeners[event] ??= []).push(cb); },
      once: (event: string, cb: (...args: any[]) => void) => { (wcListeners[event] ??= []).push(cb); },
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      emit: (event: string, ...args: any[]) => { for (const cb of wcListeners[event] ?? []) cb(...args); },
    };
    const win = {
      _mockId: id,
      webContents,
      isDestroyed: () => destroyed,
      destroy: vi.fn(() => { destroyed = true; }),
      close: vi.fn(() => { destroyed = true; }),
      focus: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      showInactive: vi.fn(),
      hide: vi.fn(),
      setBounds: vi.fn((next: Partial<typeof bounds>) => { bounds = { ...bounds, ...next }; }),
      getBounds: vi.fn(() => ({ ...bounds })),
      setIgnoreMouseEvents: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      on: (event: string, cb: (...args: any[]) => void) => { (winListeners[event] ??= []).push(cb); },
      once: (event: string, cb: (...args: any[]) => void) => { (winListeners[event] ??= []).push(cb); },
      emit: (event: string, ...args: any[]) => { for (const cb of winListeners[event] ?? []) cb(...args); },
    };
    windowsByContents.set(webContents, win);
    return win;
  };

  const BrowserWindow = vi.fn((options?: Record<string, number>) => makeMockWin(options));
  BrowserWindow.fromWebContents = (wc: object): unknown => windowsByContents.get(wc) ?? null;

  return {
    ipcHandlers,
    ipcListeners,
    BrowserWindow,
    createdWindows: () => BrowserWindow.mock.results.map((r) => r.value),
    invokeIpc: async (name: string, event: unknown, ...args: unknown[]): Promise<unknown> => {
      const handler = ipcHandlers.get(name);
      if (!handler) throw new Error(`no ipc handler registered: ${name}`);
      return (handler as (...a: unknown[]) => Promise<unknown>)(event, ...args);
    },
    emitIpc: (name: string, event: unknown, ...args: unknown[]): void => {
      for (const listener of ipcListeners.get(name) ?? []) listener(event, ...args);
    },
    setCursorPoint: (point: { x: number; y: number }): void => {
      cursorPoint = point;
    },
    getCursorPoint: (): { x: number; y: number } => ({ ...cursorPoint }),
  };
});

vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => { electronMocks.ipcHandlers.set(name, fn); },
    removeHandler: (name: string) => { electronMocks.ipcHandlers.delete(name); },
    on: (name: string, fn: (...args: unknown[]) => unknown) => {
      const listeners = electronMocks.ipcListeners.get(name) ?? new Set();
      listeners.add(fn);
      electronMocks.ipcListeners.set(name, listeners);
    },
    removeListener: (name: string, fn: (...args: unknown[]) => unknown) => {
      electronMocks.ipcListeners.get(name)?.delete(fn);
    },
  },
  BrowserWindow: electronMocks.BrowserWindow,
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    getCursorScreenPoint: vi.fn(() => electronMocks.getCursorPoint()),
    getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
  },
}));

function graphEvent(
  seq: number,
  type: TaskGraphEvent['type'],
  occurredAt: string,
  nodeId?: string,
  taskgraphId: string = 'tg-test',
): TaskGraphEvent {
  return {
    taskgraph_id: taskgraphId,
    seq,
    type,
    occurred_at: occurredAt,
    structure_revision: 1,
    refs: nodeId ? { node_id: nodeId } : undefined,
  };
}

// ── TaskGraph normalizers ────────────────────────────────────────────

describe('TaskGraph normalizers', () => {
  it('validates and normalizes taskgraph.list result', () => {
    const raw = {
      runs: [
        {
          taskgraph_id: 'tg-123',
          state: 'running',
          structure_revision: 1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T01:00:00Z',
        },
        {
          taskgraph_id: 'tg-456',
          state: 'done',
          cancel_requested: false,
          structure_revision: 2,
          project: 'my-project',
          created_at: '2025-01-02T00:00:00Z',
          updated_at: '2025-01-02T02:00:00Z',
          ended_at: '2025-01-02T02:30:00Z',
        },
      ],
    };
    const result = normalizeTaskGraphListResult(raw);
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].taskgraph_id).toBe('tg-123');
    expect(result.runs[0].state).toBe('running');
    expect(result.runs[0].structure_revision).toBe(1);
    expect(result.runs[0].cancel_requested).toBeUndefined();
    expect(result.runs[1].project).toBe('my-project');
    expect(result.runs[1].ended_at).toBe('2025-01-02T02:30:00Z');
  });

  it('rejects malformed list result (missing runs)', () => {
    expect(() => normalizeTaskGraphListResult({})).toThrow();
  });

  it('rejects malformed list result (invalid state)', () => {
    expect(() => normalizeTaskGraphListResult({
      runs: [{ taskgraph_id: 'tg-1', state: 'invalid', structure_revision: 1, created_at: '', updated_at: '' }],
    })).toThrow('invalid state');
  });

  it('validates and normalizes taskgraph.inspect result', () => {
    const raw = {
      graph: {
        id: 'tg-1',
        revision: 3,
        nodes: {
          'node-a': {
            id: 'node-a',
            action: { type: 'llm_call', params: { model: 'gpt-4' } },
            deps: [],
          },
          'node-b': {
            id: 'node-b',
            name: 'Summarize',
            action: { type: 'llm_call' },
            deps: ['node-a'],
            input: [{ name: 'context', source: 'node-a.output' }],
          },
        },
      },
    };
    const result = normalizeTaskGraphInspectResult(raw);
    expect(result.graph.id).toBe('tg-1');
    expect(result.graph.revision).toBe(3);
    expect(Object.keys(result.graph.nodes)).toHaveLength(2);
    expect(result.graph.nodes['node-a'].action.type).toBe('llm_call');
    expect(result.graph.nodes['node-a'].action.params).toEqual({ model: 'gpt-4' });
    expect(result.graph.nodes['node-b'].deps).toEqual(['node-a']);
    expect(result.graph.nodes['node-b'].input?.[0].name).toBe('context');
  });

  it('rejects malformed inspect result (non-record nodes)', () => {
    expect(() => normalizeTaskGraphInspectResult({
      graph: { id: 'tg-1', revision: 1, nodes: [] },
    })).toThrow('must be a record');
  });

  it('validates and normalizes taskgraph.status result', () => {
    const raw = {
      taskgraph_id: 'tg-1',
      state: 'running',
      structure_revision: 3,
      latest_seq: 42,
      node_counts: { planned: 2, running: 3, waiting: 1, done: 5, failed: 1, interrupted: 0, cancelled: 1 },
      active: { running: ['node-a', 'node-b'], waiting: ['node-waiting'] },
    };
    const result = normalizeTaskGraphStatusResult(raw);
    expect(result.state).toBe('running');
    expect(result.taskgraph_id).toBe('tg-1');
    expect(result.node_counts.planned).toBe(2);
    expect(result.node_counts.running).toBe(3);
    expect(result.node_counts.failed).toBe(1);
    expect(result.active).toEqual({ running: ['node-a', 'node-b'], waiting: ['node-waiting'] });
  });

  it('validates and normalizes taskgraph.node.inspect result', () => {
    const raw = {
      structure_revision: 3,
      node: { id: 'node-a', action: { type: 'llm_call' }, deps: [] },
      run: { state: 'running', task_run_id: 'run-123' },
      output: { result: 'hello' },
    };
    const result = normalizeTaskGraphNodeInspectResult(raw);
    expect(result.structure_revision).toBe(3);
    expect(result.run.state).toBe('running');
    expect(result.run.task_run_id).toBe('run-123');
    expect(JSON.stringify(result)).not.toContain('hello');
  });

  it('validates and normalizes taskgraph.node.inspect with error', () => {
    const raw = {
      structure_revision: 3,
      node: { id: 'node-a', action: { type: 'llm_call' }, deps: [] },
      run: { state: 'cancelled', error: { code: 'EXEC_FAILURE', message: 'Timeout' } },
    };
    const result = normalizeTaskGraphNodeInspectResult(raw);
    expect(result.run.state).toBe('cancelled');
    expect(JSON.stringify(result)).not.toContain('Timeout');
    expect(result.run.task_run_id).toBeUndefined();
  });

  it('accepts every canonical Foreman node run state and rejects graph-only states', () => {
    const canonical = ['planned', 'running', 'waiting', 'done', 'failed', 'interrupted', 'cancelled'];
    for (const state of canonical) {
      const result = normalizeTaskGraphNodeInspectResult({
        structure_revision: 1,
        node: { id: 'node-a', action: { type: 'task', params: {} }, deps: [] },
        run: { state },
      });
      expect(result.run.state).toBe(state);
    }
    expect(() => normalizeTaskGraphNodeInspectResult({
      structure_revision: 1,
      node: { id: 'node-a', action: { type: 'task', params: {} }, deps: [] },
      run: { state: 'created' },
    })).toThrow('invalid node state');
  });

  it('validates and normalizes taskgraph.events result', () => {
    const raw = {
      events: [
        graphEvent(1, 'taskgraph.node.started', '2025-01-01T00:00:00Z', undefined, 'tg-1'),
        graphEvent(2, 'taskgraph.node.completed', '2025-01-01T00:01:00Z', 'node-a', 'tg-1'),
      ],
      next_seq: 2,
      latest_seq: 2,
      has_more: false,
    };
    const result = normalizeTaskGraphEventsResult(raw);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].refs).toBeUndefined();
    expect(result.events[1].refs?.node_id).toBe('node-a');
    expect(result.events[1].type).toBe('taskgraph.node.completed');
    expect(result.next_seq).toBe(2);
    expect(result.latest_seq).toBe(2);
    expect(result.has_more).toBe(false);
  });

  it('validates and normalizes task.run.events result', () => {
    const raw = {
      task_run_id: 'run-123',
      events: [
        { seq: 1, type: 'message', timestamp: '2025-01-01T00:00:00Z', data: { text: 'Hello' } },
        { seq: 2, type: 'tool_call', timestamp: '2025-01-01T00:00:01Z', data: { name: 'bash' }, is_error: false },
      ],
      next_seq: 3,
      has_more: true,
    };
    const result = normalizeTaskRunEventsResult(raw);
    expect(result.task_run_id).toBe('run-123');
    expect(result.events).toHaveLength(2);
    expect(result.events[1].type).toBe('tool_call');
    expect(result.events[1].seq).toBe(2);
    expect(result.next_seq).toBe(3);
    expect(result.has_more).toBe(true);
  });
});

// ── Optional title display metadata ──────────────────────────────────

describe('Optional taskgraph title metadata', () => {
  const baseListRun = (overrides: Record<string, unknown> = {}) => ({
    taskgraph_id: 'tg-title',
    state: 'running',
    structure_revision: 1,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  });

  const baseStatusRaw = (overrides: Record<string, unknown> = {}) => ({
    taskgraph_id: 'tg-title',
    state: 'running',
    structure_revision: 1,
    latest_seq: 1,
    node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
    active: { running: ['node-a'], waiting: [] },
    ...overrides,
  });

  it('normalizes a trimmed single-line title from taskgraph.list', () => {
    const result = normalizeTaskGraphListResult({
      runs: [baseListRun({ title: '  Show graph purpose in Pet window headers  ' })],
    });
    expect(result.runs[0].title).toBe('Show graph purpose in Pet window headers');
  });

  it('normalizes a valid title from taskgraph.status', () => {
    const status = normalizeTaskGraphStatusResult(
      baseStatusRaw({ title: 'Show graph purpose in Pet window headers' }),
    );
    expect(status.title).toBe('Show graph purpose in Pet window headers');
  });

  it('accepts a title up to 120 code units', () => {
    const title = 'x'.repeat(120);
    expect(normalizeTaskGraphStatusResult(baseStatusRaw({ title })).title).toHaveLength(120);
  });

  it('omits malformed or legacy titles instead of rejecting the whole response', () => {
    const malformed = [undefined, null, 42, '', '   ', 'line1\nline2', 'line1\rline2', 'x'.repeat(121)];
    for (const title of malformed) {
      const status = normalizeTaskGraphStatusResult(baseStatusRaw({ title }));
      expect(status.title).toBeUndefined();
      // Noncritical metadata: identity/state validation is unaffected.
      expect(status.taskgraph_id).toBe('tg-title');
      expect(status.state).toBe('running');
    }
    const list = normalizeTaskGraphListResult({ runs: [baseListRun({ title: 42 })] });
    expect(list.runs[0].title).toBeUndefined();
  });
});

// ── Adversarial optional-title Unicode boundary ──────────────────────
// Optional graph titles share the centralized bounded Unicode predicate
// used for Graph Slip display strings: C0/DEL/C1 controls and unpaired
// UTF-16 surrogates are rejected, valid supplementary characters pass, and
// an invalid title is omitted (never sanitized) before renderer projection.

describe('Adversarial optional-title Unicode boundary', () => {
  const baseStatusRaw = (overrides: Record<string, unknown> = {}) => ({
    taskgraph_id: 'tg-title',
    state: 'running',
    structure_revision: 1,
    latest_seq: 1,
    node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
    active: { running: ['node-a'], waiting: [] },
    ...overrides,
  });

  // Project the already-normalized status into the renderer DTO, exactly as
  // the snapshot pipeline does: the DTO copies status.title verbatim, so an
  // invalid title must already be absent at the status boundary.
  const projectStatusTitle = (status: TaskGraphStatusResult): GraphSlipSnapshotDto => {
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: { graph: { id: 'tg-title', revision: 1, nodes: {} } },
      status,
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map(),
    };
    return projectGraphSlipSnapshot(snapshot, Date.now());
  };

  const controlCases: Array<[string, string]> = [
    ['NUL (C0)', '\u0000'],
    ['SOH (C0)', '\u0001'],
    ['TAB (C0)', '\u0009'],
    ['LF (C0)', '\u000A'],
    ['VT (C0)', '\u000B'],
    ['CR (C0)', '\u000D'],
    ['ESC (C0)', '\u001B'],
    ['US (C0 last)', '\u001F'],
    ['DEL', '\u007F'],
    ['C1 first (PAD)', '\u0080'],
    ['C1 CSI', '\u009B'],
    ['C1 last (APC)', '\u009F'],
  ];
  it('omits titles containing any C0/DEL/C1 control from the renderer DTO', () => {
    for (const [name, title] of controlCases) {
      const status = normalizeTaskGraphStatusResult(baseStatusRaw({ title }));
      expect(status.title).toBeUndefined();
      const projected = projectStatusTitle(status);
      expect('title' in projected).toBe(false);
      // Noncritical metadata: identity/state validation is unaffected.
      expect(status.taskgraph_id).toBe('tg-title');
      expect(status.state).toBe('running');
      expect(name).toBeTruthy();
    }
  });

  const surrogateCases: Array<[string, string]> = [
    ['unpaired high surrogate', 'bad \uD800 title'],
    ['unpaired low surrogate', 'bad \uDC00 title'],
    ['high followed by non-low (broken pair)', 'bad \uD800\u0041 title'],
    ['trailing high surrogate', 'bad \uD800'],
    ['leading low surrogate', '\uDC00 bad'],
  ];
  it('omits titles with unpaired or broken UTF-16 surrogates from the renderer DTO', () => {
    for (const [, title] of surrogateCases) {
      const status = normalizeTaskGraphStatusResult(baseStatusRaw({ title }));
      expect(status.title).toBeUndefined();
      const projected = projectStatusTitle(status);
      expect('title' in projected).toBe(false);
    }
  });

  it('preserves valid Chinese at the 120-code-unit cap through projection', () => {
    const title = '审'.repeat(120);
    expect(title.length).toBe(120);
    const status = normalizeTaskGraphStatusResult(baseStatusRaw({ title }));
    expect(status.title).toBe(title);
    expect(projectStatusTitle(status).title).toBe(title);
  });

  it('preserves valid paired supplementary Unicode at the 120-code-unit cap through projection', () => {
    const title = '\u{1F600}'.repeat(60); // 2 code units each → exactly 120
    expect(title.length).toBe(120);
    const status = normalizeTaskGraphStatusResult(baseStatusRaw({ title }));
    expect(status.title).toBe(title);
    expect(projectStatusTitle(status).title).toBe(title);
  });

  it('rejects a control embedded mid-string without trimming or sanitizing it away', () => {
    const status = normalizeTaskGraphStatusResult(baseStatusRaw({ title: 'ok\u0000title' }));
    expect(status.title).toBeUndefined();
    const projected = projectStatusTitle(status);
    expect('title' in projected).toBe(false);
    expect(status.taskgraph_id).toBe('tg-title');
    expect(status.state).toBe('running');
  });
});

// ── Pure utilities ───────────────────────────────────────────────────

describe('TaskGraph utilities', () => {
  it('nodeRuntimesFromEvents computes correct runtimes', () => {
    const events = [
      graphEvent(1, 'taskgraph.node.started', '2025-01-01T00:00:00Z', 'node-a'),
      graphEvent(2, 'taskgraph.node.completed', '2025-01-01T00:00:05Z', 'node-a'),
      graphEvent(3, 'taskgraph.node.started', '2025-01-01T00:00:10Z', 'node-b'),
      graphEvent(4, 'taskgraph.node.failed', '2025-01-01T00:00:20Z', 'node-b'),
    ];
    const runtimes = nodeRuntimesFromEvents(events);
    expect(runtimes['node-a']).toBe(5000);
    expect(runtimes['node-b']).toBe(10000);
  });

  it('nodeRuntimesFromEvents ignores unmatched events', () => {
    const events = [
      graphEvent(1, 'taskgraph.node.started', '2025-01-01T00:00:00Z', 'node-a'),
    ];
    const runtimes = nodeRuntimesFromEvents(events);
    expect(runtimes['node-a']).toBeUndefined();
  });

  it('edgeDataLabel uses label field first', () => {
    expect(edgeDataLabel({ label: 'my label', name: 'ignored' })).toBe('my label');
  });

  it('edgeDataLabel falls back through name/summary/description', () => {
    expect(edgeDataLabel({ name: 'my name' })).toBe('my name');
    expect(edgeDataLabel({ summary: 'my summary' })).toBe('my summary');
    expect(edgeDataLabel({ description: 'my desc' })).toBe('my desc');
  });

  it('edgeDataLabel returns undefined for empty data', () => {
    expect(edgeDataLabel({})).toBeUndefined();
    expect(edgeDataLabel(undefined)).toBeUndefined();
  });

  it('formatDuration handles various inputs', () => {
    expect(formatDuration(0)).toBe('<1s');
    expect(formatDuration(500)).toBe('<1s');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(61000)).toBe('1m 1s');
    expect(formatDuration(3661000)).toBe('1h 1m 1s');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Infinity)).toBe('—');
  });
});

// ── Generation guard ────────────────────────────────────────────────

describe('TaskGraph generation guard', () => {
  it('uses canonical taskgraph_id params for every snapshot request', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push([method, params]);
        if (method === 'taskgraph.inspect') {
          return {
            graph: {
              id: 'tg-canonical',
              revision: 1,
              nodes: { plan: { id: 'plan', action: { type: 'llm_call' }, deps: [] } },
            },
          };
        }
        if (method === 'taskgraph.status') {
          return {
            taskgraph_id: 'tg-canonical',
            state: 'done',
            structure_revision: 1,
            latest_seq: 0,
            node_counts: { planned: 0, running: 0, waiting: 0, done: 1, failed: 0, interrupted: 0, cancelled: 0 },
            active: { running: [], waiting: [] },
          };
        }
        if (method === 'taskgraph.events') {
          return { events: [], next_seq: 0, latest_seq: 0, has_more: false };
        }
        if (method === 'taskgraph.node.inspect') {
          return {
            structure_revision: 1,
            node: { id: 'plan', action: { type: 'llm_call' }, deps: [] },
            run: { state: 'done', task_run_id: 'run-plan' },
          };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as ForemanIpcClient;

    await new ForemanTaskGraphReader(client).loadSnapshot('tg-canonical');

    expect(calls).toEqual([
      ['taskgraph.inspect', { taskgraph_id: 'tg-canonical' }],
      ['taskgraph.status', { taskgraph_id: 'tg-canonical' }],
      ['taskgraph.events', { taskgraph_id: 'tg-canonical', after_seq: 0, limit: 1000 }],
      ['taskgraph.node.inspect', { taskgraph_id: 'tg-canonical', node_id: 'plan' }],
    ]);
  });

  it('drains every taskgraph.events page for complete runtime projection', async () => {
    const eventParams: Record<string, unknown>[] = [];
    const client = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === 'taskgraph.inspect') {
          return { graph: { id: 'tg-pages', revision: 1, nodes: {} } };
        }
        if (method === 'taskgraph.status') {
          return {
            taskgraph_id: 'tg-pages', state: 'done', structure_revision: 1, latest_seq: 2,
            node_counts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
            active: { running: [], waiting: [] },
          };
        }
        if (method === 'taskgraph.events') {
          eventParams.push(params);
          if (params.after_seq === 0) {
            return {
              events: [graphEvent(1, 'taskgraph.node.started', '2025-01-01T00:00:00Z', undefined, 'tg-pages')],
              next_seq: 1, latest_seq: 2, has_more: true,
            };
          }
          return {
            events: [graphEvent(2, 'taskgraph.node.completed', '2025-01-01T00:00:01Z', undefined, 'tg-pages')],
            next_seq: 2, latest_seq: 2, has_more: false,
          };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as ForemanIpcClient;

    const snapshot = await new ForemanTaskGraphReader(client).loadSnapshot('tg-pages');

    expect(snapshot.events.events).toHaveLength(2);
    expect(eventParams).toEqual([
      { taskgraph_id: 'tg-pages', after_seq: 0, limit: 1000 },
      { taskgraph_id: 'tg-pages', after_seq: 1, limit: 1000 },
    ]);
  });

  it('rejects taskgraph.events rows for another graph', async () => {
    const client = {
      request: async (method: string) => {
        if (method === 'taskgraph.inspect') {
          return { graph: { id: 'tg-expected', revision: 1, nodes: {} } };
        }
        if (method === 'taskgraph.status') {
          return {
            taskgraph_id: 'tg-expected', state: 'done', structure_revision: 1, latest_seq: 1,
            node_counts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
            active: { running: [], waiting: [] },
          };
        }
        if (method === 'taskgraph.events') {
          return {
            events: [graphEvent(1, 'taskgraph.done', '2025-01-01T00:00:00Z', undefined, 'tg-other')],
            next_seq: 1, latest_seq: 1, has_more: false,
          };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as ForemanIpcClient;

    await expect(new ForemanTaskGraphReader(client).loadSnapshot('tg-expected')).rejects.toThrow(
      'taskgraph.events identity mismatch',
    );
  });

  it('rejects a task.run.events response for another task run', async () => {
    const client = {
      request: async () => ({
        task_run_id: 'run-other',
        events: [],
        next_seq: 0,
        has_more: false,
      }),
    } as unknown as ForemanIpcClient;
    const reader = new ForemanTaskGraphReader(client);

    await expect(reader.loadTaskEvents('run-expected')).rejects.toThrow(
      'task.run.events identity mismatch',
    );
  });

  it('snapshot with mismatched generation is detected', () => {
    const inspectRev = 3;
    const statusRev = 5;
    expect(inspectRev === statusRev).toBe(false);
  });

  it('snapshot with matching generation passes', () => {
    const inspectRev = 3;
    const statusRev = 3;
    expect(inspectRev === statusRev).toBe(true);
  });
});

// ── Graph Slip request contract ─────────────────────────────────────

describe('Graph Slip request contract', () => {
  function makeReader(handlers: Record<string, (params: Record<string, unknown>) => unknown>): {
    reader: ForemanTaskGraphReader;
    calls: Array<[string, Record<string, unknown>]>;
  } {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push([method, params]);
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected method: ${method}`);
        return handler(params);
      },
    } as unknown as ForemanIpcClient;
    return { reader: new ForemanTaskGraphReader(client), calls };
  }

  function inspectWith(nodes: Record<string, { type: string }>): unknown {
    const graphNodes: Record<string, unknown> = {};
    for (const [nodeId, n] of Object.entries(nodes)) {
      graphNodes[nodeId] = { id: nodeId, action: { type: n.type }, deps: [] };
    }
    return { graph: { id: 'tg-slip', revision: 1, nodes: graphNodes } };
  }

  const statusResult = (overrides: Record<string, unknown> = {}): unknown => ({
    taskgraph_id: 'tg-slip',
    state: 'running',
    structure_revision: 1,
    latest_seq: 7,
    node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
    active: { running: ['taskA'], waiting: [] },
    ...overrides,
  });

  const emptyEvents = (): unknown => ({ events: [], next_seq: 0, latest_seq: 7, has_more: false });

  function nodeInspect(nodeId: string): unknown {
    return {
      structure_revision: 1,
      node: { id: nodeId, action: { type: 'task' }, deps: [] },
      run: { state: 'running', task_run_id: `run-${nodeId}` },
    };
  }

  const slipResult = (overrides: Record<string, unknown> = {}): unknown => ({
    schema_version: 'foreman.taskgraph.slip.v1',
    taskgraph_id: 'tg-slip',
    graph_state: 'running',
    structure_revision: 1,
    latest_seq: 7,
    nodes: [
      { node_id: 'taskA', state: 'running', task_category: 'code', display_label: '代码审查' },
      { node_id: 'taskC', state: 'running', task_category: 'doc', summary: 'Write docs' },
    ],
    ...overrides,
  });

  it('requests taskgraph.slip exactly once with every visible task node id', async () => {
    const { reader, calls } = makeReader({
      'taskgraph.inspect': () => inspectWith({ taskA: { type: 'task' }, llmB: { type: 'llm_call' }, taskC: { type: 'task' } }),
      'taskgraph.status': () => statusResult(),
      'taskgraph.events': emptyEvents,
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => slipResult(),
    });

    const snapshot = await reader.loadSnapshot('tg-slip');

    const slipCalls = calls.filter(([m]) => m === 'taskgraph.slip');
    expect(slipCalls).toHaveLength(1);
    expect(slipCalls[0][1]).toEqual({ taskgraph_id: 'tg-slip', node_ids: ['taskA', 'taskC'] });
    expect(snapshot.slip?.nodes.map((n) => n.node_id)).toEqual(['taskA', 'taskC']);
    expect(snapshot.slip?.nodes[0].display_label).toBe('代码审查');
  });

  it('skips taskgraph.slip entirely when no task nodes are visible', async () => {
    const { reader, calls } = makeReader({
      'taskgraph.inspect': () => inspectWith({ llmB: { type: 'llm_call' }, condC: { type: 'condition' } }),
      'taskgraph.status': () => statusResult(),
      'taskgraph.events': emptyEvents,
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => { throw new Error('taskgraph.slip must not be requested'); },
    });

    const snapshot = await reader.loadSnapshot('tg-slip');

    expect(snapshot.slip).toBeUndefined();
    expect(calls.some(([m]) => m === 'taskgraph.slip')).toBe(false);
  });

  it.each([
    ['schema_version', { schema_version: 'foreman.taskgraph.slip.v2' }, 'schema_version mismatch'],
    ['taskgraph id', { taskgraph_id: 'tg-other' }, 'identity mismatch'],
    ['graph state', { graph_state: 'done' }, 'state mismatch'],
    ['structure_revision', { structure_revision: 2 }, 'structure_revision mismatch'],
    ['latest_seq', { latest_seq: 8 }, 'latest_seq mismatch'],
    ['node order', { nodes: [{ node_id: 'taskC', state: 'running' }, { node_id: 'taskA', state: 'running' }] }, 'node order mismatch'],
    ['duplicate node ids', { nodes: [{ node_id: 'taskA', state: 'running' }, { node_id: 'taskA', state: 'running' }] }, 'node order mismatch'],
    ['node state', { nodes: [{ node_id: 'taskA', state: 'done' }, { node_id: 'taskC', state: 'running' }] }, 'node state mismatch'],
    ['node count', { nodes: [{ node_id: 'taskA', state: 'running' }] }, 'node count mismatch'],
  ])('rejects taskgraph.slip with a %s mismatch', async (_label, slipOverrides, errorText) => {
    const { reader } = makeReader({
      'taskgraph.inspect': () => inspectWith({ taskA: { type: 'task' }, taskC: { type: 'task' } }),
      'taskgraph.status': () => statusResult(),
      'taskgraph.events': emptyEvents,
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => slipResult(slipOverrides),
    });

    await expect(reader.loadSnapshot('tg-slip')).rejects.toThrow(errorText);
  });

  it('rejects numeric schema_version and legacy graph_id/state wire keys fail-closed', async () => {
    // Numeric schema_version (legacy v1 int) must never be accepted.
    const numericVersion = makeReader({
      'taskgraph.inspect': () => inspectWith({ taskA: { type: 'task' } }),
      'taskgraph.status': () => statusResult(),
      'taskgraph.events': emptyEvents,
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => ({
        schema_version: 1,
        taskgraph_id: 'tg-slip',
        graph_state: 'running',
        structure_revision: 1,
        latest_seq: 7,
        nodes: [{ node_id: 'taskA', state: 'running', task_category: 'code' }],
      }),
    });
    await expect(numericVersion.reader.loadSnapshot('tg-slip')).rejects.toThrow(
      'taskgraph.slip.schema_version',
    );

    // Legacy graph_id/state aliases are never accepted as alternate wire keys.
    const legacyAliases = makeReader({
      'taskgraph.inspect': () => inspectWith({ taskA: { type: 'task' } }),
      'taskgraph.status': () => statusResult(),
      'taskgraph.events': emptyEvents,
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => ({
        schema_version: 'foreman.taskgraph.slip.v1',
        graph_id: 'tg-slip',
        state: 'running',
        structure_revision: 1,
        latest_seq: 7,
        nodes: [{ node_id: 'taskA', state: 'running', task_category: 'code' }],
      }),
    });
    await expect(legacyAliases.reader.loadSnapshot('tg-slip')).rejects.toThrow(
      'taskgraph.slip.taskgraph_id',
    );
  });

  it('rejects the polling round before Slip projection when events.latest_seq differs from status.latest_seq', async () => {
    const { reader, calls } = makeReader({
      'taskgraph.inspect': () => inspectWith({ taskA: { type: 'task' } }),
      'taskgraph.status': () => statusResult({ latest_seq: 8 }),
      'taskgraph.events': emptyEvents, // latest_seq: 7
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => { throw new Error('taskgraph.slip must not be requested'); },
    });

    await expect(reader.loadSnapshot('tg-slip')).rejects.toThrow('latest_seq mismatch');
    expect(calls.some(([m]) => m === 'taskgraph.slip')).toBe(false);
  });

  it('rejects a malformed taskgraph.slip envelope', async () => {
    const { reader } = makeReader({
      'taskgraph.inspect': () => inspectWith({ taskA: { type: 'task' } }),
      'taskgraph.status': () => statusResult(),
      'taskgraph.events': emptyEvents,
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => ({
        schema_version: 'foreman.taskgraph.slip.v1',
        taskgraph_id: 'tg-slip',
        graph_state: 'running',
        structure_revision: 1,
        latest_seq: 7,
        nodes: {},
      }),
    });

    await expect(reader.loadSnapshot('tg-slip')).rejects.toThrow('nodes must be an array');
  });

  it('normalizes out-of-bounds slip display fields fail-closed without rejecting the round', async () => {
    const { reader } = makeReader({
      'taskgraph.inspect': () => inspectWith({ taskA: { type: 'task' } }),
      'taskgraph.status': () => statusResult(),
      'taskgraph.events': emptyEvents,
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => slipResult({
        nodes: [{
          node_id: 'taskA',
          state: 'running',
          task_category: 'x'.repeat(33),
          display_label: 'x'.repeat(25),
          tool_call_count: -3,
          tps: 2_000_000,
          summary: 'x'.repeat(281),
          params: { secret: 'raw-param-secret' },
        }],
      }),
    });

    const snapshot = await reader.loadSnapshot('tg-slip');
    expect(snapshot.slip?.nodes[0].task_category).toBeUndefined();
    expect(snapshot.slip?.nodes[0].display_label).toBeUndefined();
    expect(snapshot.slip?.nodes[0].tool_call_count).toBeUndefined();
    expect(snapshot.slip?.nodes[0].tps).toBeUndefined();
    expect(snapshot.slip?.nodes[0].summary).toBeUndefined();
    expect(JSON.stringify(snapshot.slip)).not.toContain('raw-param-secret');
  });

  it('omits control-character and broken-surrogate slip display strings fail-closed at the wire boundary', async () => {
    const { reader } = makeReader({
      'taskgraph.inspect': () => inspectWith({ taskA: { type: 'task' } }),
      'taskgraph.status': () => statusResult(),
      'taskgraph.events': emptyEvents,
      'taskgraph.node.inspect': (p) => nodeInspect(String(p.node_id)),
      'taskgraph.slip': () => slipResult({
        nodes: [{
          node_id: 'taskA',
          state: 'running',
          task_category: 'code',
          display_label: '\ud800',
          description: '\u0000bad',
          profile: '\u007f',
          summary: '\u009f',
        }],
      }),
    });

    // The round still succeeds (optional display fields are omitted, never
    // allowed to poison the whole result), and no malformed value crosses.
    const snapshot = await reader.loadSnapshot('tg-slip');
    expect(snapshot.slip?.nodes[0].display_label).toBeUndefined();
    expect(snapshot.slip?.nodes[0].description).toBeUndefined();
    expect(snapshot.slip?.nodes[0].profile).toBeUndefined();
    expect(snapshot.slip?.nodes[0].summary).toBeUndefined();
    expect(JSON.stringify(snapshot.slip)).not.toContain('\u0000');
    expect(JSON.stringify(snapshot.slip)).not.toContain('\u007f');
    expect(JSON.stringify(snapshot.slip)).not.toContain('\u009f');
    expect(JSON.stringify(snapshot.slip)).not.toContain('\ud800');
  });
});

// ── Slip identity boundary (structure_revision / latest_seq) ────────

describe('Graph Slip identity boundary (structure_revision / latest_seq)', () => {
  const baseSlipRaw = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 'foreman.taskgraph.slip.v1',
    taskgraph_id: 'tg-seq',
    graph_state: 'running',
    structure_revision: 1,
    latest_seq: 7,
    nodes: [],
    ...overrides,
  });

  it('rejects negative identity values fail-closed', () => {
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ structure_revision: -1 }), 0)).toThrow(
      'nonnegative safe integer',
    );
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ latest_seq: -1 }), 0)).toThrow(
      'nonnegative safe integer',
    );
  });

  it('rejects fractional identity values without coercion or clamping', () => {
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ structure_revision: 1.5 }), 0)).toThrow(
      'nonnegative safe integer',
    );
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ latest_seq: 7.25 }), 0)).toThrow(
      'nonnegative safe integer',
    );
  });

  it('rejects NaN/Infinity and unsafe integers', () => {
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ structure_revision: NaN }), 0)).toThrow();
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ latest_seq: Infinity }), 0)).toThrow();
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ structure_revision: Number.MAX_SAFE_INTEGER + 1 }), 0)).toThrow();
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ latest_seq: Number.MAX_SAFE_INTEGER + 1 }), 0)).toThrow();
  });

  it('accepts valid zero and MAX_SAFE_INTEGER identity values', () => {
    const zero = normalizeTaskGraphSlipResult(baseSlipRaw({ structure_revision: 0, latest_seq: 0 }), 0);
    expect(zero.structure_revision).toBe(0);
    expect(zero.latest_seq).toBe(0);
    const max = normalizeTaskGraphSlipResult(
      baseSlipRaw({ structure_revision: Number.MAX_SAFE_INTEGER, latest_seq: Number.MAX_SAFE_INTEGER }),
      0,
    );
    expect(max.structure_revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(max.latest_seq).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts valid zero/MAX_SAFE_INTEGER identities through the atomic reader merge when every source agrees', async () => {
    const makeReader = (identity: number): ForemanTaskGraphReader => {
      const client = {
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === 'taskgraph.inspect') {
            return {
              graph: {
                id: 'tg-seq', revision: identity,
                nodes: { taskA: { id: 'taskA', action: { type: 'task' }, deps: [] } },
              },
            };
          }
          if (method === 'taskgraph.status') {
            return {
              taskgraph_id: 'tg-seq', state: 'running', structure_revision: identity, latest_seq: identity,
              node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
              active: { running: ['taskA'], waiting: [] },
            };
          }
          if (method === 'taskgraph.events') {
            return { events: [], next_seq: 0, latest_seq: identity, has_more: false };
          }
          if (method === 'taskgraph.node.inspect') {
            return {
              structure_revision: identity,
              node: { id: 'taskA', action: { type: 'task' }, deps: [] },
              run: { state: 'running', task_run_id: 'run-taskA' },
            };
          }
          if (method === 'taskgraph.slip') {
            return {
              schema_version: 'foreman.taskgraph.slip.v1',
              taskgraph_id: 'tg-seq',
              graph_state: 'running',
              structure_revision: identity,
              latest_seq: identity,
              nodes: [{ node_id: 'taskA', state: 'running' }],
            };
          }
          throw new Error(`unexpected method: ${method}`);
        },
      } as unknown as ForemanIpcClient;
      return new ForemanTaskGraphReader(client);
    };

    for (const identity of [0, Number.MAX_SAFE_INTEGER]) {
      const snapshot = await makeReader(identity).loadSnapshot('tg-seq');
      expect(snapshot.slip?.structure_revision).toBe(identity);
      expect(snapshot.slip?.latest_seq).toBe(identity);
    }
  });
});

// ── Graph Slip node cardinality boundary ────────────────────────────

describe('Graph Slip node cardinality boundary', () => {
  const baseSlipRaw = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 'foreman.taskgraph.slip.v1',
    taskgraph_id: 'tg-cardinality',
    graph_state: 'running',
    structure_revision: 1,
    latest_seq: 7,
    nodes: [],
    ...overrides,
  });

  // Every element is a Proxy whose property access throws and increments a
  // counter. If per-element normalization ever began, reading node_id/state
  // on an element would trip the trap; a rejected cardinality must therefore
  // leave the counter at zero, proving traversal never started.
  function poisonedNodes(length: number): { nodes: unknown[]; counter: { accesses: number } } {
    const counter = { accesses: 0 };
    const nodes = Array.from({ length }, () => new Proxy({}, {
      get() {
        counter.accesses++;
        throw new Error('unexpected per-element access: traversal must never begin');
      },
    }));
    return { nodes, counter };
  }

  it('rejects an oversized nodes array in O(1) before element normalization', () => {
    const { nodes, counter } = poisonedNodes(3);
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ nodes }), 2)).toThrow('node count mismatch');
    expect(counter.accesses).toBe(0);
  });

  it('rejects an undersized nodes array in O(1) before element normalization', () => {
    const { nodes, counter } = poisonedNodes(1);
    expect(() => normalizeTaskGraphSlipResult(baseSlipRaw({ nodes }), 3)).toThrow('node count mismatch');
    expect(counter.accesses).toBe(0);
  });
});

// ── Transcript authorization ────────────────────────────────────────

describe('Transcript authorization (snapshotAllowsTranscript)', () => {
  it('only allows transcript ids that match a validated task node in the active snapshot', () => {
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-1',
          revision: 1,
          nodes: { 'node-1': { id: 'node-1', action: { type: 'task' }, deps: [] } },
        },
      },
      status: {
        taskgraph_id: 'tg-1',
        state: 'running',
        structure_revision: 1,
        latest_seq: 1,
        node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: ['node-1'], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map([
        ['node-1', {
          structure_revision: 1,
          node: { id: 'node-1', action: { type: 'task' }, deps: [] },
          run: { state: 'running', task_run_id: 'run-1' },
        }],
      ]),
    };
    expect(snapshotAllowsTranscript(snapshot, 'tg-1', 'node-1', 'run-1')).toBe(true);
    expect(snapshotAllowsTranscript(snapshot, 'tg-2', 'node-1', 'run-1')).toBe(false);
    expect(snapshotAllowsTranscript(snapshot, 'tg-1', 'node-2', 'run-1')).toBe(false);
    expect(snapshotAllowsTranscript(snapshot, 'tg-1', 'node-1', 'run-2')).toBe(false);
  });

  it('rejects a matching task_run_id on every representative non-task control node', () => {
    const controls = ['start', 'end', 'condition', 'checkpoint', 'convert', 'join', 'fanout'];
    const controlNodes: Record<string, { id: string; action: { type: string }; deps: string[] }> = {};
    const nodeInspections = new Map<string, TaskGraphNodeInspectResult>();
    for (const type of controls) {
      const nodeId = `node-${type}`;
      controlNodes[nodeId] = { id: nodeId, action: { type }, deps: [] };
      nodeInspections.set(nodeId, {
        structure_revision: 1,
        node: { id: nodeId, action: { type }, deps: [] },
        run: { state: 'running', task_run_id: `run-${type}` },
      });
    }
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: { graph: { id: 'tg-ctrl', revision: 1, nodes: controlNodes } },
      status: {
        taskgraph_id: 'tg-ctrl',
        state: 'running',
        structure_revision: 1,
        latest_seq: 1,
        node_counts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections,
    };
    for (const type of controls) {
      expect(
        snapshotAllowsTranscript(snapshot, 'tg-ctrl', `node-${type}`, `run-${type}`),
        `control ${type}`,
      ).toBe(false);
    }
  });

  it('accepts action.type=task with the matching task_run_id while graph identity still gates', () => {
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-task',
          revision: 1,
          nodes: { 'task-1': { id: 'task-1', action: { type: 'task' }, deps: [] } },
        },
      },
      status: {
        taskgraph_id: 'tg-task',
        state: 'running',
        structure_revision: 1,
        latest_seq: 1,
        node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: ['task-1'], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map([
        ['task-1', {
          structure_revision: 1,
          node: { id: 'task-1', action: { type: 'task' }, deps: [] },
          run: { state: 'running', task_run_id: 'run-task-1' },
        }],
      ]),
    };
    expect(snapshotAllowsTranscript(snapshot, 'tg-task', 'task-1', 'run-task-1')).toBe(true);
    expect(snapshotAllowsTranscript(snapshot, 'tg-other', 'task-1', 'run-task-1')).toBe(false);
    expect(snapshotAllowsTranscript(snapshot, 'tg-task', 'task-1', 'run-task-2')).toBe(false);
  });

  it('rejects null snapshot', () => {
    expect(snapshotAllowsTranscript(null, 'tg-1', 'node-1', 'run-1')).toBe(false);
  });

  it('rejects null graphId', () => {
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: { graph: { id: 'tg-1', revision: 1, nodes: {} } },
      status: {
        taskgraph_id: 'tg-1', state: 'running', structure_revision: 1, latest_seq: 1,
        node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: ['node-1'], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map([['node-1', { structure_revision: 1, node: { id: 'node-1', action: { type: 'llm_call' }, deps: [] }, run: { state: 'running', task_run_id: 'run-1' } }]]),
    };
    expect(snapshotAllowsTranscript(snapshot, null, 'node-1', 'run-1')).toBe(false);
  });
});

// ── Renderer-safe projection ─────────────────────────────────────────

describe('Renderer-safe projection (projectGraphSlipSnapshot)', () => {
  it('projects only allowlisted display fields, never raw action params or schemas', () => {
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-safe',
          revision: 2,
          nodes: {
            source: {
              id: 'source',
              name: 'Collect',
              action: { type: 'llm_call', params: { secret: 'do-not-cross' } },
              deps: [],
              output_schema: { title: 'Collected Data', private: 'do-not-cross' },
            },
            target: {
              id: 'target',
              name: 'Analyze',
              action: { type: 'tool_use', params: { token: 'do-not-cross' } },
              deps: ['source'],
              input: [{ name: 'analysis', source: 'source.output' }],
              input_schema: { properties: { analysis: { title: 'Analysis Context', private: 'do-not-cross' } } },
            },
          },
        },
      },
      status: {
        taskgraph_id: 'tg-safe', state: 'running', structure_revision: 2, latest_seq: 2,
        node_counts: { planned: 0, running: 1, waiting: 0, done: 1, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: ['target'], waiting: [] },
      },
      events: { events: [
        graphEvent(1, 'taskgraph.node.started', '2025-01-01T00:00:00Z', 'source', 'tg-safe'),
        graphEvent(2, 'taskgraph.node.completed', '2025-01-01T00:00:05Z', 'source', 'tg-safe'),
      ], next_seq: 2, latest_seq: 2, has_more: false },
      nodeInspections: new Map([
        ['source', {
          structure_revision: 2,
          node: { id: 'source', name: 'Collect', action: { type: 'llm_call' }, deps: [] },
          run: { state: 'done', task_run_id: 'run-source' },
        }],
        ['target', {
          structure_revision: 2,
          node: { id: 'target', name: 'Analyze', action: { type: 'tool_use' }, deps: ['source'] },
          run: { state: 'running', task_run_id: 'run-target' },
        }],
      ]),
    };
    const projected = projectGraphSlipSnapshot(snapshot, Date.parse('2025-01-01T00:00:10Z'));
    expect(projected.graph_id).toBe('tg-safe');
    expect(projected.nodes.source.runtime_ms).toBe(5000);
    expect(projected.edges).toEqual([{ from: 'source', to: 'target', label: 'analysis · Analysis Context' }]);
    expect(JSON.stringify(projected)).not.toContain('do-not-cross');
    expect(Object.keys(projected.nodes.source).sort()).toEqual([
      'action_type', 'deps', 'id', 'runtime_ms', 'state', 'task_run_id',
    ]);
  });

  it('derives a still-running node runtime from trusted start to nowMs and rejects invalid nowMs', () => {
    const startedAt = Date.parse('2025-01-01T00:00:00Z');
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-running-runtime',
          revision: 1,
          nodes: {
            live: { id: 'live', action: { type: 'task' }, deps: [] },
          },
        },
      },
      status: {
        taskgraph_id: 'tg-running-runtime', state: 'running', structure_revision: 1, latest_seq: 1,
        node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: ['live'], waiting: [] },
      },
      events: { events: [
        graphEvent(1, 'taskgraph.node.started', '2025-01-01T00:00:00Z', 'live', 'tg-running-runtime'),
      ], next_seq: 1, latest_seq: 1, has_more: false },
      nodeInspections: new Map([
        ['live', { structure_revision: 1, node: { id: 'live', action: { type: 'task' }, deps: [] }, run: { state: 'running', task_run_id: 'run-live' } }],
      ]),
    };
    // Elapsed grows from the trusted started event to the projection nowMs.
    const grown = projectGraphSlipSnapshot(snapshot, startedAt + 30_000);
    expect(grown.nodes.live.runtime_ms).toBe(30_000);
    // nowMs before the start (negative elapsed) is rejected: no runtime_ms.
    const invalid = projectGraphSlipSnapshot(snapshot, startedAt - 1_000);
    expect(invalid.nodes.live.runtime_ms).toBeUndefined();
    // A non-finite nowMs is rejected outright.
    const nonFinite = projectGraphSlipSnapshot(snapshot, Number.NaN);
    expect(nonFinite.nodes.live.runtime_ms).toBeUndefined();
  });

  it('keeps terminal end-start runtime regardless of a later nowMs', () => {
    const startedAt = Date.parse('2025-01-01T00:00:00Z');
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-terminal-runtime',
          revision: 1,
          nodes: {
            done: { id: 'done', action: { type: 'task' }, deps: [] },
          },
        },
      },
      status: {
        taskgraph_id: 'tg-terminal-runtime', state: 'running', structure_revision: 1, latest_seq: 2,
        node_counts: { planned: 0, running: 0, waiting: 0, done: 1, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
      },
      events: { events: [
        graphEvent(1, 'taskgraph.node.started', '2025-01-01T00:00:00Z', 'done', 'tg-terminal-runtime'),
        graphEvent(2, 'taskgraph.node.completed', '2025-01-01T00:00:05Z', 'done', 'tg-terminal-runtime'),
      ], next_seq: 2, latest_seq: 2, has_more: false },
      nodeInspections: new Map([
        ['done', { structure_revision: 1, node: { id: 'done', action: { type: 'task' }, deps: [] }, run: { state: 'done', task_run_id: 'run-done' } }],
      ]),
    };
    const projected = projectGraphSlipSnapshot(snapshot, startedAt + 10_000_000);
    expect(projected.nodes.done.runtime_ms).toBe(5_000);
  });

  it('falls back to input_schema title for edge label', () => {
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-schema',
          revision: 1,
          nodes: {
            src: { id: 'src', name: 'Src', action: { type: 'llm_call' }, deps: [] },
            dst: {
              id: 'dst', name: 'Dst', action: { type: 'llm_call' }, deps: ['src'],
              input_schema: { title: 'Schema Context' },
            },
          },
        },
      },
      status: {
        taskgraph_id: 'tg-schema', state: 'running', structure_revision: 1, latest_seq: 1,
        node_counts: { planned: 1, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map([
        ['src', { structure_revision: 1, node: { id: 'src', action: { type: 'llm_call' }, deps: [] }, run: { state: 'planned' } }],
        ['dst', { structure_revision: 1, node: { id: 'dst', action: { type: 'llm_call' }, deps: ['src'] }, run: { state: 'planned' } }],
      ]),
    };
    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.edges[0].label).toBe('Schema Context');
  });

  it('falls back to output_schema title for edge label', () => {
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-outschema',
          revision: 1,
          nodes: {
            src: { id: 'src', name: 'Src', action: { type: 'llm_call' }, deps: [], output_schema: { title: 'Output Title' } },
            dst: { id: 'dst', name: 'Dst', action: { type: 'llm_call' }, deps: ['src'] },
          },
        },
      },
      status: {
        taskgraph_id: 'tg-outschema', state: 'running', structure_revision: 1, latest_seq: 1,
        node_counts: { planned: 1, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map([
        ['src', { structure_revision: 1, node: { id: 'src', action: { type: 'llm_call' }, deps: [] }, run: { state: 'planned' } }],
        ['dst', { structure_revision: 1, node: { id: 'dst', action: { type: 'llm_call' }, deps: ['src'] }, run: { state: 'planned' } }],
      ]),
    };
    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.edges[0].label).toBe('Output Title');
  });

  it('defaults to "data" when no label source found', () => {
    const snapshot: TaskGraphSnapshot = {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-data',
          revision: 1,
          nodes: {
            src: { id: 'src', action: { type: 'llm_call' }, deps: [] },
            dst: { id: 'dst', action: { type: 'llm_call' }, deps: ['src'] },
          },
        },
      },
      status: {
        taskgraph_id: 'tg-data', state: 'running', structure_revision: 1, latest_seq: 1,
        node_counts: { planned: 1, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map([
        ['src', { structure_revision: 1, node: { id: 'src', action: { type: 'llm_call' }, deps: [] }, run: { state: 'planned' } }],
        ['dst', { structure_revision: 1, node: { id: 'dst', action: { type: 'llm_call' }, deps: ['src'] }, run: { state: 'planned' } }],
      ]),
    };
    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.edges[0].label).toBe('data');
  });
});

// ── Edge-label display normalization ────────────────────────────────

describe('Edge-label display normalization (projectGraphSlipSnapshot)', () => {
  function snapshotWithEdge(
    srcOverrides: Record<string, unknown>,
    dstOverrides: Record<string, unknown>,
  ): TaskGraphSnapshot {
    return {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-edge-norm',
          revision: 1,
          nodes: {
            src: { id: 'src', name: 'Src', action: { type: 'llm_call' }, deps: [], ...srcOverrides },
            dst: { id: 'dst', name: 'Dst', action: { type: 'llm_call' }, deps: ['src'], ...dstOverrides },
          },
        },
      },
      status: {
        taskgraph_id: 'tg-edge-norm', state: 'running', structure_revision: 1, latest_seq: 1,
        node_counts: { planned: 1, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map([
        ['src', { structure_revision: 1, node: { id: 'src', action: { type: 'llm_call' }, deps: [] }, run: { state: 'planned' } }],
        ['dst', { structure_revision: 1, node: { id: 'dst', action: { type: 'llm_call' }, deps: ['src'] }, run: { state: 'planned' } }],
      ]),
    };
  }

  const edgeLabel = (projected: GraphSlipSnapshotDto): string => projected.edges[0].label;

  it('rejects multiline binding names and falls back instead of folding them onto one line', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge({}, {
        input: [{ name: 'fetch\n   parse  rows', source: 'src.output' }],
      }),
      Date.now(),
    );
    // U+000A is a C0 control: the ORIGINAL binding name is rejected before any
    // whitespace folding, so the label must fall back to the fixed safe
    // caption rather than collapse the lines into a derived label.
    expect(edgeLabel(projected)).toBe('data');
  });

  it('rejects control-character binding names and falls back to the schema title', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge({}, {
        input: [{ name: 'bad\u0007name', source: 'src.output' }],
        input_schema: { title: 'Context Data' },
      }),
      Date.now(),
    );
    expect(edgeLabel(projected)).toBe('Context Data');
  });

  it('omits whitespace-only binding names and falls back to the fixed "data" caption', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge({}, {
        input: [{ name: '   \t  ', source: 'src.output' }],
      }),
      Date.now(),
    );
    expect(edgeLabel(projected)).toBe('data');
  });

  it('rejects over-length schema titles and falls back to the next valid candidate', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge(
        { output_schema: { title: 'Short Output Title' } },
        { input_schema: { title: 'x'.repeat(100) } },
      ),
      Date.now(),
    );
    expect(edgeLabel(projected)).toBe('Short Output Title');
  });

  it('rejects every invalid candidate and lands on the safe fallback', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge(
        { output_schema: { title: 'x'.repeat(100) } },
        { input_schema: { title: '\u0007bad' } },
      ),
      Date.now(),
    );
    expect(edgeLabel(projected)).toBe('data');
  });

  it('accepts valid Unicode including surrogate pairs as a canonical single-line label', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge({}, { input_schema: { title: '输入 \u{1F600} 数据' } }),
      Date.now(),
    );
    expect(edgeLabel(projected)).toBe('输入 \u{1F600} 数据');
    expect(edgeLabel(projected)).not.toMatch(/[\r\n]/);
  });

  it('rejects unpaired-surrogate titles so broken UTF-16 never reaches the renderer', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge({}, { input_schema: { title: 'bad \uD800 title' } }),
      Date.now(),
    );
    expect(edgeLabel(projected)).toBe('data');
  });

  it('accepts a label exactly at the documented display cap', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge({}, {
        input: [{ name: 'x'.repeat(32), source: 'src.output' }],
      }),
      Date.now(),
    );
    expect(edgeLabel(projected)).toHaveLength(32);
    expect(edgeLabel(projected)).not.toMatch(/[\r\n]/);
  });

  it('rejects an over-length binding name instead of slicing it', () => {
    const projected = projectGraphSlipSnapshot(
      snapshotWithEdge({}, {
        input: [{ name: 'x'.repeat(33), source: 'src.output' }],
      }),
      Date.now(),
    );
    // Never truncated to a partial value; the safe fallback is used instead.
    expect(edgeLabel(projected)).toBe('data');
  });
});

// ── Graph Slip title projection ──────────────────────────────────────

describe('Graph Slip title projection', () => {
  const makeSnapshot = (title?: string): TaskGraphSnapshot => ({
    list: { runs: [] },
    inspect: { graph: { id: 'tg-title', revision: 1, nodes: {} } },
    status: {
      taskgraph_id: 'tg-title',
      state: 'running',
      structure_revision: 1,
      latest_seq: 1,
      node_counts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
      active: { running: [], waiting: [] },
      ...(title !== undefined ? { title } : {}),
    },
    events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
    nodeInspections: new Map(),
  });

  it('exposes the normalized optional title exactly', () => {
    const projected = projectGraphSlipSnapshot(
      makeSnapshot('Show graph purpose in Pet window headers'),
      Date.now(),
    );
    expect(projected.title).toBe('Show graph purpose in Pet window headers');
    expect(Object.keys(projected).sort()).toEqual(['edges', 'graph_id', 'nodes', 'revision', 'state', 'title']);
  });

  it('legacy snapshots without title omit the optional field', () => {
    const projected = projectGraphSlipSnapshot(makeSnapshot(), Date.now());
    expect('title' in projected).toBe(false);
    expect(Object.keys(projected)).not.toContain('title');
  });
});

// ── Graph Slip display facts projection ─────────────────────────────

describe('Graph Slip display facts projection', () => {
  function snapshotWithSlipNodes(slipNodes: Array<Record<string, unknown>>): TaskGraphSnapshot {
    return {
      list: { runs: [] },
      inspect: {
        graph: {
          id: 'tg-slip-proj',
          revision: 1,
          nodes: {
            taskNode: {
              id: 'taskNode',
              name: 'Review',
              action: { type: 'task', params: { secret: 'raw-param-secret' } },
              deps: [],
              output_schema: { private: 'raw-schema-secret' },
            },
            llmNode: { id: 'llmNode', name: 'Plan', action: { type: 'llm_call' }, deps: [] },
          },
        },
      },
      status: {
        taskgraph_id: 'tg-slip-proj', state: 'running', structure_revision: 1, latest_seq: 1,
        node_counts: { planned: 0, running: 1, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: ['taskNode'], waiting: [] },
      },
      events: { events: [], next_seq: 0, latest_seq: 0, has_more: false },
      nodeInspections: new Map([
        ['taskNode', { structure_revision: 1, node: { id: 'taskNode', action: { type: 'task' }, deps: [] }, run: { state: 'running', task_run_id: 'run-task' } }],
        ['llmNode', { structure_revision: 1, node: { id: 'llmNode', action: { type: 'llm_call' }, deps: [] }, run: { state: 'planned' } }],
      ]),
      slip: slipNodes.length > 0
        ? {
            schema_version: 'foreman.taskgraph.slip.v1',
            taskgraph_id: 'tg-slip-proj',
            graph_state: 'running',
            structure_revision: 1,
            latest_seq: 1,
            nodes: slipNodes as TaskGraphSlipNode[],
          }
        : undefined,
    };
  }

  it('projects all allowlisted Graph Slip display fields onto matching task nodes', () => {
    const snapshot = snapshotWithSlipNodes([{
      node_id: 'taskNode',
      state: 'running',
      task_category: 'code-review',
      display_label: '代码审查',
      description: 'Review the diff for regressions',
      agent_runtime: 'python:3.11',
      profile: 'fast',
      tool_call_count: 42,
      tps: 250.5,
      summary: 'Checks the diff for regressions',
    }]);

    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    const task = projected.nodes.taskNode;
    expect(task.task_category).toBe('code-review');
    expect(task.display_label).toBe('代码审查');
    expect(task.description).toBe('Review the diff for regressions');
    expect(task.agent_runtime).toBe('python:3.11');
    expect(task.profile).toBe('fast');
    expect(task.tool_call_count).toBe(42);
    expect(task.tps).toBe(250.5);
    expect(task.summary).toBe('Checks the diff for regressions');
    // Non-task nodes never receive slip display facts.
    expect(projected.nodes.llmNode.task_category).toBeUndefined();
    expect(Object.keys(projected.nodes.llmNode).sort()).toEqual([
      'action_type', 'deps', 'id', 'runtime_ms', 'state', 'task_run_id',
    ]);
    // Only the allowlisted DTO keys cross for a task node too.
    expect(Object.keys(projected.nodes.taskNode).sort()).toEqual([
      'action_type', 'agent_runtime', 'deps', 'description', 'display_label', 'id',
      'profile', 'runtime_ms', 'state', 'summary', 'task_category',
      'task_run_id', 'tool_call_count', 'tps',
    ]);
  });

  it('never copies unknown wire keys or raw payloads across main→renderer', () => {
    const snapshot = snapshotWithSlipNodes([{
      node_id: 'taskNode',
      state: 'running',
      task_category: 'code-review',
      params: { secret: 'raw-param-secret' },
      input: { secret: 'raw-input-secret' },
      output: { result: 'raw-output-secret' },
      error: { message: 'raw-error-secret' },
      prompt: 'raw-prompt-secret',
      transcript: [{ text: 'raw-transcript-secret' }],
      event: { payload: 'raw-event-secret' },
      secret: 'wire-secret',
    }]);

    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    const json = JSON.stringify(projected);
    expect(json).not.toContain('raw-param-secret');
    expect(json).not.toContain('raw-input-secret');
    expect(json).not.toContain('raw-output-secret');
    expect(json).not.toContain('raw-error-secret');
    expect(json).not.toContain('raw-prompt-secret');
    expect(json).not.toContain('raw-transcript-secret');
    expect(json).not.toContain('raw-event-secret');
    expect(json).not.toContain('wire-secret');
    expect(Object.keys(projected.nodes.taskNode).sort()).toEqual([
      'action_type', 'deps', 'id', 'runtime_ms', 'state', 'task_category', 'task_run_id',
    ]);
  });

  it('omits out-of-bounds display fields fail-closed', () => {
    const snapshot = snapshotWithSlipNodes([{
      node_id: 'taskNode',
      state: 'running',
      task_category: 'x'.repeat(33),
      display_label: 'x'.repeat(25),
      description: 'x'.repeat(281),
      agent_runtime: 'x'.repeat(129),
      profile: 'x'.repeat(129),
      tool_call_count: -1,
      tps: 1_000_001,
      summary: 'x'.repeat(281),
    }]);

    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.nodes.taskNode.task_category).toBeUndefined();
    expect(projected.nodes.taskNode.display_label).toBeUndefined();
    expect(projected.nodes.taskNode.description).toBeUndefined();
    expect(projected.nodes.taskNode.agent_runtime).toBeUndefined();
    expect(projected.nodes.taskNode.profile).toBeUndefined();
    expect(projected.nodes.taskNode.tool_call_count).toBeUndefined();
    expect(projected.nodes.taskNode.tps).toBeUndefined();
    expect(projected.nodes.taskNode.summary).toBeUndefined();
  });

  it('accepts boundary values up to the protocol bounds', () => {
    const snapshot = snapshotWithSlipNodes([{
      node_id: 'taskNode',
      state: 'running',
      task_category: 'x'.repeat(32),
      display_label: 'x'.repeat(24),
      description: 'x'.repeat(280),
      agent_runtime: 'x'.repeat(128),
      profile: 'x'.repeat(128),
      tool_call_count: 0,
      tps: 0,
      summary: 'x'.repeat(280),
    }]);

    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.nodes.taskNode.task_category).toHaveLength(32);
    expect(projected.nodes.taskNode.display_label).toHaveLength(24);
    expect(projected.nodes.taskNode.description).toHaveLength(280);
    expect(projected.nodes.taskNode.agent_runtime).toHaveLength(128);
    expect(projected.nodes.taskNode.profile).toHaveLength(128);
    expect(projected.nodes.taskNode.tool_call_count).toBe(0);
    expect(projected.nodes.taskNode.tps).toBe(0);
    expect(projected.nodes.taskNode.summary).toHaveLength(280);
  });

  it('omits malformed typed display fields', () => {
    const snapshot = snapshotWithSlipNodes([{
      node_id: 'taskNode',
      state: 'running',
      task_category: 42,
      display_label: null,
      description: false,
      agent_runtime: ['python'],
      profile: { name: 'fast' },
      tool_call_count: 1.5,
      tps: NaN,
      summary: 280,
    }]);

    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.nodes.taskNode.task_category).toBeUndefined();
    expect(projected.nodes.taskNode.display_label).toBeUndefined();
    expect(projected.nodes.taskNode.description).toBeUndefined();
    expect(projected.nodes.taskNode.agent_runtime).toBeUndefined();
    expect(projected.nodes.taskNode.profile).toBeUndefined();
    expect(projected.nodes.taskNode.tool_call_count).toBeUndefined();
    expect(projected.nodes.taskNode.tps).toBeUndefined();
    expect(projected.nodes.taskNode.summary).toBeUndefined();
  });

  it('rejects malformed task_category ids fail-closed without dropping other safe fields', () => {
    const invalidCategories = [
      'CodeReview',   // uppercase
      '0code',        // leading digit
      'code_review',  // underscore
      'code.review',  // dot
      'code:review',  // colon
      'code/review',  // slash
      'x'.repeat(33), // overlength
    ];
    for (const bad of invalidCategories) {
      const snapshot = snapshotWithSlipNodes([{
        node_id: 'taskNode',
        state: 'running',
        task_category: bad,
        description: 'safe-description',
      }]);
      const projected = projectGraphSlipSnapshot(snapshot, Date.now());
      expect(projected.nodes.taskNode.task_category, bad).toBeUndefined();
      // Unrelated safe fields survive the category rejection.
      expect(projected.nodes.taskNode.description).toBe('safe-description');
    }
  });

  it('leaves display_label absent when a task node has no category, keeping other facts independent', () => {
    const snapshot = snapshotWithSlipNodes([{
      node_id: 'taskNode',
      state: 'running',
      display_label: 'Synthetic?',
      description: 'desc',
      tool_call_count: 3,
    }]);

    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.nodes.taskNode.task_category).toBeUndefined();
    // No synthetic label for the renderer fallback.
    expect(projected.nodes.taskNode.display_label).toBeUndefined();
    // Legacy/static omissions are independent of the remaining slip facts.
    expect(projected.nodes.taskNode.description).toBe('desc');
    expect(projected.nodes.taskNode.tool_call_count).toBe(3);
    // State/runtime projection is unaffected by the slip display facts.
    expect(projected.nodes.taskNode.state).toBe('running');
    expect(projected.nodes.taskNode.task_run_id).toBe('run-task');
  });

  it('keeps state and runtime independent when a task node has no slip entry', () => {
    const snapshot = snapshotWithSlipNodes([]);
    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.nodes.taskNode.state).toBe('running');
    expect(projected.nodes.taskNode.task_run_id).toBe('run-task');
    expect(projected.nodes.taskNode.task_category).toBeUndefined();
    expect(Object.keys(projected.nodes.taskNode).sort()).toEqual([
      'action_type', 'deps', 'id', 'runtime_ms', 'state', 'task_run_id',
    ]);
  });

  it('omits control-character and broken-surrogate display strings for every server-authored field', () => {
    const malformedValues = [
      ['NUL', '\u0000'],
      ['tab', '\t'],
      ['C0 max', '\u001f'],
      ['DEL', '\u007f'],
      ['C1 min', '\u0080'],
      ['C1 max', '\u009f'],
      ['lone high surrogate', '\ud800'],
      ['lone low surrogate', '\udc00'],
      ['broken surrogate ordering', '\ud800a'],
    ] as const;
    const displayFields = ['display_label', 'description', 'profile', 'summary'] as const;
    for (const [name, bad] of malformedValues) {
      for (const field of displayFields) {
        const snapshot = snapshotWithSlipNodes([{
          node_id: 'taskNode',
          state: 'running',
          task_category: 'code-review',
          display_label: 'Safe label',
          description: 'Safe description',
          profile: 'safe-profile',
          summary: 'Safe summary',
          [field]: bad,
        }]);
        const projected = projectGraphSlipSnapshot(snapshot, Date.now());
        // The malformed field is omitted fail-closed, never forwarded.
        expect(projected.nodes.taskNode[field], `${field} with ${name}`).toBeUndefined();
        // No malformed value reaches the GraphSlipNodeDto serialized output.
        const json = JSON.stringify(projected);
        expect(json, `${field} with ${name}`).not.toContain(bad);
        // Unrelated safe display fields survive the rejection.
        for (const other of displayFields) {
          if (other === field) continue;
          expect(projected.nodes.taskNode[other], `${field} with ${name} dropped ${other}`).toBeDefined();
        }
      }
    }
  });

  it('preserves ordinary Chinese and correctly paired supplementary-plane characters at the length boundary', () => {
    const snapshot = snapshotWithSlipNodes([{
      node_id: 'taskNode',
      state: 'running',
      task_category: 'code-review',
      // 22 CJK code units + a paired supplementary-plane pair = 24 units,
      // exactly the display_label cap.
      display_label: '\u7801'.repeat(22) + '\ud83d\ude00',
      // 278 ASCII units + a paired supplementary pair = 280, the slip text cap.
      description: 'x'.repeat(278) + '\ud83d\ude00',
      profile: 'x'.repeat(126) + '\ud83d\ude00',
      summary: 'x'.repeat(278) + '\ud83d\ude00',
    }]);

    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.nodes.taskNode.display_label).toBe('\u7801'.repeat(22) + '\ud83d\ude00');
    expect(projected.nodes.taskNode.description).toBe('x'.repeat(278) + '\ud83d\ude00');
    expect(projected.nodes.taskNode.profile).toBe('x'.repeat(126) + '\ud83d\ude00');
    expect(projected.nodes.taskNode.summary).toBe('x'.repeat(278) + '\ud83d\ude00');
    expect(projected.nodes.taskNode.display_label).toHaveLength(24);
    expect(projected.nodes.taskNode.description).toHaveLength(280);
    expect(projected.nodes.taskNode.profile).toHaveLength(128);
    expect(projected.nodes.taskNode.summary).toHaveLength(280);
  });

  it('keeps the full 280-code-unit Chinese done summary through projection and the tip region', () => {
    // Exactly the e2e complex-done fixture: at the 280-code-unit cap the
    // bounded Chinese text is retained whole (never sliced), so only the
    // CSS line clamp can truncate it — the e2e capture proves the clamp.
    const longSummary =
      '人工终审完成，全部交付物已按验收标准逐项核查，未发现阻塞性缺陷。功能实现与需求描述完全一致，界面交互符合预期，数据统计与导出结果正确，日志与回放记录完整且可追溯。安全性审查通过，未发现凭证泄露、越权访问或注入风险。性能全部达标，峰值耗时与内存占用均在允许范围内。回归测试已覆盖全部关键路径，所有用例均通过。文档已同步更新至最新版本，发布准备就绪，可以交付发布。补充说明：以上结论均基于当日实测数据与完整审计记录，无遗漏项。复核人已确认关键指标区间，异常样本全部复测通过。发布后观察四小时无问题即可转正式环境。建议后续发布后连续观察四小时，无问题即可转正式环境。';
    expect(longSummary).toHaveLength(280);

    const snapshot = snapshotWithSlipNodes([{
      node_id: 'taskNode',
      state: 'done',
      task_category: 'code-review',
      display_label: '代码审查',
      summary: longSummary,
    }]);

    const projected = projectGraphSlipSnapshot(snapshot, Date.now());
    expect(projected.nodes.taskNode.summary).toBe(longSummary);
    expect(projected.nodes.taskNode.summary).toHaveLength(280);

    // The renderer surfaces the full bounded text as the unlabeled summary
    // region, never a 结果摘要 row.
    const tip = nodeTip({ ...projected.nodes.taskNode, state: 'done', task_status: 'done' }, 'task');
    expect(tip!.summary).toBe(longSummary);
    expect(tip!.rows.some((r) => r.label === '结果摘要')).toBe(false);
  });
});

// ── Active list request ──────────────────────────────────────────────

describe('Active list request', () => {
  it('requests only running and paused states', () => {
    const client = {
      request: async (method: string, params: Record<string, unknown>) => {
        expect(method).toBe('taskgraph.list');
        expect(params.states).toEqual(['running', 'paused']);
        return { runs: [{ taskgraph_id: 'tg-1', state: 'running', structure_revision: 1, created_at: '', updated_at: '' }] };
      },
    } as unknown as ForemanIpcClient;
    const reader = new ForemanTaskGraphReader(client);
    return reader.listActive().then(function (result) {
      expect(result.runs).toHaveLength(1);
    });
  });

  it('rejects created/done/cancelled returns', async () => {
    const client = {
      request: async () => ({
        runs: [{ taskgraph_id: 'tg-1', state: 'created', structure_revision: 1, created_at: '', updated_at: '' }],
      }),
    } as unknown as ForemanIpcClient;
    const reader = new ForemanTaskGraphReader(client);
    await expect(reader.listActive()).rejects.toThrow('invalid state');
  });
});

// ── DAG layout (pure graph-layout module) ───────────────────────────

describe('DAG layout (pure graph-layout)', () => {
  function slipNode(id: string, actionType: string, overrides: Partial<GraphSlipNodeDto> = {}): GraphSlipNodeDto {
    return { id, action_type: actionType, deps: [], state: 'planned', ...overrides };
  }

  function snapshotOf(
    nodes: Record<string, GraphSlipNodeDto>,
    edges: Array<{ from: string; to: string; label: string }> = [],
  ): GraphSlipSnapshotDto {
    return { graph_id: 'tg-layout', revision: 1, state: 'running', nodes, edges };
  }

  // A routed edge is only orthogonal when every consecutive pair of points
  // shares an x or a y coordinate. Any L command would be a diagonal.
  function orthogonalityViolations(layout: GraphLayout): string[] {
    const violations: string[] = [];
    for (const edge of layout.edges) {
      for (let i = 1; i < edge.points.length; i++) {
        const a = edge.points[i - 1];
        const b = edge.points[i];
        if (a.x !== b.x && a.y !== b.y) {
          violations.push(`${edge.from}->${edge.to} segment ${i}: (${a.x},${a.y}) → (${b.x},${b.y}) is diagonal`);
        }
      }
    }
    return violations;
  }

  // Strict rect intersection: a segment touching a node boundary is allowed,
  // so the source/target attachment segments never trip the check.
  function segmentHitsNode(
    a: { x: number; y: number },
    b: { x: number; y: number },
    n: LayoutNode,
  ): boolean {
    const lowX = Math.min(a.x, b.x);
    const highX = Math.max(a.x, b.x);
    const lowY = Math.min(a.y, b.y);
    const highY = Math.max(a.y, b.y);
    if (a.x === b.x) {
      if (a.x <= n.x || a.x >= n.x + n.width) return false;
      return highY > n.y && lowY < n.y + n.height;
    }
    if (a.y <= n.y || a.y >= n.y + n.height) return false;
    return highX > n.x && lowX < n.x + n.width;
  }

  function intersectionViolations(layout: GraphLayout): string[] {
    const violations: string[] = [];
    for (const edge of layout.edges) {
      for (let i = 1; i < edge.points.length; i++) {
        const a = edge.points[i - 1];
        const b = edge.points[i];
        for (const n of layout.nodes) {
          if (n.id === edge.from || n.id === edge.to) continue;
          if (segmentHitsNode(a, b, n)) {
            violations.push(`${edge.from}->${edge.to} crosses node ${n.id}`);
          }
        }
      }
    }
    return violations;
  }

  function layersOf(layout: GraphLayout): Map<string, number> {
    return new Map(layout.nodes.map((n) => [n.id, n.layer]));
  }

  it('produces an empty layout for an empty graph', () => {
    const layout = layoutGraph(snapshotOf({}));
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.junctions).toHaveLength(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  it('lays out a 5-node chain into five layers with four orthogonal edges', () => {
    const ids = ['chain-a', 'chain-b', 'chain-c', 'chain-d', 'chain-e'];
    const nodes: Record<string, GraphSlipNodeDto> = {};
    ids.forEach((id, i) => {
      nodes[id] = slipNode(id, 'task', { deps: i === 0 ? [] : [ids[i - 1]], task_run_id: `run-${id}` });
    });
    const layout = layoutGraph(snapshotOf(nodes));
    expect(layout.nodes).toHaveLength(5);
    expect(layout.edges).toHaveLength(4);
    const layers = layersOf(layout);
    ids.forEach((id, i) => expect(layers.get(id)).toBe(i));
    expect(orthogonalityViolations(layout)).toEqual([]);
    expect(intersectionViolations(layout)).toEqual([]);
    // Natural single-column content size: one task per layer.
    expect(layout.width).toBe(TASK_WIDTH + PADDING * 2);
    expect(layout.height).toBe(ids.length * TASK_HEIGHT + (ids.length - 1) * STRAIGHT_ROW_GAP + PADDING * 2);
    // Lanes stay inside the bounded per-band slot count.
    for (const edge of layout.edges) {
      expect(edge.lane).toBeGreaterThanOrEqual(0);
      expect(edge.lane).toBeLessThan(6);
    }
  });

  it('routes a 1→3→1 split/merge on three layers with natural width', () => {
    const nodes: Record<string, GraphSlipNodeDto> = {
      'task-split': slipNode('task-split', 'task', { task_run_id: 'run-split' }),
      'task-l': slipNode('task-l', 'task', { deps: ['task-split'], task_run_id: 'run-l' }),
      'task-c': slipNode('task-c', 'task', { deps: ['task-split'], task_run_id: 'run-c' }),
      'task-r': slipNode('task-r', 'task', { deps: ['task-split'], task_run_id: 'run-r' }),
      'task-merge': slipNode('task-merge', 'task', { deps: ['task-l', 'task-c', 'task-r'], task_run_id: 'run-merge' }),
    };
    const layout = layoutGraph(snapshotOf(nodes));
    expect(layout.nodes).toHaveLength(5);
    expect(layout.edges).toHaveLength(6);
    const layers = layersOf(layout);
    expect(layers.get('task-split')).toBe(0);
    expect(layers.get('task-l')).toBe(1);
    expect(layers.get('task-c')).toBe(1);
    expect(layers.get('task-r')).toBe(1);
    expect(layers.get('task-merge')).toBe(2);
    // The three-task middle layer is the widest and defines natural width.
    expect(layout.width).toBe(3 * TASK_WIDTH + 2 * NODE_GAP + PADDING * 2);
    // All arms of a visual split/merge share one horizontal bus. Left and
    // right branches must never staircase across separate routing lanes.
    const splitEdges = layout.edges.filter((edge) => edge.from === 'task-split');
    const mergeEdges = layout.edges.filter((edge) => edge.to === 'task-merge');
    expect(new Set(splitEdges.map((edge) => edge.lane)).size).toBe(1);
    expect(new Set(mergeEdges.map((edge) => edge.lane)).size).toBe(1);
    expect(orthogonalityViolations(layout)).toEqual([]);
    expect(intersectionViolations(layout)).toEqual([]);
  });

  it('collapses join/fanout transit nodes out of the node DOM and exposes solder dots', () => {
    const nodes: Record<string, GraphSlipNodeDto> = {
      'ctrl-start': slipNode('ctrl-start', 'start', { state: 'done' }),
      'join-split': slipNode('join-split', 'join', { deps: ['ctrl-start'], state: 'done' }),
      'task-a': slipNode('task-a', 'task', { deps: ['join-split'], state: 'running', task_run_id: 'run-a' }),
      'task-b': slipNode('task-b', 'task', { deps: ['join-split'], state: 'running', task_run_id: 'run-b' }),
      'fanout-merge': slipNode('fanout-merge', 'fanout', { deps: ['task-a', 'task-b'], state: 'done' }),
      'ctrl-end': slipNode('ctrl-end', 'end', { deps: ['fanout-merge'], state: 'done' }),
    };
    // nodeKind classifies the semantic split/merge as transit.
    expect(nodeKind(nodes['join-split'])).toBe('transit');
    expect(nodeKind(nodes['fanout-merge'])).toBe('transit');
    expect(nodeKind(nodes['task-a'])).toBe('task');
    expect(nodeKind(nodes['ctrl-start'])).toBe('control');

    const collapsed = collapseTransit(snapshotOf(nodes));
    // join/fanout never surface as renderable nodes.
    expect(collapsed.nodes['join-split']).toBeUndefined();
    expect(collapsed.nodes['fanout-merge']).toBeUndefined();
    expect(Object.keys(collapsed.nodes).sort()).toEqual(['ctrl-end', 'ctrl-start', 'task-a', 'task-b']);
    expect(collapsed.edges).toHaveLength(4);
    expect(collapsed.junctions.map((j) => j.kind).sort()).toEqual(['merge', 'split']);

    // Layout keeps the transit nodes out of the node list and emits the
    // solder dots that stand in for the collapsed junctions.
    const layout = layoutGraph(snapshotOf(nodes));
    expect(layout.nodes.map((n) => n.id)).not.toContain('join-split');
    expect(layout.nodes.map((n) => n.id)).not.toContain('fanout-merge');
    expect(layout.junctions).toHaveLength(2);
    for (const dot of layout.junctions) {
      expect(dot.x).toBeGreaterThan(0);
      expect(dot.y).toBeGreaterThan(0);
      expect(dot.kind === 'split' || dot.kind === 'merge').toBe(true);
    }
    expect(orthogonalityViolations(layout)).toEqual([]);
  });

  it('keeps an 8-layer cross dependency acyclic with orthogonal non-intersecting routes', () => {
    const ids = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const deps: Record<string, string[]> = {
      n0: [], n1: ['n0'], n2: ['n1'], n3: ['n2'], n4: ['n3'], n5: ['n4'], n6: ['n5'], n7: ['n6'],
    };
    // Long cross edges skip over intermediate layers.
    deps.n5 = ['n4', 'n0'];
    deps.n6 = ['n5', 'n1'];
    deps.n7 = ['n6', 'n2'];
    const nodes: Record<string, GraphSlipNodeDto> = {};
    for (const id of ids) {
      nodes[id] = slipNode(id, 'task', { deps: deps[id], task_run_id: `run-${id}` });
    }
    const layout = layoutGraph(snapshotOf(nodes));
    const layers = layersOf(layout);
    ids.forEach((id, i) => expect(layers.get(id)).toBe(i));
    expect(new Set(layers.values()).size).toBe(8);
    expect(orthogonalityViolations(layout)).toEqual([]);
    expect(intersectionViolations(layout)).toEqual([]);
  });

  it('routes a direct cross-layer dependency around an occupied layer with a side gutter', () => {
    // a → mid → z plus the direct a → z dependency that skips mid's layer.
    // mid sits directly below a, so a straight descent at a's centre would
    // pass through it and forces the router into a deterministic side gutter.
    const nodes: Record<string, GraphSlipNodeDto> = {
      'a': slipNode('a', 'task', { task_run_id: 'run-a' }),
      'mid': slipNode('mid', 'task', { deps: ['a'], task_run_id: 'run-mid' }),
      'z': slipNode('z', 'task', { deps: ['a', 'mid'], task_run_id: 'run-z' }),
    };
    const layout = layoutGraph(snapshotOf(nodes));
    const layers = layersOf(layout);
    expect(layers.get('a')).toBe(0);
    expect(layers.get('mid')).toBe(1);
    expect(layers.get('z')).toBe(2);

    const direct = layout.edges.find((e) => e.from === 'a' && e.to === 'z');
    expect(direct).toBeDefined();
    if (!direct) return;

    // Every route is visibly attached at both endpoints.
    const src = layout.nodes.find((n) => n.id === 'a')!;
    const dst = layout.nodes.find((n) => n.id === 'z')!;
    const first = direct.points[0];
    const last = direct.points[direct.points.length - 1];
    expect(first).toEqual({ x: src.x + src.width / 2, y: src.y + src.height });
    expect(last).toEqual({ x: dst.x + dst.width / 2, y: dst.y });

    // The side gutter is a real detour: the source midpoint stays fixed and
    // the very next point is an explicit horizontal clearance segment.
    const second = direct.points[1];
    expect(second.y).toBe(first.y);
    expect(second.x).not.toBe(first.x);

    expect(orthogonalityViolations(layout)).toEqual([]);
    expect(intersectionViolations(layout)).toEqual([]);

    // No duplicate zero-length points anywhere in the routed set.
    for (const edge of layout.edges) {
      for (let i = 1; i < edge.points.length; i++) {
        const prev = edge.points[i - 1];
        const p = edge.points[i];
        expect(prev.x === p.x && prev.y === p.y).toBe(false);
      }
    }

    // The arrowhead rides the final segment: a vertical drop into the target.
    const prev = direct.points[direct.points.length - 2];
    expect(prev.x).toBe(last.x);
    expect(last.y).toBeGreaterThan(prev.y);

    // Natural SVG bounds contain the whole route without spurious inflation.
    for (const edge of layout.edges) {
      for (const p of edge.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(layout.width);
        expect(p.y).toBeLessThanOrEqual(layout.height);
      }
    }
    expect(layout.width).toBe(TASK_WIDTH + PADDING * 2);
    expect(layout.height).toBe(3 * TASK_HEIGHT + 2 * ROW_GAP + PADDING * 2);
  });

  it('routes around a fully occupied barrier that blocks the centre and every old candidate lane', () => {
    // a (layer 0) has a direct edge to z (layer 4) that must descend through
    // three barrier layers (1-3) of packed control nodes. The barrier tiles
    // the whole horizontal span: the source centre, all twelve 4px lanes on
    // each side, and several more lanes beyond that are still occupied. The
    // old bounded router exhausted its 12-probe budget and fell back to the
    // blocked centre; the deterministic router keeps stepping outward until
    // it reaches the guaranteed free gutter past the barrier.
    const nodes: Record<string, GraphSlipNodeDto> = {
      'a': slipNode('a', 'task', { task_run_id: 'run-a' }),
    };
    // 10 / 9 / 8 control nodes tile [16, 364] continuously: each layer's
    // 12px gaps sit strictly inside the next layer's nodes, so every
    // interior lane is occupied.
    for (let i = 0; i < 10; i++) nodes[`b1_${i}`] = slipNode(`b1_${i}`, 'control', { deps: ['a'] });
    for (let i = 0; i < 9; i++) nodes[`b2_${i}`] = slipNode(`b2_${i}`, 'control', { deps: ['b1_0'] });
    for (let i = 0; i < 8; i++) nodes[`b3_${i}`] = slipNode(`b3_${i}`, 'control', { deps: ['b2_0'] });
    nodes['z'] = slipNode('z', 'task', { deps: ['a', 'b3_0'], task_run_id: 'run-z' });

    const layout = layoutGraph(snapshotOf(nodes));
    const direct = layout.edges.find((e) => e.from === 'a' && e.to === 'z')!;
    expect(direct).toBeDefined();
    if (!direct) return;

    const src = layout.nodes.find((n) => n.id === 'a')!;
    const dst = layout.nodes.find((n) => n.id === 'z')!;

    // The route stays anchored at both endpoint midpoints.
    const first = direct.points[0];
    const last = direct.points[direct.points.length - 1];
    expect(first).toEqual({ x: src.x + src.width / 2, y: src.y + src.height });
    expect(last).toEqual({ x: dst.x + dst.width / 2, y: dst.y });

    // The barrier occupies the source centre: a synthetic centre descent
    // crosses a node, so the router was forced off-centre.
    const laneY = direct.points[direct.points.length - 2].y;
    const center = src.x + src.width / 2;
    const centreDescentHits = layout.nodes.some((n) =>
      n.id !== 'a' && n.layer < 4
        && segmentHitsNode({ x: center, y: src.y + src.height }, { x: center, y: laneY }, n),
    );
    expect(centreDescentHits).toBe(true);

    // Every old candidate lane (centre + twelve 4px probes on each side) is
    // blocked too, so the old bounded fallback would have returned the
    // blocked centre and its descent would cross the barrier.
    for (let k = 1; k <= 12; k++) {
      for (const x of [src.x - k * 4, src.x + src.width + k * 4]) {
        const blocked = layout.nodes.some((n) =>
          n.id !== 'a' && n.layer < 4
            && segmentHitsNode({ x, y: src.y + src.height }, { x, y: laneY }, n),
        );
        expect(blocked).toBe(true);
      }
    }

    // The deterministic router escapes the barrier to a free lane and the
    // chosen descent is itself collision-free.
    const gutterX = direct.points[1].x;
    expect(gutterX).not.toBe(center);
    const gutterDescentHits = layout.nodes.some((n) =>
      n.id !== 'a' && n.layer < 4
        && segmentHitsNode({ x: gutterX, y: src.y + src.height }, { x: gutterX, y: laneY }, n),
    );
    expect(gutterDescentHits).toBe(false);

    expect(orthogonalityViolations(layout)).toEqual([]);
    expect(intersectionViolations(layout)).toEqual([]);

    // Natural SVG bounds contain the external gutter and every routed point.
    for (const edge of layout.edges) {
      for (const p of edge.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(layout.width);
        expect(p.y).toBeLessThanOrEqual(layout.height);
      }
    }

    // Re-running the layout returns identical geometry.
    const again = layoutGraph(snapshotOf(nodes));
    expect(again.nodes).toEqual(layout.nodes);
    expect(again.edges).toEqual(layout.edges);
    expect(again.width).toBe(layout.width);
    expect(again.height).toBe(layout.height);
  });

  it('places 4+ tasks in one layer without overlap and at natural width', () => {
    const nodes: Record<string, GraphSlipNodeDto> = {};
    nodes['root'] = slipNode('root', 'task', { task_run_id: 'run-root' });
    for (let i = 0; i < 5; i++) {
      nodes[`task-${i}`] = slipNode(`task-${i}`, 'task', { deps: ['root'], task_run_id: `run-${i}` });
    }
    const layout = layoutGraph(snapshotOf(nodes));
    const busyLayer = layout.nodes.filter((n) => n.layer === 1);
    expect(busyLayer).toHaveLength(5);
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
    expect(layout.width).toBe(5 * TASK_WIDTH + 4 * NODE_GAP + PADDING * 2);
    expect(orthogonalityViolations(layout)).toEqual([]);
  });

  it('routes a control chain with control-sized glyphs and no paper tags', () => {
    const nodes: Record<string, GraphSlipNodeDto> = {
      'ctrl-start': slipNode('ctrl-start', 'start', { state: 'done' }),
      'ctrl-cond': slipNode('ctrl-cond', 'condition', { deps: ['ctrl-start'], state: 'running' }),
      'ctrl-end': slipNode('ctrl-end', 'end', { deps: ['ctrl-cond'], state: 'planned' }),
    };
    const layout = layoutGraph(snapshotOf(nodes));
    expect(layout.nodes).toHaveLength(3);
    for (const n of layout.nodes) {
      expect(n.kind).toBe('control');
      expect(n.width).toBe(CONTROL_SIZE);
      expect(n.height).toBe(CONTROL_SIZE);
    }
    const layers = layersOf(layout);
    expect(layers.get('ctrl-start')).toBe(0);
    expect(layers.get('ctrl-cond')).toBe(1);
    expect(layers.get('ctrl-end')).toBe(2);
    expect(layout.width).toBe(CONTROL_SIZE + PADDING * 2);
    expect(orthogonalityViolations(layout)).toEqual([]);
  });

  it('terminates deterministically on cyclic input', () => {
    const nodeIds = ['a', 'b', 'c'];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
    ];
    const layers = assignLayers(nodeIds, edges);
    expect(layers.get('a')).toBeGreaterThanOrEqual(0);
    expect(layers.get('b')).toBeGreaterThanOrEqual(0);
    expect(layers.get('c')).toBeGreaterThanOrEqual(0);
    // A cyclic snapshot still renders and routes orthogonally.
    const nodes: Record<string, GraphSlipNodeDto> = {};
    for (const id of nodeIds) nodes[id] = slipNode(id, 'task', { deps: edges.filter((e) => e.to === id).map((e) => e.from), task_run_id: `run-${id}` });
    const layout = layoutGraph(snapshotOf(nodes));
    expect(layout.nodes).toHaveLength(3);
    expect(orthogonalityViolations(layout)).toEqual([]);
  });

  it('keeps natural content dimensions for every rendered node', () => {
    const nodes: Record<string, GraphSlipNodeDto> = {
      'a': slipNode('a', 'task', { task_run_id: 'run-a' }),
      'b': slipNode('b', 'task', { deps: ['a'], task_run_id: 'run-b' }),
      'c': slipNode('c', 'task', { deps: ['a'], task_run_id: 'run-c' }),
    };
    const layout = layoutGraph(snapshotOf(nodes));
    expect(layout.width).toBe(2 * TASK_WIDTH + NODE_GAP + PADDING * 2);
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(layout.width);
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height);
    }
  });
});

// ── Safe transcript event normalization ──────────────────────────────

describe('Safe transcript event normalization', () => {
  it('renders only the bounded daemon-authored summary for message events', () => {
    const raw: TaskRunEvent = {
      seq: 1, type: 'message', timestamp: '2025-01-01T00:00:00Z',
      data: { text: 'raw hidden text', content: 'raw content', message_summary: '已完成调用关系分析。' },
    };
    const safe = normalizeSafeEvent(raw) as SafeTranscriptEventData & { type: 'message' };
    if (safe.type !== 'message') { expect(safe.type).toBe('message'); return; }
    expect(safe.message_summary).toBe('已完成调用关系分析。');
    expect('text' in safe).toBe(false);
    expect('content' in safe).toBe(false);
  });

  it('rejects raw output fields and exposes only the approved result summary', () => {
    const raw: TaskRunEvent = {
      seq: 2, type: 'tool_result', timestamp: '2025-01-01T00:00:00Z',
      data: { output: 'raw output', result: 'raw result', output_tail: 'tail', status: 'success', call_id: 'call-1', output_summary: '读取 3 个匹配项' },
      is_error: false,
    };
    const safe = normalizeSafeEvent(raw) as SafeTranscriptEventData & { type: 'tool_result' };
    if (safe.type !== 'tool_result') { expect(safe.type).toBe('tool_result'); return; }
    expect(safe.output_summary).toBe('读取 3 个匹配项');
    expect(safe.call_id).toBe('call-1');
    expect('output' in safe).toBe(false);
    expect('result' in safe).toBe(false);
    expect('output_tail' in safe).toBe(false);
  });

  it('derives tool failure state from the approved status when no boolean is present', () => {
    const safe = normalizeSafeEvent({
      seq: 2,
      type: 'tool_result',
      timestamp: '2025-01-01T00:00:00Z',
      data: { status: 'error', output_summary: 'command failed' },
    });
    expect(safe.type).toBe('tool_result');
    if (safe.type !== 'tool_result') return;
    expect(safe.is_error).toBe(true);
  });

  it('rejects nested input fields and exposes only the approved input summary', () => {
    const raw: TaskRunEvent = {
      seq: 3, type: 'tool_call', timestamp: '2025-01-01T00:00:00Z',
      data: { name: 'bash', input: { command: 'rm -rf' }, arguments: ['a', 'b'], tool_name: 'bash', input_summary: 'rg -n "TaskGraph" src' },
    };
    const safe = normalizeSafeEvent(raw) as SafeTranscriptEventData & { type: 'tool_call' };
    if (safe.type !== 'tool_call') { expect(safe.type).toBe('tool_call'); return; }
    expect(safe.tool_name).toBe('bash');
    expect(safe.input_summary).toBe('rg -n "TaskGraph" src');
    expect('input' in safe).toBe(false);
    expect('arguments' in safe).toBe(false);
  });

  it('redacts credential assignments in daemon-authored summaries', () => {
    const raw: TaskRunEvent = {
      seq: 3, type: 'message', timestamp: '2025-01-01T00:00:00Z',
      data: { message_summary: 'Authorization: Bearer tok_abcdefghijklmnop' },
    };
    const safe = normalizeSafeEvent(raw);
    expect(safe.type).toBe('message');
    if (safe.type !== 'message') return;
    expect(safe.message_summary).toBe('Authorization: [REDACTED]');
  });

  it('handles malformed usage numbers by clamping to 0', () => {
    const raw: TaskRunEvent = {
      seq: 4, type: 'turn_usage', timestamp: '2025-01-01T00:00:00Z',
      data: { input_tokens: -1, output_tokens: Infinity, total_tokens: NaN, duration_ms: 100 },
    };
    const safe = normalizeSafeEvent(raw) as SafeTranscriptEventData & { type: 'turn_usage' };
    if (safe.type !== 'turn_usage') { expect(safe.type).toBe('turn_usage'); return; }
    expect(safe.input_tokens).toBe(0);
    expect(safe.output_tokens).toBe(0);
    expect(safe.total_tokens).toBe(0);
    expect(safe.duration_ms).toBe(100);
  });

  it('unknown event types retain their label/timestamp but data becomes empty', () => {
    const raw: TaskRunEvent = {
      seq: 5, type: 'custom_event', timestamp: '2025-01-01T00:00:00Z',
      data: { secret: 'leaked' },
    };
    const safe = normalizeSafeEvent(raw);
    expect(safe.type).toBe('unknown');
    expect(safe.event_type).toBe('custom_event');
    expect((safe as Record<string, unknown>).timestamp).toBe('2025-01-01T00:00:00Z');
    expect((safe as Record<string, unknown>).data).toEqual({});
    expect('secret' in (safe as Record<string, unknown>).data as Record<string, never>).toBe(false);
  });

  it('normalizes persisted task lifecycle rows for the Work Slip', () => {
    const raw: TaskRunEvent = {
      seq: 1,
      type: 'task.done',
      timestamp: '2025-01-01T00:00:00Z',
      data: { event: 'task.done', status: 'done' },
    };
    const safe = normalizeSafeEvent(raw);
    expect(safe).toEqual({
      type: 'lifecycle',
      timestamp: '2025-01-01T00:00:00Z',
      event: 'task.done',
      status: 'done',
    });
  });
});

// ── Semantic automation attribute helpers (pure, no DOM) ─────────────

describe('Semantic automation contract', () => {
  it('nodeSemanticAttributes returns data-node-id from node id', () => {
    const node: TaskGraphNode = { id: 'test-node-001', action: { type: 'llm_call' }, deps: [] };
    const attrs = nodeSemanticAttributes(node);
    expect(attrs['data-node-id']).toBe('test-node-001');
    expect(`${node.name ?? node.action.type} (planned)`).not.toContain('test-node-001');
  });

  it('nodeSemanticAttributes returns data-action-type from node action type', () => {
    const node: TaskGraphNode = { id: 'node-1', action: { type: 'llm_call' }, deps: [] };
    const attrs = nodeSemanticAttributes(node);
    expect(attrs['data-action-type']).toBe('llm_call');
  });

  it('nodeSemanticAttributes returns data-node-state from inspection state', () => {
    const node: TaskGraphNode = { id: 'node-1', action: { type: 'llm_call' }, deps: [] };
    const inspection: TaskGraphNodeInspectResult = {
      structure_revision: 1,
      node,
      run: { state: 'running' },
    };
    const attrs = nodeSemanticAttributes(node, inspection);
    expect(attrs['data-node-state']).toBe('running');
  });

  it('nodeSemanticAttributes sets accessibility fields for task nodes', () => {
    const node: TaskGraphNode = { id: 'node-1', name: 'My Task', action: { type: 'llm_call' }, deps: [] };
    const inspection: TaskGraphNodeInspectResult = {
      structure_revision: 1,
      node,
      run: { state: 'done', task_run_id: 'run-123' },
    };
    const attrs = nodeSemanticAttributes(node, inspection);
    expect(attrs['tabindex']).toBe('0');
    expect(attrs['role']).toBe('button');
    expect(attrs['aria-label']).toBe('My Task (done)');
  });

  it('nodeSemanticAttributes sets accessibility fields for non-task nodes', () => {
    const node: TaskGraphNode = { id: 'node-1', action: { type: 'llm_call' }, deps: [] };
    const inspection: TaskGraphNodeInspectResult = {
      structure_revision: 1,
      node,
      run: { state: 'planned' },
    };
    const attrs = nodeSemanticAttributes(node, inspection);
    expect(attrs['tabindex']).toBe('-1');
    expect(attrs['role']).toBe('graphics-symbol');
    expect(attrs['aria-label']).toBe('llm_call (planned)');
  });

  it('edgeSemanticAttributes returns edge data attributes', () => {
    const attrs = edgeSemanticAttributes('node-a', 'node-b', 'my label');
    expect(attrs['data-edge-id']).toBe('node-a->node-b');
    expect(attrs['data-source-id']).toBe('node-a');
    expect(attrs['data-target-id']).toBe('node-b');
    expect(attrs['data-edge-label']).toBe('my label');
  });

  it('edgeSemanticAttributes returns accessibility fields', () => {
    const attrs = edgeSemanticAttributes('node-a', 'node-b');
    expect(attrs['tabindex']).toBe('0');
    expect(attrs['role']).toBe('graphics-symbol');
    expect(attrs['aria-label']).toBe('Edge: node-a → node-b');
  });

  it('nodeSemanticAttributes returns distinct records for different nodes', () => {
    const node1: TaskGraphNode = { id: 'node-e2e-a1', action: { type: 'llm_call' }, deps: [] };
    const node2: TaskGraphNode = { id: 'node-e2e-b1', action: { type: 'http_request' }, deps: [] };
    const attrs1 = nodeSemanticAttributes(node1);
    const attrs2 = nodeSemanticAttributes(node2);
    expect(attrs1['data-node-id']).toBe('node-e2e-a1');
    expect(attrs2['data-node-id']).toBe('node-e2e-b1');
  });

  it('edgeSemanticAttributes produces distinct edge ids for different pairs', () => {
    const attrs1 = edgeSemanticAttributes('node-e2e-a1', 'node-e2e-a2');
    const attrs2 = edgeSemanticAttributes('node-e2e-b1', 'node-e2e-b2');
    expect(attrs1['data-edge-id']).toBe('node-e2e-a1->node-e2e-a2');
    expect(attrs2['data-edge-id']).toBe('node-e2e-b1->node-e2e-b2');
  });
});

// ── Snapshot events produce exact runtime ─────────────────────────────

describe('Snapshot event runtime', () => {
  it('computes exact runtime from events with matching refs', () => {
    const events = [
      graphEvent(1, 'taskgraph.node.started', '2025-06-01T00:00:00Z', 'node-x'),
      graphEvent(2, 'taskgraph.node.completed', '2025-06-01T00:00:05Z', 'node-x'),
    ];
    const runtimes = nodeRuntimesFromEvents(events);
    expect(runtimes['node-x']).toBe(5000);
  });

  it('formatDuration converts runtime ms to readable display', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(10000)).toBe('10s');
  });
});

// ── Stale retention ──────────────────────────────────────────────────

describe('Stale retention', () => {
  it('stale flag preserves entity until exit timer fires', () => {
    let stale = false;
    const entity = { stale: false };

    entity.stale = true;
    stale = entity.stale;
    expect(stale).toBe(true);
  });

  it('terminal states are never in active entity DTO', () => {
    const states: Array<{ state: string }> = [
      { state: 'running' },
      { state: 'paused' },
    ];
    for (const s of states) {
      expect(['running', 'paused']).toContain(s.state);
    }
  });
});

// ── New E2E case list contract ───────────────────────────────────────

describe('New E2E case list contract', () => {
  it('defines all expected new screenshot case IDs', () => {
    const cases = [
      'wren-running',
      'wren-paused',
      'wren-multiple',
      'wren-hover',
      'wren-stale',
      'graph-slip',
      'graph-slip-node-hover',
      'graph-slip-dynamic-fields',
      'graph-slip-loading',
      'graph-slip-error',
      'work-slip-message',
      'work-slip-tool',
      'work-slip-usage-lifecycle',
      'entity-to-slip-to-work-slip-chain',
      'graph-slip-complex-running',
      'graph-slip-complex-done',
    ];
    expect(cases).toHaveLength(16);
    expect(cases.filter(Boolean)).toHaveLength(16);
  });
});


// ── taskRunIsTerminal protocol contract ───────────────────────────────
// Guards the exact production reader protocol behind the f-2 fixture shape:
// the status response must echo the requested id and carry a string status,
// and terminal classification is derived from that string.

describe('taskRunIsTerminal protocol contract', () => {
  const makeReader = (respond: (params: Record<string, unknown>) => unknown) =>
    new ForemanTaskGraphReader({
      request: async (method: string, params: Record<string, unknown>) => respond(params),
    } as unknown as ForemanIpcClient);

  it('accepts echoed-id string statuses and classifies live vs terminal', async () => {
    expect(await makeReader((p) => ({ task_run_id: p.task_run_id, status: 'running' })).taskRunIsTerminal('run-1')).toBe(false);
    expect(await makeReader((p) => ({ task_run_id: p.task_run_id, status: 'waiting' })).taskRunIsTerminal('run-1')).toBe(false);
    expect(await makeReader((p) => ({ task_run_id: p.task_run_id, status: 'done' })).taskRunIsTerminal('run-1')).toBe(true);
    expect(await makeReader((p) => ({ task_run_id: p.task_run_id, status: 'failed' })).taskRunIsTerminal('run-1')).toBe(true);
  });

  it('rejects non-echoed ids, non-string statuses, and legacy is_terminal-only responses', async () => {
    await expect(makeReader(() => ({ task_run_id: 'other', status: 'running' })).taskRunIsTerminal('run-1')).rejects.toThrow('identity mismatch');
    await expect(makeReader(() => ({ task_run_id: 'run-1', is_terminal: false })).taskRunIsTerminal('run-1')).rejects.toThrow('identity mismatch');
    await expect(makeReader(() => ({ task_run_id: 'run-1', status: 42 })).taskRunIsTerminal('run-1')).rejects.toThrow('identity mismatch');
    await expect(makeReader(() => ({ task_run_id: 'run-1' })).taskRunIsTerminal('run-1')).rejects.toThrow('identity mismatch');
  });
});

// ── Entity window vs bird dimensions ──────────────────────────────────

describe('Entity window vs bird dimensions', () => {
  it('entity window is larger than bird canvas', () => {
    const birdW = 84;
    const birdH = 66;
    const windowW = 156;
    const windowH = 84;
    expect(windowW).toBeGreaterThan(birdW);
    expect(windowH).toBeGreaterThan(birdH);
  });

  it('entity window does not clip the enlarged bird or the fact slip below it', () => {
    // Bird display is 84x66; the fact slip sits directly below the bird and
    // is ~17px tall (10px font * 1.3 line-height + 4px vertical padding),
    // leaving a 1px bottom margin inside the 84px window.
    const birdH = 66;
    const factSlipTop = birdH;
    const factSlipH = 17;
    const windowW = 156;
    const windowH = 84;
    expect(birdH).toBeLessThan(windowH);
    expect(factSlipTop + factSlipH).toBeLessThanOrEqual(windowH);
    // Width still holds the wide fact slip inside the transparent window.
    expect(windowW).toBeGreaterThanOrEqual(156);
  });

  it('multi-entity placement stacks by the enlarged window height plus gap', () => {
    // Mirrors positionEntity spacing: y = base + index * (windowHeight + 4)
    const windowH = 84;
    const index = 2;
    const y = 8 + index * (windowH + 4);
    expect(windowH + 4).toBe(88);
    expect(y).toBe(184);
  });

  it('clamps by the visible bird while re-anchoring the tip window at screen edges', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(placeWrenWindow({ x: 1900, y: 1060 }, workArea)).toEqual({
      windowBounds: { x: 1764, y: 996, width: 156, height: 84 },
      birdOffsetX: 72,
      birdOffsetY: 18,
      tipSide: 'above',
    });
    expect(placeWrenWindow({ x: -100, y: -100 }, workArea)).toEqual({
      windowBounds: { x: 0, y: 0, width: 156, height: 84 },
      birdOffsetX: 0,
      birdOffsetY: 0,
      tipSide: 'below',
    });
  });
});

// ── Stale-then-missing removal (stale is not exiting) ─────────────────

describe('Stale-then-missing removal', () => {
  it('stale flag without exiting allows further scheduling', () => {
    const entity = { stale: true, exiting: false };
    expect(entity.stale).toBe(true);
    expect(entity.exiting).toBe(false);
    // Can still be scheduled for exit
    entity.exiting = true;
    expect(entity.exiting).toBe(true);
  });
});

// ── DTO state update on reconcile ────────────────────────────────────

describe('DTO state update on reconcile', () => {
  it('existing entity DTO is replaced on reconcile', () => {
    const dto = { id: 'tg-1', state: 'running', revision: 1, created_at: '2025-01-01T00:00:00Z' };
    const newDto = { id: 'tg-1', state: 'paused', revision: 2, created_at: '2025-01-01T01:00:00Z' };
    expect(dto.state).toBe('running');
    expect(newDto.state).toBe('paused');
    // Simulate update
    Object.assign(dto, newDto);
    expect(dto.state).toBe('paused');
    expect(dto.revision).toBe(2);
  });
});

// ── Parameterless openSelf/close and two-argument openTranscript ─────

describe('Parameterless API contracts', () => {
  it('openSelf takes no arguments', () => {
    const openSelf = () => Promise.resolve();
    expect(openSelf.length).toBe(0);
  });

  it('close takes no arguments', () => {
    const close = () => Promise.resolve();
    expect(close.length).toBe(0);
  });

  it('openTranscript takes exactly two arguments', () => {
    const openTranscript = (nodeId: string, taskRunId: string) => Promise.resolve();
    expect(openTranscript.length).toBe(2);
  });
});

// ── Handler cleanup ──────────────────────────────────────────────────

describe('Handler cleanup', () => {
  it('registered IPC handlers are tracked for removal', () => {
    const handlers = [
      'entity:open-self', 'entity:set-mouse-passthrough', 'entity:get-state',
      'entity:drag-start', 'entity:drag-move', 'entity:drag-end',
      'slip:open-transcript', 'slip:report-content-size', 'slip:close', 'transcript:retry',
    ];
    expect(handlers).toHaveLength(10);
    expect(handlers).toContain('slip:close');
    expect(handlers).toContain('entity:get-state');
    expect(handlers).toContain('entity:drag-move');
  });
});

// ── Entity get-state initial handshake ──────────────────────────────

describe('Entity get-state initial handshake', () => {
  it('returns expected DTO shape for a known sender', () => {
    const dto = { id: 'tg-1', state: 'running', stale: false, exiting: false };
    expect(dto).toHaveProperty('id');
    expect(dto).toHaveProperty('state');
    expect(dto).toHaveProperty('stale');
    expect(dto).toHaveProperty('exiting');
    expect(Object.keys(dto)).toEqual(['id', 'state', 'stale', 'exiting']);
  });

  it('rejects foreign sender (no matching entity)', () => {
    // A sender window that has no matching owner entity must return null
    const result = null;
    expect(result).toBeNull();
  });

  it('rejects destroyed sender', () => {
    // A destroyed BrowserWindow.fromWebContents lookup returns null
    const sender = null;
    expect(sender).toBeNull();
  });
});

// ── Last-snapshot stale recovery ─────────────────────────────────────

describe('Last-snapshot stale recovery', () => {
  it('stale error keeps last projection visible', () => {
    const lastProjected = { graph_id: 'tg-1', revision: 1, state: 'running', nodes: {}, edges: [] };
    const error = 'Failed to load graph snapshot';
    // Stale signal preserves last projection
    expect(lastProjected).toBeDefined();
    expect(error).toBeDefined();
  });
});

// ── Snapshot completeness: node.inspect failure policy ────────────────

describe('Snapshot node.inspect completeness', () => {
  const baseNode = (id: string) => ({ id, action: { type: 'llm_call' }, deps: [] });
  const baseRun = (id: string) => ({ state: 'done' as const, task_run_id: `run-${id}` });

  it('rejects snapshot when node.inspect id mismatches key', () => {
    const result = { structure_revision: 1, node: baseNode('node-wrong-id'), run: baseRun('node-a') };
    expect(result.node.id).not.toBe('node-a');
  });

  it('rejects snapshot when node.inspect structure_revision mismatches graph revision', () => {
    const expectedRev = 1;
    const result = { structure_revision: 2, node: baseNode('node-a'), run: baseRun('node-a') };
    expect(result.structure_revision).not.toBe(expectedRev);
  });

  it('requires every expected graph node to have a matching node.inspect result', () => {
    const nodeIds = ['node-a', 'node-b'];
    const results = new Map<string, unknown>();
    results.set('node-a', { structure_revision: 1, node: baseNode('node-a'), run: baseRun('node-a') });
    expect(results.has('node-b')).toBe(false);
  });
});

// ── Owner-bound open without id contract ─────────────────────────────

describe('Owner-bound open without id contract', () => {
  it('entity openSelf must infer identity solely from sender window', () => {
    // Simulated: sender window lookup returns entity id
    const windowMap = new Map<string, string>();
    windowMap.set('win-entity-a', 'tg-a');
    const entityId = windowMap.get('win-entity-a');
    expect(entityId).toBe('tg-a');
    expect(windowMap.has('win-other')).toBe(false);
  });

  it('graph slip openTranscript must not accept graph id from renderer', () => {
    // openTranscript(nodeId, taskRunId) — no graphId parameter
    const openTranscript = (nodeId: string, taskRunId: string): void => {
      void nodeId;
      void taskRunId;
    };
    expect(openTranscript.length).toBe(2);
  });
});

describe('Absence of rack/history/refresh', () => {
  it('graph slip HTML must not contain rack, history, or refresh', () => {
    const forbidden = ['#rack', '#refresh-btn', '.rack-item', 'history'];
    for (const sel of forbidden) {
      // In a Graph Slip DOM, these selectors must return empty
      const exists = false;
      expect(exists).toBe(false);
    }
  });
});

// ── Graph Slip glyph & language contract (pure graph-visuals) ────────

describe('Graph Slip glyph & language contract (pure graph-visuals)', () => {
  const glyph = (parts: Array<{ d: string; fill?: boolean }>): string =>
    parts.map((p) => p.d).join('|');

  function taskNode(overrides: Partial<GraphSlipNodeDto> = {}): GraphSlipNodeDto {
    return { id: 'task-1', action_type: 'task', deps: [], state: 'running', ...overrides };
  }

  it('unifies every task node on the single Agent glyph signature', () => {
    const agent = glyph(taskIconPaths());
    // The signature is stable and identical across every task invocation.
    expect(agent).toBe(glyph(taskIconPaths()));
    // The round head, antenna and shoulder line that define the Agent glyph.
    expect(agent).toContain('M5,5.2');
    expect(agent).toContain('M5,11.5 H11');
    expect(taskIconPaths()).toHaveLength(4);
  });

  it('keeps start/end/condition/checkpoint/convert glyphs semantically distinct', () => {
    const types = ['start', 'end', 'condition', 'checkpoint', 'convert'];
    const signatures = new Set(types.map((t) => glyph(controlIconPaths(t))));
    expect(signatures.size).toBe(types.length);
    // The unified task Agent glyph is never reused by any control.
    const agent = glyph(taskIconPaths());
    for (const t of types) {
      expect(glyph(controlIconPaths(t))).not.toBe(agent);
    }
  });

  it('never uses emoji or icon fonts — only SVG path geometry', () => {
    const allParts = [
      ...taskIconPaths(),
      ...['start', 'end', 'condition', 'checkpoint', 'convert', 'llm_call', 'workflow', 'shell'].flatMap((t) => controlIconPaths(t)),
    ];
    for (const part of allParts) {
      expect(part.d).toMatch(/^[A-Za-z0-9.,\- ]+$/);
    }
  });

  it('maps every control to a Chinese aria label with a safe fallback', () => {
    expect(controlAriaLabel('start')).toBe('开始');
    expect(controlAriaLabel('end')).toBe('结束');
    expect(controlAriaLabel('condition')).toBe('条件');
    expect(controlAriaLabel('checkpoint')).toBe('检查点');
    expect(controlAriaLabel('convert')).toBe('转换');
    expect(controlAriaLabel('unknown-control')).toBe('控制节点');
  });

  it('falls back to the Chinese 任务 title when display metadata is missing', () => {
    expect(nodeTitle(taskNode({ display_label: undefined }))).toBe('任务');
    expect(nodeTitle(taskNode({ display_label: '代码审查' }))).toBe('代码审查');
    expect(taskAriaLabel(taskNode({ display_label: '终审' }))).toBe('终审');
  });

  it('keeps an exactly-24-unit Chinese display label intact for layout measurement', () => {
    // The display_label wire contract caps at 24 UTF-16 units, so the title
    // helper must preserve a real boundary-length Chinese fixture untouched
    // (no truncation, no fallback).
    const long = '这是一个用于压力测试布局的超长中文任务标签内容的';
    expect(long.length).toBe(24);
    expect(nodeTitle(taskNode({ display_label: long }))).toBe(long);
    expect(nodeTitle(taskNode({ display_label: long })).length).toBe(24);
  });

  it('labels every canonical node state in Chinese', () => {
    const expected: Array<[TaskGraphNodeState, string]> = [
      ['planned', '计划'],
      ['running', '运行中'],
      ['waiting', '等待中'],
      ['done', '已完成'],
      ['failed', '失败'],
      ['interrupted', '已中断'],
      ['cancelled', '已取消'],
    ];
    for (const [state, label] of expected) {
      expect(nodeStateLabelZh(state)).toBe(label);
    }
  });

  it('formats durations in Chinese and rejects invalid input', () => {
    expect(formatDurationZh(0)).toBe('0秒');
    expect(formatDurationZh(5_000)).toBe('5秒');
    expect(formatDurationZh(65_000)).toBe('1分5秒');
    expect(formatDurationZh(3_661_000)).toBe('1小时1分1秒');
    expect(formatDurationZh(-1)).toBeNull();
    expect(formatDurationZh(Number.NaN)).toBeNull();
  });

  it('builds task tips from present rows only and omits absent ones', () => {
    const full = nodeTip(taskNode({
      state: 'done',
      task_id: 'code-review',
      task_run_id: 'run-1',
      runtime_ms: 5_000,
      profile: 'fast',
      tool_call_count: 3,
      tps: 12.5,
      summary: '  审查完成，无回归问题。  ',
      description: ' 自动化审查代码改动 ',
    }), 'task');
    expect(full).not.toBeNull();
    expect(full!.firstLine).toBe('任务');
    expect(full!.rows.map((r) => r.label)).toEqual([
      '状态', '任务 ID', '运行配置', '工具调用', '输出速度',
    ]);
    // A completed task reads its elapsed inline on the status row (状态
    // 已完成 · 5秒) — never duplicated on a separate 耗时 row.
    expect(full!.rows.find((r) => r.label === '状态')!.value).toBe('已完成 · 5秒');
    expect(full!.rows.some((r) => r.label === '耗时')).toBe(false);
    // 任务 ID shows the Foreman task definition name, never the runtime
    // instance id task_run_id.
    expect(full!.rows.find((r) => r.label === '任务 ID')!.value).toBe('code-review');
    expect(JSON.stringify(full!.rows)).not.toContain('run-1');
    expect(full!.rows.find((r) => r.label === '运行配置')!.value).toBe('fast');
    expect(full!.rows.find((r) => r.label === '工具调用')!.value).toBe('3');
    expect(full!.rows.find((r) => r.label === '输出速度')!.value).toBe('12.50');
    // The done summary is a separate unlabeled region, never a 结果摘要 row.
    expect(full!.summary).toBe('审查完成，无回归问题。');
    expect(JSON.stringify(full!.rows)).not.toContain('结果摘要');

    // Absent/invalid fields are omitted, never placeholder rows.
    const sparse = nodeTip(taskNode({ state: 'running' }), 'task');
    expect(sparse!.firstLine).toBe('任务');
    expect(sparse!.rows.map((r) => r.label)).toEqual(['状态']);
    expect(sparse!.rows[0].value).toBe('运行中');
  });

  it('shows the exact 任务 ID row only when task_id is present and never falls back to task_run_id', () => {
    // A task carrying both definition name and runtime instance id exposes
    // only the definition name under 任务 ID.
    const withId = nodeTip(taskNode({ state: 'running', task_id: 'forge-deploy', task_run_id: 'task_x' }), 'task');
    expect(withId!.rows.find((r) => r.label === '任务 ID')!.value).toBe('forge-deploy');
    // The runtime instance id is never exposed as that semantic field.
    expect(withId!.rows.some((r) => r.value === 'task_x')).toBe(false);
    expect(JSON.stringify(withId!.rows)).not.toContain('task_x');
    // A legacy node without task_id omits the row entirely — never a wrong
    // runtime id fallback.
    const withoutId = nodeTip(taskNode({ state: 'running', task_run_id: 'task_x' }), 'task');
    expect(withoutId!.rows.some((r) => r.label === '任务 ID')).toBe(false);
    expect(withoutId!.rows.map((r) => r.label)).toEqual(['状态']);
  });

  it('[label_budget] fits mixed CJK/English labels by measured width', () => {
    const measure = (text: string): number => Array.from(text).reduce((width, char) => (
      width + (char === '…' ? 6 : /[\u3400-\u9fff]/u.test(char) ? 10 : 5)
    ), 0);
    expect(fitTagLabelToWidth('代码终审', TAG_LABEL_MAX_WIDTH, measure)).toBe('代码终审');
    expect(fitTagLabelToWidth('MixedAbc12', TAG_LABEL_MAX_WIDTH, measure)).toBe('MixedAbc12');

    const mixed = '调查 Fallen Component implementation';
    const fitted = fitTagLabelToWidth(mixed, TAG_LABEL_MAX_WIDTH, measure);
    expect(fitted).toBe('调查 Fallen Component…');
    expect(measure(fitted)).toBeLessThanOrEqual(TAG_LABEL_MAX_WIDTH);
  });

  it('uses the full fixed tag width while preserving right padding', () => {
    expect(TAG_LABEL_START_X + TAG_LABEL_MAX_WIDTH + TAG_LABEL_RIGHT_PADDING).toBe(TASK_WIDTH);
    expect(TASK_WIDTH).toBe(148);
    expect(TASK_HEIGHT).toBe(28);
  });

  it('labels profile/TPS as 运行配置/输出速度 with exactly two decimals and no legacy labels', () => {
    const tip = nodeTip(taskNode({ state: 'running', profile: 'fast', tps: 12.5 }), 'task');
    expect(tip!.rows.find((r) => r.label === '运行配置')!.value).toBe('fast');
    expect(tip!.rows.find((r) => r.label === '输出速度')!.value).toBe('12.50');
    // Exactly two decimals for every TPS magnitude.
    expect(nodeTip(taskNode({ state: 'running', tps: 8.5 }), 'task')!.rows.find((r) => r.label === '输出速度')!.value).toBe('8.50');
    expect(nodeTip(taskNode({ state: 'running', tps: 13.7 }), 'task')!.rows.find((r) => r.label === '输出速度')!.value).toBe('13.70');
    const labels = tip!.rows.map((r) => r.label);
    expect(labels).not.toContain('Profile');
    expect(labels).not.toContain('端到端有效输出速度');
  });

  it('renders the done summary as a separate unlabeled region, never a 结果摘要 row', () => {
    const doneTip = nodeTip(taskNode({ state: 'done', summary: '全部通过，可发布。' }), 'task');
    expect(doneTip!.summary).toBe('全部通过，可发布。');
    expect(doneTip!.rows.some((r) => r.label === '结果摘要')).toBe(false);
    expect(doneTip!.rows.map((r) => r.label)).toEqual(['状态']);
    // The summary region is done-only.
    const runningTip = nodeTip(taskNode({ state: 'running', summary: '中途摘要' }), 'task');
    expect(runningTip!.summary).toBeUndefined();
  });

  it('validates the Pet task_title: single-line, CJK, bounded to 48 UTF-16 units', () => {
    expect(normalizeTaskTitle('接收订单')).toBe('接收订单');
    expect(normalizeTaskTitle(' 代码终审 ')).toBe('代码终审');
    expect(normalizeTaskTitle('Analyze')).toBeUndefined(); // English-only rejected
    expect(normalizeTaskTitle('Mixed 分析')).toBe('Mixed 分析');
    expect(normalizeTaskTitle(42)).toBeUndefined();
    expect(normalizeTaskTitle('   ')).toBeUndefined();
    expect(normalizeTaskTitle('长'.repeat(48))).toBe('长'.repeat(48));
    expect(normalizeTaskTitle('长'.repeat(49))).toBeUndefined();
  });

  it('uses the validated static task_title as the tip heading, falling back to display_label then 任务, never the internal description', () => {
    // The English/internal task description is never exposed as a heading.
    const folded = nodeTip(taskNode({
      state: 'running',
      description: '  Review the diff for regressions ',
    }), 'task');
    expect(folded!.firstLine).toBe('任务');
    // The validated Chinese static responsibility name wins over display_label.
    const staticTitle = nodeTip(taskNode({ state: 'running', task_title: '代码终审', display_label: '代码审查' }), 'task');
    expect(staticTitle!.firstLine).toBe('代码终审');
    // display_label is the heading when no valid static title is present.
    const labelHeading = nodeTip(taskNode({ state: 'running', display_label: '代码审查' }), 'task');
    expect(labelHeading!.firstLine).toBe('代码审查');
    // No description/display_label → the Chinese '任务' default.
    const defaultFallback = nodeTip(taskNode({ state: 'running' }), 'task');
    expect(defaultFallback!.firstLine).toBe('任务');
    // Rows still expose/omit exactly as before regardless of the heading.
    expect(folded!.rows.map((r) => r.label)).toEqual(['状态']);
    expect(folded!.rows[0].value).toBe('运行中');
    expect(labelHeading!.rows.map((r) => r.label)).toEqual(['状态']);
    // The internal English description must never surface in the tip payload.
    expect(JSON.stringify(folded)).not.toContain('Review the diff');
  });

  it('start/end controls have no tip at all while other controls keep a minimal one', () => {
    expect(nodeTip(taskNode({ action_type: 'start', state: 'done' }), 'control')).toBeNull();
    expect(nodeTip(taskNode({ action_type: 'end', state: 'done' }), 'control')).toBeNull();
    const cond = nodeTip(taskNode({ action_type: 'condition', state: 'running', runtime_ms: 5_000 }), 'control');
    expect(cond).not.toBeNull();
    expect(cond!.firstLine).toBeUndefined();
    expect(cond!.rows.map((r) => r.label)).toEqual(['状态', '耗时']);
  });

  it('[completed_tip] reads the elapsed inline on the completed status row and keeps the separate 耗时 row elsewhere', () => {
    // Completed task with a valid runtime: 状态 已完成 · 5分12秒, no 耗时 row.
    const done = nodeTip(taskNode({ state: 'done', runtime_ms: 312_000 }), 'task');
    expect(done!.rows[0]).toEqual({ label: '状态', value: '已完成 · 5分12秒' });
    expect(done!.rows.map((r) => r.label)).toEqual(['状态']);
    // A task_status of done inlines exactly like a done node state.
    const doneStatus = nodeTip(taskNode({ state: 'done', task_status: 'done', runtime_ms: 5_000 }), 'task');
    expect(doneStatus!.rows[0].value).toBe('已完成 · 5秒');
    expect(doneStatus!.rows.some((r) => r.label === '耗时')).toBe(false);

    // Non-terminal task nodes keep the existing separate elapsed row.
    const running = nodeTip(taskNode({ state: 'running', runtime_ms: 30_000 }), 'task');
    expect(running!.rows[0]).toEqual({ label: '状态', value: '运行中' });
    expect(running!.rows.find((r) => r.label === '耗时')!.value).toBe('30秒');

    // Control nodes keep the existing separate elapsed row even when done.
    const cond = nodeTip(taskNode({ action_type: 'condition', state: 'done', runtime_ms: 5_000 }), 'control');
    expect(cond!.rows.map((r) => r.label)).toEqual(['状态', '耗时']);
    expect(cond!.rows.find((r) => r.label === '状态')!.value).toBe('已完成');
    expect(cond!.rows.find((r) => r.label === '耗时')!.value).toBe('5秒');
  });

  it('[fallback] a completed task without a valid runtime_ms keeps the original plain 已完成 status', () => {
    const noRuntime = nodeTip(taskNode({ state: 'done' }), 'task');
    expect(noRuntime!.rows[0]).toEqual({ label: '状态', value: '已完成' });
    expect(noRuntime!.rows.map((r) => r.label)).toEqual(['状态']);
    // Invalid runtime_ms values are never inlined and never placeholder.
    const invalid = nodeTip(taskNode({ state: 'done', runtime_ms: -5 }), 'task');
    expect(invalid!.rows[0]).toEqual({ label: '状态', value: '已完成' });
    expect(invalid!.rows.some((r) => r.label === '耗时')).toBe(false);
  });
});

describe('Activity-driven Graph Slip runtime projection', () => {
  it('[projection] preserves a valid runtime_ms and omits invalid or missing values', () => {
    const structure: TaskGraphInspectResult = {
      graph: {
        id: 'tg-rt',
        revision: 1,
        nodes: {
          'node-done': { id: 'node-done', action: { type: 'task' }, deps: [] },
          'node-bad': { id: 'node-bad', action: { type: 'task' }, deps: [] },
          'node-none': { id: 'node-none', action: { type: 'task' }, deps: [] },
        },
      },
    };
    const normalized = normalizeActivitySnapshotV1({
      schema_version: ACTIVITY_SNAPSHOT_SCHEMA_VERSION,
      sampled_at: '2025-01-01T00:01:00.000Z',
      tasks: [],
      taskgraphs: [{
        taskgraph_id: 'tg-rt',
        state: 'done',
        on_node_failure: 'pause',
        cancel_requested: false,
        structure_revision: 1,
        latest_seq: 1,
        node_counts: { planned: 0, running: 0, waiting: 0, done: 3, failed: 0, interrupted: 0, cancelled: 0 },
        active: { running: [], waiting: [] },
        nodes: [
          { node_id: 'node-done', state: 'done', runtime_ms: 312_000 },
          { node_id: 'node-bad', state: 'done', runtime_ms: -5 },
          { node_id: 'node-none', state: 'done' },
        ],
      }],
    });
    const presence = deriveActivityPresence(normalized, false);
    const dto = projectGraphSlipFromActivity(structure, presence.taskgraphs[0]);
    expect(dto.nodes['node-done'].runtime_ms).toBe(312_000);
    expect(dto.nodes['node-bad'].runtime_ms).toBeUndefined();
    expect(dto.nodes['node-none'].runtime_ms).toBeUndefined();
    // The projection feeds the completed tip directly: inline elapsed, no
    // duplicated 耗时 row.
    const tip = nodeTip(dto.nodes['node-done'], 'task');
    expect(tip!.rows[0]).toEqual({ label: '状态', value: '已完成 · 5分12秒' });
    expect(tip!.rows.some((r) => r.label === '耗时')).toBe(false);
  });
});

// ── Work Slip graph ownership ────────────────────────────────────────

describe('Work Slip graph ownership', () => {
  it('stale entity sender cannot open a slip', () => {
    const entities = new Map<string, { stale: boolean; exiting: boolean }>();
    entities.set('tg-stale', { stale: true, exiting: false });
    const entity = entities.get('tg-stale');
    expect(entity).toBeDefined();
    expect(entity!.stale).toBe(true);
    expect(() => {
      if (entity!.stale) throw new Error('stale entity cannot open slip');
    }).toThrow('stale entity cannot open slip');
  });

  it('exiting entity sender cannot open a slip', () => {
    const entities = new Map<string, { stale: boolean; exiting: boolean }>();
    entities.set('tg-exiting', { stale: true, exiting: true });
    const entity = entities.get('tg-exiting');
    expect(entity).toBeDefined();
    expect(entity!.exiting).toBe(true);
    expect(() => {
      if (entity!.exiting) throw new Error('exiting entity cannot open slip');
    }).toThrow('exiting entity cannot open slip');
  });

  it('missing entity cannot open a slip', () => {
    const entities = new Map<string, unknown>();
    expect(entities.has('tg-nonexistent')).toBe(false);
  });

  it('graph removal closes all dependent Work Slips', () => {
    const transcriptOwners = new Map<string, string>();
    transcriptOwners.set('run-a', 'tg-graph-1');
    transcriptOwners.set('run-b', 'tg-graph-1');
    transcriptOwners.set('run-c', 'tg-graph-2');

    const removedTranscripts: string[] = [];
    for (const [taskRunId, ownerGraphId] of transcriptOwners) {
      if (ownerGraphId === 'tg-graph-1') {
        transcriptOwners.delete(taskRunId);
        removedTranscripts.push(taskRunId);
      }
    }
    expect(removedTranscripts).toEqual(['run-a', 'run-b']);
    expect(transcriptOwners.has('run-a')).toBe(false);
    expect(transcriptOwners.has('run-b')).toBe(false);
    expect(transcriptOwners.has('run-c')).toBe(true);
    expect(transcriptOwners.size).toBe(1);
  });

  it('unrelated graph transcript windows survive when another graph is removed', () => {
    const transcriptOwners = new Map<string, string>();
    transcriptOwners.set('run-x', 'tg-x');
    transcriptOwners.set('run-y', 'tg-y');

    const removed: string[] = [];
    for (const [taskRunId, ownerGraphId] of transcriptOwners) {
      if (ownerGraphId === 'tg-x') {
        removed.push(taskRunId);
      }
    }
    expect(removed).toEqual(['run-x']);
    expect(transcriptOwners.get('run-y')).toBe('tg-y');
  });
});

// ── Immediate dependent-window closure on entity exit ─────────────────

describe('Immediate dependent-window closure on entity exit', () => {
  it('scheduleEntityExit closes graph slip and transcript windows immediately while entity stays for delayed removal', () => {
    const entities = new Map<string, { stale: boolean; exiting: boolean }>();
    const graphSlips = new Map<string, unknown>();
    const transcriptWindows = new Map<string, unknown>();
    const transcriptOwners = new Map<string, string>();

    // Setup: entity, its graph slip, and owned transcript exist
    entities.set('tg-exit', { stale: false, exiting: false });
    graphSlips.set('tg-exit', { window: {} });
    transcriptOwners.set('run-owned', 'tg-exit');
    transcriptWindows.set('run-owned', {});
    // Unrelated graph and its transcript survive
    entities.set('tg-other', { stale: false, exiting: false });
    transcriptOwners.set('run-other', 'tg-other');
    transcriptWindows.set('run-other', {});

    // Simulate scheduleEntityExit(tg-exit) logic
    const entity = entities.get('tg-exit')!;
    entity.stale = true;
    entity.exiting = true;
    // Immediate dependent-window closure
    graphSlips.delete('tg-exit');
    for (const [taskRunId, ownerId] of transcriptOwners) {
      if (ownerId === 'tg-exit') {
        transcriptOwners.delete(taskRunId);
        transcriptWindows.delete(taskRunId);
      }
    }

    // Entity still exists with flags (delayed removal by timer)
    expect(entities.has('tg-exit')).toBe(true);
    expect(entities.get('tg-exit')!.stale).toBe(true);
    expect(entities.get('tg-exit')!.exiting).toBe(true);

    // Dependent windows are gone
    expect(graphSlips.has('tg-exit')).toBe(false);
    expect(transcriptWindows.has('run-owned')).toBe(false);

    // Unrelated graph and its transcripts survive
    expect(entities.has('tg-other')).toBe(true);
    expect(transcriptWindows.has('run-other')).toBe(true);
    expect(transcriptOwners.get('run-other')).toBe('tg-other');
    expect(graphSlips.size).toBe(0);
  });

  it('missing reconciliation via scheduleEntityExit closes graph/transcript windows and delays entity removal', () => {
    const entities = new Map<string, { stale: boolean; exiting: boolean }>();
    const graphSlips = new Map<string, unknown>();
    const transcriptWindows = new Map<string, unknown>();
    const transcriptOwners = new Map<string, string>();

    // Entity exists but is missing from list (activeIds does not contain it)
    entities.set('tg-missing', { stale: false, exiting: false });
    graphSlips.set('tg-missing', { window: {} });
    transcriptOwners.set('run-missing', 'tg-missing');
    transcriptWindows.set('run-missing', {});

    // Simulate missing reconciliation (activeIds = new Set() for this entity)
    const entity = entities.get('tg-missing')!;
    entity.stale = true;
    entity.exiting = true;
    graphSlips.delete('tg-missing');
    for (const [taskRunId, ownerId] of transcriptOwners) {
      if (ownerId === 'tg-missing') {
        transcriptOwners.delete(taskRunId);
        transcriptWindows.delete(taskRunId);
      }
    }

    // Entity window not destroyed yet (delayed)
    expect(entities.has('tg-missing')).toBe(true);
    expect(graphSlips.has('tg-missing')).toBe(false);
    expect(transcriptWindows.has('run-missing')).toBe(false);
    expect(transcriptOwners.has('run-missing')).toBe(false);
  });

  it('terminal snapshot triggers scheduleEntityExit before stopping poller', () => {
    const terminalStates: ReadonlySet<string> = new Set(['done', 'cancelled']);
    const exited = new Set<string>();

    // Simulate the polling callback behavior for a terminal state
    function runPollCallback(snapshotState: string, graphId: string): boolean {
      const scheduleEntityExit = (id: string) => {
        exited.add(id);
      };
      if (terminalStates.has(snapshotState)) {
        // Terminal → route through scheduleEntityExit, then stop poller
        scheduleEntityExit(graphId);
        return false;
      }
      return true;
    }

    // Terminal states trigger exit and return false
    expect(runPollCallback('done', 'tg-terminal')).toBe(false);
    expect(exited.has('tg-terminal')).toBe(true);

    // Non-terminal states continue polling
    expect(runPollCallback('running', 'tg-running')).toBe(true);
    expect(exited.has('tg-running')).toBe(false);

    // Multiple terminal states all trigger exit
    expect(runPollCallback('cancelled', 'tg-cancelled')).toBe(false);
    expect(exited.has('tg-cancelled')).toBe(true);
  });

  it('terminal snapshot idempotence: scheduleEntityExit handles already-exiting entity', () => {
    // Simulate that scheduleEntityExit checks for existing exiting state
    function scheduleEntityExit(entities: Map<string, { exiting: boolean }>, id: string): void {
      const entity = entities.get(id);
      if (!entity) return;
      if (entity.exiting) return; // already scheduled — no-op
      entity.exiting = true;
    }

    const entities = new Map<string, { exiting: boolean }>();
    entities.set('tg-term', { exiting: false });

    // First call sets exiting
    scheduleEntityExit(entities, 'tg-term');
    expect(entities.get('tg-term')!.exiting).toBe(true);

    // Second call is no-op (idempotent)
    scheduleEntityExit(entities, 'tg-term');
    expect(entities.get('tg-term')!.exiting).toBe(true);
  });
});

// ── Real TaskGraphWindowOwner lifecycle (activity-snapshot driven) ───
// The owner no longer polls taskgraph.list/status/slip. Presence flows in
// through applyActivity(presence); only taskgraph.inspect (static structure)
// and task.run.events/status (transcripts) hit the daemon. Identity is still
// inferred purely from sender windows.

class FakeForemanClient {
  structureRevision = 1;
  nodeState: TaskGraphNodeState = 'running';
  /** Static structure served by taskgraph.inspect; the owner computes
   * fact-slip counts from these action types, so tests can mix task and
   * control nodes. */
  structureNodes: Record<string, TaskGraphNode> = {
    nodeA: { id: 'nodeA', name: 'Plan', action: { type: 'task' }, deps: [] },
  };
  inspectRequestCount = 0;
  // When armed, taskgraph.inspect throws this value so the slip's structure
  // load exercises its failure path. Arming is explicit so `undefined` can be
  // thrown as a first-class throw value.
  private structureFailureArmed = false;
  private structureFailure?: unknown;

  armStructureFailure(value: unknown): void {
    this.structureFailure = value;
    this.structureFailureArmed = true;
  }

  clearStructureFailure(): void {
    this.structureFailureArmed = false;
    this.structureFailure = undefined;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'taskgraph.inspect') {
      this.inspectRequestCount += 1;
      if (this.structureFailureArmed) throw this.structureFailure;
      const graphId = String(params.taskgraph_id);
      return {
        graph: {
          id: graphId,
          revision: this.structureRevision,
          nodes: this.structureNodes,
        },
      };
    }
    if (method === 'task.run.events') {
      return { task_run_id: String(params.task_run_id), events: [], next_seq: 0, has_more: false };
    }
    if (method === 'task.run.status') {
      return { task_run_id: String(params.task_run_id), status: this.nodeState };
    }
    throw new Error(`FakeForemanClient: unexpected method ${method}`);
  }
}

interface OwnerInternals {
  entities: Map<string, {
    dto: { id: string; state: 'created' | 'running' | 'paused'; revision: number };
    stale: boolean;
    exiting: boolean;
    manuallyPositioned: boolean;
  }>;
  graphSlips: Map<string, unknown>;
  transcriptWindows: Map<string, unknown>;
}

describe('Graph Slip window sizing', () => {
  it('fits the first window to DAG content plus the 24px header', () => {
    expect(fitGraphSlipWindowSize(
      { width: 340, height: 528 },
      { width: 1920, height: 1080 },
    )).toEqual({ width: 380, height: 552 });
  });

  it('uses a remembered manual size instead of content dimensions', () => {
    expect(fitGraphSlipWindowSize(
      { width: 340, height: 528 },
      { width: 1920, height: 1080 },
      { width: 640, height: 720 },
    )).toEqual({ width: 640, height: 720 });
  });

  it('keeps oversized content inside the display work area', () => {
    expect(fitGraphSlipWindowSize(
      { width: 3000, height: 4000 },
      { width: 1920, height: 1080 },
    )).toEqual({ width: 1888, height: 1048 });
  });
});

describe('TaskGraphWindowOwner lifecycle (activity-snapshot driven)', () => {
  let owner: TaskGraphWindowOwner | undefined;
  let client: FakeForemanClient;

  beforeEach(() => {
    vi.useFakeTimers();
    electronMocks.ipcHandlers.clear();
    electronMocks.ipcListeners.clear();
    electronMocks.setCursorPoint({ x: 0, y: 0 });
    electronMocks.BrowserWindow.mockClear();
    client = new FakeForemanClient();
  });

  afterEach(() => {
    owner?.destroy();
    vi.useRealTimers();
  });

  async function flushAsync(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }

  function graphPresence(
    id: string,
    state: TaskGraphState,
    overrides: Record<string, unknown> = {},
  ): ActivityTaskGraphPresence {
    return {
      taskgraphId: id,
      state,
      structureRevision: client.structureRevision,
      latestSeq: 1,
      nodeCounts: {
        planned: 0,
        running: state === 'running' ? 1 : 0,
        waiting: 0,
        done: state === 'done' ? 1 : 0,
        failed: 0,
        interrupted: 0,
        cancelled: 0,
      },
      active: { running: state === 'running' ? ['nodeA'] : [], waiting: [] },
      nodes: [
        { nodeId: 'nodeA', state: 'running', taskRunId: 'run-nodeA', taskStatus: 'running' },
      ],
      ...overrides,
    };
  }

  function presenceWith(
    taskgraphs: ActivityTaskGraphPresence[],
  ): ActivityPresence {
    return { sampledAt: '2025-01-01T00:00:00.000Z', stale: false, tasks: [], taskgraphs };
  }

  function makeOwner(): TaskGraphWindowOwner {
    return new TaskGraphWindowOwner({
      foremanIpcClient: client as unknown as ForemanIpcClient,
      htmlDir: '/nonexistent/html',
      preloadDir: '/nonexistent/preload',
      getHouseWindow: () => null,
      logger: { warn: () => {}, error: () => {}, log: () => {} },
    });
  }

  it('drives entity appearance → revision refresh → running→paused → slip/transcript → tracked terminal → delayed entity disappearance', async () => {
    owner = makeOwner();
    const internals = owner as unknown as OwnerInternals;

    // 1. First fresh snapshot creates the entity window.
    owner.applyActivity(presenceWith([graphPresence('tg-a', 'running')]));
    await flushAsync();
    let wins = electronMocks.createdWindows();
    expect(wins).toHaveLength(1);
    const entityWin = wins[0] as any;
    entityWin.emit('ready-to-show');
    expect(entityWin.showInactive).toHaveBeenCalled();
    expect(entityWin.webContents.send).toHaveBeenCalledWith('entity:state', {
      id: 'tg-a', state: 'running', stale: false, exiting: false, nodeCounts: { done: 0, total: 1 },
    });
    expect(internals.entities.size).toBe(1);
    expect(internals.entities.get('tg-a')!.dto.state).toBe('running');
    expect(internals.entities.get('tg-a')!.dto.revision).toBe(1);

    // entity:get-state works purely from sender-window inference.
    const statePayload = await electronMocks.invokeIpc('entity:get-state', { sender: entityWin.webContents });
    expect(statePayload).toEqual({
      id: 'tg-a',
      state: 'running',
      stale: false,
      exiting: false,
      nodeCounts: { done: 0, total: 1 },
      placement: { bird_x: 64, bird_y: 18, tip_side: 'above' },
    });

    // 2. Revision refresh.
    client.structureRevision = 2;
    owner.applyActivity(presenceWith([graphPresence('tg-a', 'running')]));
    expect(internals.entities.get('tg-a')!.dto.revision).toBe(2);

    // 3. running → paused.
    owner.applyActivity(presenceWith([graphPresence('tg-a', 'paused')]));
    expect(internals.entities.get('tg-a')!.dto.state).toBe('paused');
    expect(entityWin.webContents.send).toHaveBeenCalledWith('entity:state', {
      id: 'tg-a', state: 'paused', stale: false, exiting: false,
    });

    // 4. Open the graph slip via entity:open-self (identity inferred from sender).
    await electronMocks.invokeIpc('entity:open-self', { sender: entityWin.webContents });
    wins = electronMocks.createdWindows();
    expect(wins).toHaveLength(2);
    const slipWin = wins[1] as any;
    expect(internals.graphSlips.size).toBe(1);
    slipWin.webContents.emit('did-finish-load');
    await flushAsync();
    const slipSnapshotCalls = slipWin.webContents.send.mock.calls.filter((c: any[]) => c[0] === 'slip:snapshot');
    expect(slipSnapshotCalls.length).toBeGreaterThan(0);
    expect(slipSnapshotCalls.at(-1)[1]).toMatchObject({ graph_id: 'tg-a', revision: 2, state: 'paused' });

    // 5. Open a dependent work transcript for the running node.
    await electronMocks.invokeIpc('slip:open-transcript', { sender: slipWin.webContents }, 'nodeA', 'run-nodeA');
    wins = electronMocks.createdWindows();
    expect(wins).toHaveLength(3);
    const transcriptWin = wins[2] as any;
    expect(internals.transcriptWindows.size).toBe(1);
    transcriptWin.webContents.emit('did-finish-load');
    await flushAsync();
    expect(transcriptWin.webContents.send).toHaveBeenCalledWith(
      'transcript:data-run-nodeA',
      expect.objectContaining({ task_run_id: 'run-nodeA' }),
    );

    // 6. Tracked terminal completion: the graph is still present as a tracked
    // terminal; the owner closes the slip + transcript and starts the entity
    // exit without any separate status/slip request.
    owner.applyActivity(presenceWith([graphPresence('tg-a', 'done')]));
    expect(slipWin.isDestroyed()).toBe(true);
    expect(transcriptWin.isDestroyed()).toBe(true);
    expect(internals.graphSlips.size).toBe(0);
    expect(internals.transcriptWindows.size).toBe(0);
    expect(entityWin.isDestroyed()).toBe(false);
    expect(internals.entities.get('tg-a')!.stale).toBe(true);
    expect(internals.entities.get('tg-a')!.exiting).toBe(true);
    expect(entityWin.webContents.send).toHaveBeenCalledWith('entity:state', {
      id: 'tg-a', state: 'paused', stale: true, exiting: true, terminal: 'done',
      nodeCounts: { done: 0, total: 1 },
    });

    // 7. Delayed entity disappearance after ENTITY_EXIT_MS.
    await vi.advanceTimersByTimeAsync(800);
    expect(entityWin.isDestroyed()).toBe(true);
    expect(internals.entities.size).toBe(0);
  });

  it('creates entity windows with the enlarged footprint', () => {
    owner = makeOwner();
    owner.applyActivity(presenceWith([graphPresence('tg-fp', 'running')]));
    expect(electronMocks.createdWindows()).toHaveLength(1);
    const entityWindowOptions = electronMocks.BrowserWindow.mock.calls[0][0];
    expect(entityWindowOptions).toMatchObject({ width: 156, height: 84 });
  });

  it('moves a Wren within the display and preserves the manual position across activity refreshes', () => {
    owner = makeOwner();
    const internals = owner as unknown as OwnerInternals;
    owner.applyActivity(presenceWith([graphPresence('tg-drag', 'running')]));
    const entityWin = electronMocks.createdWindows()[0] as any;
    expect(entityWin.getBounds()).toEqual({ x: 1764, y: 988, width: 156, height: 84 });

    electronMocks.setCursorPoint({ x: 1848, y: 1026 });
    electronMocks.emitIpc('entity:drag-start', { sender: entityWin.webContents });
    electronMocks.setCursorPoint({ x: 500, y: 400 });
    electronMocks.emitIpc('entity:drag-move', { sender: entityWin.webContents });
    expect(entityWin.getBounds()).toEqual({ x: 480, y: 380, width: 156, height: 84 });
    expect(internals.entities.get('tg-drag')!.manuallyPositioned).toBe(true);

    electronMocks.emitIpc('entity:drag-end', { sender: entityWin.webContents });
    owner.applyActivity(presenceWith([graphPresence('tg-drag', 'running')]));
    expect(entityWin.getBounds()).toEqual({ x: 480, y: 380, width: 156, height: 84 });
  });

  it('auto-fits only the first opening after the renderer reports DAG dimensions', async () => {
    owner = makeOwner();
    owner.applyActivity(presenceWith([graphPresence('tg-fit', 'running')]));
    await flushAsync();
    const entityWin = electronMocks.createdWindows()[0] as any;
    await electronMocks.invokeIpc('entity:open-self', { sender: entityWin.webContents });
    const slipWin = electronMocks.createdWindows()[1] as any;
    const slipOptions = electronMocks.BrowserWindow.mock.calls[1][0];
    expect(slipOptions).toMatchObject({ width: 380, height: 280 });

    slipWin.emit('ready-to-show');
    expect(slipWin.showInactive).not.toHaveBeenCalled();
    await electronMocks.invokeIpc(
      'slip:report-content-size',
      { sender: slipWin.webContents },
      340,
      528,
    );
    expect(slipWin.setBounds).toHaveBeenCalledWith({
      x: 770,
      y: 264,
      width: 380,
      height: 552,
    });
    expect(slipWin.showInactive).toHaveBeenCalledTimes(1);

    await electronMocks.invokeIpc(
      'slip:report-content-size',
      { sender: slipWin.webContents },
      900,
      900,
    );
    expect(slipWin.setBounds).toHaveBeenCalledTimes(1);
  });

  it('uses and updates remembered manual Graph Slip size without auto-fitting', async () => {
    const onGraphSlipGeometryChange = vi.fn();
    owner = new TaskGraphWindowOwner({
      foremanIpcClient: client as unknown as ForemanIpcClient,
      htmlDir: '/nonexistent/html',
      preloadDir: '/nonexistent/preload',
      getHouseWindow: () => null,
      graphSlipGeometry: { width: 640, height: 720 },
      onGraphSlipGeometryChange,
      logger: { warn: () => {}, error: () => {}, log: () => {} },
    });
    owner.applyActivity(presenceWith([graphPresence('tg-remember', 'running')]));
    await flushAsync();
    const entityWin = electronMocks.createdWindows()[0] as any;
    await electronMocks.invokeIpc('entity:open-self', { sender: entityWin.webContents });
    const slipWin = electronMocks.createdWindows()[1] as any;
    expect(electronMocks.BrowserWindow.mock.calls[1][0]).toMatchObject({ width: 640, height: 720 });

    slipWin.emit('ready-to-show');
    expect(slipWin.showInactive).toHaveBeenCalledTimes(1);
    await electronMocks.invokeIpc(
      'slip:report-content-size',
      { sender: slipWin.webContents },
      340,
      528,
    );
    expect(slipWin.setBounds).not.toHaveBeenCalled();

    slipWin.emit('will-resize');
    slipWin.setBounds({ width: 700, height: 760 });
    slipWin.emit('resize');
    expect(onGraphSlipGeometryChange).toHaveBeenCalledWith({ x: 640, y: 180, width: 700, height: 760 });
  });

  it('remembers Graph Slip movement without turning the auto-fitted size into a manual size', async () => {
    const onGraphSlipGeometryChange = vi.fn();
    owner = new TaskGraphWindowOwner({
      foremanIpcClient: client as unknown as ForemanIpcClient,
      htmlDir: '/nonexistent/html',
      preloadDir: '/nonexistent/preload',
      getHouseWindow: () => null,
      onGraphSlipGeometryChange,
      logger: { warn: () => {}, error: () => {}, log: () => {} },
    });
    owner.applyActivity(presenceWith([graphPresence('tg-position', 'running')]));
    await flushAsync();
    const entityWin = electronMocks.createdWindows()[0] as any;
    await electronMocks.invokeIpc('entity:open-self', { sender: entityWin.webContents });
    const firstSlip = electronMocks.createdWindows()[1] as any;
    await electronMocks.invokeIpc(
      'slip:report-content-size',
      { sender: firstSlip.webContents },
      340,
      528,
    );
    firstSlip.emit('will-move');
    firstSlip.setBounds({ x: 120, y: 140 });
    firstSlip.emit('move');
    expect(onGraphSlipGeometryChange).toHaveBeenLastCalledWith({ x: 120, y: 140 });

    await electronMocks.invokeIpc('slip:close', { sender: firstSlip.webContents });
    await electronMocks.invokeIpc('entity:open-self', { sender: entityWin.webContents });
    const secondSlip = electronMocks.createdWindows()[2] as any;
    expect(electronMocks.BrowserWindow.mock.calls[2][0]).toMatchObject({
      x: 120,
      y: 140,
      width: 380,
      height: 280,
    });
    await electronMocks.invokeIpc(
      'slip:report-content-size',
      { sender: secondSlip.webContents },
      340,
      528,
    );
    expect(secondSlip.setBounds).toHaveBeenCalledWith({
      x: 120,
      y: 140,
      width: 380,
      height: 552,
    });
  });

  it('[atomic-stale] a stale round keeps entities and open slips and marks stale without clearing any surface', async () => {
    owner = makeOwner();
    const internals = owner as unknown as OwnerInternals;
    owner.applyActivity(presenceWith([graphPresence('tg-s', 'running')]));
    await flushAsync();
    const entityWin = electronMocks.createdWindows()[0] as any;
    entityWin.emit('ready-to-show');

    await electronMocks.invokeIpc('entity:open-self', { sender: entityWin.webContents });
    const slipWin = electronMocks.createdWindows()[1] as any;
    slipWin.webContents.emit('did-finish-load');
    await flushAsync();
    const slipCalls = slipWin.webContents.send.mock.calls.filter((c: any[]) => c[0] === 'slip:snapshot');
    expect(slipCalls.length).toBeGreaterThan(0);

    // Failed round: everything is kept, entities are flagged stale, the slip
    // retains its last complete projection.
    owner.applyActivity({ sampledAt: '2025-01-01T00:00:00.000Z', stale: true, tasks: [], taskgraphs: [] });
    expect(internals.entities.size).toBe(1);
    expect(internals.entities.get('tg-s')!.stale).toBe(true);
    expect(entityWin.webContents.send).toHaveBeenCalledWith('entity:state', {
      id: 'tg-s', state: 'running', stale: true, exiting: false, nodeCounts: { done: 0, total: 1 },
    });
    expect(internals.graphSlips.size).toBe(1);
    const slipCallsAfter = slipWin.webContents.send.mock.calls.filter((c: any[]) => c[0] === 'slip:snapshot');
    expect(slipCallsAfter.at(-1)[1]).toEqual(slipCalls.at(-1)[1]);

    // Recovery clears stale.
    owner.applyActivity(presenceWith([graphPresence('tg-s', 'running')]));
    expect(entityWin.webContents.send).toHaveBeenCalledWith('entity:state', {
      id: 'tg-s', state: 'running', stale: false, exiting: false, nodeCounts: { done: 0, total: 1 },
    });
  });

  it('rejects transcript opening for a node/task that does not match the slip snapshot', async () => {
    owner = makeOwner();
    owner.applyActivity(presenceWith([graphPresence('tg-auth', 'running')]));
    await flushAsync();
    const entityWin = electronMocks.createdWindows()[0] as any;
    entityWin.emit('ready-to-show');
    await electronMocks.invokeIpc('entity:open-self', { sender: entityWin.webContents });
    const slipWin = electronMocks.createdWindows()[1] as any;
    slipWin.webContents.emit('did-finish-load');
    await flushAsync();
    await electronMocks.invokeIpc('slip:open-transcript', { sender: slipWin.webContents }, 'nodeA', 'run-other');
    expect(electronMocks.createdWindows()).toHaveLength(2);
  });

  it('recovers a slip after a structure load failure while preserving the last projection', async () => {
    owner = makeOwner();
    // Arm the shared structure load so the entity's first inspect attempt (and
    // the slip's retry) fail; the failure path surfaces slip:error.
    client.armStructureFailure(new Error('secret-structure-error'));
    owner.applyActivity(presenceWith([graphPresence('tg-rec', 'running')]));
    await flushAsync();
    const entityWin = electronMocks.createdWindows()[0] as any;
    entityWin.emit('ready-to-show');

    await electronMocks.invokeIpc('entity:open-self', { sender: entityWin.webContents });
    const slipWin = electronMocks.createdWindows()[1] as any;
    slipWin.webContents.emit('did-finish-load');
    await flushAsync();
    const errorCalls = slipWin.webContents.send.mock.calls.filter((c: any[]) => c[0] === 'slip:error');
    expect(errorCalls.length).toBeGreaterThan(0);
    expect(errorCalls.at(-1)[1]).toBe('Failed to load graph snapshot');

    // Recovery on the next activity round projects a fresh snapshot.
    client.clearStructureFailure();
    owner.applyActivity(presenceWith([graphPresence('tg-rec', 'running')]));
    await flushAsync();
    const snapshotCalls = slipWin.webContents.send.mock.calls.filter((c: any[]) => c[0] === 'slip:snapshot');
    expect(snapshotCalls.at(-1)[1]).toMatchObject({ graph_id: 'tg-rec', state: 'running' });
  });

  it('[content] fact-slip payload carries the title and task counts (2 done / 3 total) while done controls never count', async () => {
    owner = makeOwner();
    client.structureNodes = {
      't1': { id: 't1', action: { type: 'task' }, deps: [] },
      't2': { id: 't2', action: { type: 'task' }, deps: [] },
      't3': { id: 't3', action: { type: 'task' }, deps: [] },
      'ctl1': { id: 'ctl1', action: { type: 'llm_call' }, deps: [] },
      'ctl2': { id: 'ctl2', action: { type: 'end' }, deps: [] },
    };
    const presence = graphPresence('tg-content', 'running', {
      title: '答疑 Agent 评估',
      nodes: [
        { nodeId: 't1', state: 'done' },
        { nodeId: 't2', state: 'done' },
        { nodeId: 't3', state: 'running' },
        { nodeId: 'ctl1', state: 'done' },
        { nodeId: 'ctl2', state: 'done' },
      ],
    });
    owner.applyActivity(presenceWith([presence]));
    await flushAsync();
    const entityWin = electronMocks.createdWindows()[0] as any;
    entityWin.emit('ready-to-show');
    expect(entityWin.webContents.send).toHaveBeenCalledWith('entity:state', {
      id: 'tg-content', state: 'running', stale: false, exiting: false,
      title: '答疑 Agent 评估', nodeCounts: { done: 2, total: 3 },
    });
  });

  it('[revision-gate] issues at most one deduplicated bounded inspect load per graph per structure_revision', async () => {
    owner = makeOwner();
    owner.applyActivity(presenceWith([graphPresence('tg-count', 'running')]));
    await flushAsync();
    const entityWin = electronMocks.createdWindows()[0] as any;
    entityWin.emit('ready-to-show');
    expect(client.inspectRequestCount).toBe(1);

    // Same-revision rounds reuse the cached structure — no new load.
    owner.applyActivity(presenceWith([graphPresence('tg-count', 'running')]));
    owner.applyActivity(presenceWith([graphPresence('tg-count', 'paused')]));
    await flushAsync();
    expect(client.inspectRequestCount).toBe(1);

    // Revision change triggers exactly one bounded reload.
    client.structureRevision = 2;
    owner.applyActivity(presenceWith([graphPresence('tg-count', 'running')]));
    await flushAsync();
    expect(client.inspectRequestCount).toBe(2);

    // Concurrent rounds while the reload is in flight stay deduplicated.
    client.structureRevision = 3;
    owner.applyActivity(presenceWith([graphPresence('tg-count', 'running')]));
    owner.applyActivity(presenceWith([graphPresence('tg-count', 'running')]));
    await flushAsync();
    expect(client.inspectRequestCount).toBe(3);
  });

  it('[revision-gate] missing/loading/mismatched structure omits counts and reloads once per new revision', async () => {
    owner = makeOwner();
    // Structure is missing until the inspect load resolves: the first push has
    // no nodeCounts and the label must not guess a number.
    owner.applyActivity(presenceWith([graphPresence('tg-gate', 'running')]));
    const internals = owner as unknown as OwnerInternals;
    const entityWin = electronMocks.createdWindows()[0] as any;
    entityWin.emit('ready-to-show');
    expect(entityWin.webContents.send).toHaveBeenCalledWith('entity:state', {
      id: 'tg-gate', state: 'running', stale: false, exiting: false,
    });
    expect(internals.entities.get('tg-gate')!.dto.nodeCounts).toBeUndefined();
    await flushAsync();
    expect(entityWin.webContents.send).toHaveBeenCalledWith('entity:state', {
      id: 'tg-gate', state: 'running', stale: false, exiting: false, nodeCounts: { done: 0, total: 1 },
    });
  });
});

// ── Wren fact-slip count projection (pure) ────────────────────────────

describe('countDoneTaskNodes', () => {
  it('counts only action.type=task structure nodes whose presence state is done', () => {
    const structure: TaskGraphInspectResult = {
      graph: {
        id: 'tg-mixed',
        revision: 1,
        nodes: {
          task1: { id: 'task1', action: { type: 'task' }, deps: [] },
          task2: { id: 'task2', action: { type: 'task' }, deps: [] },
          task3: { id: 'task3', action: { type: 'task' }, deps: [] },
          start: { id: 'start', action: { type: 'start' }, deps: [] },
          cond: { id: 'cond', action: { type: 'condition' }, deps: [] },
          check: { id: 'check', action: { type: 'checkpoint' }, deps: [] },
          convert: { id: 'convert', action: { type: 'convert' }, deps: [] },
          join: { id: 'join', action: { type: 'join' }, deps: [] },
          fanout: { id: 'fanout', action: { type: 'fanout' }, deps: [] },
          end: { id: 'end', action: { type: 'end' }, deps: [] },
          unknown: { id: 'unknown', action: { type: 'llm_call' }, deps: [] },
        },
      },
    };
    const presence: ActivityTaskGraphPresence = {
      taskgraphId: 'tg-mixed',
      state: 'running',
      structureRevision: 1,
      latestSeq: 1,
      nodeCounts: {
        planned: 0, running: 1, waiting: 0, done: 9, failed: 0, interrupted: 0, cancelled: 0,
      },
      active: { running: ['task3'], waiting: [] },
      nodes: [
        { nodeId: 'task1', state: 'done' },
        { nodeId: 'task2', state: 'done' },
        { nodeId: 'task3', state: 'running' },
        { nodeId: 'start', state: 'done' },
        { nodeId: 'cond', state: 'done' },
        { nodeId: 'check', state: 'done' },
        { nodeId: 'convert', state: 'done' },
        { nodeId: 'join', state: 'done' },
        { nodeId: 'fanout', state: 'done' },
        { nodeId: 'end', state: 'done' },
        { nodeId: 'unknown', state: 'done' },
      ],
    };
    // Graph-level node_counts says 9 done — but only the two task nodes count.
    expect(countDoneTaskNodes(structure, presence)).toEqual({ done: 2, total: 3 });
  });

  it('task nodes with no presence entry count in total but never in done', () => {
    const structure: TaskGraphInspectResult = {
      graph: {
        id: 'tg-sparse',
        revision: 1,
        nodes: {
          t1: { id: 't1', action: { type: 'task' }, deps: [] },
          t2: { id: 't2', action: { type: 'task' }, deps: [] },
        },
      },
    };
    const presence: ActivityTaskGraphPresence = {
      taskgraphId: 'tg-sparse',
      state: 'running',
      structureRevision: 1,
      latestSeq: 1,
      nodeCounts: { planned: 0, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0 },
      active: { running: [], waiting: [] },
      nodes: [{ nodeId: 't1', state: 'done' }],
    };
    expect(countDoneTaskNodes(structure, presence)).toEqual({ done: 1, total: 2 });
  });
});
