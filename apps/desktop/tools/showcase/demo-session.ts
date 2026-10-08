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
 * writes, so the renderer's `fold` derives a realistic session model from them.
 */

import type {
  SessionBridge,
  SessionBridgeEventPayload,
  SessionBridgeLivePayload,
  SessionBridgeModelEntry,
  SessionBridgeTaskBrief,
} from '../../src/session/preload.ts';
import type { ReasoningEffort } from '@wrenyard/models';
import type {
  CallRole,
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
  Usage,
  WorkspaceSnapshot,
} from '@wrenyard/session';

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

/** The `doc-search` call's understanding of the first cycle. */
const DOC_SEARCH_OUTPUT = '需要在 aurora 计费模块找到重试策略的规格与约定。';
/** The `memory-search` call's recall summary for the first cycle. */
const MEMORY_SEARCH_OUTPUT = '找到与计费重试相关的记忆：memories/aurora-billing-conventions.md。';

/** Reason text of the featured turn's first cycle: message content only. */
const REASON_TURN1_CYCLE1 = `我打算分两步：先把 aurora 的 billing 重试实现读出来，确认当前策略；再改成带抖动的指数退避并补齐单测。`;

const ACTION_INTENT_1 = `派发任务给 aurora：探查 billing/retry.ts 的现有重试实现，给出文件位置、重试次数与间隔，并指出可复用的测试工具。
验收标准：说明现有实现的关键参数与文件位置。`;

const ACTION_INTENT_2 = `派发任务给 aurora：将 billing 重试逻辑改为指数退避 + full jitter（base 500ms、factor 2、上限 30s），补齐单元测试。
验收标准：实现可在 billing/retry.ts 找到，新增测试覆盖重试次数、间隔上限与抖动范围。`;

/** Reason text of the featured turn's second cycle: message content only. */
const REASON_TURN1_CYCLE2 = `两个任务都已返回，改动看起来正确。我再派发一次测试，确认 aurora 的 billing 相关用例全部通过。`;

const ACTION_INTENT_3 = `派发任务给 aurora：运行 billing 相关的单元测试并报告结果。
验收标准：全部测试通过，或列出失败用例与原因。`;

/** Chinese titles (at most 20 characters) for the dispatched actions. */
const ACTION_TITLE_1 = '探查现有重试实现';
const ACTION_TITLE_2 = '改为指数退避并补测';
const ACTION_TITLE_3 = '运行 billing 单元测试';

const COMPILE_OUTPUT_1 = '{"kind":"dispatch","intent":"派发任务给 aurora：探查 billing/retry.ts 的现有重试实现"}';
const COMPILE_OUTPUT_2 = '{"kind":"dispatch","intent":"派发任务给 aurora：改为指数退避 + full jitter 并补齐单测"}';
const COMPILE_OUTPUT_3 = '{"kind":"dispatch","intent":"派发任务给 aurora：运行 billing 相关单元测试"}';

/** Task-declared output files, projected from `files` events. */
const RETRY_SOURCE_FILE: SessionFile = {
  path: 'projects/aurora/billing/retry.ts',
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

const REPLY_TURN1_CYCLE1 = '已派发 explore 与 edit 两个任务，正在执行；完成后我会继续。';

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

/** Live scene: one streaming reason call, then a reply delivered whole when its call ends. */
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

// ─── Fictional model catalogue ─────────────────────────────────────────────

interface ModelSpec {
  publicId: string;
  displayName: string;
  /** Route-owned, non-empty effort ladder the picker may offer. */
  reasoningEfforts: ReasoningEffort[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

const MODEL_SPECS: readonly ModelSpec[] = [
  {
    publicId: 'anthropic/claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  },
  { publicId: 'anthropic/claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', reasoningEfforts: ['none', 'low', 'medium', 'high'], contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  { publicId: 'chatgpt/gpt-5.6-sol', displayName: 'GPT-5.6 Sol', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], contextWindow: 1_050_000, maxOutputTokens: 128_000 },
  { publicId: 'kimi-coding/kimi-k3', displayName: 'Kimi K3', reasoningEfforts: ['none', 'low', 'medium', 'high'], contextWindow: 1_048_576, maxOutputTokens: 32_768 },
  { publicId: 'zhipu-coding/glm-5.3', displayName: 'GLM-5.3', reasoningEfforts: ['none', 'low', 'medium'], contextWindow: 200_000, maxOutputTokens: 32_000 },
  { publicId: 'deepseek/deepseek-v4.1', displayName: 'DeepSeek V4.1', reasoningEfforts: ['none', 'low', 'medium', 'high'], contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  { publicId: 'deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', reasoningEfforts: ['none', 'low', 'medium'], contextWindow: 1_000_000, maxOutputTokens: 32_000 },
  // Window facts unknown on the gateway: the picker shows them as unknown.
  { publicId: 'cursor/composer-2', displayName: 'Composer 2', reasoningEfforts: ['none', 'medium', 'high'] },
];

const MODEL_ENTRIES: SessionBridgeModelEntry[] = MODEL_SPECS.map((spec) => {
  const separator = spec.publicId.indexOf('/');
  return {
    publicId: spec.publicId,
    provider: spec.publicId.slice(0, separator),
    quotaProvider: spec.publicId.slice(0, separator),
    model: spec.publicId.slice(separator + 1),
    displayName: spec.displayName,
    reasoningEfforts: [...spec.reasoningEfforts],
    ...(spec.contextWindow === undefined ? {} : { contextWindow: spec.contextWindow }),
    ...(spec.maxOutputTokens === undefined ? {} : { maxOutputTokens: spec.maxOutputTokens }),
  };
});

const MODEL_METADATA = new Map(
  MODEL_SPECS.map((spec) => [spec.publicId, { contextWindow: spec.contextWindow, maxOutputTokens: spec.maxOutputTokens }] as const),
);

/** The expensive model every featured turn starts with. */
const DEFAULT_MODEL = { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' };

// ─── Context-inspection token table ────────────────────────────────────────

/** Resident layer sizes match the featured ledger's assembled views. */
const RESIDENT_LAYERS = { system: 6_200, global: 3_900, role: 300, workspace: 9_800, info: 450 } as const;

const REASON_ITEM_TOKENS: Record<string, number> = { c_reason1: 12_000, c_reason2: 8_000, c_reason3: 6_000 };
const REPLY_TOKENS: Record<number, number> = { 1: 1_600, 2: 380 };
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

function tailNumber(publicId: string): { provider: string; model: string } {
  const separator = publicId.indexOf('/');
  return { provider: publicId.slice(0, separator), model: publicId.slice(separator + 1) };
}

interface AppendCallArgs {
  /** Seconds-ago of the call start. */
  at: number;
  /** Call duration in seconds. */
  seconds: number;
  callId: string;
  callRole: CallRole;
  modelPublicId: string;
  turn?: number;
  cycle?: number;
  layers: Record<string, number>;
  estimatedInputTokens: number;
  usage: Usage;
  output: string;
  reasoning?: string;
}

/** Append the `call.started` + terminal `call` pair for one attempt. */
function appendCall(sink: Sink, args: AppendCallArgs): void {
  const startedAt = sec(args.at);
  const endedAt = sec(args.at - args.seconds);
  sink(startedAt, {
    type: 'call.started',
    callId: args.callId,
    role: args.callRole,
    model: args.modelPublicId,
    ...(args.turn === undefined ? {} : { turn: args.turn }),
    ...(args.cycle === undefined ? {} : { cycle: args.cycle }),
  });
  sink(endedAt, {
    type: 'call',
    callId: args.callId,
    role: args.callRole,
    model: args.modelPublicId,
    status: 'ok',
    startedAt,
    endedAt,
    firstTokenAt: sec(args.at - 0.3),
    layers: args.layers,
    estimatedInputTokens: args.estimatedInputTokens,
    usage: args.usage,
    output: args.output,
    ...(args.reasoning === undefined ? {} : { reasoning: args.reasoning }),
    ...(args.turn === undefined ? {} : { turn: args.turn }),
    ...(args.cycle === undefined ? {} : { cycle: args.cycle }),
  });
}

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
      { id: 'doc', description: '撰写或更新文档', inputSummary: ['目标项目', '文档类型', '精确路径', '完整对话'] },
    ],
    projects: buildProjects(),
  };
}

function summarize(sessionId: string, events: LedgerEvent[]): SessionSummary {
  let createdAt = events[0]?.at ?? new Date(T0).toISOString();
  let updatedAt = createdAt;
  let title = '新会话';
  for (const event of events) {
    if (event.type === 'session.created') createdAt = event.at;
    if (event.type === 'title' && event.text.trim() !== '') title = event.text.trim();
    updatedAt = event.at;
  }
  return { sessionId, title, createdAt, updatedAt };
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
    case 'reason.completed':
      return 'assistant';
    case 'thinking':
      return 'thinking';
    case 'reply':
      return 'reply';
    case 'doc.content':
      return 'doc';
    case 'doc.search':
      return 'doc-search';
    case 'memory.recalled':
      return 'memory';
    case 'files':
      return 'files';
    case 'action.finished':
      return 'action-result';
    case 'ws.updated':
      return 'ws-update';
    case 'turn.interrupted':
      return 'interrupt';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

function contextLabel(event: LedgerEvent): string {
  switch (event.type) {
    case 'turn.started':
    case 'reason.completed':
    case 'thinking':
    case 'reply':
      return firstLine(event.text);
    case 'doc.content':
    case 'memory.recalled':
    case 'ws.updated':
      return event.path;
    case 'doc.search':
      return firstLine(event.understanding);
    case 'files':
      return event.files.map((file) => file.name).join('、');
    case 'error':
      return `${event.stage}: ${event.message}`;
    case 'turn.interrupted':
      return event.reason;
    case 'action.finished': {
      const line = firstLine(event.result);
      return line === '' ? event.kind : line;
    }
    default:
      return '';
  }
}

function contextTokens(event: LedgerEvent): number {
  switch (event.type) {
    case 'turn.started':
      return 40;
    case 'thinking':
      return 320;
    case 'reason.completed':
      return REASON_ITEM_TOKENS[event.callId] ?? 1_800;
    case 'reply':
      return REPLY_TOKENS[event.turn ?? 0] ?? 400;
    case 'doc.content':
      return event.tokens;
    case 'doc.search':
      return 1_200;
    case 'memory.recalled':
      return 1_800;
    case 'files':
      return 160;
    case 'action.finished':
      return ACTION_ITEM_TOKENS[event.actionId] ?? 800;
    case 'error':
      return 40;
    case 'ws.updated':
      return 40;
    case 'turn.interrupted':
      return 20;
    default:
      return 0;
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
      ...(event.cycle === undefined ? {} : { cycle: event.cycle }),
      kind,
      label: contextLabel(event),
      tokens: contextTokens(event),
    });
  }
  return items;
}

function lastReasonCalibration(events: readonly LedgerEvent[]): ContextInspection['calibration'] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'call' || event.role !== 'reason') continue;
    const input = event.usage?.input;
    if (input === undefined) continue;
    return { callId: event.callId, model: event.model, estimated: event.estimatedInputTokens, actual: input };
  }
  return undefined;
}

// ─── Public API ────────────────────────────────────────────────────────────

/** The id of the featured session (index 0 in every list). */
const FEATURED_ID = 'demo-aurora-billing-retry';

export function createDemoSession(): { api: SessionBridge; playTurn(text: string): Promise<void> } {
  const sessions = new Map<string, LedgerEvent[]>();
  const summaries = new Map<string, SessionSummary>();
  const eventListeners = new Set<(payload: SessionBridgeEventPayload) => void>();
  const liveListeners = new Set<(payload: SessionBridgeLivePayload) => void>();
  let created = 0;

  function register(sessionId: string, events: LedgerEvent[]): void {
    sessions.set(sessionId, events);
    summaries.set(sessionId, summarize(sessionId, events));
  }

  function appendEvent(sessionId: string, draft: LedgerEventDraft, at: Date): LedgerEvent {
    const events = sessions.get(sessionId);
    if (!events) throw new Error(`Unknown session: ${sessionId}`);
    const event = { ...draft, seq: events.length + 1, at: at.toISOString() } as LedgerEvent;
    events.push(event);
    const current = summaries.get(sessionId);
    const title = event.type === 'title' && event.text.trim() !== ''
      ? event.text.trim()
      : current?.title ?? '新会话';
    summaries.set(sessionId, {
      sessionId,
      title,
      createdAt: current?.createdAt ?? event.at,
      updatedAt: event.at,
    });
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

    push(sec(2_520), { type: 'session.created', format: 3, workspaceRoot: WORKSPACE_ROOT, snapshot });
    push(sec(2_520), {
      type: 'turn.started',
      turn: 1,
      text: '帮我把 aurora 的 billing 重试逻辑改成指数退避，加上抖动，并补齐测试。',
      model: { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' },
    });

    // Cycle 1 prepares context: a doc-search, a read action that loads the
    // specs (doc.search/doc.content) and a memory-search that recalls the
    // billing conventions.
    appendCall(push, {
      at: 2_514,
      seconds: 2,
      callId: 'c_search1',
      callRole: 'doc-search',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      cycle: 1,
      layers: { 'wy-system': 2_600, 'wy-doc-search': 1_400 },
      estimatedInputTokens: 4_100,
      usage: { input: 4_180, cachedInput: 0, output: 120 },
      output: DOC_SEARCH_OUTPUT,
    });
    push(sec(2_512), {
      type: 'action.started',
      turn: 1,
      cycle: 1,
      actionId: 'a1',
      kind: 'read',
      parsed: { kind: 'read', intent: '读取 aurora 计费重试相关的规格与约定' },
    });
    push(sec(2_512), {
      type: 'doc.search',
      turn: 1,
      cycle: 1,
      actionId: 'a1',
      understanding: DOC_SEARCH_OUTPUT,
      picks: [
        { path: 'projects/aurora/docs/specs/2026-09-28-billing-retry.md', title: 'Billing 重试策略规格', reason: '本次改动对应的规格文档' },
      ],
      near: [
        { path: 'projects/aurora/docs/reports/2026-09-22-billing-latency.md', title: 'Billing 延迟报告', reason: '同一模块的历史分析' },
      ],
      notes: ['项目指令始终加载'],
    });
    push(sec(2_511), {
      type: 'doc.content',
      turn: 1,
      cycle: 1,
      actionId: 'a1',
      path: 'projects/aurora/AGENTS.md',
      title: 'Aurora 项目指令',
      updated: '2026-09-20',
      version: 'v3',
      tokens: 3_100,
      content: AURORA_AGENTS_CONTENT,
      format: 'full',
      source: 'project-instructions',
    });
    push(sec(2_511), {
      type: 'doc.content',
      turn: 1,
      cycle: 1,
      actionId: 'a1',
      path: 'projects/aurora/docs/specs/2026-09-28-billing-retry.md',
      title: 'Billing 重试策略',
      updated: '2026-09-28',
      version: 'v2',
      tokens: 12_400,
      content: SPEC_CONTENT,
      format: 'full',
      source: 'read',
    });
    appendCall(push, {
      at: 2_513,
      seconds: 1,
      callId: 'c_mem1',
      callRole: 'memory-search',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      cycle: 1,
      layers: { 'wy-system': 1_800, 'wy-memory-search': 900 },
      estimatedInputTokens: 2_800,
      usage: { input: 2_840, output: 90 },
      output: MEMORY_SEARCH_OUTPUT,
    });
    push(sec(2_511), {
      type: 'memory.recalled',
      turn: 1,
      cycle: 1,
      version: 'v4',
      source: 'memory-search',
      path: 'memories/aurora-billing-conventions.md',
      content: MEMORY_BILLING_CONTENT,
    });
    push(sec(2_510), {
      type: 'action.finished',
      turn: 1,
      cycle: 1,
      actionId: 'a1',
      kind: 'read',
      status: 'done',
      result: '已加载规格、项目指令与计费记忆。',
    });

    appendCall(push, {
      at: 2_510,
      seconds: 14,
      callId: 'c_reason1',
      callRole: 'reason',
      modelPublicId: 'anthropic/claude-opus-5-5',
      turn: 1,
      cycle: 1,
      layers: { 'wy-system': 5_200, 'wy-global': 3_800, 'wy-role': 280, 'wy-workspace': 9_600, 'wy-ctx': 41_000, 'wy-info': 420 },
      estimatedInputTokens: 61_240,
      usage: { input: 61_240, cachedInput: 52_100, output: 1_830, reasoning: 640 },
      output: REASON_TURN1_CYCLE1,
      reasoning: '先读现有实现，确认重试参数；然后改成指数退避，加 full jitter，最后补测试。',
    });
    push(sec(2_496), {
      type: 'thinking',
      turn: 1,
      cycle: 1,
      callId: 'c_reason1',
      text: '先读现有实现，确认重试参数；然后改成指数退避，加 full jitter，最后补测试。',
    });
    push(sec(2_496), { type: 'reason.completed', turn: 1, cycle: 1, callId: 'c_reason1', text: REASON_TURN1_CYCLE1 });

    appendCall(push, {
      at: 2_495,
      seconds: 1,
      callId: 'c_compile1',
      callRole: 'compile',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      cycle: 1,
      layers: { 'wy-system': 2_000, 'wy-compile': 1_500 },
      estimatedInputTokens: 3_600,
      usage: { input: 3_640, output: 320 },
      output: COMPILE_OUTPUT_1,
    });
    appendCall(push, {
      at: 2_494,
      seconds: 1,
      callId: 'c_compile2',
      callRole: 'compile',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      cycle: 1,
      layers: { 'wy-system': 2_000, 'wy-compile': 1_400 },
      estimatedInputTokens: 3_500,
      usage: { input: 3_520, output: 300 },
      output: COMPILE_OUTPUT_2,
    });

    push(sec(2_493), {
      type: 'action.started',
      turn: 1,
      cycle: 1,
      actionId: 'a2',
      kind: 'dispatch',
      parsed: { kind: 'dispatch', intent: ACTION_INTENT_1 },
      taskRunId: 'task_demo01',
    });
    push(sec(2_493), { type: 'action.titled', turn: 1, cycle: 1, actionId: 'a2', title: ACTION_TITLE_1 });
    push(sec(2_493), {
      type: 'action.started',
      turn: 1,
      cycle: 1,
      actionId: 'a3',
      kind: 'dispatch',
      parsed: { kind: 'dispatch', intent: ACTION_INTENT_2 },
      taskRunId: 'task_demo02',
    });
    push(sec(2_493), { type: 'action.titled', turn: 1, cycle: 1, actionId: 'a3', title: ACTION_TITLE_2 });
    push(sec(2_440), {
      type: 'action.finished',
      turn: 1,
      cycle: 1,
      actionId: 'a2',
      kind: 'dispatch',
      status: 'done',
      result: '现有实现为固定 3 次间隔 2s 重试，位于 billing/retry.ts。',
      taskRunId: 'task_demo01',
    });
    push(sec(2_380), {
      type: 'action.finished',
      turn: 1,
      cycle: 1,
      actionId: 'a3',
      kind: 'dispatch',
      status: 'done',
      result: '已改为指数退避（base 500ms, factor 2, max 30s）+ full jitter，新增 6 个单测。',
      taskRunId: 'task_demo02',
    });
    push(sec(2_380), {
      type: 'files',
      turn: 1,
      cycle: 1,
      source: 'task',
      actionId: 'a3',
      taskRunId: 'task_demo02',
      files: [RETRY_SOURCE_FILE],
    });

    appendCall(push, {
      at: 2_378,
      seconds: 2,
      callId: 'c_reply1',
      callRole: 'reply',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      cycle: 1,
      layers: { 'wy-system': 1_200, 'wy-workspace': 5_000, 'wy-ctx': 400, 'wy-status': 120 },
      estimatedInputTokens: 6_400,
      usage: { input: 6_460, output: 60 },
      output: REPLY_TURN1_CYCLE1,
    });
    push(sec(2_376), { type: 'reply', turn: 1, cycle: 1, text: REPLY_TURN1_CYCLE1, callId: 'c_reply1' });

    appendCall(push, {
      at: 2_375,
      seconds: 14,
      callId: 'c_reason2',
      callRole: 'reason',
      modelPublicId: 'anthropic/claude-opus-5-5',
      turn: 1,
      cycle: 2,
      layers: { 'wy-system': 5_200, 'wy-global': 3_800, 'wy-role': 280, 'wy-workspace': 9_600, 'wy-ctx': 44_600, 'wy-info': 430 },
      estimatedInputTokens: 66_900,
      usage: { input: 66_900, cachedInput: 61_000, output: 920, reasoning: 300 },
      output: REASON_TURN1_CYCLE2,
      reasoning: '两个任务结果都正常，最后跑一遍 billing 测试确认。',
    });
    push(sec(2_361), {
      type: 'thinking',
      turn: 1,
      cycle: 2,
      callId: 'c_reason2',
      text: '两个任务结果都正常，最后跑一遍 billing 测试确认。',
    });
    push(sec(2_361), { type: 'reason.completed', turn: 1, cycle: 2, callId: 'c_reason2', text: REASON_TURN1_CYCLE2 });

    appendCall(push, {
      at: 2_360,
      seconds: 1,
      callId: 'c_compile3',
      callRole: 'compile',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      cycle: 2,
      layers: { 'wy-system': 2_000, 'wy-compile': 1_300 },
      estimatedInputTokens: 3_400,
      usage: { input: 3_430, output: 280 },
      output: COMPILE_OUTPUT_3,
    });

    push(sec(2_359), {
      type: 'action.started',
      turn: 1,
      cycle: 2,
      actionId: 'a4',
      kind: 'dispatch',
      parsed: { kind: 'dispatch', intent: ACTION_INTENT_3 },
      taskRunId: 'task_demo03',
    });
    push(sec(2_359), { type: 'action.titled', turn: 1, cycle: 2, actionId: 'a4', title: ACTION_TITLE_3 });
    push(sec(2_320), {
      type: 'action.finished',
      turn: 1,
      cycle: 2,
      actionId: 'a4',
      kind: 'dispatch',
      status: 'done',
      result: '12 个测试全部通过。',
      taskRunId: 'task_demo03',
    });

    appendCall(push, {
      at: 2_318,
      seconds: 2,
      callId: 'c_reply2',
      callRole: 'reply',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      cycle: 2,
      layers: { 'wy-system': 1_200, 'wy-workspace': 5_200, 'wy-ctx': 800, 'wy-status': 120 },
      estimatedInputTokens: 8_200,
      usage: { input: 8_240, output: 380 },
      output: FINAL_REPLY_1,
    });
    push(sec(2_316), { type: 'reply', turn: 1, cycle: 2, text: FINAL_REPLY_1, callId: 'c_reply2' });

    appendCall(push, {
      at: 2_315,
      seconds: 1,
      callId: 'c_title',
      callRole: 'title',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      layers: { 'wy-system': 260, 'wy-title': 400 },
      estimatedInputTokens: 900,
      usage: { input: 910, output: 14 },
      output: '支付重试改为指数退避',
    });
    push(sec(2_314), { type: 'title', turn: 1, text: '支付重试改为指数退避', callId: 'c_title' });
    push(sec(2_313), { type: 'turn.finished', turn: 1, status: 'completed' });

    // Turn 2: one short completed turn with a single reason call.
    push(sec(2_280), {
      type: 'turn.started',
      turn: 2,
      text: TURN2_TEXT,
      model: { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' },
    });
    appendCall(push, {
      at: 2_278,
      seconds: 14,
      callId: 'c_reason3',
      callRole: 'reason',
      modelPublicId: 'anthropic/claude-opus-5-5',
      turn: 2,
      cycle: 1,
      layers: { 'wy-system': 5_200, 'wy-global': 3_800, 'wy-role': 280, 'wy-workspace': 9_600, 'wy-ctx': 28_400, 'wy-info': 420 },
      estimatedInputTokens: 46_900,
      usage: { input: 48_200, cachedInput: 44_000, output: 640, reasoning: 220 },
      output: REASON_TURN2,
      reasoning: 'console 的加载慢和重试无关，指向首屏 bundle。',
    });
    push(sec(2_264), {
      type: 'thinking',
      turn: 2,
      cycle: 1,
      callId: 'c_reason3',
      text: 'console 的加载慢和重试无关，指向首屏 bundle。',
    });
    push(sec(2_264), { type: 'reason.completed', turn: 2, cycle: 1, callId: 'c_reason3', text: REASON_TURN2 });
    push(sec(2_262), { type: 'reply', turn: 2, cycle: 1, text: FINAL_REPLY_2 });
    push(sec(2_261), { type: 'turn.finished', turn: 2, status: 'completed' });
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
    push(sec(args.createdAt), {
      type: 'session.created',
      format: 3,
      workspaceRoot: WORKSPACE_ROOT,
      snapshot: buildSnapshot(sec(args.createdAt)),
    });
    push(sec(args.createdAt), {
      type: 'turn.started',
      turn: 1,
      text: args.user,
      model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    });
    appendCall(push, {
      at: args.createdAt - 20,
      seconds: 8,
      callId: `${args.id}_reason`,
      callRole: 'reason',
      modelPublicId: 'anthropic/claude-sonnet-5-5',
      turn: 1,
      cycle: 1,
      layers: { 'wy-system': 5_200, 'wy-global': 3_800, 'wy-role': 280, 'wy-workspace': 9_600, 'wy-ctx': 2_400, 'wy-info': 420 },
      estimatedInputTokens: 5_200,
      usage: { input: 5_300, cachedInput: 3_100, output: 320, reasoning: 120 },
      output: args.reply,
      reasoning: '快速确认结论后直接回复。',
    });
    push(sec(args.createdAt - 28), { type: 'reason.completed', turn: 1, cycle: 1, callId: `${args.id}_reason`, text: args.reply });
    push(sec(args.createdAt - 32), { type: 'reply', turn: 1, cycle: 1, text: args.reply });
    appendCall(push, {
      at: args.createdAt - 34,
      seconds: 1,
      callId: `${args.id}_title`,
      callRole: 'title',
      modelPublicId: 'deepseek/deepseek-v4.1-flash',
      turn: 1,
      layers: { 'wy-system': 260, 'wy-title': 300 },
      estimatedInputTokens: 620,
      usage: { input: 640, output: 12 },
      output: args.title,
    });
    push(sec(args.createdAt - 35), { type: 'title', turn: 1, text: args.title, callId: `${args.id}_title` });
    push(sec(args.createdAt - 37), { type: 'turn.finished', turn: 1, status: 'completed' });
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
    model: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<void> {
    const modelPublicId = `${model.provider}/${model.model}`;
    const reasonCallId = `live_${turn}_reason`;
    const replyCallId = `live_${turn}_reply`;
    const live: LiveCall[] = [];

    appendEvent(sessionId, {
      type: 'turn.started',
      turn,
      text,
      model: {
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
      },
    }, new Date());
    await sleep(150);

    const reasonStartedAt = new Date();
    appendEvent(sessionId, {
      type: 'call.started',
      callId: reasonCallId,
      role: 'reason',
      model: modelPublicId,
      turn,
      cycle: 1,
    }, reasonStartedAt);

    const reasonLive: LiveCall = { callId: reasonCallId, text: '', reasoning: '' };
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
    const reasonEndedAt = new Date();
    const reasonText = LIVE_REASON_TEXT_CHUNKS.join('');
    appendEvent(sessionId, {
      type: 'call',
      callId: reasonCallId,
      role: 'reason',
      model: modelPublicId,
      status: 'ok',
      startedAt: reasonStartedAt.toISOString(),
      endedAt: reasonEndedAt.toISOString(),
      firstTokenAt: new Date(reasonStartedAt.getTime() + 320).toISOString(),
      layers: { 'wy-system': 5_200, 'wy-global': 3_800, 'wy-role': 280, 'wy-workspace': 9_600, 'wy-ctx': 2_100, 'wy-info': 420 },
      estimatedInputTokens: 4_600,
      usage: { input: 4_700, cachedInput: 3_000, output: 180, reasoning: 90 },
      output: reasonText,
      reasoning: LIVE_REASONING_CHUNKS.join(''),
      turn,
      cycle: 1,
    }, reasonEndedAt);
    appendEvent(sessionId, { type: 'reason.completed', turn, cycle: 1, callId: reasonCallId, text: reasonText }, new Date());
    await sleep(250);

    const replyStartedAt = new Date();
    appendEvent(sessionId, {
      type: 'call.started',
      callId: replyCallId,
      role: 'reply',
      model: 'deepseek/deepseek-v4.1-flash',
      turn,
      cycle: 1,
    }, replyStartedAt);
    await sleep(1_800);

    const replyText = LIVE_REPLY;
    const replyEndedAt = new Date();
    appendEvent(sessionId, {
      type: 'call',
      callId: replyCallId,
      role: 'reply',
      model: 'deepseek/deepseek-v4.1-flash',
      status: 'ok',
      startedAt: replyStartedAt.toISOString(),
      endedAt: replyEndedAt.toISOString(),
      firstTokenAt: new Date(replyStartedAt.getTime() + 300).toISOString(),
      layers: { 'wy-system': 2_400, 'wy-ctx': 3_600, 'wy-info': 900 },
      estimatedInputTokens: 6_800,
      usage: { input: 6_900, output: 120 },
      output: replyText,
      turn,
      cycle: 1,
    }, replyEndedAt);
    appendEvent(sessionId, { type: 'reply', turn, cycle: 1, text: replyText, callId: replyCallId }, new Date());
    appendEvent(sessionId, { type: 'turn.finished', turn, status: 'completed' }, new Date());
  }

  async function playTurn(text: string): Promise<void> {
    const events = sessions.get(FEATURED_ID);
    if (!events) return;
    await runTurn(FEATURED_ID, nextTurn(events), text, DEFAULT_MODEL);
  }

  // ── Bridge implementation ────────────────────────────────────────────────

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
        format: 3,
        workspaceRoot: WORKSPACE_ROOT,
        snapshot: buildSnapshot(new Date().toISOString()),
      });
      register(sessionId, events);
      return { sessionId };
    },
    async ledger(sessionId: string): Promise<LedgerEvent[]> {
      return [...(sessions.get(sessionId) ?? [])];
    },
    async send(request): Promise<{ turn: number }> {
      const events = sessions.get(request.sessionId);
      if (!events) throw new Error(`Unknown session: ${request.sessionId}`);
      const turn = nextTurn(events);
      void runTurn(request.sessionId, turn, request.text, {
        provider: request.model.provider,
        model: request.model.model,
        ...(request.model.reasoningEffort === undefined ? {} : { reasoningEffort: request.model.reasoningEffort }),
      });
      return { turn };
    },
    async interrupt(): Promise<void> {
      // The demo has nothing to interrupt.
    },
    async models(): Promise<SessionBridgeModelEntry[]> {
      return MODEL_ENTRIES.map((entry) => ({
        ...entry,
        reasoningEfforts: [...entry.reasoningEfforts],
      }));
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
        return { computedAtSeq: 0, estimator: 'cl100k_base', model, layers: resident, items: [], totalTokens };
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
        estimator: 'cl100k_base',
        model,
        layers,
        items,
        totalTokens,
        ...(calibration === undefined ? {} : { calibration }),
      };
    },
    async tasks(taskRunIds: string[]): Promise<SessionBridgeTaskBrief[]> {
      const known: Record<string, SessionBridgeTaskBrief> = {
        task_demo01: {
          taskRunId: 'task_demo01',
          taskName: 'explore',
          status: 'done',
          runtime: 'anthropic/claude-sonnet-5-5',
          summary: '现有实现为固定 3 次间隔 2s 重试，位于 billing/retry.ts。',
          usage: { input: 18_400, output: 640 },
        },
        task_demo02: {
          taskRunId: 'task_demo02',
          taskName: 'edit',
          status: 'done',
          runtime: 'anthropic/claude-sonnet-5-5',
          summary: '已改为指数退避（base 500ms, factor 2, max 30s）+ full jitter，新增 6 个单测。',
          usage: { input: 42_100, output: 3_800 },
        },
        task_demo03: {
          taskRunId: 'task_demo03',
          taskName: 'test',
          status: 'done',
          runtime: 'anthropic/claude-sonnet-5-5',
          summary: '12 个测试全部通过。',
          usage: { input: 9_600, output: 420 },
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
  };

  return { api, playTurn };
}
