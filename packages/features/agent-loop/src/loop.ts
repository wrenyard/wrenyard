/**
 * The shared multi-round tool loop used by every auxiliary task.
 *
 * An auxiliary task is a small tool-calling sub-conversation: a document
 * writer, a version-control operator or a project/worktree manager. Each session
 * runs the same loop here and only differs in its system prompt, its user
 * message and its tool set. The loop reuses the host's existing model call
 * runner ([`LoopDeps.calls`]), the same span-id scheme and the same
 * deferred-draft return shape the action layer already uses, so it never
 * introduces a second call path.
 *
 * The loop ends when the model calls the `done` tool; a call failure, two
 * silent rounds in a row or the round limit end it as a failure. Every tool
 * error is reported back to the model as a tool result and never aborts the
 * loop.
 */

import type {
  ActionExecutionOutcome,
  ActionRunContext,
  CallRunRequest,
  CallRunResult,
  CallsPort,
  LedgerEvent,
  LedgerEventDraft,
  LoopHelpers,
  Message as ModelMessage,
  MessageToolCall as ModelToolCall,
  MethodCatalogPort,
  MethodInfo,
  ToolCall,
  ToolSpec,
  Usage,
  WorkspaceChange,
} from './ports.ts';
import type { AuxiliaryRunRecordInput, TaskUsage } from '@wrenyard/protocol';

/** Which auxiliary task is running; used for ledger call attribution. */
export type LoopRole = 'document' | 'todo' | 'vcs' | 'project' | 'dispatch' | 'memory-search' | 'search';

/**
 * The one tool every auxiliary task declares to finish. `status` is `done`
 * when the work succeeded and `failed` when it could not be completed; `summary`
 * is the one-to-three-sentence report the caller turns into the action result.
 */
export const DONE_TOOL: ToolSpec = {
  name: 'done',
  description:
    'Finish this session. Call it once when the work is complete or when it cannot continue. Report the final status and a short summary.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['done', 'failed'],
        description: 'done when the work succeeded, failed when it could not be completed.',
      },
      summary: {
        type: 'string',
        description: 'One to three sentences describing what was done, or why it failed.',
      },
    },
    required: ['status', 'summary'],
    additionalProperties: false,
  },
};

/** One tool a auxiliary task exposes to the model. */
export interface LoopTool {
  spec: ToolSpec;
  /** Run the tool with parsed JSON arguments; return a compact JSON result. */
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/** The host seams one loop run needs. */
export interface LoopDeps {
  /** The protocol-method catalog, already bound to the running definition. */
  host: MethodCatalogPort;
  /** The model transport and its span bookkeeping. */
  calls: CallsPort;
  /** The host's text and tool-diagnostic helpers. */
  helpers: LoopHelpers;
  /**
   * Optional hook recording one finished auxiliary run into the unified run
   * record. Threaded from {@link AuxiliaryRunnerPorts}; falls back to the
   * shared `calls` port when supplied there instead.
   */
  recordAuxiliaryRun?: (input: AuxiliaryRunRecordInput) => void;
}

/** Everything one auxiliary loop run needs. */
export interface AuxiliaryLoopOptions {
  deps: LoopDeps;
  ctx: ActionRunContext;
  role: LoopRole;
  /** Stable system prompt of this session. */
  system: string;
  /** The user message, normally from {@link buildAuxiliaryUser}. */
  user: string;
  tools: readonly LoopTool[];
  maxRounds: number;
  /** Names this task's span within its action. */
  spanIdPrefix: string;
  /**
   * The run's effect record. When present, a `done` claim that recorded no
   * workspace change, no document draft and no authoritative observation is
   * returned as a failure: a helper cannot report successful completion
   * without a recorded effect.
   */
  record?: LoopRecord;
}

/** The terminal outcome of a auxiliary loop. */
export interface AuxiliaryLoopResult {
  status: 'done' | 'failed';
  summary: string;
  /** The route the last serving request actually used, when known. */
  route?: { provider?: string; model?: string; effort?: string };
  /** Tokens summed across every request this loop issued. */
  usage?: Usage;
  /** ISO timestamp the loop started. */
  startedAt: string;
  /** ISO timestamp the loop finished. */
  finishedAt: string;
}

/**
 * Run one auxiliary task loop. Each round makes exactly one model request
 * through the same runner the action layer uses, appends the assistant output
 * and one tool message per call, and repeats until the model calls `done`.
 */
export async function runAuxiliaryLoop(options: AuxiliaryLoopOptions): Promise<AuxiliaryLoopResult> {
  // The whole loop is one auxiliary task and therefore one span: every round's
  // request reports into it and it closes when the loop ends, however it ends.
  const spanId = `${options.ctx.actionId}.${options.spanIdPrefix}`;
  const startedAt = new Date().toISOString();
  options.deps.calls.holdSpan(spanId);
  try {
    return await runRounds(options, spanId, startedAt);
  } finally {
    await options.deps.calls.releaseSpan(spanId, options.ctx.signal.aborted ? 'aborted' : undefined);
  }
}

async function runRounds(options: AuxiliaryLoopOptions, spanId: string, startedAt: string): Promise<AuxiliaryLoopResult> {
  const { deps, ctx, role, system, user, tools, maxRounds } = options;
  const { messageOf } = deps.helpers;
  const toolMap = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const specs: ToolSpec[] = [...tools.map((tool) => tool.spec), DONE_TOOL];
  const layers = { 'wy-system': system.length, 'wy-ctx': user.length };
  const messages: ModelMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let silentRounds = 0;
  // Accumulate the run-level facts the unified record needs, across every round.
  let lastRoute: { provider?: string; model?: string; effort?: string } | undefined;
  let totalUsage: Usage = {};

  const finish = (status: 'done' | 'failed', summary: string): AuxiliaryLoopResult => {
    const finishedAt = new Date().toISOString();
    const recordInput = buildAuxiliaryRunRecordInput({
      options,
      status,
      summary,
      route: lastRoute,
      usage: totalUsage,
      startedAt,
      finishedAt,
    });
    const record = (input: AuxiliaryRunRecordInput): void => {
      if (options.deps.recordAuxiliaryRun !== undefined) options.deps.recordAuxiliaryRun(input);
      else if (options.deps.calls.recordAuxiliaryRun !== undefined) options.deps.calls.recordAuxiliaryRun(input);
    };
    record(recordInput);
    return { status, summary, route: lastRoute, usage: totalUsage, startedAt, finishedAt };
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    if (ctx.signal.aborted) return finish('failed', 'The session was interrupted.');

    let text: string;
    let calls: readonly ToolCall[];
    try {
      const result = await deps.calls.run({
        spanId,
        parent: ctx.actionId,
        role,
        turn: ctx.turn,
        step: ctx.step,
        messages: [...messages],
        layers,
        signal: ctx.signal,
        tools: specs,
      } satisfies CallRunRequest) as CallRunResult;
      text = result.text;
      calls = result.toolCalls ?? [];
      // The last serving route, preferred from the host-resolved `route` and
      // falling back to the raw model id when only that is known.
      if (result.route !== undefined) lastRoute = result.route;
      else if (result.model !== undefined && result.model !== '') lastRoute = { model: result.model };
      if (result.usage !== undefined) totalUsage = sumUsage(totalUsage, result.usage);
    } catch (error) {
      return finish('failed', `The model call failed: ${messageOf(error)}`);
    }
    if (ctx.signal.aborted) return finish('failed', 'The session was interrupted.');

    messages.push({
      role: 'assistant',
      content: text,
      ...(calls.length === 0 ? {} : {
        toolCalls: calls.map((call): ModelToolCall => ({ id: call.id, name: call.name, arguments: call.arguments })),
      }),
    });

    // A round with no tool call asks the model once more; twice in a row is a
    // model that will not use the tools, which ends the loop as a failure.
    if (calls.length === 0) {
      silentRounds += 1;
      if (silentRounds >= 2) return finish('failed', 'The model did not call a tool.');
      messages.push({ role: 'user', content: 'Call a tool or call done.' });
      continue;
    }
    silentRounds = 0;

    for (const call of calls) {
      if (ctx.signal.aborted) return finish('failed', 'The session was interrupted.');
      if (call.name === DONE_TOOL.name) {
        const done = readDoneCall(call, messageOf);
        if (!done.ok) {
          messages.push({ role: 'tool', toolCallId: call.id, content: errorResult('invalid_arguments', done.error) });
          continue;
        }
        // Close the false-success path: a `done` claim with no recorded
        // workspace change, no document draft and no recorded observation is a
        // failure with an explicit no-change explanation, never a successful
        // completion.
        if (done.status === 'done' && options.record !== undefined
          && options.record.changes.length === 0 && options.record.documents.length === 0
          && options.record.observations.length === 0) {
          return finish(
            'failed',
            'The helper reported done, but this run recorded no workspace change, no document draft and no authoritative result, so the claimed completion is not confirmed and the result is a failure.',
          );
        }
        return finish(done.status, done.summary);
      }
      const content = await runToolCall(toolMap.get(call.name), call, ctx.signal, options.record, messageOf);
      messages.push({ role: 'tool', toolCallId: call.id, content });
    }
  }

  return finish('failed', `The round limit of ${maxRounds} was reached.`);
}

/** Run one model tool call, converting every failure into a tool result. */
async function runToolCall(
  tool: LoopTool | undefined,
  call: ToolCall,
  signal: AbortSignal,
  record: LoopRecord | undefined,
  messageOf: (error: unknown) => string,
): Promise<string> {
  if (tool === undefined) return errorResult('unknown_tool', `Unknown tool: ${call.name}`);
  const args = parseArguments(call.arguments, messageOf);
  if (!args.ok) return errorResult('invalid_arguments', args.error);
  let content: string;
  try {
    content = await tool.run(args.value, signal);
  } catch (error) {
    return errorResult(errorCodeOf(error), messageOf(error));
  }
  record?.observeToolResult?.(content);
  return content;
}

/** Validate the `done` call's arguments; a malformed call stays a tool error. */
function readDoneCall(
  call: ToolCall,
  messageOf: (error: unknown) => string,
): { ok: true; status: 'done' | 'failed'; summary: string } | { ok: false; error: string } {
  const args = parseArguments(call.arguments, messageOf);
  if (!args.ok) return { ok: false, error: args.error };
  const status = args.value.status;
  const summary = args.value.summary;
  if (status !== 'done' && status !== 'failed') {
    return { ok: false, error: 'done requires status "done" or "failed".' };
  }
  if (typeof summary !== 'string') return { ok: false, error: 'done requires a summary string.' };
  return { ok: true, status, summary };
}

type ParsedArguments = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Parse one tool call's raw JSON argument text into a plain object. */
function parseArguments(raw: string, messageOf: (error: unknown) => string): ParsedArguments {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim() === '' ? '{}' : raw);
  } catch (error) {
    return { ok: false, error: `Arguments are not valid JSON: ${messageOf(error)}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Arguments must be a JSON object.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** The `code` a thrown tool error carries, or a generic fallback. */
export function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return 'tool_failed';
}

// ─── Tool results ───────────────────────────────────────────────────────────

/** Compact JSON tool result. */
export function jsonResult(value: unknown): string {
  return JSON.stringify(value);
}

/** A tool error result carrying the code the caller chose. */
export function errorResult(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

// ─── User message ───────────────────────────────────────────────────────────

/** Token reserve for wy-info, wy-intent and surrounding tags in the auxiliary user message. */
const AUXILIARY_USER_TAG_INFO_TOKEN_RESERVE = 1024;

function omittedConversationEventsMarker(droppedCount: number): string {
  return `(${droppedCount} older conversation events omitted for context limit)`;
}

/**
 * Keep the contiguous newest suffix of whole items whose summed {@link costOf}
 * fits within {@link budget}. Preserves item order within the suffix.
 */
export function keepNewestWithinBudget<T>(
  items: readonly T[],
  budget: number,
  costOf: (item: T) => number,
): { kept: readonly T[]; droppedCount: number } {
  if (items.length === 0 || budget <= 0) {
    return { kept: [], droppedCount: items.length };
  }
  const kept: T[] = [];
  let total = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const cost = costOf(items[index]!);
    if (total + cost > budget) break;
    total += cost;
    kept.unshift(items[index]!);
  }
  return { kept, droppedCount: items.length - kept.length };
}

function renderAuxiliaryEventsBlock(
  events: readonly LedgerEvent[],
  intent: string,
  helpers: LoopHelpers,
): string {
  const { estimateTokens, renderEvent, conversationTokenBudget } = helpers;
  if (
    estimateTokens === undefined
    || renderEvent === undefined
    || conversationTokenBudget === undefined
  ) {
    return helpers.renderEventsBlock(events);
  }
  const effectiveBudget = conversationTokenBudget
    - estimateTokens(intent)
    - AUXILIARY_USER_TAG_INFO_TOKEN_RESERVE;
  if (effectiveBudget <= 0) {
    const dropped = events.length;
    if (dropped === 0) return '<events>\n</events>';
    const marker = `${omittedConversationEventsMarker(dropped)}\n`;
    return `<events>\n${marker}</events>`;
  }
  const rendered = events
    .map((event) => ({ event, text: renderEvent(event) }))
    .filter((entry): entry is { event: LedgerEvent; text: string } => entry.text !== undefined);
  const { kept, droppedCount } = keepNewestWithinBudget(
    rendered,
    effectiveBudget,
    (entry) => estimateTokens(entry.text),
  );
  const lines = kept.map((entry) => entry.text);
  const marker = droppedCount > 0 ? `${omittedConversationEventsMarker(droppedCount)}\n` : '';
  const body = lines.length === 0 && marker === '' ? '' : `\n${marker}${lines.join('\n')}`;
  return `<events>${body}\n</events>`;
}

/**
 * Build the one user message of an auxiliary request: the whole conversation
 * under `<wy-ctx><wy-conversation>`, the call's facts (time, device and the
 * registered projects) under `<wy-info>`, and the intent under `<wy-intent>`.
 */
export function buildAuxiliaryUser(ctx: ActionRunContext, intent: string, helpers: LoopHelpers): string {
  const conversation = renderAuxiliaryEventsBlock(ctx.currentEvents(), intent, helpers);
  const projects = ctx.projects.length === 0
    ? '(none)'
    : ctx.projects.map((project) => {
      const checkout = project.checkoutPath === undefined ? '(none)' : project.checkoutPath;
      return `- id=${project.id} workspaceDir=${project.workspaceDir} checkout=${checkout}`;
    }).join('\n');
  const info = [
    `time: ${new Date().toISOString()}`,
    `device: ${ctx.snapshot.deviceName}`,
    'projects:',
    projects,
  ].join('\n');
  return [
    '<wy-ctx>',
    '<wy-conversation>',
    conversation,
    '</wy-conversation>',
    '</wy-ctx>',
    '<wy-info>',
    helpers.escapeBody(info),
    '</wy-info>',
    '<wy-intent>',
    helpers.escapeBody(intent),
    '</wy-intent>',
  ].join('\n');
}

// ─── Recorded side effects and the action outcome ───────────────────────────

/**
 * The side effects a auxiliary task performed, collected by its tools and
 * turned into an {@link ActionExecutionOutcome} once the loop returns.
 */
export interface LoopRecord {
  /** One human-readable line per recorded workspace change, in order. */
  changes: string[];
  /** Deferred `workspace.changed` drafts, in the order the changes happened. */
  updates: LedgerEventDraft[];
  /** Deferred `document.content` drafts, in the order the writes happened. */
  documents: LedgerEventDraft[];
  /** Authoritative successful read or write results, in call order. */
  observations: string[];
  /** Evidence-backed tool diagnoses worth surfacing in the action result. */
  notes: string[];
  /**
   * Host hook for a successful document write: read the written document back
   * and queue its `document.content` draft. Supplied by the record adapter so
   * the loop never depends on the session document helpers.
   */
  captureDocument?(args: Record<string, unknown>, result: unknown): void | Promise<void>;
  /**
   * Host hook for one returned tool result. Todo records successful todo
   * payloads; project and vcs record successful tool results through a shared
   * helper capped in total size. Other hosts leave it absent.
   */
  observeToolResult?(content: string): void;
}

export function createLoopRecord(): LoopRecord {
  return { changes: [], updates: [], documents: [], observations: [], notes: [] };
}

/** One recorded workspace change, independent of the ledger's own fields. */
export interface WorkspaceUpdate {
  scope: 'document' | 'workspace' | 'project';
  target: string;
  worktreeId?: string;
  /** A short verb such as `created`, `committed`, `pushed` or `worktree-merged`. */
  change: string;
  version?: string;
  hash?: string;
  files?: readonly string[];
}

/** Append one `workspace.changed` draft and its human-readable change line. */
export function recordWorkspaceUpdate(record: LoopRecord, ctx: ActionRunContext, update: WorkspaceUpdate): void {
  record.updates.push({
    type: 'workspace.changed',
    turn: ctx.turn,
    step: ctx.step,
    parent: ctx.actionId,
    ...update,
  } as unknown as LedgerEventDraft);
  const suffix = update.worktreeId === undefined ? '' : ` (${update.worktreeId})`;
  record.changes.push(`- ${update.change} ${update.target}${suffix}`);
}

/**
 * Turn a finished loop into the action outcome: `done` maps to a successful
 * action and `failed` to a failed one; the result text is the summary followed
 * by one line per recorded workspace change, then every authoritative
 * observation; the deferred drafts are the recorded `workspace.changed` drafts
 * plus any `document.content` drafts the caller passes.
 */
export function toActionOutcome(
  result: AuxiliaryLoopResult,
  record: LoopRecord,
  extraDrafts: readonly LedgerEventDraft[] = [],
): ActionExecutionOutcome {
  const lines = [result.summary, ...record.changes, ...record.observations, ...record.notes]
    .filter((line) => line.trim() !== '');
  return {
    status: result.status === 'done' ? 'done' : 'failed',
    result: lines.join('\n'),
    deferred: [...record.updates, ...extraDrafts],
  };
}

/**
 * Assemble the unified run-record input for one finished auxiliary loop. The id
 * is the owning action id, the role is the loop's role and the caller is the
 * owning session, so the record reads as one auxiliary run in the unified ledger.
 */
function buildAuxiliaryRunRecordInput(args: {
  options: AuxiliaryLoopOptions;
  status: 'done' | 'failed';
  summary: string;
  route?: { provider?: string; model?: string; effort?: string };
  usage: Usage;
  startedAt: string;
  finishedAt: string;
}): AuxiliaryRunRecordInput {
  const { options, status, summary, route, usage, startedAt, finishedAt } = args;
  return {
    id: options.ctx.actionId,
    role: options.role,
    callerSessionId: options.ctx.sessionId,
    status,
    ...(route ? { route } : {}),
    usage: toTaskUsage(usage),
    startedAt,
    finishedAt,
    summary,
  };
}

/** Map summed auxiliary loop usage onto the protocol `TaskUsage` shape. */
function toTaskUsage(usage: Usage): TaskUsage {
  const input = usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = input + cached + output;
  return {
    completeness: 'partial',
    attempt_count: 1,
    usage_event_count: 1,
    ...(input > 0 ? { input_tokens: input } : {}),
    ...(cached > 0 ? { cached_input_tokens: cached } : {}),
    ...(output > 0 ? { output_tokens: output } : {}),
    ...(total > 0 ? { total_tokens: total } : {}),
    reference_cost_complete: false,
  };
}

/** Sum two auxiliary `Usage` records, field by field. */
function sumUsage(total: Usage, next: Usage): Usage {
  const sum: Usage = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'] as const) {
    const value = addUsage(total[key], next[key]);
    if (value !== undefined) sum[key] = value;
  }
  return sum;
}

function addUsage(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

// ─── Protocol tool adapter ──────────────────────────────────────────────────

/**
 * How one protocol method's successful call maps to a recorded workspace
 * change. `when` names a boolean field of the call result that must be `true`
 * for the change to be recorded; an absent `when` records on every success.
 * `after` is an optional per-method hook awaited after the call and its
 * recorded change; it receives the run's record so a host can queue its own
 * document drafts without the loop importing host code.
 */
export interface MethodEffect {
  scope: 'workspace' | 'project' | 'document';
  change: WorkspaceChange;
  when?: string;
  /** When present, the target is taken from this call; otherwise the fallback chain is used. */
  target?(args: Record<string, unknown>, result: unknown): string;
  after?(args: Record<string, unknown>, result: unknown, record: LoopRecord): void | Promise<void>;
}

/**
 * Bind one catalog to a running definition: every `methods`/`call` context
 * carries the definition id, which is how a host gates auxiliary calls by the
 * running definition's allowlist.
 */
export function bindCatalog(catalog: MethodCatalogPort, definitionId: string): MethodCatalogPort {
  return {
    methods(names, context) {
      return catalog.methods(names, { ...context, auxiliaryDefinitionId: definitionId });
    },
    call(method, args, context) {
      return catalog.call(method, args, { ...context, auxiliaryDefinitionId: definitionId });
    },
  };
}

/**
 * Build one {@link LoopTool} per requested protocol method. The catalog
 * describes the methods; every tool declares the method's params JSON Schema
 * with a strict top-level `additionalProperties: false`, forwards its parsed
 * arguments to `catalog.call` and returns the compact JSON result. A
 * successful call whose method has an effect entry (and whose `when` guard, if
 * any, holds in the result) records exactly one `workspace.changed` through the
 * shared helpers, then awaits the effect's optional `after` hook. A host error
 * keeps its string code and message as an error result and never aborts the
 * caller's loop; a throw from the `after` hook becomes the same tool's error
 * result.
 */
export async function protocolTools(
  catalog: MethodCatalogPort,
  helpers: LoopHelpers,
  ctx: ActionRunContext,
  record: LoopRecord,
  methods: readonly string[],
  effects: Readonly<Record<string, MethodEffect>>,
): Promise<LoopTool[]> {
  const infos: MethodInfo[] = await catalog.methods(methods);
  const enumerated = infos.map((info) => info.name);
  for (const name of methods) {
    if (!enumerated.includes(name)) {
      record.notes.push(`Method '${name}' was not returned by the catalog.`);
    }
  }
  return infos.map((info) => {
    const effect = effects[info.name];
    return {
      spec: {
        name: info.name.replace(/\./g, '_'),
        description: info.description,
        parameters: { ...info.params, additionalProperties: false },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        let result: unknown;
        try {
          result = await catalog.call(info.name, args, { sessionId: ctx.sessionId });
        } catch (error) {
          const message = helpers.messageOf(error);
          if (TOOL_NOT_FOUND.test(message) || NO_MCP.test(message)) {
            return errorResult(NO_MCP.test(message) ? 'no-mcp' : 'tool-missing', message);
          }
          return errorResult(errorCodeOf(error), message);
        }
        if (effect !== undefined && effectApplies(effect, result)) {
          recordMethodEffect(record, ctx, args, result, effect);
        }
        if (effect?.after !== undefined) {
          try {
            await effect.after(args, result, record);
          } catch (error) {
            return errorResult(errorCodeOf(error), helpers.messageOf(error));
          }
        }
        return jsonResult(result);
      },
    };
  });
}

/** A call result whose own text reports the tool was never found. */
const TOOL_NOT_FOUND = /tool not found/i;
/** A call result whose own text reports no MCP server is available. */
const NO_MCP = /no mcp/i;

/** Whether the effect's `when` guard (if any) holds for the call result. */
function effectApplies(effect: MethodEffect, result: unknown): boolean {
  if (effect.when === undefined) return true;
  return readBooleanField(result, effect.when) === true;
}

/**
 * Record the single `ws.updated` a successful protocol call produced. `change`
 * is the result's own string `change` when present, otherwise the effect's
 * static change. The target is the effect's own `target` function when present,
 * otherwise the call's project, then the result's project, then `workspace` when
 * the effect is workspace-scoped; the worktree id and commit/version facts come
 * from the call arguments and the result.
 */
function recordMethodEffect(
  record: LoopRecord,
  ctx: ActionRunContext,
  args: Record<string, unknown>,
  result: unknown,
  effect: MethodEffect,
): void {
  const change = readStringField(result, 'change') ?? effect.change;
  const target = effect.target?.(args, result)
    ?? readStringField(args, 'project')
    ?? readStringField(result, 'project')
    ?? (effect.scope === 'workspace' ? 'workspace' : '');
  const worktreeId = readStringField(args, 'worktree_id') ?? readStringField(result, 'worktree_id');
  const hash = readStringField(result, 'hash');
  const files = readStringListField(result, 'files');
  const version = readStringField(result, 'version');
  recordWorkspaceUpdate(record, ctx, {
    scope: effect.scope,
    target,
    ...(worktreeId === undefined ? {} : { worktreeId }),
    change,
    ...(version === undefined ? {} : { version }),
    ...(hash === undefined ? {} : { hash }),
    ...(files === undefined ? {} : { files }),
  });
}

/** Read one string field from a plain object, or undefined. */
function readStringField(source: unknown, key: string): string | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read one boolean field from a plain object, or undefined. */
function readBooleanField(source: unknown, key: string): boolean | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read one string-array field from a plain object, or undefined. */
function readStringListField(source: unknown, key: string): string[] | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}
