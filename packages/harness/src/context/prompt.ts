/**
 * Primary views: the main reasoning request, its prompt layers, and the
 * workspace/info blocks.
 *
 * Every builder is a pure function of its input. The main reasoning view emits
 * its stable prefix before its dynamic suffix so provider prompt caching can
 * hit, and an event already on the ledger always renders to the same bytes.
 */

import type { Message as ModelMessage, ModelContentPart } from '@wrenyard/ai/transport';
import type { LedgerEvent, WorkspaceSnapshot } from '../events.ts';
import type { BuiltView } from '../ports.ts';
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
} from './render.ts';
import { renderCompactionBlock } from './compaction.ts';

// Mirrors SYSTEM_DEFAULT_RUN_TIME_LIMIT_MINUTES in @wrenyard/task; declared
// locally to keep this package free of a task-runtime dependency edge.
const DEFAULT_RUN_TIME_LIMIT_MINUTES = 60;

const REASON_SYSTEM = `<wy-system>
You are the conversation orchestrator of Wrenyard (啾啾工坊). You cannot read or write files or run commands. The only way to make the system do something is to call the wy_action tool.

wy_action has seven types:
- search: read workspace material: project documents, memories, and files or images that tasks left or the user attached. Give the intent or an exact path. Search only chooses documents by title; it does not answer questions, so ask current source code, line numbers or values with dispatch, and send one search per topic.
- dispatch: dispatch a task in a project. State the project, the task, the goal and the acceptance criteria. Every task run has a default run time limit of ${DEFAULT_RUN_TIME_LIMIT_MINUTES} minutes, counted from the moment the run starts; when the limit is reached the run is terminated and marked as timed out.
- document: create, revise or delete ordinary project documents (spec, report or handoff), or read/revise an existing registered project AGENTS.md using the fixed document ID AGENTS.md and the same doc methods. For ordinary docs state project, kind, name/title and content; for AGENTS.md state project and the requested revision. Document actions cannot create/delete AGENTS.md, target arbitrary paths, workspace-root or checkout instruction files, or change other source/config/workspace files.
- todo: read workspace todos only through todo.list and todo.get. Sessions cannot create, update, tag, comment on, or otherwise mutate todos. Never bypass this restriction by dispatching tasks or using other tools, and never read todo files directly.
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

function latestCompaction(events: readonly LedgerEvent[]): Extract<LedgerEvent, { type: 'context.compacted' }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'context.compacted') return event;
  }
  return undefined;
}

export function latestReduction(events: readonly LedgerEvent[]): Extract<LedgerEvent, { type: 'context.reduced' }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'context.reduced') return event;
  }
  return undefined;
}

function renderReasonContext(input: ReasonViewInput): ModelMessage[] {
  const images = input.allowImages === false ? {} : (input.images ?? {});
  const compaction = latestCompaction(input.events);
  const events = compaction === undefined
    ? input.events
    : input.events.filter((event) => event.seq > compaction.throughSeq);
  const floorCandidate = input.reducedThroughSeq ?? latestReduction(events)?.throughSeq;
  const reducedFloor = floorCandidate === undefined
    || (compaction !== undefined && floorCandidate <= compaction.throughSeq)
    ? undefined
    : floorCandidate;
  const isReduced = (event: LedgerEvent): boolean => reducedFloor !== undefined && event.seq <= reducedFloor;
  const render = (event: LedgerEvent): string | undefined =>
    renderEventText(event, isReduced(event) ? { reduced: true } : undefined);

  const stepKey = (turn: number | undefined, step: number | undefined): string => `${turn ?? 0}:${step ?? 0}`;
  interface StartOccurrence {
    index: number;
    type: string;
    intent: string;
    name?: string;
    key: string;
    callId: string;
    finish?: FinishOccurrence;
  }
  interface FinishOccurrence {
    index: number;
    event: Extract<LedgerEvent, { type: 'action.finished' }>;
    start?: StartOccurrence;
  }

  const completedSteps = new Set<string>();
  const stepStarts: number[] = [];
  const starts: StartOccurrence[] = [];
  const startByIndex = new Map<number, StartOccurrence>();
  const finishByIndex = new Map<number, FinishOccurrence>();
  const occurrences = new Map<string, number>();
  const awaiting = new Map<string, StartOccurrence[]>();

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
        callId: ordinal === 0
          ? event.id
          : `${event.id}_${event.turn ?? 0}_${event.step ?? 0}_${event.seq}`,
      };
      starts.push(start);
      startByIndex.set(index, start);
      const key = occurrenceKey(event.id, event.turn, event.step);
      if (key !== undefined) awaiting.set(key, [...(awaiting.get(key) ?? []), start]);
    } else if (event.type === 'action.finished' && event.afterInterrupt !== true) {
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
        if (start === undefined || !isNative(start)) pushText(render(event)!);
        break;
      }
      case 'reasoning.completed': {
        const key = stepKey(event.turn, event.step);
        const calls = starts.filter((start) => start.key === key);
        if (event.text === '' && calls.length === 0) break;
        endUserMessage();
        const reduced = isReduced(event);
        const argument = (intent: string): string => (reduced
          ? cutReleasedChars(intent, REDUCED_ARGUMENT_LIMIT, REDUCED_ARGUMENT_HEAD, REDUCED_ARGUMENT_TAIL)
          : intent);
        messages.push({
          role: 'assistant',
          content: reduced
            ? cutReleasedChars(event.text, REDUCED_TEXT_LIMIT, REDUCED_TEXT_HEAD, REDUCED_TEXT_TAIL)
            : event.text,
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

function toolCallName(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const name = (input as { name?: unknown }).name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

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
  /** Optional explicit reduction floor when `events` already filtered out `context.reduced`. */
  reducedThroughSeq?: number;
  /** Whole system message override (used by bot sessions). */
  systemOverride?: string;
}

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
    'wy-workspace': workspaceSeg,
    'wy-info': infoSeg,
    'wy-ctx': ctxText,
    'wy-user': userSeg,
  };
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
