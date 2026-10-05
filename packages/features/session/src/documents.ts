/**
 * session documents: the current-only document view of the ledger.
 *
 * Documents are reconstructible from `doc.content` events alone. A document
 * enters the context as one `full` event; every later change is one or more
 * unified diff hunks whose base is the content that already entered the
 * context, so the timeline never hides a second full snapshot and nothing has
 * to be migrated.
 *
 * These helpers are pure: they read ledger events and produce event drafts;
 * they never touch disk and never call a model. `makeDocumentDraft` is the only
 * entry point the action layer needs.
 */

import { createHash } from 'node:crypto';

import { diffArrays } from 'diff';

import { estimateTokens } from './calls.ts';
import type { DocContentEvent, LedgerEvent } from './ledger.ts';

/** One `doc.content` event body, without the `seq` / `at` the ledger assigns. */
export type DocContentDraft = Omit<DocContentEvent, 'seq' | 'at'>;

/** How much unchanged context surrounds each changed run of a diff hunk. */
const CONTEXT_LINES = 3;

/** The 8-character content version used by `doc.content` events. */
export function contentVersion(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

export type DocumentChange = Pick<DocContentEvent, 'content' | 'format' | 'base' | 'version'>;

/**
 * Describe the change from `before` to `after`. A new document (`before`
 * undefined) is `full`; an unchanged document yields `undefined`; an update is
 * one or more standards-compliant unified diff hunks against the content that
 * already entered the context.
 */
export function documentChange(
  path: string,
  before: string | undefined,
  after: string,
): DocumentChange | undefined {
  const version = contentVersion(after);
  if (before !== undefined && contentVersion(before) === version) return undefined;
  if (before === undefined) return { content: after, format: 'full', version };
  return { content: unifiedDiff(path, before, after), format: 'diff', base: contentVersion(before), version };
}

/** Ranges and rendered body for an aligned edit or a complete unified hunk. */
interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: string[];
}

/**
 * Align two line arrays with jsdiff and record every changed run in both the
 * old and new line spaces. Unchanged runs only advance the cursors, so they are
 * preserved rather than rebuilt.
 */
function alignEdits(oldLines: readonly string[], newLines: readonly string[]): DiffHunk[] {
  const runs: DiffHunk[] = [];
  let oldPos = 0;
  let newPos = 0;
  for (const part of diffArrays([...oldLines], [...newLines])) {
    const count = part.value.length;
    if (part.added) {
      runs.push({ oldStart: oldPos, oldCount: 0, newStart: newPos, newCount: count, body: part.value.map((line) => `+${line}`) });
      newPos += count;
      continue;
    }
    if (part.removed) {
      runs.push({ oldStart: oldPos, oldCount: count, newStart: newPos, newCount: 0, body: part.value.map((line) => `-${line}`) });
      oldPos += count;
      continue;
    }
    oldPos += count;
    newPos += count;
  }
  return runs;
}

/**
 * Group aligned edits into hunks. Runs separated by more than two context
 * windows stay in separate hunks; runs whose 3-line windows touch or overlap
 * merge into one, as a standard unified diff does.
 */
function buildHunks(runs: readonly DiffHunk[], oldLines: readonly string[], newLength: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let start = 0;
  while (start < runs.length) {
    let end = start;
    while (end + 1 < runs.length) {
      const gap = runs[end + 1]!.oldStart - (runs[end]!.oldStart + runs[end]!.oldCount);
      if (gap > 2 * CONTEXT_LINES) break;
      end += 1;
    }

    const first = runs[start]!;
    const last = runs[end]!;
    const previous = start === 0 ? undefined : runs[start - 1]!;
    const next = end + 1 < runs.length ? runs[end + 1]! : undefined;
    const previousOldEnd = previous === undefined ? 0 : previous.oldStart + previous.oldCount;
    const previousNewEnd = previous === undefined ? 0 : previous.newStart + previous.newCount;
    const nextOldStart = next === undefined ? oldLines.length : next.oldStart;
    const nextNewStart = next === undefined ? newLength : next.newStart;

    const contextBefore = Math.min(CONTEXT_LINES, first.oldStart - previousOldEnd, first.newStart - previousNewEnd);
    const lastOldEnd = last.oldStart + last.oldCount;
    const lastNewEnd = last.newStart + last.newCount;
    const contextAfter = Math.min(CONTEXT_LINES, nextOldStart - lastOldEnd, nextNewStart - lastNewEnd);

    const oldStart = first.oldStart - contextBefore;
    const newStart = first.newStart - contextBefore;
    const body: string[] = [];
    for (let index = oldStart; index < first.oldStart; index += 1) body.push(` ${oldLines[index] ?? ''}`);
    let oldCursor = first.oldStart;
    for (let run = start; run <= end; run += 1) {
      const edit = runs[run]!;
      for (let index = oldCursor; index < edit.oldStart; index += 1) body.push(` ${oldLines[index] ?? ''}`);
      body.push(...edit.body);
      oldCursor = edit.oldStart + edit.oldCount;
    }
    for (let index = lastOldEnd; index < lastOldEnd + contextAfter; index += 1) body.push(` ${oldLines[index] ?? ''}`);

    hunks.push({
      oldStart,
      newStart,
      oldCount: contextBefore + (lastOldEnd - first.oldStart) + contextAfter,
      newCount: contextBefore + (lastNewEnd - first.newStart) + contextAfter,
      body,
    });
    start = end + 1;
  }
  return hunks;
}

/**
 * Build a standards-compliant unified diff of two texts. Lines are split on
 * `\n` (keeping the trailing empty unit) and aligned with jsdiff, so every
 * unchanged internal run stays out of the diff; separated edits become separate
 * hunks while edits within two 3-line context windows merge into one.
 */
function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const hunks = buildHunks(alignEdits(oldLines, newLines), oldLines, newLines.length);

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    lines.push(`@@ -${rangeStart(hunk.oldStart, hunk.oldCount)},${hunk.oldCount} +${rangeStart(hunk.newStart, hunk.newCount)},${hunk.newCount} @@`);
    lines.push(...hunk.body);
  }
  return lines.join('\n');
}

/** Unified-diff line numbers are 1-based, except an empty range uses 0. */
function rangeStart(start: number, count: number): number {
  return count === 0 ? start : start + 1;
}

/**
 * Apply our unified diff (one or more hunks) to `base`. Every hunk is parsed
 * strictly — complete header, monotonic non-overlapping old/new ranges, exact
 * old/new counts, and context/removal lines that match the base — so a
 * malformed, truncated or out-of-order hunk throws instead of silently
 * producing partial content. Historical single-hunk events remain valid.
 */
export function applyDocumentDiff(base: string, diff: string): string {
  const lines = diff.split('\n');
  const baseLines = base.split('\n');

  let index = 0;
  while (index < lines.length && !lines[index]!.startsWith('@@')) index += 1;
  if (index >= lines.length) throw new Error('document diff has no hunk header');
  if (index !== 0 && (index !== 2 || !lines[0]!.startsWith('--- ') || !lines[1]!.startsWith('+++ '))) {
    throw new Error('document diff has an invalid file header');
  }

  const result: string[] = [];
  let baseCursor = 0;
  while (index < lines.length) {
    const headerLine = lines[index]!;
    if (!headerLine.startsWith('@@')) throw new Error('document diff has unexpected content between hunks');
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(headerLine);
    if (!header) throw new Error('document diff has an invalid hunk header');
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    const baseIndex = oldCount === 0 ? oldStart : oldStart - 1;
    index += 1;

    if (baseIndex < baseCursor) throw new Error('document diff hunks overlap or are out of order');
    if (baseIndex + oldCount > baseLines.length) throw new Error('document diff does not fit the base content');
    result.push(...baseLines.slice(baseCursor, baseIndex));
    const newIndex = newCount === 0 ? newStart : newStart - 1;
    if (result.length !== newIndex) throw new Error('document diff hunk start does not match its output position');

    let consumed = 0;
    let produced = 0;
    for (; index < lines.length; index += 1) {
      const body = lines[index]!;
      if (body.startsWith('@@')) break;
      if (body === '') {
        if (index === lines.length - 1) continue;
        throw new Error('document diff has an invalid line');
      }
      const marker = body[0];
      const text = body.slice(1);
      if (marker === ' ') {
        if (baseLines[baseIndex + consumed] !== text) throw new Error('document diff context does not match the base');
        result.push(text);
        consumed += 1;
        produced += 1;
      } else if (marker === '-') {
        if (baseLines[baseIndex + consumed] !== text) throw new Error('document diff removal does not match the base');
        consumed += 1;
      } else if (marker === '+') {
        result.push(text);
        produced += 1;
      } else {
        throw new Error('document diff has an invalid line marker');
      }
    }
    // The header counts are authoritative: each hunk must consume exactly
    // `oldCount` base lines and produce exactly `newCount` output lines, so a
    // truncated or corrupt hunk is rejected instead of being partially applied.
    if (consumed !== oldCount || produced !== newCount) {
      throw new Error('document diff body does not match its hunk header');
    }
    baseCursor = baseIndex + consumed;
  }

  result.push(...baseLines.slice(baseCursor));
  return result.join('\n');
}

/**
 * Reconstruct the current content of one document from the ledger. A `full`
 * event seeds the content; each diff is applied to what is already in the
 * context. Returns `undefined` when the document never entered the context.
 */
export function currentDocument(
  events: readonly LedgerEvent[],
  path: string,
): { content: string; version: string } | undefined {
  let content: string | undefined;
  let version: string | undefined;
  for (const event of events) {
    if (event.type !== 'doc.content' || event.path !== path) continue;
    if (event.format === 'full') {
      if (contentVersion(event.content) !== event.version) {
        throw new Error(`document full content for ${path} has an inconsistent version`);
      }
      content = event.content;
      version = event.version;
      continue;
    }
    if (content === undefined || version === undefined) {
      throw new Error(`document diff for ${path} has no base content in the ledger`);
    }
    if (event.base !== undefined && event.base !== version) {
      throw new Error(`document diff for ${path} does not apply to version ${version}`);
    }
    content = applyDocumentDiff(content, event.content);
    version = event.version;
    if (contentVersion(content) !== version) {
      throw new Error(`document diff for ${path} produced an inconsistent version`);
    }
  }
  if (content === undefined || version === undefined) return undefined;
  return { content, version };
}

/** Read a `更新`/`updated` value from a `>` header block of a Markdown file. */
function headerField(content: string, labels: readonly string[]): string {
  for (const line of content.split('\n')) {
    const quoted = /^\s*>\s*(.+)$/u.exec(line);
    if (!quoted) continue;
    for (const label of labels) {
      const field = new RegExp(`^${label}\\s*[:：]\\s*(.*)$`, 'iu').exec(quoted[1]!.trim());
      if (field) return field[1]!.trim();
    }
  }
  return '';
}

export type DocumentDraftMeta = Pick<DocContentEvent, 'turn' | 'cycle' | 'actionId' | 'source'>;

/**
 * Build the `doc.content` draft for a document read or write. When the prior
 * content already entered the context the change is the diff against that
 * content (never the disk copy); a document that never entered the context is
 * written once as `full`. Returns `undefined` when nothing changed.
 */
export function makeDocumentDraft(
  file: { path: string; title: string; content: string },
  events: readonly LedgerEvent[],
  meta: DocumentDraftMeta,
): DocContentDraft | undefined {
  const previous = currentDocument(events, file.path);
  const change = documentChange(file.path, previous?.content, file.content);
  if (change === undefined) return undefined;
  return {
    type: 'doc.content',
    turn: meta.turn,
    cycle: meta.cycle,
    path: file.path,
    title: file.title,
    updated: headerField(file.content, ['更新', '更新时间', 'updated', 'update']),
    version: change.version,
    tokens: estimateTokens(file.content),
    content: change.content,
    format: change.format,
    ...(change.base === undefined ? {} : { base: change.base }),
    source: meta.source,
    ...(meta.actionId === undefined ? {} : { actionId: meta.actionId }),
  };
}
