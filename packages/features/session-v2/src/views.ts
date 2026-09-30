/**
 * session-v2 views: prompt assembly, context event rendering, escaping and
 * per-layer character statistics.
 *
 * Every builder is a pure function of its input. Each view emits its stable
 * prefix before its dynamic suffix so provider prompt caching can hit, and an
 * event already on the ledger always renders to the same bytes: attributes are
 * emitted in a fixed order and only the closing tags that could terminate the
 * current structure are escaped inside bodies.
 *
 * This module never calls a model and never touches the ledger at runtime; it
 * imports the engine view contracts and the ledger event/snapshot types only.
 */

import { getEncoding } from 'js-tiktoken';
import type {
  BuiltView,
  CompileViewInput,
  InterpretViewInput,
  ReasonViewInput,
  ReplyViewInput,
  RunningTurnInfo,
  SelectViewInput,
  SessionViewInfo,
  TitleViewInput,
  ViewMessage,
  ViewsPort,
  WriteDocViewInput,
} from './engine.ts';
import type {
  ActionFinishedEvent,
  DocReadEvent,
  LedgerEvent,
  LedgerEventDraft,
  MemoryRecalledEvent,
  ReasonCompletedEvent,
  ReplyEvent,
  TurnInterruptedEvent,
  TurnStartedEvent,
  WorkspaceSnapshot,
  WsUpdatedEvent,
} from './ledger.ts';

// ─── Fixed system prompts ──────────────────────────────────────────────────

const REASON_SYSTEM = `<wy-system>
你是啾啾工坊的对话编排者。你没有工具，不能直接读写文件或执行命令。

需要系统做的事，用 <wy-action>…</wy-action> 以自然语言写清楚：目标、验收标准、可选的项目提示；写文档时给出大纲。系统会在后台执行，结果出现在下一次推理的上下文中。

可用的三类 action：
- 派发任务：项目代码与外部工作，说明项目、任务、目标与验收标准。
- 读取资料：只能读根 memories/ 与项目 docs/ 下的 Markdown；相关项目指令会自动加载。
- 写文档：给出项目、文档类型（spec/plan/report/handoff）与大纲，由系统撰写并写入。

行为规则：
- 先写 action，再写说明，便于系统尽早开始执行。
- 把结论、计划与待确认的问题写进可见输出；thinking 不会保留到下一次推理。
- 不要重复请求已有结果的 action；能直接回答的问题不要产生 action。
- 用户看到的回复由另一个模型根据你的输出撰写，你的输出以实质内容为主。
- 注意剩余推理次数；最后一次推理不得产生 action，只能给出结论。
</wy-system>`;

const REASON_ROLE = `<wy-role>
啾啾工坊的编排者：理解用户目标并调度系统完成工作；面向用户时使用中文。
</wy-role>`;

const SELECT_SYSTEM = `<wy-system>
你是上下文选择器。根据用户请求，从记忆索引与各项目近 7 日文档中挑选本次推理需要加载的文件。
只输出严格 JSON：{"memories":[{"path":"memories/…md","reason":"…"}],"docs":[{"path":"projects/<name>/docs/…md","reason":"…"}]}
规则：
- path 必须是工作区相对的 Markdown 路径；memories 只能位于根 memories/，docs 只能位于 projects/<项目目录>/docs/ 下，且文件必须存在。
- reason 用一句中文说明选择理由。
- 已在上下文中的路径不要重复选择。
- 没有需要加载的内容时返回空数组。
- 只输出 JSON，不要代码围栏或额外说明。
</wy-system>`;

const INTERPRET_SYSTEM = `<wy-system>
你是 action 解析器。读取主模型给出的标注块，结合本循环推理输出与对话上下文，产出严格 JSON。
只输出：{"actions":[...]}，不要代码围栏或额外说明。
每个 action 是以下之一：
- {"kind":"dispatch","project":"可选项目 id","task":"任务 id","goal":"目标","acceptance":"验收标准"}
- {"kind":"read","paths":["工作区相对路径", ...]}
- {"kind":"write-doc","project":"项目 id","docType":"spec|plan|report|handoff","path":"更新已有文档时给出","outline":"大纲"}
- {"kind":"unsupported","reason":"无法执行的原因"}
规则：task 必须来自任务列表，project 必须来自项目列表；无法完成时使用 unsupported。
</wy-system>`;

const COMPILE_SYSTEM = `<wy-system>
你是派发编译器。根据任务契约、input JSON schema 与 action 的目标，生成任务运行的 input 与精简上下文 ctx。
只输出严格 JSON：{"input":<符合 schema 的值>,"ctx":<JSON 对象>}，不要代码围栏或额外说明。
- input 必须严格符合给定的 input schema。
- ctx 供任务使用，包含用户请求、目标、验收标准与相关事件摘录，序列化后不得超过 16384 字节（16KB）。
</wy-system>`;

const WRITE_SYSTEM = `<wy-system>
你是文档撰写者。根据工作区信息、上下文、目标项目、文档类型与大纲，撰写一份完整的 Markdown 文档。
只输出一个文档块：
<wy-doc path="projects/<项目目录>/docs/<类型目录>/YYYY-MM-DD-<主题>.md">
完整 Markdown 正文
</wy-doc>
规则：
- 目标路径必须位于目标项目 docs 下对应类型目录中，文件名为 YYYY-MM-DD-<主题>.md。
- 只能输出这一个 <wy-doc> 块，不要任何额外文字或代码围栏。
- 正文第一行是一级标题。
</wy-system>`;

const REPLY_SYSTEM = `<wy-system>
你是沟通者：把系统当前的工作进展或最终结果，用自然、简短、像同事交流的中文告诉用户。
规则：
- 只输出回复正文，不要标题、列表或代码细节。
- 进展回复一两句；最终回复说清结论与下一步。
- 不得声称尚未完成的工作已经完成。
- 面向用户使用中文。
</wy-system>`;

const TITLE_SYSTEM = `<wy-system>
你为一段对话生成标题。输出一行简短中文标题，不超过 20 个字，不要引号、书名号或句末标点，不要解释。
</wy-system>`;

// ─── Escaping ──────────────────────────────────────────────────────────────

/**
 * Closing tags that must not appear verbatim in a body: every `</wy-…>` and the
 * closing forms of the context event tags. Other markup is left untouched.
 */
const BODY_CLOSING = /<\/(?:wy-[A-Za-z0-9-]+|message|memory-recall|doc-read|action-result|reply|ws-update|interrupt)>/gu;

/** Escape only the structural closing tags, leaving all other text intact. */
function escapeBody(text: string): string {
  return text.replace(BODY_CLOSING, (match) => `&lt;${match.slice(1, -1)}&gt;`);
}

/** Escape a value placed inside a double-quoted attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

type Attribute = readonly [name: string, value: string | number | undefined];

/** Emit a tag with a fixed attribute order; undefined optional attributes drop out. */
function tag(name: string, attributes: readonly Attribute[], body?: string): string {
  let open = `<${name}`;
  for (const [key, value] of attributes) {
    if (value === undefined) continue;
    open += ` ${key}="${escapeAttr(String(value))}"`;
  }
  return body === undefined ? `${open}/>` : `${open}>${body}</${name}>`;
}

// ─── Event rendering ───────────────────────────────────────────────────────

/**
 * Render one approved context event, or `undefined` for events that never enter
 * the context (procedural events and post-interrupt results). Thinking is never
 * a context event, so it can never be rendered here.
 */
function renderEvent(event: LedgerEvent): string | undefined {
  switch (event.type) {
    case 'turn.started': {
      const started = event as TurnStartedEvent;
      return tag(
        'message',
        [['turn', started.turn], ['role', 'user'], ['at', started.at]],
        escapeBody(started.text),
      );
    }
    case 'reason.completed': {
      const reason = event as ReasonCompletedEvent;
      return tag(
        'message',
        [['turn', reason.turn], ['cycle', reason.cycle], ['role', 'assistant']],
        escapeBody(reason.text),
      );
    }
    case 'memory.recalled': {
      const memory = event as MemoryRecalledEvent;
      return tag(
        'memory-recall',
        [['turn', memory.turn], ['path', memory.path]],
        escapeBody(memory.content),
      );
    }
    case 'doc.read': {
      const doc = event as DocReadEvent;
      if (doc.source === 'project-instructions') {
        return tag(
          'doc-read',
          [['turn', doc.turn], ['path', doc.path], ['source', 'project-instructions']],
          escapeBody(doc.content),
        );
      }
      return tag(
        'doc-read',
        [['turn', doc.turn], ['path', doc.path], ['title', doc.title]],
        escapeBody(doc.content),
      );
    }
    case 'action.finished': {
      const finished = event as ActionFinishedEvent;
      if (finished.afterInterrupt === true) return undefined;
      return tag(
        'action-result',
        [
          ['turn', finished.turn],
          ['cycle', finished.cycle],
          ['id', finished.actionId],
          ['kind', finished.kind],
          ['status', finished.status],
          ['task', finished.task],
          ['run', finished.taskRunId],
        ],
        escapeBody(finished.result),
      );
    }
    case 'reply': {
      const reply = event as ReplyEvent;
      return tag('reply', [['turn', reply.turn], ['phase', reply.phase]], escapeBody(reply.text));
    }
    case 'ws.updated': {
      const updated = event as WsUpdatedEvent;
      return tag('ws-update', [['turn', updated.turn], ['change', updated.change], ['path', updated.path]]);
    }
    case 'turn.interrupted': {
      const interrupted = event as TurnInterruptedEvent;
      return tag('interrupt', [['turn', interrupted.turn], ['reason', interrupted.reason]]);
    }
    // Observational only: a started call must never enter the rendered context,
    // exactly like the terminal `call` event it pairs with.
    case 'call.started':
    case 'call':
      return undefined;
    default:
      return undefined;
  }
}

/** Render a delayed recall that is not on the ledger yet (write-doc preparation). */
function renderRecallDraft(draft: LedgerEventDraft): string | undefined {
  const value = draft as {
    type?: string;
    turn?: number;
    path?: string;
    title?: string;
    content?: string;
    source?: string;
  };
  if (typeof value.path !== 'string' || typeof value.content !== 'string') return undefined;
  if (value.type === 'memory.recalled') {
    return tag('memory-recall', [['turn', value.turn], ['path', value.path]], escapeBody(value.content));
  }
  if (value.type === 'doc.read') {
    if (value.source === 'project-instructions') {
      return tag(
        'doc-read',
        [['turn', value.turn], ['path', value.path], ['source', 'project-instructions']],
        escapeBody(value.content),
      );
    }
    return tag(
      'doc-read',
      [['turn', value.turn], ['path', value.path], ['title', value.title]],
      escapeBody(value.content),
    );
  }
  return undefined;
}

/** Wrap the approved context events (plus any pending recalls) in `<events>`. */
function renderEventsBlock(events: readonly LedgerEvent[], pending: readonly LedgerEventDraft[] = []): string {
  const rendered: string[] = [];
  for (const event of events) {
    const text = renderEvent(event);
    if (text !== undefined) rendered.push(text);
  }
  for (const draft of pending) {
    const text = renderRecallDraft(draft);
    if (text !== undefined) rendered.push(text);
  }
  const body = rendered.length === 0 ? '' : `\n${rendered.join('\n')}`;
  return `<events>${body}\n</events>`;
}

// ─── Workspace, info and target blocks ─────────────────────────────────────

/** Frozen workspace snapshot, in the spec's `<wy-workspace>` shape. */
function renderWorkspace(snapshot: WorkspaceSnapshot): string {
  const lines: string[] = ['<wy-workspace>', '<projects>'];
  for (const project of snapshot.projects) {
    lines.push('<project>');
    lines.push(
      tag('infos', [
        ['id', project.id],
        ['name', project.displayName],
        ['dir', project.workspaceDir],
        ['checkout', project.checkoutPath],
        ['remote', project.gitRemote],
        ['defaultBranch', project.defaultBranch],
        ['branch', project.branch],
        ['head', project.head],
      ]),
    );
    lines.push('<tasks>');
    if (project.tasks.length === 0) lines.push('(none)');
    for (const task of project.tasks) lines.push(`- ${escapeBody(task.id)}: ${escapeBody(task.description)}`);
    lines.push('</tasks>');
    lines.push('<docs>');
    if (project.recentDocs.length === 0) lines.push('(none)');
    for (const doc of project.recentDocs) lines.push(`- ${escapeBody(doc.path)}: ${escapeBody(doc.title)}`);
    lines.push('</docs>');
    lines.push('</project>');
  }
  lines.push('</projects>');
  lines.push('<memories>');
  lines.push(escapeBody(snapshot.memoryIndex));
  lines.push('</memories>');
  lines.push('<tasks>');
  if (snapshot.builtinTasks.length === 0) lines.push('(none)');
  for (const task of snapshot.builtinTasks) lines.push(`- ${escapeBody(task.id)}: ${escapeBody(task.description)}`);
  lines.push('</tasks>');
  lines.push('</wy-workspace>');
  return lines.join('\n');
}

/** Time source for `<wy-info>`: the newest event timestamp, pure of wall clock. */
function lastAt(events: readonly LedgerEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const at = (events[index] as { at?: unknown } | undefined)?.at;
    if (typeof at === 'string' && at !== '') return at;
  }
  return undefined;
}

/** Timezone label derived from an ISO 8601 timestamp's own offset. */
function zoneOf(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const match = /([+-]\d{2}:\d{2}|Z)$/u.exec(iso);
  if (!match) return undefined;
  return match[1] === 'Z' ? 'UTC+00:00' : `UTC${match[1]}`;
}

const tokenizer = getEncoding('cl100k_base');

/** Use the same tokenizer as the call budget. */
function approximateTokens(text: string): number {
  return tokenizer.encode(text).length;
}

/**
 * `<wy-info>`: rebuilt for every request, so mutable state belongs here rather
 * than on the timeline. Todos are intentionally absent in the MVP.
 */
function renderInfo(args: {
  session: SessionViewInfo;
  deviceName: string;
  events: readonly LedgerEvent[];
  runningTurns: readonly RunningTurnInfo[];
  estimatedInputTokens: number;
}): string {
  const { session } = args;
  const at = (session as SessionViewInfo & { now?: string }).now ?? lastAt(args.events);
  const lines: string[] = ['<wy-info>', '<infos>'];
  if (at !== undefined) lines.push(`time: ${escapeBody(at)}`);
  const zone = zoneOf(at);
  if (zone !== undefined) lines.push(`timezone: ${zone}`);
  lines.push(`device: ${escapeBody(args.deviceName)}`);
  lines.push('</infos>');
  lines.push('<sessions>');
  lines.push(`session: ${escapeBody(session.sessionId)}`);
  lines.push(`turn: ${session.turn}`);
  lines.push(`cycle: ${session.cycle}/${session.maxCycles}（第 ${session.cycle}/${session.maxCycles} 次推理）`);
  lines.push(`model: ${escapeBody(session.model)}`);
  lines.push(`estimated input: ~${args.estimatedInputTokens} tokens`);
  if (session.contextWindow !== undefined) lines.push(`context window: ${session.contextWindow} tokens`);
  for (const sibling of args.runningTurns) {
    if (sibling.turn !== session.turn) lines.push(`running turn ${sibling.turn}: phase ${escapeBody(sibling.phase)}`);
  }
  lines.push('</sessions>');
  lines.push('<actions>');
  let running = 0;
  for (const sibling of args.runningTurns) {
    for (const action of sibling.actions) {
      running += 1;
      lines.push(
        `- id=${escapeBody(action.actionId)} turn=${action.turn} kind=${escapeBody(action.kind)} goal=${escapeBody(action.goal)} started=${escapeBody(action.startedAt)}${
          action.taskRunId === undefined ? '' : ` run=${escapeBody(action.taskRunId)}`
        }`,
      );
    }
  }
  if (running === 0) lines.push('(none)');
  lines.push('</actions>');
  lines.push('</wy-info>');
  return lines.join('\n');
}

/** Events belonging to the current turn only, used by later select cycles. */
function currentTurnEvents(events: readonly LedgerEvent[], turn: number): LedgerEvent[] {
  return events.filter((event) => (event as { turn?: number }).turn === turn);
}

// ─── View builders ─────────────────────────────────────────────────────────

function buildReason(input: ReasonViewInput): BuiltView {
  const systemSeg = REASON_SYSTEM;
  const globalSeg = `<wy-global>\n${escapeBody(input.snapshot.agents)}\n</wy-global>`;
  const roleSeg = REASON_ROLE;
  const workspaceSeg = renderWorkspace(input.snapshot);
  const ctxSeg = `<wy-ctx>\n${renderEventsBlock(input.events)}\n</wy-ctx>`;
  const userSeg = `<wy-user>\n${escapeBody(input.userText)}\n</wy-user>`;
  const infoSeg = renderInfo({
    session: input.session,
    deviceName: input.deviceName,
    events: input.events,
    runningTurns: input.runningTurns,
    estimatedInputTokens: approximateTokens(
      `${systemSeg}\n${globalSeg}\n${roleSeg}\n${workspaceSeg}\n${ctxSeg}\n${userSeg}`,
    ),
  });

  const messages: ViewMessage[] = [
    { role: 'system', content: `${systemSeg}\n${globalSeg}\n${roleSeg}` },
    { role: 'user', content: `${workspaceSeg}\n${ctxSeg}\n${infoSeg}\n${userSeg}` },
  ];
  return {
    messages,
    layers: {
      'wy-system': systemSeg.length,
      'wy-global': globalSeg.length,
      'wy-role': roleSeg.length,
      'wy-workspace': workspaceSeg.length,
      'wy-ctx': ctxSeg.length,
      'wy-info': infoSeg.length,
      'wy-user': userSeg.length,
    },
  };
}

function buildSelect(input: SelectViewInput): BuiltView {
  const systemSeg = SELECT_SYSTEM;
  const lines: string[] = ['<wy-select>'];
  lines.push('<memory-index>');
  lines.push(escapeBody(input.snapshot.memoryIndex));
  lines.push('</memory-index>');
  lines.push('<recent-docs>');
  let recent = 0;
  for (const project of input.snapshot.projects) {
    for (const doc of project.recentDocs) {
      recent += 1;
      lines.push(`- ${escapeBody(doc.path)}: ${escapeBody(doc.title)}（项目 ${escapeBody(project.id)}）`);
    }
  }
  if (recent === 0) lines.push('(none)');
  lines.push('</recent-docs>');
  lines.push('<user>');
  lines.push(escapeBody(input.userText));
  lines.push('</user>');
  lines.push('<output-format>');
  lines.push('只输出 JSON：{"memories":[{"path":"memories/…md","reason":"…"}],"docs":[{"path":"…","reason":"…"}]}');
  lines.push('</output-format>');
  lines.push('<loaded-paths>');
  if (input.loadedPaths.length === 0) lines.push('(none)');
  for (const path of input.loadedPaths) lines.push(`- ${escapeBody(path)}`);
  lines.push('</loaded-paths>');
  if (input.cycle >= 2) {
    lines.push('<current-turn-events>');
    lines.push(renderEventsBlock(currentTurnEvents(input.events, input.session.turn)));
    lines.push('</current-turn-events>');
  }
  lines.push('</wy-select>');
  const userSeg = lines.join('\n');

  const messages: ViewMessage[] = [
    { role: 'system', content: systemSeg },
    { role: 'user', content: userSeg },
  ];
  return { messages, layers: { 'wy-system': systemSeg.length, 'wy-select': userSeg.length } };
}

function buildInterpret(input: InterpretViewInput): BuiltView {
  const systemSeg = INTERPRET_SYSTEM;
  const lines: string[] = ['<wy-interpret>'];
  lines.push('<projects>');
  if (input.projects.length === 0) lines.push('(none)');
  for (const project of input.projects) {
    const name = project.displayName === undefined ? '' : ` name=${escapeBody(project.displayName)}`;
    lines.push(`- id=${escapeBody(project.id)} dir=${escapeBody(project.workspaceDir)}${name}`);
  }
  lines.push('</projects>');
  lines.push('<tasks>');
  if (input.tasks.length === 0) lines.push('(none)');
  for (const task of input.tasks) {
    const project = task.project === undefined ? '' : `（项目 ${escapeBody(task.project)}）`;
    lines.push(`- ${escapeBody(task.id)}${project}: ${escapeBody(task.description)}`);
  }
  lines.push('</tasks>');
  lines.push('<scope>');
  lines.push(escapeBody(input.scopeRules));
  lines.push('</scope>');
  lines.push('<user>');
  lines.push(escapeBody(input.userText));
  lines.push('</user>');
  lines.push('<current-output>');
  lines.push(escapeBody(input.cycleText));
  lines.push('</current-output>');
  lines.push(`<block unterminated="${input.unterminated ? 'true' : 'false'}">`);
  lines.push(escapeBody(input.blockText));
  lines.push('</block>');
  if (input.previousFailure !== undefined) {
    lines.push('<previous-failure>');
    lines.push(escapeBody(input.previousFailure));
    lines.push('</previous-failure>');
  }
  lines.push('</wy-interpret>');
  const userSeg = lines.join('\n');

  const messages: ViewMessage[] = [
    { role: 'system', content: systemSeg },
    { role: 'user', content: userSeg },
  ];
  return { messages, layers: { 'wy-system': systemSeg.length, 'wy-interpret': userSeg.length } };
}

function buildCompile(input: CompileViewInput): BuiltView {
  const systemSeg = COMPILE_SYSTEM;
  const lines: string[] = ['<wy-compile>'];
  lines.push(`<task id="${escapeAttr(input.task.id)}">`);
  lines.push(`<description>${escapeBody(input.task.description)}</description>`);
  lines.push(`<input-schema>${escapeBody(JSON.stringify(input.task.inputSchema, null, 2))}</input-schema>`);
  lines.push('</task>');
  lines.push('<action>');
  if (input.action.project !== undefined) lines.push(`project: ${escapeBody(input.action.project)}`);
  lines.push(`task: ${escapeBody(input.action.task)}`);
  lines.push(`goal: ${escapeBody(input.action.goal)}`);
  lines.push(`acceptance: ${escapeBody(input.action.acceptance)}`);
  lines.push('</action>');
  lines.push('<user>');
  lines.push(escapeBody(input.userText));
  lines.push('</user>');
  lines.push(renderEventsBlock(input.events));
  lines.push('<providers>');
  if (input.providers.length === 0) lines.push('(none)');
  for (const provider of input.providers) lines.push(`- ${escapeBody(provider.provider)}/${escapeBody(provider.model)}`);
  lines.push('</providers>');
  if (input.previousFailure !== undefined) {
    lines.push('<previous-failure>');
    lines.push(escapeBody(input.previousFailure));
    lines.push('</previous-failure>');
  }
  lines.push('</wy-compile>');
  const userSeg = lines.join('\n');

  const messages: ViewMessage[] = [
    { role: 'system', content: systemSeg },
    { role: 'user', content: userSeg },
  ];
  return { messages, layers: { 'wy-system': systemSeg.length, 'wy-compile': userSeg.length } };
}

function buildWriteDoc(input: WriteDocViewInput, documentRules: string): BuiltView {
  const systemSeg = documentRules === '' ? WRITE_SYSTEM : `${WRITE_SYSTEM}\n${documentRules}`.trimEnd();
  const globalSeg = `<wy-global>\n${escapeBody(input.globalAgents)}\n</wy-global>`;
  const workspaceSeg = renderWorkspace(input.snapshot);
  const ctxSeg = `<wy-ctx>\n${renderEventsBlock(input.events, input.pendingRecalls)}\n</wy-ctx>`;

  const target: string[] = ['<wy-target>'];
  target.push(`project: ${escapeBody(input.project.id)}`);
  target.push(`workspaceDir: ${escapeBody(input.project.workspaceDir)}`);
  if (input.project.displayName !== undefined) target.push(`name: ${escapeBody(input.project.displayName)}`);
  target.push(`docType: ${escapeBody(input.docType)}`);
  target.push(`date: ${escapeBody(input.date)}`);
  if (input.currentContent !== undefined) {
    target.push('<current-document>');
    target.push(escapeBody(input.currentContent));
    target.push('</current-document>');
  }
  target.push('<outline>');
  target.push(escapeBody(input.outline));
  target.push('</outline>');
  target.push('</wy-target>');
  const targetSeg = target.join('\n');

  const messages: ViewMessage[] = [
    { role: 'system', content: systemSeg },
    { role: 'user', content: `${globalSeg}\n${workspaceSeg}\n${ctxSeg}\n${targetSeg}` },
  ];
  return {
    messages,
    layers: {
      'wy-system': systemSeg.length,
      'wy-global': globalSeg.length,
      'wy-workspace': workspaceSeg.length,
      'wy-ctx': ctxSeg.length,
      'wy-target': targetSeg.length,
    },
  };
}

function buildReply(input: ReplyViewInput): BuiltView {
  const systemSeg = REPLY_SYSTEM;
  const workspaceSeg = renderWorkspace(input.snapshot);
  const ctxSeg = `<wy-ctx>\n${renderEventsBlock(input.events)}\n</wy-ctx>`;
  const status: string[] = ['<wy-status>'];
  status.push(`phase: ${escapeBody(input.phase)}`);
  if (input.status !== undefined) status.push(`turn status: ${escapeBody(input.status)}`);
  if (input.error !== undefined) status.push(`error: ${escapeBody(input.error)}`);
  status.push(`turn: ${input.session.turn}`);
  status.push(`cycle: ${input.session.cycle}/${input.session.maxCycles}`);
  status.push('</wy-status>');
  const statusSeg = status.join('\n');

  const messages: ViewMessage[] = [
    { role: 'system', content: systemSeg },
    { role: 'user', content: `${workspaceSeg}\n${ctxSeg}\n${statusSeg}` },
  ];
  return {
    messages,
    layers: {
      'wy-system': systemSeg.length,
      'wy-workspace': workspaceSeg.length,
      'wy-ctx': ctxSeg.length,
      'wy-status': statusSeg.length,
    },
  };
}

function buildTitle(input: TitleViewInput): BuiltView {
  const systemSeg = TITLE_SYSTEM;
  const lines: string[] = ['<wy-title>', '<user>', escapeBody(input.userText), '</user>'];
  if (input.finalReply !== undefined) {
    lines.push('<final-reply>', escapeBody(input.finalReply), '</final-reply>');
  }
  lines.push('</wy-title>');
  const userSeg = lines.join('\n');

  const messages: ViewMessage[] = [
    { role: 'system', content: systemSeg },
    { role: 'user', content: userSeg },
  ];
  return { messages, layers: { 'wy-system': systemSeg.length, 'wy-title': userSeg.length } };
}

// ─── Composition root ──────────────────────────────────────────────────────

/**
 * Build the view port. `documentRules` is the full text of
 * `instructions/documents.md`; the composition root reads it and the writer
 * system prompt embeds it verbatim.
 */
export function createViews(documentRules?: string): ViewsPort {
  const rules = documentRules ?? '';
  return {
    reason: (input) => buildReason(input),
    select: (input) => buildSelect(input),
    reply: (input) => buildReply(input),
    title: (input) => buildTitle(input),
    interpret: (input) => buildInterpret(input),
    compile: (input) => buildCompile(input),
    writeDoc: (input) => buildWriteDoc(input, rules),
  };
}
