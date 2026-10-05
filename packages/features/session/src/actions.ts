/**
 * session action layer (current-only).
 *
 * Owns:
 *   - conversion of native driver tool calls into typed actions
 *     (`actionFromToolCall`)
 *   - the AJV-backed draft-07 task input validator and the 256KB `ctx`
 *     normalizer
 *   - execution of the typed actions, returning context events as deferred
 *     drafts so the engine keeps append ordering
 *
 * The reasoning model declares one native tool; the API returns parsed calls.
 * There is no hand-written text parsing layer.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

import { renderTaskResult } from './result-text.ts';
import { collectSessionFiles, type LedgerEvent, type LedgerEventDraft, type TaskBrief, type WorkspaceSnapshot } from './ledger.ts';
import { contentVersion, makeDocumentDraft } from './documents.ts';
import type { ToolCall } from './driver.ts';
import type { CallsPort, FilesPort, ProjectInfo, SessionHost } from './ports.ts';
import type { FileStore, SessionFile } from './media.ts';
import type { DocCatalogEntry } from './workspace.ts';
import {
  renderEventsBlock,
  type BuiltView,
  type ViewsPort,
} from './views.ts';

// ─── Typed action model ────────────────────────────────────────────────────

export type ActionKind = 'read' | 'dispatch' | 'write';
export type ActionStatus = 'done' | 'failed' | 'skipped' | 'cancelled';

/** One typed action: its kind plus the natural-language intent body. */
export interface ParsedAction {
  kind: ActionKind;
  intent: string;
}

/**
 * Convert one native driver tool call into a typed action. An `ask` call is
 * returned separately because it never executes an action; a call carrying a
 * driver-provided error or an unknown type is rejected.
 */
export function actionFromToolCall(
  call: ToolCall,
): { ok: true; action: ParsedAction } | { ok: true; ask: string } | { ok: false; reason: string } {
  if (call.error !== undefined) return { ok: false, reason: call.error };
  if (call.type === 'ask') return { ok: true, ask: call.intent };
  if (call.type === 'read' || call.type === 'dispatch' || call.type === 'write') {
    return { ok: true, action: { kind: call.type, intent: call.intent } };
  }
  return { ok: false, reason: `unknown action type: ${call.type}` };
}

/** Result of executing one action. */
export interface ActionExecutionOutcome {
  taskRunId?: string;
  status: ActionStatus;
  result: string;
  taskStatus?: string;
  task?: string;
  /** Drafts whose append is deferred until after the cycle's reasoning event. */
  deferred: LedgerEventDraft[];
}

// ─── JSON schema validation (AJV, draft-07) ────────────────────────────────

export type SchemaValidation = { ok: true } | { ok: false; errors: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

// ─── Task context normalizer (256KB task-system limit) ─────────────────────

export const TASK_CONTEXT_MAX_BYTES = 262144;
const TASK_CONTEXT_MAX_KEYS = 64;
const TASK_CONTEXT_MAX_KEY_LENGTH = 128;
const TASK_CONTEXT_MAX_DEPTH = 8;
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

function assertContextValue(value: unknown, path: string, depth: number, ancestors: Set<object>): void {
  if (depth > TASK_CONTEXT_MAX_DEPTH) {
    throw new TaskContextError(`${path} exceeds the maximum nesting depth of ${TASK_CONTEXT_MAX_DEPTH}`);
  }
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
    value.forEach((item, index) => assertContextValue(item, `${path}[${index}]`, depth + 1, ancestors));
  } else {
    if (!isPlainObject(value)) {
      throw new TaskContextError(`${path} must contain only plain JSON objects`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.length < 1 || key.length > TASK_CONTEXT_MAX_KEY_LENGTH) {
        throw new TaskContextError(`${path} keys must contain 1-${TASK_CONTEXT_MAX_KEY_LENGTH} characters`);
      }
      if (FORBIDDEN_KEYS.has(key) || /[\u0000-\u001f\u007f]/u.test(key)) {
        throw new TaskContextError(`${path} contains an unsafe key '${key}'`);
      }
      assertContextValue(child, `${path}.${key}`, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}

/**
 * Validate and detach a bounded JSON-safe task context. The serialized-size
 * limit matches the task system's own `TASK_CONTEXT_MAX_BYTES` authority.
 */
export function normalizeTaskContext(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TaskContextError('ctx must be a JSON object');
  const keys = Object.keys(value);
  if (keys.length > TASK_CONTEXT_MAX_KEYS) {
    throw new TaskContextError(`ctx must contain at most ${TASK_CONTEXT_MAX_KEYS} top-level keys`);
  }
  assertContextValue(value, 'ctx', 1, new Set<object>());
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > TASK_CONTEXT_MAX_BYTES) {
    throw new TaskContextError(`ctx exceeds the ${TASK_CONTEXT_MAX_BYTES}-byte serialized limit`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

// ─── Ports ──────────────────────────────────────────────────────────────────

export type ActionProjectInfo = Pick<ProjectInfo, 'id' | 'displayName' | 'workspaceDir' | 'checkoutPath'>;

export type ActionTaskInfo = Pick<TaskBrief, 'id' | 'description' | 'inputSummary'> & { project?: string };

export interface ActionRunnerDeps {
  host: Pick<SessionHost, 'describeTask' | 'createTaskRun' | 'waitTaskRun' | 'cancelTaskRun'>;
  files: Pick<FilesPort, 'checkPath' | 'exists' | 'read' | 'instructionChain' | 'listDocuments' | 'readDocumentRules'>;
  views: Pick<ViewsPort, 'compile' | 'docSearch'>;
  calls: Pick<CallsPort, 'run'>;
  fileStore: FileStore;
  now(): Date;
}

/** The host's wait result, derived from the authoritative `SessionHost` type. */
type Waited = Awaited<ReturnType<ActionRunnerDeps['host']['waitTaskRun']>>;

/** The host's task contract, derived from the authoritative `SessionHost` type. */
type TaskContract = Awaited<ReturnType<ActionRunnerDeps['host']['describeTask']>>;

/**
 * Everything one action needs. The engine supplies a fresh `currentEvents`
 * read per call, so an action always sees the timeline as of now.
 */
export interface ActionRunContext {
  sessionId: string;
  turn: number;
  cycle: number;
  actionId: string;
  userText: string;
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
  currentEvents(): LedgerEvent[];
  projects: ActionProjectInfo[];
  tasks: ActionTaskInfo[];
  signal: AbortSignal;
  onTaskRun(taskRunId: string): Promise<void>;
  onTitle?(title: string): void;
  onDispatched?(): void;
}

// ─── Action runner ──────────────────────────────────────────────────────────

/**
 * Executes the three typed actions. The runner never appends ledger events
 * itself: every path that produces context events returns deferred drafts.
 */
export class ActionRunner {
  private readonly deps: ActionRunnerDeps;
  private callSeq = 0;

  constructor(deps: ActionRunnerDeps) {
    this.deps = deps;
  }

  async execute(action: ParsedAction, ctx: ActionRunContext): Promise<ActionExecutionOutcome> {
    switch (action.kind) {
      case 'read':
        return this.executeRead(action, ctx);
      case 'write':
      case 'dispatch':
        return this.executeCompile(action, ctx);
    }
  }

  // ── read ────────────────────────────────────────────────────────────────

  private async executeRead(action: ParsedAction, ctx: ActionRunContext): Promise<ActionExecutionOutcome> {
    const events = ctx.currentEvents();
    const catalog = this.deps.files.listDocuments();
    const sessionFiles = collectSessionFiles(events);
    const loadedDocs = new Set<string>();
    for (const event of events) if (event.type === 'doc.content') loadedDocs.add(event.path);

    const deferred: LedgerEventDraft[] = [];
    const loaded: string[] = [];
    const already: string[] = [];
    const missing: string[] = [];
    const unsupported: string[] = [];
    const notes: string[] = [];
    const claimed = new Set<string>();

    const runIds = sessionRunIds(events);
    let listed = false;
    let loose = false;
    const tokens = extractPathTokens(action.intent);
    const exact: { path: string; kind: 'file' | 'doc'; taskRunId?: string }[] = [];
    for (const token of tokens) {
      const hit = this.classifyPath(token, catalog, sessionFiles, runIds, ctx);
      if (hit === undefined) {
        // An existing path that is not a document is reported, not searched for.
        const absolute = resolve(ctx.workspaceRoot, token);
        const run = this.deps.fileStore.runOf(absolute, runIds);
        if (run !== undefined && statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true) {
          notes.push(renderRunFiles(await this.deps.fileStore.listRunFiles(run)));
          listed = true;
        } else if (existsSync(absolute)) unsupported.push(absolute);
        // Only a Markdown or absolute path is a path the model meant to read;
        // any other slash-separated word is ordinary intent text.
        else if (token.endsWith('.md') || token.startsWith('/')) missing.push(token);
        else loose = true;
        continue;
      }
      if (!exact.some((item) => item.path === hit.path)) exact.push(hit);
    }

    const residual = residualText(action.intent, tokens);
    // A written path that resolves is read directly; the words around it are a
    // label, not a search request.
    const needSearch = (exact.length === 0 && unsupported.length === 0 && !listed) || missing.length > 0 || loose;
    if (!needSearch && residual !== '') notes.push('只读取了写明的路径；需要其他文档时，另写一个不含路径的 read');

    let picks: { path: string; reason: string }[] = [];
    if (needSearch) {
      const view = this.deps.views.docSearch({ catalog, loadedPaths: [...loadedDocs], intent: action.intent });
      const outcome = await this.runView('doc-search', view, ctx);
      if (!outcome.ok) return this.fail(`doc-search call failed: ${outcome.error}`);
      const parsed = parseDocSearch(outcome.text, catalog);
      if (!parsed.ok) return this.fail(parsed.reason);
      notes.push(...parsed.notes);
      picks = parsed.picks.filter((pick) => !loadedDocs.has(pick.path));
      const nearTitles = parsed.near.map((near) => `${near.path} (${near.title})`);
      if (nearTitles.length > 0) notes.push(`near: ${nearTitles.join(', ')}`);
      // First doc-search draft, before any picked document content.
      deferred.push({
        type: 'doc.search',
        turn: ctx.turn,
        cycle: ctx.cycle,
        actionId: ctx.actionId,
        understanding: parsed.understanding,
        picks: parsed.picks.map((pick) => ({
          path: pick.path,
          title: catalog.find((entry) => entry.path === pick.path)?.title ?? pick.path,
          reason: pick.reason,
        })),
        near: parsed.near.map((near) => ({ path: near.path, title: near.title, reason: near.reason })),
        notes: parsed.notes,
      });
    }

    for (const pick of picks) {
      if (!exact.some((item) => item.path === pick.path)) exact.push({ path: pick.path, kind: 'doc' });
    }

    for (const item of exact) {
      if (ctx.signal.aborted) break;
      if (claimed.has(item.path)) continue;
      claimed.add(item.path);
      if (item.kind === 'file') {
        await this.readSessionFile(item.path, item.taskRunId, events, ctx, deferred, loaded, already, missing);
        continue;
      }
      const file = this.deps.files.read(item.path);
      if (!file) {
        missing.push(item.path);
        continue;
      }
      await this.recallProjectInstructions(item.path, ctx, events, deferred);
      const draft = makeDocumentDraft(file, events, {
        turn: ctx.turn,
        cycle: ctx.cycle,
        actionId: ctx.actionId,
        source: 'read',
      });
      if (draft === undefined) already.push(item.path);
      else {
        deferred.push(draft);
        loaded.push(item.path);
      }
    }

    const failed = loaded.length === 0 && already.length === 0 && unsupported.length === 0 && !listed;
    const sections: string[] = [];
    if (loaded.length > 0) sections.push(`loaded: ${loaded.join(', ')}`);
    if (already.length > 0) sections.push(`已在上下文中，未变化: ${already.join(', ')}`);
    if (unsupported.length > 0) sections.push(`存在，但不是文档或本会话的文件，没有读入: ${unsupported.join(', ')}`);
    if (missing.length > 0) sections.push(`missing: ${missing.join(', ')}`);
    if (notes.length > 0) sections.push(...notes);
    if (sections.length === 0) sections.push('no paths were processed');
    return { status: failed ? 'failed' : 'done', result: sections.join('\n'), deferred };
  }

  private async readSessionFile(
    path: string,
    runId: string | undefined,
    events: readonly LedgerEvent[],
    ctx: ActionRunContext,
    deferred: LedgerEventDraft[],
    loaded: string[],
    already: string[],
    missing: string[],
  ): Promise<void> {
    const latest = latestSessionFile(events, path);
    let prepared;
    try {
      prepared = await this.deps.fileStore.prepareFile(path, {
        source: latest?.source ?? 'task',
        actionId: ctx.actionId,
        ...((latest?.taskRunId ?? runId) === undefined ? {} : { taskRunId: (latest?.taskRunId ?? runId)! }),
        ...(latest?.role === undefined ? {} : { role: latest.role }),
        ...(latest?.description === undefined || latest.description === '' ? {} : { description: latest.description }),
      });
    } catch {
      missing.push(path);
      return;
    }
    // An unchanged file, image or document is already in the context.
    if (latest !== undefined && latest.hash === prepared.hash) {
      already.push(path);
      return;
    }
    deferred.push({
      type: 'files',
      turn: ctx.turn,
      cycle: ctx.cycle,
      source: 'read',
      files: [prepared],
      actionId: ctx.actionId,
    });
    loaded.push(path);
  }

  /** Resolve one intent token to an allowed, registered path. */
  /** A session file, a file one of this session's runs left, or a project document. */
  private classifyPath(
    raw: string,
    catalog: readonly DocCatalogEntry[],
    sessionFiles: readonly { path: string }[],
    runIds: ReadonlySet<string>,
    ctx: ActionRunContext,
  ): { path: string; kind: 'file' | 'doc'; taskRunId?: string } | undefined {
    if (sessionFiles.some((file) => file.path === raw)) return { path: raw, kind: 'file' };
    if (raw.startsWith('/')) {
      const run = this.deps.fileStore.runOf(raw, runIds);
      if (run !== undefined && statSync(raw, { throwIfNoEntry: false })?.isFile() === true) {
        return { path: raw, kind: 'file', taskRunId: run };
      }
    }
    const prefix = `${ctx.workspaceRoot.replace(/\/$/u, '')}/`;
    const relative = raw.startsWith('/') ? (raw.startsWith(prefix) ? raw.slice(prefix.length) : undefined) : raw;
    const doc = relative === undefined ? undefined : catalog.find((entry) => entry.path === relative);
    return doc ? { path: doc.path, kind: 'doc' } : undefined;
  }

  /** Queue the project instruction chain as full `doc.content` drafts. */
  private async recallProjectInstructions(
    docPath: string,
    ctx: ActionRunContext,
    events: readonly LedgerEvent[],
    deferred: LedgerEventDraft[],
    settledWrite = false,
  ): Promise<void> {
    const project = projectForDocPath(ctx.projects, docPath);
    if (!project) return;
    const directory = docPath.endsWith('/AGENTS.md') ? docPath.slice(0, -10) : project.workspaceDir;
    for (const instructionPath of this.deps.files.instructionChain(directory, docPath)) {
      if (ctx.signal.aborted && !settledWrite) return;
      const file = this.deps.files.read(instructionPath);
      if (!file) continue;
      const draft = makeDocumentDraft(file, events, {
        turn: ctx.turn,
        cycle: ctx.cycle,
        actionId: ctx.actionId,
        source: 'project-instructions',
      });
      if (draft !== undefined) deferred.push(draft);
    }
  }

  // ── compile: write / dispatch ───────────────────────────────────────────

  private async executeCompile(action: ParsedAction, ctx: ActionRunContext): Promise<ActionExecutionOutcome> {
    const contracts: CompileContract[] = [];
    for (const task of ctx.tasks) {
      let contract: TaskContract;
      try {
        contract = await this.deps.host.describeTask(task.id, task.project);
      } catch (error) {
        if (isObject(error) && error.code === 'task_not_found') continue;
        return this.fail(`describeTask failed: ${messageOf(error)}`);
      }
      contracts.push({
        ...task,
        inputSchema: contract.inputSchema,
        builtinDoc: contract.builtinDoc === true,
        requiredCapabilities: contract.requiredCapabilities ?? [],
      });
    }

    const view = this.deps.views.compile({
      kind: action.kind === 'write' ? 'write' : 'dispatch',
      intent: action.intent,
      userText: ctx.userText,
      events: ctx.currentEvents(),
      workspaceRoot: ctx.workspaceRoot,
      projects: ctx.projects.map((project) => ({
        id: project.id,
        displayName: project.displayName,
        workspaceDir: project.workspaceDir,
        ...(project.checkoutPath === undefined ? {} : { checkoutPath: project.checkoutPath }),
      })),
      tasks: contracts,
    });
    // A failed call or unusable output is a system fault, not a decision of
    // the reasoning model. The compiler is asked again with its own output and
    // the reason it was rejected, so each attempt corrects the previous one.
    let compiled: Extract<ReturnType<ActionRunner['checkCompiled']>, { ok: true }> | undefined;
    let compileError = '';
    let attemptView = view;
    for (let attempt = 1; attempt <= COMPILE_ATTEMPTS && compiled === undefined && !ctx.signal.aborted; attempt += 1) {
      const outcome = await this.runView('compile', attemptView, ctx);
      if (!outcome.ok) {
        compileError = `compile call failed: ${outcome.error}`;
        continue;
      }
      const checked = this.checkCompiled(outcome.text, action, ctx, contracts);
      if (checked.ok) {
        compiled = checked;
        break;
      }
      compileError = checked.error;
      attemptView = {
        ...attemptView,
        messages: [
          ...attemptView.messages,
          { role: 'assistant', content: outcome.text },
          { role: 'user', content: `上一次输出不能使用：${checked.error}\n只输出修正后的完整 JSON。` },
        ],
      };
    }
    if (compiled === undefined) return this.fail(compileError);
    const { parsed, project, taskId, effectiveInput, targetPath } = compiled;

    const rawTitle = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const title = rawTitle !== '' && rawTitle.length <= 40 ? rawTitle : '';
    if (title !== '') ctx.onTitle?.(title);

    let normalizedCtx: Record<string, unknown> | undefined;
    if (parsed.ctx !== undefined) {
      try {
        normalizedCtx = normalizeTaskContext(parsed.ctx);
      } catch (error) {
        return this.fail(messageOf(error));
      }
    }

    // Injected documents must be the original file text as it exists on disk
    // now, never the model's own rewrite. Only paths already present in the
    // timeline as loaded documents or recalled memories are eligible.
    const contextEvents = ctx.currentEvents();
    const eligibleContext = new Set<string>();
    for (const event of contextEvents) {
      if (event.type === 'doc.content' || event.type === 'memory.recalled') eligibleContext.add(event.path);
    }
    const contextDocs: { source: string; content: string }[] = [];
    if (Array.isArray(parsed.context)) {
      const seen = new Set<string>();
      for (const candidate of parsed.context) {
        if (typeof candidate !== 'string' || seen.has(candidate) || !eligibleContext.has(candidate)) continue;
        seen.add(candidate);
        const file = this.deps.files.read(candidate);
        if (file === undefined) continue;
        contextDocs.push({ source: candidate, content: file.content });
      }
    }
    let taskCtx: Record<string, unknown> | undefined = normalizedCtx;
    if (contextDocs.length > 0) {
      try {
        taskCtx = normalizeTaskContext({ ...(normalizedCtx ?? {}), context: contextDocs });
      } catch (error) {
        return this.fail(messageOf(error));
      }
    }

    const before = action.kind === 'write' && targetPath !== undefined
      ? this.deps.files.read(targetPath)
      : undefined;

    let taskRunId: string;
    try {
      const createParams: Parameters<ActionRunnerDeps['host']['createTaskRun']>[0] & { title?: string } = {
        task: taskId,
        project: project.id,
        input: effectiveInput,
        ...(taskCtx === undefined ? {} : { ctx: taskCtx }),
        ...(title === '' ? {} : { title }),
      };
      const run = await this.deps.host.createTaskRun(createParams);
      taskRunId = run.taskRunId;
    } catch (error) {
      return this.fail(`createTaskRun failed: ${messageOf(error)}`);
    }

    await ctx.onTaskRun(taskRunId);
    if (ctx.signal.aborted) {
      // Cancelled just after the run opened: cancel, then still wait below so
      // an in-flight document write settles and is recorded, not lost.
      await this.deps.host.cancelTaskRun(taskRunId).catch(() => undefined);
    } else {
      ctx.onDispatched?.();
    }

    let waited: Waited | undefined;
    let waitError: unknown;
    try {
      waited = await this.deps.host.waitTaskRun(taskRunId, ctx.signal);
    } catch (error) {
      waitError = error;
    }

    // A thrown wait is failed or cancelled, never a false done.
    const aborted = ctx.signal.aborted;
    const status: ActionStatus = waited === undefined
      ? (aborted ? 'cancelled' : 'failed')
      : mapTaskStatus(waited.status, aborted);
    const taskStatus = waited?.status ?? (status === 'failed' ? 'failed' : 'cancelled');
    const deferred: LedgerEventDraft[] = [];
    let result = waited === undefined ? `waitTaskRun failed: ${messageOf(waitError)}` : renderTaskResult(waited.output);

    // Disk is recorded after the wait fence for every outcome (done, failed,
    // cancelled, thrown), so a partial write is never dropped early.
    if (action.kind === 'write' && targetPath !== undefined) {
      const after = this.deps.files.read(targetPath);
      const changed = after !== undefined && (before === undefined || after.content !== before.content);
      if (changed) {
        // Project instructions enter the context before the document content,
        // so the first project document written also carries its chain.
        await this.recallProjectInstructions(targetPath, ctx, ctx.currentEvents(), deferred, true);
        const draft = makeDocumentDraft(
          { path: targetPath, title: after!.title, content: after!.content },
          ctx.currentEvents(),
          { turn: ctx.turn, cycle: ctx.cycle, actionId: ctx.actionId, source: 'write' },
        );
        // The disk change is factual even when the content is already on the
        // ledger and no new `doc.content` draft is produced.
        if (draft !== undefined) deferred.push(draft);
        deferred.push({
          type: 'ws.updated',
          turn: ctx.turn,
          cycle: ctx.cycle,
          path: targetPath,
          change: before === undefined ? 'created' : 'updated',
          actionId: ctx.actionId,
          taskRunId,
          taskStatus,
        });
      }
    } else if (action.kind === 'dispatch' && (waited?.artifacts?.length ?? 0) > 0) {
      const described = await this.deps.fileStore.describeArtifacts({
        sessionId: ctx.sessionId,
        taskRunId,
        actionId: ctx.actionId,
        artifacts: waited!.artifacts!,
      });
      if (described.files.length > 0) {
        deferred.push({
          type: 'files',
          turn: ctx.turn,
          cycle: ctx.cycle,
          source: 'task',
          files: described.files,
          taskRunId,
          actionId: ctx.actionId,
        });
      }
      result = appendDiagnostics(result, described.errors);
    }
    // An unfinished run reports what it left behind, so the work is not redone blind.
    if (action.kind === 'dispatch' && status !== 'done') {
      const left = await this.deps.fileStore.listRunFiles(taskRunId);
      if (left.length > 0) result = `${result}\n${renderRunFiles(left)}`;
    }
    // Invalid artifact descriptors dropped by the host are surfaced in text.
    if (waited?.artifactErrors !== undefined) result = appendDiagnostics(result, waited.artifactErrors);

    return { status, result, taskRunId, taskStatus, task: taskId, deferred };
  }

  /** Parse one compile output and validate it up to the task's input schema. */
  private checkCompiled(
    text: string,
    action: ParsedAction,
    ctx: ActionRunContext,
    contracts: readonly CompileContract[],
  ): { ok: true; parsed: Record<string, unknown>; project: ProjectInfo; taskId: string; effectiveInput: unknown; targetPath: string | undefined }
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
    if (action.kind === 'write' && !contract.builtinDoc) {
      return bad(`write must target the trusted builtin doc task: ${taskId}`);
    }

    // Validate the model's own file values against disk before any program
    // text is bound: the injected conversation/templateRules may legitimately
    // begin with '/', so they are never treated as missing paths.
    const missingPath = findMissingAbsolutePath(parsed.input);
    if (missingPath !== undefined) return bad(`input references a missing path: ${missingPath}`);

    // Bind the authoritative document fields first, then validate the bound
    // object once. A dispatch validates its raw input strictly.
    let effectiveInput: unknown = parsed.input;
    let targetPath: string | undefined;
    if (action.kind === 'write') {
      const base = isObject(parsed.input) ? parsed.input : {};
      const bound: Record<string, unknown> = {
        ...base,
        targetProject: project.id,
        conversation: renderEventsBlock(ctx.currentEvents()),
        templateRules: this.deps.files.readDocumentRules(),
      };
      if (typeof bound.targetPath === 'string') targetPath = bound.targetPath;
      if (targetPath !== undefined && !targetPath.startsWith(`${project.workspaceDir}/docs/`)) {
        return bad(`doc target must live under ${project.workspaceDir}/docs/: ${targetPath}`);
      }
      effectiveInput = bound;
    }
    const validation = validateJsonSchema(contract.inputSchema, effectiveInput);
    if (!validation.ok) {
      return bad(`input does not satisfy the task schema: ${validation.errors.join('; ')}`);
    }
    return { ok: true, parsed, project, taskId, effectiveInput, targetPath };
  }

  // ── shared helpers ──────────────────────────────────────────────────────

  private async runView(
    role: 'compile' | 'doc-search',
    view: BuiltView,
    ctx: ActionRunContext,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const callId = `c${ctx.turn}.${ctx.cycle}.x${++this.callSeq}`;
    try {
      const result = await this.deps.calls.run({
        callId,
        role,
        turn: ctx.turn,
        cycle: ctx.cycle,
        messages: view.messages,
        layers: view.layers,
        signal: ctx.signal,
      });
      return { ok: true, text: result.text };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  private fail(reason: string): ActionExecutionOutcome {
    return { status: 'failed', result: reason, deferred: [] };
  }
}

// ─── Doc-search output parsing ──────────────────────────────────────────────

interface ParsedDocSearch {
  understanding: string;
  picks: { path: string; reason: string }[];
  near: { path: string; title: string; reason: string }[];
  notes: string[];
}

function parseDocSearch(
  text: string,
  catalog: readonly DocCatalogEntry[],
): ({ ok: true } & ParsedDocSearch) | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (error) {
    return { ok: false, reason: `doc-search output is not valid JSON: ${messageOf(error)}` };
  }
  if (!isObject(value)) return { ok: false, reason: 'doc-search output must be a JSON object' };
  if (typeof value.understanding !== 'string') {
    return { ok: false, reason: 'doc-search output is missing understanding' };
  }
  if (!Array.isArray(value.picks) || !Array.isArray(value.near)) {
    return { ok: false, reason: 'doc-search output must contain picks and near arrays' };
  }
  const notes: string[] = [];
  const known = new Map(catalog.map((entry) => [entry.path, entry]));
  const picks: { path: string; reason: string }[] = [];
  for (const raw of value.picks) {
    if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.reason !== 'string') {
      return { ok: false, reason: 'doc-search pick has an invalid shape' };
    }
    const entry = known.get(raw.path);
    if (!entry) {
      notes.push(`discarded unknown catalog path: ${raw.path}`);
      continue;
    }
    picks.push({ path: entry.path, reason: raw.reason });
    if (picks.length >= 3) break;
  }
  const near: { path: string; title: string; reason: string }[] = [];
  for (const raw of value.near) {
    if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.reason !== 'string') {
      return { ok: false, reason: 'doc-search near entry has an invalid shape' };
    }
    const entry = known.get(raw.path);
    if (!entry) {
      notes.push(`discarded unknown catalog path: ${raw.path}`);
      continue;
    }
    near.push({ path: entry.path, title: entry.title, reason: raw.reason });
    if (near.length >= 5) break;
  }
  return { ok: true, understanding: value.understanding, picks, near, notes };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Path-like tokens in an intent, used for exact-path resolution. */
/** Task runs this session started or received files from. */
function sessionRunIds(events: readonly LedgerEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if ((event.type === 'action.started' || event.type === 'files') && event.taskRunId !== undefined) ids.add(event.taskRunId);
  }
  return ids;
}

function renderRunFiles(files: readonly { path: string; bytes: number }[]): string {
  if (files.length === 0) return '任务目录里没有文件';
  return ['任务目录里的文件:', ...files.map((file) => `- ${file.path} (${file.bytes} 字节)`)].join('\n');
}

function extractPathTokens(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_./-]+\.md|[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+/gu) ?? [];
  const tokens = matches.map((token) => token.replace(/[),.;:!?]+$/u, '')).filter((token) => token !== '');
  return [...new Set(tokens)];
}

/** The intent text left once the path tokens, quotes and punctuation are removed. */
function residualText(text: string, tokens: readonly string[]): string {
  let rest = text;
  for (const token of tokens) rest = rest.split(token).join(' ');
  return rest.replace(/["'`>{}[\]]/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Latest `files` event row for one path, if the path is ledger-registered. */
function latestSessionFile(events: readonly LedgerEvent[], path: string): SessionFile | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'files') continue;
    const file = event.files.find((candidate) => candidate.path === path);
    if (file) return file;
  }
  return undefined;
}

/** The most specific registered project that owns `docPath`, if any. */
function projectForDocPath(projects: readonly ActionProjectInfo[], docPath: string): ActionProjectInfo | undefined {
  const matches = projects.filter((project) => docPath.startsWith(`${project.workspaceDir}/`)
    || (docPath.endsWith('/AGENTS.md') && project.workspaceDir.startsWith(`${docPath.slice(0, -10)}/`)));
  if (matches.length === 0) return undefined;
  return matches.reduce((longest, candidate) =>
    candidate.workspaceDir.length > longest.workspaceDir.length ? candidate : longest);
}

const COMPILE_ATTEMPTS = 3;

type CompileContract = ActionTaskInfo & { inputSchema: unknown; builtinDoc: boolean; requiredCapabilities: readonly string[] };

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
