/**
 * session views (current-only): prompt assembly, context event rendering,
 * escaping and per-layer character statistics.
 *
 * Every builder is a pure function of its input. The main reasoning view emits
 * its stable prefix before its dynamic suffix so provider prompt caching can
 * hit, and an event already on the ledger always renders to the same bytes.
 * Only the current typed action model and context event set are rendered: no
 * compatibility view and no legacy role remain.
 *
 * This module never calls a model and never touches the ledger.
 */

import { estimateTokens } from './calls.ts';
import type { ModelContentPart, ModelMessage } from './driver.ts';
import {
  type DocContentEvent,
  type DocSearchEvent,
  type FilesEvent,
  type LedgerEvent,
  type WorkspaceSnapshot,
} from './ledger.ts';
import type { SessionFile } from './media.ts';
import type { DocCatalogEntry } from './workspace.ts';

// ─── View result contracts ──────────────────────────────────────────────────

export type ViewMessage = ModelMessage;

export interface BuiltView {
  messages: ViewMessage[];
  /** Character count per prompt layer, for the `call` event. */
  layers: Record<string, number>;
  /** Raw text of each assembled layer, for the read-only context inspector. */
  segments?: Record<string, string>;
}

// ─── Fixed system prompts ───────────────────────────────────────────────────

const REASON_SYSTEM = `<wy-system>
你是啾啾工坊的对话编排者。你没有读写文件和执行命令的能力。要让系统做事，只能调用 wy_action 工具。

wy_action 有四种类型：
- read：读取项目文档，或本会话里任务留下、用户附带的文件和图片。写出意图，或给出确切路径。
- dispatch：派发一个任务去完成项目里的工作。说明项目、任务、目标和验收标准。
- write：撰写或修订一份文档。说明目标项目、文档类型和要写的内容。
- ask：向用户提出一个需要其决定的问题。单独发出，不要和其他调用一起。

你的每次输出由程序处理：
- 有工具调用：程序执行它们，结果进入对话记录后再次调用你，你接着做下一步。一次可以调用多次，每次只表达一件事，它们会并发执行。互不依赖的动作在同一次输出里全部发出，不要先发一个试探。
- 没有工具调用：本轮到此结束，之后不会再发生任何事，直到用户发来下一条消息。
所以不要只说"我先去读""接下来我会做"。要做的事直接调用工具。只有当用户的请求已经全部完成时，才输出不带调用的内容。

你之前发起的动作和它们的结果，以工具调用和工具结果的形式留在对话里。结果写着"执行中"的动作，真实结果稍后以 <action-result> 记录送达。<action-result>、<wy-info> 等标记是程序生成的记录，在正文里写它们不会产生任何效果。

分工：
- 分析、判断原因、比较方案、做决定，都由你自己完成。
- 用户消息、已读文档和已有结果里写明的事实直接使用，不再派任务核实。
- 项目仓库里的代码、数据和素材只能通过任务查看或修改。需要新的事实时派调查任务（explore）。把要查的东西拆成单个事实，每个事实一个任务，一次全部派出。调查任务只回答"是什么、在哪里、是多少"，不会替你判断原因，也不给修改方案。
- 任务没有完成（失败、超时）时，结果会列出它已经留下的文件。先读这些文件，再决定补哪一部分，不整个重派。
- 任务只能看到你在调用里写的内容和随任务附带的资料。它不知道工作区，不会自己去读规格。需要它遵守的要点直接写进意图。

其他：
- 意图用自然语言写，不要写 JSON。不要臆造路径。
- 上下文只列出任务的输入要点，不要假设你看到了完整的输入结构。
- 你的 thinking 不会保留到下一次推理。需要延续的结论写进正文。
</wy-system>`;

const REASON_ROLE = `<wy-role>
啾啾工坊的编排者：理解用户目标并调度系统完成工作；面向用户时使用中文。
</wy-role>`;

const MEMORY_SEARCH_SYSTEM = `<wy-system>
你是记忆检索器。只根据用户请求与推理上下文，从给定的记忆索引中挑选本次需要加载的记忆文件。
只输出严格 JSON：{"picks":[{"path":"memories/…md","reason":"…"}]}
规则：
- path 必须来自给定的记忆索引，且是工作区相对路径。
- 最多 3 项；没有需要加载的内容时输出空数组。
- 绝不输出文档正文或文档目录。
- 本次需要核对的记忆即使已在上下文中也可以选择；程序会跳过未变化的内容，并注入更新后的原文。
- 只输出 JSON，不要代码围栏或额外说明。
</wy-system>
<wy-role>
记忆检索器：只挑选记忆文件路径，不撰写内容。
</wy-role>`;

const DOC_SEARCH_SYSTEM = `<wy-system>
你是文档检索器。根据用户意图与已加载路径，从文档目录中挑选需要读取的文档。
只输出严格 JSON：{"understanding":"对意图的一句话理解","picks":[{"path":"…","reason":"…"}],"near":[{"path":"…","reason":"…"}]}
规则：
- understanding 必填；picks 最多 3 项，near 最多 5 项。
- path 必须来自给定目录；未知路径会被丢弃。
- 已在上下文中的路径不要再选。
- near 只提供路径，用于提示，不读取正文。
- 报告/交接类文档只在意图是进展或结果时选择。
- 最近且未废弃的 spec 可作为默认选择。
- 只输出 JSON，不要代码围栏或额外说明。
</wy-system>
<wy-role>
文档检索器：只挑选工作区文档路径，不撰写文档正文。
</wy-role>`;

const COMPILE_SYSTEM = `<wy-system>
你是任务编译器。只为本次 <intent> 所指的这一件一次性派发或文档写入生成运行参数。
只输出严格 JSON 的一个对象：{"project":"项目 id","task":"任务 id","input":<符合 schema 的值>,"ctx":<JSON 对象>,"title":"中文短语","context":["工作区相对路径"]}
规则：
- project 必须来自项目列表；task 必须来自任务列表，且属于所选项目或为内置任务。
- <intent> 是本次唯一权威，<reference-context> 仅供核对、不能授权兄弟任务或历史目标；只完成 <intent> 描述的这一件事，保留其中明确写出且已登记的确切项目与任务，不得替换为父项目、兄弟项目或无关项目；内置任务（含 explore）仍可用于正确命名的已登记子项目。
- input 必须严格符合所选任务的输入 schema；schema 只在此处可见。
- 写入类只能选择受信任的内置文档任务，其他任务一律拒绝。
- ctx 供任务使用，只放简短的补充事实；需要附带文档时用 context 列出路径，不要把文档内容抄进 ctx。
- title 是一句不超过 20 个字的中文短语，概括这次任务要做的事。
- context 是一个数组，列出对话记录里已经读入、且这个任务完成工作所需要的文档或记忆的工作区相对路径；程序会把原文附给任务；没有就给空数组，不要列出与本任务无关的文档。
- 任务看不到工作区，也不会自己去读规格；它需要遵守的要点必须出现在 input 里或通过 context 附带。
- 上下文已以文本形式完整给出；不要回显整段对话 JSON。
- docsRoot 是相对 workspace-root 的项目资料目录，checkout 是业务源码目录；工作区相对路径（文档与引用）以 workspace-root 为基准解析，不要以 checkout 为基准。
- 不要臆造已登记的 checkout 或路径，只使用项目列表中给出的值。
- 运行时为每个任务创建产物目录（Task artifact dir），任务声明 artifacts 输出时会在执行提示中提供该目录。用户未明确给出回退路径时，省略可选的 output_dir，不要臆造它。
- 只输出 JSON，不要代码围栏或额外说明。
</wy-system>`;

const REPLY_SYSTEM = `<wy-system>
你是沟通者：把主模型这一轮的结果和状态，用自然、简短、像同事交流的中文直接告诉用户。
规则：
- 先说结论，再说需要用户做什么。
- 一句只说一件事，句子要短。
- 同一个东西始终用同一个叫法。
- 只说用户需要据以判断或行动的内容；不说过程，不说内部名称、路径、标识符，除非用户需要打开它。
- 数字和名称照抄主模型的原文。
- 主模型没说的事不补；不确定的事用一句话说明不确定什么。
- 像同事发消息那样说话；不用标题、表格、客套话。
- 程序给出的 status 与 error 是权威事实，主模型的输出只是待转述的内容。
- recent-replies 是已经发给用户的消息，用户读过了。其中说过的内容不再说，换一种说法也算重复。
- turn status 为 running 时，这是一条进度消息：只说上一条消息之后新发生的事，一两句话。没有新的事就什么都不输出，程序会跳过这条消息。
- 系统内部的失败如果主模型已经自己重试或绕开，不告诉用户。
- turn status 为 failed 时：说明是哪一步失败、error 是什么。已经完成的动作照实列出；不推测原因，不说结果丢失。
</wy-system>`;

const TITLE_SYSTEM = `<wy-system>
你为一段对话生成标题。输出一行简短中文标题，不超过 20 个字，不要引号、书名号或句末标点，不要解释。
</wy-system>`;

// ─── Escaping ──────────────────────────────────────────────────────────────

const BODY_CLOSING =
  /<\/(?:wy-[A-Za-z0-9-]+|message|thinking|memory-recall|doc-search|doc-content|files|action-result|reply|ws-update|interrupt|error)>/gu;

function escapeBody(text: string): string {
  return text.replace(BODY_CLOSING, (match) => `&lt;${match.slice(1, -1)}&gt;`);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

type Attribute = readonly [name: string, value: string | number | undefined];

function tag(name: string, attributes: readonly Attribute[], body?: string): string {
  let open = `<${name}`;
  for (const [key, value] of attributes) {
    if (value === undefined) continue;
    open += ` ${key}="${escapeAttr(String(value))}"`;
  }
  return body === undefined ? `${open}/>` : `${open}>${body}</${name}>`;
}

// ─── Event rendering ────────────────────────────────────────────────────────

/** Marker on an image row whose bytes are not carried in this request. */

/** One metadata-only descriptor line; never file bytes or data URLs. */
function formatFile(file: SessionFile): string {
  const dimensions = file.kind === 'image' && file.width !== undefined && file.height !== undefined
    ? ` ${file.width}x${file.height}`
    : '';
  const role = file.role === undefined ? '' : ` role=${file.role}`;
  const run = file.taskRunId === undefined ? '' : ` run=${file.taskRunId}`;
  const tokens = file.tokens === undefined ? '' : ` tokens=${file.tokens}`;
  const truncated = file.truncated === true ? ' truncated=true' : '';
  return `[file path=${file.path} name=${file.name} kind=${file.kind} mime=${file.mime} bytes=${file.bytes} source=${file.source}${role}${run}${dimensions}${tokens}${truncated}] ${file.description}`;
}

function renderFiles(event: FilesEvent): string {
  const files = event.files.flatMap((file) => [
    escapeBody(formatFile(file)),
    ...(typeof file.text === 'string' && file.text !== '' ? [escapeBody(file.text)] : []),
  ]);
  return [
    tag('files', [['turn', event.turn], ['cycle', event.cycle], ['source', event.source]]),
    ...(event.files.length === 0 ? ['(none)'] : files),
    '</files>',
  ].join('\n');
}

function renderDocContent(event: DocContentEvent): string {
  return tag(
    'doc-content',
    [
      ['turn', event.turn], ['cycle', event.cycle], ['path', event.path], ['title', event.title],
      ['updated', event.updated], ['version', event.version], ['tokens', event.tokens],
      ['format', event.format], ['base', event.base], ['source', event.source],
    ],
    escapeBody(event.content),
  );
}

function renderDocSearch(event: DocSearchEvent): string {
  return [
    tag('doc-search', [['turn', event.turn], ['cycle', event.cycle], ['id', event.actionId]]),
    escapeBody(event.understanding),
    ...event.picks.map((pick) => escapeBody(`- pick ${pick.path}: ${pick.reason}`)),
    ...event.near.map((near) => escapeBody(`- near ${near.path}: ${near.reason}`)),
    ...event.notes.map((note) => escapeBody(`- note ${note}`)),
    '</doc-search>',
  ].join('\n');
}

/**
 * Render one current context event as text, or `undefined` for observational
 * events (calls and `action.titled`) and post-interrupt results. Thinking is a
 * context event and renders before the message it precedes.
 */
export function renderEventText(event: LedgerEvent): string | undefined {
  switch (event.type) {
    case 'turn.started':
      return tag('message', [['turn', event.turn], ['role', 'user'], ['at', event.at]], escapeBody(event.text));
    case 'cycle.started':
      // The per-request facts of one reasoning cycle, fixed once written.
      return tag('wy-info', [
        ['turn', event.turn], ['cycle', event.cycle], ['at', event.at],
        ['model', event.model], ['context-window', event.contextWindow], ['last-input-tokens', event.lastInputTokens],
      ]);
    case 'thinking':
      return tag('thinking', [['turn', event.turn], ['cycle', event.cycle]], escapeBody(event.text));
    case 'reason.completed':
      return tag('message', [['turn', event.turn], ['cycle', event.cycle], ['role', 'assistant']], escapeBody(event.text));
    case 'memory.recalled':
      return tag('memory-recall', [['turn', event.turn], ['cycle', event.cycle], ['path', event.path], ['source', event.source]], escapeBody(event.content));
    case 'doc.search':
      return renderDocSearch(event);
    case 'doc.content':
      return renderDocContent(event);
    case 'files':
      return renderFiles(event);
    case 'action.started': {
      const parsed = event.parsed as { intent?: unknown } | undefined;
      const intent = typeof parsed?.intent === 'string' ? parsed.intent : '';
      return tag('action', [['id', event.actionId], ['type', event.kind]], escapeBody(intent));
    }
    case 'action.finished':
      if (event.afterInterrupt === true) return undefined;
      return tag(
        'action-result',
        [['turn', event.turn], ['cycle', event.cycle], ['id', event.actionId], ['kind', event.kind], ['status', event.status], ['task', event.task], ['run', event.taskRunId]],
        escapeBody(event.result),
      );
    case 'reply':
      return tag('reply', [['turn', event.turn]], escapeBody(event.text));
    case 'ws.updated':
      return tag('ws-update', [['turn', event.turn], ['change', event.change], ['path', event.path]]);
    case 'turn.interrupted':
      return tag('interrupt', [['turn', event.turn], ['reason', event.reason]]);
    case 'error':
      return tag('error', [['turn', event.turn], ['stage', event.stage]], escapeBody(event.message));
    // Observational only: never part of the rendered context.
    case 'call.started':
    case 'call':
    case 'action.titled':
    case 'session.created':
    case 'turn.finished':
    case 'title':
      return undefined;
    default:
      return undefined;
  }
}

/** Render the approved context events as TEXT ONLY inside `<events>`. */
export function renderEventsBlock(events: readonly LedgerEvent[]): string {
  const rendered = events.map(renderEventText).filter((text): text is string => text !== undefined);
  const body = rendered.length === 0 ? '' : `\n${rendered.join('\n')}`;
  return `<events>${body}\n</events>`;
}

/** Tool result of an action that was still running when a later request was assembled. */
const ACTION_RUNNING = '执行中。结果稍后以 <action-result> 记录送达。';

/**
 * Render the reasoning context as an append-only message sequence.
 *
 * Each finished reasoning output becomes an `assistant` message (its text plus
 * the actions it started as tool calls) followed by one `tool` message per
 * action. Everything else — user messages, recalled memory, documents, files,
 * replies, errors, the per-cycle info line — is record text in `user`
 * messages, with images at their `files` event positions.
 *
 * The sequence only grows at its end as the ledger grows:
 * - a `user` message is closed right after each `cycle.started` marker, which
 *   is where that cycle's request ended;
 * - an action still running when a later cycle started keeps the
 *   {@link ACTION_RUNNING} tool result for good, and its real result arrives as
 *   an `<action-result>` record at the position it finished.
 *
 * Thinking is not replayed. An action whose reasoning output never completed
 * has no assistant message to hang on and stays record text.
 */
function renderReasonContext(input: ReasonViewInput): ModelMessage[] {
  const images = input.allowImages === false ? {} : (input.images ?? {});
  const events = input.events;

  // Index the ledger: where each action started and finished, which cycles
  // produced a reasoning output, and where every cycle started.
  const cycleKey = (turn: number | undefined, cycle: number | undefined): string => `${turn ?? 0}:${cycle ?? 0}`;
  const started = new Map<string, { index: number; kind: string; intent: string; key: string }>();
  const finished = new Map<string, { index: number; event: Extract<LedgerEvent, { type: 'action.finished' }> }>();
  const completedCycles = new Set<string>();
  const cycleStarts: number[] = [];
  events.forEach((event, index) => {
    if (event.type === 'action.started' && !started.has(event.actionId)) {
      const parsed = event.parsed as { intent?: unknown } | undefined;
      started.set(event.actionId, {
        index, kind: event.kind, key: cycleKey(event.turn, event.cycle),
        intent: typeof parsed?.intent === 'string' ? parsed.intent : '',
      });
    } else if (event.type === 'action.finished' && event.afterInterrupt !== true && !finished.has(event.actionId)) {
      finished.set(event.actionId, { index, event });
    } else if (event.type === 'reason.completed') {
      completedCycles.add(cycleKey(event.turn, event.cycle));
    } else if (event.type === 'cycle.started') {
      cycleStarts.push(index);
    }
  });
  const isNative = (actionId: string): boolean => {
    const start = started.get(actionId);
    return start !== undefined && completedCycles.has(start.key);
  };
  /** The result was not yet available when some later request was assembled. */
  const arrivedLate = (actionId: string): boolean => {
    const start = started.get(actionId)!;
    const end = finished.get(actionId)?.index ?? Number.POSITIVE_INFINITY;
    return cycleStarts.some((at) => at > start.index && at < end);
  };

  const messages: ModelMessage[] = [];
  let parts: ModelContentPart[] = [];
  let buffer = '';
  const pushText = (text: string): void => {
    buffer = buffer === '' ? text : `${buffer}\n${text}`;
  };
  const flushText = (): void => {
    if (buffer !== '') parts.push({ type: 'text', text: `${buffer}\n` });
    buffer = '';
  };
  const endUserMessage = (): void => {
    flushText();
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
    parts = [];
  };

  for (const [index, event] of events.entries()) {
    switch (event.type) {
      case 'files': {
        pushText(renderFiles(event));
        for (const file of event.files) {
          if (file.kind !== 'image' || file.processedPath === undefined) continue;
          const image = images[file.processedPath];
          if (image === undefined) continue;
          flushText();
          parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
        }
        break;
      }
      case 'thinking':
        break;
      case 'action.started':
        if (!isNative(event.actionId) && started.get(event.actionId)?.index === index) {
          pushText(renderEventText(event)!);
        }
        break;
      case 'reason.completed': {
        const key = cycleKey(event.turn, event.cycle);
        const calls = [...started.entries()].filter(([, start]) => start.key === key);
        if (event.text === '' && calls.length === 0) break;
        endUserMessage();
        messages.push({
          role: 'assistant',
          content: event.text,
          toolCalls: calls.map(([id, start]) => ({ id, type: start.kind, intent: start.intent })),
        });
        for (const [id] of calls) {
          const result = finished.get(id);
          const content = result === undefined || arrivedLate(id)
            ? ACTION_RUNNING
            : actionResultText(result.event);
          messages.push({ role: 'tool', toolCallId: id, content });
        }
        break;
      }
      case 'action.finished': {
        if (event.afterInterrupt === true) break;
        // Delivered as the action's tool result unless it arrived late.
        if (isNative(event.actionId) && !arrivedLate(event.actionId)) break;
        pushText(renderEventText(event)!);
        break;
      }
      case 'cycle.started':
        pushText(renderEventText(event)!);
        endUserMessage();
        break;
      default: {
        const text = renderEventText(event);
        if (text !== undefined) pushText(text);
      }
    }
  }
  endUserMessage();
  return messages;
}

/** The text of one action's tool result: its outcome when not done, then the result. */
function actionResultText(event: Extract<LedgerEvent, { type: 'action.finished' }>): string {
  const result = event.result === '' ? '(无输出)' : event.result;
  return event.status === 'done' ? result : `[${event.status}] ${result}`;
}

// ─── Workspace and info blocks ──────────────────────────────────────────────

function renderTaskList(tasks: readonly { id: string; description: string; inputSummary?: readonly string[] }[]): string[] {
  if (tasks.length === 0) return ['(none)'];
  return tasks.flatMap((task) => [
    `- ${escapeBody(task.id)}: ${escapeBody(task.description)}`,
    ...(task.inputSummary ?? []).map((summary) => escapeBody(`  input: ${summary}`)),
  ]);
}

/** Frozen workspace snapshot: registered projects and builtin tasks only. */
function renderWorkspace(snapshot: WorkspaceSnapshot): string {
  const projects = snapshot.projects.flatMap((project) => [
    '<project>',
    tag('infos', [
      ['id', project.id], ['name', project.displayName], ['dir', project.workspaceDir],
      ['checkout', project.checkoutPath], ['remote', project.gitRemote],
      ['defaultBranch', project.defaultBranch], ['branch', project.branch], ['head', project.head],
    ]),
    '<tasks>',
    ...renderTaskList(project.tasks),
    '</tasks>',
    '<docs>',
    ...(project.recentDocs.length === 0
      ? ['(none)']
      : project.recentDocs.map((doc) => `- ${escapeBody(doc.path)}: ${escapeBody(doc.title)}`)),
    '</docs>',
    '</project>',
  ]);
  return [
    '<wy-workspace>',
    '<projects>',
    ...projects,
    '</projects>',
    '<tasks>',
    ...renderTaskList(snapshot.builtinTasks),
    '</tasks>',
    '</wy-workspace>',
  ].join('\n');
}

/**
 * `<wy-info>`: the facts that hold for the whole session. Everything that
 * changes per request (time, turn, cycle, model, size) is the `<wy-info .../>`
 * line each `cycle.started` event renders inside the context.
 */
function renderInfo(input: {
  session: ReasonSessionInfo;
  deviceName: string;
  inputFacts: Record<string, string | number>;
}): string {
  const infos = [
    `session: ${escapeBody(input.session.sessionId)}`,
    `device: ${escapeBody(input.deviceName)}`,
    ...Object.entries(input.inputFacts).map(([key, value]) => `${escapeBody(key)}: ${escapeBody(String(value))}`),
  ].join('\n');
  return ['<wy-info>', infos, '</wy-info>'].join('\n');
}

// ─── View inputs ────────────────────────────────────────────────────────────

export interface ReasonSessionInfo {
  now?: string;
  sessionId: string;
  turn: number;
  cycle: number;
  model: string;
  contextWindow?: number;
}

export interface ReasonViewInput {
  deviceName: string;
  snapshot: WorkspaceSnapshot;
  events: LedgerEvent[];
  userText: string;
  session: ReasonSessionInfo;
  inputFacts?: Record<string, string | number>;
  /** Prepared image data URLs keyed by processed path; used on every request. */
  images?: Record<string, { dataUrl: string; mime: string }>;
  allowImages?: boolean;
}

export interface MemorySearchViewInput {
  memoryIndex: string;
  loadedPaths: string[];
  userText: string;
  lastReasonText: string;
  actionResults: { name: string; status: string; text: string }[];
}

export interface DocSearchViewInput {
  catalog: DocCatalogEntry[];
  loadedPaths: string[];
  intent: string;
}

export interface CompileTaskInput {
  id: string; project?: string; description: string; inputSummary: string[];
  inputSchema: unknown; builtinDoc?: boolean; requiredCapabilities?: readonly string[];
}

export interface CompileViewInput {
  kind: 'dispatch' | 'write'; intent: string; userText: string; events: LedgerEvent[];
  workspaceRoot: string;
  projects: { id: string; displayName?: string; workspaceDir: string; checkoutPath?: string }[];
  tasks: CompileTaskInput[];
}

export interface ReplyViewInput {
  userText: string; lastReasonText: string;
  actions: { name: string; status: string }[]; recentReplies: string[];
  status?: string; error?: string; imageNotice?: boolean; question?: string;
}

export interface TitleViewInput {
  userText: string;
  finalReply?: string;
}

export interface ViewsPort {
  reason(input: ReasonViewInput): BuiltView;
  memorySearch(input: MemorySearchViewInput): BuiltView;
  docSearch(input: DocSearchViewInput): BuiltView;
  compile(input: CompileViewInput): BuiltView;
  reply(input: ReplyViewInput): BuiltView;
  title(input: TitleViewInput): BuiltView;
}

// ─── View builders ──────────────────────────────────────────────────────────

function twoPartView(system: string, user: string, layer: string): BuiltView {
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    layers: { 'wy-system': system.length, [layer]: user.length },
    segments: { 'wy-system': system, [layer]: user },
  };
}

/**
 * The main reasoning request, laid out so that each request is the previous one
 * plus an appended tail: a stable head (workspace and session facts), the
 * append-only conversation, and a short closing message naming the request
 * being served. Protocol adapters decide how the messages go on the wire.
 */
function buildReason(input: ReasonViewInput): BuiltView {
  const systemSeg = `${REASON_SYSTEM}\n<wy-global>\n${escapeBody(input.snapshot.agents)}\n</wy-global>\n${REASON_ROLE}`;
  const workspaceSeg = renderWorkspace(input.snapshot);
  const infoSeg = renderInfo({
    session: input.session, deviceName: input.deviceName, inputFacts: input.inputFacts ?? {},
  });
  const conversation = renderReasonContext(input);
  const ctxText = renderEventsBlock(input.events);
  const userSeg = `<wy-user>\n${escapeBody(input.userText)}\n</wy-user>`;
  const ctxLayers = conversation.reduce((total, message) => {
    const calls = (message.toolCalls ?? []).reduce((sum, call) => sum + call.intent.length, 0);
    const content = typeof message.content === 'string'
      ? message.content.length
      : message.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : part.image_url.url.length), 0);
    return total + calls + content;
  }, 0);
  const segments: Record<string, string> = {
    'wy-system': REASON_SYSTEM, 'wy-global': input.snapshot.agents, 'wy-role': REASON_ROLE,
    'wy-workspace': workspaceSeg, 'wy-info': infoSeg, 'wy-ctx': ctxText, 'wy-user': userSeg,
  };
  // Every layer is its segment's character count; `wy-ctx` counts the assembled
  // conversation instead of the text-only event block.
  const layers = Object.fromEntries(
    Object.entries(segments).map(([name, text]) => [name, name === 'wy-ctx' ? ctxLayers : text.length]),
  );
  return {
    messages: [
      { role: 'system', content: systemSeg },
      { role: 'user', content: `${workspaceSeg}\n${infoSeg}\n` },
      ...conversation,
      { role: 'user', content: userSeg },
    ],
    layers,
    segments,
  };
}

function buildMemorySearch(input: MemorySearchViewInput): BuiltView {
  const loaded = input.loadedPaths.length === 0
    ? '(none)'
    : input.loadedPaths.map((path) => `- ${escapeBody(path)}`).join('\n');
  const results = input.actionResults.length === 0
    ? '(none)'
    : input.actionResults
      .map((result) => escapeBody(`- ${result.name} [${result.status}]: ${result.text}`))
      .join('\n');
  const body = [
    tag('memory-index', [], escapeBody(input.memoryIndex)),
    tag('loaded-paths', [], loaded),
    tag('last-reason', [], escapeBody(input.lastReasonText)),
    tag('action-results', [], results),
    tag('user', [], escapeBody(input.userText)),
  ].join('\n');
  return twoPartView(MEMORY_SEARCH_SYSTEM, tag('wy-memory-search', [], body), 'wy-memory-search');
}

function docCategory(path: string): string {
  const match = /^(.*\/docs\/[^/]+)\//u.exec(path);
  return match ? match[1]! : path.slice(0, path.lastIndexOf('/'));
}

function newestSpec(catalog: readonly DocCatalogEntry[]): string | undefined {
  let best: DocCatalogEntry | undefined;
  for (const entry of catalog) {
    if (!/\/docs\/specs\//u.test(entry.path)) continue;
    if (/deprecated|废弃/iu.test(entry.status)) continue;
    if (best === undefined || entry.updated > best.updated) best = entry;
  }
  return best?.path;
}

function buildDocSearch(input: DocSearchViewInput): BuiltView {
  const groups = new Map<string, DocCatalogEntry[]>();
  for (const entry of input.catalog) {
    const key = docCategory(entry.path);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const defaultSpec = newestSpec(input.catalog);
  const catalog = [...groups.keys()].sort().map((key) => {
    const rows = groups.get(key)!.slice().sort((a, b) => a.path.localeCompare(b.path)).map((entry) => {
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      const isDefault = entry.path === defaultSpec ? ' default=true' : '';
      return escapeBody(
        `- path=${entry.path} name=${name} title=${entry.title} status=${entry.status} updated=${entry.updated} length=${entry.length}${isDefault}`,
      );
    }).join('\n');
    return `<group path="${escapeAttr(key)}">\n${rows}\n</group>`;
  }).join('\n');
  const loaded = input.loadedPaths.length === 0
    ? '(none)'
    : input.loadedPaths.map((path) => `- ${escapeBody(path)}`).join('\n');
  const body = [
    tag('catalog', [], groups.size === 0 ? '(none)' : catalog),
    tag('loaded-paths', [], loaded),
    tag('intent', [], escapeBody(input.intent)),
  ].join('\n');
  return twoPartView(DOC_SEARCH_SYSTEM, tag('wy-doc-search', [], body), 'wy-doc-search');
}

function buildCompile(input: CompileViewInput): BuiltView {
  const projects = input.projects.length === 0
    ? '(none)'
    : input.projects.map((project) => {
      const name = project.displayName === undefined ? '' : ` name=${escapeBody(project.displayName)}`;
      const checkout = project.checkoutPath === undefined
        ? ''
        : ` checkout=${escapeBody(project.checkoutPath)}`;
      return `- id=${escapeBody(project.id)} docsRoot=${escapeBody(project.workspaceDir)}${checkout}${name}`;
    }).join('\n');
  const tasks = input.tasks.length === 0
    ? '(none)'
    : input.tasks.map((task) => {
      const project = task.project === undefined ? '' : ` project=${escapeBody(task.project)}`;
      const builtin = task.builtinDoc === true ? ' builtinDoc=true' : '';
      const capabilities = (task.requiredCapabilities ?? []).join(',');
      const inner = [
        tag('description', [], escapeBody(task.description)),
        tag('input-summary', [], escapeBody(task.inputSummary.join('; '))),
        tag('input-schema', [], escapeBody(JSON.stringify(task.inputSchema, null, 2))),
      ].join('\n');
      return `<task id="${escapeAttr(task.id)}"${project}${builtin} capabilities="${escapeAttr(capabilities)}">\n${inner}\n</task>`;
    }).join('\n');
  const body = [
    tag('kind', [], escapeBody(input.kind)),
    tag('workspace-root', [], escapeBody(input.workspaceRoot)),
    tag('projects', [], projects),
    tag('tasks', [], tasks),
    '<reference-context>',
    tag('user', [], escapeBody(input.userText)),
    renderEventsBlock(input.events),
    '</reference-context>',
    tag('intent', [], escapeBody(input.intent)),
  ].join('\n');
  return twoPartView(COMPILE_SYSTEM, tag('wy-compile', [], body), 'wy-compile');
}

const REPLY_BUDGET_TOKENS = 3_000;
/** Placeholder for a field trimmed by the deterministic reply budget. */
const OMISSION = '\n…[omitted]…\n';
/** Raw reply fields are capped before any tokenizer work: 512 head + 512 tail. */
const REPLY_FIELD_MAX_CODEPOINTS = 1_024;
/** Per-field token caps in priority order; the flexible trace takes the rest. */
const REPLY_USER_TOKENS = 600;
const REPLY_STATUS_TOKENS = 900;
const REPLY_RECENT_TOKENS = 300;

/**
 * Bound one raw reply field before any `estimateTokens`/binary search runs.
 * A bounded forward `for...of` visits at most 1025 codepoints (never a full
 * `Array.from` copy), recording the UTF-16 offset after the 512th codepoint as
 * the head boundary. A field within the cap is returned exactly unchanged. A
 * longer field keeps exactly 512 leading and 512 trailing codepoints around the
 * shared omission marker; the trailing cut is a bounded backward scan that
 * pairs a low surrogate with its preceding high surrogate, so both cuts land on
 * codepoint boundaries and no valid UTF-16 pair is ever split.
 */
function boundRawField(text: string): string {
  const half = REPLY_FIELD_MAX_CODEPOINTS / 2;
  let count = 0;
  let offset = 0;
  let headBoundary = 0;
  for (const point of text) {
    if (count === REPLY_FIELD_MAX_CODEPOINTS) {
      // The 1025th codepoint proves the field is over the cap: trim it. Record
      // exactly 512 trailing codepoints by walking code units backwards.
      let tailStart = text.length;
      for (let taken = 0; taken < half && tailStart > 0;) {
        const code = text.charCodeAt(tailStart - 1);
        if (code >= 0xdc00 && code <= 0xdfff && tailStart >= 2) {
          const high = text.charCodeAt(tailStart - 2);
          if (high >= 0xd800 && high <= 0xdbff) {
            tailStart -= 2;
            taken += 1;
            continue;
          }
        }
        tailStart -= 1;
        taken += 1;
      }
      return `${text.slice(0, headBoundary)}${OMISSION}${text.slice(tailStart)}`;
    }
    if (count === half) headBoundary = offset;
    offset += point.length;
    count += 1;
  }
  return text;
}

/** Largest codepoint prefix (or suffix) of `points` within the token budget. */
function sliceByTokens(points: readonly string[], maxTokens: number, fromEnd: boolean): string {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = fromEnd ? points.slice(points.length - mid) : points.slice(0, mid);
    if (estimateTokens(slice.join('')) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return (fromEnd ? points.slice(points.length - low) : points.slice(0, low)).join('');
}

/**
 * The single deterministic, Unicode-safe head/tail trim, applied only to raw
 * fields already bounded to 1024 retained codepoints. Both ends are found by
 * binary search over codepoints against the real tokenizer budget, so a
 * surrogate pair is never split.
 */
function clipHeadTail(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  const points = Array.from(text);
  const budget = Math.max(0, maxTokens - estimateTokens(OMISSION));
  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  return `${sliceByTokens(points, head, false)}${OMISSION}${sliceByTokens(points, tail, true)}`;
}

/** Bounded one-line action name; head/tail trimmed by codepoint, deterministic. */
function compactActionName(name: string): string {
  const oneLine = name.replace(/\s+/gu, ' ').trim();
  const points = Array.from(oneLine);
  const MAX_NAME_CODEPOINTS = 48;
  if (points.length <= MAX_NAME_CODEPOINTS) return oneLine;
  return `${points.slice(0, 36).join('')}…${points.slice(-11).join('')}`;
}

function buildReply(input: ReplyViewInput): BuiltView {
  const status: string[] = [];
  // The explicit turn status leads the block, so the factual state a
  // communicator must trust survives any bounded clip of what follows.
  if (input.status !== undefined) status.push(`turn status: ${input.status}`);
  // Compact, status-first action table: the always-present tally and each
  // `status: name` line keep the running signal ahead of long action goals, so
  // even a giant goal cannot bury the state that decides whether work is
  // genuinely finished. The tally is rendered even at zero.
  const tally = new Map<string, number>();
  for (const action of input.actions) tally.set(action.status, (tally.get(action.status) ?? 0) + 1);
  const counts = [...tally.entries()].map(([state, count]) => `${state} ${count}`).join(', ');
  status.push(`actions: ${input.actions.length}${counts === '' ? '' : ` (${counts})`}`);
  for (const action of input.actions) {
    status.push(`action ${action.status}: ${compactActionName(action.name)}`);
  }
  if (input.error !== undefined) status.push(`error: ${input.error}`);
  if (input.imageNotice === true) status.push('注意：当前主推理模型看不到图片，请在回复中明确告诉用户。');
  if (input.question !== undefined) status.push(`question: ${input.question}`);

  const recent = input.recentReplies.slice(-5).join('\n');
  // Every raw field is Unicode-bounded before any tokenizer work; factual
  // fields lead so the short user request survives intact.
  const fields = [
    { label: 'user', text: boundRawField(input.userText), cap: REPLY_USER_TOKENS },
    { label: 'status', text: boundRawField(status.join('\n')), cap: REPLY_STATUS_TOKENS },
    { label: 'recent-replies', text: boundRawField(recent), cap: REPLY_RECENT_TOKENS },
    { label: 'last-reason', text: boundRawField(input.lastReasonText), cap: Number.POSITIVE_INFINITY },
  ];
  const system = [
    REPLY_SYSTEM,
    ...(COMMUNICATION_EXAMPLES.length === 0 ? [] : [COMMUNICATION_EXAMPLES.join('\n')]),
  ].join('\n');
  const assemble = (texts: readonly string[]): string => [
    '<wy-reply>',
    ...fields.flatMap((field, index) => [`<${field.label}>`, escapeBody(texts[index]!), `</${field.label}>`]),
    '</wy-reply>',
  ].join('\n');

  // Charge the fixed framing once, then let each field spend what remains.
  let remaining = Math.max(0, REPLY_BUDGET_TOKENS - estimateTokens(system) - estimateTokens(assemble(fields.map(() => ''))));
  const bounded = fields.map((field) => {
    const text = clipHeadTail(field.text, Math.max(0, Math.min(field.cap, remaining)));
    remaining = Math.max(0, remaining - estimateTokens(text));
    return text;
  });
  let userSeg = assemble(bounded);
  // A concatenation boundary can nudge the real join over the estimate; one
  // bounded pass over the fields restores the exact budget.
  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const total = estimateTokens(system) + estimateTokens(userSeg);
    if (total <= REPLY_BUDGET_TOKENS) break;
    const current = bounded[index]!;
    const over = total - REPLY_BUDGET_TOKENS + estimateTokens(OMISSION);
    bounded[index] = clipHeadTail(current, Math.max(0, estimateTokens(current) - over));
    userSeg = assemble(bounded);
  }
  return twoPartView(system, userSeg, 'wy-reply');
}

function buildTitle(input: TitleViewInput): BuiltView {
  const body = [
    tag('user', [], escapeBody(input.userText)),
    ...(input.finalReply === undefined ? [] : [tag('final-reply', [], escapeBody(input.finalReply))]),
  ].join('\n');
  return twoPartView(TITLE_SYSTEM, tag('wy-title', [], body), 'wy-title');
}

// ─── Composition root ───────────────────────────────────────────────────────

/**
 * Approved communication few-shot examples. Deliberately empty: the root
 * supplies approved samples later. Do not embed unapproved candidates.
 */
export const COMMUNICATION_EXAMPLES: readonly string[] = [];

export function createViews(): ViewsPort {
  return {
    reason: buildReason,
    memorySearch: buildMemorySearch,
    docSearch: buildDocSearch,
    compile: buildCompile,
    reply: buildReply,
    title: buildTitle,
  };
}
