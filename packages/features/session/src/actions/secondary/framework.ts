/**
 * The shared multi-round tool loop used by every secondary session.
 *
 * A secondary session is a cheap, tool-calling sub-conversation: a document
 * writer, a version-control operator or a project/worktree manager. Each session
 * runs the same loop here and only differs in its system prompt, its user
 * message and its tool set. The loop reuses the session's existing model call
 * runner ([`ActionRunnerDeps.calls`] via `runView`), the same call-id scheme and
 * the same deferred-draft return shape the action layer already uses, so it
 * never introduces a second call path.
 *
 * The loop ends when the model calls the `done` tool; a call failure, two
 * silent rounds in a row or the round limit end it as a failure. Every tool
 * error is reported back to the model as a tool result and never aborts the
 * loop.
 */

import type { ModelMessage, ModelToolCall, ToolCall, ToolSpec } from '../../driver.ts';
import type {
  ActionExecutionOutcome,
  ActionRunContext,
  ActionRunnerDeps,
} from '../index.ts';
import type { LedgerEventDraft, WsUpdatedEvent } from '../../ledger.ts';
import { escapeBody, renderEventsBlock } from '../../render.ts';
import { messageOf } from '../../errors.ts';

/** Which secondary session is running; used for ledger call attribution. */
export type SecondaryRole = 'document' | 'vcs' | 'project';

/**
 * The one tool every secondary session declares to finish. `status` is `done`
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

/** One tool a secondary session exposes to the model. */
export interface SecondaryTool {
  spec: ToolSpec;
  /** Run the tool with parsed JSON arguments; return a compact JSON result. */
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/** Everything one secondary loop run needs. */
export interface SecondaryRunOptions {
  deps: ActionRunnerDeps;
  ctx: ActionRunContext;
  role: SecondaryRole;
  /** Stable system prompt of this session. */
  system: string;
  /** The user message, normally from {@link buildSecondaryUser}. */
  user: string;
  tools: readonly SecondaryTool[];
  maxRounds: number;
  /** Prefix for every round's fresh call id. */
  callIdPrefix: string;
}

/** The terminal outcome of a secondary loop. */
export interface SecondaryResult {
  status: 'done' | 'failed';
  summary: string;
}

/**
 * Run one secondary session loop. Each round makes exactly one model call
 * through the same runner the action layer uses, appends the assistant output
 * and one tool message per call, and repeats until the model calls `done`.
 */
export async function runSecondary(options: SecondaryRunOptions): Promise<SecondaryResult> {
  const { deps, ctx, role, system, user, tools, maxRounds, callIdPrefix } = options;
  const toolMap = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const specs: ToolSpec[] = [...tools.map((tool) => tool.spec), DONE_TOOL];
  const layers = { 'wy-system': system.length, 'wy-ctx': user.length };
  const messages: ModelMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let silentRounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    if (ctx.signal.aborted) return abortedResult();

    const callId = `${callIdPrefix}.${round}`;
    let text: string;
    let calls: readonly ToolCall[];
    try {
      const result = await deps.calls.run({
        callId,
        role,
        turn: ctx.turn,
        cycle: ctx.cycle,
        messages: [...messages],
        layers,
        signal: ctx.signal,
        tools: specs,
      }) as { text: string; toolCalls?: readonly ToolCall[] };
      text = result.text;
      calls = result.toolCalls ?? [];
    } catch (error) {
      return { status: 'failed', summary: `The model call failed: ${messageOf(error)}` };
    }
    if (ctx.signal.aborted) return abortedResult();

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
      if (silentRounds >= 2) return { status: 'failed', summary: 'The model did not call a tool.' };
      messages.push({ role: 'user', content: 'Call a tool or call done.' });
      continue;
    }
    silentRounds = 0;

    for (const call of calls) {
      if (ctx.signal.aborted) return abortedResult();
      if (call.name === DONE_TOOL.name) {
        const done = readDoneCall(call);
        if (!done.ok) {
          messages.push({ role: 'tool', toolCallId: call.id, content: errorResult('invalid_arguments', done.error) });
          continue;
        }
        return { status: done.status, summary: done.summary };
      }
      const content = await runToolCall(toolMap.get(call.name), call, ctx.signal);
      messages.push({ role: 'tool', toolCallId: call.id, content });
    }
  }

  return { status: 'failed', summary: `The round limit of ${maxRounds} was reached.` };
}

function abortedResult(): SecondaryResult {
  return { status: 'failed', summary: 'The session was interrupted.' };
}

/** Run one model tool call, converting every failure into a tool result. */
async function runToolCall(tool: SecondaryTool | undefined, call: ToolCall, signal: AbortSignal): Promise<string> {
  if (tool === undefined) return errorResult('unknown_tool', `Unknown tool: ${call.name}`);
  const args = parseArguments(call.arguments);
  if (!args.ok) return errorResult('invalid_arguments', args.error);
  try {
    return await tool.run(args.value, signal);
  } catch (error) {
    return errorResult(errorCodeOf(error), messageOf(error));
  }
}

/** Validate the `done` call's arguments; a malformed call stays a tool error. */
function readDoneCall(
  call: ToolCall,
): { ok: true; status: 'done' | 'failed'; summary: string } | { ok: false; error: string } {
  const args = parseArguments(call.arguments);
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
function parseArguments(raw: string): ParsedArguments {
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

/**
 * Build the one user message of a secondary request: the whole conversation
 * under `<wy-ctx><wy-conversation>`, the call's facts (time, device and the
 * registered projects) under `<wy-info>`, and the intent under `<wy-intent>`.
 */
export function buildSecondaryUser(ctx: ActionRunContext, intent: string): string {
  const conversation = renderEventsBlock(ctx.currentEvents());
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
    escapeBody(info),
    '</wy-info>',
    '<wy-intent>',
    escapeBody(intent),
    '</wy-intent>',
  ].join('\n');
}

// ─── Recorded side effects and the action outcome ───────────────────────────

/**
 * The side effects a secondary session performed, collected by its tools and
 * turned into an {@link ActionExecutionOutcome} once the loop returns.
 */
export interface SecondaryRecord {
  /** One human-readable line per recorded workspace change, in order. */
  changes: string[];
  /** Deferred `ws.updated` drafts, in the order the changes happened. */
  updates: LedgerEventDraft[];
  /** Deferred `doc.content` drafts, in the order the writes happened. */
  documents: LedgerEventDraft[];
}

export function createSecondaryRecord(): SecondaryRecord {
  return { changes: [], updates: [], documents: [] };
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

/** Append one `ws.updated` draft and its human-readable change line. */
export function recordWorkspaceUpdate(record: SecondaryRecord, ctx: ActionRunContext, update: WorkspaceUpdate): void {
  record.updates.push({
    type: 'ws.updated',
    turn: ctx.turn,
    cycle: ctx.cycle,
    actionId: ctx.actionId,
    ...update,
  } as unknown as LedgerEventDraft);
  const suffix = update.worktreeId === undefined ? '' : ` (${update.worktreeId})`;
  record.changes.push(`- ${update.change} ${update.target}${suffix}`);
}

/**
 * Turn a finished loop into the action outcome: `done` maps to a successful
 * action and `failed` to a failed one; the result text is the summary followed
 * by one line per recorded workspace change; the deferred drafts are the
 * recorded `ws.updated` drafts plus any `doc.content` drafts the caller passes.
 */
export function toActionOutcome(
  result: SecondaryResult,
  record: SecondaryRecord,
  extraDrafts: readonly LedgerEventDraft[] = [],
): ActionExecutionOutcome {
  const lines = [result.summary, ...record.changes].filter((line) => line.trim() !== '');
  return {
    status: result.status === 'done' ? 'done' : 'failed',
    result: lines.join('\n'),
    deferred: [...record.updates, ...extraDrafts],
  };
}

// ─── Protocol tool adapter ──────────────────────────────────────────────────

/**
 * How one protocol method's successful call maps to a recorded workspace
 * change. `when` names a boolean field of the call result that must be `true`
 * for the change to be recorded; an absent `when` records on every success.
 * `after` is an optional per-method hook awaited after the call and its
 * recorded change.
 */
export interface MethodEffect {
  scope: 'workspace' | 'project' | 'document';
  change: WsUpdatedEvent['change'];
  when?: string;
  /** When present, its return value is the recorded target; otherwise the fallback chain is used. */
  target?(args: Record<string, unknown>, result: unknown): string;
  after?(args: Record<string, unknown>, result: unknown): void | Promise<void>;
}

/**
 * Build one {@link SecondaryTool} per requested protocol method. The host
 * describes the methods; every tool declares the method's params JSON Schema
 * with a strict top-level `additionalProperties: false`, forwards its parsed
 * arguments to `deps.host.call` and returns the compact JSON result. A
 * successful call whose method has an effect entry (and whose `when` guard, if
 * any, holds in the result) records exactly one `ws.updated` through the shared
 * helpers, then awaits the effect's optional `after` hook. A host error keeps
 * its string code and message as an error result and never aborts the caller's
 * loop; a throw from the `after` hook becomes the same tool's error result.
 */
export async function protocolTools(
  deps: ActionRunnerDeps,
  ctx: ActionRunContext,
  record: SecondaryRecord,
  methods: readonly string[],
  effects: Readonly<Record<string, MethodEffect>>,
): Promise<SecondaryTool[]> {
  const infos = await deps.host.methods(methods);
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
          result = await deps.host.call(info.name, args);
        } catch (error) {
          return errorResult(errorCodeOf(error), messageOf(error));
        }
        if (effect !== undefined && effectApplies(effect, result)) {
          recordMethodEffect(record, ctx, args, result, effect);
        }
        if (effect?.after !== undefined) {
          try {
            await effect.after(args, result);
          } catch (error) {
            return errorResult(errorCodeOf(error), messageOf(error));
          }
        }
        return jsonResult(result);
      },
    };
  });
}

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
  record: SecondaryRecord,
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
