import { ConversationActivityView } from './conversation-activity.js';
import type {
  ConversationItemSnapshot,
  ConversationModelOptionSnapshot,
  ConversationSnapshot,
  ConversationTurnSnapshot,
  ProviderModelSnapshot,
  QuotaSnapshot,
  TaskRunSnapshot,
  WrenyardShellApi,
} from '../shell-contract.js';
import {
  conversationProviderPresentation,
  type ConversationProviderPresentation,
} from './conversation-provider-status.js';
import { formatCompactTokenCount } from './format.js';
import { SearchableSingleSelect, bindThemedTooltip, hideThemedTooltip } from './single-select.js';
import { brandIcon } from './brand-icons.js';
import { providerBrand, classifyFamily, familyBrand } from './model-list.js';
import { createAgentTaskStatusIcon } from './agent-task-icon.js';

/** Shared token formatter re-exported for conversation stats; never a second copy. */
export { formatCompactTokenCount };

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing conversation element: ${id}`);
  return value as T;
}

function formatTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatSessionTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(value);
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

/**
 * Splits a ` · `-joined provider presentation tooltip into short readable
 * lines: provider label and quota status stay on one line, every concrete
 * window/balance/message detail gets its own line.
 */
function tooltipLines(presentation: string): string[] {
  const parts = presentation.split(' · ').filter(Boolean);
  if (parts.length < 2) return parts;
  return [parts.slice(0, 2).join(' · '), ...parts.slice(2)];
}

/**
 * Basename of a configured workspace path for the sidebar label. Handles both
 * POSIX (`/a/b/c`) and Windows (`C:\\a\\b`, `\\\\server\\share\\dir`) separators,
 * tolerates a trailing separator, and never falls back to the raw full path
 * when no separator is present.
 */
export function workspaceDisplayName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/u, '');
  if (!trimmed) return path.trim();
  const segments = trimmed.split(/[\\/]+/u);
  return segments[segments.length - 1] || trimmed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  return String(error);
}

/** Local wall-clock stamp for the user message corner. */
function formatClockTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/** Whole-second duration between two observed event times. */
function elapsedSeconds(startedAt: number, endedAt: number): number | undefined {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
  const delta = endedAt - startedAt;
  if (delta < 0) return undefined;
  return Math.round(delta / 1_000);
}

/** Chinese duration label ("打造了 2m 05s") with bounded precision. */
export function formatTurnDuration(seconds: number): string {
  const bounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(bounded / 60);
  const rest = bounded % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

/** Collapsed activity summary for a finished turn; absent timing is not invented. */
export function turnCompletionLabel(turn: ConversationTurnSnapshot): string {
  if (turn.endedAt === undefined) return '完成';
  const seconds = elapsedSeconds(turn.startedAt, turn.endedAt);
  return seconds === undefined ? '完成' : `打造了 ${formatTurnDuration(seconds)}`;
}

/** Shared token formatter re-exported for conversation stats; never a second copy. */

export const CONVERSATION_PLACEHOLDERS = [
  '给工坊派个活儿…',
  '今天从哪件小事开始…',
  '把想法放到工作台上…',
  '搭档已就位，说件事吧…',
  '灯亮着，交代点活计…',
  '图纸铺开，等你一句话…',
  '车间安静，就等你开口…',
  '说说这次想折腾点什么…',
  '工具摆好了，听你安排…',
  '想修点什么，还是做点新的…',
  '把任务轻轻放在台上…',
  '开工前，先说个大概…',
  '小锤子待命，听你安排…',
  '这盏灯下，聊点正事…',
  '灵感来了就往这儿写…',
  '给搭档递个话…',
  '工作台擦干净了，开始吧…',
  '先描述问题，其余慢慢来…',
  '灯下说件正经事…',
  '今天的工单，由你来写…',
  '把难题放到工坊看看…',
  '说一说这次的目标…',
  '写代码也好，聊方案也好…',
  '这边坐，慢慢说清楚…',
] as const;

export function pickConversationPlaceholder(
  previous: string | undefined,
  random: () => number = Math.random,
): string {
  const raw = random();
  const bounded = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.9999999999999999) : 0;
  let index = Math.floor(bounded * CONVERSATION_PLACEHOLDERS.length);
  if (CONVERSATION_PLACEHOLDERS[index] === previous) {
    index = (index + 1) % CONVERSATION_PLACEHOLDERS.length;
  }
  return CONVERSATION_PLACEHOLDERS[index];
}

let lastConversationPlaceholder: string | undefined;

function nextConversationPlaceholder(): string {
  lastConversationPlaceholder = pickConversationPlaceholder(lastConversationPlaceholder);
  return lastConversationPlaceholder;
}

export function conversationModelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

export function parseConversationModelValue(value: string): { provider: string; model: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== 'string' || !part)) return null;
    return { provider: parsed[0], model: parsed[1] };
  } catch {
    return null;
  }
}

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  nextIndex: number;
}

function markdownTableCells(line: string): string[] | null {
  const source = line.trim();
  if (!source.includes('|')) return null;
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  let inCode = false;
  for (const character of source) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      cell += character;
      continue;
    }
    if (character === '`') inCode = !inCode;
    if (character === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  if (source.startsWith('|')) cells.shift();
  if (source.endsWith('|')) cells.pop();
  return cells.length > 0 ? cells : null;
}

export function parseMarkdownTable(lines: readonly string[], startIndex: number): MarkdownTable | null {
  const headers = markdownTableCells(lines[startIndex] ?? '');
  const delimiter = markdownTableCells(lines[startIndex + 1] ?? '');
  if (!headers || !delimiter || headers.length !== delimiter.length
    || delimiter.some((cell) => !/^:?-{3,}:?$/u.test(cell))) return null;
  const rows: string[][] = [];
  let nextIndex = startIndex + 2;
  for (; nextIndex < lines.length; nextIndex += 1) {
    if (!(lines[nextIndex] ?? '').trim()) break;
    const row = markdownTableCells(lines[nextIndex] ?? '');
    if (!row) break;
    rows.push(headers.map((_, index) => row[index] ?? ''));
  }
  return { headers, rows, nextIndex };
}

export function isMarkdownHorizontalRule(line: string): boolean {
  const compact = line.trim().replace(/\s/gu, '');
  return /^(?:-{3,}|\*{3,}|_{3,})$/u.test(compact);
}

export interface ConversationRenderGroup {
  kind: 'item' | 'assistant-turn';
  items: ConversationItemSnapshot[];
  /** Stable group identity: the DSH turn id, or the single item id. */
  id: string;
  /** Turn boundary/usage metadata when the snapshot carried it for this turn. */
  turn?: ConversationTurnSnapshot;
}

export function groupConversationItems(items: readonly ConversationItemSnapshot[]): ConversationRenderGroup[] {
  const groups: ConversationRenderGroup[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (item && item.turnId && (item.kind === 'assistant' || item.kind === 'tool')) {
      const turnItems: ConversationItemSnapshot[] = [];
      while (index < items.length) {
        const candidate = items[index];
        if (!candidate || candidate.turnId !== item.turnId
          || (candidate.kind !== 'assistant' && candidate.kind !== 'tool')) break;
        turnItems.push(candidate);
        index += 1;
      }
      groups.push({ kind: 'assistant-turn', items: turnItems, id: item.turnId });
      continue;
    }
    if (item) groups.push({ kind: 'item', items: [item], id: item.id });
    index += 1;
  }
  return groups;
}

/**
 * Latest observed item for a turn. `finalItemId` from the turn snapshot wins
 * when it is still present in the group. Only a completed turn with a known
 * `finalItemId` exposes a final body; the legacy fallback picks the last
 * assistant item and never a tool item, so raw tool arguments can never be
 * rendered as the answer.
 */
export function conversationTurnFinalItem(
  group: ConversationRenderGroup,
): ConversationItemSnapshot | undefined {
  const preferred = group.turn?.finalItemId;
  if (preferred) {
    const match = group.items.find((item) => item.id === preferred);
    return match && match.kind === 'assistant' ? match : undefined;
  }
  if (!group.turn && !group.items.some((item) => item.running)) {
    for (let index = group.items.length - 1; index >= 0; index -= 1) {
      const item = group.items[index];
      if (item && item.kind === 'assistant') return item;
    }
  }
  return undefined;
}

export interface ConversationGroupStatus {
  /** Latest non-empty assistant progress text inside the turn. */
  latest: string;
  /** Newest Chinese tool summary observed for a running step. */
  toolSummary?: string;
  /** Turn body signature; an unchanged signature must not be re-rendered. */
  signature: string;
}

/** Text shown in the collapsed summary: preferred id first, then the last progress text. */
export function conversationTurnLatestProgress(
  group: ConversationRenderGroup,
  preferredId?: string,
): string {
  const preferred = preferredId ? group.items.find((item) => item.id === preferredId) : undefined;
  if (preferred && preferred.text.trim()) return preferred.text.trim();
  for (let index = group.items.length - 1; index >= 0; index -= 1) {
    const item = group.items[index];
    if (item && item.kind === 'assistant' && item.text.trim()) return item.text.trim();
  }
  return '';
}

export function conversationGroupStatus(
  group: ConversationRenderGroup,
  preferredId?: string,
): ConversationGroupStatus {
  const body = conversationGroupBodySignature(group);
  let toolSummary: string | undefined;
  for (let index = group.items.length - 1; index >= 0; index -= 1) {
    const item = group.items[index];
    if (item && item.kind === 'tool' && item.toolState === 'running' && item.toolSummary) {
      toolSummary = item.toolSummary;
      break;
    }
  }
  const latest = conversationTurnLatestProgress(group, preferredId);
  const signature = [
    body,
    latest,
    toolSummary ?? '',
    group.turn ? conversationTurnTimingSignature(group.turn) : '',
  ].join('\u0000');
  return { latest, ...(toolSummary ? { toolSummary } : {}), signature };
}

/**
 * True when a turn must keep its existing DOM nodes. A running group is kept
 * while nothing observable changed (the elapsed clock ticks itself); a
 * completed group is kept only once its completion transition and body have
 * settled, so an awaited turn and any real change still rebuild.
 */
export function shouldPreserveTurnNodes(options: {
  running: boolean;
  signatureChanged: boolean;
  completionChanged: boolean;
  nodesConnected: boolean;
  awaiting: boolean;
}): boolean {
  if (!options.nodesConnected) return false;
  if (options.awaiting) return false;
  if (options.running) return !options.signatureChanged;
  return !options.signatureChanged && !options.completionChanged;
}

export function conversationTurnRunning(group: ConversationRenderGroup): boolean {
  return group.turn ? group.turn.running : group.items.some((item) => item.running === true);
}

/** Aggregate observed step/usage metadata, omitting anything DSH never supplied. */
export interface ConversationTurnStatLine {
  label: string;
  value: string;
}

export function buildConversationTurnStatLines(turn: ConversationTurnSnapshot): ConversationTurnStatLine[] {
  const lines: ConversationTurnStatLine[] = [];
  if (turn.inputTokens !== undefined || turn.outputTokens !== undefined) {
    lines.push({
      label: 'TOKEN',
      value: `输入 ${turn.inputTokens !== undefined ? formatCompactTokenCount(turn.inputTokens) : '—'}`
        + ` / 输出 ${turn.outputTokens !== undefined ? formatCompactTokenCount(turn.outputTokens) : '—'}`,
    });
  }
  if (turn.outputTps !== undefined && Number.isFinite(turn.outputTps)) {
    lines.push({ label: 'TPS', value: `${Math.round(turn.outputTps * 10) / 10} tok/s` });
  }
  lines.push({ label: '派发', value: `${turn.dispatchCount} 次` });
  if (turn.endedAt !== undefined) {
    const seconds = elapsedSeconds(turn.startedAt, turn.endedAt);
    if (seconds !== undefined) lines.push({ label: '耗时', value: formatTurnDuration(seconds) });
  }
  return lines;
}

/** Observed timing/usage signature of a turn; drives the footer stat lines. */
function conversationTurnTimingSignature(turn: ConversationTurnSnapshot): string {
  return [
    turn.startedAt,
    turn.endedAt ?? '',
    turn.running ? 1 : 0,
    turn.finalItemId ?? '',
    turn.progressItemId ?? '',
    turn.pendingTaskCount ?? '',
    turn.dispatchCount,
    turn.inputTokens ?? '',
    turn.outputTokens ?? '',
    turn.outputTps ?? '',
  ].join(':');
}

/**
 * The stop control belongs to the running user message and is derived from the
 * turn snapshot as well as the item, so an optimistic user item still exposes
 * a cancel affordance while its turn is running.
 */
export function userItemRunning(item: ConversationItemSnapshot, turn?: ConversationTurnSnapshot): boolean {
  if (turn?.running) return true;
  return item.running === true;
}

function conversationItemSignature(item: ConversationItemSnapshot): string {
  return [
    item.id,
    item.kind,
    item.running ? 1 : 0,
    item.toolState ?? '',
    item.toolName ?? '',
    item.step ?? '',
    item.toolSummary ?? '',
    String(item.time),
    item.text,
    item.toolResultText ?? '',
    item.taskRun?.taskRunId ?? '',
    item.taskRun?.status ?? '',
    item.taskRun?.taskName ?? '',
    item.documentLinks?.map((link) => `${link.title}\u0004${link.path}`).join('\u0005') ?? '',
  ].join('\u0001');
}

/** Turn body only (item identities + texts), unaffected by live feed growth. */
function conversationGroupBodySignature(group: ConversationRenderGroup): string {
  return group.items.map(conversationItemSignature).join('\u0002');
}

/**
 * Everything one turn render depends on: its body, the collapsed progress /
 * tool label and its observed timing. The elapsed clock text is deliberately
 * excluded so a running turn is not rebuilt on every one-second tick.
 */
function conversationGroupSignature(group: ConversationRenderGroup, running = conversationTurnRunning(group)): string {
  return [
    conversationGroupBodySignature(group),
    conversationTurnLatestProgress(group, group.turn?.finalItemId),
    conversationGroupStatus(group, group.turn?.finalItemId).toolSummary ?? '',
    group.turn ? conversationTurnTimingSignature(group.turn) : '',
    running ? '1' : '0',
  ].join('\u0000');
}

interface OrderedNodeHost {
  children: ArrayLike<unknown>;
  insertBefore(node: unknown, reference: unknown): unknown;
  removeChild(node: unknown): unknown;
}

/**
 * Reconcile the desired ordered nodes into the feed in place: undesired nodes
 * are removed and desired nodes are moved/inserted only as far as their target
 * position requires, so a node already in place is never rebuilt.
 */
export function reconcileOrderedNodes(container: OrderedNodeHost, desired: readonly unknown[]): void {
  const wanted = new Set<unknown>(desired);
  for (const child of Array.from(container.children)) {
    if (!wanted.has(child)) container.removeChild(child);
  }
  desired.forEach((node, index) => {
    const child = container.children[index];
    if (child === node) return;
    container.insertBefore(node, child ?? null);
  });
}

/** Independent one-second elapsed clock; ticks are monotonic and non-accumulating. */
export function nextElapsedTickDelay(now: number, lastTickAt: number, interval = 1_000): number {
  const remainder = (now - lastTickAt) % interval;
  const aligned = remainder === 0 ? interval : interval - remainder;
  return Math.max(16, aligned);
}

/** Per-turn render state retained between feed updates (also feeds the timer). */
interface TurnRenderPreferences {
  article?: HTMLElement;
  body?: HTMLElement;
  summary?: HTMLElement;
  footer?: HTMLElement;
  stats?: HTMLElement;
  statsSignature?: string;
  finalItem?: ConversationItemSnapshot;
  turn?: ConversationTurnSnapshot;
  running?: boolean;
  open?: boolean;
  completed?: boolean;
  manualExpanded?: boolean;
  /** Real start time of the running step, used by the independent clock. */
  startedAt?: number;
  /** True while the running group's elapsed clock is scheduled. */
  clocking?: boolean;
}

export function shouldFollowConversationTail(options: { sessionChanged: boolean; wasPinned: boolean }): boolean {
  return options.sessionChanged || options.wasPinned;
}

export interface ConversationScrollAnchor {
  id: string;
  offset: number;
}

export interface RestoreConversationScrollTopOptions {
  followTail: boolean;
  scrollTop: number;
  anchorId?: string;
  capturedOffset?: number;
  anchors: ConversationScrollAnchor[];
  maximum: number;
}

/**
 * Restores the conversation feed scroll position after a streaming rerender.
 * A pinned / session-followed view returns to the bottom (`maximum`); otherwise
 * the previously captured visible anchor is located again in the rebuilt feed
 * and its offset delta is applied to the prior scroll top, clamped into range.
 * When no matching anchor survives the rebuild, the clamped prior scroll top
 * is kept.
 */
export function restoreConversationScrollTop(options: RestoreConversationScrollTopOptions): number {
  const clamp = (value: number): number => Math.max(0, Math.min(value, Math.max(0, options.maximum)));
  if (options.followTail) return Math.max(0, options.maximum);
  if (options.anchorId !== undefined && options.capturedOffset !== undefined) {
    const anchor = (options.anchors ?? []).find((candidate) => candidate.id === options.anchorId);
    if (anchor !== undefined) return clamp(options.scrollTop + anchor.offset - options.capturedOffset);
  }
  return clamp(options.scrollTop);
}

interface ModelPickerEntry extends ConversationModelOptionSnapshot {
  value: string;
  current: boolean;
  advertised: boolean;
}

function appendInlineMarkdown(target: HTMLElement, text: string): void {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      target.append(code);
    } else if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      target.append(strong);
    } else {
      target.append(document.createTextNode(part));
    }
  }
}

export function renderRichText(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('```') && part.endsWith('```')) {
      const firstLine = part.indexOf('\n');
      const code = firstLine === -1 ? part.slice(3, -3) : part.slice(firstLine + 1, -3);
      const pre = document.createElement('pre');
      const codeElement = document.createElement('code');
      codeElement.textContent = code.trimEnd();
      pre.append(codeElement);
      fragment.append(pre);
      continue;
    }
    const lines = part.split('\n');
    let paragraph: HTMLParagraphElement | undefined;
    let list: HTMLUListElement | HTMLOListElement | undefined;
    const flush = (): void => { paragraph = undefined; list = undefined; };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      if (!line.trim()) {
        flush();
        continue;
      }
      const markdownTable = parseMarkdownTable(lines, lineIndex);
      if (markdownTable) {
        const table = document.createElement('table');
        const head = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const value of markdownTable.headers) {
          const cell = document.createElement('th');
          appendInlineMarkdown(cell, value);
          headerRow.append(cell);
        }
        head.append(headerRow);
        const body = document.createElement('tbody');
        for (const values of markdownTable.rows) {
          const row = document.createElement('tr');
          for (const value of values) {
            const cell = document.createElement('td');
            appendInlineMarkdown(cell, value);
            row.append(cell);
          }
          body.append(row);
        }
        table.append(head, body);
        fragment.append(table);
        lineIndex = markdownTable.nextIndex - 1;
        flush();
        continue;
      }
      if (isMarkdownHorizontalRule(line)) {
        fragment.append(document.createElement('hr'));
        flush();
        continue;
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        const h = document.createElement(heading[1].length === 1 ? 'h2' : 'h3');
        h.textContent = heading[2];
        fragment.append(h);
        flush();
        continue;
      }
      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      if (bullet) {
        if (!list || list.tagName !== 'UL') {
          list = document.createElement('ul');
          fragment.append(list);
        }
        const item = document.createElement('li');
        appendInlineMarkdown(item, bullet[1]);
        list.append(item);
        paragraph = undefined;
        continue;
      }
      const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      if (numbered) {
        if (!list || list.tagName !== 'OL') {
          list = document.createElement('ol');
          fragment.append(list);
        }
        const item = document.createElement('li');
        appendInlineMarkdown(item, numbered[1]);
        list.append(item);
        paragraph = undefined;
        continue;
      }
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        const blockquote = document.createElement('blockquote');
        appendInlineMarkdown(blockquote, quote[1]);
        fragment.append(blockquote);
        flush();
        continue;
      }
      if (!paragraph) {
        paragraph = document.createElement('p');
        fragment.append(paragraph);
      } else {
        paragraph.append(document.createElement('br'));
      }
      appendInlineMarkdown(paragraph, line);
      list = undefined;
    }
  }
  return fragment;
}

export interface TaskRunSummaryLine {
  label: string;
  value: string;
}

/**
 * Builds the truthful terminal consumption summary for a resolved run_task card.
 * Missing numerics render as 未知; a real numeric zero is preserved so it still
 * shows. The selection speed (when present) is labeled distinctly from the
 * measured output TPS.
 */
export function buildTaskRunSummaryLines(taskRun: TaskRunSnapshot): TaskRunSummaryLine[] {
  const lines: TaskRunSummaryLine[] = [];
  const model = taskRun.resolvedModel ?? taskRun.resolvedProfile ?? '模型未知';
  lines.push({ label: '模型 / 配置', value: model });

  const usage = taskRun.usage;
  if (usage.totalTokens !== undefined || usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    const detail = usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? `（输入 ${usage.inputTokens ?? '未知'} / 输出 ${usage.outputTokens ?? '未知'}）`
      : '';
    lines.push({ label: '消耗 TOKEN', value: `${usage.totalTokens ?? '未知'}${detail}` });
  } else {
    lines.push({ label: '消耗 TOKEN', value: '未知' });
  }

  lines.push({ label: 'TPS', value: usage.outputTps !== undefined ? String(usage.outputTps) : '未知' });
  lines.push({
    label: '参考费用（估算）',
    value: usage.referenceCostUsd !== undefined ? `$${usage.referenceCostUsd.toFixed(4)}` : '未知',
  });
  lines.push({ label: '尝试次数', value: String(usage.attemptCount) });

  if (usage.completeness === 'partial') lines.push({ label: '成本完整性', value: '部分' });
  else if (usage.completeness === 'unavailable') lines.push({ label: '成本完整性', value: '不可用' });

  if (taskRun.speed) {
    const speedSources = {
      local_31d: '本机 31 天',
      provider_override: '服务商覆盖',
      catalog_default: '目录默认',
    } as const;
    lines.push({ label: '选择速度（估算）', value: `${taskRun.speed.effectiveTps}（来源：${speedSources[taskRun.speed.source]}）` });
  }

  return lines;
}

export class ConversationView {
  private readonly api: WrenyardShellApi;
  private readonly activity: ConversationActivityView;
  private readonly openSettings: () => void;
  private readonly feed = element<HTMLElement>('conversation-feed');
  private readonly sessionList = element<HTMLElement>('conversation-session-list');
  private readonly input = element<HTMLTextAreaElement>('conversation-input');
  private readonly sendButton = element<HTMLButtonElement>('conversation-send');
  private readonly modelPickerHost = element<HTMLElement>('conversation-model-picker');
  private readonly modelSelect: SearchableSingleSelect;
  private readonly reasoningSelect: HTMLSelectElement;
  private readonly error = element<HTMLElement>('conversation-error');
  private readonly gate = element<HTMLElement>('workspace-gate');
  private readonly gateMode = element<HTMLSelectElement>('workspace-gate-mode');
  private readonly gateInput = element<HTMLInputElement>('workspace-gate-input');
  private readonly gateHint = element<HTMLElement>('workspace-gate-hint');
  private readonly gateError = element<HTMLElement>('workspace-gate-error');
  private snapshot: ConversationSnapshot | undefined;
  private readonly expandedItemIds = new Set<string>();
  /** Per-feed live update sequence; lets scroll restoring ignore stale deltas. */
  private feedUpdateSequence = 0;
  private refreshing = false;
  private refreshQueued = false;
  private busy = false;
  private workspaceSaving = false;
  private quotaSnapshot: QuotaSnapshot | undefined;
  private modelEntries: ModelPickerEntry[] = [];
  private modelCategories = new Map<string, ConversationProviderPresentation>();
  // Live feed state. Nodes are keyed by session + group id so an unchanged
  // completed turn keeps its actual DOM nodes across streaming deltas
  // (the reconciled order removes replaced nodes instead of appending copies).
  private feedNodes: HTMLElement[] = [];
  private readonly turnPreferences = new Map<string, TurnRenderPreferences>();
  private readonly groupCompleted = new Map<string, boolean>();
  private readonly groupSignatures = new Map<string, string>();
  private readonly itemSignatures = new Map<string, string>();
  private renderedSessionId: string | undefined;
  private feedEmpty = true;
  private waitingNode: HTMLElement | undefined;
  private autoFollow = true;
  private readonly followTimers = new Map<number, number>();
  private timerTimeout: number | undefined;
  private timerLastTickAt = 0;
  private feedListenersBound = false;

  constructor(api: WrenyardShellApi, openSettings: () => void) {
    this.api = api;
    this.activity = new ConversationActivityView(api, () => { if (this.snapshot) this.render(this.snapshot); });
    this.openSettings = openSettings;
    this.modelSelect = new SearchableSingleSelect(this.modelPickerHost, {
      label: '会话模型',
      placeholder: '读取模型…',
      onChange: (value) => void this.selectModel(value),
    });
    this.reasoningSelect = document.createElement('select');
    this.reasoningSelect.className = 'conversation-reasoning-select';
    this.reasoningSelect.setAttribute('aria-label', '思考强度');
    this.reasoningSelect.hidden = true;
    this.reasoningSelect.addEventListener('change', () => void this.selectReasoningEffort(this.reasoningSelect.value));
    // The reasoning control belongs before the model trigger in the same host,
    // so the DOM order matches the picker order; it is the existing control,
    // only repositioned.
    this.modelPickerHost.prepend(this.reasoningSelect);
    element('new-conversation-button').addEventListener('click', () => void this.create());
    this.sendButton.addEventListener('click', () => void this.send());
    element('workspace-open-settings').addEventListener('click', openSettings);
    element('workspace-quick-save').addEventListener('click', () => void this.saveWorkspace());
    this.gateMode.addEventListener('change', () => this.applyGateMode());
    this.input.addEventListener('input', () => this.resizeComposer());
    this.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void this.send();
    });
    this.api.onConversationChanged(() => void this.refresh());
    this.rotateConversationPlaceholder();
  }

  start(): void {
    void this.refresh();
  }

  setQuotaSnapshot(snapshot: QuotaSnapshot): void {
    this.quotaSnapshot = snapshot;
    this.modelCategories.clear();
    if (this.snapshot) this.renderModels(this.snapshot);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      this.render(await this.api.getConversation());
    } catch (error) {
      this.showError(errorMessage(error));
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private render(snapshot: ConversationSnapshot): void {
    const sessionChanged = snapshot.selectedSessionId !== this.snapshot?.selectedSessionId;
    const workspaceChanged = snapshot.workspace.path !== this.snapshot?.workspace.path;
    const gateWasHidden = this.gate.hidden;
    const previousScrollTop = this.feed.scrollTop;
    const previousMaximum = Math.max(0, this.feed.scrollHeight - this.feed.clientHeight);
    this.autoFollow = previousMaximum - previousScrollTop < 120;
    this.captureExpandedItems();
    if (sessionChanged) {
      this.expandedItemIds.clear();
      this.resetFeed();
    }
    this.snapshot = snapshot;
    const ready = snapshot.status === 'ready';
    const workspaceLabel = element('conversation-workspace');
    const workspacePath = snapshot.workspace.path?.trim();
    workspaceLabel.textContent = workspacePath ? workspaceDisplayName(workspacePath) : '未绑定工作区';
    workspaceLabel.title = workspacePath ? workspacePath : '尚未绑定工作区';
    element('conversation-title').textContent = snapshot.selectedTitle ?? '新会话';

    this.renderModels(snapshot);
    this.renderSessions(snapshot);
    this.renderItems(this.activity.enrich(snapshot));
    this.gate.hidden = snapshot.status !== 'workspace-required';
    if (!this.gate.hidden) {
      if (gateWasHidden || workspaceChanged) this.gateInput.value = snapshot.workspace.path ?? '';
      element('workspace-gate-message').textContent = snapshot.message ?? '会话必须绑定一个 Wrenyard workspace。';
      const workspaceFromEnvironment = snapshot.workspace.source === 'environment';
      this.gateInput.readOnly = workspaceFromEnvironment;
      this.gateInput.setAttribute('aria-readonly', String(workspaceFromEnvironment));
      this.gateMode.disabled = workspaceFromEnvironment || this.workspaceSaving;
      const quickSave = element<HTMLButtonElement>('workspace-quick-save');
      quickSave.disabled = workspaceFromEnvironment || this.workspaceSaving;
      this.applyGateMode();
    }
    const canPrompt = ready && snapshot.models.routable !== false;
    this.input.disabled = !canPrompt;
    // A turn in flight never blocks typing or sending: concurrent turns are
    // allowed, so only readiness and the trimmed draft gate the send icon.
    this.syncSendState();
    if (snapshot.status === 'unavailable') this.showError(snapshot.message ?? 'DSH 会话后端暂时不可用');
    else if (ready && snapshot.message) this.showError(snapshot.message);
    else if (snapshot.models.routable === false) this.showError('当前模型暂时不可用，请切换到其他模型');
    else if (snapshot.models.status === 'error') this.showError(snapshot.models.message ?? '模型目录暂时不可用');
    else this.hideError();

    if (sessionChanged) {
      // applyFeedOrder already equaled it; scroll to the newest content once.
      this.scrollToEnd();
      return;
    }
    // The order was already reconciled in place; only a pinned view (which the
    // reader has not scrolled away from since this update) is followed.
    if (this.autoFollow) this.scheduleFollow(previousMaximum);
  }

  private resetFeed(): void {
    for (const frame of this.followTimers.values()) cancelAnimationFrame(frame);
    this.followTimers.clear();
    if (this.timerTimeout !== undefined) window.clearTimeout(this.timerTimeout);
    this.timerTimeout = undefined;
    this.expandedItemIds.clear();
    this.groupCompleted.clear();
    this.groupSignatures.clear();
    this.itemSignatures.clear();
    this.turnPreferences.clear();
    this.feedNodes = [];
    this.feedEmpty = true;
    this.waitingNode = undefined;
    this.feed.replaceChildren();
  }

  private bindFeedListeners(): void {
    if (this.feedListenersBound) return;
    this.feedListenersBound = true;
    // Any real scroll (wheel or scrollbar drag) releases the follow, so a
    // reader who scrolled up or is selecting text is never yanked to the end.
    // A queued follow for an earlier update is dropped with it.
    const release = (): void => {
      this.autoFollow = false;
      this.cancelScheduledFollows();
    };
    this.feed.addEventListener('scroll', release, { passive: true });
    this.feed.addEventListener('wheel', release, { passive: true });
    // Releasing a selection restores following only when the view sits at the end.
    this.feed.addEventListener('pointerup', () => {
      const maximum = Math.max(0, this.feed.scrollHeight - this.feed.clientHeight);
      this.autoFollow = maximum - this.feed.scrollTop < 120;
    });
  }

  /**
   * Follow the growing tail. A delta can arrive while the reused nodes are
   * still being measured, so several frames are allowed; the reader's own
   * scroll after scheduling always cancels the move.
   */
  private scheduleFollow(previousMaximum: number): void {
    const sequence = this.feedUpdateSequence;
    const frame = requestAnimationFrame(() => {
      this.followTimers.delete(frame);
      const maximum = Math.max(0, this.feed.scrollHeight - this.feed.clientHeight);
      if (!this.autoFollow || this.feedUpdateSequence !== sequence) return;
      if (maximum !== previousMaximum) this.feed.scrollTop = maximum;

    });
    this.followTimers.set(frame, frame);
  }

  private cancelScheduledFollows(): void {
    for (const frame of this.followTimers.values()) cancelAnimationFrame(frame);
    this.followTimers.clear();
  }

  private scrollToEnd(): void {
    requestAnimationFrame(() => {
      const maximum = Math.max(0, this.feed.scrollHeight - this.feed.clientHeight);
      this.feed.scrollTop = maximum;
    });
  }

  /**
   * Reconcile the current ordered nodes into the feed. Nodes already in place
   * keep their DOM identity; replaced nodes, the welcome and a stale waiting
   * node are removed instead of piling up.
   */
  private applyFeedOrder(): void {
    const desired: HTMLElement[] = [...this.feedNodes];
    if (this.waitingNode) desired.push(this.waitingNode);
    reconcileOrderedNodes(this.feed, desired);
  }

  private renderItems(snapshot: ConversationSnapshot): void {
    this.bindFeedListeners();
    this.feedUpdateSequence += 1;
    if (this.renderedSessionId !== snapshot.selectedSessionId) {
      this.renderedSessionId = snapshot.selectedSessionId;
      this.feedNodes = [];
      this.groupCompleted.clear();
      this.groupSignatures.clear();
      this.turnPreferences.clear();
      this.feedEmpty = true;
      this.waitingNode = undefined;
    }
    if (snapshot.items.length === 0 && !snapshot.turns?.some((turn) => turn.running)) {
      if (this.feedEmpty) {
        // A brand-new empty session still shows the welcome; it must never be
        // left over from a previous session once real items arrived.
        if (this.feed.querySelector('.conversation-welcome')) return;
      }
      this.feedEmpty = true;
      this.feedNodes = [];
      this.waitingNode = undefined;
      const welcome = this.createWelcome();
      this.feed.replaceChildren(welcome);
      return;
    }
    this.feedEmpty = false;
    const groups = groupConversationItems(snapshot.items);
    const turns = new Map<string, ConversationTurnSnapshot>();
    for (const turn of snapshot.turns ?? []) turns.set(turn.id, turn);
    for (const group of groups) {
      if (group.kind === 'assistant-turn') {
        const turn = turns.get(group.id);
        if (turn) group.turn = turn;
        continue;
      }
      // A single item (the user message) also resolves its turn, so its stop
      // control follows a running turn snapshot even when the item itself was
      // only optimistically inserted.
      const item = group.items[0];
      const turn = item?.turnId ? turns.get(item.turnId) : undefined;
      if (turn) group.turn = turn;
    }
    // A running turn whose items have not arrived yet still renders its header
    // from the optimistic snapshot, so a turn never disappears into a bare
    // spinner while the model is being reached.
    const turnHasGroup = new Set(groups.filter((group) => group.kind === 'assistant-turn').map((group) => group.id));
    for (const turn of snapshot.turns ?? []) {
      if (!turn.running || turnHasGroup.has(turn.id)) continue;
      const userIndex = groups.findIndex((group) => group.kind === 'item'
        && group.items[0]?.kind === 'user' && group.items[0]?.turnId === turn.id);
      groups.splice(userIndex < 0 ? groups.length : userIndex + 1, 0,
        { kind: 'assistant-turn', items: [], id: turn.id, turn });
    }
    const hasRunningItem = snapshot.items.some((item) => item.running === true);
    const running = snapshot.selectedRunning || hasRunningItem;
    let waitingGroupIndex = -1;
    if (running && !hasRunningItem) {
      for (let index = groups.length - 1; index >= 0; index -= 1) {
        if (groups[index]?.kind === 'assistant-turn') {
          waitingGroupIndex = index;
          break;
        }
      }
    }
    this.feedNodes = [];
    groups.forEach((group, index) => {
      if (group.kind !== 'assistant-turn') {
        this.renderSingleItem(group);
        return;
      }
      const preferences = this.groupRenderPreferences(group.id);
      const runningTurn = conversationTurnRunning(group);
      const signature = conversationGroupSignature(group, runningTurn);
      const signatureChanged = this.groupSignatures.get(group.id) !== signature;
      if (group.turn) preferences.turn = group.turn;
      const wasCompleted = this.groupCompleted.get(group.id);
      const completionChanged = wasCompleted !== !runningTurn;
      if (wasCompleted === false && !runningTurn) this.expandedItemIds.delete(group.id);
      // The rendered signature is only committed on an actual (re)build: a
      // preserved turn keeps the previous value on purpose, but a real change
      // still rebuilds it instead of being silently swallowed.
      if (shouldPreserveTurnNodes({
        running: runningTurn,
        signatureChanged,
        completionChanged,
        nodesConnected: preferences.article?.isConnected === true,
        awaiting: index === waitingGroupIndex,
      })) {
        this.groupCompleted.set(group.id, !runningTurn);
        this.renderTurnStats(preferences);
        this.addExistingNode(preferences.article);
        return;
      }
      this.groupCompleted.set(group.id, !runningTurn);
      this.renderAssistantTurn(group, index === waitingGroupIndex, preferences, signature);
    });
    if (running && !hasRunningItem && waitingGroupIndex === -1) {
      if (!this.waitingNode) {
        const waiting = document.createElement('article');
        waiting.className = 'message message-assistant message-waiting';
        waiting.innerHTML = '<div class="message-body"><span class="thinking-dots"><i></i><i></i><i></i></span></div>';
        this.waitingNode = waiting;
      }
    } else {
      this.waitingNode = undefined;
    }
    this.applyFeedOrder();
    const active = groups.some((group) => group.kind === 'assistant-turn' && conversationTurnRunning(group));
    if (!active) this.stopTurnClock();
    else this.scheduleTurnClock();
  }

  private addExistingNode(node: HTMLElement | undefined): void {
    if (!node) return;
    this.feedNodes.push(node);
  }

  private createWelcome(): HTMLElement {
    const welcome = document.createElement('div');
    welcome.className = 'conversation-welcome';
    const image = document.createElement('img');
    image.src = './icon-256.png';
    image.alt = '';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = 'THE WRENYARD WORKSHOP';
    const title = document.createElement('h2');
    title.textContent = '今天想让工坊做些什么？';
    welcome.append(image, eyebrow, title);
    return welcome;
  }

  private groupRenderPreferences(groupId: string): TurnRenderPreferences {
    let preferences = this.turnPreferences.get(groupId);
    if (!preferences) {
      preferences = {};
      this.turnPreferences.set(groupId, preferences);
    }
    return preferences;
  }

  /** Append or update the streaming single item (tool item or standalone assistant). */
  private renderSingleItem(group: ConversationRenderGroup): void {
    const item = group.items[0];
    if (!item) return;
    const preferences = this.groupRenderPreferences(group.id);
    // A running change comes from the turn snapshot too, so it is part of the
    // item signature: the stop control must appear/disappear with the turn.
    const signature = conversationItemSignature(item) + '\u0006' + (userItemRunning(item, group.turn) ? '1' : '0');
    if (this.itemSignatures.get(group.id) === signature && preferences.article?.isConnected) {
      this.addExistingNode(preferences.article);
      this.syncStreamingCursor(preferences.article, item);
      return;
    }
    this.itemSignatures.set(group.id, signature);
    const node = this.renderItem(item, preferences, group.turn);
    preferences.article = node;
    this.feedNodes.push(node);
  }

  private renderItem(
    item: ConversationItemSnapshot,
    preferences: TurnRenderPreferences,
    turn?: ConversationTurnSnapshot,
  ): HTMLElement {
    if (item.kind === 'tool') {
      const tool = this.renderToolItem(item, preferences);
      tool.dataset.scrollId = item.id;
      return tool;
    }
    if (item.kind === 'assistant') {
      return this.renderAssistantTurn(
        { kind: 'assistant-turn', items: [item], id: item.id, ...(turn ? { turn } : {}) },
        false,
        preferences,
      );
    }
    const running = userItemRunning(item, turn);
    const article = document.createElement('article');
    article.className = 'message message-' + item.kind + (running ? ' is-streaming' : '');
    article.dataset.scrollId = item.id;
    const body = document.createElement('div');
    body.className = 'message-body';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    const content = document.createElement('div');
    content.className = 'message-content';
    content.append(renderRichText(item.text));
    // The user message carries no avatar; its stamp sits inside the bubble.
    const time = document.createElement('time');
    time.className = 'message-time';
    time.textContent = formatClockTime(item.time);
    bubble.append(content, time);
    body.append(bubble);
    // The stop control sits to the right of the bubble, never under the stamp.
    if (running && item.turnId) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'message-stop';
      stop.setAttribute('aria-label', '停止生成');
      stop.title = '停止生成';
      stop.innerHTML = '<span></span>';
      stop.addEventListener('click', () => void this.cancel(item.turnId));
      article.append(stop);
    }
    article.append(body);
    return article;
  }

  /**
   * One assistant turn: a collapsed working-process block plus the final body.
   * The process block is collapsed by default in every state; only the final
   * item's Markdown is parsed, step labels stay plain text and each detail body
   * (full step text, tool result) is materialized lazily on first expand.
   */
  private renderAssistantTurn(
    group: ConversationRenderGroup,
    waiting: boolean,
    preferences: TurnRenderPreferences,
    signature = conversationGroupSignature(group, conversationTurnRunning(group)),
  ): HTMLElement {
    const finalItem = conversationTurnFinalItem(group);
    const summaryItem = finalItem ?? group.items.find((item) => item.kind === 'assistant' && item.id === group.turn?.progressItemId);
    if (finalItem) preferences.finalItem = finalItem;
    const running = conversationTurnRunning(group);
    preferences.running = running;
    preferences.startedAt = running ? this.turnStartedAt(group) : undefined;

    const article = document.createElement('article');
    article.className = 'message message-assistant';
    article.dataset.turnId = group.id;
    article.dataset.scrollId = group.id;
    const body = document.createElement('div');
    body.className = 'message-body';
    const details = document.createElement('details');
    details.className = 'turn-activity' + (running ? ' is-running' : '');
    this.bindTurnExpandedState(details, group.id, preferences);
    // Default collapsed in every state; only an explicit reader expansion opens it.
    details.open = this.expandedItemIds.has(group.id);

    const summary = document.createElement('summary');
    summary.className = 'turn-activity-summary';
    const summaryText = document.createElement('span');
    summaryText.className = 'turn-activity-text' + (running ? ' turn-activity-clock' : '');
    // Internal execution stays inside the disclosure; summaries sit below it.
    summaryText.textContent = running
      ? `打造了 ${formatTurnDuration(elapsedSeconds(this.turnStartedAt(group), Date.now()) ?? 0)}`
      : this.completedLabel(group);
    const summaryChevron = document.createElement('span');
    summaryChevron.className = 'turn-activity-chevron';
    summaryChevron.setAttribute('aria-hidden', 'true');
    summaryChevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
    summary.append(summaryText, summaryChevron);

    const backlog = document.createElement('div');
    backlog.className = 'turn-activity-steps';
    const processItems = group.items.filter((item) => !summaryItem || item.id !== summaryItem.id).sort((a, b) => a.time - b.time);
    for (let index = 0; index < processItems.length;) {
      const item = processItems[index];
      if (item?.kind === 'assistant') {
        const prose = document.createElement('div');
        prose.className = 'message-content turn-assistant-prose';
        // The expanded work prose is never truncated; the process block is the
        // reader's own disclosure, so it shows every observed step line.
        prose.append(renderRichText(item.text.trim()));
        backlog.append(prose);
        index += 1;
        continue;
      }
      if (item?.kind === 'tool') {
        const row = document.createElement('div');
        row.className = 'turn-tool-row';
        const icons = document.createElement('div');
        icons.className = 'turn-tool-row-icons';
        const preview = document.createElement('div');
        preview.className = 'turn-tool-row-preview';
        while (processItems[index]?.kind === 'tool') {
          const tools: ConversationItemSnapshot[] = [];
          const category = this.toolCategory(processItems[index]!);
          while (processItems[index]?.kind === 'tool' && this.toolCategory(processItems[index]!) === category) {
            tools.push(processItems[index++]!);
          }
          icons.append(this.renderToolStack(tools, 'stack:', preview));
        }
        row.append(icons, preview);
        backlog.append(row);
        continue;
      }
      index += 1;
    }

    details.append(summary, backlog);
    body.append(details);
    // Owned task dispatches keep a distinct label list outside the process
    // block: every owned run (running or terminal) shows its task name with a
    // click-to-open task conversation link, even while the process is expanded.
    const taskItems = processItems.filter((item) => item.kind === 'tool' && item.taskRun?.taskRunId);
    const summaryRails = document.createElement('div');
    summaryRails.className = 'turn-task-summary-rails';
    summaryRails.hidden = taskItems.length === 0;
    const seenRuns = new Set<string>();
    for (const item of taskItems) {
      const runId = item.taskRun!.taskRunId;
      if (seenRuns.has(runId)) continue;
      seenRuns.add(runId);
      summaryRails.append(this.renderTaskSummaryLabel(item));
    }
    if (summaryItem) body.append(this.renderFinalContent(summaryItem, group, preferences));
    body.append(summaryRails);
    const footer = document.createElement('div');
    footer.className = 'message-footer';
    footer.hidden = running;
    if (finalItem && !running) footer.append(this.createCopyButton(finalItem.text));
    const stamp = document.createElement('time');
    stamp.className = 'message-time';
    const endedAt = group.turn?.endedAt;
    stamp.textContent = endedAt === undefined ? '' : formatClockTime(endedAt);
    stamp.hidden = endedAt === undefined;
    footer.append(stamp);
    body.append(footer);
    article.append(body);

    preferences.article = article;
    preferences.body = body;
    preferences.summary = summaryText;
    preferences.footer = footer;
    if (group.turn) preferences.turn = group.turn;
    this.groupSignatures.set(group.id, signature);
    this.itemSignatures.delete(group.id);
    this.feedNodes.push(article);
    if (!running) this.renderTurnStats(preferences);
    void waiting;
    return article;
  }

  private turnStartedAt(group: ConversationRenderGroup): number {
    if (group.turn) return group.turn.startedAt;
    const times = group.items.map((item) => item.time).filter((value) => Number.isFinite(value));
    return times.length > 0 ? Math.min(...times) : Date.now();
  }

  private completedLabel(group: ConversationRenderGroup): string {
    return group.turn ? turnCompletionLabel(group.turn) : '完成';
  }

  private toolCategory(item: ConversationItemSnapshot): string {
    if (item.taskRun || item.toolName === 'run_task' || item.toolName === 'task_run') return 'tasks';
    if (/search|doc|read/.test(item.toolName ?? '')) return 'docs-search';
    return 'other';
  }

  private toolIcon(item: ConversationItemSnapshot): HTMLSpanElement {
    const icon = document.createElement('span');
    icon.className = 'turn-tool-icon';
    icon.setAttribute('aria-hidden', 'true');
    const path = this.toolCategory(item) === 'tasks'
      ? '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>'
      : this.toolCategory(item) === 'docs-search' ? '<path d="M12 5v15M12 5C8 2 3 4 3 4v15s5-2 9 1c4-3 9-1 9-1V4s-5-2-9 1z"/>'
        : '<path d="M4 7h16M4 12h16M4 17h10"/>';
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${path}</svg>`;
    return icon;
  }

  private renderToolStack(items: ConversationItemSnapshot[], stackPrefix = 'stack:', previewHost?: HTMLElement): HTMLElement {
    const stack = document.createElement('div');
    stack.className = 'turn-tool-stack';
    const id = stackPrefix + items[0]!.id;
    stack.dataset.expandId = id;
    const viewport = document.createElement('div');
    viewport.className = 'turn-tool-viewport';
    const rail = document.createElement('div');
    rail.className = 'turn-tool-rail';
    const taskGroup = this.toolCategory(items[0]!) === 'tasks';
    // Task dispatches render as plain task-category tool icons here; the task
    // name text lives only in the label list outside the process block.
    const widths = items.map(() => 28);
    rail.style.setProperty('--collapsed-width', '32px');
    rail.style.setProperty('--expanded-width', `${widths.reduce((total, width) => total + width + 5, 0)}px`);
    const selected = document.createElement('div');
    selected.className = 'turn-tool-detail';
    const buttons: HTMLButtonElement[] = [];
    const clearDetail = (): void => {
      this.closeDescendants(selected);
      for (const item of items) this.expandedItemIds.delete(item.id);
      selected.replaceChildren();
      buttons.forEach((button) => button.setAttribute('aria-expanded', 'false'));
    };
    selected.addEventListener('clear-tool-preview', clearDetail);
    const select = (item: ConversationItemSnapshot, button: HTMLButtonElement, restoring = false): void => {
      const wasSelected = button.getAttribute('aria-expanded') === 'true';
      if (!restoring) clearDetail();
      if (wasSelected) return;
      for (const sibling of Array.from(previewHost?.children ?? [])) {
        if (sibling !== selected) sibling.dispatchEvent(new Event('clear-tool-preview'));
      }
      button.setAttribute('aria-expanded', 'true');
      this.expandedItemIds.add(item.id);
      const body = document.createElement('div');
      body.className = 'turn-tool-body';
      body.append(this.renderToolBody(item));
      selected.append(body);
    };
    items.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.style.setProperty('--collapsed-x', '0px');
      button.style.setProperty('--expanded-x', `${widths.slice(0, index).reduce((total, width) => total + width + 5, 0)}px`);
      button.style.setProperty('--button-width', `${widths[index]}px`);
      button.style.setProperty('--collapsed-opacity', index === 0 ? '1' : '0');
      const taskRunId = item.taskRun?.taskRunId;
      const taskName = taskGroup ? this.taskLabel(item) : undefined;
      const state = item.taskRun?.status ?? item.toolState;
      button.className = 'turn-tool-icon-button is-' + (state === 'done' ? 'done' : ['queued', 'running', 'waiting'].includes(state ?? 'running') ? 'running' : 'failed');
      button.title = [taskName ?? item.toolSummary ?? item.toolName ?? '工具', this.toolStateLabel(item), taskRunId ? '点击查看任务对话' : undefined].filter(Boolean).join(' · ');
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-expanded', 'false');
      if (taskGroup) button.append(createAgentTaskStatusIcon(state));
      else button.append(this.toolIcon(item));
      button.addEventListener('click', async () => {
        if (!taskRunId) { select(item, button); return; }
        button.disabled = true;
        try { await this.api.openTaskTranscript(taskRunId); }
        catch (error) { button.title = `无法打开任务：${errorMessage(error)}`; }
        finally { button.disabled = false; }
      });
      buttons.push(button);
      rail.append(button);
    });
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'turn-tool-stack-toggle';
    toggle.title = taskGroup ? items.map((item) => this.taskLabel(item)).join('、') : `${items.length} 次工具调用`;
    toggle.setAttribute('aria-label', toggle.title);
    if (items.length > 1) {
      const count = document.createElement('span');
      count.className = 'turn-tool-count';
      count.textContent = String(items.length);
      count.setAttribute('aria-hidden', 'true');
      toggle.append(count);
    }
    const setExpanded = (open: boolean): void => {
      stack.classList.toggle('is-expanded', open);
      stack.dataset.expanded = String(open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.tabIndex = open ? -1 : 0;
      toggle.setAttribute('aria-hidden', String(open));
      buttons.forEach((button) => {
        button.tabIndex = open ? 0 : -1;
        button.setAttribute('aria-hidden', String(!open));
      });
      if (open) this.expandedItemIds.add(id);
      else { clearDetail(); this.expandedItemIds.delete(id); }
    };
    toggle.addEventListener('click', () => { setExpanded(true); buttons[0]?.focus({ preventScroll: true }); });
    stack.addEventListener('reset-tool-stack', () => {
      clearDetail();
      setExpanded(items.length === 1);
    });
    rail.append(toggle);
    viewport.append(rail);
    stack.append(viewport);
    (previewHost ?? stack).append(selected);
    const restoredItem = items.findIndex((item) => this.expandedItemIds.has(item.id));
    const open = items.length === 1 || this.expandedItemIds.has(id);
    setExpanded(open);
    if (open && restoredItem >= 0) select(items[restoredItem]!, buttons[restoredItem]!, true);
    return stack;
  }

  /**
   * One owned task label for the list below the turn summary: the task name
   * with the single existing status icon (running pulses, terminal keeps its
   * state color) and the click-to-open task conversation behavior.
   */
  private renderTaskSummaryLabel(item: ConversationItemSnapshot): HTMLElement {
    const taskRun = item.taskRun!;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'turn-task-label-row';
    const state = taskRun.status ?? item.toolState;
    button.classList.add('is-' + (state === 'done' ? 'done' : ['queued', 'running', 'waiting'].includes(state ?? 'running') ? 'running' : 'failed'));
    button.append(createAgentTaskStatusIcon(state));
    const label = document.createElement('span');
    label.className = 'turn-task-label-text';
    label.textContent = this.taskLabel(item);
    button.append(label);
    button.title = [this.taskLabel(item), this.toolStateLabel(item), '点击查看任务对话'].filter(Boolean).join(' · ');
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await this.api.openTaskTranscript(taskRun.taskRunId); }
      catch (error) { button.title = `无法打开任务：${errorMessage(error)}`; }
      finally { button.disabled = false; }
    });
    return button;
  }

  private taskLabel(item: ConversationItemSnapshot): string {
    return item.taskRun?.taskName?.trim()
      || item.toolSummary?.replace(/^运行任务\s*/, '').trim()
      || item.taskRun?.taskId || '任务';
  }

  private toolStateLabel(item: ConversationItemSnapshot): string {
    const labels: Record<string, string> = { queued: '排队中', running: '运行中', waiting: '等待中', paused: '已暂停', done: '完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
    return labels[item.taskRun?.status ?? item.toolState ?? 'running'] ?? '未知';
  }

  /** Final answer content, separate from the footer actions and metrics. */
  private renderFinalContent(
    item: ConversationItemSnapshot,
    group: ConversationRenderGroup,
    preferences: TurnRenderPreferences,
  ): HTMLElement {
    void group;
    void preferences;
    const content = document.createElement('div');
    content.className = 'message-content message-content-segment';
    content.append(renderRichText(item.text));
    if (item.running) {
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      content.append(cursor);
    }
    if (item.documentLinks && item.documentLinks.length > 0) {
      content.append(this.renderDocumentLinks(item.documentLinks, item.toolResultText));
    }
    return content;
  }

  private createCopyButton(text: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-copy';
    this.setCopyButtonState(button, '复制');
    button.addEventListener('click', () => { void this.copyMessage(text, button); });
    return button;
  }

  private setCopyButtonState(button: HTMLButtonElement, label: string): void {
    button.title = label;
    button.setAttribute('aria-label', label);
    const path = label === '已复制'
      ? '<path d="m5 12 4 4 10-10"/>'
      : label === '复制失败'
        ? '<path d="m7 7 10 10M17 7 7 17"/>'
        : '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/>';
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  private async copyMessage(text: string, button: HTMLButtonElement): Promise<void> {
    try {
      await this.api.copyText(text);
      this.setCopyButtonState(button, '已复制');
    } catch {
      this.setCopyButtonState(button, '复制失败');
    }
    window.setTimeout(() => {
      if (button.isConnected) this.setCopyButtonState(button, '复制');
    }, 1_400);
  }

  /** Keep the streaming cursor visible on an unchanged item body. */
  private syncStreamingCursor(node: HTMLElement, item: ConversationItemSnapshot): void {
    if (!item.running) return;
    const final = node.querySelector('.message-content');
    if (!final || node.querySelector('.streaming-cursor')) return;
    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';
    final.append(cursor);
  }

  private renderStatsLines(preferences: TurnRenderPreferences): void {
    const turn = preferences.turn;
    if (!turn || !preferences.footer) return;
    // A running turn has no finished consumption to report: while it is being
    // worked on (and while waiting for the next step) every stat and copy
    // affordance stays out of the footer instead of showing partial numbers.
    if (turn.running === true) {
      preferences.statsSignature = conversationTurnTimingSignature(turn);
      preferences.stats?.remove();
      preferences.stats = undefined;
      return;
    }
    const stats = document.createElement('div');
    stats.className = 'turn-stats';
    for (const line of buildConversationTurnStatLines(turn)) {
      const cell = document.createElement('span');
      cell.className = 'turn-stat';
      const label = document.createElement('small');
      label.textContent = line.label;
      const value = document.createElement('b');
      value.textContent = line.value;
      cell.append(label, value);
      stats.append(cell);
    }
    preferences.stats = stats;
    preferences.footer.insertBefore(stats, preferences.footer.querySelector('.message-time'));
  }

  /** Usage/timing lines are rendered once per observed timing signature. */
  private renderTurnStats(preferences: TurnRenderPreferences): void {
    const turn = preferences.turn;
    if (!turn || !preferences.footer) return;
    const signature = conversationTurnTimingSignature(turn);
    if (preferences.statsSignature === signature && preferences.stats?.isConnected) return;
    preferences.statsSignature = signature;
    preferences.stats?.remove();
    this.renderStatsLines(preferences);
  }

  /** Schedule the running group's independent one-second elapsed clock. */
  private scheduleTurnClock(): void {
    if (this.timerTimeout !== undefined) return;
    const delay = nextElapsedTickDelay(Date.now(), this.timerLastTickAt);
    this.timerTimeout = window.setTimeout(() => {
      this.timerTimeout = undefined;
      this.tickTurnClock();
    }, delay);
  }

  /** One tick: refresh the summary clock text and re-arm the next second. */
  private tickTurnClock(): void {
    let running = false;
    for (const preferences of this.turnPreferences.values()) {
      if (!preferences.running || !preferences.article?.isConnected) continue;
      running = true;
      const elapsed = preferences.startedAt === undefined ? 0 : elapsedSeconds(preferences.startedAt, Date.now()) ?? 0;
      if (preferences.summary?.isConnected) preferences.summary.textContent = `打造了 ${formatTurnDuration(elapsed)}`;
      preferences.clocking = false;
    }
    if (!running) { this.stopTurnClock(); return; }
    this.timerLastTickAt = Date.now();
    this.timerTimeout = window.setTimeout(() => {
      this.timerTimeout = undefined;
      this.tickTurnClock();
    }, nextElapsedTickDelay(Date.now(), this.timerLastTickAt));
  }

  /** Stop the elapsed clock; used when no turn is observed running anymore. */
  private stopTurnClock(): void {
    if (this.timerTimeout !== undefined) window.clearTimeout(this.timerTimeout);
    this.timerTimeout = undefined;
  }

  private renderToolItem(
    item: ConversationItemSnapshot,
    preferences: TurnRenderPreferences,
  ): HTMLDetailsElement {
    const tool = document.createElement('details');
    tool.className = 'tool-card is-' + (item.toolState ?? 'running');
    this.bindExpandedState(tool, item.id);
    const summary = document.createElement('summary');
    summary.textContent = item.toolSummary
      ? item.toolSummary + ' · ' + this.toolStateLabel(item)
      : (item.toolName ?? '工具') + ' · ' + this.toolStateLabel(item);
    tool.append(summary, this.renderToolBody(item));
    // A run_task item renders as a compact animated card; nested details stay
    // until the preview bridge lands, so the terminal metadata is never hidden.
    if (item.toolName === 'run_task') {
      tool.classList.add('tool-card-task');
      tool.open = item.taskRun ? preferences.open !== false : true;
    }
    return tool;
  }

  private formatToolJson(value: string): string {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }

  private renderToolBody(item: ConversationItemSnapshot): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const code = document.createElement('pre');
    code.setAttribute('aria-label', '调用参数');
    code.textContent = this.formatToolJson(item.text || '{}');
    fragment.append(code);

    // run_task items carry terminal metadata once resolved, or a pending hint
    // while the model is still being selected. Pending items never poll.
    if (item.toolName === 'run_task') {
      if (item.taskRun) {
        const box = document.createElement('div');
        box.className = 'task-run-summary';
        for (const line of buildTaskRunSummaryLines(item.taskRun)) {
          const row = document.createElement('div');
          row.className = 'task-run-row';
          const label = document.createElement('span');
          label.className = 'task-run-label';
          label.textContent = line.label;
          const value = document.createElement('span');
          value.className = 'task-run-value';
          value.textContent = line.value;
          row.append(label, value);
          box.append(row);
        }
        fragment.append(box);
      } else {
        const pending = document.createElement('div');
        pending.className = 'task-run-pending';
        pending.textContent = '运行中 · 模型待解析';
        fragment.append(pending);
      }
    }

    if (item.toolResultText) {
      const result = document.createElement('pre');
      result.className = 'tool-result-body';
      result.setAttribute('aria-label', '调用结果');
      result.textContent = this.formatToolJson(item.toolResultText);
      fragment.append(result);
    }

    return fragment;
  }

  /**
   * Document links observed for a doc tool result, rendered as a real
   * disclosure: the label expands the observed tool result body instead of
   * being an anchor without a target.
   */
  private renderDocumentLinks(
    links: readonly { title: string; path: string }[],
    resultText?: string,
  ): HTMLElement {
    const box = document.createElement('div');
    box.className = 'turn-documents';
    for (const link of links) {
      const details = document.createElement('details');
      details.className = 'turn-document';
      this.bindExpandedState(details, 'doc:' + link.path);
      const summary = document.createElement('summary');
      summary.className = 'turn-document-label';
      summary.textContent = link.title;
      summary.title = link.path;
      details.append(summary);
      const body = document.createElement('pre');
      body.className = 'turn-document-body';
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        if (body.isConnected) return;
        // The body is the actual observed tool result, not a dead link.
        body.textContent = link.path + '\n\n' + (resultText || '未观察到工具结果');
        details.append(body);
      });
      box.append(details);
    }
    return box;
  }

  private renderModels(snapshot: ConversationSnapshot): void {
    const directory = snapshot.models;
    const currentValue = directory.current
      ? conversationModelValue(directory.current.provider, directory.current.model)
      : '';
    const entries: ModelPickerEntry[] = [];

    if (directory.current && !directory.current.advertised) {
      entries.push({
        provider: directory.current.provider,
        catalogProvider: directory.current.catalogProvider,
        providerLabel: directory.current.providerLabel,
        model: directory.current.model,
        label: directory.current.label,
        value: currentValue,
        current: true,
        advertised: false,
        description: '当前会话模型未出现在最新模型目录中',
      });
    }
    for (const group of directory.groups) {
      for (const model of group.models) {
        const value = conversationModelValue(model.provider, model.model);
        entries.push({
          ...model,
          value,
          current: value === currentValue,
          advertised: true,
        });
      }
    }
    this.modelEntries = entries;
    this.updateModelSelect();

    const unavailable = snapshot.status !== 'ready'
      || directory.status === 'loading'
      || this.advertisedCount() === 0;
    // DSH emits a transient loading snapshot while it applies a model change.
    // Keep the already-focused trigger in the tab order through that refresh;
    // aria-disabled still exposes and enforces the temporary disabled state.
    const transientLoading = snapshot.status === 'ready'
      && Boolean(snapshot.selectedSessionId)
      && directory.status === 'loading';
    this.modelSelect.setDisabled(unavailable && !transientLoading);
    this.modelSelect.setLoading(this.busy || transientLoading);
    const current = directory.current;
    const placeholder = directory.status === 'loading'
      ? '读取模型…'
      : snapshot.selectedSessionId ? '选择模型' : '选择模型后开始对话';
    this.modelSelect.placeholder = placeholder;
    // Themed trigger tooltip: model identity on the first line, then the
    // provider quota section as short readable multiline lines.
    const currentModel = current ? this.modelEntries.find((entry) => entry.current) : undefined;
    const currentCatalogModel = currentModel ? this.catalogModel(currentModel) : undefined;
    this.modelSelect.setTitle(current
      ? [
          [current.label, current.reasoningEffort, current.advertised ? '' : '当前目录未提供',
            currentCatalogModel && this.modelIsFree(currentCatalogModel) ? '免费模型' : '']
            .filter(Boolean).join(' · '),
          ...tooltipLines(this.providerPresentation(current.catalogProvider).tooltip),
        ].filter(Boolean).join('\n')
      : directory.message ?? placeholder);
    const selectedEntry = this.modelEntries.find((entry) => entry.current);
    const efforts = selectedEntry?.reasoningEfforts ?? [];
    this.reasoningSelect.replaceChildren(...efforts.map((effort) => {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = effort;
      return option;
    }));
    this.reasoningSelect.hidden = efforts.length === 0;
    this.reasoningSelect.disabled = this.busy || transientLoading;
    if (current?.reasoningEffort && efforts.includes(current.reasoningEffort)) {
      this.reasoningSelect.value = current.reasoningEffort;
    } else if (selectedEntry?.defaultReasoningEffort && efforts.includes(selectedEntry.defaultReasoningEffort)) {
      this.reasoningSelect.value = selectedEntry.defaultReasoningEffort;
    }
  }

  private advertisedCount(): number {
    return this.modelEntries.filter((entry) => entry.advertised).length;
  }

  /** Projects provider quota into the picker labels, tooltips and fallback titles. */
  private providerPresentation(providerId: string): ConversationProviderPresentation {
    const cached = this.modelCategories.get(providerId);
    if (cached) return cached;
    const presentation = conversationProviderPresentation(providerId, this.quotaSnapshot);
    this.modelCategories.set(providerId, presentation);
    return presentation;
  }

  /** Catalog model row backing a picker entry, matched on the canonical id. */
  private catalogModel(entry: ModelPickerEntry): ProviderModelSnapshot | undefined {
    // DSH gateway entries already carry canonical provider/model public IDs.
    const prefix = `${entry.catalogProvider}/`;
    const modelId = entry.provider === 'wrenyard' && entry.model.startsWith(prefix)
      ? entry.model.slice(prefix.length) : entry.model;
    return this.quotaSnapshot?.catalog
      .find((provider) => provider.id === entry.catalogProvider)?.models
      ?.find((candidate) => candidate.id === modelId);
  }

  /**
   * Themed option tooltip copy: model identity and input capability on the
   * first line, the free-state note, then the provider quota section as short
   * readable multiline lines inside the shared themed tooltip.
   */
  private optionTitle(entry: ModelPickerEntry): string {
    const capability = entry.inputTypes === undefined
      ? '图片：未知'
      : entry.inputTypes.includes('image') ? '图片：支持' : '图片：不支持';
    const model = this.catalogModel(entry);
    return [
      [entry.description ?? entry.model, capability].filter(Boolean).join(' · '),
      model && this.modelIsFree(model) ? '免费额度' : '',
      ...tooltipLines(this.providerPresentation(entry.catalogProvider).tooltip),
    ].filter(Boolean).join('\n');
  }

  /**
   * Authoritative free-model predicate. Only the catalog's explicit free flag
   * counts; a missing/zero price is never treated as evidence of a free model,
   * because unpriced rows are exactly the unknown case.
   */
  private modelIsFree(model: ProviderModelSnapshot): boolean {
    return model.free === true;
  }

  private updateModelSelect(): void {
    const advertised = this.modelEntries.filter((entry) => entry.advertised);
    const current = this.modelEntries.find((entry) => entry.current);
    // The not-in-directory current model stays listed (disabled) so the
    // selection remains visible while advertised options are available.
    const options = current && !current.advertised ? [current, ...advertised] : advertised;
    this.modelSelect.setOptions(options.map((entry) => ({
      value: entry.value,
      label: entry.label,
      icon: () => brandIcon(familyBrand(classifyFamily(entry.label))) ?? brandIcon(providerBrand(entry.catalogProvider)) ?? document.createElement('span'),
      secondary: entry.advertised
        ? this.providerPresentation(entry.catalogProvider).label
        : '当前会话模型',
      title: this.optionTitle(entry),
      disabled: !entry.advertised,
      badges: entry.advertised ? (() => {
        const model = this.catalogModel(entry);
        const badges: Array<{ kind: 'fast' | 'very-fast' | 'quota' | 'free'; label: string }> = [];
        if (model?.effectiveTps !== undefined && model.effectiveTps !== null) {
          if (model.effectiveTps > 200) badges.push({ kind: 'very-fast', label: `极速 · ${model.effectiveTps} TPS` });
          else if (model.effectiveTps > 100) badges.push({ kind: 'fast', label: `快速 · ${model.effectiveTps} TPS` });
        }
        if (model?.quotaAbundant) badges.push({ kind: 'quota', label: '额度充足' });
        // Monochrome free-model icon sits beside the speed/quota badges and is
        // driven only by the authoritative catalog flag.
        if (model && this.modelIsFree(model)) badges.push({ kind: 'free', label: '免费模型' });
        return badges;
      })() : undefined,
    })));
    this.modelSelect.value = current?.value ?? '';
    this.modelSelect.setSearchLabel('搜索模型');
  }

  private renderSessions(snapshot: ConversationSnapshot): void {
    // Rebuilt rows lose their tooltip anchors; any open tooltip closes with them.
    hideThemedTooltip();
    if (snapshot.sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-list-empty';
      empty.textContent = snapshot.status === 'ready' ? '还没有会话' : '配置 Workspace 后显示会话';
      this.sessionList.replaceChildren(empty);
      return;
    }
    this.sessionList.replaceChildren(...snapshot.sessions.map((session) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `session-row${session.id === snapshot.selectedSessionId ? ' is-selected' : ''}`;
      button.setAttribute('role', 'listitem');
      button.addEventListener('click', () => void this.select(session.id));
      const copy = document.createElement('span');
      copy.className = 'session-row-copy';
      const title = document.createElement('strong');
      // Compact row: no preset/DSH subtitle. The full title stays reachable
      // through the themed hover/focus tooltip since the label ellipsizes.
      title.textContent = session.title;
      copy.append(title);
      // Real themed full-title tooltip: only when the row actually truncates
      // the label; the long title wraps and scrolls inside the overlay.
      // Clicking anywhere on the row still selects the session.
      bindThemedTooltip(button, () => (title.scrollWidth > title.clientWidth ? session.title : ''));
      const time = document.createElement('time');
      time.textContent = session.running ? '工作中' : formatSessionTime(session.updatedAt);
      if (session.running) time.className = 'is-running';
      button.append(copy, time);
      return button;
    }));
  }

  /** Manual per-tool expansion; the reader's open/closed choice is preserved. */
  private bindExpandedState(details: HTMLDetailsElement, id: string): void {
    details.dataset.expandId = id;
    details.open = this.expandedItemIds.has(id);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open && !this.hasClosedAncestor(details)) this.expandedItemIds.add(id);
      else {
        details.open = false;
        this.closeDescendants(details);
        this.expandedItemIds.delete(id);
      }
    });
  }

  private bindTurnExpandedState(
    details: HTMLDetailsElement,
    id: string,
    preferences: TurnRenderPreferences,
  ): void {
    details.dataset.expandId = id;
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) {
        this.expandedItemIds.add(id);
        preferences.manualExpanded = true;
        return;
      }
      this.closeDescendants(details);
      this.expandedItemIds.delete(id);
      // Only an explicit collapse clears the manual expansion; a rebuild
      // replacing the node must not look like a reader collapse.
      preferences.manualExpanded = false;
    });
  }

  private hasClosedAncestor(details: HTMLDetailsElement): boolean {
    let ancestor = details.parentElement?.closest('details, .turn-tool-stack');
    while (ancestor) {
      if (ancestor instanceof HTMLDetailsElement ? !ancestor.open : ancestor.getAttribute('data-expanded') !== 'true') return true;
      ancestor = ancestor.parentElement?.closest('details, .turn-tool-stack');
    }
    return false;
  }

  private closeDescendants(parent: HTMLElement): void {
    parent.querySelectorAll<HTMLElement>('.turn-tool-stack').forEach((stack) => stack.dispatchEvent(new Event('reset-tool-stack')));
    for (const child of Array.from(parent.querySelectorAll<HTMLDetailsElement>('details'))) {
      child.open = false;
      const id = child.dataset.expandId;
      if (id) this.expandedItemIds.delete(id);
    }
  }

  private captureExpandedItems(): void {
    for (const details of Array.from(this.feed.querySelectorAll<HTMLDetailsElement>('details[data-expand-id]'))) {
      const id = details.dataset.expandId;
      if (!id) continue;
      if (details.open && !this.hasClosedAncestor(details)) this.expandedItemIds.add(id);
      else {
        details.open = false;
        this.closeDescendants(details);
        this.expandedItemIds.delete(id);
      }
    }
  }

  private async select(sessionId: string): Promise<void> {
    if (this.busy || sessionId === this.snapshot?.selectedSessionId) return;
    this.busy = true;
    if (this.snapshot) this.renderModels(this.snapshot);
    try {
      this.render(await this.api.selectConversation(sessionId));
    } catch (error) {
      this.showError(errorMessage(error));
    } finally {
      this.busy = false;
      if (this.snapshot) this.render(this.snapshot);
    }
  }

  private async create(): Promise<void> {
    if (this.busy || this.snapshot?.status !== 'ready') return;
    this.busy = true;
    if (this.snapshot) this.renderModels(this.snapshot);
    try {
      this.render(await this.api.createConversation());
      this.rotateConversationPlaceholder();
      this.input.focus();
    } catch (error) {
      this.showError(errorMessage(error));
    } finally {
      this.busy = false;
      if (this.snapshot) this.render(this.snapshot);
    }
  }

  private rotateConversationPlaceholder(): void {
    this.input.placeholder = nextConversationPlaceholder();
  }

  private async selectModel(value: string): Promise<void> {
    // The shared control already applied the canonical value optimistically, so
    // remember it to restore the previous selection when the change fails.
    const previousValue = this.modelSelect.value;
    const selection = parseConversationModelValue(value);
    const previousSnapshot = this.snapshot;
    if (!selection || this.busy || previousSnapshot?.status !== 'ready') {
      if (previousSnapshot) this.renderModels(previousSnapshot);
      return;
    }
    this.busy = true;
    this.renderModels(previousSnapshot);
    try {
      this.render(await this.api.selectConversationModel(selection.provider, selection.model));
    } catch (error) {
      this.snapshot = previousSnapshot;
      this.renderModels(previousSnapshot);
      // Canonical provider/model encoding is preserved on failure.
      if (previousValue) this.modelSelect.value = previousValue;
      this.showError(errorMessage(error));
    } finally {
      this.busy = false;
      if (this.snapshot) this.renderModels(this.snapshot);
      // The trigger is re-enabled above, so focus can return after the await.
      if (!this.modelSelectTriggerDisabled()) {
        requestAnimationFrame(() => this.modelPickerHost.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
      }
    }
  }

  private async selectReasoningEffort(reasoningEffort: string): Promise<void> {
    const current = this.snapshot?.models.current;
    if (!current || !reasoningEffort || this.busy) return;
    this.busy = true;
    try {
      this.render(await this.api.selectConversationModel(current.provider, current.model, reasoningEffort));
    } catch (error) {
      this.showError(errorMessage(error));
      if (this.snapshot) this.renderModels(this.snapshot);
    } finally {
      this.busy = false;
      if (this.snapshot) this.render(this.snapshot);
    }
  }

  private modelSelectTriggerDisabled(): boolean {
    const trigger = this.modelPickerHost.querySelector<HTMLButtonElement>('button');
    return !trigger || trigger.disabled;
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.snapshot?.status !== 'ready') return;
    if (this.snapshot) this.renderModels(this.snapshot);
    this.input.value = '';
    this.resizeComposer();
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      this.render(await this.api.sendConversation(text, zone));
    } catch (error) {
      // A failed send restores the draft only when the reader has not typed a
      // newer one in the meantime; the newer draft always wins.
      if (!this.input.value.trim()) {
        this.input.value = text;
        this.resizeComposer();
      }
      this.showError(errorMessage(error));
    } finally {
      if (this.snapshot) this.render(this.snapshot);
      this.input.focus();
    }
  }

  private async cancel(turnId?: string): Promise<void> {
    try {
      this.render(await this.api.cancelConversation(turnId));
    } catch (error) {
      this.showError(errorMessage(error));
    } finally {
      if (this.snapshot) this.render(this.snapshot);
    }
  }

  private async saveWorkspace(): Promise<void> {
    if (this.workspaceSaving) return;
    this.workspaceSaving = true;
    const button = element<HTMLButtonElement>('workspace-quick-save');
    const create = this.gateMode.value === 'create';
    this.gateError.textContent = '';
    button.disabled = true;
    button.textContent = '正在保存…';
    try {
      await this.api.saveWorkspace(this.gateInput.value, create);
      button.textContent = '已应用';
      await this.refresh();
    } catch (error) {
      this.gateError.textContent = errorMessage(error);
      button.disabled = false;
      this.applyGateMode();
    } finally {
      this.workspaceSaving = false;
    }
  }

  /** Project the selected mode onto the confirm label and destination hint. */
  private applyGateMode(): void {
    const create = this.gateMode.value === 'create';
    const quickSave = element<HTMLButtonElement>('workspace-quick-save');
    quickSave.textContent = quickSave.disabled
      ? '环境变量管理'
      : create ? '新建并应用' : '保存并应用';
    this.gateHint.textContent = create
      ? '新建模式会初始化一个空的 workspace 目录，已有内容的目录请改用「选择已有 workspace」。'
      : '选择模式只会绑定已存在的 workspace 目录。';
  }

  /**
   * The composer is a single flex row: the textarea grows upward and the send
   * icon keeps its place on the right. Only the trimmed input gates the send
   * affordance (an explicit class drives opacity/pointer-events so a
   * reduced-motion reader still gets the same non-interactive state), never the
   * turn in flight — concurrent turns are allowed.
   */
  private resizeComposer(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(180, Math.max(32, this.input.scrollHeight))}px`;
    this.syncSendState();
  }

  private syncSendState(): void {
    const ready = this.snapshot?.status === 'ready' && this.snapshot.models.routable !== false;
    const hasDraft = this.input.value.trim().length > 0;
    const enabled = ready && hasDraft;
    this.sendButton.disabled = !enabled;
    this.sendButton.classList.toggle('is-ready', enabled);
    this.sendButton.setAttribute('aria-disabled', String(!enabled));
  }

  private showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  private hideError(): void {
    this.error.hidden = true;
    this.error.textContent = '';
  }
}
