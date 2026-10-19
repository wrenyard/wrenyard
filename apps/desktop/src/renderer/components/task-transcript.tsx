/**
 * Shared task-run transcript view: the same event stream the standalone
 * 查看任务对话 window renders, extracted so the activity side panel can embed
 * it. `TaskTranscriptStream` is the pure view over already-loaded events;
 * `TaskTranscript` additionally owns pulling/polling behind a small
 * `TaskRunEventsLoader` interface — the shell feeds it from the session
 * bridge while the Pet window keeps its pushed `transcriptApi` pages and uses
 * the stream directly. Tool calls between two messages fold into one
 * execution record that expands to every recorded call.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { Badge } from '@/renderer/components/ui/badge';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Button } from '@/renderer/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { Message, MessageContent, MessageHeader } from '@/renderer/components/ui/message';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Markdown } from '@/renderer/components/markdown';
import { formatClockSeconds, formatElapsedMs, formatTokenCount } from '@/renderer/lib/format';
import type { SafeTaskRunEventsResult, SafeTranscriptEventData, TranscriptRunInfo } from '@/pet/shared/taskgraph';
import {
  fileReference,
  labelForField,
  lineRangeText,
  parseTaskResult,
  valueLabel,
  valueTone,
  type FileReference,
  type ParsedTaskResult,
  type StatusTone,
} from '@/pet/panels/task-result';

/** One page of task-run transcript events, plus the authoritative run facts. */
export interface TaskRunEventsLoader {
  /** Read events after `afterSeq` (or the first page when omitted). */
  load(taskRunId: string, afterSeq?: number): Promise<SafeTaskRunEventsResult>;
  /** Re-request the stream after a failed load. */
  retry(taskRunId: string): Promise<void>;
}

/** Map an authoritative run status to its Chinese label, tone and liveness. */
export function runStatusView(status?: string): { label: string; tone: string; dot: string; live: boolean } | undefined {
  if (status === undefined || status === '') return undefined;
  switch (status) {
    case 'done':
      return { label: '已完成', tone: 'text-success', dot: 'bg-success', live: false };
    case 'failed':
      return { label: '失败', tone: 'text-destructive', dot: 'bg-destructive', live: false };
    case 'cancelled':
      return { label: '已取消', tone: 'text-muted-foreground', dot: 'bg-muted-foreground', live: false };
    case 'interrupted':
      return { label: '已中断', tone: 'text-warning', dot: 'bg-warning', live: false };
    case 'queued':
    case 'pending':
    case 'created':
      return { label: '排队中', tone: 'text-muted-foreground', dot: 'bg-muted-foreground', live: true };
    default:
      return {
        label: '运行中',
        tone: 'text-foreground',
        dot: 'bg-warning animate-pulse motion-reduce:animate-none [[data-motion=reduce]_&]:animate-none',
        live: true,
      };
  }
}

/** Terminal run statuses end incremental polling. */
const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled', 'interrupted']);

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

const LIFECYCLE_TONE: Record<string, string> = {
  'task.done': 'text-success',
  'task.completed': 'text-success',
  'task.failed': 'text-destructive',
};

// ── Tool activity model ──────────────────────────────────────────────

type ToolState = 'pending' | 'ok' | 'error';

interface ToolCallRecord {
  key: string;
  callId?: string;
  timestamp: string;
  label: string;
  toolName: string;
  input: string;
  output: string;
  state: ToolState;
}

interface ToolActivity {
  timestamp: string;
  calls: ToolCallRecord[];
}

interface SafeMessageEvent extends Extract<SafeTranscriptEventData, { type: 'message' }> {}
interface SafeUsageEvent extends Extract<SafeTranscriptEventData, { type: 'turn_usage' }> {}
interface SafeLifecycleEvent extends Extract<SafeTranscriptEventData, { type: 'lifecycle' }> {}

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
 * between two messages collapse into one execution record that keeps every
 * recorded call; unknown adapter bookkeeping is intentionally omitted.
 */
function projectEvents(events: SafeTranscriptEventData[]): RenderedEvent[] {
  const rows: RenderedEvent[] = [];
  let toolActivity: ToolActivity | null = null;
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
        toolActivity ??= { timestamp: event.timestamp, calls: [] };
        toolActivity.calls.push({
          key: `call-${toolActivity.calls.length}`,
          callId: event.call_id,
          timestamp: event.timestamp,
          label: humanToolLabel(event.tool_name),
          toolName: event.tool_name,
          input: isMeaningfulSummary(event.input_summary) ? event.input_summary : '',
          output: '',
          state: 'pending',
        });
        break;
      }
      case 'tool_result': {
        toolActivity ??= { timestamp: event.timestamp, calls: [] };
        const match = event.call_id !== undefined
          ? toolActivity.calls.find((call) => call.callId === event.call_id)
          : toolActivity.calls.find((call) => call.state === 'pending' && call.callId === undefined);
        if (match) {
          match.state = event.is_error ? 'error' : 'ok';
          match.output = isMeaningfulSummary(event.output_summary) ? event.output_summary : '';
        } else {
          toolActivity.calls.push({
            key: `call-${toolActivity.calls.length}`,
            timestamp: event.timestamp,
            label: '后台操作',
            toolName: '',
            input: '',
            output: isMeaningfulSummary(event.output_summary) ? event.output_summary : '',
            state: event.is_error ? 'error' : 'ok',
          });
        }
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

// ── Structured task results ──────────────────────────────────────────

// Transcript markdown keeps headings at body scale inside compact bubbles.
const MARKDOWN_CLASS = 'text-sm [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:text-sm [&_h4]:font-medium';
// Decoded result text keeps its single line breaks.
const RESULT_MARKDOWN_CLASS = `${MARKDOWN_CLASS} [&_p]:whitespace-pre-wrap`;
const MARKDOWN_SYNTAX = /[\n`*#[\]|>]/;
const PILL_FIELDS = new Set(['status', 'confidence', 'action']);

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  muted: 'border-border bg-muted/60 text-muted-foreground',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortPrimitive(value: unknown): boolean {
  return value === null || typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 40 && !value.includes('\n'));
}

function primitiveText(value: unknown): string {
  return value === null ? '—' : String(value);
}

function ResultPill({ field, value }: { field: string; value: string }): ReactElement {
  return (
    <Badge variant="outline" className={cn('h-4 shrink-0 px-1.5 text-[10px] font-normal', TONE_CLASS[valueTone(field, value)])}>
      {valueLabel(field, value)}
    </Badge>
  );
}

function ResultMuted({ children }: { children: ReactNode }): ReactElement {
  return <span className="text-[11px] text-muted-foreground">{children}</span>;
}

function ResultReference({ reference }: { reference: FileReference }): ReactElement {
  return (
    <code className="min-w-0 break-all font-mono text-[11px] text-foreground/90">
      {reference.kind !== undefined && <span className="text-muted-foreground">{valueLabel('kind', reference.kind)} · </span>}
      {reference.text}
    </code>
  );
}

function ResultText({ text, appearance }: { text: string; appearance: RowAppearance }): ReactElement {
  if (!MARKDOWN_SYNTAX.test(text)) return <span className="break-words">{text}</span>;
  return (
    <Markdown className={RESULT_MARKDOWN_CLASS} dark={appearance.dark} onOpenExternal={appearance.onOpenExternal}>
      {text}
    </Markdown>
  );
}

const NO_FIELDS: ReadonlySet<string> = new Set();

interface ResultValueProps {
  field: string;
  value: unknown;
  appearance: RowAppearance;
}

/** One value of a parsed result, rendered compactly and without dropping data. */
function ResultValue({ field, value, appearance }: ResultValueProps): ReactElement | null {
  if (value === null || value === undefined) return <ResultMuted>—</ResultMuted>;
  if (typeof value === 'string') {
    if (PILL_FIELDS.has(field) && value.length > 0 && value.length <= 40) return <ResultPill field={field} value={value} />;
    return <ResultText text={value} appearance={appearance} />;
  }
  if (typeof value !== 'object') return <span className="tabular-nums">{String(value)}</span>;
  const reference = fileReference(value);
  if (reference) return <ResultReference reference={reference} />;
  if (Array.isArray(value)) return <ResultList field={field} items={value} appearance={appearance} />;
  return <ResultFields record={value as Record<string, unknown>} omit={NO_FIELDS} appearance={appearance} />;
}

function ResultList({ field, items, appearance }: { field: string; items: unknown[]; appearance: RowAppearance }): ReactElement {
  if (items.length === 0) return <ResultMuted>空列表</ResultMuted>;
  const range = field === 'line_range' ? lineRangeText(items) : null;
  if (range !== null) return <span className="font-mono text-[11px] tabular-nums">{range}</span>;
  if (items.every(isShortPrimitive)) {
    return <span className="break-words tabular-nums">{items.map(primitiveText).join(' · ')}</span>;
  }
  const references = items.map(fileReference);
  if (references.every((reference) => reference !== null)) {
    return (
      <ul className="flex min-w-0 flex-col gap-0.5">
        {references.map((reference, index) => (
          <li key={index} className="min-w-0"><ResultReference reference={reference as FileReference} /></li>
        ))}
      </ul>
    );
  }
  if (items.every((item) => !isRecord(item) && !Array.isArray(item))) {
    return (
      <ul className="flex min-w-0 list-disc flex-col gap-0.5 pl-4">
        {items.map((item, index) => (
          <li key={index} className="min-w-0 break-words"><ResultValue field={field} value={item} appearance={appearance} /></li>
        ))}
      </ul>
    );
  }
  return (
    <ol className="flex min-w-0 flex-col gap-1.5">
      {items.map((item, index) => (
        <li key={index} className="min-w-0 rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
          <ResultValue field={field} value={item} appearance={appearance} />
        </li>
      ))}
    </ol>
  );
}

/** Labelled two-column grid of a result object; unknown keys keep their own name. */
function ResultFields(
  { record, omit, appearance }: { record: Record<string, unknown>; omit: ReadonlySet<string>; appearance: RowAppearance },
): ReactElement | null {
  const entries = Object.entries(record).filter(([key]) => !omit.has(key));
  if (entries.length === 0) return Object.keys(record).length === 0 ? <ResultMuted>空对象</ResultMuted> : null;
  return (
    <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-1">
      {entries.map(([key, entry]) => (
        <Fragment key={key}>
          <dt className="text-[11px] text-muted-foreground">{labelForField(key)}</dt>
          <dd className="min-w-0 break-words">
            <ResultValue field={key} value={entry} appearance={appearance} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Readable card for a structured result with the untouched original text behind 原始内容. */
function TaskResultMessage(
  { parsed, text, appearance }: { parsed: ParsedTaskResult; text: string; appearance: RowAppearance },
): ReactElement {
  const value = parsed.value;
  const answerField = isRecord(value) && typeof value.answer === 'string' ? value.answer : undefined;
  const answer = parsed.answer ?? answerField;
  const hasAnswer = answer !== undefined && answer.trim() !== '';
  const omit = new Set<string>();
  if (parsed.status !== undefined) omit.add('status');
  if (hasAnswer && answerField !== undefined) omit.add('answer');
  const restCount = isRecord(value)
    ? Object.keys(value).filter((key) => !omit.has(key)).length
    : value !== undefined ? 1 : 0;
  const summary = parsed.summary ?? '';
  // The preserved leading text is only shown when it adds information beyond
  // the promoted answer, and never in place of the untouched raw text.
  const showSummary = summary !== '' && summary !== (answer?.trim() ?? '');
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs">
      {showSummary && <p className="min-w-0 break-words text-[11px] leading-relaxed text-muted-foreground">{summary}</p>}
      {hasAnswer && (
        <Markdown className={RESULT_MARKDOWN_CLASS} dark={appearance.dark} onOpenExternal={appearance.onOpenExternal}>
          {answer}
        </Markdown>
      )}
      {restCount > 0 && (
        <div className={cn('min-w-0', hasAnswer && 'border-t border-border/60 pt-2')}>
          {isRecord(value)
            ? <ResultFields record={value} omit={omit} appearance={appearance} />
            : <ResultValue field="" value={value} appearance={appearance} />}
        </div>
      )}
      {parsed.truncated && (
        <ResultMuted>{hasAnswer ? '内容已截断' : '结构化结果预览已截断，请展开原始内容查看。'}</ResultMuted>
      )}
      <details className="group min-w-0 border-t border-border/60 pt-1.5">
        <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          原始内容
        </summary>
        <pre className="mt-1.5 max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/90">{text}</pre>
      </details>
    </div>
  );
}

function MessageRow({ event, appearance }: { event: SafeMessageEvent; appearance: RowAppearance }): ReactElement {
  const role = event.role === 'user' ? '用户' : event.role === 'system' ? '系统' : '助手';
  const align = event.role === 'user' ? 'end' : 'start';
  const assistant = event.role !== 'user' && event.role !== 'system';
  const parsed = assistant ? parseTaskResult(event.message_summary) : null;
  return (
    <Message align={align}>
      <MessageContent>
        <MessageHeader className="gap-2 px-0 text-xs">
          <span className="font-medium text-foreground">{role}</span>
          <time className="tabular-nums text-muted-foreground">{formatClockSeconds(event.timestamp)}</time>
          {parsed?.status !== undefined && <ResultPill field="status" value={parsed.status} />}
        </MessageHeader>
        <Bubble variant={event.role === 'user' ? 'default' : 'muted'} align={align} className={parsed ? 'w-full' : undefined}>
          <BubbleContent>
            {parsed === null ? (
              <Markdown className={MARKDOWN_CLASS} dark={appearance.dark} onOpenExternal={appearance.onOpenExternal}>
                {event.message_summary}
              </Markdown>
            ) : (
              <TaskResultMessage parsed={parsed} text={event.message_summary} appearance={appearance} />
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

const TOOL_STATE_DOT: Record<ToolState, { className: string; label: string }> = {
  ok: { className: 'bg-success', label: '完成' },
  error: { className: 'bg-destructive', label: '失败' },
  pending: { className: 'bg-warning', label: '进行中' },
};

function ToolDetail({ label, text, error }: { label: string; text: string; error: boolean }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 pl-3.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <pre className={cn('whitespace-pre-wrap break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed', error ? 'text-destructive' : 'text-foreground/90')}>{text}</pre>
    </div>
  );
}

function ToolCallItem({ call, live }: { call: ToolCallRecord; live: boolean }): ReactElement {
  const dot = call.state === 'pending' && !live
    ? { className: 'bg-muted-foreground', label: '无结果' }
    : TOOL_STATE_DOT[call.state];
  return (
    <li className="flex min-w-0 flex-col gap-1 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('size-1.5 shrink-0 rounded-full', dot.className)} title={dot.label} aria-label={dot.label} />
        <span className="shrink-0 font-medium text-foreground">{call.label}</span>
        {call.toolName !== '' && (
          <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={call.toolName}>{call.toolName}</code>
        )}
        <time className="ml-auto shrink-0 tabular-nums text-muted-foreground">{formatClockSeconds(call.timestamp)}</time>
      </div>
      {call.input !== '' && <ToolDetail label="输入" text={call.input} error={false} />}
      {call.output !== '' && <ToolDetail label="输出" text={call.output} error={call.state === 'error'} />}
    </li>
  );
}

function ToolGroup({ activity, live }: { activity: ToolActivity; live: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const calls = activity.calls;
  const failed = calls.filter((call) => call.state === 'error').length;
  const pending = calls.filter((call) => call.state === 'pending').length;
  const status = failed > 0
    ? { label: `${failed} 项失败`, tone: 'text-destructive' }
    : pending > 0
      ? live
        ? { label: `${pending} 项进行中`, tone: 'text-warning' }
        : { label: `${pending} 项无结果`, tone: 'text-muted-foreground' }
      : { label: `${calls.length} 项完成`, tone: 'text-success' };

  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.label, (counts.get(call.label) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(' · ');

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card text-xs">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        <span className="shrink-0 font-medium text-foreground">执行记录</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={summary}>{summary}</span>
        <span className={cn('shrink-0', status.tone)}>{status.label}</span>
        <time className="shrink-0 tabular-nums text-muted-foreground">{formatClockSeconds(activity.timestamp)}</time>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="flex flex-col divide-y border-t">
          {calls.map((call) => <ToolCallItem key={call.key} call={call} live={live} />)}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TimelineDivider({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="min-w-0 truncate tabular-nums">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function UsageRow({ event }: { event: SafeUsageEvent }): ReactElement {
  const parts = [
    event.input_tokens > 0 ? `输入 ${formatTokenCount(event.input_tokens)}` : '',
    event.output_tokens > 0 ? `输出 ${formatTokenCount(event.output_tokens)}` : '',
    event.duration_ms > 0 ? `用时 ${formatElapsedMs(event.duration_ms)}` : '',
  ].filter(Boolean);
  return <TimelineDivider>{[formatClockSeconds(event.timestamp), ...parts].join(' · ')}</TimelineDivider>;
}

function LifecycleRow({ event, label }: { event: SafeLifecycleEvent; label: string }): ReactElement {
  return (
    <TimelineDivider>
      <span className={cn('font-medium', LIFECYCLE_TONE[event.event])}>{label}</span>
      {' · '}
      {formatClockSeconds(event.timestamp)}
    </TimelineDivider>
  );
}

function renderRow(row: RenderedEvent, appearance: RowAppearance, live: boolean): ReactNode {
  switch (row.kind) {
    case 'message': return <MessageRow key={row.key} event={row.event} appearance={appearance} />;
    case 'tool': return <ToolGroup key={row.key} activity={row.activity} live={live} />;
    case 'usage': return <UsageRow key={row.key} event={row.event} />;
    case 'lifecycle': return <LifecycleRow key={row.key} event={row.event} label={row.label} />;
  }
}

// ── Stream (presentational) ──────────────────────────────────────────

export interface TaskTranscriptStreamProps {
  /** Already loaded safe events, in order. */
  events: SafeTranscriptEventData[];
  /** True while the run is live (drives the 运行中 tail row). */
  live: boolean;
  /** First page still loading. */
  loading: boolean;
  /** Load failure message, when any. */
  error: string | null;
  /** Re-run the initial load after a failure; omitted when nothing can retry. */
  onRetry?: () => void;
  /** Resolved dark appearance for syntax highlighting. */
  dark: boolean;
  /** External-link opener for markdown content. */
  onOpenExternal: (href: string) => void;
  className?: string;
}

/**
 * The scrollable transcript stream shared by the standalone window and the
 * activity panel preview. Keeps the scroll pinned to the bottom while the
 * reader stays there and renders the projected rows plus the loading/empty/
 * error overlays (anchored to this element, never to the viewport).
 */
export function TaskTranscriptStream({
  events,
  live,
  loading,
  error,
  onRetry,
  dark,
  onOpenExternal,
  className,
}: TaskTranscriptStreamProps): ReactElement {
  const stickToBottom = useRef(true);
  const streamRef = useRef<HTMLDivElement | null>(null);

  // Keep the stream pinned to the bottom while the reader stays there.
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream || !stickToBottom.current) return;
    stream.scrollTop = stream.scrollHeight;
  }, [events, live]);

  const rows = useMemo(() => projectEvents(events), [events]);
  const rowAppearance = useMemo<RowAppearance>(
    () => ({ dark, onOpenExternal }),
    [dark, onOpenExternal],
  );
  const showEmpty = !loading && !error && rows.length === 0;

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col bg-background text-xs text-foreground', className)}>
      <div
        ref={streamRef}
        role="log"
        aria-live="polite"
        aria-label="任务对话流"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 20;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {rows.map((row) => renderRow(row, rowAppearance, live))}
        {live && rows.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />运行中…
          </div>
        )}
      </div>

      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/95 text-muted-foreground">
          正在读取对话…
        </div>
      )}
      {showEmpty && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/97 text-muted-foreground">
          {live ? '正在等待第一条记录…' : '还没有可读的对话信息。'}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/97 text-destructive">
          <span>读取任务对话失败</span>
          {onRetry !== undefined && <Button onClick={onRetry}>重试</Button>}
        </div>
      )}
    </div>
  );
}

// ── Polling container ────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;

export interface TaskTranscriptProps {
  /** Task run whose events are previewed. */
  taskRunId: string;
  /** Data source; the shell wires it to the session bridge. */
  loader: TaskRunEventsLoader;
  /** Resolved dark appearance for syntax highlighting. */
  dark: boolean;
  /** External-link opener for markdown content. */
  onOpenExternal: (href: string) => void;
  className?: string;
}

/**
 * Self-loading task transcript for in-shell previews: pulls the event pages
 * through `loader`, keeps polling `next_seq` while the run is live, and ends
 * polling when the run reports a terminal status. Rendered through
 * {@link TaskTranscriptStream}.
 */
export function TaskTranscript({ taskRunId, loader, dark, onOpenExternal, className }: TaskTranscriptProps): ReactElement {
  const [events, setEvents] = useState<SafeTranscriptEventData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadingRef = useRef(true);
  loadingRef.current = loading;

  useEffect(() => {
    if (taskRunId === '') {
      setLoading(false);
      setError('Missing task_run_id');
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextSeq: number | undefined;
    const tick = async (): Promise<void> => {
      try {
        const result = await loader.load(taskRunId, nextSeq);
        if (disposed) return;
        setLoading(false);
        setError(null);
        if (result.run !== undefined) {
          setLive(!TERMINAL_RUN_STATUSES.has(result.run.status));
        }
        if (result.events.length > 0) setEvents((current) => [...current, ...result.events]);
        nextSeq = result.next_seq;
        const terminal = result.run !== undefined && TERMINAL_RUN_STATUSES.has(result.run.status);
        if (!disposed && (result.has_more || !terminal)) {
          // Pages still draining come back immediately; a live run polls.
          timer = setTimeout(() => void tick(), result.has_more ? 0 : POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (disposed) return;
        if (loadingRef.current) {
          setLoading(false);
          setError(err instanceof Error ? err.message : String(err));
        } else {
          // A failed refresh keeps the loaded stream and retries later.
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      }
    };
    void tick();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [taskRunId, loader, nonce]);

  const retry = useCallback((): void => {
    setError(null);
    setLoading(true);
    void loader.retry(taskRunId).catch(() => undefined);
    setNonce((value) => value + 1);
  }, [loader, taskRunId]);

  return (
    <TaskTranscriptStream
      events={events}
      live={live}
      loading={loading}
      error={error}
      onRetry={taskRunId === '' ? undefined : retry}
      dark={dark}
      onOpenExternal={onOpenExternal}
      className={className}
    />
  );
}
