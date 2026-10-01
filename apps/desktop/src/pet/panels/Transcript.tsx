// ── Work Slip transcript panel (React) ──────────────────────────────
// Renders persisted task.run.events as a read-only conversation record with
// the shared Message/Bubble/Markdown components. Only the sanitized
// SafeTranscriptEventData allowlist crosses the preload boundary; the panel
// accumulates incremental rounds and keeps the stream pinned to the bottom
// while the reader stays there.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/renderer/components/ui/badge';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import { Message, MessageContent, MessageHeader } from '@/renderer/components/ui/message';
import { Markdown } from '@/renderer/components/markdown';
import { formatClockSeconds, formatElapsedMs, formatTokenCount } from '@/renderer/lib/format';
import { petAppearanceBridge, type PetAppearanceApi } from '../shared/appearance';
import type { SafeTaskRunEventsResult, SafeTranscriptEventData } from '../shared/taskgraph';

interface TranscriptWindowApi {
  onData: (taskRunId: string, cb: (data: SafeTaskRunEventsResult) => void) => () => void;
  onError: (cb: (message: string) => void) => () => void;
  retry: (taskRunId: string) => Promise<void>;
  close: () => Promise<void>;
}

declare global {
  interface Window {
    transcriptApi: TranscriptWindowApi;
    petAppearance: PetAppearanceApi;
  }
}

// ── Parsing helpers (ported from the removed transcript DOM module) ──

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

interface SafeMessageEvent extends Extract<SafeTranscriptEventData, { type: 'message' }> {}
interface SafeUsageEvent extends Extract<SafeTranscriptEventData, { type: 'turn_usage' }> {}
interface SafeLifecycleEvent extends Extract<SafeTranscriptEventData, { type: 'lifecycle' }> {}

interface ToolActivity {
  timestamp: string;
  counts: Map<string, number>;
  calls: Map<string, ToolState>;
}

type RenderedEvent =
  | { kind: 'message'; key: string; event: SafeMessageEvent }
  | { kind: 'tool'; key: string; activity: ToolActivity }
  | { kind: 'usage'; key: string; event: SafeUsageEvent }
  | { kind: 'lifecycle'; key: string; event: SafeLifecycleEvent; label: string };

function isMeaningfulSummary(value: string): boolean {
  return value.trim().length > 0 && !GENERIC_SUMMARIES.has(value);
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

/**
 * Flatten the safe event stream into renderable rows. Tool calls/results
 * between two messages collapse into one aggregated activity row; unknown
 * adapter bookkeeping is intentionally omitted.
 */
function projectEvents(events: SafeTranscriptEventData[]): RenderedEvent[] {
  const rows: RenderedEvent[] = [];
  let toolActivity: ToolActivity | null = null;
  let syntheticCallId = 0;
  let index = 0;

  const flushToolActivity = (): void => {
    if (!toolActivity) return;
    rows.push({ kind: 'tool', key: `tool-${index++}`, activity: toolActivity });
    toolActivity = null;
  };

  for (const event of events) {
    switch (event.type) {
      case 'message': {
        flushToolActivity();
        if (isMeaningfulSummary(event.message_summary)) {
          rows.push({ kind: 'message', key: `message-${index++}`, event });
        }
        break;
      }
      case 'tool_call': {
        toolActivity ??= { timestamp: event.timestamp, counts: new Map(), calls: new Map() };
        const label = humanToolLabel(event.tool_name);
        toolActivity.counts.set(label, (toolActivity.counts.get(label) ?? 0) + 1);
        toolActivity.calls.set(event.call_id ?? `call-${syntheticCallId++}`, 'pending');
        break;
      }
      case 'tool_result': {
        toolActivity ??= { timestamp: event.timestamp, counts: new Map(), calls: new Map() };
        if (toolActivity.counts.size === 0) toolActivity.counts.set('后台操作', 1);
        toolActivity.calls.set(event.call_id ?? `result-${syntheticCallId++}`, event.is_error ? 'error' : 'ok');
        break;
      }
      case 'turn_usage': {
        flushToolActivity();
        if (
          event.input_tokens <= 0
          && event.output_tokens <= 0
          && event.total_tokens <= 0
          && event.duration_ms <= 0
        ) break;
        rows.push({ kind: 'usage', key: `usage-${index++}`, event });
        break;
      }
      case 'lifecycle': {
        flushToolActivity();
        const label = LIFECYCLE_LABELS[event.event];
        if (label === undefined) break;
        rows.push({ kind: 'lifecycle', key: `lifecycle-${index++}`, event, label });
        break;
      }
      default:
        break;
    }
  }
  flushToolActivity();
  return rows;
}

// ── Rows ─────────────────────────────────────────────────────────────

interface RowAppearance {
  dark: boolean;
  onOpenExternal: (href: string) => void;
}

function MessageRow({ event, appearance }: { event: SafeMessageEvent; appearance: RowAppearance }): ReactElement {
  const role = event.role === 'user' ? '用户' : event.role === 'system' ? '系统' : '助手';
  const align = event.role === 'user' ? 'end' : 'start';
  return (
    <Message align={align}>
      <MessageContent>
        <MessageHeader className="px-0">
          <time className="text-xs text-muted-foreground">{formatClockSeconds(event.timestamp)}</time>
          <span className="ml-2 text-xs font-bold text-muted-foreground">{role}</span>
        </MessageHeader>
        <Bubble variant={event.role === 'user' ? 'secondary' : 'muted'} align={align}>
          <BubbleContent>
            <Markdown
              className="text-xs"
              dark={appearance.dark}
              onOpenExternal={appearance.onOpenExternal}
            >
              {event.message_summary}
            </Markdown>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function ToolRow({ activity }: { activity: ToolActivity }): ReactElement {
  const states = [...activity.calls.values()];
  const failed = states.filter((state) => state === 'error').length;
  const pending = states.filter((state) => state === 'pending').length;
  const status = failed > 0
    ? { label: `${failed} 项失败`, variant: 'destructive' as const, tone: 'text-destructive' }
    : pending > 0
      ? { label: `${pending} 项进行中`, variant: 'outline' as const, tone: 'text-warning' }
      : { label: `${states.length} 项完成`, variant: 'outline' as const, tone: 'text-success' };
  const summary = [...activity.counts.entries()].map(([label, count]) => `${label} ×${count}`).join(' · ');
  return (
    <Card size="sm" className="mx-3 gap-1 border-l-2 bg-muted/20 py-2">
      <div className="flex items-center gap-2 px-3">
        <time className="text-xs text-muted-foreground">{formatClockSeconds(activity.timestamp)}</time>
        <span className="text-xs font-bold text-muted-foreground">执行记录</span>
        <Badge variant={status.variant} className={`ml-auto ${status.tone}`}>
          {status.label}
        </Badge>
      </div>
      <div className="truncate px-3 text-xs text-muted-foreground" title={summary}>
        {summary}
      </div>
    </Card>
  );
}

function UsageRow({ event }: { event: SafeUsageEvent }): ReactElement {
  const parts = [
    event.input_tokens > 0 ? `输入 ${formatTokenCount(event.input_tokens)}` : '',
    event.output_tokens > 0 ? `输出 ${formatTokenCount(event.output_tokens)}` : '',
    event.duration_ms > 0 ? `用时 ${formatElapsedMs(event.duration_ms)}` : '',
  ].filter(Boolean);
  return (
    <div className="my-2 border-y border-dashed border-border px-2 py-1 text-center text-xs text-muted-foreground">
      {`${formatClockSeconds(event.timestamp)} · ${parts.join(' · ')}`}
    </div>
  );
}

function LifecycleRow({ event, label }: { event: SafeLifecycleEvent; label: string }): ReactElement {
  return (
    <div className="px-2 py-1 text-center text-xs text-muted-foreground">
      {`${formatClockSeconds(event.timestamp)}  —  ${label}`}
    </div>
  );
}

function renderRow(row: RenderedEvent, appearance: RowAppearance): ReactNode {
  switch (row.kind) {
    case 'message': return <MessageRow key={row.key} event={row.event} appearance={appearance} />;
    case 'tool': return <ToolRow key={row.key} activity={row.activity} />;
    case 'usage': return <UsageRow key={row.key} event={row.event} />;
    case 'lifecycle': return <LifecycleRow key={row.key} event={row.event} label={row.label} />;
  }
}

// ── Panel ────────────────────────────────────────────────────────────

type TranscriptState = 'loading' | 'data' | 'empty' | 'error';

/** Current Pet appearance, mirrored synchronously from the preload bridge. */
function usePetAppearance(): { dark: boolean } {
  return useSyncExternalStore(
    (listener) => petAppearanceBridge.subscribe(listener),
    () => petAppearanceBridge.getSnapshot(),
    () => petAppearanceBridge.getSnapshot(),
  );
}

export function Transcript(): ReactElement {
  const [taskRunId] = useState(() => new URLSearchParams(window.location.search).get('task_run_id') ?? '');
  const [nodeLabel] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('task_label') || params.get('node_id') || '任务对话';
  });
  const [platform] = useState(() => new URLSearchParams(window.location.search).get('platform') ?? '');
  const [events, setEvents] = useState<SafeTranscriptEventData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const stickToBottom = useRef(true);
  const streamRef = useRef<HTMLDivElement | null>(null);

  const missingRunId = taskRunId.length === 0;
  const appearance = usePetAppearance();
  const onOpenExternal = useCallback((href: string) => {
    void window.petAppearance.openExternal(href);
  }, []);

  useEffect(() => {
    if (platform) document.documentElement.dataset.platform = platform;
  }, [platform]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.transcriptReady = '1';
    return () => {
      delete root.dataset.transcriptReady;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const state: TranscriptState = error ? 'error' : events.length > 0 ? 'data' : 'empty';
    root.dataset.transcriptState = loading ? 'loading' : state;
  }, [error, events.length, loading]);

  useEffect(() => {
    if (missingRunId) {
      setLoading(false);
      setError('Missing task_run_id');
      return;
    }
    const api = window.transcriptApi;
    if (!api) return;
    const disposeData = api.onData(taskRunId, (data) => {
      setLoading(false);
      setError(null);
      if (data.events.length > 0) setEvents((current) => [...current, ...data.events]);
    });
    const disposeError = api.onError((message) => {
      setLoading(false);
      setError(message);
    });
    return () => {
      disposeData();
      disposeError();
    };
  }, [missingRunId, taskRunId]);

  // Keep the stream pinned to the bottom while the reader stays there.
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream || !stickToBottom.current) return;
    stream.scrollTop = stream.scrollHeight;
  }, [events]);

  const rows = useMemo(() => projectEvents(events), [events]);
  const rowAppearance = useMemo<RowAppearance>(
    () => ({ dark: appearance.dark, onOpenExternal }),
    [appearance.dark, onOpenExternal],
  );
  const boundedRunId = taskRunId.length > 12 ? `${taskRunId.slice(0, 12)}…` : taskRunId;
  const boundedLabel = nodeLabel.length > 48 ? `${nodeLabel.slice(0, 47)}…` : nodeLabel;
  const showEmpty = !loading && !error && rows.length === 0;

  return (
    <div className="relative flex h-screen w-screen flex-col bg-background text-xs text-foreground">
      <div className="flex min-h-9 items-center gap-2 border-b border-border bg-background/95 px-2.5 py-1 shadow-sm [-webkit-app-region:drag]">
        {platform === 'darwin' && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭任务对话"
            className="[-webkit-app-region:no-drag]"
            onClick={() => void window.transcriptApi.close()}
          >
            <X />
          </Button>
        )}
        <span className="flex-1 truncate text-xs font-semibold" title={nodeLabel}>{boundedLabel}</span>
        <span className="text-xs text-muted-foreground">{boundedRunId}</span>
      </div>

      <div
        ref={streamRef}
        role="log"
        aria-live="polite"
        aria-label="任务对话流"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 20;
        }}
        className="flex-1 overflow-y-auto px-2.5 pb-4 pt-2.5"
      >
        {rows.map((row) => renderRow(row, rowAppearance))}
      </div>

      {loading && !error && (
        <div className="absolute inset-x-0 bottom-0 top-9 flex items-center justify-center bg-background/95 text-muted-foreground">
          正在读取对话…
        </div>
      )}
      {showEmpty && (
        <div className="absolute inset-x-0 bottom-0 top-9 flex items-center justify-center bg-background/97 text-muted-foreground">
          还没有可读的对话信息。
        </div>
      )}
      {error && (
        <div className="absolute inset-x-0 bottom-0 top-9 flex flex-col items-center justify-center gap-2 bg-background/97 text-destructive">
          <span>{error}</span>
          {!missingRunId && (
            <Button
              onClick={() => {
                setError(null);
                setLoading(true);
                void window.transcriptApi.retry(taskRunId);
              }}
            >
              重试
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
