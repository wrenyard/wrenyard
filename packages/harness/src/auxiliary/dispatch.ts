/**
 * The dispatch auxiliary task: compile one dispatch intent into a task run.
 */

import { existsSync } from 'node:fs';
import type { LadderStep } from '@wrenyard/auto-routing';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import {
  bindCatalog,
  createLoopRecord,
  protocolTools,
  runAuxiliaryLoop,
  toActionOutcome,
  type LoopRecord,
  type MethodCatalogPort,
  type MethodInfo,
} from '@wrenyard/loop';
import { getAuxiliaryDefinition } from './definitions.ts';
import type { AuxiliaryRecordPort } from './runner.ts';
import { renderTaskRunResult } from './dispatch-result.ts';
import { fail, isObject, renderRunFiles } from './shared.ts';
import { messageOf } from '../errors.ts';
import {
  collectSessionFiles,
  type ActionFinishedEvent,
  type ActionStatus,
  type DocumentContentEvent,
  type LedgerEvent,
  type LedgerEventDraft,
  type SpanStatus,
  type TaskSpanMetrics,
} from '../events.ts';
import { currentDocument } from '../tools/documents.ts';
import { escapeAttr, escapeBody, renderEventText, renderEventsBlock, tag } from '../context/render.ts';
import type {
  ActionExecutionOutcome,
  ActionRunContext,
  ActionTaskInfo,
  ActionWorkflowDeps,
  ParsedAction,
  ProjectInfo,
} from '../ports.ts';

/** The dispatch compiler tries mid models first, then low models, then the ordinary ranked order over the rest. */
export const DISPATCH_LADDER: readonly LadderStep[] = [
  { intelligence: ['mid'] },
  { intelligence: ['low'] },
  { intelligence: ['low', 'mid', 'high', 'premium'] },
];

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

// ─── Task context normalizer ────────────────────────────────────────────────

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

// ─── Dispatch view ──────────────────────────────────────────────────────────

export interface CompileTaskInput {
  id: string;
  project?: string;
  description: string;
  inputSummary: string[];
  inputSchema: unknown;
  requiredCapabilities?: readonly string[];
}

export interface CompileViewInput {
  kind: 'dispatch';
  intent: string;
  userText: string;
  events: LedgerEvent[];
  workspaceRoot: string;
  projects: { id: string; displayName?: string; workspaceDir: string; checkoutPath?: string }[];
  tasks: CompileTaskInput[];
  contracts?: string;
}

function renderDispatchProjects(projects: CompileViewInput['projects']): string {
  if (projects.length === 0) return '(none)';
  return projects.map((project) => {
    const name = project.displayName === undefined ? '' : ` name=${escapeBody(project.displayName)}`;
    const checkout = project.checkoutPath === undefined
      ? ''
      : ` checkout=${escapeBody(project.checkoutPath)}`;
    return `- id=${escapeBody(project.id)} docsRoot=${escapeBody(project.workspaceDir)}${checkout}${name}`;
  }).join('\n');
}

function renderDispatchTasks(tasks: CompileTaskInput[]): string {
  if (tasks.length === 0) return '(none)';
  return tasks.map((task) => {
    const project = task.project === undefined ? '' : ` project=${escapeBody(task.project)}`;
    const capabilities = (task.requiredCapabilities ?? []).join(',');
    const inner = [
      tag('description', [], escapeBody(task.description)),
      tag('input-summary', [], escapeBody(task.inputSummary.join('; '))),
      tag('input-schema', [], escapeBody(JSON.stringify(task.inputSchema))),
    ].join('\n');
    return `<task id="${escapeAttr(task.id)}"${project} capabilities="${escapeAttr(capabilities)}">\n${inner}\n</task>`;
  }).join('\n');
}

function buildDispatchUser(
  ctx: ActionRunContext,
  intent: string,
  events: readonly LedgerEvent[],
  input: Omit<CompileViewInput, 'kind' | 'intent' | 'events' | 'userText'>,
): string {
  const body = [
    tag('workspace-root', [], escapeBody(ctx.workspaceRoot)),
    tag('projects', [], renderDispatchProjects(input.projects)),
    tag('tasks', [], renderDispatchTasks(input.tasks)),
    '<reference-context>',
    tag('user', [], escapeBody(ctx.userText)),
    renderEventsBlock(events),
    '</reference-context>',
    ...(input.contracts === undefined || input.contracts === '' ? [] : [input.contracts]),
    tag('intent', [], escapeBody(intent)),
  ].join('\n');
  return tag('wy-dispatch', [], body);
}

const COMPILE_CONTEXT_EVENT_CHARS = 24_000;

function currentTurnIntentIndex(events: readonly LedgerEvent[], turn: number): number | undefined {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === 'turn.started' && event.turn === turn) return index;
  }
  return undefined;
}

function boundCompileEvents(
  events: readonly LedgerEvent[],
  focus: ReadonlySet<string>,
  turn: number,
): LedgerEvent[] {
  const tokens = [...focus];
  const intentIndex = currentTurnIntentIndex(events, turn);
  let focusChars = 0;
  let tailChars = 0;
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

// ─── Dispatch protocol catalog (session-local) ──────────────────────────────

const DISPATCH_METHOD_INFOS: readonly MethodInfo[] = [
  {
    name: 'task.contract',
    description: 'Read one registered task contract: description, input schema, required capabilities and tools.',
    params: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Registered project id.' },
        task: { type: 'string', description: 'Task id within the project or a builtin task.' },
      },
      required: ['project', 'task'],
    },
  },
  {
    name: 'task.create',
    description: 'Create one task run after validation. Returns taskRunId on success.',
    params: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        task: { type: 'string' },
        input: { type: 'object', description: 'Task input object matching the task schema; pass a JSON object, never a string.' },
        worktree: {
          type: 'string',
          description:
            'Optional managed worktree id. Include only when the intent explicitly names one, copying the id exactly; never invent. Read-only tasks run in the project checkout without a worktree.',
        },
        fast: { type: 'boolean', description: 'Optional explicit Fast preference.' },
        title: { type: 'string', description: 'Optional short title, at most 40 characters.' },
      },
      required: ['project', 'task', 'input'],
    },
  },
];

type DispatchCreateResult = {
  taskRunId: string;
  taskId: string;
  project: ProjectInfo;
  title: string;
  worktree?: string;
  effectiveInput: unknown;
};

function createDispatchCatalog(
  deps: ActionWorkflowDeps,
  ctx: ActionRunContext,
  contracts: readonly CompileContract[],
  record: LoopRecord,
  onCreated: (result: DispatchCreateResult) => void,
): MethodCatalogPort {
  const local = new Map(DISPATCH_METHOD_INFOS.map((info) => [info.name, info]));
  return {
    async methods(names) {
      const out: MethodInfo[] = [];
      const remote: string[] = [];
      for (const name of names) {
        const info = local.get(name);
        if (info !== undefined) out.push(info);
        else remote.push(name);
      }
      if (remote.length > 0) out.push(...await deps.host.methods(remote));
      return out;
    },
    async call(method, params, context) {
      if (method === 'task.contract') return readTaskContract(params, contracts);
      if (method === 'task.create') {
        const created = await createTaskRunFromTool(deps, ctx, contracts, params);
        if (!created.ok) throw Object.assign(new Error(created.error), { code: 'validation_failed' });
        onCreated(created.value);
        record.observations.push(created.value.taskRunId);
        return { taskRunId: created.value.taskRunId };
      }
      return deps.host.call(method, params, context);
    },
  };
}

function readTaskContract(params: unknown, contracts: readonly CompileContract[]): Record<string, unknown> {
  if (!isObject(params)) throw new Error('task.contract params must be an object');
  const projectId = params.project;
  const taskId = params.task;
  if (typeof projectId !== 'string' || typeof taskId !== 'string') {
    throw new Error('task.contract requires project and task strings');
  }
  const contract = contracts.find((candidate) => candidate.id === taskId
    && (candidate.project === undefined || candidate.project === projectId));
  if (contract === undefined) throw new Error(`unknown task '${taskId}' for project ${projectId}`);
  return {
    project: projectId,
    task: taskId,
    description: contract.description,
    inputSummary: contract.inputSummary,
    inputSchema: contract.inputSchema,
    requiredCapabilities: contract.requiredCapabilities,
    requiredTools: contract.requiredTools,
  };
}

async function createTaskRunFromTool(
  deps: ActionWorkflowDeps,
  ctx: ActionRunContext,
  contracts: readonly CompileContract[],
  params: unknown,
): Promise<{ ok: true; value: DispatchCreateResult } | { ok: false; error: string }> {
  if (!isObject(params)) return { ok: false, error: 'task.create params must be an object' };
  const validated = validateTaskCreate(params, ctx, contracts);
  if (!validated.ok) return validated;
  const { project, taskId, worktree, effectiveInput, fast, title } = validated.value;
  const resolvedContract = contracts.find((candidate) => candidate.id === taskId
    && (candidate.project === undefined || candidate.project === project.id));
  const unsupported = (resolvedContract?.requiredCapabilities ?? [])
    .filter((capability) => capability !== 'text' && capability !== 'image');
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: `cannot dispatch task '${taskId}': no execution environment provides required capabilities: ${unsupported.join(', ')}`,
    };
  }
  let requiredTools = resolvedContract?.requiredTools ?? [];
  if (deps.host.mountedTaskTools !== undefined) {
    try {
      requiredTools = await deps.host.mountedTaskTools(taskId, project.id, effectiveInput);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }
  if (requiredTools.length > 0) {
    let available: readonly string[];
    try {
      available = deps.host.environmentTools === undefined ? [] : await deps.host.environmentTools();
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    const missing = requiredTools
      .map((tool) => TOOL_ID_ALIASES[tool] ?? tool)
      .filter((tool) => !available.includes(tool));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `cannot dispatch task '${taskId}': this execution environment does not provide the required tools: ${missing.join(', ')} (available: ${available.length === 0 ? 'none' : available.join(', ')})`,
      };
    }
  }
  let taskCtx: Record<string, unknown>;
  try {
    taskCtx = buildTaskContext(ctx.currentEvents(), ctx.actionId, project);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
  try {
    const conflict = await deps.host.findTaskWriteConflict({
      project: project.id,
      task: taskId,
      input: effectiveInput,
      ...(worktree === undefined ? {} : { worktree }),
    });
    if (conflict) {
      const timing = renderConflictTiming(conflict);
      return {
        ok: false,
        error: `Its write targets overlap running task run '${conflict.runId}' (task '${conflict.taskId}'): ${conflict.overlap.join(', ')}${timing}`,
      };
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
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
    return {
      ok: true,
      value: {
        taskRunId: run.taskRunId,
        taskId,
        project,
        title,
        effectiveInput,
        ...(worktree === undefined ? {} : { worktree }),
      },
    };
  } catch (error) {
    return { ok: false, error: `createTaskRun failed: ${messageOf(error)}` };
  }
}

function validateTaskCreate(
  parsed: Record<string, unknown>,
  ctx: ActionRunContext,
  contracts: readonly CompileContract[],
): { ok: true; value: {
  project: ProjectInfo;
  taskId: string;
  worktree?: string;
  effectiveInput: unknown;
  fast?: boolean;
  title: string;
} } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
  const projectId = parsed.project;
  const taskId = parsed.task;
  if (typeof projectId !== 'string' || typeof taskId !== 'string') {
    return bad('task.create must name a project and a task');
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
  const fast = parsed.fast;
  if (fast !== undefined && typeof fast !== 'boolean') return bad('fast must be a boolean when present');
  const missingPath = findMissingAbsolutePath(parsed.input);
  if (missingPath !== undefined) return bad(`input references a missing path: ${missingPath}`);
  const effectiveInput: unknown = parsed.input;
  const validation = validateJsonSchema(contract.inputSchema, effectiveInput);
  if (!validation.ok) {
    return bad(`input does not satisfy the task schema: ${validation.errors.join('; ')}`);
  }
  const rawTitle = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const title = rawTitle !== '' && rawTitle.length <= 40 ? rawTitle : '';
  return {
    ok: true,
    value: {
      project,
      taskId,
      ...(worktree === undefined ? {} : { worktree: worktree.trim() }),
      effectiveInput,
      ...(fast === undefined ? {} : { fast }),
      title,
    },
  };
}

// ─── Dispatch action ────────────────────────────────────────────────────────

function notDispatched(reason: string): ActionExecutionOutcome {
  return fail(`Not dispatched; no task run was created. ${reason}`);
}

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

  const focus = new Set<string>();
  for (const project of ctx.projects) {
    if (action.intent.includes(project.id)) focus.add(project.id);
  }
  for (const contract of contracts) {
    if (action.intent.includes(contract.id)) focus.add(contract.id);
  }

  const dispatchView = {
    workspaceRoot: ctx.workspaceRoot,
    projects: ctx.projects.map((project) => ({
      id: project.id,
      displayName: project.displayName,
      workspaceDir: project.workspaceDir,
      ...(project.checkoutPath === undefined ? {} : { checkoutPath: project.checkoutPath }),
    })),
    tasks: contracts,
  };
  const referenceEvents = boundCompileEvents(ctx.currentEvents(), focus, ctx.turn);
  let taskRunId: string | undefined;
  let dispatchedTaskId = '';
  let dispatchedProject: ProjectInfo | undefined;
  let dispatchedWorktree: string | undefined;
  let dispatchedInput: unknown;
  const record: AuxiliaryRecordPort = {
    ...createLoopRecord(),
    helpers: {
      messageOf,
      escapeBody,
      renderEventsBlock: (events) => renderEventsBlock(events as readonly LedgerEvent[]),
    },
  };
  const definition = getAuxiliaryDefinition('dispatch');
  if (definition === undefined) return notDispatched('dispatch auxiliary definition is missing');
  const catalog = createDispatchCatalog(deps, ctx, contracts, record, (created) => {
    taskRunId = created.taskRunId;
    dispatchedTaskId = created.taskId;
    dispatchedProject = created.project;
    dispatchedWorktree = created.worktree;
    dispatchedInput = created.effectiveInput;
    if (created.title !== '') ctx.onTitle?.(created.title);
  });
  const loopDeps = {
    host: bindCatalog(catalog, 'dispatch'),
    calls: deps.calls,
    helpers: record.helpers,
  };
  const tools = await protocolTools(
    loopDeps.host,
    record.helpers,
    ctx,
    record,
    definition.methods,
    definition.effects,
  );
  const loopResult = await runAuxiliaryLoop({
    deps: loopDeps,
    ctx,
    role: 'dispatch',
    system: definition.buildSystemPrompt({ documentRules: () => '' }),
    user: buildDispatchUser(ctx, action.intent, referenceEvents, dispatchView),
    tools,
    maxRounds: definition.maxRounds,
    spanIdPrefix: definition.spanIdPrefix,
    record,
  });
  const loopOutcome = toActionOutcome(loopResult, record);
  if (loopOutcome.status !== 'done' || taskRunId === undefined || dispatchedProject === undefined) {
    return notDispatched(loopOutcome.result);
  }
  const project = dispatchedProject;
  const taskId = dispatchedTaskId;

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
      ...(dispatchedWorktree === undefined ? {} : { worktree: dispatchedWorktree }),
      taskRunId,
      ...(dispatchedInput === undefined ? {} : { input: dispatchedInput }),
    },
  });

  await ctx.onTaskRun(taskRunId);
  if (ctx.signal.aborted) {
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

  const aborted = ctx.signal.aborted;
  const status: ActionStatus = waited === undefined
    ? (aborted ? 'cancelled' : 'failed')
    : mapTaskStatus(waited.status, aborted);
  const taskStatus = waited?.status ?? (aborted ? 'cancelled' : 'failed');
  const deferred: LedgerEventDraft[] = [];
  let result = waited === undefined ? `waitTaskRun failed: ${messageOf(waitError)}` : renderTaskRunResult(waited.output, waited.facts);

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
  if (action.type === 'dispatch' && status !== 'done') {
    const left = await deps.fileStore.listRunFiles(taskRunId);
    if (left.length > 0) result = `${result}\n${renderRunFiles(left)}`;
  }
  if (waited?.artifactErrors !== undefined) result = appendDiagnostics(result, waited.artifactErrors);

  return { status, result, taskRunId, taskStatus, task: taskId, deferred };
}

// ─── Task context builder ───────────────────────────────────────────────────

type TaskDocument = { path: string; version: string; content: string };

const CONVERSATION_RESULT_PREVIEW = 200;

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

function isProjectInstructionPath(path: string, workspaceDir: string): boolean {
  return path === 'AGENTS.md' || path.startsWith(`${workspaceDir}/`);
}

function collectMemories(events: readonly LedgerEvent[]): { path: string; content: string }[] {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'memory.recalled') latest.set(event.path, event.content);
  }
  return [...latest.entries()].map(([path, content]) => ({ path, content }));
}

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

function renderActionResultStart(event: ActionFinishedEvent): string {
  return tag('action-result', [['id', event.id], ['status', event.status]], escapeBody(resultPreview(event.result)));
}

function resultPreview(result: string): string {
  const firstLine = result.split('\n', 1)[0] ?? '';
  return firstLine.length > CONVERSATION_RESULT_PREVIEW
    ? `${firstLine.slice(0, CONVERSATION_RESULT_PREVIEW)}…`
    : firstLine;
}

type Waited = Awaited<ReturnType<ActionWorkflowDeps['host']['waitTaskRun']>>;
type TaskContract = Awaited<ReturnType<ActionWorkflowDeps['host']['describeTask']>>;

type CompileContract = ActionTaskInfo & {
  inputSchema: unknown;
  requiredCapabilities: readonly string[];
  requiredTools: readonly string[];
};

const TOOL_ID_ALIASES: Readonly<Record<string, string>> = {
  'browser-use': 'browser',
  computer: 'desktop',
  'computer-use': 'desktop',
};

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

type WriteConflict = NonNullable<Awaited<ReturnType<ActionWorkflowDeps['host']['findTaskWriteConflict']>>>;

function renderConflictTiming(conflict: WriteConflict): string {
  const items: string[] = [];
  const startedMs = conflict.startedAt === undefined ? NaN : Date.parse(conflict.startedAt);
  if (Number.isFinite(startedMs)) items.push(`running ${minutesAgo(startedMs)}`);
  const activityMs = conflict.lastActivityAt === undefined ? NaN : Date.parse(conflict.lastActivityAt);
  if (Number.isFinite(activityMs)) items.push(`last activity ${minutesAgo(activityMs)} ago`);
  const limitMs = conflict.timeLimitEndsAt === undefined ? NaN : Date.parse(conflict.timeLimitEndsAt);
  if (Number.isFinite(limitMs)) items.push(`time limit ends ${localTime(limitMs)}`);
  return items.length === 0 ? '' : ` (${items.join(', ')})`;
}

function minutesAgo(thenMs: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - thenMs) / 60_000));
  return `${minutes} min`;
}

function localTime(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
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

function appendDiagnostics(output: string, notes: readonly string[]): string {
  if (notes.length === 0) return output;
  const section = ['artifacts dropped or unavailable:', ...notes.map((note) => `- ${note}`)].join('\n');
  return output === '' ? section : `${output}\n${section}`;
}

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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
