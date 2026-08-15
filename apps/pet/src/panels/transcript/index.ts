// ── Work Slip transcript panel ───────────────────────────────────────
// Renders persisted event types from task.run.events as a single-column
// read-only conversation record.

import type { SafeTranscriptEventData, SafeTaskRunEventsResult } from '../../shared/taskgraph';

interface TranscriptWindowApi {
  onData: (taskRunId: string, cb: (data: SafeTaskRunEventsResult) => void) => () => void;
  onError: (cb: (message: string) => void) => () => void;
  retry: (taskRunId: string) => Promise<void>;
  close: () => Promise<void>;
}

declare global {
  interface Window {
    transcriptApi: TranscriptWindowApi;
  }
}

// ── State ────────────────────────────────────────────────────────────

interface TranscriptState {
  taskRunId: string;
  nodeId: string;
  events: SafeTranscriptEventData[];
  nextSeq: number;
  hasMore: boolean;
}

let state: TranscriptState | null = null;
const eventsCache: SafeTranscriptEventData[] = [];

// ── DOM refs ─────────────────────────────────────────────────────────

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const streamEl = getEl('stream');
const loadingEl = getEl('loading-indicator');
const errorEl = getEl('error-indicator');
const errorMsgEl = getEl('error-message');
const retryBtn = getEl('retry-btn');
const emptyEl = getEl('empty-indicator');

// ── Parsing helpers ──────────────────────────────────────────────────

function getQueryParam(name: string): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

// ── Event rendering — SafeTranscriptEventData only ──────────────────

const GENERIC_SUMMARIES = new Set([
  'Message recorded',
  'Tool input recorded',
  'No tool input recorded',
  'Tool output recorded',
  'No tool output recorded',
]);

const LIFECYCLE_LABELS: Record<string, string> = {
  'task.started': '任务开始',
  'task.done': '任务完成',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.cancelled': '任务取消',
};

type ToolState = 'pending' | 'ok' | 'error';

interface ToolActivity {
  timestamp: string;
  counts: Map<string, number>;
  calls: Map<string, ToolState>;
}

function renderEvents(events: SafeTranscriptEventData[]): void {
  streamEl.innerHTML = '';
  let toolActivity: ToolActivity | null = null;
  let syntheticCallId = 0;
  let renderedCount = 0;

  const flushToolActivity = (): void => {
    if (!toolActivity) return;
    streamEl.appendChild(renderToolActivity(toolActivity));
    toolActivity = null;
    renderedCount += 1;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'message': {
        flushToolActivity();
        if (!isMeaningfulSummary(ev.message_summary)) break;
        streamEl.appendChild(renderMessage(ev));
        renderedCount += 1;
        break;
      }
      case 'tool_call': {
        toolActivity ??= { timestamp: ev.timestamp, counts: new Map(), calls: new Map() };
        const label = humanToolLabel(ev.tool_name);
        toolActivity.counts.set(label, (toolActivity.counts.get(label) ?? 0) + 1);
        toolActivity.calls.set(ev.call_id ?? `call-${syntheticCallId++}`, 'pending');
        break;
      }
      case 'tool_result': {
        toolActivity ??= { timestamp: ev.timestamp, counts: new Map(), calls: new Map() };
        if (toolActivity.counts.size === 0) {
          toolActivity.counts.set('后台操作', 1);
        }
        toolActivity.calls.set(
          ev.call_id ?? `result-${syntheticCallId++}`,
          ev.is_error ? 'error' : 'ok',
        );
        break;
      }
      case 'turn_usage': {
        flushToolActivity();
        if (ev.input_tokens <= 0 && ev.output_tokens <= 0 && ev.total_tokens <= 0 && ev.duration_ms <= 0) break;
        streamEl.appendChild(renderUsage(ev));
        renderedCount += 1;
        break;
      }
      case 'lifecycle': {
        flushToolActivity();
        const label = LIFECYCLE_LABELS[ev.event];
        if (!label) break;
        streamEl.appendChild(renderLifecycle(ev.timestamp, label, ev.event));
        renderedCount += 1;
        break;
      }
      default:
        // Unknown adapter bookkeeping is intentionally omitted. A row saying
        // “details unavailable” is not useful conversation information.
        break;
    }
  }
  flushToolActivity();

  emptyEl.classList.toggle('visible', renderedCount === 0);
}

function renderMessage(ev: Extract<SafeTranscriptEventData, { type: 'message' }>): HTMLElement {
  const el = eventElement('message', 'event-message');
  const role = ev.role === 'user' ? '用户' : ev.role === 'system' ? '系统' : '助手';
  el.classList.add(`role-${ev.role || 'assistant'}`);
  el.appendChild(metaRow(ev.timestamp, role, 'message-role'));
  const content = document.createElement('div');
  content.className = 'event-content';
  content.textContent = ev.message_summary;
  el.appendChild(content);
  return el;
}

function renderToolActivity(activity: ToolActivity): HTMLElement {
  const el = eventElement('tool_activity', 'event-tool-activity');
  const meta = metaRow(activity.timestamp, '执行记录', 'flow-kicker');
  const states = [...activity.calls.values()];
  const failed = states.filter((state) => state === 'error').length;
  const pending = states.filter((state) => state === 'pending').length;
  const status = document.createElement('span');
  status.className = `tool-status ${failed > 0 ? 'error' : pending > 0 ? 'pending' : 'ok'}`;
  status.textContent = failed > 0
    ? `${failed} 项失败`
    : pending > 0
      ? `${pending} 项进行中`
      : `${states.length} 项完成`;
  meta.appendChild(status);
  el.appendChild(meta);

  const summary = document.createElement('div');
  summary.className = 'tool-activity-summary';
  summary.textContent = [...activity.counts.entries()]
    .map(([label, count]) => `${label} ×${count}`)
    .join(' · ');
  summary.title = summary.textContent;
  el.appendChild(summary);
  return el;
}

function humanToolLabel(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === 'read' || normalized.includes('read_file')) return '阅读文件';
  if (normalized === 'grep' || normalized.includes('search')) return '搜索代码';
  if (normalized === 'glob' || normalized.includes('find')) return '查找文件';
  if (normalized === 'bash' || normalized.includes('shell') || normalized.includes('command')) return '执行命令';
  if (normalized === 'edit' || normalized.includes('patch')) return '修改文件';
  if (normalized === 'write' || normalized.includes('create_file')) return '写入文件';
  if (normalized.includes('task') || normalized.includes('todo')) return '协作与进度';
  if (normalized.includes('web') || normalized.includes('fetch')) return '查询资料';
  return '其他操作';
}

function renderUsage(ev: Extract<SafeTranscriptEventData, { type: 'turn_usage' }>): HTMLElement {
  const el = eventElement('turn_usage', 'event-turn_usage');
  const parts = [
    ev.input_tokens > 0 ? `输入 ${formatCount(ev.input_tokens)}` : '',
    ev.output_tokens > 0 ? `输出 ${formatCount(ev.output_tokens)}` : '',
    ev.duration_ms > 0 ? `用时 ${formatMs(ev.duration_ms)}` : '',
  ].filter(Boolean);
  el.textContent = `${formatTimestamp(ev.timestamp)} · ${parts.join(' · ')}`;
  return el;
}

function renderLifecycle(timestamp: string, label: string, eventType: string): HTMLElement {
  const el = eventElement(eventType, 'event-lifecycle');
  el.textContent = `${formatTimestamp(timestamp)}  —  ${label}`;
  return el;
}

function eventElement(eventType: string, className: string): HTMLElement {
  const el = document.createElement('article');
  el.className = `event ${className}`;
  el.dataset.eventType = eventType;
  return el;
}

function metaRow(timestamp: string, label: string, labelClass: string): HTMLElement {
  const meta = document.createElement('div');
  meta.className = 'event-meta';
  const ts = document.createElement('time');
  ts.className = 'timestamp-marker';
  ts.textContent = formatTimestamp(timestamp);
  meta.appendChild(ts);
  const role = document.createElement('span');
  role.className = labelClass;
  role.textContent = label;
  meta.appendChild(role);
  return meta;
}

function isMeaningfulSummary(value: string): boolean {
  return value.trim().length > 0 && !GENERIC_SUMMARIES.has(value);
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}毫秒`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}秒`;
  return `${Math.floor(ms / 60000)}分${Math.round((ms % 60000) / 1000)}秒`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

// ── UI state management ──────────────────────────────────────────────

function setTranscriptState(state: 'loading' | 'data' | 'empty' | 'error'): void {
  document.documentElement.dataset.transcriptState = state;
}

function showLoading(): void {
  loadingEl.classList.add('visible');
  errorEl.classList.remove('visible');
  emptyEl.classList.remove('visible');
  setTranscriptState('loading');
}

function hideLoading(): void {
  loadingEl.classList.remove('visible');
}

function showError(message: string): void {
  errorMsgEl.textContent = message;
  errorEl.classList.add('visible');
  hideLoading();
  setTranscriptState('error');
}

function hideError(): void {
  errorEl.classList.remove('visible');
}

// ── Init ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  try {
    const taskRunId = getQueryParam('task_run_id');
    const nodeIdParam = getQueryParam('node_id');
    const taskLabelParam = getQueryParam('task_label');

    if (!taskRunId) {
      showError('Missing task_run_id');
      return;
    }

    state = {
      taskRunId,
      nodeId: nodeIdParam || '',
      events: [],
      nextSeq: 0,
      hasMore: true,
    };

    const api = window.transcriptApi;

    // Populate header from query params
    const nodeNameEl = document.getElementById('node-name');
    if (nodeNameEl) {
      const label = taskLabelParam || nodeIdParam || '任务对话';
      const boundedLabel = label.length > 48 ? label.slice(0, 47) + '…' : label;
      nodeNameEl.textContent = boundedLabel;
      nodeNameEl.title = label;
    }
    const runIdEl = document.getElementById('run-id');
    if (runIdEl && taskRunId) {
      const boundedId = taskRunId.length > 12 ? taskRunId.slice(0, 12) + '…' : taskRunId;
      runIdEl.textContent = boundedId;
    }

    // Close button and Escape
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        api.close();
      });
    }
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        api.close();
      }
    });

    api.onData(taskRunId, (data: SafeTaskRunEventsResult) => {
      hideLoading();
      hideError();
      if (data.events.length > 0) {
        const wasAtBottom = isAtBottom();
        eventsCache.push(...data.events);
        renderEvents(eventsCache);
        if (wasAtBottom) scrollToBottom();
        setTranscriptState('data');
      } else {
        if (eventsCache.length === 0) emptyEl.classList.add('visible');
        setTranscriptState('empty');
      }
      if (state) {
        state.nextSeq = data.next_seq;
        state.hasMore = data.has_more;
      }
    });

    api.onError((message: string) => {
      hideLoading();
      showError(message);
    });

    retryBtn.addEventListener('click', () => {
      hideError();
      showLoading();
      void api.retry(taskRunId);
    });

    showLoading();
    document.documentElement.dataset.transcriptReady = '1';
  } catch (e) {
    console.error('[transcript] init failed:', e);
  }
}

function isAtBottom(): boolean {
  return streamEl.scrollTop + streamEl.clientHeight >= streamEl.scrollHeight - 20;
}

function scrollToBottom(): void {
  streamEl.scrollTop = streamEl.scrollHeight;
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', init);
}
