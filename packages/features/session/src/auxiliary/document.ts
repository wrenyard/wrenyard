/**
 * The document auxiliary task.
 *
 * The loop, its tool adapter and the definition data (role, methods, effects,
 * round budget and system prompt) live in `@wrenyard/agent-loop`. This module
 * is the session-side adapter: it supplies the method catalog, the model
 * transport, the workspace document rules and a record adapter that writes
 * exactly the drafts the session wrote before — a `workspace.changed` per
 * successful write and, through `makeDocumentDraft`, the written document's
 * `document.content` draft.
 *
 * A document is identified by its project, its kind (spec, report or handoff)
 * and its name; the file location is only the session internal ledger key and
 * is never shown to the model.
 */

import { runAuxiliary, type AuxiliaryRecordPort, createLoopRecord } from '@wrenyard/agent-loop';

import { escapeBody, renderEventsBlock } from '../context/render.ts';
import { makeDocumentDraft, type DocContentDraft } from '../documents.ts';
import { messageOf } from '../errors.ts';
import type { LedgerEvent, LedgerEventDraft } from '../ledger/store.ts';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../reasoning/actions.ts';

/** Document kind to its directory under `docs/`. */
const KIND_DIRECTORIES = {
  spec: 'specs',
  report: 'reports',
  handoff: 'handoff',
} as const;

/**
 * The session internal ledger key of a document:
 * `projects/<project>/docs/<dir>/<name>.md`, where `<dir>` is the kind's
 * directory. It is used only inside this file to key the `doc.content` ledger
 * draft; models never see it and address a document by project, kind and name.
 */
function documentKey(project: string, kind: keyof typeof KIND_DIRECTORIES, name: string): string {
  return `projects/${project}/docs/${KIND_DIRECTORIES[kind]}/${name}.md`;
}

/** Start one document session for a parsed write action. */
export async function runDocumentAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record: AuxiliaryRecordPort = {
    ...createLoopRecord(),
    helpers: {
      messageOf,
      escapeBody,
      renderEventsBlock,
    },
  };
  record.captureDocument = documentDraftHook(deps, ctx, record);
  return runAuxiliary('document', action.intent, {
    catalog: deps.host,
    calls: deps.calls,
    record,
    context: ctx,
    documentRules: () => deps.files.readDocumentRules(),
  });
}

/**
 * The `after` hook shared by the write methods: read the written document back
 * through the protocol by its returned name and queue its `doc.content` draft
 * keyed by the session internal document key. A document that cannot be read
 * back is not an error.
 */
function documentDraftHook(
  deps: ActionRunnerDeps,
  ctx: ActionRunContext,
  record: AuxiliaryRecordPort,
): (args: Record<string, unknown>, result: unknown) => Promise<void> {
  return async (args, result) => {
    const project = readStringField(result, 'project') ?? readStringField(args, 'project');
    const kind = readStringField(result, 'kind') ?? readStringField(args, 'kind');
    const name = readStringField(result, 'name') ?? readStringField(args, 'name');
    const id = readStringField(result, 'id') ?? readStringField(args, 'id');
    if (project === undefined || (id !== 'AGENTS.md' && (kind === undefined || name === undefined))) return;
    if (id !== 'AGENTS.md' && !(kind! in KIND_DIRECTORIES)) return;
    const target = id === 'AGENTS.md' ? { project, id } : { project, kind, name };
    const read = await deps.host.call('workspace.doc.read', target) as {
      title?: unknown;
      content?: unknown;
    } | undefined;
    const content = typeof read?.content === 'string' ? read.content : '';
    const fallbackTitle = id === 'AGENTS.md' ? 'AGENTS.md' : (name ?? '');
    const title = typeof read?.title === 'string' ? read.title : fallbackTitle;
    const draft = makeDocumentDraft(
      { path: id === 'AGENTS.md' ? `projects/${project}/AGENTS.md` : documentKey(project, kind as keyof typeof KIND_DIRECTORIES, name!), title, content },
      draftEvents(ctx, record.documents),
      { turn: ctx.turn, step: ctx.step, parent: ctx.actionId, source: 'write' },
    );
    if (draft !== undefined) record.documents.push(draft);
  };
}

/**
 * The ledger events as of now plus this run's already queued `doc.content`
 * drafts, in order. A later write in the same loop must diff against the
 * content its earlier writes produced rather than the ledger base the run
 * started from, so the whole run stays a valid chained history. The queued
 * values are `doc.content` bodies, so a synthetic `seq`/`at` is enough to view
 * each as a ledger event.
 */
function draftEvents(ctx: ActionRunContext, drafts: readonly LedgerEventDraft[]): LedgerEvent[] {
  const events = ctx.currentEvents();
  const queued = drafts.map((draft, index): LedgerEvent => ({
    ...(draft as DocContentDraft),
    seq: events.length + index + 1,
    at: '',
  }));
  return [...events, ...queued];
}

/** Read a string field from a plain object, or undefined. */
function readStringField(source: unknown, key: string): string | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
