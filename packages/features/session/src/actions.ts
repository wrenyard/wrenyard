/**
 * session action layer.
 *
 * Owns:
 *   - the streaming `<wy-action>` splitter (fence / inline-code aware)
 *   - the action JSON schema, plus an AJV-backed draft-07 validator used to
 *     check the interpreter output and task input schemas
 *   - the interpretation of a block into zero or more actions (with one repair)
 *   - execution of the three supported actions and the two rejected forms
 *   - the task-system 16KB `ctx` normalizer
 *   - the `<wy-doc>` write-doc output parser and target-path validation
 *
 * The runner never appends ledger events itself: results that must land after
 * the cycle's `reason.completed` are returned as deferred drafts, and the engine
 * owns append ordering.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

import type { LedgerEventDraft, WorkspaceSnapshot } from './ledger.ts';
import type {
  ActionBaseContext,
  ActionRunContext,
  BuiltView,
  CallsPort,
  FilesPort,
  SessionHost,
  ViewsPort,
} from './engine.ts';

// ─── Action model ─────────────────────────────────────────────────────────

export type DocType = 'spec' | 'plan' | 'report' | 'handoff';

/** Plural directory under `docs/` for each document type. */
export const DOC_TYPE_DIRS: Record<DocType, string> = {
  spec: 'specs',
  plan: 'plans',
  report: 'reports',
  handoff: 'handoff',
};

export type ParsedAction =
  | { kind: 'dispatch'; project?: string; task: string; goal: string; acceptance: string }
  | { kind: 'read'; paths: string[] }
  | { kind: 'write-doc'; project: string; docType: DocType; path?: string; outline: string }
  | { kind: 'unsupported'; reason: string };

/** The action discriminants plus the synthetic parse-failure kind. */
export type ActionKind = ParsedAction['kind'];

export type ActionStatus = 'done' | 'failed' | 'skipped' | 'cancelled';

/** Result of executing one action. */
export interface ActionExecutionOutcome {
  taskStatus?: string;
  status: ActionStatus;
  result: string;
  taskRunId?: string;
  /** Drafts whose append is deferred until after the cycle's `reason.completed`. */
  deferred: LedgerEventDraft[];
}

export type ActionParseResult =
  | { ok: true; actions: ParsedAction[] }
  | { ok: false; reason: string };

// ─── Streaming splitter ────────────────────────────────────────────────────

const OPEN_TAG = '<wy-action>';
const CLOSE_TAG = '</wy-action>';

export interface SplitActionBlock {
  /** Raw block body, exactly as written between the tags. */
  text: string;
  /** True when reasoning ended before a matching `</wy-action>` was seen. */
  unterminated: boolean;
}

function runLength(text: string, at: number, ch: string): number {
  let end = at;
  while (end < text.length && text[end] === ch) end += 1;
  return end - at;
}

/** Whether `text` from `pos` is a live (possibly incomplete) prefix of `token`. */
function isPartialPrefix(text: string, pos: number, token: string): boolean {
  const rest = text.length - pos;
  if (rest >= token.length) return false;
  return token.startsWith(text.slice(pos));
}

/**
 * Incremental `<wy-action>` splitter.
 *
 * Tags are matched case-sensitively and without attributes. Fenced code blocks
 * and inline code spans are skipped both outside and inside an open block, so a
 * `</wy-action>` inside code never closes a block and a nested `<wy-action>` is
 * ordinary body text. Call {@link push} with each visible delta and
 * {@link finish} once the reasoning stream ends; a block still open at that
 * point is emitted with `unterminated: true`. Empty blocks are ignored.
 */
export class ActionSplitter {
  private text = '';
  private pos = 0;
  private atLineStart = true;
  private inBlock = false;
  private blockStart = 0;
  private inCode: 'none' | 'inline' | 'fence' = 'none';
  private inlineLen = 0;
  private fenceChar = '`';
  private fenceLen = 3;
  private fenceBodyStart = -1;
  private closed = false;

  push(delta: string): SplitActionBlock[] {
    if (this.closed || delta === '') return [];
    this.text += delta;
    return this.scan(false);
  }

  finish(): SplitActionBlock[] {
    if (this.closed) return [];
    const blocks = this.scan(true);
    if (this.inBlock) {
      const body = this.text.slice(this.blockStart);
      if (body.trim() !== '') blocks.push({ text: body, unterminated: true });
      this.inBlock = false;
    }
    this.closed = true;
    return blocks;
  }

  private scan(ending: boolean): SplitActionBlock[] {
    const blocks: SplitActionBlock[] = [];
    const text = this.text;
    const n = text.length;

    while (this.pos < n) {
      const ch = text[this.pos]!;

      if (this.inCode === 'fence') {
        if (this.fenceBodyStart < 0) {
          const newline = text.indexOf('\n', this.pos);
          if (newline === -1) return blocks;
          this.fenceBodyStart = newline + 1;
        }
        const close = this.findFenceClose(text, ending);
        if (close === -1) return blocks;
        this.pos = close;
        this.inCode = 'none';
        this.atLineStart = true;
        continue;
      }

      if (this.inCode === 'inline') {
        // Content inside a code span is skipped until a backtick run of the
        // exact opening length appears.
        const close = this.findInlineClose(text, this.pos, ending);
        if (close === -1) {
          if (!ending) return blocks;
          this.inCode = 'none';
          continue;
        }
        this.pos = close + this.inlineLen;
        this.inCode = 'none';
        this.atLineStart = false;
        continue;
      }

      if (this.atLineStart && (ch === '`' || ch === '~')) {
        const run = runLength(text, this.pos, ch);
        if (!ending && this.pos + run === n) return blocks;
        if (run >= 3) {
          this.fenceChar = ch;
          this.fenceLen = run;
          this.fenceBodyStart = -1;
          this.pos += run;
          this.inCode = 'fence';
          this.atLineStart = false;
          continue;
        }
        // A shorter run at the very end may still grow into a fence.
        if (!ending && this.pos + run >= n) return blocks;
      }

      if (ch === '`') {
        this.inlineLen = runLength(text, this.pos, '`');
        if (!ending && this.pos + this.inlineLen === n) return blocks;
        this.pos += this.inlineLen;
        this.inCode = 'inline';
        this.atLineStart = false;
        continue;
      }

      if (this.inBlock) {
        if (text.startsWith(CLOSE_TAG, this.pos)) {
          const body = text.slice(this.blockStart, this.pos);
          if (body.trim() !== '') blocks.push({ text: body, unterminated: false });
          this.pos += CLOSE_TAG.length;
          this.inBlock = false;
          this.atLineStart = false;
          continue;
        }
        if (!ending && isPartialPrefix(text, this.pos, CLOSE_TAG)) return blocks;
      } else {
        if (text.startsWith(OPEN_TAG, this.pos)) {
          this.pos += OPEN_TAG.length;
          this.blockStart = this.pos;
          this.inBlock = true;
          this.atLineStart = false;
          continue;
        }
        if (!ending && isPartialPrefix(text, this.pos, OPEN_TAG)) return blocks;
      }

      this.atLineStart = ch === '\n';
      this.pos += 1;
    }

    return blocks;
  }

  /** Index just past the closing fence line, or -1 when the fence never closes. */
  private findFenceClose(text: string, ending: boolean): number {
    let search = this.fenceBodyStart < 0 ? this.pos : this.fenceBodyStart;
    while (search < text.length) {
      if (text[search] === this.fenceChar && runLength(text, search, this.fenceChar) >= this.fenceLen) {
        const run = runLength(text, search, this.fenceChar);
        const newline = text.indexOf('\n', search + run);
        if (newline === -1 && !ending) return -1;
        const end = newline === -1 ? text.length : newline;
        if (/^[ \t\r]*$/u.test(text.slice(search + run, end))) return newline === -1 ? end : end + 1;
      }
      const nextNewline = text.indexOf('\n', search);
      if (nextNewline === -1) return -1;
      search = nextNewline + 1;
    }
    return -1;
  }

  /** Start of a backtick run that closes the current inline span, or -1. */
  private findInlineClose(text: string, from: number, ending: boolean): number {
    let search = from;
    while (search < text.length) {
      const found = text.indexOf('`', search);
      if (found === -1) return -1;
      const run = runLength(text, found, '`');
      if (!ending && found + run === text.length) return -1;
      if (run === this.inlineLen) return found;
      search = found + run;
    }
    return -1;
  }
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

// ─── Interpreter schema ────────────────────────────────────────────────────

const DISPATCH_SCHEMA = {
  type: 'object',
  required: ['kind', 'task', 'goal', 'acceptance'],
  additionalProperties: false,
  properties: {
    kind: { const: 'dispatch' },
    project: { type: 'string', minLength: 1 },
    task: { type: 'string', minLength: 1 },
    goal: { type: 'string' },
    acceptance: { type: 'string' },
  },
} as const;

const READ_SCHEMA = {
  type: 'object',
  required: ['kind', 'paths'],
  additionalProperties: false,
  properties: {
    kind: { const: 'read' },
    paths: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  },
} as const;

const WRITE_DOC_SCHEMA = {
  type: 'object',
  required: ['kind', 'project', 'docType', 'outline'],
  additionalProperties: false,
  properties: {
    kind: { const: 'write-doc' },
    project: { type: 'string', minLength: 1 },
    docType: { enum: ['spec', 'plan', 'report', 'handoff'] },
    path: { type: 'string', minLength: 1 },
    outline: { type: 'string' },
  },
} as const;

const UNSUPPORTED_SCHEMA = {
  type: 'object',
  required: ['kind', 'reason'],
  additionalProperties: false,
  properties: {
    kind: { const: 'unsupported' },
    reason: { type: 'string' },
  },
} as const;

/** Strict schema of the cheap interpreter's JSON output. */
export const ACTIONS_SCHEMA = {
  type: 'object',
  required: ['actions'],
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      items: {
        anyOf: [DISPATCH_SCHEMA, READ_SCHEMA, WRITE_DOC_SCHEMA, UNSUPPORTED_SCHEMA],
      },
    },
  },
} as const;

function parseActionsText(text: string): ActionParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, actions: [] };

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, reason: `output is not valid JSON: ${(error as Error).message}` };
  }

  const validation = validateJsonSchema(ACTIONS_SCHEMA, value);
  if (!validation.ok) {
    return { ok: false, reason: `output does not match the actions schema: ${validation.errors.join('; ')}` };
  }

  const actions = (value as { actions: ParsedAction[] }).actions;
  return { ok: true, actions };
}

// ─── Task context normalizer (16KB task-system limit) ──────────────────────

export const TASK_CONTEXT_MAX_BYTES = 16 * 1024;
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

// ─── Write-doc output parsing and path validation ──────────────────────────

const DOC_BLOCK = /<wy-doc\s+path="([^"]*)">([\s\S]*?)<\/wy-doc>/gu;
const DOC_FILENAME = /^\d{4}-\d{2}-\d{2}-.+\.md$/u;

export interface ParsedDocBlock {
  path: string;
  content: string;
}

/**
 * Extract the single `<wy-doc>` block required from a writer call output. The
 * document body is taken verbatim (bar one framing newline on each side); no
 * wrapping fence is stripped, so the written file is exactly what the writer
 * produced.
 */
export function parseDocBlock(text: string): ParsedDocBlock | undefined {
  const matches = [...text.matchAll(DOC_BLOCK)];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  if (text.trim() !== match[0]) return undefined;
  const path = match[1]!.trim();
  const content = match[2]!.replace(/^\n/u, '').replace(/\n$/u, '');
  return { path, content };
}

/** First `# ` heading in a Markdown document, falling back to the file name. */
export function docTitle(path: string, content: string): string {
  const heading = content.match(/^#\s+(.+?)\s*$/mu);
  if (heading) return heading[1]!.trim();
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name;
}

export interface DocPathCheck {
  ok: boolean;
  reason?: string;
}

/** Validate the writer's `<wy-doc path>` against the target project and doc type. */
export function validateDocTargetPath(
  path: string,
  projectWorkspaceDir: string,
  docType: DocType,
  updatePath: string | undefined,
  exists: (candidate: string) => boolean,
): DocPathCheck {
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) {
    return { ok: false, reason: `doc path must be a workspace-relative POSIX path: ${path}` };
  }
  if (path.split('/').includes('..')) {
    return { ok: false, reason: `doc path must not contain '..': ${path}` };
  }
  const directory = `${projectWorkspaceDir}/docs/${DOC_TYPE_DIRS[docType]}/`;
  if (!path.startsWith(directory)) {
    return { ok: false, reason: `doc path must live under ${directory}: ${path}` };
  }
  const name = path.slice(directory.length);
  if (name.includes('/')) {
    return { ok: false, reason: `doc path must be a direct child of ${directory}: ${path}` };
  }
  if (!DOC_FILENAME.test(name)) {
    return { ok: false, reason: `doc file name must match YYYY-MM-DD-<topic>.md: ${name}` };
  }
  if (updatePath !== undefined) {
    if (path !== updatePath) {
      return { ok: false, reason: `update must write to ${updatePath}: ${path}` };
    }
  } else if (exists(path)) {
    return { ok: false, reason: `refusing to create an existing document: ${path}` };
  }
  return { ok: true };
}

// ─── Action runner ─────────────────────────────────────────────────────────

export interface ActionRunnerDeps {
  host: SessionHost;
  files: FilesPort;
  views: ViewsPort;
  calls: CallsPort;
  now(): Date;
}

/**
 * Parses blocks into actions and executes them. Ledger append ordering stays in
 * the engine; every path that produces context events returns deferred drafts.
 */
export class ActionRunner {
  private readonly deps: ActionRunnerDeps;
  private callSeq = 0;

  constructor(deps: ActionRunnerDeps) {
    this.deps = deps;
  }

  /** Interpret one block, retrying exactly once with the failure attached. */
  async parse(block: SplitActionBlock, ctx: ActionBaseContext): Promise<ActionParseResult> {
    let failure = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = this.deps.views.interpret({
        blockText: block.text,
        unterminated: block.unterminated,
        cycleText: ctx.currentCycleText(),
        userText: ctx.userText,
        projects: ctx.projects,
        tasks: ctx.tasks,
        scopeRules: ctx.scopeRules,
        previousFailure: failure === '' ? undefined : failure,
      });
      const outcome = await this.runView('interpret', view, ctx);
      // Transport-level failures (network, timeout, abort) surface immediately;
      // only the cheap model's own output is retried once.
      if (!outcome.ok) return { ok: false, reason: outcome.error };
      const parsed = parseActionsText(outcome.text);
      if (parsed.ok) return parsed;
      failure = parsed.reason;
    }
    return { ok: false, reason: failure === '' ? 'action interpretation failed' : failure };
  }

  async execute(action: ParsedAction, ctx: ActionRunContext): Promise<ActionExecutionOutcome> {
    switch (action.kind) {
      case 'dispatch':
        return this.executeDispatch(action, ctx);
      case 'read':
        return this.executeRead(action, ctx);
      case 'write-doc':
        return this.executeWriteDoc(action, ctx);
      case 'unsupported':
        return { status: 'failed', result: action.reason, deferred: [] };
    }
  }

  // ── dispatch ────────────────────────────────────────────────────────────

  private async executeDispatch(
    action: Extract<ParsedAction, { kind: 'dispatch' }>,
    ctx: ActionRunContext,
  ): Promise<ActionExecutionOutcome> {
    const project = resolveProject(ctx.snapshot, action.project);
    if (action.project !== undefined && !project) {
      return { status: 'failed', result: `unknown project: ${action.project}`, deferred: [] };
    }
    // A builtin task is usable with any valid project; a project-scoped task
    // needs its owning project.
    const projectScoped = project?.tasks.some((task) => task.id === action.task) ?? false;
    const builtin = ctx.snapshot.builtinTasks.some((task) => task.id === action.task);
    if (!projectScoped && !builtin) {
      return {
        status: 'failed',
        result: `unknown task '${action.task}'${project ? ` for project ${project.id}` : ''}`,
        deferred: [],
      };
    }

    const projectId = project?.id;
    let contract: { description: string; inputSchema: unknown };
    try {
      contract = await this.deps.host.describeTask(action.task, projectId);
    } catch (error) {
      return { status: 'failed', result: `describeTask failed: ${messageOf(error)}`, deferred: [] };
    }

    const compiled = await this.compileDispatch(action, contract, ctx);
    if (!compiled.ok) {
      return { status: 'failed', result: compiled.reason, deferred: [] };
    }
    if (ctx.signal.aborted) {
      return { status: 'cancelled', result: 'cancelled before task creation', deferred: [] };
    }

    let taskRunId: string;
    try {
      const run = await this.deps.host.createTaskRun({
        task: action.task,
        ...(projectId === undefined ? {} : { project: projectId }),
        input: compiled.input,
        ctx: compiled.ctx,
      });
      taskRunId = run.taskRunId;
    } catch (error) {
      return { status: 'failed', result: `createTaskRun failed: ${messageOf(error)}`, deferred: [] };
    }

    // Register — and persist — the run id immediately, before waiting, so an
    // interrupt that races this dispatch still cancels the run.
    await ctx.onTaskRun(taskRunId);
    if (ctx.signal.aborted) {
      await this.deps.host.cancelTaskRun(taskRunId).catch(() => undefined);
      return { status: 'cancelled', result: 'cancelled after interrupt', taskRunId, deferred: [] };
    }

    try {
      const waited = await this.deps.host.waitTaskRun(taskRunId, ctx.signal);
      // The wait may resolve just as the turn is aborted; the terminal status
      // still wins so the record is a cancellation, not a completion.
      const status: ActionStatus = mapTaskStatus(waited.status, ctx.signal.aborted);
      return {
        status,
        taskStatus: waited.status,
        result: waited.output,
        taskRunId,
        deferred: [],
      };
    } catch (error) {
      return {
        status: ctx.signal.aborted ? 'cancelled' : 'failed',
        result: `waitTaskRun failed: ${messageOf(error)}`,
        taskRunId,
        deferred: [],
      };
    }
  }

  private async compileDispatch(
    action: Extract<ParsedAction, { kind: 'dispatch' }>,
    contract: { description: string; inputSchema: unknown },
    ctx: ActionRunContext,
  ): Promise<{ ok: true; input: unknown; ctx: Record<string, unknown> } | { ok: false; reason: string }> {
    let failure = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = this.deps.views.compile({
        task: { id: action.task, description: contract.description, inputSchema: contract.inputSchema },
        action,
        userText: ctx.userText,
        events: ctx.currentEvents(),
        providers: ctx.providers,
        previousFailure: failure === '' ? undefined : failure,
      });
      const outcome = await this.runView('compile', view, ctx);
      // Transport-level failures surface immediately; only the cheap model's
      // own JSON or schema mistakes are repaired once.
      if (!outcome.ok) return { ok: false, reason: outcome.error };

      let parsed: unknown;
      try {
        parsed = JSON.parse(outcome.text.trim());
      } catch (error) {
        failure = `compile output is not valid JSON: ${messageOf(error)}`;
        continue;
      }
      if (!isObject(parsed) || !('input' in parsed) || !('ctx' in parsed)) {
        failure = 'compile output must be a JSON object with input and ctx';
        continue;
      }

      const validation = validateJsonSchema(contract.inputSchema, parsed.input);
      if (!validation.ok) {
        failure = `input does not satisfy the task schema: ${validation.errors.join('; ')}`;
        continue;
      }

      let normalized: Record<string, unknown>;
      try {
        normalized = normalizeTaskContext(parsed.ctx ?? {});
      } catch (error) {
        failure = messageOf(error);
        continue;
      }

      return { ok: true, input: parsed.input, ctx: normalized };
    }
    return { ok: false, reason: failure === '' ? 'dispatch compilation failed' : failure };
  }

  // ── read ────────────────────────────────────────────────────────────────

  private async executeRead(
    action: Extract<ParsedAction, { kind: 'read' }>,
    ctx: ActionRunContext,
  ): Promise<ActionExecutionOutcome> {
    const loaded: string[] = [];
    const already: string[] = [];
    const rejected: string[] = [];
    const missing: string[] = [];
    const deferred: LedgerEventDraft[] = [];
    // Paths already queued by this action's own recall step, so a path is never
    // emitted twice within the same deferred batch.
    const seen = new Set<string>();

    for (const raw of action.paths) {
      if (ctx.signal.aborted) break;
      const check = this.deps.files.checkPath(raw);
      if (!check.ok) {
        rejected.push(`${raw} (${check.reason})`);
        continue;
      }
      if (ctx.recalls.has(raw) || seen.has(raw)) {
        already.push(raw);
        continue;
      }
      if (check.kind === 'doc') {
        // A project document — including a directly requested `AGENTS.md` —
        // triggers the full top-down instruction chain first.
        await this.recallProjectInstructions(raw, ctx, deferred, seen);
        if (seen.has(raw)) {
          loaded.push(raw);
          continue;
        }
        if (ctx.signal.aborted) break;
      }

      if (!this.deps.files.exists(raw)) {
        missing.push(raw);
        continue;
      }
      const file = this.deps.files.read(raw);
      // Read before claiming: a failed read must never consume the path.
      if (!file) {
        missing.push(raw);
        continue;
      }
      if (!ctx.recalls.claim(raw)) {
        already.push(raw);
        continue;
      }
      deferred.push(recallDraft(raw, check.kind, file, ctx));
      seen.add(raw);
      loaded.push(raw);
    }

    const failed = loaded.length === 0 && already.length === 0;
    const sections: string[] = [];
    if (loaded.length > 0) sections.push(`loaded: ${loaded.join(', ')}`);
    if (already.length > 0) sections.push(`already in context: ${already.join(', ')}`);
    if (rejected.length > 0) sections.push(`rejected: ${rejected.join(', ')}`);
    if (missing.length > 0) sections.push(`missing: ${missing.join(', ')}`);
    if (sections.length === 0) sections.push('no paths were processed');

    return {
      status: failed ? 'failed' : 'done',
      result: sections.join('\n'),
      deferred,
    };
  }

  // ── write-doc ───────────────────────────────────────────────────────────

  private async executeWriteDoc(
    action: Extract<ParsedAction, { kind: 'write-doc' }>,
    ctx: ActionRunContext,
  ): Promise<ActionExecutionOutcome> {
    const project = resolveProject(ctx.snapshot, action.project);
    if (!project) {
      return { status: 'failed', result: `unknown project: ${action.project}`, deferred: [] };
    }
    if (!(action.docType in DOC_TYPE_DIRS)) {
      return { status: 'failed', result: `unsupported docType: ${action.docType}`, deferred: [] };
    }

    const deferred: LedgerEventDraft[] = [];
    const seen = new Set<string>();
    const recallTarget = action.path ?? `${project.workspaceDir}/docs/${DOC_TYPE_DIRS[action.docType]}/pending.md`;
    await this.recallProjectInstructions(recallTarget, ctx, deferred, seen);
    if (ctx.signal.aborted) {
      return { status: 'cancelled', result: 'cancelled before writing the document', deferred };
    }

    let currentContent: string | undefined;
    if (action.path !== undefined) {
      const check = this.deps.files.checkPath(action.path);
      if (!check.ok) {
        return { status: 'failed', result: `cannot update ${action.path}: ${check.reason}`, deferred };
      }
      // The update target must belong to the requested project and docType
      // before the original is read.
      const target = validateDocTargetPath(action.path, project.workspaceDir, action.docType, action.path, () => false);
      if (!target.ok) {
        return { status: 'failed', result: target.reason ?? 'invalid doc target', deferred };
      }
      const existing = this.deps.files.read(action.path);
      if (!existing) {
        return { status: 'failed', result: `cannot update a missing document: ${action.path}`, deferred };
      }
      currentContent = existing.content;
    }

    const date = isoDate(this.deps.now());
    let failure = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = this.deps.views.writeDoc({
        globalAgents: ctx.snapshot.agents,
        snapshot: ctx.snapshot,
        events: ctx.currentEvents(),
        pendingRecalls: deferred.filter(isReadDraft),
        project: { id: project.id, workspaceDir: project.workspaceDir, displayName: project.displayName },
        docType: action.docType,
        date,
        currentContent,
        outline: failure === '' ? action.outline : `${action.outline}\n\n（上一次输出未被接受：${failure}）`,
      });
      const outcome = await this.runView('write', view, ctx);
      // A transport-level failure is never repaired.
      if (!outcome.ok) {
        return { status: 'failed', result: `write call failed: ${outcome.error}`, deferred };
      }
      if (ctx.signal.aborted) {
        // The disk write has not started, so the interrupted call is dropped.
        return { status: 'cancelled', result: 'cancelled before writing the document', deferred };
      }

      const block = parseDocBlock(outcome.text);
      if (!block) {
        failure = 'the output must contain exactly one <wy-doc path="…">…</wy-doc> block';
        continue;
      }
      const check = validateDocTargetPath(
        block.path,
        project.workspaceDir,
        action.docType,
        action.path,
        (candidate) => this.deps.files.exists(candidate),
      );
      if (!check.ok) {
        failure = check.reason ?? 'invalid doc target';
        continue;
      }

      const created = action.path === undefined;
      try {
        if (created) {
          await this.deps.host.createWorkspaceDoc(block.path, block.content);
        } else {
          await this.deps.host.updateWorkspaceDoc(block.path, block.content, currentContent ?? '');
        }
      } catch (error) {
        return {
          status: 'failed',
          result: `${created ? 'createWorkspaceDoc' : 'updateWorkspaceDoc'} failed: ${messageOf(error)}`,
          deferred,
        };
      }

      // The document is on disk; an interrupt that arrived meanwhile completes
      // normally and still reports the update.
      deferred.push({
        type: 'ws.updated',
        turn: ctx.turn,
        cycle: ctx.cycle,
        path: block.path,
        change: created ? 'created' : 'updated',
        actionId: ctx.actionId,
      });

      const title = docTitle(block.path, block.content);
      return {
        status: 'done',
        result: `${created ? 'created' : 'updated'} ${block.path}\ntitle: ${title}`,
        deferred,
      };
    }
    return { status: 'failed', result: `write output rejected: ${failure}`, deferred };
  }

  // ── shared helpers ──────────────────────────────────────────────────────

  /**
   * Queue the project instruction chain for a project document as deferred
   * `doc.read` drafts. Existing instructions that are not already committed on
   * the timeline (or queued by this batch) are queued outermost first; each
   * instruction file is queued at most once per batch.
   */
  private async recallProjectInstructions(
    docPath: string,
    ctx: ActionRunContext,
    deferred: LedgerEventDraft[],
    seen: Set<string>,
  ): Promise<void> {
    const project = projectForDocPath(ctx.snapshot, docPath);
    if (!project) return;
    const directory = docPath.endsWith('/AGENTS.md') ? docPath.slice(0, -10) : project.workspaceDir;
    const chain = this.deps.files.instructionChain(directory, docPath);
    for (const instructionPath of chain) {
      if (ctx.signal.aborted) return;
      if (ctx.recalls.has(instructionPath) || seen.has(instructionPath)) continue;
      // Read before claiming so a missing instruction never claims its path.
      const file = this.deps.files.read(instructionPath);
      if (!file) continue;
      if (!ctx.recalls.claim(instructionPath)) continue;
      deferred.push({
        type: 'doc.read',
        turn: ctx.turn,
        cycle: ctx.cycle,
        path: instructionPath,
        title: file.title,
        content: file.content,
        source: 'project-instructions',
        actionId: ctx.actionId,
      });
      seen.add(instructionPath);
    }
  }

  private async runView(
    role: 'interpret' | 'compile' | 'write',
    view: BuiltView,
    ctx: ActionBaseContext,
  ): Promise<{ ok: true; text: string; callId: string } | { ok: false; error: string }> {
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
      return { ok: true, text: result.text, callId };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }
}

function recallDraft(
  path: string,
  kind: 'memory' | 'doc',
  file: { path: string; title: string; content: string },
  ctx: ActionRunContext,
): LedgerEventDraft {
  if (kind === 'memory') {
    return {
      type: 'memory.recalled',
      turn: ctx.turn,
      cycle: ctx.cycle,
      path,
      content: file.content,
      source: 'action',
      actionId: ctx.actionId,
    };
  }
  return {
    type: 'doc.read',
    turn: ctx.turn,
    cycle: ctx.cycle,
    path,
    title: file.title,
    content: file.content,
    source: 'action',
    actionId: ctx.actionId,
  };
}

function isReadDraft(draft: LedgerEventDraft): boolean {
  const type = (draft as { type?: string }).type;
  return type === 'doc.read' || type === 'memory.recalled';
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

/** Resolve an action's project by its registered id, never by a display name. */
function resolveProject(snapshot: WorkspaceSnapshot, identifier: string | undefined) {
  if (identifier === undefined) return undefined;
  return snapshot.projects.find((project) => project.id === identifier);
}

/** The most specific registered project that owns `docPath`, if any. */
function projectForDocPath(snapshot: WorkspaceSnapshot, docPath: string) {
  const matches = snapshot.projects.filter((project) => docPath.startsWith(`${project.workspaceDir}/`)
    || (docPath.endsWith('/AGENTS.md') && project.workspaceDir.startsWith(`${docPath.slice(0, -10)}/`)));
  if (matches.length === 0) return undefined;
  return matches.reduce((longest, candidate) =>
    candidate.workspaceDir.length > longest.workspaceDir.length ? candidate : longest,
  );
}

function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
