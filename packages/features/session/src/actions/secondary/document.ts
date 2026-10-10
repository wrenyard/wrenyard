/**
 * The document secondary session.
 *
 * It writes and revises Markdown documents under `projects/<project>/docs` by
 * calling the daemon-hosted document service through `deps.host.writeDocument`.
 * It never edits files itself, so every write is path-checked and
 * compare-and-swapped by the host. Each successful write is recorded as a
 * `ws.updated` draft plus a `doc.content` draft, exactly as the action layer
 * defers drafts.
 */

import { contentVersion, makeDocumentDraft } from '../../documents.ts';
import type { ActionExecutionOutcome, ActionRunContext, ActionRunnerDeps, ParsedAction } from '../index.ts';
import {
  buildSecondaryUser,
  createSecondaryRecord,
  errorResult,
  jsonResult,
  optionalStringArg,
  recordWorkspaceUpdate,
  runSecondary,
  stringArg,
  ToolArgumentError,
  toActionOutcome,
  type SecondaryRecord,
  type SecondaryTool,
} from './framework.ts';

/** Rounds the document loop may run before it fails. */
const DOCUMENT_MAX_ROUNDS = 24;

/** Start one document session for a parsed write action. */
export async function runDocumentAction(
  deps: ActionRunnerDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const record = createSecondaryRecord();
  const result = await runSecondary({
    deps,
    ctx,
    role: 'document',
    system: documentSystemPrompt(deps),
    user: buildSecondaryUser(ctx, action.intent),
    tools: documentTools(deps, ctx, record),
    maxRounds: DOCUMENT_MAX_ROUNDS,
    callIdPrefix: 'doc',
  });
  return toActionOutcome(result, record, record.documents);
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
    'Rules:',
    '- New documents live under projects/<project>/docs/<specs|plans|reports|handoff>/YYYY-MM-DD-<slug>.md.',
    '- Read before you revise. Prefer edit_document for local changes; use rewrite_document only for a full rewrite.',
    '- Use only facts from the conversation and the documents you read.',
    "- The document language follows the project's document rules.",
    '- When a tool returns an error, fix the call.',
    '- Finish with done and a summary of one to three sentences.',
  ].join('\n');
}

/** The five document tools plus the shared `done` tool. */
function documentTools(
  deps: ActionRunnerDeps,
  ctx: ActionRunContext,
  record: SecondaryRecord,
): SecondaryTool[] {
  return [
    {
      spec: {
        name: 'list_documents',
        description: 'List the project documents in the workspace catalogue. Optionally filter to one project.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'A registered project id to filter the catalogue by.' },
          },
          additionalProperties: false,
        },
      },
      async run(args) {
        const project = optionalStringArg(args, 'project');
        const catalog = deps.files.listDocuments();
        const documents = project === undefined
          ? catalog
          : catalog.filter((entry) => {
            const owner = ctx.projects.find((candidate) => candidate.id === project);
            return owner !== undefined && entry.path.startsWith(`${owner.workspaceDir}/docs/`);
          });
        return jsonResult({ documents });
      },
    },
    {
      spec: {
        name: 'read_document',
        description: 'Read one document. Returns its content and a content version.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The workspace-relative path of the document.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const path = stringArg(args, 'path');
        const file = deps.files.read(path);
        if (file === undefined) return errorResult('not_found', `Document not found: ${path}`);
        return jsonResult({ path, content: file.content, version: contentVersion(file.content) });
      },
    },
    {
      spec: {
        name: 'create_document',
        description: 'Create one new document. The path must be a new file under projects/<project>/docs/.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The workspace-relative path of the new document.' },
            content: { type: 'string', description: 'The full Markdown content of the new document.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const path = stringArg(args, 'path');
        const content = stringArg(args, 'content');
        const written = await deps.host.writeDocument({ path, content });
        recordWrite(ctx, record, path, content, written);
        return jsonResult(written);
      },
    },
    {
      spec: {
        name: 'edit_document',
        description: 'Apply local edits to an existing document. Each edit replaces one unique old text with new text.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The workspace-relative path of the document.' },
            edits: {
              type: 'array',
              description: 'The edits to apply, in order.',
              items: {
                type: 'object',
                properties: {
                  old: { type: 'string', description: 'The exact existing text to replace; it must occur exactly once.' },
                  new: { type: 'string', description: 'The replacement text.' },
                },
                required: ['old', 'new'],
                additionalProperties: false,
              },
            },
          },
          required: ['path', 'edits'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const path = stringArg(args, 'path');
        const edits = editListArg(args, 'edits');
        const file = deps.files.read(path);
        if (file === undefined) return errorResult('not_found', `Document not found: ${path}`);
        const read = file.content;
        let content = read;
        for (const edit of edits) {
          const count = occurrences(content, edit.old);
          if (count === 0) return errorResult('not_found', `edit old text was not found: ${excerpt(edit.old)}`);
          if (count > 1) return errorResult('not_unique', `edit old text appears ${count} times: ${excerpt(edit.old)}`);
          // A function replacement keeps `$` sequences in the new text literal.
          content = content.replace(edit.old, () => edit.new);
        }
        const written = await deps.host.writeDocument({ path, content, expectedContent: read });
        recordWrite(ctx, record, path, content, written);
        return jsonResult(written);
      },
    },
    {
      spec: {
        name: 'rewrite_document',
        description: 'Replace an existing document with new full content.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The workspace-relative path of the document.' },
            content: { type: 'string', description: 'The complete new Markdown content of the document.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      async run(args) {
        const path = stringArg(args, 'path');
        const content = stringArg(args, 'content');
        const file = deps.files.read(path);
        if (file === undefined) return errorResult('not_found', `Document not found: ${path}`);
        const written = await deps.host.writeDocument({ path, content, expectedContent: file.content });
        recordWrite(ctx, record, path, content, written);
        return jsonResult(written);
      },
    },
  ];
}

/** The host's write result, as far as this session records it. */
interface DocumentWriteResult {
  path: string;
  change: 'created' | 'updated';
  version: string;
}

/** Record a successful write as a workspace update and a `doc.content` draft. */
function recordWrite(
  ctx: ActionRunContext,
  record: SecondaryRecord,
  path: string,
  content: string,
  written: DocumentWriteResult,
): void {
  recordWorkspaceUpdate(record, ctx, {
    scope: 'document',
    target: path,
    change: written.change,
    version: written.version,
  });
  const draft = makeDocumentDraft(
    { path, title: documentTitle(path, content), content },
    ctx.currentEvents(),
    { turn: ctx.turn, cycle: ctx.cycle, actionId: ctx.actionId, source: 'write' },
  );
  if (draft !== undefined) record.documents.push(draft);
}

/** Read a list of `{ old, new }` edits with both texts required and non-empty. */
function editListArg(args: Record<string, unknown>, name: string): { old: string; new: string }[] {
  const value = args[name];
  if (!Array.isArray(value)) throw new ToolArgumentError(`"${name}" must be an array of edits.`);
  return value.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ToolArgumentError(`"${name}[${index}]" must be an object with old and new.`);
    }
    const edit = raw as { old?: unknown; new?: unknown };
    if (typeof edit.old !== 'string' || edit.old === '') {
      throw new ToolArgumentError(`"${name}[${index}].old" must be a non-empty string.`);
    }
    if (typeof edit.new !== 'string') {
      throw new ToolArgumentError(`"${name}[${index}].new" must be a string.`);
    }
    return { old: edit.old, new: edit.new };
  });
}

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A short, single-line excerpt of an edit target for an error message. */
function excerpt(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length <= 80 ? line : `${line.slice(0, 77)}...`;
}

/** The document title: its first `# ` heading, or the path when it has none. */
function documentTitle(path: string, content: string): string {
  return /^# (.+)$/m.exec(content)?.[1]?.trim() ?? path;
}
