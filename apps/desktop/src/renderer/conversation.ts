import type {
  ConversationItemSnapshot,
  ConversationModelOptionSnapshot,
  ConversationSnapshot,
  QuotaSnapshot,
  TaskRunSnapshot,
  WrenyardShellApi,
} from '../shell-contract.js';
import {
  conversationProviderPresentation,
  type ConversationProviderPresentation,
} from './conversation-provider-status.js';
import { SearchableSingleSelect } from './single-select.js';

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  return String(error);
}

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
      groups.push({ kind: 'assistant-turn', items: turnItems });
      continue;
    }
    if (item) groups.push({ kind: 'item', items: [item] });
    index += 1;
  }
  return groups;
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
  private readonly openSettings: () => void;
  private readonly feed = element<HTMLElement>('conversation-feed');
  private readonly sessionList = element<HTMLElement>('conversation-session-list');
  private readonly input = element<HTMLTextAreaElement>('conversation-input');
  private readonly sendButton = element<HTMLButtonElement>('conversation-send');
  private readonly stopButton = element<HTMLButtonElement>('conversation-stop');
  private readonly modelPickerHost = element<HTMLElement>('conversation-model-picker');
  private readonly modelSelect: SearchableSingleSelect;
  private readonly error = element<HTMLElement>('conversation-error');
  private readonly gate = element<HTMLElement>('workspace-gate');
  private readonly gateMode = element<HTMLSelectElement>('workspace-gate-mode');
  private readonly gateInput = element<HTMLInputElement>('workspace-gate-input');
  private readonly gateHint = element<HTMLElement>('workspace-gate-hint');
  private readonly gateError = element<HTMLElement>('workspace-gate-error');
  private snapshot: ConversationSnapshot | undefined;
  private readonly expandedItemIds = new Set<string>();
  private refreshing = false;
  private refreshQueued = false;
  private busy = false;
  private workspaceSaving = false;
  private quotaSnapshot: QuotaSnapshot | undefined;
  private modelEntries: ModelPickerEntry[] = [];
  private modelCategories = new Map<string, ConversationProviderPresentation>();

  constructor(api: WrenyardShellApi, openSettings: () => void) {
    this.api = api;
    this.openSettings = openSettings;
    this.modelSelect = new SearchableSingleSelect(this.modelPickerHost, {
      label: '会话模型',
      placeholder: '读取模型…',
      onChange: (value) => void this.selectModel(value),
    });
    element('new-conversation-button').addEventListener('click', () => void this.create());
    this.sendButton.addEventListener('click', () => void this.send());
    this.stopButton.addEventListener('click', () => void this.cancel());
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
    const wasPinned = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 120;
    const previousScrollTop = this.feed.scrollTop;
    const scrollAnchor = sessionChanged ? undefined : this.captureScrollAnchor();
    this.captureExpandedItems();
    if (sessionChanged) this.expandedItemIds.clear();
    this.snapshot = snapshot;
    const ready = snapshot.status === 'ready';
    const workspaceLabel = element('conversation-workspace');
    workspaceLabel.textContent = '工坊工作区';
    workspaceLabel.title = snapshot.workspace.path ? '当前绑定的工坊工作区' : '尚未绑定工坊工作区';
    element('conversation-title').textContent = snapshot.selectedTitle ?? '新会话';

    this.renderModels(snapshot);
    this.renderSessions(snapshot);
    this.renderItems(snapshot.items, snapshot.selectedRunning);
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
    this.input.disabled = !canPrompt || this.busy;
    this.sendButton.disabled = !canPrompt || this.busy || !this.input.value.trim();
    this.sendButton.hidden = snapshot.selectedRunning;
    this.stopButton.hidden = !snapshot.selectedRunning;
    if (snapshot.status === 'unavailable') this.showError(snapshot.message ?? 'DSH 会话后端暂时不可用');
    else if (snapshot.models.routable === false) this.showError('当前模型暂时不可用，请切换到其他模型');
    else if (snapshot.models.status === 'error') this.showError(snapshot.models.message ?? '模型目录暂时不可用');
    else this.hideError();
    const followTail = shouldFollowConversationTail({ sessionChanged, wasPinned });
    requestAnimationFrame(() => {
      const maximum = Math.max(0, this.feed.scrollHeight - this.feed.clientHeight);
      this.feed.scrollTop = restoreConversationScrollTop({
        followTail,
        scrollTop: previousScrollTop,
        anchorId: scrollAnchor?.id,
        capturedOffset: scrollAnchor?.offset,
        anchors: this.collectScrollAnchors(),
        maximum,
      });
    });
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
    this.modelSelect.setTitle(current
      ? [current.label, current.reasoningEffort, current.advertised ? '' : '当前目录未提供',
          this.providerPresentation(current.catalogProvider).tooltip]
        .filter(Boolean).join(' · ')
      : directory.message ?? placeholder);
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

  private optionTitle(entry: ModelPickerEntry): string {
    const capability = entry.inputTypes === undefined
      ? '图片：未知'
      : entry.inputTypes.includes('image') ? '图片：支持' : '图片：不支持';
    const presentation = this.providerPresentation(entry.catalogProvider);
    return [entry.description ?? entry.model, capability, presentation.tooltip]
      .filter(Boolean)
      .join(' · ');
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
      secondary: entry.advertised
        ? this.providerPresentation(entry.catalogProvider).label
        : '当前会话模型',
      title: this.optionTitle(entry),
      disabled: !entry.advertised,
    })));
    this.modelSelect.value = current?.value ?? '';
    this.modelSelect.setSearchLabel('搜索模型');
  }

  private renderSessions(snapshot: ConversationSnapshot): void {
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
      const title = document.createElement('strong');
      title.textContent = session.title;
      const meta = document.createElement('small');
      meta.textContent = session.agentPreset ? session.agentPreset : 'DSH';
      copy.append(title, meta);
      const time = document.createElement('time');
      time.textContent = session.running ? '工作中' : formatSessionTime(session.updatedAt);
      if (session.running) time.className = 'is-running';
      button.append(copy, time);
      return button;
    }));
  }

  private renderItems(items: ConversationItemSnapshot[], running: boolean): void {
    if (items.length === 0) {
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
      const copy = document.createElement('p');
      copy.textContent = 'DSH 在后台提供会话能力，所有工作默认发生在已绑定的 Wrenyard workspace。';
      welcome.append(image, eyebrow, title, copy);
      this.feed.replaceChildren(welcome);
      return;
    }
    const groups = groupConversationItems(items);
    let waitingGroupIndex = -1;
    if (running && !items.some((item) => item.running)) {
      for (let index = groups.length - 1; index >= 0; index -= 1) {
        if (groups[index]?.kind === 'assistant-turn') {
          waitingGroupIndex = index;
          break;
        }
      }
    }
    const nodes = groups.map((group, index) => group.kind === 'assistant-turn'
      ? this.renderAssistantTurn(group.items, index === waitingGroupIndex)
      : this.renderItem(group.items[0]!));
    if (running && !items.some((item) => item.running) && waitingGroupIndex === -1) {
      const waiting = document.createElement('article');
      waiting.className = 'message message-assistant message-waiting';
      waiting.innerHTML = '<div class="message-avatar">啾</div><div class="message-body"><span class="thinking-dots"><i></i><i></i><i></i></span></div>';
      nodes.push(waiting);
    }
    this.feed.replaceChildren(...nodes);
  }

  private captureScrollAnchor(): { id: string; offset: number } | undefined {
    const feedRect = this.feed.getBoundingClientRect();
    for (const child of Array.from(this.feed.children)) {
      const id = child instanceof HTMLElement ? child.dataset.scrollId : undefined;
      if (!id) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom > feedRect.top && rect.top < feedRect.bottom) {
        return { id, offset: rect.top - feedRect.top };
      }
    }
    return undefined;
  }

  private collectScrollAnchors(): ConversationScrollAnchor[] {
    const feedRect = this.feed.getBoundingClientRect();
    const anchors: ConversationScrollAnchor[] = [];
    for (const child of Array.from(this.feed.children)) {
      const id = child instanceof HTMLElement ? child.dataset.scrollId : undefined;
      if (!id) continue;
      const rect = child.getBoundingClientRect();
      anchors.push({ id, offset: rect.top - feedRect.top });
    }
    return anchors;
  }

  private renderItem(item: ConversationItemSnapshot): HTMLElement {
    if (item.kind === 'tool') {
      const tool = this.renderToolItem(item);
      tool.dataset.scrollId = item.id;
      return tool;
    }
    if (item.kind === 'assistant') return this.renderAssistantTurn([item], false);
    const article = document.createElement('article');
    article.className = `message message-${item.kind}${item.running ? ' is-streaming' : ''}`;
    article.dataset.scrollId = item.id;
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = item.kind === 'user' ? '你' : '啾';
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('strong');
    author.textContent = item.kind === 'user' ? '你' : '啾啾工坊';
    const time = document.createElement('time');
    time.textContent = formatTime(item.time);
    meta.append(author, time);
    body.append(meta);
    this.appendAssistantContent(body, item);
    article.append(avatar, body);
    return article;
  }

  private renderAssistantTurn(items: ConversationItemSnapshot[], waiting: boolean): HTMLElement {
    const first = items.find((item) => item.kind === 'assistant') ?? items[0]!;
    const article = document.createElement('article');
    article.className = `message message-assistant${items.some((item) => item.running) ? ' is-streaming' : ''}`;
    article.dataset.turnId = first.turnId ?? first.id;
    article.dataset.scrollId = first.id;
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '啾';
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('strong');
    author.textContent = '啾啾工坊';
    const time = document.createElement('time');
    time.textContent = formatTime(first.time);
    meta.append(author, time);
    body.append(meta);
    for (const item of items) {
      if (item.kind === 'tool') body.append(this.renderToolItem(item));
      else this.appendAssistantContent(body, item);
    }
    if (waiting) {
      const dots = document.createElement('span');
      dots.className = 'thinking-dots';
      dots.innerHTML = '<i></i><i></i><i></i>';
      body.append(dots);
    }
    article.append(avatar, body);
    return article;
  }

  private appendAssistantContent(body: HTMLElement, item: ConversationItemSnapshot): void {
    if (!item.text && !item.running) return;
    const content = document.createElement('div');
    content.className = 'message-content message-content-segment';
    content.append(renderRichText(item.text));
    if (item.running) {
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      content.append(cursor);
    }
    body.append(content);
  }

  private renderToolItem(item: ConversationItemSnapshot): HTMLDetailsElement {
    const tool = document.createElement('details');
    tool.className = `tool-card is-${item.toolState ?? 'running'}`;
    this.bindExpandedState(tool, item.id);
    const summary = document.createElement('summary');
    const state = item.toolState === 'failed' ? '失败' : item.toolState === 'done' ? '完成' : '运行中';
    summary.textContent = `${item.toolName ?? '工具'} · ${state}`;
    const code = document.createElement('pre');
    code.textContent = item.text || '无参数';
    tool.append(summary, code);

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
        tool.append(box);
      } else {
        const pending = document.createElement('div');
        pending.className = 'task-run-pending';
        pending.textContent = '运行中 · 模型待解析';
        tool.append(pending);
      }
    }

    // Bounded raw result, rendered as escaped text in its own expandable body.
    if (item.toolResultText) {
      const result = document.createElement('details');
      result.className = 'tool-result';
      this.bindExpandedState(result, `${item.id}:tool-result`);
      const resultSummary = document.createElement('summary');
      resultSummary.textContent = '原始结果';
      const resultBody = document.createElement('div');
      resultBody.className = 'tool-result-body';
      resultBody.textContent = item.toolResultText;
      result.append(resultSummary, resultBody);
      tool.append(result);
    }

    return tool;
  }

  private bindExpandedState(details: HTMLDetailsElement, id: string): void {
    details.dataset.expandId = id;
    details.open = this.expandedItemIds.has(id);
    details.addEventListener('toggle', () => {
      if (details.open) this.expandedItemIds.add(id);
      else this.expandedItemIds.delete(id);
    });
  }

  private captureExpandedItems(): void {
    for (const details of Array.from(this.feed.querySelectorAll<HTMLDetailsElement>('details[data-expand-id]'))) {
      const id = details.dataset.expandId;
      if (!id) continue;
      if (details.open) this.expandedItemIds.add(id);
      else this.expandedItemIds.delete(id);
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

  private modelSelectTriggerDisabled(): boolean {
    const trigger = this.modelPickerHost.querySelector<HTMLButtonElement>('button');
    return !trigger || trigger.disabled;
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.busy || this.snapshot?.status !== 'ready') return;
    this.busy = true;
    if (this.snapshot) this.renderModels(this.snapshot);
    this.input.value = '';
    this.resizeComposer();
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      this.render(await this.api.sendConversation(text, zone));
    } catch (error) {
      this.input.value = text;
      this.showError(errorMessage(error));
    } finally {
      this.busy = false;
      if (this.snapshot) this.render(this.snapshot);
      this.input.focus();
    }
  }

  private async cancel(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (this.snapshot) this.renderModels(this.snapshot);
    try {
      this.render(await this.api.cancelConversation());
    } catch (error) {
      this.showError(errorMessage(error));
    } finally {
      this.busy = false;
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

  private resizeComposer(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(180, Math.max(28, this.input.scrollHeight))}px`;
    this.sendButton.disabled = this.busy
      || this.snapshot?.status !== 'ready'
      || this.snapshot.models.routable === false
      || !this.input.value.trim();
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
