/**
 * session ledger rendering: escaping and the event-to-text renderers.
 *
 * Every function is a pure function of its input. An event already on the
 * ledger always renders to the same bytes, so the append-only context only ever
 * grows at its end. This module never calls a model and never touches the
 * ledger.
 */

import {
  CONTEXT_EVENT_TYPES,
  type DocumentContentEvent,
  type DocumentFoundEvent,
  type FilesAttachedEvent,
  type LedgerEvent,
} from '../ledger/store.ts';
import { estimateTokens } from '../model/request.ts';
import type { SessionFile } from '../media.ts';
import type { BuiltView } from '../ports.ts';

// ─── Escaping ──────────────────────────────────────────────────────────────

const BODY_CLOSING =
  /<\/(?:wy-[A-Za-z0-9-]+|message|thinking|memory-recall|doc-search|doc-content|files|action-result|reply|ws-update|interrupt|error)>/gu;

export function escapeBody(text: string): string {
  return text.replace(BODY_CLOSING, (match) => `&lt;${match.slice(1, -1)}&gt;`);
}

/** Escape communication framing without changing any other view's rendering. */
export function escapeReplyBody(text: string): string {
  return escapeBody(text).replace(/<\/(?:infos|actions)>/gu, (match) => `&lt;${match.slice(1, -1)}&gt;`);
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

export type Attribute = readonly [name: string, value: string | number | undefined];

export function tag(name: string, attributes: readonly Attribute[], body?: string): string {
  let open = `<${name}`;
  for (const [key, value] of attributes) {
    if (value === undefined) continue;
    open += ` ${key}="${escapeAttr(String(value))}"`;
  }
  return body === undefined ? `${open}/>` : `${open}>${body}</${name}>`;
}

/** The shared two-part view shape (stable system prompt plus one user message). */
export function twoPartView(system: string, user: string, layer: string): BuiltView {
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    layers: { 'wy-system': system.length, [layer]: user.length },
    segments: { 'wy-system': system, [layer]: user },
  };
}

// ─── Event rendering ────────────────────────────────────────────────────────

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

export function renderFiles(event: FilesAttachedEvent): string {
  const files = event.files.flatMap((file) => [
    escapeBody(formatFile(file)),
    ...(typeof file.text === 'string' && file.text !== '' ? [escapeBody(file.text)] : []),
  ]);
  return [
    tag('files', [['turn', event.turn], ['cycle', event.step], ['source', event.source]]),
    ...(event.files.length === 0 ? ['(none)'] : files),
    '</files>',
  ].join('\n');
}

export function renderDocContent(event: DocumentContentEvent): string {
  return tag(
    'doc-content',
    [
      ['turn', event.turn], ['cycle', event.step], ['path', event.path], ['title', event.title],
      ['updated', event.updated], ['version', event.version], ['tokens', event.tokens],
      ['format', event.format], ['base', event.base], ['source', event.source],
    ],
    escapeBody(event.content),
  );
}

export function renderDocSearch(event: DocumentFoundEvent): string {
  return [
    tag('doc-search', [['turn', event.turn], ['cycle', event.step], ['id', event.parent]]),
    escapeBody(event.understanding),
    ...event.picks.map((pick) => escapeBody(`- pick ${pick.path}: ${pick.reason}`)),
    ...event.near.map((near) => escapeBody(`- near ${near.path}: ${near.reason}`)),
    ...event.notes.map((note) => escapeBody(`- note ${note}`)),
    '</doc-search>',
  ].join('\n');
}

// ─── Reduced (cold) rendering ───────────────────────────────────────────────

/** Length above which a reduced assistant text or reply is cut. */
export const REDUCED_TEXT_LIMIT = 1_500;
/** Characters kept from the head and the tail of a reduced text. */
export const REDUCED_TEXT_HEAD = 1_200;
export const REDUCED_TEXT_TAIL = 200;
/** Length above which a reduced reply is cut; it is cut the same way as text. */
export const REDUCED_REPLY_LIMIT = 2_000;
/** Length above which a reduced action result is cut. */
export const REDUCED_RESULT_LIMIT = 1_500;
/** Characters kept from the head and the tail of a reduced action result. */
export const REDUCED_RESULT_HEAD = 1_000;
export const REDUCED_RESULT_TAIL = 300;
/** Length above which the arguments of one reduced tool call are cut. */
export const REDUCED_ARGUMENT_LIMIT = 500;
/** Characters kept from the head and the tail of reduced tool-call arguments. */
export const REDUCED_ARGUMENT_HEAD = 400;
export const REDUCED_ARGUMENT_TAIL = 100;

/** The first line of one text; every following line is dropped. */
export function firstLine(text: string): string {
  const index = text.indexOf('\n');
  return index === -1 ? text : text.slice(0, index);
}

/**
 * Cut one long text to its head and tail, naming the characters released. The
 * paired head and tail keep the opening and the conclusion, which is what the
 * model still needs from a cold event.
 */
export function cutReleasedChars(
  text: string,
  limit: number,
  head: number,
  tail: number,
): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, head)}…[省略 ${text.length - head - tail} 字]${text.slice(text.length - tail)}`;
}

/** Cut one long action result the same way, naming the tokens released. */
export function cutReleasedTokens(
  text: string,
  limit: number,
  head: number,
  tail: number,
): string {
  if (text.length <= limit) return text;
  const released = estimateTokens(text.slice(head, text.length - tail));
  return `${text.slice(0, head)}…[省略约 ${released} tokens]${text.slice(text.length - tail)}`;
}

/** A document's stub: the content is released and re-read only when needed. */
function renderDocContentStub(event: DocumentContentEvent): string {
  return tag(
    'doc-content',
    [
      ['turn', event.turn], ['cycle', event.step], ['path', event.path], ['title', event.title],
      ['updated', event.updated], ['version', event.version], ['tokens', event.tokens],
      ['format', event.format], ['base', event.base], ['source', event.source],
    ],
    escapeBody(`[文档 ${event.path} 约 ${event.tokens} tokens 已释放，需要时重新读取]`),
  );
}

/** A document search result reduced to the paths and titles it found. */
function renderDocSearchStub(event: DocumentFoundEvent): string {
  return [
    tag('doc-search', [['turn', event.turn], ['cycle', event.step], ['id', event.parent]]),
    ...event.picks.map((pick) => escapeBody(`- pick ${pick.path}: ${pick.title}`)),
    ...event.near.map((near) => escapeBody(`- near ${near.path}: ${near.title}`)),
    '</doc-search>',
  ].join('\n');
}

/** File names and kinds only; no bytes, descriptions or text. */
function renderFilesStub(event: FilesAttachedEvent): string {
  const files = event.files.map((file) => escapeBody(`[file name=${file.name} kind=${file.kind}]`));
  return [
    tag('files', [['turn', event.turn], ['cycle', event.step], ['source', event.source]]),
    ...(event.files.length === 0 ? ['(none)'] : files),
    '</files>',
  ].join('\n');
}

/** Options for {@link renderEventText}. */
export interface RenderEventOptions {
  /**
   * Render the reduced cold form: bulky content is released and replaced by a
   * stub the program generates. User messages are never reduced.
   */
  reduced?: boolean;
}

/**
 * Render one current context event as text, or `undefined` for observational
 * events (spans, `step.finished`, `action.titled`), post-interrupt results and
 * every event outside {@link CONTEXT_EVENT_TYPES}. Thinking is a context event
 * and renders before the message it precedes.
 *
 * `opts.reduced` renders the cold form of a reduced event: long assistant texts
 * and tool results are cut to head plus tail, documents, memory recalls and
 * attachments become stubs, system notices are dropped and errors keep their
 * first line. User messages, step markers, workspace changes and interruptions
 * never change.
 */
export function renderEventText(
  event: LedgerEvent,
  opts?: RenderEventOptions,
): string | undefined {
  if (!CONTEXT_EVENT_TYPES.has(event.type)) return undefined;
  const reduced = opts?.reduced === true;
  switch (event.type) {
    case 'turn.started':
      // A user message is a requirement; it is never reduced.
      return tag('message', [['turn', event.turn], ['role', 'user'], ['at', event.at]], escapeBody(event.text));
    case 'turn.steered':
      return tag('message', [['turn', event.turn], ['role', 'user'], ['at', event.at]], escapeBody(event.text));
    case 'step.started':
      // The per-request facts of one reasoning step, fixed once written.
      return tag('wy-info', [
        ['turn', event.turn], ['cycle', event.step], ['at', event.at],
        ['model', event.model], ['context-window', event.contextWindow], ['last-input-tokens', event.lastInputTokens],
      ]);
    case 'reasoning.thinking':
      return tag('thinking', [['turn', event.turn], ['cycle', event.step]], escapeBody(event.text));
    case 'reasoning.completed':
      return tag(
        'message',
        [['turn', event.turn], ['cycle', event.step], ['role', 'assistant']],
        escapeBody(reduced
          ? cutReleasedChars(event.text, REDUCED_TEXT_LIMIT, REDUCED_TEXT_HEAD, REDUCED_TEXT_TAIL)
          : event.text),
      );
    case 'memory.recalled':
      // Only the memory's path survives; its content is re-read when needed.
      return tag(
        'memory-recall',
        [['turn', event.turn], ['cycle', event.step], ['path', event.path], ['source', event.source]],
        reduced ? '' : escapeBody(event.content),
      );
    case 'document.found':
      return reduced ? renderDocSearchStub(event) : renderDocSearch(event);
    case 'document.content':
      return reduced ? renderDocContentStub(event) : renderDocContent(event);
    case 'files.attached':
      return reduced ? renderFilesStub(event) : renderFiles(event);
    case 'action.started':
      return tag('action', [['id', event.id], ['type', event.action.type]], escapeBody(event.action.prompt));
    case 'action.finished':
      // An interrupted result stays out of the context.
      if (event.afterInterrupt === true) {
        return undefined;
      }
      // The status and the structured fields are always kept; only the bulky
      // result body is cut.
      return tag(
        'action-result',
        [['turn', event.turn], ['cycle', event.step], ['id', event.id], ['kind', event.action.type], ['status', event.status], ['task', event.task], ['run', event.taskRunId]],
        escapeBody(reduced
          ? cutReleasedTokens(event.result, REDUCED_RESULT_LIMIT, REDUCED_RESULT_HEAD, REDUCED_RESULT_TAIL)
          : event.result),
      );
    case 'workspace.changed':
      return tag('wy-info', [
        ['type', 'ws.updated'], ['action', event.parent], ['scope', event.scope], ['target', event.target],
        ['change', event.change], ['worktreeId', event.worktreeId], ['version', event.version],
        ['hash', event.hash], ['files', event.files?.join(',')],
      ]);
    case 'turn.interrupted':
      return tag('interrupt', [['turn', event.turn], ['reason', event.reason]]);
    case 'reply.sent':
      return tag('reply', [['turn', event.turn]], escapeBody(reduced
        ? cutReleasedChars(event.text, REDUCED_REPLY_LIMIT, REDUCED_TEXT_HEAD, REDUCED_TEXT_TAIL)
        : event.text));
    case 'system.error':
      // Kept as the original `<error>` record so existing sessions render unchanged.
      return tag(
        'error',
        [['turn', event.turn], ['stage', event.code]],
        escapeBody(reduced ? firstLine(event.message) : event.message),
      );
    case 'system.warning':
    case 'system.info':
      if (reduced) return undefined;
      return tag(
        'wy-info',
        [['type', event.type], ['turn', event.turn], ['source', event.source], ['code', event.code]],
        escapeBody(event.message),
      );
    default:
      return undefined;
  }
}

/** Render the approved context events as TEXT ONLY inside `<events>`. */
export function renderEventsBlock(events: readonly LedgerEvent[]): string {
  const rendered = events
    .map((event) => renderEventText(event))
    .filter((text): text is string => text !== undefined);
  const body = rendered.length === 0 ? '' : `\n${rendered.join('\n')}`;
  return `<events>${body}\n</events>`;
}

/** Tool result of an action that was still running when a later request was assembled. */
export const ACTION_RUNNING = 'Running. The result arrives later as an <action-result> record.';
