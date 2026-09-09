import { randomUUID } from 'node:crypto';
import { canonicalizeBuiltinPublicModelId } from '@wrenyard/providers';
import { parseTaskRunSnapshot } from './stats-snapshot.js';
import type {
  ConversationItemSnapshot,
  ConversationModelGroupSnapshot,
  ConversationModelsSnapshot,
  ConversationModelSelectionSnapshot,
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
  /**
   * Canonical product provider ids whose credentials were passed to the DSH
   * child. Copied defensively; used to filter the advertised model directory.
   */
  configuredProviderIds: readonly string[];
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

const MAX_TOOL_RESULT_TEXT = 16_000;

/**
 * Bounded raw text for a DSH tool/result message: the joined text of every
 * nested `tool-result` block, including text blocks inside each block's
 * `content`. Capped so escaped terminal payloads stay within renderer limits.
 */
function extractToolResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool-result') continue;
    const inner = block.content;
    if (typeof inner === 'string') {
      if (inner) parts.push(inner);
    } else if (Array.isArray(inner)) {
      for (const innerBlock of inner) {
        if (isObject(innerBlock) && typeof innerBlock.text === 'string' && innerBlock.text) {
          parts.push(innerBlock.text);
        }
      }
    }
  }
  const joined = parts.join('\n\n').trim();
  return joined.length > MAX_TOOL_RESULT_TEXT ? joined.slice(0, MAX_TOOL_RESULT_TEXT) : joined;
}

/** Parse a JSON string into a plain object, or undefined when it is not one. */
function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort parse of a tool/call `arguments` string into its object form. */
function parseToolCallArguments(value: unknown): Record<string, unknown> | undefined {
  return parseJsonObject(value);
}

function titleFromSummary(summary: RawSessionSummary): string {
  const title = summary.projections?.values?.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return summary.blank ? '新会话' : '未命名会话';
}

function eventTime(event: Record<string, unknown>): number {
  return asNumber(event.time) ?? Date.now();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`DSH 模型目录缺少 ${field}`);
  return value;
}

function catalogProviderForRoute(provider: string, model: string): string {
  if (provider !== 'wrenyard') return provider;
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : provider;
}

function canonicalConversationModel(provider: string, model: string): string {
  if (provider === 'wrenyard') return canonicalizeBuiltinPublicModelId(model);
  const canonical = canonicalizeBuiltinPublicModelId(`${provider}/${model}`);
  return canonical.startsWith(`${provider}/`) ? canonical.slice(provider.length + 1) : model;
}

export interface PersistedModelSelectionRepair {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/**
 * Return the one safe persistence repair for a retired public Gateway alias.
 * The provider/catalog directory remains authoritative: this never changes
 * providers, invents a fallback model, or rewrites a genuinely unknown id.
 */
export function persistedModelSelectionRepair(
  selection: unknown,
  groups: ConversationModelGroupSnapshot[],
): PersistedModelSelectionRepair | undefined {
  if (!isObject(selection) || selection.provider !== 'wrenyard' || typeof selection.model !== 'string') return undefined;
  const model = canonicalConversationModel('wrenyard', selection.model);
  if (model === selection.model) return undefined;
  const option = groups
    .find((group) => group.provider === 'wrenyard')
    ?.models.find((candidate) => candidate.model === model);
  if (!option) return undefined;
  return {
    provider: 'wrenyard',
    model,
    ...(option.defaultReasoningEffort ? { reasoningEffort: option.defaultReasoningEffort } : {}),
  };
}

function modelSelectionSnapshot(
  selection: Record<string, unknown>,
  groups: ConversationModelGroupSnapshot[],
  configuredProviderIds?: ReadonlySet<string>,
): ConversationModelSelectionSnapshot {
  const provider = requiredString(selection.provider, 'current.provider');
  const model = canonicalConversationModel(provider, requiredString(selection.model, 'current.model'));
  const group = groups.find((candidate) => candidate.provider === provider);
  const option = group?.models.find((candidate) => candidate.model === model);
  return {
    provider,
    catalogProvider: option?.catalogProvider ?? catalogProviderForRoute(provider, model),
    model,
    label: option?.label ?? model,
    providerLabel: group?.label ?? provider,
    advertised: option !== undefined,
    configured: configuredProviderIds === undefined || configuredProviderIds.has(provider),
    ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort
      ? { reasoningEffort: selection.reasoningEffort }
      : {}),
  };
}

/**
 * Validate and project DSH's `groups` + `failures` arrays into the strict
 * product model directory. Shared between the per-session projection (which
 * also carries `current`/`routable`) and the host-scoped draft projection
 * (groups/failures only). When `configured` is supplied, only providers whose
 * credentials were actually passed to the DSH child are advertised.
 */
function projectModelGroups(
  value: Record<string, unknown>,
  configured?: ReadonlySet<string>,
): { groups: ConversationModelGroupSnapshot[]; failures: string[] } {
  if (!Array.isArray(value.groups) || !Array.isArray(value.failures)) {
    throw new Error('DSH 模型目录格式无效');
  }
  const groups = value.groups.map((rawGroup, groupIndex): ConversationModelGroupSnapshot => {
    if (!isObject(rawGroup) || !Array.isArray(rawGroup.models)) throw new Error(`DSH 模型目录第 ${groupIndex + 1} 组格式无效`);
    const provider = requiredString(rawGroup.id, `groups[${groupIndex}].id`);
    const providerLabel = requiredString(rawGroup.name, `groups[${groupIndex}].name`);
    return {
      provider,
      label: providerLabel,
      models: rawGroup.models.flatMap((rawModel, modelIndex) => {
        if (!isObject(rawModel)) throw new Error(`DSH 模型目录 ${provider} 第 ${modelIndex + 1} 项格式无效`);
        const model = requiredString(rawModel.id, `groups[${groupIndex}].models[${modelIndex}].id`);
        const sourceLabel = requiredString(rawModel.name, `groups[${groupIndex}].models[${modelIndex}].name`);
        const reasoning = isObject(rawModel.reasoning) ? rawModel.reasoning : undefined;
        return [{
          provider,
          catalogProvider: catalogProviderForRoute(provider, model),
          providerLabel,
          model,
          label: sourceLabel,
          ...(typeof rawModel.description === 'string' && rawModel.description
            ? { description: rawModel.description.slice(0, 500) }
            : {}),
          ...(reasoning && typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort
            ? { defaultReasoningEffort: reasoning.defaultEffort }
            : {}),
        }];
      }),
    };
  }).filter((group) => configured === undefined || configured.has(group.provider));
  const failures = value.failures.flatMap((failure) => {
    if (!isObject(failure)) return [];
    const name = asString(failure.name) ?? asString(failure.id) ?? '模型提供方';
    const message = asString(failure.message);
    return message ? [`${name}: ${message}`] : [];
  });
  return { groups, failures };
}

/**
 * Validate and project DSH's advisory per-session model directory. When
 * `configuredProviderIds` is supplied, only providers whose credentials were
 * actually passed to the DSH child are advertised. This projection stays
 * strict about `current` and `routable`: it is only used for `session.models`.
 */
export function projectConversationModels(
  value: unknown,
  configuredProviderIds?: readonly string[],
): ConversationModelsSnapshot {
  if (!isObject(value) || !isObject(value.current)) throw new Error('DSH 模型目录格式无效');
  if (typeof value.routable !== 'boolean') throw new Error('DSH 模型目录缺少 routable');
  const configured = configuredProviderIds === undefined
    ? undefined
    : new Set(configuredProviderIds);
  const { groups, failures } = projectModelGroups(value, configured);
  return {
    status: 'ready',
    groups,
    current: modelSelectionSnapshot(value.current, groups, configured),
    routable: value.routable,
    ...(failures.length > 0 ? { message: failures.join('；').slice(0, 1_000) } : {}),
  };
}

/**
 * Project the host-scoped draft catalog returned by `llm.models`. DSH
 * 0.1.1-rc.2 sends only `groups` and `failures` — there is no `current`
 * selection and no `routable` flag. The picker is therefore seeded without
 * ever fabricating a current model, and `routable` is derived from whether at
 * least one advertised, configured model is present.
 */
export function projectHostModels(
  value: unknown,
  configuredProviderIds?: readonly string[],
): ConversationModelsSnapshot {
  if (!isObject(value)) throw new Error('DSH 模型目录格式无效');
  const configured = configuredProviderIds === undefined
    ? undefined
    : new Set(configuredProviderIds);
  const { groups, failures } = projectModelGroups(value, configured);
  // Every option that survived configured-provider filtering is both
  // advertised by the host catalog and backed by credentials passed to DSH.
  const routable = groups.some((group) => group.models.length > 0);
  return {
    status: 'ready',
    groups,
    current: undefined,
    routable,
    ...(failures.length > 0 ? { message: failures.join('；').slice(0, 1_000) } : {}),
  };
}

/** Fold DSH's durable history protocol into the bounded product-owned renderer model. */
export function projectConversationHistory(entries: HistoryEntry[]): ConversationItemSnapshot[] {
  const items: Array<ConversationItemSnapshot & { order: number }> = [];
  const drafts = new Map<string, ConversationItemSnapshot & { order: number }>();
  const finalizedSteps = new Set<string>();
  const tools = new Map<string, ConversationItemSnapshot & { order: number }>();
  const toolArguments = new Map<string, Record<string, unknown> | undefined>();
  let activeTurnId: string | undefined;

  for (const [order, entry] of entries.entries()) {
    const event = entry.event;
    const type = asString(event.type);
    const data = isObject(event.data) ? event.data : {};
    const seq = asNumber(event.seq) ?? order;
    const time = eventTime(event);

    if (type === 'user/message') {
      if (isObject(data.source) && data.source.kind !== 'user') continue;
      activeTurnId = undefined;
      const text = contentText(data.content);
      if (text) items.push({ id: `user-${seq}`, kind: 'user', text, time, order });
      continue;
    }

    if (type === 'assistant/chunk') {
      const chunk = isObject(data.chunk) ? data.chunk : {};
      const turn = asNumber(data.turn);
      const step = asNumber(data.step) ?? 0;
      const chunkType = asString(chunk.type);
      if (chunkType !== 'text-delta' && chunkType !== 'reasoning-delta') continue;
      const delta = asString(chunk.text) ?? '';
      if (!delta) continue;
      const turnId = turn === undefined ? activeTurnId ?? `assistant-${seq}` : `turn-${turn}`;
      const key = `${turnId}:${step}`;
      activeTurnId = turnId;
      if (finalizedSteps.has(key)) continue;
      const draft = drafts.get(key) ?? {
        id: `assistant-${key}`,
        kind: 'assistant' as const,
        text: '',
        reasoning: '',
        time,
        turnId,
        running: true,
        order,
      };
      if (chunkType === 'reasoning-delta') draft.reasoning = `${draft.reasoning ?? ''}${delta}`;
      else draft.text += delta;
      drafts.set(key, draft);
      continue;
    }

    if (type === 'assistant/message') {
      const turn = asNumber(data.turn);
      const step = asNumber(data.step) ?? 0;
      const turnId = turn === undefined ? activeTurnId ?? `assistant-${seq}` : `turn-${turn}`;
      const key = `${turnId}:${step}`;
      activeTurnId = turnId;
      finalizedSteps.add(key);
      drafts.delete(key);
      const message = isObject(data.message) ? data.message : {};
      const text = contentText(message.content);
      const reasoning = contentText(message.content, 'reasoning');
      if (text || reasoning) {
        items.push({
          id: `assistant-${key}`,
          kind: 'assistant',
          text,
          turnId,
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
      const turn = asNumber(data.turn);
      const turnId = turn === undefined ? activeTurnId : `turn-${turn}`;
      if (turn !== undefined) activeTurnId = turnId;
      const item: ConversationItemSnapshot & { order: number } = {
        id: `tool-${callId}`,
        kind: 'tool',
        toolName: name,
        toolState: 'running',
        text: args ? args.slice(0, 4_000) : '',
        time,
        ...(turnId ? { turnId } : {}),
        order,
      };
      tools.set(callId, item);
      toolArguments.set(callId, parseToolCallArguments(args));
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
        const rawText = extractToolResultText(blocks);
        if (rawText) tool.toolResultText = rawText;
        if (tool.toolName === 'run_task') {
          const resultObject = parseJsonObject(rawText);
          if (resultObject) {
            let candidate: Record<string, unknown> = resultObject;
            if (!asString(candidate.task_id)) {
              const argTaskId = toolArguments.get(callId);
              const fallbackTaskId = argTaskId ? asString(argTaskId.task_id) : undefined;
              if (fallbackTaskId) candidate = { ...candidate, task_id: fallbackTaskId };
            }
            const taskRun = parseTaskRunSnapshot(candidate);
            if (taskRun) tool.taskRun = taskRun;
          }
        }
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
  private readonly configuredProviderIds: ReadonlySet<string>;
  private readonly onChanged: () => void;
  private sessions = new Map<string, RawSessionSummary>();
  private workspaceSessionIds = new Set<string>();
  private selectedSessionId: string | undefined;
  private history: HistoryPage = { events: [], hasMore: false };
  private models: ConversationModelsSnapshot = { status: 'idle', groups: [] };
  private modelGeneration = 0;
  private pendingDraftModel: Pick<ConversationModelSelectionSnapshot, 'provider' | 'model'> | undefined;
  private materializeDraftPromise: Promise<string> | undefined;
  private initialSendPromise: Promise<ConversationSnapshot> | undefined;
  private stopped = false;
  private sockets = new Set<WebSocket>();
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshPromise: Promise<void> | undefined;

  constructor(options: DshConversationClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.workspaceId = options.workspaceId;
    this.workspace = options.workspace;
    this.configuredProviderIds = new Set(options.configuredProviderIds);
    this.onChanged = options.onChanged;
  }

  async start(): Promise<void> {
    await this.refreshIndex();
    // A host-created blank session is only reusable implementation state for
    // the first send; it is not yet a product conversation and must not appear
    // selected in the fresh draft UI.
    const first = [...this.sessions.values()].find((session) => !session.blank);
    if (first) {
      this.selectedSessionId = first.sessionId;
      await this.loadHistory(first.sessionId);
      await this.refreshModels(first.sessionId);
    } else {
      // Fresh workspace with no durable session: load the host-scoped draft
      // model catalog via llm.models so the picker is ready before any session
      // is created. No session.create is issued here.
      await this.refreshModels();
    }
    this.openStream('events.mux');
    this.openStream('events.host');
  }

  stop(): void {
    this.stopped = true;
    this.modelGeneration += 1;
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
      models: this.models,
      hasMore: this.history.hasMore,
      items: projectConversationHistory(this.history.events),
    };
  }

  async select(sessionId: string): Promise<ConversationSnapshot> {
    if (!this.workspaceSessionIds.has(sessionId)) throw new Error('会话不属于当前 workspace');
    this.selectedSessionId = sessionId;
    this.models = { status: 'loading', groups: [] };
    this.notify();
    await this.loadHistory(sessionId);
    await this.refreshModels(sessionId);
    return this.snapshot();
  }

  async create(): Promise<ConversationSnapshot> {
    if (this.initialSendPromise) return this.snapshot();
    const current = this.models.current;
    if (this.selectedSessionId) {
      this.pendingDraftModel = current?.advertised && current.configured
        ? { provider: current.provider, model: current.model }
        : undefined;
    }
    this.modelGeneration += 1;
    this.selectedSessionId = undefined;
    this.history = { events: [], hasMore: false };
    this.notify();
    return this.snapshot();
  }

  async selectModel(provider: string, model: string): Promise<ConversationSnapshot> {
    const option = this.models.groups
      .find((group) => group.provider === provider)
      ?.models.find((candidate) => candidate.model === model);
    if (!option) throw new Error('所选模型不在当前 DSH 模型目录中');

    // Existing-session path: persist the choice through session.selectModel.
    const sessionId = this.selectedSessionId;
    if (sessionId) {
      if (this.models.current?.provider === provider && this.models.current.model === model) return this.snapshot();

      const generation = ++this.modelGeneration;
      this.models = { ...this.models, status: 'loading', message: undefined };
      this.notify();
      try {
        const value = await this.rpc('session.selectModel', {
          sessionId,
          provider,
          model,
          ...(option.defaultReasoningEffort ? { reasoningEffort: option.defaultReasoningEffort } : {}),
        });
        if (!isObject(value) || !isObject(value.selected)) throw new Error('DSH 未返回已选择模型');
        if (generation !== this.modelGeneration || sessionId !== this.selectedSessionId) return this.snapshot();
        this.models = {
          ...this.models,
          status: 'ready',
          current: modelSelectionSnapshot(value.selected, this.models.groups, this.configuredProviderIds),
          routable: true,
          message: undefined,
        };
        this.notify();
        return this.snapshot();
      } catch (error) {
        if (generation === this.modelGeneration && sessionId === this.selectedSessionId) {
          this.models = {
            ...this.models,
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
          this.notify();
        }
        throw error;
      }
    }

    // Draft path (no durable session yet): keep the choice in memory only and
    // reflect it in the snapshot current selection. Never call session.selectModel
    // or session.create here; the first send materializes exactly one session.
    const selected = modelSelectionSnapshot(
      { provider, model, ...(option.defaultReasoningEffort ? { reasoningEffort: option.defaultReasoningEffort } : {}) },
      this.models.groups,
      this.configuredProviderIds,
    );
    this.pendingDraftModel = { provider, model };
    this.models = {
      ...this.models,
      status: 'ready',
      current: selected,
      routable: this.models.routable,
    };
    this.notify();
    return this.snapshot();
  }

  async send(text: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    const prompt = text.trim();
    if (!prompt) throw new Error('消息不能为空');
    if (prompt.length > 100_000) throw new Error('消息过长');
    if (this.initialSendPromise) return this.initialSendPromise;
    if (!this.selectedSessionId) {
      const pending = this.sendInitial(prompt, clientTimeZone);
      this.initialSendPromise = pending;
      try {
        return await pending;
      } finally {
        if (this.initialSendPromise === pending) this.initialSendPromise = undefined;
      }
    }
    return this.sendToSession(this.selectedSessionId, prompt, clientTimeZone);
  }

  private async sendInitial(prompt: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
    const sessionId = await this.materializeDraftSession();
    return this.sendToSession(sessionId, prompt, clientTimeZone);
  }

  private async sendToSession(sessionId: string, prompt: string, clientTimeZone?: string): Promise<ConversationSnapshot> {
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
    if (this.selectedSessionId === sessionId) {
      await this.loadHistory(sessionId).catch(() => undefined);
    }
    this.notify();
    return this.snapshot();
  }

  private async materializeDraftSession(): Promise<string> {
    if (this.selectedSessionId) return this.selectedSessionId;
    if (this.materializeDraftPromise) return this.materializeDraftPromise;

    const pendingModel = this.pendingDraftModel;
    const operation = (async (): Promise<string> => {
      let target = [...this.sessions.values()].find(
        (session) => this.workspaceSessionIds.has(session.sessionId) && session.blank,
      );
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

      let nextModels = await this.fetchModels(target.sessionId);
      if (pendingModel) {
        const option = nextModels.groups
          .find((group) => group.provider === pendingModel.provider)
          ?.models.find((candidate) => candidate.model === pendingModel.model);
        if (!option) {
          throw new Error(`新会话无法使用原选择模型 ${pendingModel.provider}/${pendingModel.model}`);
        }
        if (nextModels.current?.provider !== pendingModel.provider || nextModels.current.model !== pendingModel.model) {
          const value = await this.rpc('session.selectModel', {
            sessionId: target.sessionId,
            provider: pendingModel.provider,
            model: pendingModel.model,
            ...(option.defaultReasoningEffort ? { reasoningEffort: option.defaultReasoningEffort } : {}),
          });
          if (!isObject(value) || !isObject(value.selected)) throw new Error('DSH 未返回已选择模型');
          nextModels = {
            ...nextModels,
            current: modelSelectionSnapshot(value.selected, nextModels.groups, this.configuredProviderIds),
            routable: true,
          };
        }
      }

      if (!this.selectedSessionId) {
        this.selectedSessionId = target.sessionId;
        this.history = { events: [], hasMore: false };
        this.models = nextModels;
        this.pendingDraftModel = undefined;
        this.notify();
      }
      return target.sessionId;
    })();
    this.materializeDraftPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.materializeDraftPromise === operation) this.materializeDraftPromise = undefined;
    }
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

  /**
   * Load the model catalog. With a `sessionId` the per-session directory comes
   * from `session.models`; without one the host-scoped draft catalog comes from
   * `llm.models`. Both share the same strict projection path, so the picker is
   * identically shaped before and after a session exists.
   */
  private async refreshModels(sessionId?: string): Promise<void> {
    const generation = ++this.modelGeneration;
    this.models = { ...this.models, status: 'loading', message: undefined };
    this.notify();
    try {
      const next = await this.fetchModels(sessionId);
      if (generation !== this.modelGeneration) return;
      if (sessionId && sessionId !== this.selectedSessionId) return;
      this.models = next;
      this.notify();
    } catch (error) {
      if (generation !== this.modelGeneration) return;
      if (sessionId && sessionId !== this.selectedSessionId) return;
      this.models = {
        ...this.models,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
      this.notify();
    }
  }

  private async fetchModels(sessionId?: string): Promise<ConversationModelsSnapshot> {
    const value = await this.rpc(sessionId ? 'session.models' : 'llm.models', sessionId ? { sessionId } : {});
    if (!sessionId) return projectHostModels(value, [...this.configuredProviderIds]);
    let next = projectConversationModels(value, [...this.configuredProviderIds]);
    const repair = isObject(value)
      ? persistedModelSelectionRepair(value.current, next.groups)
      : undefined;
    if (!repair) return next;
    const repaired = await this.rpc('session.selectModel', { sessionId, ...repair });
    if (!isObject(repaired) || !isObject(repaired.selected)) throw new Error('DSH 未返回归一化后的模型选择');
    const selected = modelSelectionSnapshot(repaired.selected, next.groups, this.configuredProviderIds);
    if (selected.provider !== repair.provider || selected.model !== repair.model) {
      throw new Error('DSH 未持久化归一化后的模型选择');
    }
    next = { ...next, current: selected };
    return next;
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
          .then(async () => {
            if (!this.selectedSessionId) return;
            await this.loadHistory(this.selectedSessionId);
            await this.refreshModels(this.selectedSessionId);
          })
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
    if (type === 'host/remote-event'
      && (frame.event === 'llm/adapters-updated' || frame.event === 'settings/document-updated')) {
      if (this.selectedSessionId) void this.refreshModels(this.selectedSessionId);
      return;
    }
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
    models: { status: 'idle', groups: [] },
    hasMore: false,
    items: [],
    message: message ?? (workspace.status === 'configured'
      ? 'DSH 会话后端暂时不可用'
      : '请先配置 Wrenyard workspace 路径'),
  };
}
