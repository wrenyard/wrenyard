/**
 * The search secondary session: read workspace material by intent or exact
 * path. It resolves the intent's path tokens against the session's document
 * catalog and files, asks the document retriever which documents to read, and
 * returns the reads as deferred drafts.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { collectSessionFiles, type LedgerEvent, type LedgerEventDraft } from '../../ledger.ts';
import { makeDocumentDraft } from '../../documents.ts';
import { escapeAttr, escapeBody, tag, twoPartView } from '../../render.ts';
import { fail, isObject, renderRunFiles } from '../shared.ts';
import { messageOf } from '../../errors.ts';
import type { DocCatalogEntry } from '../../workspace.ts';
import type { SessionFile } from '../../media.ts';
import type { BuiltView } from '../../ports.ts';
import type {
  ActionExecutionOutcome,
  ActionProjectInfo,
  ActionRunContext,
  ActionWorkflowDeps,
  ParsedAction,
} from '../index.ts';

// ─── Document-retriever view ────────────────────────────────────────────────

const DOC_SEARCH_SYSTEM = `<wy-system>
You are the document retriever. Based on the user intent and the loaded paths, pick the documents to read from the document catalog.
Output strict JSON only: {"understanding":"one-sentence understanding of the intent","picks":[{"path":"…","reason":"…"}],"near":[{"path":"…","reason":"…"}]}
Rules:
- understanding is required. picks has at most 3 items and near at most 5 items.
- path must come from the given catalog. Unknown paths are dropped.
- Do not pick paths that are already in context.
- near only gives paths as hints. Their bodies are not read.
- Pick report or handoff documents only when the intent is about progress or results.
- A recent spec that is not deprecated is an acceptable default pick.
- Output only JSON, with no code fence or extra explanation.
</wy-system>
<wy-role>
Document retriever: pick workspace document paths only. Never write document bodies.
</wy-role>`;

export interface DocSearchViewInput {
  catalog: DocCatalogEntry[];
  loadedPaths: string[];
  intent: string;
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

export function buildDocSearch(input: DocSearchViewInput): BuiltView {
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
  const body = [
    tag('catalog', [], groups.size === 0 ? '(none)' : catalog),
    tag('loaded-paths', [], loaded),
    tag('intent', [], escapeBody(input.intent)),
  ].join('\n');
  return twoPartView(DOC_SEARCH_SYSTEM, tag('wy-doc-search', [], body), 'wy-doc-search');
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
  for (const event of events) if (event.type === 'doc.content') loadedDocs.add(event.path);

  const deferred: LedgerEventDraft[] = [];
  const loaded: string[] = [];
  const already: string[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];
  const notes: string[] = [];
  const claimed = new Set<string>();

  const runIds = sessionRunIds(events);
  let listed = false;
  let loose = false;
  const tokens = extractPathTokens(action.intent);
  const exact: { path: string; kind: 'file' | 'doc'; taskRunId?: string }[] = [];
  for (const token of tokens) {
    const hit = classifyPath(deps, token, catalog, sessionFiles, runIds, ctx);
    if (hit === undefined) {
      // An existing path that is not a document is reported, not searched for.
      const absolute = resolve(ctx.workspaceRoot, token);
      const run = deps.fileStore.runOf(absolute, runIds);
      if (run !== undefined && statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true) {
        notes.push(renderRunFiles(await deps.fileStore.listRunFiles(run)));
        listed = true;
      } else if (existsSync(absolute)) unsupported.push(absolute);
      // Only a Markdown or absolute path is a path the model meant to read;
      // any other slash-separated word is ordinary intent text.
      else if (token.endsWith('.md') || token.startsWith('/')) missing.push(token);
      else loose = true;
      continue;
    }
    if (!exact.some((item) => item.path === hit.path)) exact.push(hit);
  }

  const residual = residualText(action.intent, tokens);
  // A written path that resolves is read directly; the words around it are a
  // label, not a search request.
  const needSearch = (exact.length === 0 && unsupported.length === 0 && !listed) || missing.length > 0 || loose;
  if (!needSearch && residual !== '') notes.push('Only the stated paths were read. For other documents, send a separate read without paths.');

  let picks: { path: string; reason: string }[] = [];
  if (needSearch) {
    const view = buildDocSearch({ catalog, loadedPaths: [...loadedDocs], intent: action.intent });
    const outcome = await runDocSearchCall(deps, view, ctx);
    if (!outcome.ok) return fail(`doc-search call failed: ${outcome.error}`);
    const parsed = parseDocSearch(outcome.text, catalog);
    if (!parsed.ok) return fail(parsed.reason);
    notes.push(...parsed.notes);
    picks = parsed.picks.filter((pick) => !loadedDocs.has(pick.path));
    const nearTitles = parsed.near.map((near) => `${near.path} (${near.title})`);
    if (nearTitles.length > 0) notes.push(`near: ${nearTitles.join(', ')}`);
    // First doc-search draft, before any picked document content.
    deferred.push({
      type: 'doc.search',
      turn: ctx.turn,
      cycle: ctx.cycle,
      actionId: ctx.actionId,
      understanding: parsed.understanding,
      picks: parsed.picks.map((pick) => ({
        path: pick.path,
        title: catalog.find((entry) => entry.path === pick.path)?.title ?? pick.path,
        reason: pick.reason,
      })),
      near: parsed.near.map((near) => ({ path: near.path, title: near.title, reason: near.reason })),
      notes: parsed.notes,
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
      cycle: ctx.cycle,
      actionId: ctx.actionId,
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
  if (unsupported.length > 0) sections.push(`Exists but is not a document or a file of this session, not read: ${unsupported.join(', ')}`);
  if (missing.length > 0) sections.push(`missing: ${missing.join(', ')}`);
  if (notes.length > 0) sections.push(...notes);
  if (sections.length === 0) sections.push('no paths were processed');
  return { status: failed ? 'failed' : 'done', result: sections.join('\n'), deferred };
}

/** One `doc-search` model call; a failure is returned, not thrown. */
async function runDocSearchCall(
  deps: ActionWorkflowDeps,
  view: BuiltView,
  ctx: ActionRunContext,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const callId = deps.nextCallId();
  try {
    const result = await deps.calls.run({
      callId,
      role: 'search',
      turn: ctx.turn,
      cycle: ctx.cycle,
      messages: view.messages,
      layers: view.layers,
      signal: ctx.signal,
    });
    return { ok: true, text: result.text };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
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
    type: 'files',
    turn: ctx.turn,
    cycle: ctx.cycle,
    source: 'read',
    files: [prepared],
    actionId: ctx.actionId,
  });
  loaded.push(path);
}

/**
 * Resolve one intent token to an allowed, registered path: a session file, a
 * file one of this session's runs left, or a project document.
 */
function classifyPath(
  deps: ActionWorkflowDeps,
  raw: string,
  catalog: readonly DocCatalogEntry[],
  sessionFiles: readonly { path: string }[],
  runIds: ReadonlySet<string>,
  ctx: ActionRunContext,
): { path: string; kind: 'file' | 'doc'; taskRunId?: string } | undefined {
  if (sessionFiles.some((file) => file.path === raw)) return { path: raw, kind: 'file' };
  if (raw.startsWith('/')) {
    const run = deps.fileStore.runOf(raw, runIds);
    if (run !== undefined && statSync(raw, { throwIfNoEntry: false })?.isFile() === true) {
      return { path: raw, kind: 'file', taskRunId: run };
    }
  }
  const prefix = `${ctx.workspaceRoot.replace(/\/$/u, '')}/`;
  const relative = raw.startsWith('/') ? (raw.startsWith(prefix) ? raw.slice(prefix.length) : undefined) : raw;
  const doc = relative === undefined ? undefined : catalog.find((entry) => entry.path === relative);
  return doc ? { path: doc.path, kind: 'doc' } : undefined;
}

/** Queue the project instruction chain as full `doc.content` drafts. */
async function recallProjectInstructions(
  deps: ActionWorkflowDeps,
  docPath: string,
  ctx: ActionRunContext,
  events: readonly LedgerEvent[],
  deferred: LedgerEventDraft[],
): Promise<void> {
  const project = projectForDocPath(ctx.projects, docPath);
  if (!project) return;
  const directory = docPath.endsWith('/AGENTS.md') ? docPath.slice(0, -10) : project.workspaceDir;
  for (const instructionPath of deps.files.instructionChain(directory, docPath)) {
    if (ctx.signal.aborted) return;
    const file = deps.files.read(instructionPath);
    if (!file) continue;
    const draft = makeDocumentDraft(file, events, {
      turn: ctx.turn,
      cycle: ctx.cycle,
      actionId: ctx.actionId,
      source: 'project-instructions',
    });
    if (draft !== undefined) deferred.push(draft);
  }
}

// ─── Doc-search output parsing ──────────────────────────────────────────────

interface ParsedDocSearch {
  understanding: string;
  picks: { path: string; reason: string }[];
  near: { path: string; title: string; reason: string }[];
  notes: string[];
}

function parseDocSearch(
  text: string,
  catalog: readonly DocCatalogEntry[],
): ({ ok: true } & ParsedDocSearch) | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (error) {
    return { ok: false, reason: `doc-search output is not valid JSON: ${messageOf(error)}` };
  }
  if (!isObject(value)) return { ok: false, reason: 'doc-search output must be a JSON object' };
  if (typeof value.understanding !== 'string') {
    return { ok: false, reason: 'doc-search output is missing understanding' };
  }
  if (!Array.isArray(value.picks) || !Array.isArray(value.near)) {
    return { ok: false, reason: 'doc-search output must contain picks and near arrays' };
  }
  const notes: string[] = [];
  const known = new Map(catalog.map((entry) => [entry.path, entry]));
  const picks: { path: string; reason: string }[] = [];
  for (const raw of value.picks) {
    if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.reason !== 'string') {
      return { ok: false, reason: 'doc-search pick has an invalid shape' };
    }
    const entry = known.get(raw.path);
    if (!entry) {
      notes.push(`discarded unknown catalog path: ${raw.path}`);
      continue;
    }
    picks.push({ path: entry.path, reason: raw.reason });
    if (picks.length >= 3) break;
  }
  const near: { path: string; title: string; reason: string }[] = [];
  for (const raw of value.near) {
    if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.reason !== 'string') {
      return { ok: false, reason: 'doc-search near entry has an invalid shape' };
    }
    const entry = known.get(raw.path);
    if (!entry) {
      notes.push(`discarded unknown catalog path: ${raw.path}`);
      continue;
    }
    near.push({ path: entry.path, title: entry.title, reason: raw.reason });
    if (near.length >= 5) break;
  }
  return { ok: true, understanding: value.understanding, picks, near, notes };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Task runs this session started or received files from. */
function sessionRunIds(events: readonly LedgerEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if ((event.type === 'action.started' || event.type === 'files') && event.taskRunId !== undefined) ids.add(event.taskRunId);
  }
  return ids;
}

/** Path-like tokens in an intent, used for exact-path resolution. */
function extractPathTokens(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_./-]+\.md|[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+/gu) ?? [];
  const tokens = matches.map((token) => token.replace(/[),.;:!?]+$/u, '')).filter((token) => token !== '');
  return [...new Set(tokens)];
}

/** The intent text left once the path tokens, quotes and punctuation are removed. */
function residualText(text: string, tokens: readonly string[]): string {
  let rest = text;
  for (const token of tokens) rest = rest.split(token).join(' ');
  return rest.replace(/["'`>{}[\]]/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Latest `files` event row for one path, if the path is ledger-registered. */
function latestSessionFile(events: readonly LedgerEvent[], path: string): SessionFile | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'files') continue;
    const file = event.files.find((candidate) => candidate.path === path);
    if (file) return file;
  }
  return undefined;
}

/** The most specific registered project that owns `docPath`, if any. */
function projectForDocPath(projects: readonly ActionProjectInfo[], docPath: string): ActionProjectInfo | undefined {
  const matches = projects.filter((project) => docPath.startsWith(`${project.workspaceDir}/`)
    || (docPath.endsWith('/AGENTS.md') && project.workspaceDir.startsWith(`${docPath.slice(0, -10)}/`)));
  if (matches.length === 0) return undefined;
  return matches.reduce((longest, candidate) =>
    candidate.workspaceDir.length > longest.workspaceDir.length ? candidate : longest);
}
