/**
 * The search auxiliary task: read workspace material by intent or exact
 * path. It resolves the intent's path tokens against globally readable
 * workspace documents/instructions and against the session's files, asks the
 * document retriever which documents to read, and returns the reads as
 * deferred drafts.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { platform } from 'node:os';

import {
  bindCatalog,
  createLoopRecord,
  getAuxiliaryDefinition,
  protocolTools,
  runAuxiliaryLoop,
  toActionOutcome,
  type AuxiliaryRecordPort,
  type MethodCatalogPort,
  type MethodInfo,
} from '@wrenyard/agent-loop';

import { collectSessionFiles, type LedgerEvent, type LedgerEventDraft } from '../ledger/store.ts';
import { makeDocumentDraft } from '../documents.ts';
import { escapeAttr, escapeBody, renderEventsBlock, tag } from '../context/render.ts';
import { fail, isObject, renderRunFiles } from './shared.ts';
import { messageOf } from '../errors.ts';
import type { DocCatalogEntry } from '../workspace.ts';
import type { SessionFile } from '../media.ts';
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

function docCategory(path: string): string {
  const match = /^(.*\/docs\/[^/]+)\//u.exec(path);
  return match ? match[1]! : path.slice(0, path.lastIndexOf('/'));
}

function newestSpec(catalog: readonly DocCatalogEntry[]): string | undefined {
  let best: DocCatalogEntry | undefined;
  for (const entry of catalog) {
    if (!/\/docs\/specs\//u.test(entry.path)) continue;
    if (/deprecated|废弃/iu.test(entry.status)) continue;
    if (best === undefined || entry.updated > best.updated) best = entry;
  }
  return best?.path;
}

export function buildDocSearchUser(input: DocSearchViewInput): string {
  const groups = new Map<string, DocCatalogEntry[]>();
  for (const entry of input.catalog) {
    const key = docCategory(entry.path);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const defaultSpec = newestSpec(input.catalog);
  const catalog = [...groups.keys()].sort().map((key) => {
    const rows = groups.get(key)!.slice().sort((a, b) => a.path.localeCompare(b.path)).map((entry) => {
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      const isDefault = entry.path === defaultSpec ? ' default=true' : '';
      return escapeBody(
        `- path=${entry.path} name=${name} title=${entry.title} status=${entry.status} updated=${entry.updated} length=${entry.length}${isDefault}`,
      );
    }).join('\n');
    return `<group path="${escapeAttr(key)}">\n${rows}\n</group>`;
  }).join('\n');
  const loaded = input.loadedPaths.length === 0
    ? '(none)'
    : input.loadedPaths.map((path) => `- ${escapeBody(path)}`).join('\n');
  const hints = input.directoryHints ?? [];
  const hintLines = hints.map((hint) => `- ${escapeBody(hint)}`).join('\n');
  const body = [
    tag('catalog', [], groups.size === 0 ? '(none)' : catalog),
    ...(hints.length === 0 ? [] : [tag('directory-hints', [], hintLines)]),
    tag('loaded-paths', [], loaded),
    tag('intent', [], escapeBody(input.intent)),
  ].join('\n');
  return tag('wy-doc-search', [], body);
}

const SEARCH_PICK_METHOD: MethodInfo = {
  name: 'search.pick',
  description: 'Record the final document picks for this search intent.',
  params: {
    type: 'object',
    properties: {
      understanding: { type: 'string' },
      picks: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['path', 'reason'],
        },
      },
      near: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['path', 'reason'],
        },
      },
    },
    required: ['understanding', 'picks', 'near'],
  },
};

type SearchPickState = {
  understanding: string;
  picks: { path: string; reason: string }[];
  near: { path: string; title: string; reason: string }[];
  notes: string[];
};

function createSearchCatalog(
  host: ActionWorkflowDeps['host'],
  catalog: readonly DocCatalogEntry[],
  state: SearchPickState,
): MethodCatalogPort {
  const remote = bindCatalog(host, 'search');
  const local = new Map([[SEARCH_PICK_METHOD.name, SEARCH_PICK_METHOD]]);
  const known = new Map(catalog.map((entry) => [entry.path, entry]));
  return {
    async methods(names) {
      const out: MethodInfo[] = [];
      const delegated: string[] = [];
      for (const name of names) {
        const info = local.get(name);
        if (info !== undefined) out.push(info);
        else delegated.push(name);
      }
      if (delegated.length > 0) out.push(...await remote.methods(delegated));
      return out;
    },
    async call(method, params, context) {
      if (method === 'search.pick') {
        if (!isObject(params) || typeof params.understanding !== 'string'
          || !Array.isArray(params.picks) || !Array.isArray(params.near)) {
          throw Object.assign(new Error('search.pick has an invalid shape'), { code: 'validation_failed' });
        }
        state.understanding = params.understanding;
        state.picks = [];
        state.near = [];
        for (const raw of params.picks) {
          if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.reason !== 'string') {
            throw Object.assign(new Error('search.pick entry has an invalid shape'), { code: 'validation_failed' });
          }
          const entry = known.get(raw.path);
          if (!entry) {
            state.notes.push(`discarded unknown catalog path: ${raw.path}`);
            continue;
          }
          state.picks.push({ path: entry.path, reason: raw.reason });
          if (state.picks.length >= 3) break;
        }
        for (const raw of params.near) {
          if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.reason !== 'string') {
            throw Object.assign(new Error('search.pick near entry has an invalid shape'), { code: 'validation_failed' });
          }
          const entry = known.get(raw.path);
          if (!entry) {
            state.notes.push(`discarded unknown catalog path: ${raw.path}`);
            continue;
          }
          state.near.push({ path: entry.path, title: entry.title, reason: raw.reason });
          if (state.near.length >= 5) break;
        }
        return { ok: true };
      }
      return remote.call(method, params, context);
    },
  };
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

  let picks: { path: string; reason: string }[] = [];
  if (needSearch) {
    const pickState: SearchPickState = { understanding: '', picks: [], near: [], notes: [] };
    const record: AuxiliaryRecordPort = {
      ...createLoopRecord(),
      helpers: { messageOf, escapeBody, renderEventsBlock },
    };
    record.observeToolResult = () => {
      record.observations.push('search.pick');
    };
    const definition = getAuxiliaryDefinition('search');
    if (definition === undefined) return fail(withMissing('search auxiliary definition is missing', missing));
    const loopDeps = {
      host: createSearchCatalog(deps.host, catalog, pickState),
      calls: deps.calls,
      helpers: record.helpers,
    };
    const tools = await protocolTools(
      loopDeps.host,
      record.helpers,
      ctx,
      record,
      definition.methods,
      definition.effects,
    );
    const loopResult = await runAuxiliaryLoop({
      deps: loopDeps,
      ctx,
      role: 'search',
      system: definition.buildSystemPrompt({ documentRules: () => '' }),
      user: buildDocSearchUser({ catalog, loadedPaths: [...loadedDocs], intent: action.intent, directoryHints }),
      tools,
      maxRounds: definition.maxRounds,
      spanIdPrefix: definition.spanIdPrefix,
      record,
    });
    const searchOutcome = toActionOutcome(loopResult, record);
    if (searchOutcome.status !== 'done') {
      return fail(withMissing(searchOutcome.result, missing));
    }
    if (pickState.picks.length === 0 && pickState.understanding === '') {
      return fail(withMissing('search did not record any document picks', missing));
    }
    notes.push(...pickState.notes);
    picks = pickState.picks;
    const nearTitles = pickState.near.map((near) => `${near.path} (${near.title})`);
    if (nearTitles.length > 0) notes.push(`near: ${nearTitles.join(', ')}`);
    deferred.push({
      type: 'document.found',
      turn: ctx.turn,
      step: ctx.step,
      parent: ctx.actionId,
      understanding: pickState.understanding,
      picks: pickState.picks.map((pick) => ({
        path: pick.path,
        title: catalog.find((entry) => entry.path === pick.path)?.title ?? pick.path,
        reason: pick.reason,
      })),
      near: pickState.near.map((near) => ({ path: near.path, title: near.title, reason: near.reason })),
      notes: pickState.notes,
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
