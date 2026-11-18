/**
 * The search auxiliary task: read workspace material by intent or exact path.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { platform } from 'node:os';
import type { ToolCall, ToolSpec, Usage } from '@wrenyard/ai/transport';
import type { TaskUsage } from '@wrenyard/protocol';
import { collectSessionFiles, type LedgerEvent, type LedgerEventDraft } from '../events.ts';
import { makeDocumentDraft } from '../tools/documents.ts';
import { escapeBody, tag } from '../context/render.ts';
import { messageOf } from '../errors.ts';
import type { DocCatalogEntry } from '../tools/workspace-files.ts';
import type { SessionFile } from '../tools/media-store.ts';
import type {
  ActionExecutionOutcome,
  ActionRunContext,
  ActionWorkflowDeps,
  ParsedAction,
} from '../ports.ts';
import { fail, isObject, renderRunFiles } from './shared.ts';

export interface DocSearchViewInput {
  catalog: DocCatalogEntry[];
  loadedPaths: string[];
  intent: string;
  directoryHints?: string[];
}

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

const SEARCH_MAX_TOKENS = 3072;

const SEARCH_SYSTEM = [
  'You choose workspace documents for a Wrenyard session to read.',
  'The catalog lists every project document with a numeric id. Choose at most three ids whose documents the intent needs, most relevant first, judging only by path, title, status and date.',
  'Do not answer the intent, derive values or locate source code: the session reads the chosen documents itself.',
  'Prefer current documents over deprecated ones, and the newer one when titles overlap.',
  'Call pick exactly once. Use an empty ids list when nothing fits.',
].join('\n');

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

function readPick(
  calls: readonly ToolCall[],
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
      const hint = documentDirectoryHint(catalog, token, ctx.workspaceRoot);
      if (hint !== undefined) {
        directoryHints.push(hint);
        continue;
      }
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
  const needSearch = tokens.length === 0 || directoryHints.length > 0;
  if (!needSearch && residual !== '') notes.push('Only the stated paths were read. For other documents, send a separate read without paths.');

  if (needSearch) {
    const system = SEARCH_SYSTEM;
    const user = buildDocSearchUser({ catalog, loadedPaths: [...loadedDocs], intent: action.intent, directoryHints });
    const startedAt = new Date().toISOString();
    let route: { provider?: string; model?: string; effort?: string } | undefined;
    let usage: Usage | undefined;
    const finish = (status: 'done' | 'failed', summary: string): void => {
      deps.calls.recordAuxiliaryRun?.({
        id: ctx.actionId,
        role: 'search',
        callerSessionId: ctx.sessionId,
        status,
        ...(route === undefined ? {} : { route }),
        ...(usage === undefined ? {} : { usage: toTaskUsage(usage) }),
        startedAt,
        finishedAt: new Date().toISOString(),
        summary,
      });
    };
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
      if (result.route !== undefined) route = result.route;
      else if (result.model !== '') route = { model: result.model };
      usage = result.usage;
      pick = readPick(result.toolCalls, catalog);
    } catch (error) {
      const summary = withMissing(`The model call failed: ${messageOf(error)}`, missing);
      finish('failed', summary);
      return fail(summary);
    }
    if (pick === undefined) {
      const summary = withMissing('search did not return a valid pick call', missing);
      finish('failed', summary);
      return fail(summary);
    }
    finish('done', pick.paths.length === 0 ? 'search found no matching document' : `picked: ${pick.paths.join(', ')}`);
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

function sessionRunIds(events: readonly LedgerEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if ((event.type === 'action.started' || event.type === 'files.attached') && event.taskRunId !== undefined) ids.add(event.taskRunId);
  }
  return ids;
}

function extractPathTokens(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z]:[\\/](?:[^\s"'<>|?*]+)|\\\\[^\\/\s]+\\[^\\/\s]+(?:[\\/][^\s"'<>|?*]+)*|\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.\\/-]+\.md|[A-Za-z0-9_.\\/-]*[\\/][A-Za-z0-9_.\\/-]+(?:\.[A-Za-z0-9_-]+)?)/gu) ?? [];
  const tokens = matches.map((token) => token.replace(/[),.;:!?]+$/u, '')).filter((token) => token !== '');
  return [...new Set(tokens)];
}

function isExplicitPathToken(token: string): boolean {
  return isAbsolute(token) || token.includes('/') || token.includes('\\') || /\.[A-Za-z0-9]{1,12}$/u.test(token);
}

function sessionFileMatches(registeredPath: string, token: string, sessionId: string): boolean {
  if (normalizePath(registeredPath) === normalizePath(token)) return true;
  const normalizedToken = normalizePath(token);
  const normalizedAlias = normalizePath(`sessions/${sessionId}/files/`);
  const alias = `${normalizedAlias.replace(/\/+$/u, '')}/`;
  if (!normalizedToken.startsWith(alias)) return false;
  const relativeFile = normalizedToken.slice(normalizedAlias.slice(0, 'sessions/'.length).length);
  return normalizePath(registeredPath).endsWith(`/${relativeFile}`);
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return platform() === 'win32' ? normalized.toLowerCase() : normalized;
}

function residualText(text: string, tokens: readonly string[]): string {
  let rest = text;
  for (const token of tokens) rest = rest.split(token).join(' ');
  return rest.replace(/["'`>{}[\]]/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function latestSessionFile(events: readonly LedgerEvent[], path: string): SessionFile | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'files.attached') continue;
    const file = event.files.find((candidate) => candidate.path === path);
    if (file) return file;
  }
  return undefined;
}

function projectRootForDocPath(docPath: string): string | undefined {
  if (docPath.endsWith('/AGENTS.md')) {
    const directory = docPath.slice(0, -10);
    return directory.startsWith('projects/') ? directory : undefined;
  }
  const match = /^projects\/(.+?)\/docs\//u.exec(docPath);
  return match === null ? undefined : `projects/${match[1]}`;
}
