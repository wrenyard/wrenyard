/**
 * session primary views: the main reasoning request, its prompt layers and the
 * workspace/info blocks.
 *
 * Every builder is a pure function of its input. The main reasoning view emits
 * its stable prefix before its dynamic suffix so provider prompt caching can
 * hit, and an event already on the ledger always renders to the same bytes.
 * This module never calls a model and never touches the ledger.
 */

import type { Message as ModelMessage, ModelContentPart } from '../transport/index.ts';
import {
  type LedgerEvent,
  type WorkspaceSnapshot,
} from '../ledger/store.ts';
import {
  ACTION_RUNNING,
  REDUCED_ARGUMENT_HEAD,
  REDUCED_ARGUMENT_LIMIT,
  REDUCED_ARGUMENT_TAIL,
  REDUCED_RESULT_HEAD,
  REDUCED_RESULT_LIMIT,
  REDUCED_RESULT_TAIL,
  REDUCED_TEXT_HEAD,
  REDUCED_TEXT_LIMIT,
  REDUCED_TEXT_TAIL,
  cutReleasedChars,
  cutReleasedTokens,
  escapeBody,
  renderEventText,
  renderEventsBlock,
  renderFiles,
  tag,
} from '../context/render.ts';
import { renderCompactionBlock } from '../context/compaction.ts';
import type { BuiltView } from '../ports.ts';

// Mirrors SYSTEM_DEFAULT_RUN_TIME_LIMIT_MINUTES in @wrenyard/task; declared
// locally to keep this leaf package free of a feature-level dependency edge.
const DEFAULT_RUN_TIME_LIMIT_MINUTES = 60;

const REASON_SYSTEM = `<wy-system>
You are the conversation orchestrator of Wrenyard (啾啾工坊). You cannot read or write files or run commands. The only way to make the system do something is to call the wy_action tool.

wy_action has seven types:
- search: read workspace material: project documents, memories, and files or images that tasks left or the user attached. Give the intent or an exact path. Search only chooses documents by title; it does not answer questions, so ask current source code, line numbers or values with dispatch, and send one search per topic.
- dispatch: dispatch a task in a project. State the project, the task, the goal and the acceptance criteria. Every task run has a default run time limit of ${DEFAULT_RUN_TIME_LIMIT_MINUTES} minutes, counted from the moment the run starts; when the limit is reached the run is terminated and marked as timed out.
- document: create, revise or delete ordinary project documents (spec, report or handoff), or read/revise an existing registered project AGENTS.md using the fixed document ID AGENTS.md and the same doc methods. For ordinary docs state project, kind, name/title and content; for AGENTS.md state project and the requested revision. Document actions cannot create/delete AGENTS.md, target arbitrary paths, workspace-root or checkout instruction files, or change other source/config/workspace files.
- todo: list, show, create or update workspace todos through the native todo.list, todo.get, todo.create and todo.update methods. State which operation the intent needs, and for an update the todo id and only the fields that change. Prefer this over dispatching a task to read or edit todo files, and never read todo files directly. There is no delete.
- vcs: version control of the workspace repository itself: status, diff, commit, push, pull. For a commit list the exact files and the message.
- project: manage registered project checkouts (status, diff, commit, push, pull, worktree create, remove and merge) or register a new project. Name the project and the worktree. For a commit, list the exact files. For registration, give the project id, a description and the checkout path.
- ask: ask the user one question that needs their decision. Send it alone, not together with other calls.

The program handles each of your outputs:
- With tool calls: the program runs them, adds the results to the conversation and calls you again, and you do the next step. You can make several calls at once. Each call expresses one thing, and the calls run concurrently. Send all independent actions in the same output. Do not send one first as a probe.
- Without tool calls: the turn ends here. Nothing else happens until the user sends the next message.
So do not only say "I will read it first" or "next I will do it". Call the tool for the work that needs doing. Output content without calls only when the user's request is fully complete.

The actions you started and their results stay in the conversation as tool calls and tool results. When the result of an action says "Running", its real result arrives later as an <action-result> record. <action-result>, <wy-info> and similar tags are records that the program generates. Writing them in your prose has no effect.
<reply turn=N> records are messages the replier already delivered to the user: the user has seen them, and they are not new input from the user. Do not re-ask a decision you already asked or restate a conclusion you already delivered only to close the turn. Your next output must carry a new fact or a remaining action. An output with no tool call and no text is an error, and the replier cannot be called for it; when nothing new remains, return a brief nonempty completion statement with no tool calls so the replier can stay silent.
<wy-user turn=N> restates the opening message of turn N; it is not a newly delivered message. Process any later messages in the conversation as well.
Workspace changes made by actions appear as <wy-info> records with type="ws.updated". Compare them with the action results. Do not repeat an action whose change is already recorded.

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

// ─── Reasoning context assembly ─────────────────────────────────────────────

/**
 * The latest compaction on the timeline, when one exists. Its `throughSeq` is
 * the floor: every context event at or below it is already summarised by the
 * compaction event itself, which stays in the view as the handover block.
 */
function latestCompaction(events: readonly LedgerEvent[]): Extract<LedgerEvent, { type: 'context.compacted' }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'context.compacted') return event;
  }
  return undefined;
}

/**
 * The latest reduction on the timeline, when one exists. Its `throughSeq` is
 * the reduced floor: every context event at or below it renders in reduced
 * form, and every event above it renders in full. The floor only moves when a
 * new reduction is recorded, so the rendered prefix stays byte-identical
 * between two reductions.
 */
function latestReduction(events: readonly LedgerEvent[]): Extract<LedgerEvent, { type: 'context.reduced' }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'context.reduced') return event;
  }
  return undefined;
}

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
 * - a `user` message is closed right after each `step.started` marker, which
 *   is where that step's request ended;
 * - an action still running when a later step started keeps the
 *   {@link ACTION_RUNNING} tool result for good, and its real result arrives as
 *   an `<action-result>` record at the position it finished.
 *
 * A raw action id can repeat after a session is recovered (the in-memory
 * counter used to restart at 1), so every `action.started` stays its own
 * occurrence: it is grouped with the reasoning step that wrote it, paired only
 * with the result belonging to that same occurrence, and given its own
 * tool-call id once the bare id is no longer unique.
 *
 * Thinking is not replayed. An action whose reasoning output never completed
 * has no assistant message to hang on and stays record text. System actions
 * (reply, title, memory) are never tool calls here; the renderer decides them.
 */
function renderReasonContext(input: ReasonViewInput): ModelMessage[] {
  const images = input.allowImages === false ? {} : (input.images ?? {});
  const compaction = latestCompaction(input.events);
  // The compaction floor drops every summarised event, including any earlier
  // compaction event; the latest compaction event itself survives because its
  // own sequence is above the range it covers.
  const events = compaction === undefined
    ? input.events
    : input.events.filter((event) => event.seq > compaction.throughSeq);
  // The reduced floor: a reduction below an already-summarised range has
  // nothing left to bound, so only a later one renders events reduced.
  const reduction = latestReduction(events);
  const reducedFloor = reduction === undefined
    || (compaction !== undefined && reduction.throughSeq <= compaction.throughSeq)
    ? undefined
    : reduction.throughSeq;
  const isReduced = (event: LedgerEvent): boolean => reducedFloor !== undefined && event.seq <= reducedFloor;
  /** Render one event in full, or in reduced form when it is below the floor. */
  const render = (event: LedgerEvent): string | undefined =>
    renderEventText(event, isReduced(event) ? { reduced: true } : undefined);

  // Index the ledger by occurrence, not by raw action id: a recovered session
  // can reuse an id, and each reuse is its own call with its own result.
  const stepKey = (turn: number | undefined, step: number | undefined): string => `${turn ?? 0}:${step ?? 0}`;
  interface StartOccurrence {
    index: number;
    type: string;
    intent: string;
    /** The native tool name of a `tool` action; absent for every other type. */
    name?: string;
    /** The reasoning step that started it: `turn:step`. */
    key: string;
    /** Emitted tool-call id; the bare id for the first occurrence of that id. */
    callId: string;
    /** The finish paired to this occurrence, when resolved unambiguously. */
    finish?: FinishOccurrence;
  }
  interface FinishOccurrence {
    index: number;
    event: Extract<LedgerEvent, { type: 'action.finished' }>;
    /** The start this finish belongs to, when resolved unambiguously. */
    start?: StartOccurrence;
  }

  const completedSteps = new Set<string>();
  const stepStarts: number[] = [];
  const starts: StartOccurrence[] = [];
  const startByIndex = new Map<number, StartOccurrence>();
  const finishByIndex = new Map<number, FinishOccurrence>();
  /** How many times each raw id has already appeared, in ledger order. */
  const occurrences = new Map<string, number>();
  /** Starts of one `id:turn:step` still waiting for their finish, in order. */
  const awaiting = new Map<string, StartOccurrence[]>();

  // A start and its finish pair by the same id and the same turn/step; an event
  // without that metadata cannot be correlated and stays record text.
  const occurrenceKey = (id: string, turn: number | undefined, step: number | undefined): string | undefined =>
    typeof turn === 'number' && typeof step === 'number' ? `${id}:${turn}:${step}` : undefined;

  events.forEach((event, index) => {
    if (event.type === 'action.started') {
      const ordinal = occurrences.get(event.id) ?? 0;
      occurrences.set(event.id, ordinal + 1);
      const name = event.action.type === 'tool' ? toolCallName(event.input) : undefined;
      const start: StartOccurrence = {
        index,
        type: event.action.type,
        intent: event.action.prompt,
        ...(name === undefined ? {} : { name }),
        key: stepKey(event.turn, event.step),
        // The first occurrence keeps the bare id so the bytes already sent to
        // the model never change; a reuse gets a stable id from its own event.
        callId: ordinal === 0
          ? event.id
          : `${event.id}_${event.turn ?? 0}_${event.step ?? 0}_${event.seq}`,
      };
      starts.push(start);
      startByIndex.set(index, start);
      const key = occurrenceKey(event.id, event.turn, event.step);
      if (key !== undefined) awaiting.set(key, [...(awaiting.get(key) ?? []), start]);
    } else if (event.type === 'action.finished'
      && event.afterInterrupt !== true) {
      const finish: FinishOccurrence = { index, event };
      finishByIndex.set(index, finish);
      const key = occurrenceKey(event.id, event.turn, event.step);
      const start = key === undefined ? undefined : awaiting.get(key)?.shift();
      if (start !== undefined) {
        finish.start = start;
        start.finish = finish;
      }
    } else if (event.type === 'reasoning.completed') {
      completedSteps.add(stepKey(event.turn, event.step));
    } else if (event.type === 'step.started') {
      stepStarts.push(index);
    }
  });

  const isNative = (start: StartOccurrence): boolean => completedSteps.has(start.key);
  /** The result was not yet available when some later request was assembled. */
  const arrivedLate = (start: StartOccurrence): boolean => {
    const end = start.finish?.index ?? Number.POSITIVE_INFINITY;
    return stepStarts.some((at) => at > start.index && at < end);
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
      case 'files.attached': {
        // A cold attachment is a stub of names and kinds, and it carries no
        // image parts: image bytes are the bulkiest thing in the context.
        if (isReduced(event)) {
          pushText(render(event)!);
          break;
        }
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
      case 'reasoning.thinking':
        break;
      case 'action.started': {
        const start = startByIndex.get(index);
        // An action whose reasoning step never completed has no assistant
        // message to hang on: it stays record text. Each occurrence is judged
        // on its own, so a reused id is never dropped.
        if (start === undefined || !isNative(start)) pushText(render(event)!);
        break;
      }
      case 'reasoning.completed': {
        const key = stepKey(event.turn, event.step);
        const calls = starts.filter((start) => start.key === key);
        if (event.text === '' && calls.length === 0) break;
        endUserMessage();
        const reduced = isReduced(event);
        /** Cold arguments keep the head and the tail of the original intent. */
        const argument = (intent: string): string => (reduced
          ? cutReleasedChars(intent, REDUCED_ARGUMENT_LIMIT, REDUCED_ARGUMENT_HEAD, REDUCED_ARGUMENT_TAIL)
          : intent);
        messages.push({
          role: 'assistant',
          content: reduced
            ? cutReleasedChars(event.text, REDUCED_TEXT_LIMIT, REDUCED_TEXT_HEAD, REDUCED_TEXT_TAIL)
            : event.text,
          // A `tool` action replays under its own native name with its raw
          // arguments string; every built-in action keeps the wy_action shape.
          toolCalls: calls.map((start) => start.type === 'tool'
            ? { id: start.callId, name: start.name ?? '', arguments: argument(start.intent) }
            : {
                id: start.callId,
                name: 'wy_action',
                arguments: JSON.stringify({ type: start.type, intent: argument(start.intent) }),
              }),
        });
        for (const start of calls) {
          const content = start.finish === undefined || arrivedLate(start)
            ? ACTION_RUNNING
            : actionResultText(start.finish.event, isReduced(start.finish.event));
          messages.push({ role: 'tool', toolCallId: start.callId, content });
        }
        break;
      }
      case 'action.finished': {
        if (event.afterInterrupt === true) break;
        // Delivered as the action's own tool result unless the pair is
        // unresolved or the result arrived late; a late or orphaned result
        // stays an <action-result> record.
        const start = finishByIndex.get(index)?.start;
        if (start !== undefined && isNative(start) && !arrivedLate(start)) break;
        pushText(render(event)!);
        break;
      }
      case 'step.started':
        pushText(render(event)!);
        endUserMessage();
        break;
      case 'context.compacted':
        // The handover note replaces every summarised event as one block.
        pushText(renderCompactionBlock(event));
        break;
      default: {
        const text = render(event);
        if (text !== undefined) pushText(text);
      }
    }
  }
  endUserMessage();
  return messages;
}

/** The native tool name carried by a `tool` action's parsed input, if any. */
function toolCallName(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const name = (input as { name?: unknown }).name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * The text of one action's tool result: its outcome when not done, then the
 * result. A cold result is cut to its head and tail; the outcome stays.
 */
function actionResultText(
  event: Extract<LedgerEvent, { type: 'action.finished' }>,
  reduced = false,
): string {
  const full = event.result === '' ? '(no output)' : event.result;
  const result = reduced
    ? cutReleasedTokens(full, REDUCED_RESULT_LIMIT, REDUCED_RESULT_HEAD, REDUCED_RESULT_TAIL)
    : full;
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
 * changes per request (time, turn, step, model, size) is the `<wy-info .../>`
 * line each `step.started` event renders inside the context.
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
  step: number;
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
  /**
   * When set, the system message content is exactly this string instead of
   * REASON_SYSTEM plus the `<wy-global>` AGENTS.md and REASON_ROLE. An agent
   * tool port supplies its own whole system prompt through this option.
   */
  systemOverride?: string;
}

/**
 * The main reasoning request, laid out so that each request is the previous one
 * plus an appended tail: a stable head (workspace and session facts), the
 * append-only conversation, and a short closing message naming the request
 * being served. Protocol adapters decide how the messages go on the wire.
 */
export function buildReason(input: ReasonViewInput): BuiltView {
  const systemSeg = input.systemOverride
    ?? `${REASON_SYSTEM}\n<wy-global>\n${escapeBody(input.snapshot.agents)}\n</wy-global>\n${REASON_ROLE}`;
  const workspaceSeg = renderWorkspace(input.snapshot);
  const infoSeg = renderInfo({
    session: input.session, deviceName: input.deviceName, inputFacts: input.inputFacts ?? {},
  });
  const conversation = renderReasonContext(input);
  const ctxText = renderEventsBlock(input.events);
  const userSeg = `<wy-user turn="${input.session.turn}">\n${escapeBody(input.userText)}\n</wy-user>`;
  const ctxLayers = conversation.reduce((total, message) => {
    const calls = (message.toolCalls ?? []).reduce((sum, call) => sum + call.arguments.length, 0);
    const content = typeof message.content === 'string'
      ? message.content.length
      : message.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : part.image_url.url.length), 0);
    return total + calls + content;
  }, 0);
  const segments: Record<string, string> = {
    'wy-system': input.systemOverride ?? REASON_SYSTEM,
    ...(input.systemOverride === undefined ? { 'wy-global': input.snapshot.agents, 'wy-role': REASON_ROLE } : {}),
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
