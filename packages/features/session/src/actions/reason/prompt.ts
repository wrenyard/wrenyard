/**
 * session primary views: the main reasoning request, its prompt layers and the
 * workspace/info blocks.
 *
 * Every builder is a pure function of its input. The main reasoning view emits
 * its stable prefix before its dynamic suffix so provider prompt caching can
 * hit, and an event already on the ledger always renders to the same bytes.
 * This module never calls a model and never touches the ledger.
 */

import type { ModelContentPart, ModelMessage } from '../../driver.ts';
import {
  type LedgerEvent,
  type WorkspaceSnapshot,
} from '../../ledger.ts';
import {
  ACTION_RUNNING,
  escapeBody,
  renderEventText,
  renderEventsBlock,
  renderFiles,
  tag,
} from '../../render.ts';
import type { BuiltView } from '../../ports.ts';

const REASON_SYSTEM = `<wy-system>
You are the conversation orchestrator of Wrenyard (啾啾工坊). You cannot read or write files or run commands. The only way to make the system do something is to call the wy_action tool.

wy_action has six types:
- search: read workspace material: project documents, memories, and files or images that tasks left or the user attached. Give the intent or an exact path.
- dispatch: dispatch a task in a project. State the project, the task, the goal and the acceptance criteria.
- document: create, revise or delete a project's documents. Kinds are spec, report and handoff. State the project, the kind, the document name or title, and what to write.
- vcs: version control of the workspace repository itself: status, diff, commit, push, pull. For a commit list the exact files and the message.
- project: manage registered project checkouts (status, diff, commit, push, pull, worktree create, remove and merge) or register a new project. Name the project and the worktree. For a commit, list the exact files. For registration, give the project id, a description and the checkout path.
- ask: ask the user one question that needs their decision. Send it alone, not together with other calls.

The program handles each of your outputs:
- With tool calls: the program runs them, adds the results to the conversation and calls you again, and you do the next step. You can make several calls at once. Each call expresses one thing, and the calls run concurrently. Send all independent actions in the same output. Do not send one first as a probe.
- Without tool calls: the turn ends here. Nothing else happens until the user sends the next message.
So do not only say "I will read it first" or "next I will do it". Call the tool for the work that needs doing. Output content without calls only when the user's request is fully complete.

The actions you started and their results stay in the conversation as tool calls and tool results. When the result of an action says "Running", its real result arrives later as an <action-result> record. <action-result>, <wy-info> and similar tags are records that the program generates. Writing them in your prose has no effect.
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
          toolCalls: calls.map(([id, start]) => ({
            id,
            name: 'wy_action',
            arguments: JSON.stringify({ type: start.kind, intent: start.intent }),
          })),
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

/**
 * The main reasoning request, laid out so that each request is the previous one
 * plus an appended tail: a stable head (workspace and session facts), the
 * append-only conversation, and a short closing message naming the request
 * being served. Protocol adapters decide how the messages go on the wire.
 */
export function buildReason(input: ReasonViewInput): BuiltView {
  const systemSeg = `${REASON_SYSTEM}\n<wy-global>\n${escapeBody(input.snapshot.agents)}\n</wy-global>\n${REASON_ROLE}`;
  const workspaceSeg = renderWorkspace(input.snapshot);
  const infoSeg = renderInfo({
    session: input.session, deviceName: input.deviceName, inputFacts: input.inputFacts ?? {},
  });
  const conversation = renderReasonContext(input);
  const ctxText = renderEventsBlock(input.events);
  const userSeg = `<wy-user>\n${escapeBody(input.userText)}\n</wy-user>`;
  const ctxLayers = conversation.reduce((total, message) => {
    const calls = (message.toolCalls ?? []).reduce((sum, call) => sum + call.arguments.length, 0);
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
