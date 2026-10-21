/**
 * The dispatch auxiliary task: compile one dispatch intent into a task run.
 *
 * It validates the model's JSON against the chosen task's input schema, builds
 * the task `ctx` from the ledger (the conversation, documents,
 * memories and session files already in context), opens the run, records its
 * artifacts and returns the rendered result as a deferred draft set.
 */

import type { LadderStep } from '@wrenyard/auto-routing';
import { existsSync } from 'node:fs';

/** The dispatch compiler tries mid models first, then low models, then the ordinary ranked order over the rest. */
export const DISPATCH_LADDER: readonly LadderStep[] = [
  { intelligence: ['mid'] },
  { intelligence: ['low'] },
  { intelligence: ['low', 'mid', 'high', 'premium'] },
];

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

import { renderTaskResult } from './dispatch-result.ts';
import { fail, isObject, renderRunFiles, withAuxiliaryRetry } from './shared.ts';
import { messageOf } from '../errors.ts';
import {
  collectSessionFiles,
  type ActionFinishedEvent,
  type DocumentContentEvent,
  type LedgerEvent,
  type LedgerEventDraft,
  type SpanStatus,
  type TaskSpanMetrics,
  type WorkspaceSnapshot,
} from '../ledger/store.ts';
import { currentDocument } from '../documents.ts';
import { escapeAttr, escapeBody, renderEventText, renderEventsBlock, tag, twoPartView } from '../context/render.ts';
import type { BuiltView, ProjectInfo } from '../ports.ts';
import type {
  ActionExecutionOutcome,
  ActionRunContext,
  ActionStatus,
  ActionTaskInfo,
  ActionWorkflowDeps,
  ParsedAction,
} from '../reasoning/actions.ts';

// ─── JSON schema validation (AJV, draft-07) ────────────────────────────────

export type SchemaValidation = { ok: true } | { ok: false; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: false });

const compiledSchemas = new WeakMap<object, ValidateFunction>();

function compileSchema(schema: boolean | Record<string, unknown>): ValidateFunction {
  if (typeof schema === 'boolean') return ajv.compile(schema);
  const cached = compiledSchemas.get(schema);
  if (cached) return cached;
  const validate = ajv.compile(schema);
  compiledSchemas.set(schema, validate);
  return validate;
}

function describeErrors(errors: readonly ErrorObject[]): string[] {
  return errors.map((error) => {
    const location = error.instancePath === '' ? '/' : error.instancePath;
    return `${location} ${error.message ?? 'is invalid'}`;
  });
}

/** Validate a JSON value against a draft-07 schema. Formats are not enforced. */
export function validateJsonSchema(schema: unknown, value: unknown): SchemaValidation {
  if (typeof schema !== 'boolean' && !isObject(schema)) return { ok: true };
  let validate: ValidateFunction;
  try {
    validate = compileSchema(schema as boolean | Record<string, unknown>);
  } catch (error) {
    return { ok: false, errors: [`schema is not valid: ${messageOf(error)}`] };
  }
  if (validate(value)) return { ok: true };
  return { ok: false, errors: describeErrors(validate.errors ?? []) };
}

// ─── Task context normalizer ─────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class TaskContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskContextError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertContextValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TaskContextError(`${path} must contain only finite numbers`);
    return;
  }
  if (typeof value !== 'object') {
    throw new TaskContextError(`${path} must contain only JSON-serializable values`);
  }
  if (ancestors.has(value)) throw new TaskContextError(`${path} must not contain cycles`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertContextValue(item, `${path}[${index}]`, ancestors));
  } else {
    if (!isPlainObject(value)) {
      throw new TaskContextError(`${path} must contain only plain JSON objects`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.length < 1) {
        throw new TaskContextError(`${path} keys must not be empty`);
      }
      if (FORBIDDEN_KEYS.has(key) || /[\u0000-\u001f\u007f]/u.test(key)) {
        throw new TaskContextError(`${path} contains an unsafe key '${key}'`);
      }
      assertContextValue(child, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

/**
 * Validate and detach a JSON-safe task context.
 */
export function normalizeTaskContext(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TaskContextError('ctx must be a JSON object');
  try {
    assertContextValue(value, 'ctx', new Set<object>());
    const serialized = JSON.stringify(value);
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TaskContextError) throw error;
    throw new TaskContextError(`Cannot serialize task context: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Compile view ───────────────────────────────────────────────────────────

const COMPILE_SYSTEM = `<wy-system>
You are the task compiler. Generate run parameters only for the one dispatch that this <intent> refers to.
Output exactly one strict JSON object: {"project":"project id","task":"task id","input":<value matching the schema>,"title":"short phrase"}, plus "worktree":"worktree id" only when the rule below asks for it, plus "fast":true or "fast":false only when the rule below asks for it.
Rules:
- project must come from the project list. task must come from the task list and belong to the chosen project or be a builtin task.
- <intent> is the sole authority for this action. <reference-context> is only for cross-checking and cannot authorize sibling tasks or historical goals. Do only the one thing that <intent> describes. Keep the exact registered project and task it names. They must not be replaced with a parent project, a sibling project or an unrelated project. Builtin tasks (including explore) remain usable for a correctly named registered subproject.
- worktree: when <intent> names a managed worktree of the chosen project (for example "worktree 'wy-abcd'"), copy that worktree id exactly into "worktree" so the task runs inside it. Otherwise omit the field. Never invent one.
- fast: emit it only when <intent> explicitly requests upstream Fast mode on or off for this dispatch. Never infer it from "fast" meaning a quick task, from task routing speed or from the main conversation model's own settings. Emit false when the intent explicitly turns Fast off; omit the field when the intent states no Fast preference.
- input must strictly match the input schema of the chosen task. The schema is visible only here.
- The program attaches the conversation, the documents and memories already in context, and the session files to the task automatically. Put in input only what the task's input schema asks for.
- title is a short phrase that summarizes what this task does. Write it in the language of the <user> message in <reference-context>: at most 20 characters for Chinese or Japanese, at most 8 words otherwise.
- The context is already given in full as text. Do not echo the conversation as JSON.
- docsRoot is the project documentation directory relative to workspace-root. checkout is the business source directory. Resolve workspace-relative paths (documents and references) against workspace-root, not against checkout.
- Do not invent registered checkouts or paths. Use only the values given in the project list.
- The runtime creates an artifact directory for each task (Task artifact dir) and gives it in the execution prompt when the task declares artifacts output. Unless the user explicitly gives a fallback path, omit the optional output_dir. Do not invent it.
- Output only JSON, with no code fence or extra explanation.
</wy-system>`;

export interface CompileTaskInput {
  id: string; project?: string; description: string; inputSummary: string[];
  inputSchema: unknown; requiredCapabilities?: readonly string[];
}

export interface CompileViewInput {
  kind: 'dispatch'; intent: string; userText: string; events: LedgerEvent[];
  workspaceRoot: string;
  projects: { id: string; displayName?: string; workspaceDir: string; checkoutPath?: string }[];
  tasks: CompileTaskInput[];
  /** Rendered verified tool contracts, inserted right before the <intent> tag. */
  contracts?: string;
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
      const capabilities = (task.requiredCapabilities ?? []).join(',');
      const inner = [
        tag('description', [], escapeBody(task.description)),
        tag('input-summary', [], escapeBody(task.inputSummary.join('; '))),
        tag('input-schema', [], escapeBody(JSON.stringify(task.inputSchema))),
      ].join('\n');
      return `<task id="${escapeAttr(task.id)}"${project} capabilities="${escapeAttr(capabilities)}">\n${inner}\n</task>`;
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
    ...(input.contracts === undefined || input.contracts === '' ? [] : [input.contracts]),
    tag('intent', [], escapeBody(input.intent)),
  ].join('\n');
  return twoPartView(COMPILE_SYSTEM, tag('wy-compile', [], body), 'wy-compile');
}

/**
 * Characters of the most recent rendered events kept in the compile view. The
 * compiler only needs the tail of the conversation the one intent depends on,
 * so the full ledger is never re-sent on every compile attempt.
 */
const COMPILE_CONTEXT_EVENT_CHARS = 24_000;

/**
 * The index of the event that carries the current turn's request: the turn's
 * own `turn.started`. It opens the turn, so scanning oldest first finds the
 * single such event in a real ledger; a history that repeats the same turn
 * number keeps the oldest match, which is still the event that opened the
 * turn. The event is identified by its turn, not by matching the request text,
 * because the request wording differs from the block the intent names.
 * Returns undefined when no event belongs to `turn`.
 */
function currentTurnIntentIndex(events: readonly LedgerEvent[], turn: number): number | undefined {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === 'turn.started' && event.turn === turn) return index;
  }
  return undefined;
}

/**
 * The compile view's reference events: the event carrying the current turn's
 * request is pinned and kept unconditionally; every other event whose rendered
 * text names something in `focus` — the project and task ids the one intent
 * refers to — shares {@link COMPILE_CONTEXT_EVENT_CHARS} with a bounded tail of
 * the most recent other events. Walking newest to oldest, the pinned intent
 * event is never budgeted and every other kept event is; events that render no
 * text are skipped. Because the intent event is pinned by its turn, a long
 * history that names the same project cannot push the request out of the
 * budget. When no event belongs to the current turn, the newest focused event
 * is pinned instead. Events beyond the budget are skipped. The result is
 * returned in chronological order, so the compiler still reads the
 * conversation in order.
 */
function boundCompileEvents(
  events: readonly LedgerEvent[],
  focus: ReadonlySet<string>,
  turn: number,
): LedgerEvent[] {
  const tokens = [...focus];
  const intentIndex = currentTurnIntentIndex(events, turn);
  let focusChars = 0;
  let tailChars = 0;
  // A pinned intent event satisfies the unconditional keep; without one the
  // newest focused event is the fallback pin.
  let pinned = intentIndex !== undefined;
  const kept = new Set<number>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = renderEventText(events[index]!);
    if (text === undefined) continue;
    if (index === intentIndex) {
      kept.add(index);
      continue;
    }
    if (tokens.some((token) => text.includes(token))) {
      if (!pinned) {
        pinned = true;
        focusChars += text.length;
        kept.add(index);
        continue;
      }
      if (focusChars + tailChars + text.length > COMPILE_CONTEXT_EVENT_CHARS) continue;
      focusChars += text.length;
      kept.add(index);
      continue;
    }
    if (tailChars + text.length > COMPILE_CONTEXT_EVENT_CHARS) continue;
    tailChars += text.length;
    kept.add(index);
  }
  return events.filter((_, index) => kept.has(index));
}

// ─── Dispatch action ────────────────────────────────────────────────────────

/**
 * A dispatch that ends before its task run exists. The result says so in its
 * first words, so the session never reads it as work in progress.
 */
function notDispatched(reason: string): ActionExecutionOutcome {
  return fail(`Not dispatched; no task run was created. ${reason}`);
}

/** Start one dispatch action for a parsed intent. */
export async function runDispatchAction(
  deps: ActionWorkflowDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const contracts: CompileContract[] = [];
  for (const task of ctx.tasks) {
    let contract: TaskContract;
    try {
      contract = await deps.host.describeTask(task.id, task.project);
    } catch (error) {
      if (isObject(error) && error.code === 'task_not_found') continue;
      return notDispatched(`describeTask failed: ${messageOf(error)}`);
    }
    contracts.push({
      ...task,
      inputSchema: contract.inputSchema,
      requiredCapabilities: contract.requiredCapabilities ?? [],
      requiredTools: contract.requiredTools ?? [],
    });
  }

  // The compile view pins the event that carries this turn's request and keeps
  // a bounded share of the other events that name the project or task this one
  // intent refers to, plus a bounded tail of the most recent conversation.
  const focus = new Set<string>();
  for (const project of ctx.projects) {
    if (action.intent.includes(project.id)) focus.add(project.id);
  }
  for (const contract of contracts) {
    if (action.intent.includes(contract.id)) focus.add(contract.id);
  }

  const compileInput: CompileViewInput = {
    kind: 'dispatch',
    intent: action.intent,
    userText: ctx.userText,
    events: boundCompileEvents(ctx.currentEvents(), focus, ctx.turn),
    workspaceRoot: ctx.workspaceRoot,
    projects: ctx.projects.map((project) => ({
      id: project.id,
      displayName: project.displayName,
      workspaceDir: project.workspaceDir,
      ...(project.checkoutPath === undefined ? {} : { checkoutPath: project.checkoutPath }),
    })),
    tasks: contracts,
  };
  const view = buildCompile(compileInput);
  // A failed call or unusable output is a system fault, not a decision of
  // the reasoning model. It is retried by the shared auxiliary retry: an
  // unusable output is sent back with the reason it was rejected.
  let attemptView = view;
  const compiledOutcome = await withAuxiliaryRetry<Extract<ReturnType<typeof checkCompiled>, { ok: true }>, { error: string }>(async () => {
    const outcome = await runCompileCall(deps, attemptView, ctx);
    if (!outcome.ok) return { ok: false, error: `compile call failed: ${outcome.error}` };
    const checked = checkCompiled(outcome.text, ctx, contracts);
    if (checked.ok) return { ok: true, value: checked };
    attemptView = {
      ...attemptView,
      messages: [
        ...attemptView.messages,
        { role: 'assistant', content: outcome.text },
        { role: 'user', content: `The previous output cannot be used: ${checked.error}\nOutput only the corrected complete JSON.` },
      ],
    };
    return { ok: false, error: checked.error };
  }, ctx.signal);
  if (!compiledOutcome.ok) return notDispatched(compiledOutcome.error);
  const compiled = compiledOutcome.value;

  const { parsed, project, taskId, worktree, effectiveInput, fast } = compiled;

  // Capability gate: a task whose contract requires a capability no execution
  // environment provides must not open a run at all. Only the built-in text and
  // image capabilities are serviceable today.
  const resolvedContract = contracts.find((candidate) => candidate.id === taskId
    && (candidate.project === undefined || candidate.project === project.id));
  const unsupported = (resolvedContract?.requiredCapabilities ?? [])
    .filter((capability) => capability !== 'text' && capability !== 'image');
  if (unsupported.length > 0) {
    return notDispatched(`cannot dispatch task '${taskId}': no execution environment provides required capabilities: ${unsupported.join(', ')}`);
  }

  // Execution-environment tool gate: the gate requires only the execution tools
  // this compiled input will mount, resolved from the task's feature selection
  // by the host. The declared ids are mapped through the local alias table
  // before comparing, so for example `computer-use` matches the environment's
  // `desktop`.
  let requiredTools = resolvedContract?.requiredTools ?? [];
  if (deps.host.mountedTaskTools !== undefined) {
    try {
      requiredTools = await deps.host.mountedTaskTools(taskId, project.id, effectiveInput);
    } catch (error) {
      return notDispatched(messageOf(error));
    }
  }
  if (requiredTools.length > 0) {
    let available: readonly string[];
    try {
      available = deps.host.environmentTools === undefined ? [] : await deps.host.environmentTools();
    } catch (error) {
      return notDispatched(messageOf(error));
    }
    const missing = requiredTools
      .map((tool) => TOOL_ID_ALIASES[tool] ?? tool)
      .filter((tool) => !available.includes(tool));
    if (missing.length > 0) {
      return notDispatched(
        `cannot dispatch task '${taskId}': this execution environment does not provide the required tools: ${missing.join(', ')} (available: ${available.length === 0 ? 'none' : available.join(', ')})`,
      );
    }
  }

  const rawTitle = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const title = rawTitle !== '' && rawTitle.length <= 40 ? rawTitle : '';
  if (title !== '') ctx.onTitle?.(title);

  // The program — not the compile model — attaches the shared context to the
  // task. It is built from the ledger alone: no model call and no disk read.
  let taskCtx: Record<string, unknown>;
  try {
    taskCtx = buildTaskContext(ctx.currentEvents(), ctx.actionId, project);
  } catch (error) {
    return notDispatched(messageOf(error));
  }

  try {
    const conflict = await deps.host.findTaskWriteConflict({
      project: project.id,
      task: taskId,
      input: effectiveInput,
      ...(worktree === undefined ? {} : { worktree }),
    })
    if (conflict) {
      return notDispatched(
        `Its write targets overlap running task run '${conflict.runId}' (task '${conflict.taskId}'): ${conflict.overlap.join(', ')}`,
      )
    }
  } catch (error) {
    return notDispatched(messageOf(error))
  }

  let taskRunId: string;
  try {
    const createParams: Parameters<ActionWorkflowDeps['host']['createTaskRun']>[0] & { title?: string } = {
      task: taskId,
      project: project.id,
      ...(worktree === undefined ? {} : { worktree }),
      input: effectiveInput,
      ctx: taskCtx,
      ...(fast === undefined ? {} : { fast }),
      ...(title === '' ? {} : { title }),
    };
    const run = await deps.host.createTaskRun(createParams);
    taskRunId = run.taskRunId;
  } catch (error) {
    return notDispatched(`createTaskRun failed: ${messageOf(error)}`);
  }

  // The task run is recorded as its own observational span, opened as soon as
  // the run exists and closed when the wait ends.
  const taskSpanId = deps.nextSpanId();
  await deps.appendSpan({
    type: 'span.started',
    id: taskSpanId,
    parent: ctx.actionId,
    kind: 'task',
    turn: ctx.turn,
    step: ctx.step,
    request: {
      task: taskId,
      project: project.id,
      ...(worktree === undefined ? {} : { worktree }),
      taskRunId,
    },
  });

  await ctx.onTaskRun(taskRunId);
  if (ctx.signal.aborted) {
    // Cancelled just after the run opened: cancel, then still wait below so
    // the run settles and is recorded, not lost.
    await deps.host.cancelTaskRun(taskRunId).catch(() => undefined);
  } else {
    ctx.onDispatched?.();
  }

  let waited: Waited | undefined;
  let waitError: unknown;
  try {
    waited = await deps.host.waitTaskRun(taskRunId, ctx.signal);
  } catch (error) {
    waitError = error;
  }

  // A thrown wait is failed or cancelled, never a false done.
  const aborted = ctx.signal.aborted;
  const status: ActionStatus = waited === undefined
    ? (aborted ? 'cancelled' : 'failed')
    : mapTaskStatus(waited.status, aborted);
  const taskStatus = waited?.status ?? (aborted ? 'cancelled' : 'failed');
  const deferred: LedgerEventDraft[] = [];
  let result = waited === undefined ? `waitTaskRun failed: ${messageOf(waitError)}` : renderTaskResult(waited.output);

  // Close the task span: ok only when the task finished as done, aborted when
  // an interrupt cancelled it, failed otherwise.
  const spanStatus: SpanStatus = waited !== undefined && waited.status === 'done'
    ? 'ok'
    : aborted ? 'aborted' : 'failed';
  const metrics = taskSpanMetrics(taskStatus, waited?.usage);
  await deps.appendSpan({
    type: 'span.finished',
    id: taskSpanId,
    kind: 'task',
    turn: ctx.turn,
    step: ctx.step,
    status: spanStatus,
    ...(spanStatus === 'failed'
      ? { error: { kind: 'task' as const, message: waitError !== undefined ? messageOf(waitError) : `task ${taskStatus}` } }
      : {}),
    metrics,
  });

  // Task artifacts and leftover files are recorded after the wait fence for
  // every outcome (done, failed, cancelled, thrown).
  if (action.type === 'dispatch' && (waited?.artifacts?.length ?? 0) > 0) {
    const described = await deps.fileStore.describeArtifacts({
      sessionId: ctx.sessionId,
      taskRunId,
      actionId: ctx.actionId,
      artifacts: waited!.artifacts!,
    });
    if (described.files.length > 0) {
      deferred.push({
        type: 'files.attached',
        turn: ctx.turn,
        step: ctx.step,
        source: 'task',
        files: described.files,
        taskRunId,
        parent: ctx.actionId,
      });
    }
    result = appendDiagnostics(result, described.errors);
  }
  // An unfinished run reports what it left behind, so the work is not redone blind.
  if (action.type === 'dispatch' && status !== 'done') {
    const left = await deps.fileStore.listRunFiles(taskRunId);
    if (left.length > 0) result = `${result}\n${renderRunFiles(left)}`;
  }
  // Invalid artifact descriptors dropped by the host are surfaced in text.
  if (waited?.artifactErrors !== undefined) result = appendDiagnostics(result, waited.artifactErrors);

  return { status, result, taskRunId, taskStatus, task: taskId, deferred };
}

/** One compile model call; a failure is returned, not thrown. */
async function runCompileCall(
  deps: ActionWorkflowDeps,
  view: BuiltView,
  ctx: ActionRunContext,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const spanId = deps.nextSpanId();
  try {
    const result = await deps.calls.run({
      spanId,
      parent: ctx.actionId,
      role: 'dispatch',
      turn: ctx.turn,
      step: ctx.step,
      messages: view.messages,
      layers: view.layers,
      signal: ctx.signal,
    });
    return { ok: true, text: result.text };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** Parse one compile output and validate it up to the task's input schema. */
function checkCompiled(
  text: string,
  ctx: ActionRunContext,
  contracts: readonly CompileContract[],
): { ok: true; parsed: Record<string, unknown>; project: ProjectInfo; taskId: string; worktree?: string; effectiveInput: unknown; fast?: boolean }
  | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text.trim());
    if (!isObject(value)) return bad('compile output must be a single JSON object');
    parsed = value;
  } catch (error) {
    return bad(`compile output is not valid JSON: ${messageOf(error)}`);
  }
  const projectId = parsed.project;
  const taskId = parsed.task;
  if (typeof projectId !== 'string' || typeof taskId !== 'string') {
    return bad('compile output must name a project and a task');
  }
  const project = ctx.projects.find((candidate) => candidate.id === projectId);
  if (!project) return bad(`unknown project: ${projectId}`);
  const contract = contracts.find((candidate) => candidate.id === taskId
    && (candidate.project === undefined || candidate.project === projectId));
  if (!contract) return bad(`unknown task '${taskId}' for project ${projectId}`);
  const worktree = parsed.worktree;
  if (worktree !== undefined && (typeof worktree !== 'string' || worktree.trim() === '')) {
    return bad('worktree must be a non-empty worktree id when present');
  }
  // Optional generic Fast preference; an invalid type is rejected, an absent
  // value means the task run gets no preference.
  const fast = parsed.fast;
  if (fast !== undefined && typeof fast !== 'boolean') {
    return bad('fast must be a boolean when present');
  }

  // Reject a model-provided absolute input path that does not exist on disk.
  const missingPath = findMissingAbsolutePath(parsed.input);
  if (missingPath !== undefined) return bad(`input references a missing path: ${missingPath}`);

  const effectiveInput: unknown = parsed.input;
  const validation = validateJsonSchema(contract.inputSchema, effectiveInput);
  if (!validation.ok) {
    return bad(`input does not satisfy the task schema: ${validation.errors.join('; ')}`);
  }
  return { ok: true, parsed, project, taskId, ...(worktree === undefined ? {} : { worktree: worktree.trim() }), effectiveInput, ...(fast === undefined ? {} : { fast }) };
}

// ─── Task context builder ───────────────────────────────────────────────────

/** One document (or instruction) already in context, with its current text. */
type TaskDocument = { path: string; version: string; content: string };

/** Characters of a finished action result shown inline in the conversation. */
const CONVERSATION_RESULT_PREVIEW = 200;

/**
 * Build the shared task context from the ledger alone: no model call and no
 * disk read. The compile model only compiles the call; the program attaches
 * the conversation the reasoning model saw, the documents and memories already
 * in context, and metadata for the session files.
 */
function buildTaskContext(
  events: readonly LedgerEvent[],
  currentActionId: string,
  project: ProjectInfo,
): Record<string, unknown> {
  const documents = collectCurrentDocuments(events, (event) => event.source !== 'project-instructions');
  const ctx: Record<string, unknown> = {
    conversation: buildConversation(events, currentActionId),
    documents,
    project_instructions: collectCurrentDocuments(events, (event) =>
      event.source === 'project-instructions' && isProjectInstructionPath(event.path, project.workspaceDir)),
    memories: collectMemories(events),
    session_files: collectSessionFiles(events).map((file) => ({
      path: file.path,
      kind: file.kind,
      mime: file.mime,
      ...(typeof file.description === 'string' && file.description !== '' ? { description: file.description } : {}),
    })),
  };
  return normalizeTaskContext(ctx);
}

/** Distinct documents already in context, in first-seen order, current text. */
function collectCurrentDocuments(
  events: readonly LedgerEvent[],
  include: (event: DocumentContentEvent) => boolean,
): TaskDocument[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'document.content' || !include(event)) continue;
    if (seen.has(event.path)) continue;
    seen.add(event.path);
    paths.push(event.path);
  }
  const documents: TaskDocument[] = [];
  for (const path of paths) {
    const current = currentDocument(events, path);
    if (current === undefined) continue;
    documents.push({ path, version: current.version, content: current.content });
  }
  return documents;
}

/** The chosen project's own instructions, or the workspace root `AGENTS.md`. */
function isProjectInstructionPath(path: string, workspaceDir: string): boolean {
  return path === 'AGENTS.md' || path.startsWith(`${workspaceDir}/`);
}

/** Latest content of each recalled memory, in first-seen order. */
function collectMemories(events: readonly LedgerEvent[]): { path: string; content: string }[] {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'memory.recalled') latest.set(event.path, event.content);
  }
  return [...latest.entries()].map(([path, content]) => ({ path, content }));
}

/**
 * The conversation the reasoning model already saw, as text: user messages,
 * visible model output, and one line per action with the start of its result.
 * Observational events and the current dispatch action itself are excluded.
 */
function buildConversation(events: readonly LedgerEvent[], currentActionId: string): string {
  const finished = new Map<string, ActionFinishedEvent>();
  for (const event of events) {
    if (event.type !== 'action.finished') continue;
    if (event.id === currentActionId || event.afterInterrupt === true) continue;
    finished.set(event.id, event);
  }
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === 'turn.started' || event.type === 'reasoning.completed') {
      const text = renderEventText(event);
      if (text !== undefined) lines.push(text);
      continue;
    }
    if (event.type !== 'action.started' || event.id === currentActionId) continue;
    const start = renderEventText(event);
    if (start === undefined) continue;
    const done = finished.get(event.id);
    lines.push(done === undefined ? start : `${start} ${renderActionResultStart(done)}`);
  }
  return lines.join('\n');
}

/** One action result as a single line: its status and the start of its text. */
function renderActionResultStart(event: ActionFinishedEvent): string {
  return tag('action-result', [['id', event.id], ['status', event.status]], escapeBody(resultPreview(event.result)));
}

function resultPreview(result: string): string {
  const firstLine = result.split('\n', 1)[0] ?? '';
  return firstLine.length > CONVERSATION_RESULT_PREVIEW
    ? `${firstLine.slice(0, CONVERSATION_RESULT_PREVIEW)}…`
    : firstLine;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The host's wait result, derived from the authoritative `SessionHost` type. */
type Waited = Awaited<ReturnType<ActionWorkflowDeps['host']['waitTaskRun']>>;

/** The host's task contract, derived from the authoritative `SessionHost` type. */
type TaskContract = Awaited<ReturnType<ActionWorkflowDeps['host']['describeTask']>>;


type CompileContract = ActionTaskInfo & {
  inputSchema: unknown;
  requiredCapabilities: readonly string[];
  requiredTools: readonly string[];
};

/**
 * Local aliases mapping a task's declared execution-tool ids onto the ids an
 * environment reports. Kept here so the session package never imports daemon
 * code for the mapping.
 */
const TOOL_ID_ALIASES: Readonly<Record<string, string>> = {
  'browser-use': 'browser',
  computer: 'desktop',
  'computer-use': 'desktop',
};

/** Recursively find the first absolute path string in `value` that does not exist. */
function findMissingAbsolutePath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (!value.startsWith('/')) return undefined;
    return existsSync(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const missing = findMissingAbsolutePath(item);
      if (missing !== undefined) return missing;
    }
    return undefined;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) {
      const missing = findMissingAbsolutePath(child);
      if (missing !== undefined) return missing;
    }
  }
  return undefined;
}

function mapTaskStatus(status: string, aborted: boolean): ActionStatus {
  if (aborted) return 'cancelled';
  switch (status) {
    case 'done':
      return 'done';
    case 'cancelled':
    case 'interrupted':
      return 'cancelled';
    default:
      return 'failed';
  }
}

/** Append stripped-artifact diagnostics after the task output. */
function appendDiagnostics(output: string, notes: readonly string[]): string {
  if (notes.length === 0) return output;
  const section = ['artifacts dropped or unavailable:', ...notes.map((note) => `- ${note}`)].join('\n');
  return output === '' ? section : `${output}\n${section}`;
}

/**
 * The span summary of a finished task run: its status plus the usage and
 * reference cost the task system reported with the wait result.
 */
function taskSpanMetrics(taskStatus: string, usage: Record<string, unknown> | undefined): TaskSpanMetrics {
  const metrics: TaskSpanMetrics = { taskStatus };
  if (usage === undefined) return metrics;
  const inputTokens = finiteNumber(usage.input_tokens);
  const cachedInputTokens = finiteNumber(usage.cached_input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  const totalTokens = finiteNumber(usage.total_tokens);
  if (inputTokens !== undefined || cachedInputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
    metrics.usage = {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
    };
  }
  const referenceCostUsd = finiteNumber(usage.reference_cost_usd);
  const generationMs = finiteNumber(usage.generation_ms);
  const outputTps = finiteNumber(usage.output_tps);
  if (referenceCostUsd !== undefined) metrics.referenceCostUsd = referenceCostUsd;
  if (generationMs !== undefined) metrics.generationMs = generationMs;
  if (outputTps !== undefined) metrics.outputTps = outputTps;
  return metrics;
}

/** One optional finite number from a raw protocol field, else undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
