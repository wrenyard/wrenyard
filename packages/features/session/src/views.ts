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
你是 Wrenyard 工作会话里的回复者，负责跟用户沟通。
会话里还有一个推理模型。它在后台读资料、调用工具、派发任务，并写下它的结论。用户看不到推理模型的输出，只看得到你用 reply 工具发出的消息。
推理模型每输出一段，程序就调用你一次。你决定这次要不要回复用户。

输入：
- wy-ctx 里的 wy-conversation 是这个会话到现在为止的全部对话。role="user" 是用户发的消息。role="assistant" 是你之前用 reply 发出的消息。
- wy-info 是程序这次给你的信息。infos 是时间、设备和本轮状态。actions 是还没结束的动作。wy-output 是推理模型刚刚的输出，不含它的思考，含它发起的动作。

什么时候回复：
- 要回复用户时，调用一次 reply 工具，把消息写进 text。不要在工具之外输出文字。
- 没有新的结论、进展、问题或需要用户做的事，就不调用 reply，直接结束。
- 你在 wy-conversation 里已经说过的事，不再说，换种说法也不说。
- 用户在界面上看得到动作在运行，不需要你报告"还在运行"。
- 本轮结束时（本轮状态不是 running），说出结论和需要用户做什么。推理模型提了问题，就把问题问出来。

身份和语气：
- 对用户来说，你和推理模型是同一个同事。推理模型做的事，你用"我"来说。
- 你是专业可靠的同事，在聊天软件里给用户发消息。在用户能看懂的前提下，越短越好。用户不爱读长篇大论，需要细节时他会追问。
- 先说结论，再说需要用户做什么。不说过程。
- 推理模型写了长答案时，只挑结论和最关键的一两个理由，不逐条转述。不贴代码，不列完整对比，不做总结复述。
- 只说推理模型说过的事，不补充，不推测。数字和名称照抄。条件和不确定的地方不改意思，"可能"不改成"会"。
- 不主动提出推理模型没提的问题或提议。
- 不说内部名称、路径、标识符，除非用户需要打开它。
- infos 和 actions 里的状态是程序给出的事实，优先于推理模型的计划。

怎么写：按 ASD-STE100 简化技术英语的写作规则，做到八成，用在中文上。
- 一句只说一件事。句子要短，一般不超过 30 个字。
- 用主动句，写明谁做了什么。
- 同一个东西始终用同一个叫法。
- 有条件时，条件放在句首。
- 不用分号，不用客套话。
- 进展消息一般一句，最多两句。收尾消息一般不超过 6 句。

排版：text 按 Markdown 显示。用户要能逐字读完不费时间，长消息也能跳着读。
- 短消息直接写一两句话，不用列表。
- 长消息可以用有序列表或无序列表。一个列表项只说一件事。
- 用户需要的名称、命令和路径，用行内代码。
- 只用这三种格式。不用标题、加粗、表格、引用和代码块，不写成带小标题的文章。

工具：
- reply(text)：把 text 作为一条消息发给用户。
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

/** Escape communication framing without changing any other view's rendering. */
function escapeReplyBody(text: string): string {
  return escapeBody(text).replace(/<\/(?:infos|actions)>/gu, (match) => `&lt;${match.slice(1, -1)}&gt;`);
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
  events: readonly LedgerEvent[];
  turn: number;
  /** The reasoning cycle whose output triggered this call. */
  cycle: number;
  status: 'running' | 'completed' | 'failed';
  /** ISO time of this call. */
  now: string;
  deviceName: string;
  error?: string;
  imageUnsupported?: boolean;
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

/**
 * Render the communication request as one system and one user message. The
 * user message carries `<wy-ctx>`, the whole session conversation (every user
 * input and every visible reply, in timeline order), then `<wy-info>`: the
 * call's facts, the actions still running, and the worker output of the
 * triggering cycle. Earlier worker outputs, thinking, action results and call
 * records are never rendered.
 */
function buildReply(input: ReplyViewInput): BuiltView {
  const conversation: string[] = [];
  const running = new Map<string, string>();
  let worker: Extract<LedgerEvent, { type: 'reason.completed' }> | undefined;
  for (const event of input.events) {
    switch (event.type) {
      case 'turn.started':
        conversation.push(tag('message', [['role', 'user'], ['turn', event.turn]], escapeReplyBody(event.text)));
        break;
      case 'reply':
        conversation.push(tag('message', [['role', 'assistant'], ['turn', event.turn]], escapeReplyBody(event.text)));
        break;
      case 'reason.completed':
        if (event.turn === input.turn && event.cycle === input.cycle) worker = event;
        break;
      case 'action.started':
        running.set(event.actionId, event.kind);
        break;
      case 'action.titled':
        if (running.has(event.actionId)) running.set(event.actionId, event.title);
        break;
      case 'action.finished':
        running.delete(event.actionId);
        break;
      default:
        break;
    }
  }

  const infos = [
    `time: ${input.now}`,
    `device: ${input.deviceName}`,
    `本轮状态: ${input.status}`,
    ...(input.error === undefined ? [] : [`error: ${input.error}`]),
    ...(input.imageUnsupported === true ? ['推理模型看不到用户发的图片。'] : []),
  ];
  const actions = [...running.values()].map((name) => `- ${name}`);

  const ctx = [
    '<wy-ctx>',
    tag('wy-conversation', [], conversation.length === 0 ? '(无)' : `\n${conversation.join('\n')}\n`),
    '</wy-ctx>',
  ].join('\n');
  const info = [
    '<wy-info>',
    tag('infos', [], escapeReplyBody(infos.join('\n'))),
    tag('actions', [], actions.length === 0 ? '(无)' : escapeReplyBody(actions.join('\n'))),
    tag('wy-output', [], escapeReplyBody(worker === undefined ? '(无)' : worker.workerOutput ?? worker.text)),
    '</wy-info>',
  ].join('\n');
  const user = `${ctx}\n${info}`;
  return {
    messages: [
      { role: 'system', content: REPLY_SYSTEM },
      { role: 'user', content: user },
    ],
    layers: { 'wy-system': REPLY_SYSTEM.length, 'wy-ctx': ctx.length, 'wy-info': info.length },
    segments: { 'wy-system': REPLY_SYSTEM, 'wy-ctx': ctx, 'wy-info': info },
  };
}

function buildTitle(input: TitleViewInput): BuiltView {
  const body = [
    tag('user', [], escapeBody(input.userText)),
    ...(input.finalReply === undefined ? [] : [tag('final-reply', [], escapeBody(input.finalReply))]),
  ].join('\n');
  return twoPartView(TITLE_SYSTEM, tag('wy-title', [], body), 'wy-title');
}

// ─── Composition root ───────────────────────────────────────────────────────

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
