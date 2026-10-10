/**
 * The document secondary session.
 *
 * It lists, reads, creates and revises Markdown documents under
 * `projects/<project>/docs` through the daemon-hosted document protocol
 * methods, exposed as tools by the shared protocol adapter. A document is
 * identified by its project, its kind (spec, report or handoff) and its name;
 * the file location is only the session internal ledger key and is never shown
 * to the model. Each successful write records a `ws.updated` draft; the written
 * document is then read back through the protocol and queued as a `doc.content`
 * draft, exactly as the action layer defers drafts.
 */

import { makeDocumentDraft, type DocContentDraft } from '../../documents.ts';
import type { LedgerEvent, LedgerEventDraft } from '../../ledger.ts';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../index.ts';
import {
  buildSecondaryUser,
  createSecondaryRecord,
  protocolTools,
  runSecondary,
  toActionOutcome,
  type MethodEffect,
  type SecondaryRecord,
} from './framework.ts';

/** Rounds the document loop may run before it fails. */
const DOCUMENT_MAX_ROUNDS = 24;

/** The document protocol methods this session exposes. */
const METHODS = [
  'workspace.doc.list',
  'workspace.doc.read',
  'workspace.doc.create',
  'workspace.doc.update',
  'workspace.doc.edit',
  'workspace.doc.delete',
];

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
  const record = createSecondaryRecord();
  const after = documentDraftHook(deps, ctx, record);
  const effects: Readonly<Record<string, MethodEffect>> = {
    'workspace.doc.create': { scope: 'document', change: 'created', target: documentTarget, after },
    'workspace.doc.update': { scope: 'document', change: 'updated', target: documentTarget, after },
    'workspace.doc.edit': { scope: 'document', change: 'updated', target: documentTarget, after },
    // A delete has no after hook: there is no new content to load back.
    'workspace.doc.delete': { scope: 'document', change: 'deleted', target: documentTarget },
  };
  const result = await runSecondary({
    deps,
    ctx,
    role: 'document',
    system: documentSystemPrompt(deps),
    user: buildSecondaryUser(ctx, action.intent),
    tools: await protocolTools(deps, ctx, record, METHODS, effects),
    maxRounds: DOCUMENT_MAX_ROUNDS,
    callIdPrefix: 'doc',
  });
  return toActionOutcome(result, record, record.documents);
}

/**
 * The readable `project/kind/name` target of a document method result: the
 * name is the result's revisited name (a create returns the full dated name)
 * else the call's name, and project and kind come from the result else the
 * call. It is never a path.
 */
function documentTarget(args: Record<string, unknown>, result: unknown): string {
  const project = readStringField(result, 'project') ?? readStringField(args, 'project') ?? '';
  const kind = readStringField(result, 'kind') ?? readStringField(args, 'kind') ?? '';
  const name = readStringField(result, 'name') ?? readStringField(args, 'name') ?? '';
  return `${project}/${kind}/${name}`;
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
  record: SecondaryRecord,
): (args: Record<string, unknown>, result: unknown) => Promise<void> {
  return async (args, result) => {
    const project = readStringField(result, 'project') ?? readStringField(args, 'project');
    const kind = readStringField(result, 'kind') ?? readStringField(args, 'kind');
    const name = readStringField(result, 'name') ?? readStringField(args, 'name');
    if (project === undefined || kind === undefined || name === undefined) return;
    if (!(kind in KIND_DIRECTORIES)) return;
    const read = await deps.host.call('workspace.doc.read', { project, kind, name }) as {
      title?: unknown;
      content?: unknown;
    } | undefined;
    const content = typeof read?.content === 'string' ? read.content : '';
    const title = typeof read?.title === 'string' ? read.title : name;
    const draft = makeDocumentDraft(
      { path: documentKey(project, kind as keyof typeof KIND_DIRECTORIES, name), title, content },
      draftEvents(ctx, record.documents),
      { turn: ctx.turn, cycle: ctx.cycle, actionId: ctx.actionId, source: 'write' },
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

/** The system prompt: the writer's role, the verbatim rules and the workflow. */
function documentSystemPrompt(deps: ActionRunnerDeps): string {
  const rules = deps.files.readDocumentRules();
  return [
    'You are the document writer of a Wrenyard session.',
    'You write and revise Markdown documents through the tools. You never edit files directly.',
    '',
    'Document rules:',
    rules.trim() === '' ? '(no document rules are configured)' : rules,
    '',
    'Tools:',
    "- workspace_doc_list: list a project's documents to find a name.",
    '- workspace_doc_read: read one document by project, kind and name; returns its content and version.',
    '- workspace_doc_create: create one new document; give a short lowercase slug and the full dated name is returned.',
    '- workspace_doc_update: replace a document with new full content; pass base_version taken from workspace_doc_read.',
    '- workspace_doc_edit: apply local edits to an existing document; each edit replaces one unique old text.',
    '',
    'Rules:',
    '- A document is identified by its project, its kind (spec, report or handoff) and its name.',
    "- List a project's documents with workspace_doc_list to find a name.",
    '- To create a document give a short lowercase slug; the full dated name is returned.',
    '- Read a document before revising or deleting it, and pass base_version taken from workspace_doc_read.',
    '- Prefer workspace_doc_edit for local changes; give exact old text that occurs exactly once.',
    '- Use workspace_doc_update only for a full rewrite, and pass base_version taken from workspace_doc_read.',
    '- When a call returns conflict or missing, read the document again before retrying.',
    '- Delete a document only when the intent explicitly asks to delete it.',
    '- Use only facts from the conversation and the documents you read.',
    "- The document language follows the project's document rules.",
    '- Never mention files, paths or directories in the done summary; refer to documents by kind and name.',
    '- Finish with done and a summary of one to three sentences.',
  ].join('\n');
}
