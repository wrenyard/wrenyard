/**
 * session ledger rendering: escaping and the event-to-text renderers.
 *
 * Every function is a pure function of its input. An event already on the
 * ledger always renders to the same bytes, so the append-only context only ever
 * grows at its end. This module never calls a model and never touches the
 * ledger.
 */

import type {
  DocContentEvent,
  DocSearchEvent,
  FilesEvent,
  LedgerEvent,
} from './ledger.ts';
import type { SessionFile } from './media.ts';
import type { BuiltView } from './ports.ts';

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

export function renderFiles(event: FilesEvent): string {
  const files = event.files.flatMap((file) => [
    escapeBody(formatFile(file)),
    ...(typeof file.text === 'string' && file.text !== '' ? [escapeBody(file.text)] : []),
  ]);
  return [
    tag('files', [['turn', event.turn], ['cycle', event.cycle], ['source', event.source]]),
    ...(event.files.length === 0 ? ['(none)'] : files),
    '</files>',
  ].join('\n');
}

export function renderDocContent(event: DocContentEvent): string {
  return tag(
    'doc-content',
    [
      ['turn', event.turn], ['cycle', event.cycle], ['path', event.path], ['title', event.title],
      ['updated', event.updated], ['version', event.version], ['tokens', event.tokens],
      ['format', event.format], ['base', event.base], ['source', event.source],
    ],
    escapeBody(event.content),
  );
}

export function renderDocSearch(event: DocSearchEvent): string {
  return [
    tag('doc-search', [['turn', event.turn], ['cycle', event.cycle], ['id', event.actionId]]),
    escapeBody(event.understanding),
    ...event.picks.map((pick) => escapeBody(`- pick ${pick.path}: ${pick.reason}`)),
    ...event.near.map((near) => escapeBody(`- near ${near.path}: ${near.reason}`)),
    ...event.notes.map((note) => escapeBody(`- note ${note}`)),
    '</doc-search>',
  ].join('\n');
}

/**
 * Render one current context event as text, or `undefined` for observational
 * events (calls and `action.titled`) and post-interrupt results. Thinking is a
 * context event and renders before the message it precedes.
 */
export function renderEventText(event: LedgerEvent): string | undefined {
  switch (event.type) {
    case 'turn.started':
      return tag('message', [['turn', event.turn], ['role', 'user'], ['at', event.at]], escapeBody(event.text));
    case 'cycle.started':
      // The per-request facts of one reasoning cycle, fixed once written.
      return tag('wy-info', [
        ['turn', event.turn], ['cycle', event.cycle], ['at', event.at],
        ['model', event.model], ['context-window', event.contextWindow], ['last-input-tokens', event.lastInputTokens],
      ]);
    case 'thinking':
      return tag('thinking', [['turn', event.turn], ['cycle', event.cycle]], escapeBody(event.text));
    case 'reason.completed':
      return tag('message', [['turn', event.turn], ['cycle', event.cycle], ['role', 'assistant']], escapeBody(event.text));
    case 'memory.recalled':
      return tag('memory-recall', [['turn', event.turn], ['cycle', event.cycle], ['path', event.path], ['source', event.source]], escapeBody(event.content));
    case 'doc.search':
      return renderDocSearch(event);
    case 'doc.content':
      return renderDocContent(event);
    case 'files':
      return renderFiles(event);
    case 'action.started': {
      const parsed = event.parsed as { intent?: unknown } | undefined;
      const intent = typeof parsed?.intent === 'string' ? parsed.intent : '';
      return tag('action', [['id', event.actionId], ['type', event.kind]], escapeBody(intent));
    }
    case 'action.finished':
      if (event.afterInterrupt === true) return undefined;
      return tag(
        'action-result',
        [['turn', event.turn], ['cycle', event.cycle], ['id', event.actionId], ['kind', event.kind], ['status', event.status], ['task', event.task], ['run', event.taskRunId]],
        escapeBody(event.result),
      );
    case 'reply':
      return tag('reply', [['turn', event.turn]], escapeBody(event.text));
    case 'ws.updated':
      return tag('wy-info', [
        ['type', 'ws.updated'], ['action', event.actionId], ['scope', event.scope], ['target', event.target],
        ['change', event.change], ['worktreeId', event.worktreeId], ['version', event.version],
        ['hash', event.hash], ['files', event.files?.join(',')],
      ]);
    case 'turn.interrupted':
      return tag('interrupt', [['turn', event.turn], ['reason', event.reason]]);
    case 'error':
      return tag('error', [['turn', event.turn], ['stage', event.stage]], escapeBody(event.message));
    // Observational only: never part of the rendered context.
    case 'call.started':
    case 'call':
    case 'action.titled':
    case 'session.created':
    case 'turn.finished':
    case 'title':
      return undefined;
    default:
      return undefined;
  }
}

/** Render the approved context events as TEXT ONLY inside `<events>`. */
export function renderEventsBlock(events: readonly LedgerEvent[]): string {
  const rendered = events.map(renderEventText).filter((text): text is string => text !== undefined);
  const body = rendered.length === 0 ? '' : `\n${rendered.join('\n')}`;
  return `<events>${body}\n</events>`;
}

/** Tool result of an action that was still running when a later request was assembled. */
export const ACTION_RUNNING = 'Running. The result arrives later as an <action-result> record.';
