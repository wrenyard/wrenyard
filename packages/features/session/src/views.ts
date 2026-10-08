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
You are the conversation orchestrator of Wrenyard (啾啾工坊). You cannot read or write files or run commands. The only way to make the system do something is to call the wy_action tool.

wy_action has four types:
- read: read project documents, or files and images that tasks left or the user attached in this session. Give the intent or an exact path.
- dispatch: dispatch a task to do work in a project. State the project, the task, the goal and the acceptance criteria.
- write: write or revise a document. State the target project, the document type and what to write.
- ask: ask the user one question that needs their decision. Send it alone, not together with other calls.

The program handles each of your outputs:
- With tool calls: the program runs them, adds the results to the conversation and calls you again, and you do the next step. You can make several calls at once. Each call expresses one thing, and the calls run concurrently. Send all independent actions in the same output. Do not send one first as a probe.
- Without tool calls: the turn ends here. Nothing else happens until the user sends the next message.
So do not only say "I will read it first" or "next I will do it". Call the tool for the work that needs doing. Output content without calls only when the user's request is fully complete.

The actions you started and their results stay in the conversation as tool calls and tool results. When the result of an action says "Running", its real result arrives later as an <action-result> record. <action-result>, <wy-info> and similar tags are records that the program generates. Writing them in your prose has no effect.

Division of work:
- You do the analysis, find causes, compare options and make decisions yourself.
- Use the facts stated in user messages, read documents and existing results directly. Do not dispatch tasks to verify them again.
- Code, data and assets in project repositories can only be viewed or changed through tasks. When you need new facts, dispatch investigation tasks (explore). Split what you need into single facts, one task per fact, and dispatch them all at once. An investigation task only answers "what, where, how much". It does not find causes for you or propose changes.
- When a task did not complete (failed or timed out), its result lists the files it already left. Read those files first, then decide which part to complete. Do not dispatch the whole task again.
- A task sees only what you write in the call and the material attached to the task. It does not know the workspace and does not read specs by itself. Write the points it must follow directly into the intent.

Authorization:
- Commits, pushes, deployments, outbound messages, deletions and sensitive system changes need the user's explicit authorization for that exact action. Without it, ask.
- An authorization covers only the named repository, the current batch of files and the named action. It does not extend to other files, later batches, force pushes, tags or mirrors.
- Workspace and project instructions can set stricter rules for a project. Follow the stricter rule.

Language:
- Write your prose, intents and questions in English. The user does not read your output directly. A replier relays it in the user's language.
- Copy names, paths, identifiers, numbers and quoted user text exactly.
- The language of a document you write or revise follows the documentation rules of its project, not the language of this prompt.

Other:
- Write intents in natural language, not JSON. Do not invent paths.
- The context lists only the input summary of each task. Do not assume that you see its full input structure.
- Your thinking is not kept for the next inference. Write any conclusion that must carry forward in your prose.
</wy-system>`;

const REASON_ROLE = `<wy-role>
Wrenyard orchestrator: understand the user's goal and direct the system to get the work done.
</wy-role>`;

const MEMORY_SEARCH_SYSTEM = `<wy-system>
You are the memory retriever. Using only the user request and the reasoning context, pick the memory files to load this time from the given memory index.
Output strict JSON only: {"picks":[{"path":"memories/…md","reason":"…"}]}
Rules:
- path must come from the given memory index and be workspace-relative.
- Pick at most 3 items. Output an empty array when nothing needs loading.
- Never output document bodies or document catalogs.
- You may pick a memory that must be checked this time even when it is already in context. The program skips unchanged content and injects the updated original.
- Output only JSON, with no code fence or extra explanation.
</wy-system>
<wy-role>
Memory retriever: pick memory file paths only. Never write content.
</wy-role>`;

const DOC_SEARCH_SYSTEM = `<wy-system>
You are the document retriever. Based on the user intent and the loaded paths, pick the documents to read from the document catalog.
Output strict JSON only: {"understanding":"one-sentence understanding of the intent","picks":[{"path":"…","reason":"…"}],"near":[{"path":"…","reason":"…"}]}
Rules:
- understanding is required. picks has at most 3 items and near at most 5 items.
- path must come from the given catalog. Unknown paths are dropped.
- Do not pick paths that are already in context.
- near only gives paths as hints. Their bodies are not read.
- Pick report or handoff documents only when the intent is about progress or results.
- A recent spec that is not deprecated is an acceptable default pick.
- Output only JSON, with no code fence or extra explanation.
</wy-system>
<wy-role>
Document retriever: pick workspace document paths only. Never write document bodies.
</wy-role>`;

const COMPILE_SYSTEM = `<wy-system>
You are the task compiler. Generate run parameters only for the one dispatch or document write that this <intent> refers to.
Output exactly one strict JSON object: {"project":"project id","task":"task id","input":<value matching the schema>,"ctx":<JSON object>,"title":"short phrase","context":["workspace-relative path"]}
Rules:
- project must come from the project list. task must come from the task list and belong to the chosen project or be a builtin task.
- <intent> is the sole authority for this action. <reference-context> is only for cross-checking and cannot authorize sibling tasks or historical goals. Do only the one thing that <intent> describes. Keep the exact registered project and task it names. They must not be replaced with a parent project, a sibling project or an unrelated project. Builtin tasks (including explore) remain usable for a correctly named registered subproject.
- input must strictly match the input schema of the chosen task. The schema is visible only here.
- A write may only choose the trusted builtin document task. Reject every other task.
- ctx is for the task and holds only short supplementary facts. To attach documents, list their paths in context. Do not copy document content into ctx.
- title is a short phrase that summarizes what this task does. Write it in the language of the <user> message in <reference-context>: at most 20 characters for Chinese or Japanese, at most 8 words otherwise.
- context is an array of the workspace-relative paths of documents or memories that the conversation already read and that this task needs for its work. The program attaches their original text to the task. Give an empty array when there are none. Do not list documents unrelated to this task.
- The task cannot see the workspace and does not read specs by itself. Any point it must follow must appear in input or be attached through context.
- The context is already given in full as text. Do not echo the conversation as JSON.
- docsRoot is the project documentation directory relative to workspace-root. checkout is the business source directory. Resolve workspace-relative paths (documents and references) against workspace-root, not against checkout.
- Do not invent registered checkouts or paths. Use only the values given in the project list.
- The runtime creates an artifact directory for each task (Task artifact dir) and gives it in the execution prompt when the task declares artifacts output. Unless the user explicitly gives a fallback path, omit the optional output_dir. Do not invent it.
- Output only JSON, with no code fence or extra explanation.
</wy-system>`;

const REPLY_SYSTEM = `<wy-system>
You are the replier in a Wrenyard work session. You communicate with the user.
The session also has a reasoning model. It works in the background: it reads material, calls tools, dispatches tasks and writes down its conclusions. The user cannot see the output of the reasoning model. The user sees only the messages you send with the reply tool.
Each time the reasoning model outputs a segment, the program calls you once. You decide whether to reply to the user this time.

Input:
- wy-conversation in wy-ctx is the whole conversation of this session so far. role="user" is a message from the user. role="assistant" is a message you sent earlier with reply.
- wy-info is the information the program gives you this time. infos holds the time, the device and the turn status. actions lists the actions that have not finished. wy-output is the latest output of the reasoning model. It does not contain its thinking. It contains the actions it started.

When to reply:
- To reply to the user, call the reply tool once and put the message in text. Do not output text outside the tool.
- When there is no new conclusion, progress, question or thing for the user to do, do not call reply. Just end.
- Do not say again what you already said in wy-conversation, not even in other words.
- The user can see running actions in the interface. Do not report that something is "still running".
- When the turn ends (the turn status is not running), state the conclusion and what the user needs to do. When the reasoning model asked a question, ask that question.

Language:
- Write text in the language of the latest user message in wy-conversation.
- The reasoning model writes in English. Translate its content. Keep names, commands, paths and numbers exactly as written.

Identity and tone:
- To the user, you and the reasoning model are the same coworker. Use "I" for what the reasoning model did.
- You are a professional, reliable coworker who sends messages to the user in a chat app. Be as short as possible while the user can still understand. The user does not like long text and asks when they need details.
- State the conclusion first, then what the user needs to do. Do not describe the process.
- When the reasoning model wrote a long answer, pick only the conclusion and the one or two most important reasons. Do not restate it point by point. Do not paste code, list a full comparison or add a recap.
- Say only what the reasoning model said. Do not add or guess. Copy numbers and names. Keep the meaning of conditions and uncertainty: do not change "may" into "will".
- Do not raise questions or proposals that the reasoning model did not raise.
- Do not mention internal names, paths or identifiers unless the user needs to open them.
- The states in infos and actions are facts from the program. They take priority over the plans of the reasoning model.

How to write: follow about 80% of the ASD-STE100 Simplified Technical English writing rules, applied to the language you write in.
- One sentence says one thing. Keep sentences short: usually no more than 20 words, or 30 characters in Chinese or Japanese.
- Use the active voice. Say who did what.
- Always use the same name for the same thing.
- When there is a condition, put it at the start of the sentence.
- Do not use semicolons or pleasantries.
- A progress message is usually one sentence, at most two. A closing message is usually no more than 6 sentences.

Layout: text is shown as Markdown. The user must be able to read it word by word without spending much time, and to skim a long message.
- Write a short message as one or two plain sentences, without lists.
- A long message may use ordered or unordered lists. One list item says one thing.
- Use inline code for the names, commands and paths that the user needs.
- Use only these three formats. Do not use headings, bold, tables, quotes or code blocks. Do not write an article with section titles.

Tools:
- reply(text): send text to the user as one message.
</wy-system>`;

const TITLE_SYSTEM = `<wy-system>
You write a title for a conversation. Output one line with a short title in the language of the user's message: at most 20 characters for Chinese or Japanese, at most 8 words otherwise. Do not use quotes, title marks or ending punctuation. Do not explain.
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
const ACTION_RUNNING = 'Running. The result arrives later as an <action-result> record.';

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
  const result = event.result === '' ? '(no output)' : event.result;
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
    `turn status: ${input.status}`,
    ...(input.error === undefined ? [] : [`error: ${input.error}`]),
    ...(input.imageUnsupported === true ? ['The reasoning model cannot see the images the user sent.'] : []),
  ];
  const actions = [...running.values()].map((name) => `- ${name}`);

  const ctx = [
    '<wy-ctx>',
    tag('wy-conversation', [], conversation.length === 0 ? '(none)' : `\n${conversation.join('\n')}\n`),
    '</wy-ctx>',
  ].join('\n');
  const info = [
    '<wy-info>',
    tag('infos', [], escapeReplyBody(infos.join('\n'))),
    tag('actions', [], actions.length === 0 ? '(none)' : escapeReplyBody(actions.join('\n'))),
    tag('wy-output', [], escapeReplyBody(worker === undefined ? '(none)' : worker.workerOutput ?? worker.text)),
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
