/**
 * Deterministic, privacy-safe demo data for the session page.
 *
 * This is a source-only showcase tool: it is never bundled into the product.
 * It implements the renderer-facing {@link SessionBridge} facade entirely in
 * memory, with fictional sessions, paths, projects and models, so product
 * screenshots and the promo recording can be captured without a daemon, real
 * workspaces or any personal data.
 *
 * The ledger events are the exact {@link LedgerEvent} shapes the real daemon
 * writes (turns, steps, actions, spans and content), so the renderer's `fold`
 * derives a realistic session model from them.
 */

import type {
  SessionBridge,
  SessionBridgeEventPayload,
  SessionBridgeLivePayload,
  SessionBridgeModelEntry,
  SessionBridgeTaskBrief,
  SessionSeenState,
} from '../../src/session/preload.ts';
import type { ReasoningEffort } from '@wrenyard/models';
import type {
  ContextInspection,
  ContextItem,
  ContextItemKind,
  ContextLayerTokens,
  LedgerEvent,
  LedgerEventDraft,
  LiveCall,
  ProjectSnapshot,
  SessionFile,
  SessionSummary,
  WorkspaceSnapshot,
} from '@wrenyard/protocol/session';

// ─── Fixed fictional facts ─────────────────────────────────────────────────

/** Module-load clock; every seeded timestamp is relative to it. */
const T0 = Date.now();

/** Fictional workspace root: never a real path. */
const WORKSPACE_ROOT = '~/workspace';
/** Fictional device name: never a real hostname. */
const DEVICE_NAME = 'Demo MacBook Pro';
/** Fictional workspace-level instructions frozen into every snapshot. */
const WORKSPACE_AGENTS = `# 工作区约定

- 代码与注释使用英文，面向用户的文案使用中文。
- 提交前必须运行相关测试。
- 不要把密钥、真实用户数据写入仓库。`;

/** Fictional memory index; exactly three memories. */
const MEMORY_INDEX = `# 记忆索引

- memories/aurora-billing-conventions.md — Aurora 计费的约定与重试策略
- memories/release-notes-style.md — 发布说明的写作风格
- memories/testing-standards.md — 测试与覆盖率要求`;

const AURORA_AGENTS_CONTENT = `# aurora 项目指令

- billing 相关改动必须保持向后兼容。
- 重试策略变更需要在 docs/specs 下新增或更新规格文档。
- 所有公开函数都需要单元测试覆盖。`;

const SPEC_CONTENT = `# Billing 重试策略规格

## 背景
支付网关在高峰期会返回瞬时 5xx，当前客户端固定重试 3 次、每次间隔 2s。

## 目标
改为指数退避并加入抖动，降低重试风暴。

## 方案
- 基数 500ms，系数 2，上限 30s。
- 采用 full jitter：延迟取 [0, exp] 之间的随机值。
- 仅对可重试错误重试，参数错误立即失败。

## 验收
- billing/retry.ts 实现指数退避与抖动。
- 单元测试覆盖重试次数、间隔上限与抖动范围。`;

const MEMORY_BILLING_CONTENT = `# Aurora 计费模块约定

- 重试实现集中在 billing/retry.ts，不要在其他模块复制。
- 配置项通过 billing/config.ts 注入，便于测试。
- 涉及金额的日志必须脱敏。`;

/** The search action's understanding of the first step. */
const DOC_SEARCH_OUTPUT = '需要在 aurora 计费模块找到重试策略的规格与约定。';

/** Reason text of the featured turn's first step: message content only. */
const REASON_TURN1_STEP1 = `我打算分两步：先把 aurora 的 billing 重试实现读出来，确认当前策略；再改成带抖动的指数退避并补齐单测。`;

const SEARCH_INTENT_1 = '读取 aurora 计费重试相关的规格与约定';

const ACTION_INTENT_1 = `派发任务给 aurora：探查 billing/retry.ts 的现有重试实现，给出文件位置、重试次数与间隔，并指出可复用的测试工具。
验收标准：说明现有实现的关键参数与文件位置。`;

const ACTION_INTENT_2 = `派发任务给 aurora：将 billing 重试逻辑改为指数退避 + full jitter（base 500ms、factor 2、上限 30s），补齐单元测试。
验收标准：实现可在 billing/retry.ts 找到，新增测试覆盖重试次数、间隔上限与抖动范围。`;

/** Reason text of the featured turn's second step: message content only. */
const REASON_TURN1_STEP2 = `两个任务都已返回，改动看起来正确。我再派发一次测试，确认 aurora 的 billing 相关用例全部通过。`;

const ACTION_INTENT_3 = `派发任务给 aurora：运行 billing 相关的单元测试并报告结果。
验收标准：全部测试通过，或列出失败用例与原因。`;

/** Chinese titles (at most 20 characters) for the dispatched actions. */
const ACTION_TITLE_1 = '探查现有重试实现';
const ACTION_TITLE_2 = '改为指数退避并补测';
const ACTION_TITLE_3 = '运行 billing 单元测试';

/** Task-declared output files, projected from `files.attached` events. */
const RETRY_SOURCE_FILE: SessionFile = {
  path: '~/workspace/projects/aurora/billing/retry.ts',
  name: 'retry.ts',
  kind: 'file',
  mime: 'text/plain',
  bytes: 4_096,
  hash: 'd3m0retry5ource',
  source: 'task',
  description: '指数退避与 full jitter 实现',
  taskRunId: 'task_demo02',
  actionId: 'a3',
};

const PROGRESS_REPLY_1 = '已派发 explore 与 edit 两个任务，正在执行；完成后我会继续。';

const FINAL_REPLY_1 = `已把 aurora 的 billing 重试改为带抖动的指数退避，并补上了测试。

- \`billing/retry.ts\`：改为指数退避，基数 500ms、系数 2、上限 30s。
- 加入 full jitter，避免重试风暴。
- 新增 6 个单元测试，覆盖次数、上限与抖动范围。

\`\`\`ts
const base = 500;
const factor = 2;
const max = 30_000;
const exp = Math.min(max, base * factor ** attempt);
const delay = Math.random() * exp; // full jitter
\`\`\`

要我为这些改动开一个 PR 吗？`;

const TURN2_TEXT = '顺便看看 console 有没有同样的问题';

const REASON_TURN2 = 'console 首页加载慢同样与重试无关，更像是首屏 bundle 偏大。';

const FINAL_REPLY_2 = 'console 的首页慢主要是首屏 bundle 过大，和 aurora 的重试问题不是一回事。建议先做代码分割，我可以继续跟进。';

/** Live scene: one streaming reasoning span, then a reply delivered whole when its span ends. */
const LIVE_REASONING_CHUNKS = ['熔断应包在退避之外：', '统计窗口内失败率超过阈值后', '直接短路，冷却后半开探测。'];
const LIVE_REASON_TEXT_CHUNKS = ['在 retry 外层加熔断器，', '复用现有指标，', '补充状态切换测试。'];
const LIVE_REPLY = [
  '已经在 billing 重试外层加上了熔断：',
  '最近 20 次调用中失败率超过 50% 时，',
  '熔断器打开并暂停 30 秒，',
  '之后放行一次探测请求，',
  '成功即恢复。',
  '新增 4 个状态切换测试，全部通过。',
  '要一起更新运维文档吗？',
].join('');

/** Next-input suggestion offered under the composer. */
const PROMPT_SUGGESTION = '为这次 billing 重试改动开一个 PR';

// ─── Fictional model catalogue ─────────────────────────────────────────────

interface ModelSpec {
  publicId: string;
  displayName: string;
  providerDisplayName: string;
  /** Route-owned, non-empty effort ladder the picker may offer. */
  reasoningEfforts: ReasoningEffort[];
  contextWindow?: number;
  maxOutputTokens?: number;
  effectiveTps?: number;
  free?: boolean;
  quotaState?: 'abundant' | 'sufficient' | 'insufficient' | 'exhausted';
  supportsFast?: boolean;
}

const MODEL_SPECS: readonly ModelSpec[] = [
  {
    publicId: 'anthropic/claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    providerDisplayName: 'Anthropic',
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effectiveTps: 62,
    supportsFast: true,
  },
  { publicId: 'anthropic/claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', providerDisplayName: 'Anthropic', reasoningEfforts: ['none', 'low', 'medium', 'high'], contextWindow: 1_000_000, maxOutputTokens: 64_000, effectiveTps: 88 },
  { publicId: 'chatgpt/gpt-6-sol', displayName: 'GPT 6 Sol', providerDisplayName: 'ChatGPT', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], contextWindow: 1_050_000, maxOutputTokens: 128_000, effectiveTps: 71, quotaState: 'abundant', supportsFast: true },
  { publicId: 'kimi-coding/kimi-k3', displayName: 'Kimi K3', providerDisplayName: 'Kimi Coding', reasoningEfforts: ['none', 'low', 'medium', 'high'], contextWindow: 1_048_576, maxOutputTokens: 32_768, effectiveTps: 54, quotaState: 'abundant' },
  { publicId: 'zhipu-coding/glm-5.3', displayName: 'GLM 5.3', providerDisplayName: 'Zhipu Coding', reasoningEfforts: ['none', 'low', 'medium'], contextWindow: 200_000, maxOutputTokens: 32_000, effectiveTps: 66 },
  { publicId: 'deepseek/deepseek-v4.1', displayName: 'DeepSeek V4.1', providerDisplayName: 'DeepSeek', reasoningEfforts: ['none', 'low', 'medium', 'high'], contextWindow: 1_000_000, maxOutputTokens: 64_000, effectiveTps: 48 },
  { publicId: 'opencode-zen/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', providerDisplayName: 'OpenCode Zen', reasoningEfforts: ['none', 'low', 'medium'], contextWindow: 1_000_000, maxOutputTokens: 32_000, effectiveTps: 140, free: true },
  // Window facts unknown on the gateway: the picker shows them as unknown.
  { publicId: 'cursor/composer-2', displayName: 'Composer 2', providerDisplayName: 'Cursor', reasoningEfforts: ['none', 'medium', 'high'] },
];

const MODEL_ENTRIES: SessionBridgeModelEntry[] = MODEL_SPECS.map((spec) => {
  const separator = spec.publicId.indexOf('/');
  return {
    publicId: spec.publicId,
    provider: spec.publicId.slice(0, separator),
    providerDisplayName: spec.providerDisplayName,
    quotaProvider: spec.publicId.slice(0, separator),
    model: spec.publicId.slice(separator + 1),
    displayName: spec.displayName,
    runtime: spec.publicId.startsWith('chatgpt/') ? 'openai_responses' : spec.publicId.startsWith('anthropic/') ? 'anthropic_messages' : 'openai_chat',
    reasoningEfforts: [...spec.reasoningEfforts],
    ...(spec.contextWindow === undefined ? {} : { contextWindow: spec.contextWindow }),
    ...(spec.maxOutputTokens === undefined ? {} : { maxOutputTokens: spec.maxOutputTokens }),
    ...(spec.effectiveTps === undefined ? {} : { effectiveTps: spec.effectiveTps }),
    ...(spec.free ? { free: true } : {}),
    ...(spec.quotaState === undefined ? {} : { quotaState: spec.quotaState }),
    ...(spec.supportsFast ? { supportsFast: true } : {}),
  };
});

const MODEL_METADATA = new Map(
  MODEL_SPECS.map((spec) => [spec.publicId, { contextWindow: spec.contextWindow, maxOutputTokens: spec.maxOutputTokens }] as const),
);

/** The expensive model every featured turn starts with. */
const DEFAULT_MODEL = { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' as ReasoningEffort };
/** The cheap model that serves auxiliary roles. */
const AUX_MODEL = 'opencode-zen/deepseek-v4.1-flash';

// ─── Context-inspection token table ────────────────────────────────────────

/** Resident layer sizes match the featured ledger's assembled views. */
const RESIDENT_LAYERS = { system: 6_200, global: 3_900, role: 300, workspace: 9_800, info: 450 } as const;

const REASON_ITEM_TOKENS: Record<string, number> = { 's1.3': 12_000, 's1.9': 8_000, 's2.1': 6_000 };
const ACTION_ITEM_TOKENS: Record<string, number> = { a1: 1_200, a2: 2_400, a3: 2_100, a4: 2_400 };

// ─── Helpers ───────────────────────────────────────────────────────────────

/** A sink that appends a draft with the next sequence number at a fixed time. */
type Sink = (at: string, draft: LedgerEventDraft) => LedgerEvent;

/** Seconds-ago to an ISO 8601 timestamp relative to module load. */
function sec(secondsAgo: number): string {
  return new Date(T0 - secondsAgo * 1_000).toISOString();
}

function makeSink(events: LedgerEvent[]): Sink {
  return (at, draft) => {
    const event = { ...draft, seq: events.length + 1, at } as LedgerEvent;
    events.push(event);
    return event;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

interface ModelSpanArgs {
  /** Seconds-ago of the span start. */
  at: number;
  /** Span duration in seconds. */
  seconds: number;
  id: string;
  parent: string;
  /** Auxiliary role; omitted for a reasoning span. */
  role?: 'title' | 'memory-search' | 'search' | 'dispatch' | 'document' | 'vcs' | 'reply';
  model: string;
  effort: ReasoningEffort;
  turn: number;
  step?: number;
  layers: Record<string, number>;
  inputEstimate: number;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  output: string;
  reasoning?: string;
}

/** Append the `span.started` + `span.context` + `span.finished` triple of one model request. */
function appendModelSpan(sink: Sink, args: ModelSpanArgs): void {
  const kind = args.role === undefined ? 'reasoning' : 'auxiliary';
  const position = { turn: args.turn, ...(args.step === undefined ? {} : { step: args.step }) };
  sink(sec(args.at), {
    type: 'span.started',
    id: args.id,
    parent: args.parent,
    kind,
    ...position,
    request: {
      ...(args.role === undefined ? {} : { role: args.role }),
      model: args.model,
      effort: { requested: args.effort, sent: args.effort },
      inputEstimate: args.inputEstimate,
      layers: args.layers,
    },
  });
  const endedAt = sec(args.at - args.seconds);
  sink(endedAt, { type: 'span.context', id: args.id, kind, ...position, model: args.model, inputTokens: args.inputTokens });
  sink(endedAt, {
    type: 'span.finished',
    id: args.id,
    kind,
    ...position,
    status: 'ok',
    output: args.output,
    ...(args.reasoning === undefined ? {} : { reasoning: args.reasoning }),
    requestModel: args.model,
    metrics: {
      finishReason: args.role === undefined ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: args.inputTokens,
        cachedInputTokens: args.cachedInputTokens ?? 0,
        outputTokens: args.outputTokens,
        reasoningTokens: args.reasoningTokens ?? 0,
      },
      ttftMs: 900,
      streamMs: Math.max(200, args.seconds * 1_000 - 900),
      streamTokens: args.outputTokens,
      attempts: [{ status: 200, ms: args.seconds * 1_000, model: args.model }],
    },
  });
}

interface TaskSpanArgs {
  at: number;
  seconds: number;
  id: string;
  /** The dispatch action. */
  parent: string;
  turn: number;
  step: number;
  task: string;
  taskRunId: string;
  inputTokens: number;
  outputTokens: number;
}

/** Append the `span.started` + `span.finished` pair of one dispatched agent task. */
function appendTaskSpan(sink: Sink, args: TaskSpanArgs): void {
  sink(sec(args.at), {
    type: 'span.started',
    id: args.id,
    parent: args.parent,
    kind: 'task',
    turn: args.turn,
    step: args.step,
    request: { task: args.task, project: 'aurora', taskRunId: args.taskRunId },
  });
  sink(sec(args.at - args.seconds), {
    type: 'span.finished',
    id: args.id,
    kind: 'task',
    turn: args.turn,
    step: args.step,
    status: 'ok',
    metrics: {
      taskStatus: 'done',
      usage: { inputTokens: args.inputTokens, outputTokens: args.outputTokens },
      generationMs: args.seconds * 600,
      outputTps: 180,
    },
  });
}

const REASON_LAYERS = { 'wy-system': 5_200, 'wy-global': 3_800, 'wy-role': 280, 'wy-workspace': 9_600, 'wy-info': 420 };

/** The three fictional projects every snapshot lists. */
function buildProjects(): ProjectSnapshot[] {
  return [
    {
      id: 'aurora',
      displayName: 'Aurora',
      workspaceDir: 'projects/aurora',
      checkoutPath: '~/workspace/projects/aurora',
      gitRemote: 'https://github.com/example/aurora.git',
      defaultBranch: 'main',
      branch: 'feat/billing-backoff',
      head: 'a1b2c3d',
      tasks: [
        { id: 'explore', description: '检索代码与资料并给出结论', inputSummary: ['目标', '范围'] },
        { id: 'edit', description: '修改代码并自测', inputSummary: ['目标', '验收'] },
        { id: 'test', description: '运行测试并报告结果', inputSummary: ['范围'] },
      ],
      recentDocs: [
        { path: 'projects/aurora/docs/specs/2026-09-28-billing-retry.md', title: 'Billing 重试策略' },
        { path: 'projects/aurora/docs/reports/2026-09-22-billing-latency.md', title: 'Billing 延迟报告' },
      ],
    },
    {
      id: 'console',
      displayName: 'Console',
      workspaceDir: 'projects/console',
      checkoutPath: '~/workspace/projects/console',
      gitRemote: 'https://github.com/example/console.git',
      defaultBranch: 'main',
      branch: 'main',
      head: 'd4e5f6a',
      tasks: [
        { id: 'explore', description: '检索代码与资料并给出结论', inputSummary: ['目标', '范围'] },
        { id: 'edit', description: '修改代码并自测', inputSummary: ['目标', '验收'] },
        { id: 'test', description: '运行测试并报告结果', inputSummary: ['范围'] },
      ],
      recentDocs: [
        { path: 'projects/console/docs/reports/2026-09-30-console-bundle-analysis.md', title: '首页 Bundle 分析' },
      ],
    },
    {
      id: 'docs-site',
      displayName: 'Docs Site',
      workspaceDir: 'projects/docs-site',
      checkoutPath: '~/workspace/projects/docs-site',
      gitRemote: 'https://github.com/example/docs-site.git',
      defaultBranch: 'main',
      branch: 'main',
      head: '9f8e7d6',
      tasks: [{ id: 'edit', description: '修改文档并自测', inputSummary: ['目标'] }],
      recentDocs: [],
    },
  ];
}

function buildSnapshot(takenAt: string): WorkspaceSnapshot {
  return {
    takenAt,
    deviceName: DEVICE_NAME,
    agents: WORKSPACE_AGENTS,
    memoryIndex: MEMORY_INDEX,
    builtinTasks: [
      { id: 'explore', description: '检索代码与资料并给出结论', inputSummary: ['目标', '范围'] },
      { id: 'edit', description: '修改代码并自测', inputSummary: ['目标', '验收'] },
      { id: 'test', description: '运行测试并报告结果', inputSummary: ['范围'] },
      { id: 'commit', description: '创建经过验证的本地提交', inputSummary: ['范围'] },
    ],
    projects: buildProjects(),
  };
}

function summarize(sessionId: string, events: LedgerEvent[]): SessionSummary {
  let summary: SessionSummary = {
    sessionId,
    title: '新会话',
    createdAt: events[0]?.at ?? new Date(T0).toISOString(),
    updatedAt: events[0]?.at ?? new Date(T0).toISOString(),
  };
  for (const event of events) summary = applyToSummary(summary, event);
  return summary;
}

function applyToSummary(summary: SessionSummary, event: LedgerEvent): SessionSummary {
  const next: SessionSummary = { ...summary, updatedAt: event.at };
  if (event.type === 'session.titled' && event.text.trim() !== '') next.title = event.text.trim();
  if (event.type === 'session.metadata') {
    if (event.pinned !== undefined) next.pinned = event.pinned;
    if (event.archived !== undefined) next.archived = event.archived;
  }
  if (event.type === 'turn.started') delete next.lastTurn;
  if (event.type === 'turn.finished' && event.turn !== undefined) {
    next.lastTurn = { status: event.status, finishedAt: event.at, turn: event.turn };
  }
  return next;
}

function nextTurn(events: readonly LedgerEvent[]): number {
  let highest = 0;
  for (const event of events) {
    if (typeof event.turn === 'number' && event.turn > highest) highest = event.turn;
  }
  return highest + 1;
}

// ─── Context inspection derivation ─────────────────────────────────────────

function contextKind(event: LedgerEvent): ContextItemKind | undefined {
  switch (event.type) {
    case 'turn.started':
      return 'user';
    case 'reasoning.completed':
      return 'assistant';
    case 'reasoning.thinking':
      return 'thinking';
    case 'reply.sent':
      return 'reply';
    case 'document.content':
      return 'doc';
    case 'document.found':
      return 'search';
    case 'memory.recalled':
      return 'memory';
    case 'files.attached':
      return 'files';
    case 'action.finished':
      return 'action-result';
    case 'workspace.changed':
      return 'ws-update';
    case 'turn.interrupted':
      return 'interrupt';
    case 'system.error':
      return 'error';
    default:
      return undefined;
  }
}

function contextLabel(event: LedgerEvent): string {
  switch (event.type) {
    case 'turn.started':
    case 'reasoning.completed':
    case 'reasoning.thinking':
    case 'reply.sent':
      return firstLine(event.text);
    case 'document.content':
    case 'memory.recalled':
      return event.path;
    case 'workspace.changed':
      return event.target;
    case 'document.found':
      return firstLine(event.understanding);
    case 'files.attached':
      return event.files.map((file) => file.path).join(', ');
    case 'system.error':
      return firstLine(event.message);
    case 'turn.interrupted':
      return event.reason;
    case 'action.finished': {
      const line = firstLine(event.result);
      return line === '' ? event.action.type : line;
    }
    default:
      return '';
  }
}

function contextTokens(event: LedgerEvent): number {
  switch (event.type) {
    case 'turn.started':
      return 40;
    case 'reasoning.thinking':
      return 320;
    case 'reasoning.completed':
      return REASON_ITEM_TOKENS[event.parent] ?? 1_800;
    case 'reply.sent':
      return event.kind === 'final' ? 1_600 : 120;
    case 'document.content':
      return event.tokens;
    case 'document.found':
      return 1_200;
    case 'memory.recalled':
      return 1_800;
    case 'files.attached':
      return 160;
    case 'action.finished':
      return ACTION_ITEM_TOKENS[event.id] ?? 800;
    default:
      return 40;
  }
}

/** One context item per rendered ledger event, in timeline order. */
function contextItemsFor(events: readonly LedgerEvent[]): ContextItem[] {
  const items: ContextItem[] = [];
  for (const event of events) {
    const kind = contextKind(event);
    if (kind === undefined) continue;
    items.push({
      seq: event.seq,
      turn: event.turn ?? 0,
      ...(event.step === undefined ? {} : { step: event.step }),
      kind,
      label: contextLabel(event),
      tokens: contextTokens(event),
    });
  }
  return items;
}

function lastReasonCalibration(events: readonly LedgerEvent[]): ContextInspection['calibration'] {
  const starts = new Map<string, { model: string; estimated: number }>();
  let calibration: ContextInspection['calibration'];
  for (const event of events) {
    if (event.type === 'span.started' && event.kind === 'reasoning') {
      starts.set(event.id, { model: event.request.model, estimated: event.request.inputEstimate });
    }
    if (event.type === 'span.finished' && event.kind === 'reasoning') {
      const start = starts.get(event.id);
      const actual = event.metrics?.usage?.inputTokens;
      if (start && actual !== undefined) calibration = { spanId: event.id, model: start.model, estimated: start.estimated, actual };
    }
  }
  return calibration;
}

// ─── Public API ────────────────────────────────────────────────────────────

/** The id of the featured session (index 0 in every list). */
const FEATURED_ID = 'demo-aurora-billing-retry';

export function createDemoSession(): { api: SessionBridge; playTurn(text: string): Promise<void> } {
  const sessions = new Map<string, LedgerEvent[]>();
  const summaries = new Map<string, SessionSummary>();
  const eventListeners = new Set<(payload: SessionBridgeEventPayload) => void>();
  const liveListeners = new Set<(payload: SessionBridgeLivePayload) => void>();
  const seen: SessionSeenState = { baselineAt: new Date(T0).toISOString(), seen: {} };
  let created = 0;

  function register(sessionId: string, events: LedgerEvent[]): void {
    sessions.set(sessionId, events);
    summaries.set(sessionId, summarize(sessionId, events));
  }

  function appendEvent(sessionId: string, draft: LedgerEventDraft, at: Date = new Date()): LedgerEvent {
    const events = sessions.get(sessionId);
    if (!events) throw new Error(`Unknown session: ${sessionId}`);
    const event = { ...draft, seq: events.length + 1, at: at.toISOString() } as LedgerEvent;
    events.push(event);
    const current = summaries.get(sessionId) ?? summarize(sessionId, []);
    summaries.set(sessionId, applyToSummary(current, event));
    for (const listener of [...eventListeners]) listener({ sessionId, event });
    return event;
  }

  function emitLive(sessionId: string, live: LiveCall[]): void {
    const snapshot = live.map((call) => ({ ...call }));
    for (const listener of [...liveListeners]) listener({ sessionId, live: snapshot });
  }

  // ── Featured session ledger ──────────────────────────────────────────────

  const featured: LedgerEvent[] = [];
  {
    const push = makeSink(featured);
    const snapshot = buildSnapshot(sec(2_520));

    push(sec(2_520), { type: 'session.created', workspaceRoot: WORKSPACE_ROOT, snapshot });
    push(sec(2_520), {
      type: 'turn.started',
      turn: 1,
      id: 't1',
      text: '帮我把 aurora 的 billing 重试逻辑改成指数退避，加上抖动，并补齐测试。',
      model: DEFAULT_MODEL,
    });

    // The title and the first step's memory recall run on the cheap model.
    appendModelSpan(push, {
      at: 2_519, seconds: 1, id: 's1.1', parent: 't1', role: 'title', model: AUX_MODEL, effort: 'none', turn: 1,
      layers: { 'wy-system': 260, 'wy-title': 400 }, inputEstimate: 900, inputTokens: 910, outputTokens: 14,
      output: '支付重试改为指数退避',
    });
    push(sec(2_518), { type: 'session.titled', turn: 1, parent: 's1.1', text: '支付重试改为指数退避' });
    appendModelSpan(push, {
      at: 2_519, seconds: 2, id: 's1.2', parent: 't1', role: 'memory-search', model: AUX_MODEL, effort: 'none', turn: 1, step: 1,
      layers: { 'wy-system': 1_800, 'wy-memory-search': 900 }, inputEstimate: 2_800, inputTokens: 2_840, outputTokens: 90,
      output: '找到与计费重试相关的记忆：memories/aurora-billing-conventions.md。',
    });
    push(sec(2_517), {
      type: 'memory.recalled',
      turn: 1,
      step: 1,
      parent: 's1.2',
      version: 'v4',
      source: 'memory-search',
      path: 'memories/aurora-billing-conventions.md',
      content: MEMORY_BILLING_CONTENT,
    });

    // Step 1: the main model reasons once and declares a search plus two dispatches.
    push(sec(2_517), { type: 'step.started', id: 't1.1', parent: 't1', turn: 1, step: 1, model: 'anthropic/claude-opus-5-5', contextWindow: 1_000_000 });
    appendModelSpan(push, {
      at: 2_516, seconds: 14, id: 's1.3', parent: 't1.1', model: 'anthropic/claude-opus-5-5', effort: 'high', turn: 1, step: 1,
      layers: { ...REASON_LAYERS, 'wy-ctx': 41_000 }, inputEstimate: 61_240, inputTokens: 61_240, cachedInputTokens: 52_100,
      outputTokens: 1_830, reasoningTokens: 640, output: REASON_TURN1_STEP1,
      reasoning: '先读现有实现，确认重试参数；然后改成指数退避，加 full jitter，最后补测试。',
    });
    push(sec(2_502), { type: 'reasoning.thinking', turn: 1, step: 1, parent: 's1.3', text: '先读现有实现，确认重试参数；然后改成指数退避，加 full jitter，最后补测试。' });
    push(sec(2_502), {
      type: 'reasoning.completed',
      turn: 1,
      step: 1,
      parent: 's1.3',
      text: REASON_TURN1_STEP1,
      workerOutput: `${REASON_TURN1_STEP1}\n- search: ${SEARCH_INTENT_1}\n- dispatch: ${firstLine(ACTION_INTENT_1)}\n- dispatch: ${firstLine(ACTION_INTENT_2)}`,
    });

    push(sec(2_502), { type: 'action.started', turn: 1, step: 1, id: 'a1', parent: 't1.1', action: { type: 'search', prompt: SEARCH_INTENT_1 }, input: { type: 'search', intent: SEARCH_INTENT_1 } });
    push(sec(2_502), { type: 'action.started', turn: 1, step: 1, id: 'a2', parent: 't1.1', action: { type: 'dispatch', prompt: ACTION_INTENT_1 }, input: { type: 'dispatch', intent: ACTION_INTENT_1 } });
    push(sec(2_502), { type: 'action.started', turn: 1, step: 1, id: 'a3', parent: 't1.1', action: { type: 'dispatch', prompt: ACTION_INTENT_2 }, input: { type: 'dispatch', intent: ACTION_INTENT_2 } });

    push(sec(2_502), { type: 'action.titled', turn: 1, step: 1, id: 'a1', title: '读取计费重试规格' });
    push(sec(2_501), {
      type: 'document.found',
      turn: 1,
      step: 1,
      parent: 'a1',
      understanding: DOC_SEARCH_OUTPUT,
      picks: [
        { path: 'projects/aurora/docs/specs/2026-09-28-billing-retry.md', title: 'Billing 重试策略规格', reason: '本次改动对应的规格文档' },
      ],
      near: [
        { path: 'projects/aurora/docs/reports/2026-09-22-billing-latency.md', title: 'Billing 延迟报告', reason: '同一模块的历史分析' },
      ],
      notes: ['项目指令始终加载'],
    });
    push(sec(2_501), {
      type: 'document.content',
      turn: 1,
      step: 1,
      parent: 'a1',
      path: 'projects/aurora/AGENTS.md',
      title: 'Aurora 项目指令',
      updated: '2026-09-20',
      version: 'v3',
      tokens: 3_100,
      content: AURORA_AGENTS_CONTENT,
      format: 'full',
      source: 'project-instructions',
    });
    push(sec(2_501), {
      type: 'document.content',
      turn: 1,
      step: 1,
      parent: 'a1',
      path: 'projects/aurora/docs/specs/2026-09-28-billing-retry.md',
      title: 'Billing 重试策略',
      updated: '2026-09-28',
      version: 'v2',
      tokens: 12_400,
      content: SPEC_CONTENT,
      format: 'full',
      source: 'read',
    });
    push(sec(2_500), { type: 'action.finished', turn: 1, step: 1, id: 'a1', action: { type: 'search' }, status: 'done', result: '已加载规格与项目指令。' });

    // Each dispatch is compiled by the cheap model, titled, then run as an agent task.
    appendModelSpan(push, {
      at: 2_501, seconds: 2, id: 's1.4', parent: 'a2', role: 'dispatch', model: AUX_MODEL, effort: 'none', turn: 1, step: 1,
      layers: { 'wy-system': 2_000, 'wy-compile': 1_500 }, inputEstimate: 3_600, inputTokens: 3_640, outputTokens: 320,
      output: '{"task":"explore","project":"aurora"}',
    });
    push(sec(2_499), { type: 'action.titled', turn: 1, step: 1, id: 'a2', title: ACTION_TITLE_1 });
    appendModelSpan(push, {
      at: 2_501, seconds: 2, id: 's1.5', parent: 'a3', role: 'dispatch', model: AUX_MODEL, effort: 'none', turn: 1, step: 1,
      layers: { 'wy-system': 2_000, 'wy-compile': 1_400 }, inputEstimate: 3_500, inputTokens: 3_520, outputTokens: 300,
      output: '{"task":"edit","project":"aurora"}',
    });
    push(sec(2_499), { type: 'action.titled', turn: 1, step: 1, id: 'a3', title: ACTION_TITLE_2 });

    appendModelSpan(push, {
      at: 2_498, seconds: 2, id: 's1.6', parent: 't1.1', role: 'reply', model: AUX_MODEL, effort: 'none', turn: 1, step: 1,
      layers: { 'wy-system': 1_200, 'wy-workspace': 5_000, 'wy-ctx': 400, 'wy-status': 120 }, inputEstimate: 6_400, inputTokens: 6_460, outputTokens: 60,
      output: PROGRESS_REPLY_1,
    });
    push(sec(2_496), { type: 'reply.sent', turn: 1, step: 1, parent: 's1.6', text: PROGRESS_REPLY_1, kind: 'progress' });

    appendTaskSpan(push, { at: 2_499, seconds: 59, id: 's1.7', parent: 'a2', turn: 1, step: 1, task: 'explore', taskRunId: 'task_demo01', inputTokens: 18_400, outputTokens: 640 });
    push(sec(2_440), {
      type: 'action.finished',
      turn: 1,
      step: 1,
      id: 'a2',
      action: { type: 'dispatch' },
      status: 'done',
      result: '现有实现为固定 3 次间隔 2s 重试，位于 billing/retry.ts。',
      task: 'explore',
      taskStatus: 'done',
      taskRunId: 'task_demo01',
    });
    appendTaskSpan(push, { at: 2_499, seconds: 119, id: 's1.8', parent: 'a3', turn: 1, step: 1, task: 'edit', taskRunId: 'task_demo02', inputTokens: 42_100, outputTokens: 3_800 });
    push(sec(2_380), {
      type: 'files.attached',
      turn: 1,
      step: 1,
      parent: 'a3',
      source: 'task',
      taskRunId: 'task_demo02',
      files: [RETRY_SOURCE_FILE],
    });
    push(sec(2_380), {
      type: 'action.finished',
      turn: 1,
      step: 1,
      id: 'a3',
      action: { type: 'dispatch' },
      status: 'done',
      result: '已改为指数退避（base 500ms, factor 2, max 30s）+ full jitter，新增 6 个单测。',
      task: 'edit',
      taskStatus: 'done',
      taskRunId: 'task_demo02',
    });
    push(sec(2_380), { type: 'step.finished', turn: 1, step: 1, id: 't1.1', status: 'done' });

    // Step 2: one more dispatch to verify, then the closing reply.
    push(sec(2_379), { type: 'step.started', id: 't1.2', parent: 't1', turn: 1, step: 2, model: 'anthropic/claude-opus-5-5', contextWindow: 1_000_000, lastInputTokens: 61_240 });
    appendModelSpan(push, {
      at: 2_379, seconds: 14, id: 's1.9', parent: 't1.2', model: 'anthropic/claude-opus-5-5', effort: 'high', turn: 1, step: 2,
      layers: { ...REASON_LAYERS, 'wy-ctx': 44_600 }, inputEstimate: 66_900, inputTokens: 66_900, cachedInputTokens: 61_000,
      outputTokens: 920, reasoningTokens: 300, output: REASON_TURN1_STEP2, reasoning: '两个任务结果都正常，最后跑一遍 billing 测试确认。',
    });
    push(sec(2_365), { type: 'reasoning.thinking', turn: 1, step: 2, parent: 's1.9', text: '两个任务结果都正常，最后跑一遍 billing 测试确认。' });
    push(sec(2_365), {
      type: 'reasoning.completed',
      turn: 1,
      step: 2,
      parent: 's1.9',
      text: REASON_TURN1_STEP2,
      workerOutput: `${REASON_TURN1_STEP2}\n- dispatch: ${firstLine(ACTION_INTENT_3)}`,
    });
    push(sec(2_365), { type: 'action.started', turn: 1, step: 2, id: 'a4', parent: 't1.2', action: { type: 'dispatch', prompt: ACTION_INTENT_3 }, input: { type: 'dispatch', intent: ACTION_INTENT_3 } });
    appendModelSpan(push, {
      at: 2_364, seconds: 1, id: 's1.10', parent: 'a4', role: 'dispatch', model: AUX_MODEL, effort: 'none', turn: 1, step: 2,
      layers: { 'wy-system': 2_000, 'wy-compile': 1_300 }, inputEstimate: 3_400, inputTokens: 3_430, outputTokens: 280,
      output: '{"task":"test","project":"aurora"}',
    });
    push(sec(2_363), { type: 'action.titled', turn: 1, step: 2, id: 'a4', title: ACTION_TITLE_3 });
    appendTaskSpan(push, { at: 2_363, seconds: 43, id: 's1.11', parent: 'a4', turn: 1, step: 2, task: 'test', taskRunId: 'task_demo03', inputTokens: 9_600, outputTokens: 420 });
    push(sec(2_320), {
      type: 'action.finished',
      turn: 1,
      step: 2,
      id: 'a4',
      action: { type: 'dispatch' },
      status: 'done',
      result: '12 个测试全部通过。',
      task: 'test',
      taskStatus: 'done',
      taskRunId: 'task_demo03',
    });
    appendModelSpan(push, {
      at: 2_319, seconds: 3, id: 's1.12', parent: 't1.2', role: 'reply', model: AUX_MODEL, effort: 'none', turn: 1, step: 2,
      layers: { 'wy-system': 1_200, 'wy-workspace': 5_200, 'wy-ctx': 800, 'wy-status': 120 }, inputEstimate: 8_200, inputTokens: 8_240, outputTokens: 380,
      output: FINAL_REPLY_1,
    });
    push(sec(2_316), { type: 'reply.sent', turn: 1, step: 2, parent: 's1.12', text: FINAL_REPLY_1, kind: 'final' });
    push(sec(2_316), { type: 'step.finished', turn: 1, step: 2, id: 't1.2', status: 'done' });
    push(sec(2_315), { type: 'turn.finished', turn: 1, id: 't1', status: 'completed' });

    // Turn 2: one short completed turn with a single reasoning step.
    push(sec(2_280), { type: 'turn.started', turn: 2, id: 't2', text: TURN2_TEXT, model: DEFAULT_MODEL });
    push(sec(2_279), { type: 'step.started', id: 't2.1', parent: 't2', turn: 2, step: 1, model: 'anthropic/claude-opus-5-5', contextWindow: 1_000_000, lastInputTokens: 66_900 });
    appendModelSpan(push, {
      at: 2_278, seconds: 14, id: 's2.1', parent: 't2.1', model: 'anthropic/claude-opus-5-5', effort: 'high', turn: 2, step: 1,
      layers: { ...REASON_LAYERS, 'wy-ctx': 48_400 }, inputEstimate: 69_900, inputTokens: 70_200, cachedInputTokens: 66_000,
      outputTokens: 640, reasoningTokens: 220, output: REASON_TURN2, reasoning: 'console 的加载慢和重试无关，指向首屏 bundle。',
    });
    push(sec(2_264), { type: 'reasoning.thinking', turn: 2, step: 1, parent: 's2.1', text: 'console 的加载慢和重试无关，指向首屏 bundle。' });
    push(sec(2_264), { type: 'reasoning.completed', turn: 2, step: 1, parent: 's2.1', text: REASON_TURN2 });
    appendModelSpan(push, {
      at: 2_263, seconds: 2, id: 's2.2', parent: 't2.1', role: 'reply', model: AUX_MODEL, effort: 'none', turn: 2, step: 1,
      layers: { 'wy-system': 1_200, 'wy-workspace': 5_200, 'wy-ctx': 600, 'wy-status': 120 }, inputEstimate: 7_100, inputTokens: 7_140, outputTokens: 90,
      output: FINAL_REPLY_2,
    });
    push(sec(2_261), { type: 'reply.sent', turn: 2, step: 1, parent: 's2.2', text: FINAL_REPLY_2, kind: 'final' });
    push(sec(2_261), { type: 'step.finished', turn: 2, step: 1, id: 't2.1', status: 'done' });
    push(sec(2_260), { type: 'turn.finished', turn: 2, id: 't2', status: 'completed' });

    // Turn 3: a document action updates the spec, then a vcs action commits.
    push(sec(2_200), {
      type: 'turn.started',
      turn: 3,
      id: 't3',
      text: '把这次的改动提交一下，并把规格文档更新到最新实现。',
      model: DEFAULT_MODEL,
    });
    const reason3 = '改动已验证，我先更新规格文档，然后提交这次工作区改动。';
    push(sec(2_199), { type: 'step.started', id: 't3.1', parent: 't3', turn: 3, step: 1, model: 'anthropic/claude-opus-5-5', contextWindow: 1_000_000, lastInputTokens: 70_200 });
    appendModelSpan(push, {
      at: 2_198, seconds: 10, id: 's3.1', parent: 't3.1', model: 'anthropic/claude-opus-5-5', effort: 'high', turn: 3, step: 1,
      layers: { ...REASON_LAYERS, 'wy-ctx': 52_200 }, inputEstimate: 73_400, inputTokens: 73_800, cachedInputTokens: 70_000,
      outputTokens: 520, reasoningTokens: 180, output: reason3, reasoning: '先更新规格文档，再把 billing 改动提交到当前分支。',
    });
    push(sec(2_188), { type: 'reasoning.thinking', turn: 3, step: 1, parent: 's3.1', text: '先更新规格文档，再把 billing 改动提交到当前分支。' });
    push(sec(2_188), {
      type: 'reasoning.completed',
      turn: 3,
      step: 1,
      parent: 's3.1',
      text: reason3,
      workerOutput: `${reason3}\n- document: 把 Billing 重试策略规格更新为指数退避 + full jitter 的实现\n- vcs: 提交 billing 重试改动与规格更新`,
    });

    const documentIntent = '把 Billing 重试策略规格更新为指数退避 + full jitter 的实现';
    push(sec(2_187), { type: 'action.started', turn: 3, step: 1, id: 'a5', parent: 't3.1', action: { type: 'document', prompt: documentIntent }, input: { type: 'document', intent: documentIntent } });
    appendModelSpan(push, {
      at: 2_187, seconds: 1, id: 's3.2', parent: 'a5', role: 'document', model: AUX_MODEL, effort: 'none', turn: 3, step: 1,
      layers: { 'wy-system': 2_000, 'wy-document': 1_400 }, inputEstimate: 3_200, inputTokens: 3_240, outputTokens: 260,
      output: '{"path":"projects/aurora/docs/specs/2026-09-28-billing-retry.md"}',
    });
    push(sec(2_186), { type: 'action.titled', turn: 3, step: 1, id: 'a5', title: '更新重试策略规格' });
    push(sec(2_185), {
      type: 'document.content',
      turn: 3,
      step: 1,
      parent: 'a5',
      path: 'projects/aurora/docs/specs/2026-09-28-billing-retry.md',
      title: 'Billing 重试策略',
      updated: '2026-10-01',
      version: 'v3',
      tokens: 12_900,
      content: SPEC_CONTENT,
      format: 'full',
      source: 'write',
    });
    push(sec(2_185), {
      type: 'workspace.changed',
      turn: 3,
      step: 1,
      parent: 'a5',
      scope: 'document',
      target: 'projects/aurora/docs/specs/2026-09-28-billing-retry.md',
      change: 'updated',
      version: 'v3',
    });
    push(sec(2_184), { type: 'action.finished', turn: 3, step: 1, id: 'a5', action: { type: 'document' }, status: 'done', result: '规格已更新为指数退避 + full jitter 方案。' });

    const vcsIntent = '提交 billing 重试改动与规格更新';
    push(sec(2_183), { type: 'action.started', turn: 3, step: 1, id: 'a6', parent: 't3.1', action: { type: 'vcs', prompt: vcsIntent }, input: { type: 'vcs', intent: vcsIntent } });
    appendModelSpan(push, {
      at: 2_183, seconds: 1, id: 's3.3', parent: 'a6', role: 'vcs', model: AUX_MODEL, effort: 'none', turn: 3, step: 1,
      layers: { 'wy-system': 2_000, 'wy-vcs': 1_600 }, inputEstimate: 3_600, inputTokens: 3_640, outputTokens: 280,
      output: '{"operation":"commit","project":"aurora"}',
    });
    push(sec(2_182), { type: 'action.titled', turn: 3, step: 1, id: 'a6', title: '提交重试改动' });
    push(sec(2_181), {
      type: 'workspace.changed',
      turn: 3,
      step: 1,
      parent: 'a6',
      scope: 'project',
      target: 'aurora',
      change: 'committed',
      hash: 'b7c4d9e',
      files: ['billing/retry.ts', 'docs/specs/2026-09-28-billing-retry.md'],
    });
    push(sec(2_180), { type: 'action.finished', turn: 3, step: 1, id: 'a6', action: { type: 'vcs' }, status: 'done', result: '已提交，commit b7c4d9e。' });

    const reply3 = '规格已更新，改动也已经提交（commit b7c4d9e）。需要我开一个 PR 吗？';
    appendModelSpan(push, {
      at: 2_179, seconds: 2, id: 's3.4', parent: 't3.1', role: 'reply', model: AUX_MODEL, effort: 'none', turn: 3, step: 1,
      layers: { 'wy-system': 1_200, 'wy-workspace': 5_400, 'wy-ctx': 1_200, 'wy-status': 120 }, inputEstimate: 9_100, inputTokens: 9_160, outputTokens: 340,
      output: reply3,
    });
    push(sec(2_177), { type: 'reply.sent', turn: 3, step: 1, parent: 's3.4', text: reply3, kind: 'final' });
    push(sec(2_177), { type: 'step.finished', turn: 3, step: 1, id: 't3.1', status: 'done' });
    push(sec(2_176), { type: 'turn.finished', turn: 3, id: 't3', status: 'completed' });
    push(sec(2_175), { type: 'turn.attention', turn: 3, turnId: 't3', needsUser: true, label: '等你确认开 PR', source: 'ask' });
    push(sec(2_175), { type: 'session.metadata', pinned: true });
  }
  register(FEATURED_ID, featured);

  // ── Four short sessions ──────────────────────────────────────────────────

  interface SimpleSessionArgs {
    id: string;
    createdAt: number;
    user: string;
    reply: string;
    title: string;
  }

  function seedSimpleSession(args: SimpleSessionArgs): void {
    const events: LedgerEvent[] = [];
    const push = makeSink(events);
    const sonnet = 'anthropic/claude-sonnet-5-5';
    push(sec(args.createdAt), { type: 'session.created', workspaceRoot: WORKSPACE_ROOT, snapshot: buildSnapshot(sec(args.createdAt)) });
    push(sec(args.createdAt), {
      type: 'turn.started',
      turn: 1,
      id: 't1',
      text: args.user,
      model: { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' },
    });
    appendModelSpan(push, {
      at: args.createdAt - 1, seconds: 1, id: 's1.1', parent: 't1', role: 'title', model: AUX_MODEL, effort: 'none', turn: 1,
      layers: { 'wy-system': 260, 'wy-title': 300 }, inputEstimate: 620, inputTokens: 640, outputTokens: 12, output: args.title,
    });
    push(sec(args.createdAt - 2), { type: 'session.titled', turn: 1, parent: 's1.1', text: args.title });
    push(sec(args.createdAt - 2), { type: 'step.started', id: 't1.1', parent: 't1', turn: 1, step: 1, model: sonnet, contextWindow: 1_000_000 });
    appendModelSpan(push, {
      at: args.createdAt - 2, seconds: 8, id: 's1.2', parent: 't1.1', model: sonnet, effort: 'medium', turn: 1, step: 1,
      layers: { ...REASON_LAYERS, 'wy-ctx': 2_400 }, inputEstimate: 21_700, inputTokens: 21_900, cachedInputTokens: 19_100,
      outputTokens: 320, reasoningTokens: 120, output: args.reply, reasoning: '快速确认结论后直接回复。',
    });
    push(sec(args.createdAt - 10), { type: 'reasoning.completed', turn: 1, step: 1, parent: 's1.2', text: args.reply });
    push(sec(args.createdAt - 12), { type: 'reply.sent', turn: 1, step: 1, text: args.reply, kind: 'final' });
    push(sec(args.createdAt - 12), { type: 'step.finished', turn: 1, step: 1, id: 't1.1', status: 'done' });
    push(sec(args.createdAt - 13), { type: 'turn.finished', turn: 1, id: 't1', status: 'completed' });
    register(args.id, events);
  }

  seedSimpleSession({
    id: 'demo-cli-json',
    createdAt: 9_000,
    user: '给 CLI 增加 --json 输出，方便脚本消费。',
    reply: '已经为 CLI 增加了 --json 输出，结果以稳定的 JSON 结构打印，方便脚本解析。默认的人类可读输出保持不变，两者互不影响。',
    title: 'CLI 增加 --json 输出',
  });
  seedSimpleSession({
    id: 'demo-sqlite-wal',
    createdAt: 12_600,
    user: '调研一下 SQLite WAL 模式下的写放大问题。',
    reply: '调研完成：WAL 模式在高频小事务下写放大会明显上升，主要通过合并事务与调整 checkpoint 频率来缓解。详细结论与测试数据整理在报告里。',
    title: '调研 SQLite WAL 写放大',
  });
  seedSimpleSession({
    id: 'demo-release-notes',
    createdAt: 18_000,
    user: '帮我把本周的改动整理成发布说明。',
    reply: '本周发布说明已整理完成，涵盖 8 项改动与 2 项修复。内容按功能、修复与已知问题分组，可以直接发布。',
    title: '整理本周发布说明',
  });
  seedSimpleSession({
    id: 'demo-console-perf',
    createdAt: 108_000,
    user: 'console 首页最近加载很慢，看看是什么原因。',
    reply: '初步定位到首屏 bundle 偏大，以及一次重复的接口请求，两者叠加拖慢了加载。建议先做代码分割并缓存接口结果，我可以继续跟进。',
    title: 'console 首页加载变慢排查',
  });

  // ── Live streaming (send + playTurn) ─────────────────────────────────────

  async function runTurn(
    sessionId: string,
    turn: number,
    text: string,
    model: { provider: string; model: string; reasoningEffort: ReasoningEffort },
  ): Promise<void> {
    const modelPublicId = `${model.provider}/${model.model}`;
    const turnId = `t${turn}`;
    const stepId = `${turnId}.1`;
    const reasonSpanId = `live${turn}.reason`;
    const replySpanId = `live${turn}.reply`;
    const position = { turn, step: 1 };
    const live: LiveCall[] = [];

    appendEvent(sessionId, { type: 'turn.started', turn, id: turnId, text, model });
    await sleep(150);
    appendEvent(sessionId, { type: 'step.started', id: stepId, parent: turnId, ...position, model: modelPublicId, contextWindow: MODEL_METADATA.get(modelPublicId)?.contextWindow });
    appendEvent(sessionId, {
      type: 'span.started',
      id: reasonSpanId,
      parent: stepId,
      kind: 'reasoning',
      ...position,
      request: { model: modelPublicId, effort: { requested: model.reasoningEffort, sent: model.reasoningEffort }, inputEstimate: 74_600, layers: { ...REASON_LAYERS, 'wy-ctx': 53_100 } },
    });

    const reasonLive: LiveCall = { spanId: reasonSpanId, text: '', reasoning: '' };
    live.push(reasonLive);
    emitLive(sessionId, live);
    for (const chunk of LIVE_REASONING_CHUNKS) {
      reasonLive.reasoning += chunk;
      emitLive(sessionId, live);
      await sleep(280);
    }
    for (const chunk of LIVE_REASON_TEXT_CHUNKS) {
      reasonLive.text += chunk;
      emitLive(sessionId, live);
      await sleep(280);
    }

    live.length = 0;
    emitLive(sessionId, live);
    const reasonText = LIVE_REASON_TEXT_CHUNKS.join('');
    appendEvent(sessionId, { type: 'span.context', id: reasonSpanId, kind: 'reasoning', ...position, model: modelPublicId, inputTokens: 74_700 });
    appendEvent(sessionId, {
      type: 'span.finished',
      id: reasonSpanId,
      kind: 'reasoning',
      ...position,
      status: 'ok',
      output: reasonText,
      reasoning: LIVE_REASONING_CHUNKS.join(''),
      requestModel: modelPublicId,
      metrics: {
        finishReason: 'stop',
        usage: { inputTokens: 74_700, cachedInputTokens: 73_000, outputTokens: 180, reasoningTokens: 90 },
        ttftMs: 320,
        attempts: [{ status: 200, ms: 1_700, model: modelPublicId }],
      },
    });
    appendEvent(sessionId, { type: 'reasoning.thinking', ...position, parent: reasonSpanId, text: LIVE_REASONING_CHUNKS.join('') });
    appendEvent(sessionId, { type: 'reasoning.completed', ...position, parent: reasonSpanId, text: reasonText });
    await sleep(250);

    appendEvent(sessionId, {
      type: 'span.started',
      id: replySpanId,
      parent: stepId,
      kind: 'auxiliary',
      ...position,
      request: { role: 'reply', model: AUX_MODEL, effort: { requested: 'none', sent: 'none' }, inputEstimate: 6_800, layers: { 'wy-system': 2_400, 'wy-ctx': 3_600, 'wy-info': 900 } },
    });
    await sleep(1_800);
    appendEvent(sessionId, {
      type: 'span.finished',
      id: replySpanId,
      kind: 'auxiliary',
      ...position,
      status: 'ok',
      output: LIVE_REPLY,
      requestModel: AUX_MODEL,
      metrics: { finishReason: 'stop', usage: { inputTokens: 6_900, outputTokens: 120 }, ttftMs: 300, attempts: [{ status: 200, ms: 1_800, model: AUX_MODEL }] },
    });
    appendEvent(sessionId, { type: 'reply.sent', ...position, parent: replySpanId, text: LIVE_REPLY, kind: 'final' });
    appendEvent(sessionId, { type: 'step.finished', ...position, id: stepId, status: 'done' });
    appendEvent(sessionId, { type: 'turn.finished', turn, id: turnId, status: 'completed' });
  }

  async function playTurn(text: string): Promise<void> {
    const events = sessions.get(FEATURED_ID);
    if (!events) return;
    await runTurn(FEATURED_ID, nextTurn(events), text, DEFAULT_MODEL);
  }

  // ── Bridge implementation ────────────────────────────────────────────────

  const seenListeners = new Set<(state: SessionSeenState) => void>();

  const api: SessionBridge = {
    async list(): Promise<SessionSummary[]> {
      return [...summaries.values()]
        .map((summary) => ({ ...summary }))
        .sort((a, b) => {
          if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
          return a.sessionId.localeCompare(b.sessionId);
        });
    },
    async create(): Promise<{ sessionId: string }> {
      created += 1;
      const sessionId = `demo-new-${created}`;
      const events: LedgerEvent[] = [];
      makeSink(events)(new Date().toISOString(), {
        type: 'session.created',
        workspaceRoot: WORKSPACE_ROOT,
        snapshot: buildSnapshot(new Date().toISOString()),
      });
      register(sessionId, events);
      return { sessionId };
    },
    async ledger(sessionId: string): Promise<LedgerEvent[]> {
      return [...(sessions.get(sessionId) ?? [])];
    },
    async ledgerSnapshot(sessionId: string): Promise<LedgerEvent[]> {
      return [...(sessions.get(sessionId) ?? [])];
    },
    async send(request): Promise<{ turn: number }> {
      const events = sessions.get(request.sessionId);
      if (!events) throw new Error(`Unknown session: ${request.sessionId}`);
      const turn = nextTurn(events);
      void runTurn(request.sessionId, turn, request.text, {
        provider: request.model.provider,
        model: request.model.model,
        reasoningEffort: request.model.reasoningEffort,
      });
      return { turn };
    },
    async mediaRead(request) {
      return { path: request.path };
    },
    async revealMedia(): Promise<void> {
      // The demo has no files on disk.
    },
    async deleteSession(sessionId: string): Promise<void> {
      sessions.delete(sessionId);
      summaries.delete(sessionId);
    },
    async renameSession(sessionId: string, title: string): Promise<void> {
      appendEvent(sessionId, { type: 'session.titled', text: title, manual: true });
    },
    async updateMetadata(sessionId, patch): Promise<void> {
      appendEvent(sessionId, { type: 'session.metadata', ...patch });
    },
    async selectAttachments() {
      return [];
    },
    async describeAttachments() {
      return [];
    },
    async stageClipboardImage(input) {
      return { id: 'demo-clipboard', name: input.name ?? 'image.png', bytes: 0, dataUrl: input.dataUrl };
    },
    async discardDraftAttachments(): Promise<void> {
      // Nothing is staged in the demo.
    },
    pathForFile(): string {
      return '';
    },
    async interrupt(): Promise<void> {
      // The demo has nothing to interrupt.
    },
    async cancelTask(): Promise<void> {
      // The demo has no dispatched task runs to cancel.
    },
    async models(): Promise<SessionBridgeModelEntry[]> {
      return MODEL_ENTRIES.map((entry) => ({ ...entry, reasoningEfforts: [...entry.reasoningEfforts] }));
    },
    async contextInspect(request) {
      const meta = MODEL_METADATA.get(request.model);
      const model: ContextInspection['model'] = {
        publicId: request.model,
        ...(meta?.contextWindow === undefined ? {} : { contextWindow: meta.contextWindow }),
        ...(meta?.maxOutputTokens === undefined ? {} : { maxOutputTokens: meta.maxOutputTokens }),
      };
      const resident: ContextLayerTokens[] = [
        { id: 'wy-system', tokens: RESIDENT_LAYERS.system },
        { id: 'wy-global', tokens: RESIDENT_LAYERS.global },
        { id: 'wy-role', tokens: RESIDENT_LAYERS.role },
        { id: 'wy-workspace', tokens: RESIDENT_LAYERS.workspace },
      ];
      const events = request.sessionId === undefined ? undefined : sessions.get(request.sessionId);
      if (events === undefined) {
        const totalTokens = resident.reduce((sum, layer) => sum + layer.tokens, 0);
        return { computedAtSeq: 0, estimator: 'o200k_base', model, layers: resident, items: [], totalTokens };
      }
      const items = contextItemsFor(events);
      const ctxTokens = items.reduce((sum, item) => sum + item.tokens, 0);
      const layers: ContextLayerTokens[] = [
        ...resident,
        { id: 'wy-ctx', tokens: ctxTokens },
        { id: 'wy-info', tokens: RESIDENT_LAYERS.info },
      ];
      const totalTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0);
      const calibration = lastReasonCalibration(events);
      return {
        computedAtSeq: events.length > 0 ? events[events.length - 1]!.seq : 0,
        estimator: 'o200k_base',
        model,
        layers,
        items,
        totalTokens,
        ...(calibration === undefined ? {} : { calibration }),
      };
    },
    async routesPreview() {
      const roles = ['reply', 'dispatch', 'document', 'vcs', 'project', 'search', 'memory-search', 'title', 'status', 'suggestion'] as const;
      return {
        roles: roles.map((role) => ({ role, model: AUX_MODEL, modelName: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, reasoningEffort: 'none' as ReasoningEffort })),
      };
    },
    async promptSuggest(request) {
      return request.sessionId === FEATURED_ID ? { suggestion: PROMPT_SUGGESTION } : {};
    },
    async promptCancel(): Promise<void> {
      // Suggestions resolve immediately in the demo.
    },
    async tasks(taskRunIds: string[]): Promise<SessionBridgeTaskBrief[]> {
      const usage = (inputTokens: number, outputTokens: number) => ({
        completeness: 'complete' as const,
        attemptCount: 1,
        usageEventCount: 1,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        referenceCostComplete: false,
      });
      const known: Record<string, SessionBridgeTaskBrief> = {
        task_demo01: {
          taskRunId: 'task_demo01',
          taskName: 'explore',
          status: 'done',
          runtime: 'kimi-coding/kimi-k3:claude',
          summary: '现有实现为固定 3 次间隔 2s 重试，位于 billing/retry.ts。',
          usage: usage(18_400, 640),
        },
        task_demo02: {
          taskRunId: 'task_demo02',
          taskName: 'edit',
          status: 'done',
          runtime: 'chatgpt/gpt-6-sol:codex',
          summary: '已改为指数退避（base 500ms, factor 2, max 30s）+ full jitter，新增 6 个单测。',
          usage: usage(42_100, 3_800),
        },
        task_demo03: {
          taskRunId: 'task_demo03',
          taskName: 'test',
          status: 'done',
          runtime: 'opencode-zen/deepseek-v4.1-flash:opencode',
          summary: '12 个测试全部通过。',
          usage: usage(9_600, 420),
        },
      };
      return taskRunIds.map((id) => known[id] ?? { taskRunId: id, status: 'unavailable' });
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onLive(listener) {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    async markSeen(sessionId: string): Promise<void> {
      seen.seen[sessionId] = new Date().toISOString();
      for (const listener of [...seenListeners]) listener({ ...seen, seen: { ...seen.seen } });
    },
    async getSeen(): Promise<SessionSeenState> {
      return { ...seen, seen: { ...seen.seen } };
    },
    onSeenChanged(listener) {
      seenListeners.add(listener);
      return () => {
        seenListeners.delete(listener);
      };
    },
  };

  return { api, playTurn };
}
