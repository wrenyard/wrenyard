import { randomUUID } from 'node:crypto';
import type {
  ConversationItemSnapshot,
  ConversationSessionSnapshot,
  ConversationSnapshot,
  WorkspaceConfigurationSnapshot,
} from './shell-contract.js';

interface RpcSuccess {
  type: 'server-response';
  rpcId: string;
  result: { ok: true; value: unknown };
}

interface RpcFailure {
  type: 'server-response';
  rpcId: string;
  result: { ok: false; error: { code?: unknown; message?: unknown } };
}

interface RawSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
  projections?: { values?: Record<string, unknown> };
}

interface HistoryEntry {
  event: Record<string, unknown>;
  view?: unknown;
}

interface HistoryPage {
  events: HistoryEntry[];
  hasMore: boolean;
}

interface DshConversationClientOptions {
  baseUrl: string;
  workspaceId: string;
  workspace: WorkspaceConfigurationSnapshot & { status: 'configured'; path: string };
  onChanged(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function contentText(content: unknown, type = 'text'): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => isObject(block) && block.type === type && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n\n')
    .trim();
}

function titleFromSummary(summary: RawSessionSummary): string {
  const title = summary.projections?.values?.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return summary.blank ? '新会话' : '未命名会话';
}

function eventTime(event: Record<string, unknown>): number {
  return asNumber(event.time) ?? Date.now();
}

/** Fold DSH's durable history protocol into the bounded product-owned renderer model. */
export function projectConversationHistory(entries: HistoryEntry[]): ConversationItemSnapshot[] {
  const items: Array<ConversationItemSnapshot & { order: number }> = [];
  const drafts = new Map<string, ConversationItemSnapshot & { order: number }>();
  const finalizedSteps = new Set<string>();
  const tools = new Map<string, ConversationItemSnapshot & { order: number }>();

  for (const [order, entry] of entries.entries()) {
    const event = entry.event;
    const type = asString(event.type);
    const data = isObject(event.data) ? event.data : {};
    const seq = asNumber(event.seq) ?? order;
    const time = eventTime(event);

    if (type === 'user/message') {
      if (isObject(data.source) && data.source.kind !== 'user') continue;
      const text = contentText(data.content);
      if (text) items.push({ id: `user-${seq}`, kind: 'user', text, time, order });
      continue;
    }

    if (type === 'assistant/chunk') {
      const chunk = isObject(data.chunk) ? data.chunk : {};
      const turn = asNumber(data.turn) ?? 0;
      const step = asNumber(data.step) ?? 0;
      const key = `${turn}:${step}`;
      if (finalizedSteps.has(key)) continue;
      const chunkType = asString(chunk.type);
      if (chunkType !== 'text-delta' && chunkType !== 'reasoning-delta') continue;
      const delta = asString(chunk.text) ?? '';
      if (!delta) continue;
      const draft = drafts.get(key) ?? {
        id: `assistant-draft-${key}`,
        kind: 'assistant' as const,
        text: '',
        reasoning: '',
        time,
        running: true,
        order,
      };
      if (chunkType === 'reasoning-delta') draft.reasoning = `${draft.reasoning ?? ''}${delta}`;
      else draft.text += delta;
      drafts.set(key, draft);
      continue;
    }

    if (type === 'assistant/message') {
      const turn = asNumber(data.turn) ?? 0;
      const step = asNumber(data.step) ?? 0;
      const key = `${turn}:${step}`;
      finalizedSteps.add(key);
      drafts.delete(key);
      const message = isObject(data.message) ? data.message : {};
      const text = contentText(message.content);
      const reasoning = contentText(message.content, 'reasoning');
      if (text || reasoning) {
        items.push({
          id: `assistant-${seq}`,
          kind: 'assistant',
          text,
          ...(reasoning ? { reasoning } : {}),
          time,
          order,
        });
      }
      continue;
    }

    if (type === 'tool/call') {
      const callId = asString(data.callId) ?? `seq-${seq}`;
      const name = asString(data.name) ?? '工具调用';
      const args = asString(data.arguments)?.trim();
      const item: ConversationItemSnapshot & { order: number } = {
        id: `tool-${callId}`,
        kind: 'tool',
        toolName: name,
        toolState: 'running',
        text: args ? args.slice(0, 4_000) : '',
        time,
        order,
      };
      tools.set(callId, item);
      items.push(item);
      continue;
    }

    if (type === 'tool/result') {
      const message = isObject(data.message) ? data.message : {};
      const source = isObject(message.source) ? message.source : {};
      const callId = asString(source.callId);
      if (!callId) continue;
      const tool = tools.get(callId);
      if (tool) {
        const blocks = Array.isArray(message.content) ? message.content : [];
        const failed = blocks.some((block) => isObject(block) && block.isError === true) || isObject(data.error);
        tool.toolState = failed ? 'failed' : 'done';
      }
    }
  }

  for (const draft of drafts.values()) {
    if (draft.text || draft.reasoning) items.push(draft);
  }
  return items
    .sort((left, right) => left.order - right.order)
    .slice(-240)
    .map(({ order: _order, ...item }) => item);
}

export class DshConversationClient {
  private readonly baseUrl: URL;
  private readonly workspaceId: string;
  private readonly workspace: DshConversationClientOptions['workspace'];
  private readonly onChanged: () => void;
  private sessions = new Map<string, RawSessionSummary>();
  private workspaceSessionIds = new Set<string>();
  private selectedSessionId: string | undefined;
  private history: HistoryPage = { events: [], hasMore: false };
  private stopped = false;
  private sockets = new Set<WebSocket>();
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshPromise: Promise<void> | undefined;

  constructor(options: DshConversationClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.workspaceId = options.workspaceId;
    this.workspace = options.workspace;
    this.onChanged = options.onChanged;
  }

  async start(): Promise<void> {
    await this.refreshIndex();
    const first = [...this.sessions.values()].find((session) => !session.blank)
      ?? [...this.sessions.values()][0];
    if (first) {
      this.selectedSessionId = first.sessionId;
      await this.loadHistory(first.sessionId);
    }
    this.openStream('events.mux');
    this.openStream('events.host');
  }

  stop(): void {
    this.stopped = true;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }

  snapshot(): ConversationSnapshot {
    const sessions = [...this.sessions.values()]
      .filter((session) => this.workspaceSessionIds.has(session.sessionId) && (!session.blank || session.sessionId === this.selectedSessionId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session): ConversationSessionSnapshot => ({
        id: session.sessionId,
        title: titleFromSummary(session),
        updatedAt: session.updatedAt,
        running: session.running,
        blank: session.blank,
        ...(session.agentPreset ? { agentPreset: session.agentPreset } : {}),
      }));
    const selected = this.selectedSessionId ? this.sessions.get(this.selectedSessionId) : undefined;
    return {
      status: 'ready',
      workspace: this.workspace,
      sessions,
      ...(selected ? {
        selectedSessionId: selected.sessionId,
        selectedTitle: titleFromSummary(selected),
      } : {}),
      selectedRunning: selected?.running ?? false,
      hasMore: this.history.hasMore,
      items: projectConversationHistory(this.history.events),
    };
  }

  async select(sessionId: string): Promise<ConversationSnapshot> {
    if (!this.workspaceSessionIds.has(sessionId)) throw new Error('会话不属于当前 workspace');
    this.selectedSessionId = sessionId;
    await this.loadHistory(sessionId);
    return this.snapshot();
  }

  async create(): Promise<ConversationSnapshot> {
    let target = [...this.sessions.values()].find((session) => this.workspaceSessionIds.has(session.sessionId) && session.blank);
    if (!target) {
      const created = await this.rpc('session.create', { workspaceId: this.workspaceId });
      if (!isObject(created) || typeof created.sessionId !== 'string') throw new Error('DSH 未返回新会话 id');
      target = {
        sessionId: created.sessionId,
        updatedAt: Date.now(),
        running: false,
        blank: true,
        cwd: this.workspace.path,
        ...(typeof created.agentPreset === 'string' ? { agentPreset: created.agentPreset } : {}),
      };
      this.sessions.set(target.sessionId, target);
      this.workspaceSessionIds.add(target.sessionId);
    }
    this.selectedSessionId = target.sessionId;
    this.history = { events: [], hasMore: false };
    this.notify();
    return this.snapshot();
  }

  async send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    const prompt = text.trim();
    if (!prompt) throw new Error('消息不能为空');
    if (prompt.length > 100_000) throw new Error('消息过长');
    if (!this.selectedSessionId) await this.create();
    const sessionId = this.selectedSessionId!;
    const running = this.sessions.get(sessionId)?.running === true;
    await this.rpc('session.prompt', {
      sessionId,
      mode: running ? 'steer' : 'queue',
      content: [{ type: 'text', text: prompt }],
      ...(clientTimeZone ? { clientTimeZone } : {}),
    });
    const summary = this.sessions.get(sessionId);
    if (summary) {
      summary.running = true;
      summary.blank = false;
      summary.updatedAt = Date.now();
    }
    await this.loadHistory(sessionId).catch(() => undefined);
    this.notify();
    return this.snapshot();
  }

  async cancel(): Promise<ConversationSnapshot> {
    if (!this.selectedSessionId) return this.snapshot();
    await this.rpc('session.cancel', { sessionId: this.selectedSessionId });
    return this.snapshot();
  }

  private async rpc(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const rpcId = randomUUID();
    const target = new URL(`/api/${method}`, this.baseUrl);
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    });
    if (!response.ok) throw new Error(`DSH ${method} 请求失败（HTTP ${response.status}）`);
    const envelope = await response.json() as RpcSuccess | RpcFailure;
    if (!isObject(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isObject(envelope.result)) {
      throw new Error(`DSH ${method} 返回了无效响应`);
    }
    if (envelope.result.ok) return envelope.result.value;
    const code = asString(envelope.result.error.code) ?? 'unknown';
    const message = asString(envelope.result.error.message) ?? '未知错误';
    throw new Error(`${message}（${code}）`);
  }

  private async refreshIndex(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const [sessionValue, workspaceValue] = await Promise.all([
        this.rpc('session.list'),
        this.rpc('workspace.list'),
      ]);
      if (!isObject(sessionValue) || !Array.isArray(sessionValue.items)) throw new Error('DSH 会话列表格式无效');
      if (!isObject(workspaceValue) || !Array.isArray(workspaceValue.items)) throw new Error('DSH workspace 列表格式无效');
      const workspace = workspaceValue.items.find((item) => isObject(item) && item.workspaceId === this.workspaceId);
      if (!isObject(workspace) || !Array.isArray(workspace.sessionIds)) throw new Error('DSH 未注册产品 workspace');
      this.workspaceSessionIds = new Set(workspace.sessionIds.filter((id): id is string => typeof id === 'string'));
      const next = new Map<string, RawSessionSummary>();
      for (const item of sessionValue.items) {
        if (!isObject(item) || typeof item.sessionId !== 'string' || !this.workspaceSessionIds.has(item.sessionId)) continue;
        next.set(item.sessionId, {
          sessionId: item.sessionId,
          updatedAt: asNumber(item.updatedAt) ?? 0,
          running: item.running === true,
          blank: item.blank === true,
          ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
          ...(typeof item.agentPreset === 'string' ? { agentPreset: item.agentPreset } : {}),
          ...(isObject(item.projections) ? { projections: item.projections as RawSessionSummary['projections'] } : {}),
        });
      }
      this.sessions = next;
    })().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  private async loadHistory(sessionId: string): Promise<void> {
    const value = await this.rpc('session.history', { sessionId, maxMessages: 80 });
    if (!isObject(value) || !Array.isArray(value.events)) throw new Error('DSH 会话历史格式无效');
    if (this.selectedSessionId !== sessionId) return;
    this.history = {
      events: value.events.filter((entry): entry is HistoryEntry => isObject(entry) && isObject(entry.event)),
      hasMore: value.hasMore === true,
    };
  }

  private openStream(name: 'events.mux' | 'events.host', attempt = 0): void {
    if (this.stopped) return;
    const url = new URL(`/api/${name}`, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.sockets.add(socket);
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const envelope: unknown = JSON.parse(event.data);
        if (!isObject(envelope) || envelope.type !== 'server-request' || !isObject(envelope.payload)) return;
        if (name === 'events.mux') this.handleMux(envelope.payload);
        else this.handleHost(envelope.payload);
      } catch {
        // A malformed push is isolated from the rest of the Desktop runtime.
      }
    });
    socket.addEventListener('close', () => {
      this.sockets.delete(socket);
      if (this.stopped) return;
      const delay = Math.min(5_000, 300 * (2 ** Math.min(attempt, 4)));
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(timer);
        void this.refreshIndex()
          .then(() => this.selectedSessionId ? this.loadHistory(this.selectedSessionId) : undefined)
          .catch(() => undefined)
          .finally(() => this.openStream(name, attempt + 1));
      }, delay);
      this.reconnectTimers.add(timer);
    });
  }

  private handleMux(frame: Record<string, unknown>): void {
    const type = asString(frame.type);
    const sessionId = asString(frame.sessionId);
    if (!sessionId || !this.workspaceSessionIds.has(sessionId)) return;
    if (type === 'session/event' && isObject(frame.event)) {
      const event = frame.event;
      const seq = asNumber(event.seq);
      const latest = this.history.events.at(-1)?.event;
      const latestSeq = latest ? asNumber(latest.seq) : undefined;
      if (sessionId === this.selectedSessionId && (seq === undefined || latestSeq === undefined || seq > latestSeq)) {
        this.history.events.push({ event, ...(frame.view !== undefined ? { view: frame.view } : {}) });
        if (this.history.events.length > 8_000) this.history.events.splice(0, this.history.events.length - 8_000);
      }
      const summary = this.sessions.get(sessionId);
      if (summary) {
        summary.updatedAt = eventTime(event);
        if (event.type === 'turn/start') {
          summary.running = true;
          summary.blank = false;
        }
        if (event.type === 'turn/end') summary.running = false;
        if (event.type === 'session/title' && isObject(event.data) && typeof event.data.title === 'string') {
          summary.projections = { values: { ...(summary.projections?.values ?? {}), title: event.data.title } };
        }
      }
      this.notify();
      return;
    }
    if (type === 'session/projection' && frame.key === 'title') {
      const summary = this.sessions.get(sessionId);
      if (summary) summary.projections = { values: { ...(summary.projections?.values ?? {}), title: frame.value } };
      this.notify();
    }
  }

  private handleHost(frame: Record<string, unknown>): void {
    const type = asString(frame.type);
    const sessionId = asString(frame.sessionId);
    if (type === 'host/session-status' && sessionId && this.workspaceSessionIds.has(sessionId)) {
      const summary = this.sessions.get(sessionId);
      if (summary) {
        summary.running = frame.running === true;
        if (summary.running) summary.blank = false;
      }
      this.notify();
      return;
    }
    if (type?.startsWith('host/session-') || type === 'host/workspace-changed') {
      void this.refreshIndex().then(() => this.notify()).catch(() => undefined);
    }
  }

  private notify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.onChanged();
    }, 40);
  }
}

export function unavailableConversation(
  workspace: WorkspaceConfigurationSnapshot,
  message?: string,
): ConversationSnapshot {
  return {
    status: workspace.status === 'configured' ? 'unavailable' : 'workspace-required',
    workspace,
    sessions: [],
    selectedRunning: false,
    hasMore: false,
    items: [],
    message: message ?? (workspace.status === 'configured'
      ? 'DSH 会话后端暂时不可用'
      : '请先配置 Wrenyard workspace 路径'),
  };
}
