/**
 * The search auxiliary task: read workspace material by intent or exact
 * path. It resolves the intent's path tokens against globally readable
 * workspace documents/instructions and against the session's files, asks the
 * document retriever in one forced `pick` call which catalog documents to
 * read, and returns the reads as deferred drafts.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { platform } from 'node:os';

import { collectSessionFiles, type LedgerEvent, type LedgerEventDraft } from '../ledger/store.ts';
import { makeDocumentDraft } from '../documents.ts';
import { escapeBody, tag } from '../context/render.ts';
import { fail, isObject, renderRunFiles } from './shared.ts';
import { messageOf } from '../errors.ts';
import type { DocCatalogEntry } from '../workspace.ts';
import type { SessionFile } from '../media.ts';
import type { ToolCall, ToolSpec } from '../transport/index.ts';
import type {
  ActionExecutionOutcome,
  ActionRunContext,
  ActionWorkflowDeps,
  ParsedAction,
} from '../reasoning/actions.ts';

export interface DocSearchViewInput {
  catalog: DocCatalogEntry[];
  loadedPaths: string[];
  intent: string;
  /** Workspace-relative document directories the intent points to. */
  directoryHints?: string[];
}

/**
 * The catalog with one-based ids in catalog order, plus the intent. The
 * retriever answers with ids, so a pick can never name a path outside it.
 */
export function buildDocSearchUser(input: DocSearchViewInput): string {
  const rows = input.catalog.map((entry, index) =>
    escapeBody(`[${index + 1}] ${entry.path} | ${entry.title} | ${entry.status || '-'} | ${entry.updated || '-'}`)).join('\n');
  const loaded = input.loadedPaths.length === 0
    ? '(none)'
    : input.loadedPaths.map((path) => `- ${escapeBody(path)}`).join('\n');
  const hints = input.directoryHints ?? [];
  const hintLines = hints.map((hint) => `- ${escapeBody(hint)}`).join('\n');
  const body = [
    tag('catalog', [], rows === '' ? '(none)' : rows),
    ...(hints.length === 0 ? [] : [tag('directory-hints', [], hintLines)]),
    tag('loaded-paths', [], loaded),
    tag('intent', [], escapeBody(input.intent)),
  ].join('\n');
  return tag('wy-doc-search', [], body);
}

/**
 * Output-token allowance for the one pick call. Reasoning counts against it:
 * HY3 picks spent up to about 1,400 tokens and fail outright below 512.
 */
const SEARCH_MAX_TOKENS = 3072;

const SEARCH_SYSTEM = [
  'You choose workspace documents for a Wrenyard session to read.',
  'The catalog lists every project document with a numeric id. Choose at most three ids whose documents the intent needs, most relevant first, judging only by path, title, status and date.',
  'Do not answer the intent, derive values or locate source code: the session reads the chosen documents itself.',
  'Prefer current documents over deprecated ones, and the newer one when titles overlap.',
  'Call pick exactly once. Use an empty ids list when nothing fits.',
].join('\n');

/** The one tool the retriever declares; calling it ends the search. */
const PICK_TOOL: ToolSpec = {
  name: 'pick',
  description: 'Choose the catalog documents to read. Calling it ends the search.',
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        maxItems: 3,
        items: { type: 'integer' },
        description: 'Catalog ids to read, most relevant first. Empty when nothing fits.',
      },
      understanding: { type: 'string', description: 'One sentence: what the intent is looking for.' },
    },
    required: ['ids', 'understanding'],
    additionalProperties: false,
  },
};

/**
 * Read the pick: exactly one `pick` call with integer ids. A provider that
 * ignores a forced tool choice may answer in prose; its `[n]` ids are read
 * from the text instead. Unknown and repeated ids are dropped.
 */
function readPick(
  calls: readonly ToolCall[],
  text: string,
  proseFallback: boolean,
  catalog: readonly DocCatalogEntry[],
): { understanding: string; paths: string[] } | undefined {
  let ids: unknown[];
  let understanding = '';
  const picks = calls.filter((call) => call.name === PICK_TOOL.name);
  if (picks.length === 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(picks[0]!.arguments);
    } catch {
      return undefined;
    }
    if (!isObject(parsed) || !Array.isArray(parsed.ids)) return undefined;
    ids = parsed.ids;
    if (typeof parsed.understanding === 'string') understanding = parsed.understanding;
  } else if (calls.length === 0 && proseFallback && text.trim() !== '') {
    ids = [...text.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
  } else {
    return undefined;
  }
  const paths: string[] = [];
  for (const id of ids) {
    const path = Number.isInteger(id) ? catalog[(id as number) - 1]?.path : undefined;
    if (path !== undefined && !paths.includes(path)) paths.push(path);
    if (paths.length >= 3) break;
  }
  return { understanding, paths };
}

// ─── Read action ────────────────────────────────────────────────────────────

/** Start one search session for a parsed read action. */
export async function runSearchAction(
  deps: ActionWorkflowDeps,
  action: ParsedAction,
  ctx: ActionRunContext,
): Promise<ActionExecutionOutcome> {
  const events = ctx.currentEvents();
  const catalog = deps.files.listDocuments();
  const sessionFiles = collectSessionFiles(events);
  const loadedDocs = new Set<string>();
  for (const event of events) if (event.type === 'document.content') loadedDocs.add(event.path);

  const deferred: LedgerEventDraft[] = [];
  const loaded: string[] = [];
  const already: string[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];
  const notes: string[] = [];
  const claimed = new Set<string>();
  const directoryHints: string[] = [];

  const runIds = sessionRunIds(events);
  let listed = false;
  const tokens = extractPathTokens(action.intent);
  const exact: { path: string; kind: 'file' | 'doc'; taskRunId?: string }[] = [];
  for (const token of tokens) {
    const hit = await classifyPath(deps, token, catalog, sessionFiles, runIds, ctx);
    if (hit === undefined) {
      // A token that names a live document directory is a search hint, not an
      // unsupported session file.
      const hint = documentDirectoryHint(catalog, token, ctx.workspaceRoot);
      if (hint !== undefined) {
        directoryHints.push(hint);
        continue;
      }
      // Explicit filesystem paths fail as paths; they are never reinterpreted
      // as document-search intent just because they are not Markdown files.
      const absolute = isAbsolute(token) ? resolve(token) : resolve(ctx.workspaceRoot, token);
      const run = await deps.fileStore.runOf(absolute, runIds);
      if (run !== undefined && statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true) {
        notes.push(renderRunFiles(await deps.fileStore.listRunFiles(run)));
        listed = true;
      } else if (existsSync(absolute)) unsupported.push(absolute);
      else if (isExplicitPathToken(token)) missing.push(token);
      continue;
    }
    if (!exact.some((item) => item.path === hit.path)) exact.push(hit);
  }

  const residual = residualText(action.intent, tokens);
  // A written path that resolves is read directly; the words around it are a
  // label, not a search request. A document-directory hint is a search request.
  const needSearch = tokens.length === 0 || directoryHints.length > 0;
  if (!needSearch && residual !== '') notes.push('Only the stated paths were read. For other documents, send a separate read without paths.');

  if (needSearch) {
    const system = SEARCH_SYSTEM;
    const user = buildDocSearchUser({ catalog, loadedPaths: [...loadedDocs], intent: action.intent, directoryHints });
    let pick: ReturnType<typeof readPick>;
    try {
      const result = await deps.calls.run({
        spanId: `${ctx.actionId}.search`,
        parent: ctx.actionId,
        role: 'search',
        turn: ctx.turn,
        step: ctx.step,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        layers: { 'wy-system': system.length, 'wy-ctx': user.length },
        maxTokens: SEARCH_MAX_TOKENS,
        tools: [PICK_TOOL],
        toolChoice: { name: PICK_TOOL.name },
        signal: ctx.signal,
      });
      const provider = result.route?.provider;
      const proseFallback = provider !== undefined && deps.host.resolveInferenceProvider(provider)?.ignoresForcedToolChoice === true;
      pick = readPick(result.toolCalls, result.text, proseFallback, catalog);
    } catch (error) {
      return fail(withMissing(`The model call failed: ${messageOf(error)}`, missing));
    }
    if (pick === undefined) return fail(withMissing('search did not return a valid pick call', missing));
    if (pick.paths.length === 0) notes.push('search found no matching document');
    deferred.push({
      type: 'document.found',
      turn: ctx.turn,
      step: ctx.step,
      parent: ctx.actionId,
      understanding: pick.understanding,
      picks: pick.paths.map((path) => ({
        path,
        title: catalog.find((entry) => entry.path === path)?.title ?? path,
        reason: '',
      })),
      near: [],
      notes: [],
    });
    for (const path of pick.paths) {
      if (!exact.some((item) => item.path === path)) exact.push({ path, kind: 'doc' });
    }
  }

  for (const item of exact) {
    if (ctx.signal.aborted) break;
    if (claimed.has(item.path)) continue;
    claimed.add(item.path);
    if (item.kind === 'file') {
      await readSessionFile(deps, item.path, item.taskRunId, events, ctx, deferred, loaded, already, missing);
      continue;
    }
    const file = deps.files.read(item.path);
    if (!file) {
      missing.push(item.path);
      continue;
    }
    await recallProjectInstructions(deps, item.path, ctx, events, deferred);
    const draft = makeDocumentDraft(file, events, {
      turn: ctx.turn,
      step: ctx.step,
      parent: ctx.actionId,
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
  if (already.length > 0) sections.push(`Already in context, unchanged: ${already.join(', ')}`);
  if (unsupported.length > 0) sections.push(`Exists but is not a readable workspace document or a session attachment, not read: ${unsupported.join(', ')}`);
  if (missing.length > 0) sections.push(`missing: ${missing.join(', ')}`);
  if (notes.length > 0) sections.push(...notes);
  if (sections.length === 0) sections.push('no paths were processed');
  return { status: failed ? 'failed' : 'done', result: sections.join('\n'), deferred };
}

function withMissing(message: string, missing: readonly string[]): string {
  return missing.length === 0 ? message : `${message}\nmissing: ${missing.join(', ')}`;
}

async function readSessionFile(
  deps: ActionWorkflowDeps,
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
    prepared = await deps.fileStore.prepareFile(path, {
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
    type: 'files.attached',
    turn: ctx.turn,
    step: ctx.step,
    source: 'read',
    files: [prepared],
    parent: ctx.actionId,
  });
  loaded.push(path);
}

/**
 * Resolve one intent token to a readable path. A valid existing workspace
 * document or instruction is globally readable and is not session-scoped, so it
 * is classified first; a session file and a file one of this session's runs
 * left keep their session or run ownership and stay scoped.
 */
async function classifyPath(
  deps: ActionWorkflowDeps,
  raw: string,
  catalog: readonly DocCatalogEntry[],
  sessionFiles: readonly { path: string }[],
  runIds: ReadonlySet<string>,
  ctx: ActionRunContext,
): Promise<{ path: string; kind: 'file' | 'doc'; taskRunId?: string } | undefined> {
  const relative = workspaceRelative(ctx.workspaceRoot, raw);
  if (relative !== undefined && relative !== '') {
    const doc = resolveWorkspaceDocument(deps, relative, catalog);
    if (doc !== undefined) return { path: doc, kind: 'doc' };
  }
  const sessionFile = sessionFiles.find((file) => sessionFileMatches(file.path, raw, ctx.sessionId));
  if (sessionFile) return { path: sessionFile.path, kind: 'file' };
  if (isAbsolute(raw)) {
    const absolute = resolve(raw);
    const run = await deps.fileStore.runOf(absolute, runIds);
    if (run !== undefined && statSync(absolute, { throwIfNoEntry: false })?.isFile() === true) {
      return { path: absolute, kind: 'file', taskRunId: run };
    }
  }
  return undefined;
}

/**
 * A validated workspace document or instruction path. The path must pass the
 * files-port scope check as kind `doc` and exist on disk; catalog membership is
 * not required, so a document is readable whether or not this session saw it
 * before. On Windows a differently-cased spelling is resolved through the live
 * catalog without making membership mandatory.
 */
function resolveWorkspaceDocument(
  deps: ActionWorkflowDeps,
  relative: string,
  catalog: readonly DocCatalogEntry[],
): string | undefined {
  const normalized = relative.replace(/\\/gu, '/');
  const checked = deps.files.checkPath(normalized);
  if (checked.ok && checked.kind === 'doc' && deps.files.exists(normalized)) return normalized;
  if (platform() === 'win32') {
    const match = catalog.find((entry) => normalizePath(entry.path) === normalizePath(normalized));
    if (match !== undefined && deps.files.exists(match.path)) return match.path;
  }
  return undefined;
}

/**
 * The workspace-relative spelling of a token, or `undefined` when the token is
 * an absolute path outside the workspace. Relative tokens and Windows
 * separators are normalized; containment keeps traversal outside the workspace
 * from resolving.
 */
function workspaceRelative(workspaceRoot: string, raw: string): string | undefined {
  if (!isAbsolute(raw)) return raw.replace(/\\/gu, '/');
  const root = resolve(workspaceRoot);
  const absolute = resolve(raw);
  const normalizedRoot = normalizePath(root);
  const normalizedAbsolute = normalizePath(absolute);
  if (normalizedAbsolute === normalizedRoot) return '';
  if (!normalizedAbsolute.startsWith(`${normalizedRoot}/`)) return undefined;
  return absolute.slice(root.length + 1).replace(/\\/gu, '/');
}

/**
 * The normalized workspace-relative spelling when a token names a directory
 * that owns live workspace documents: its path is a prefix of a catalogued
 * path. Such a directory is a search hint, not an unsupported session file.
 */
function documentDirectoryHint(
  catalog: readonly DocCatalogEntry[],
  token: string,
  workspaceRoot: string,
): string | undefined {
  const relative = workspaceRelative(workspaceRoot, token);
  if (relative === undefined || relative === '') return undefined;
  const hint = relative.replace(/\/+$/u, '');
  const prefix = `${normalizePath(hint)}/`;
  return catalog.some((entry) => normalizePath(entry.path).startsWith(prefix)) ? hint : undefined;
}

/** Queue the project instruction chain as full `doc.content` drafts. */
async function recallProjectInstructions(
  deps: ActionWorkflowDeps,
  docPath: string,
  ctx: ActionRunContext,
  events: readonly LedgerEvent[],
  deferred: LedgerEventDraft[],
): Promise<void> {
  const directory = projectRootForDocPath(docPath);
  if (directory === undefined) return;
  for (const instructionPath of deps.files.instructionChain(directory, docPath)) {
    if (ctx.signal.aborted) return;
    const file = deps.files.read(instructionPath);
    if (!file) continue;
    const draft = makeDocumentDraft(file, events, {
      turn: ctx.turn,
      step: ctx.step,
      parent: ctx.actionId,
      source: 'project-instructions',
    });
    if (draft !== undefined) deferred.push(draft);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Task runs this session started or received files from. */
function sessionRunIds(events: readonly LedgerEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if ((event.type === 'action.started' || event.type === 'files.attached') && event.taskRunId !== undefined) ids.add(event.taskRunId);
  }
  return ids;
}

/** Path-like tokens in an intent, used for exact-path resolution. */
function extractPathTokens(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z]:[\\/](?:[^\s"'<>|?*]+)|\\\\[^\\/\s]+\\[^\\/\s]+(?:[\\/][^\s"'<>|?*]+)*|\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.\\/-]+\.md|[A-Za-z0-9_.\\/-]*[\\/][A-Za-z0-9_.\\/-]+(?:\.[A-Za-z0-9_-]+)?)/gu) ?? [];
  const tokens = matches.map((token) => token.replace(/[),.;:!?]+$/u, '')).filter((token) => token !== '');
  return [...new Set(tokens)];
}

/** True for path-shaped references, including non-Markdown file extensions. */
function isExplicitPathToken(token: string): boolean {
  return isAbsolute(token) || token.includes('/') || token.includes('\\') || /\.[A-Za-z0-9]{1,12}$/u.test(token);
}

/** Match only a ledger-registered file, by its stored path or current-session alias. */
function sessionFileMatches(registeredPath: string, token: string, sessionId: string): boolean {
  if (normalizePath(registeredPath) === normalizePath(token)) return true;
  const normalizedToken = normalizePath(token);
  const normalizedAlias = normalizePath(`sessions/${sessionId}/files/`);
  const alias = `${normalizedAlias.replace(/\/+$/u, '')}/`;
  if (!normalizedToken.startsWith(alias)) return false;
  const relativeFile = normalizedToken.slice(normalizedAlias.slice(0, 'sessions/'.length).length);
  return normalizePath(registeredPath).endsWith(`/${relativeFile}`);
}

/** Compare path spellings independent of Windows separators and case. */
function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return platform() === 'win32' ? normalized.toLowerCase() : normalized;
}

/** The intent text left once the path tokens, quotes and punctuation are removed. */
function residualText(text: string, tokens: readonly string[]): string {
  let rest = text;
  for (const token of tokens) rest = rest.split(token).join(' ');
  return rest.replace(/["'`>{}[\]]/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Latest `files.attached` event row for one path, if the path is ledger-registered. */
function latestSessionFile(events: readonly LedgerEvent[], path: string): SessionFile | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'files.attached') continue;
    const file = event.files.find((candidate) => candidate.path === path);
    if (file) return file;
  }
  return undefined;
}

/**
 * The `projects/<id>` directory that owns a document or instruction path, if
 * any. The id is the path segments between `projects/` and `/docs/`, so it may
 * be nested such as `gol/arts`; it is derived from the path itself, not from the
 * session snapshot.
 */
function projectRootForDocPath(docPath: string): string | undefined {
  if (docPath.endsWith('/AGENTS.md')) {
    const directory = docPath.slice(0, -10);
    return directory.startsWith('projects/') ? directory : undefined;
  }
  const match = /^projects\/(.+?)\/docs\//u.exec(docPath);
  return match === null ? undefined : `projects/${match[1]}`;
}
