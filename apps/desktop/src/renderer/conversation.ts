import type {
  ConversationItemSnapshot,
  ConversationSnapshot,
  WrenyardShellApi,
} from '../shell-contract.js';

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

function renderRichText(text: string): DocumentFragment {
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
    for (const line of lines) {
      if (!line.trim()) {
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

export class ConversationView {
  private readonly api: WrenyardShellApi;
  private readonly openSettings: () => void;
  private readonly feed = element<HTMLElement>('conversation-feed');
  private readonly sessionList = element<HTMLElement>('conversation-session-list');
  private readonly input = element<HTMLTextAreaElement>('conversation-input');
  private readonly sendButton = element<HTMLButtonElement>('conversation-send');
  private readonly stopButton = element<HTMLButtonElement>('conversation-stop');
  private readonly modelSelect = element<HTMLSelectElement>('conversation-model-select');
  private readonly error = element<HTMLElement>('conversation-error');
  private readonly gate = element<HTMLElement>('workspace-gate');
  private readonly gateInput = element<HTMLInputElement>('workspace-gate-input');
  private readonly gateError = element<HTMLElement>('workspace-gate-error');
  private snapshot: ConversationSnapshot | undefined;
  private refreshing = false;
  private refreshQueued = false;
  private busy = false;

  constructor(api: WrenyardShellApi, openSettings: () => void) {
    this.api = api;
    this.openSettings = openSettings;
    element('new-conversation-button').addEventListener('click', () => void this.create());
    this.sendButton.addEventListener('click', () => void this.send());
    this.stopButton.addEventListener('click', () => void this.cancel());
    this.modelSelect.addEventListener('change', () => void this.selectModel());
    element('workspace-open-settings').addEventListener('click', openSettings);
    element('workspace-quick-save').addEventListener('click', () => void this.saveWorkspace());
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
    const pinnedToBottom = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 120;
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
      this.gateInput.value = snapshot.workspace.path ?? '';
      element('workspace-gate-message').textContent = snapshot.message ?? '会话必须绑定一个 Wrenyard workspace。';
      const workspaceFromEnvironment = snapshot.workspace.source === 'environment';
      this.gateInput.readOnly = workspaceFromEnvironment;
      this.gateInput.setAttribute('aria-readonly', String(workspaceFromEnvironment));
      const quickSave = element<HTMLButtonElement>('workspace-quick-save');
      quickSave.disabled = workspaceFromEnvironment;
      quickSave.textContent = workspaceFromEnvironment ? '环境变量管理' : '保存并应用';
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
    if (pinnedToBottom || snapshot.selectedRunning) requestAnimationFrame(() => { this.feed.scrollTop = this.feed.scrollHeight; });
  }

  private renderModels(snapshot: ConversationSnapshot): void {
    const directory = snapshot.models;
    const currentValue = directory.current
      ? conversationModelValue(directory.current.provider, directory.current.model)
      : '';
    const options: HTMLOptionElement[] = [];
    const nodes: Array<HTMLOptionElement | HTMLOptGroupElement> = [];

    if (directory.current && !directory.current.advertised && directory.current.configured) {
      const current = document.createElement('option');
      current.value = currentValue;
      current.textContent = `${directory.current.label}（当前）`;
      current.disabled = true;
      nodes.push(current);
      options.push(current);
    }
    for (const group of directory.groups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const model of group.models) {
        const option = document.createElement('option');
        option.value = conversationModelValue(model.provider, model.model);
        option.textContent = model.label;
        option.title = model.description ?? `${model.providerLabel} / ${model.model}`;
        optgroup.append(option);
        options.push(option);
      }
      nodes.push(optgroup);
    }
    if (nodes.length === 0) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = snapshot.selectedSessionId
        ? directory.status === 'loading' ? '读取模型…' : '暂无可选模型'
        : '新建会话后选择模型';
      nodes.push(placeholder);
    }
    this.modelSelect.replaceChildren(...nodes);
    if (currentValue && options.some((option) => option.value === currentValue)) this.modelSelect.value = currentValue;
    this.modelSelect.disabled = this.busy
      || snapshot.status !== 'ready'
      || !snapshot.selectedSessionId
      || directory.status === 'loading'
      || directory.groups.every((group) => group.models.length === 0);
    const current = directory.current;
    this.modelSelect.title = current
      ? `${current.providerLabel} / ${current.label}${current.reasoningEffort ? ` · ${current.reasoningEffort}` : ''}`
      : directory.message ?? '当前会话模型';
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
    const nodes = items.map((item) => this.renderItem(item));
    if (running && !items.some((item) => item.running)) {
      const waiting = document.createElement('article');
      waiting.className = 'message message-assistant message-waiting';
      waiting.innerHTML = '<div class="message-avatar">啾</div><div class="message-body"><span class="thinking-dots"><i></i><i></i><i></i></span></div>';
      nodes.push(waiting);
    }
    this.feed.replaceChildren(...nodes);
  }

  private renderItem(item: ConversationItemSnapshot): HTMLElement {
    if (item.kind === 'tool') {
      const tool = document.createElement('details');
      tool.className = `tool-card is-${item.toolState ?? 'running'}`;
      const summary = document.createElement('summary');
      const state = item.toolState === 'failed' ? '失败' : item.toolState === 'done' ? '完成' : '运行中';
      summary.textContent = `${item.toolName ?? '工具'} · ${state}`;
      const code = document.createElement('pre');
      code.textContent = item.text || '无参数';
      tool.append(summary, code);
      return tool;
    }
    const article = document.createElement('article');
    article.className = `message message-${item.kind}${item.running ? ' is-streaming' : ''}`;
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
    if (item.reasoning) {
      const thinking = document.createElement('details');
      thinking.className = 'reasoning-block';
      const label = document.createElement('summary');
      label.textContent = item.running ? '正在思考' : '思考过程';
      const content = document.createElement('div');
      content.textContent = item.reasoning;
      thinking.append(label, content);
      body.append(thinking);
    }
    const content = document.createElement('div');
    content.className = 'message-content';
    content.append(renderRichText(item.text));
    if (item.running) {
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      content.append(cursor);
    }
    body.append(content);
    article.append(avatar, body);
    return article;
  }

  private async select(sessionId: string): Promise<void> {
    if (this.busy || sessionId === this.snapshot?.selectedSessionId) return;
    this.busy = true;
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

  private async selectModel(): Promise<void> {
    const selection = parseConversationModelValue(this.modelSelect.value);
    if (!selection || this.busy || this.snapshot?.status !== 'ready') {
      if (this.snapshot) this.renderModels(this.snapshot);
      return;
    }
    this.busy = true;
    this.modelSelect.disabled = true;
    try {
      this.render(await this.api.selectConversationModel(selection.provider, selection.model));
    } catch (error) {
      this.showError(errorMessage(error));
    } finally {
      this.busy = false;
      if (this.snapshot) this.render(this.snapshot);
      this.input.focus();
    }
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.busy || this.snapshot?.status !== 'ready') return;
    this.busy = true;
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
    const button = element<HTMLButtonElement>('workspace-quick-save');
    this.gateError.textContent = '';
    button.disabled = true;
    button.textContent = '正在保存…';
    try {
      await this.api.saveWorkspace(this.gateInput.value);
      button.textContent = '已应用';
      await this.refresh();
    } catch (error) {
      this.gateError.textContent = errorMessage(error);
      button.disabled = false;
      button.textContent = '保存并应用';
    }
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
