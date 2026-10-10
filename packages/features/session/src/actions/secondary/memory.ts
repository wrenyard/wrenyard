/**
 * The memory secondary session: one memory-search call before every reason
 * request. It selects at most three root memory files from the frozen index
 * and publishes each changed one as a `memory.recalled` event with source
 * `memory-search`.
 */

import { contentVersion } from '../../documents.ts';
import { messageOf } from '../../errors.ts';
import type { LedgerEvent } from '../../ledger.ts';
import { escapeBody, tag, twoPartView } from '../../render.ts';
import type { BuiltView, SessionCallHost } from '../../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../../runtime.ts';
import { latestReasonText } from './reply.ts';

/** How much of one action result the memory-search view carries. */
const ACTION_RESULT_EXCERPT = 200;

// ─── Memory-search view ─────────────────────────────────────────────────────

const MEMORY_SEARCH_SYSTEM = `<wy-system>
You are the memory retriever. Using only the user request and the reasoning context, pick the memory files to load this time from the given memory index.
Output strict JSON only: {"picks":[{"path":"memories/…md","reason":"…"}]}
Rules:
- path must come from the given memory index and be workspace-relative.
- Pick at most 3 items. Output an empty array when nothing needs loading.
- Never output document bodies or document catalogs.
- You may pick a memory that must be checked this time even when it is already in context. The program skips unchanged content and injects the updated original.
- Output only JSON, with no code fence or extra explanation.
</wy-system>
<wy-role>
Memory retriever: pick memory file paths only. Never write content.
</wy-role>`;

export interface MemorySearchViewInput {
  memoryIndex: string;
  loadedPaths: string[];
  userText: string;
  lastReasonText: string;
  actionResults: { name: string; status: string; text: string }[];
}

function buildMemorySearch(input: MemorySearchViewInput): BuiltView {
  const loaded = input.loadedPaths.length === 0
    ? '(none)'
    : input.loadedPaths.map((path) => `- ${escapeBody(path)}`).join('\n');
  const results = input.actionResults.length === 0
    ? '(none)'
    : input.actionResults
      .map((result) => escapeBody(`- ${result.name} [${result.status}]: ${result.text}`))
      .join('\n');
  const body = [
    tag('memory-index', [], escapeBody(input.memoryIndex)),
    tag('loaded-paths', [], loaded),
    tag('last-reason', [], escapeBody(input.lastReasonText)),
    tag('action-results', [], results),
    tag('user', [], escapeBody(input.userText)),
  ].join('\n');
  return twoPartView(MEMORY_SEARCH_SYSTEM, tag('wy-memory-search', [], body), 'wy-memory-search');
}

// ─── Memory search ──────────────────────────────────────────────────────────

/** The engine surface one memory-search call needs. */
export type MemorySearchHost = Pick<SessionCallHost, 'ledger' | 'invoke' | 'appendError'>;

/**
 * One memory-search call before every reason request. It selects at most
 * three root memory files from the frozen index and publishes each changed
 * one as a `memory.recalled` event with source `memory-search`. A failed or
 * invalid call is reported and the reason request still runs.
 */
export async function runMemorySearch(
  host: MemorySearchHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  cycle: number,
): Promise<void> {
  const events = host.ledger.read(session.sessionId);
  const view: BuiltView = buildMemorySearch({
    memoryIndex: session.snapshot.memoryIndex,
    loadedPaths: memoryPathsInContext(events),
    userText: turn.userText,
    lastReasonText: latestReasonText(events),
    actionResults: turnActionResults(turn, events),
  });
  const outcome = await host.invoke(session, turn, 'memory-search', view);
  if (!outcome.ok) {
    await host.appendError(session.sessionId, 'memory-search', outcome.error ?? 'memory-search call failed', turn);
    return;
  }
  const parsed = parseMemoryPicks(outcome.text, session.snapshot.memoryIndex);
  if (!parsed.ok) {
    await host.appendError(session.sessionId, 'memory-search', parsed.reason, turn);
    return;
  }
  for (const pick of parsed.picks) {
    if (turn.finished || turn.abort.signal.aborted) return;
    const file = session.files.read(pick.path);
    if (!file) continue;
    const version = contentVersion(file.content);
    if (latestMemoryVersion(events, pick.path) === version) continue;
    await host.ledger.append(session.sessionId, {
      type: 'memory.recalled',
      turn: turn.turn,
      cycle,
      path: pick.path,
      content: file.content,
      version,
      source: 'memory-search',
    });
  }
}

// ─── Memory pick parsing ────────────────────────────────────────────────────

/** Distinct memory paths already recalled into the context, in timeline order. */
function memoryPathsInContext(events: readonly LedgerEvent[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    if (event.type === 'memory.recalled' && !paths.includes(event.path)) paths.push(event.path);
  }
  return paths;
}

/** The content version of the latest memory recall for one path. */
function latestMemoryVersion(events: readonly LedgerEvent[], path: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'memory.recalled' && event.path === path) return event.version;
  }
  return undefined;
}

/** This turn's committed action results, trimmed for the memory-search view. */
function turnActionResults(
  turn: TurnRuntime,
  events: readonly LedgerEvent[],
): { name: string; status: string; text: string }[] {
  const results: { name: string; status: string; text: string }[] = [];
  for (const event of events) {
    if (event.type !== 'action.finished' || event.turn !== turn.turn) continue;
    results.push({ name: event.kind, status: event.status, text: event.result.slice(0, ACTION_RESULT_EXCERPT) });
  }
  return results;
}

/**
 * Exact canonical root memory paths actually listed in the frozen raw index.
 * Only inline Markdown link targets and standalone canonical path entries are
 * considered, so a name that merely appears in a link label or prose never
 * admits a path. Root `name.md` / `./name.md` targets normalize relative to
 * `memories/INDEX.md` to `memories/name.md`. Parent traversal, nested folders,
 * absolute/external targets and INDEX.md are excluded.
 */
function canonicalMemoryTargets(memoryIndex: string): Set<string> {
  const targets = new Set<string>();
  const candidates: string[] = [];
  // Actual inline Markdown link targets: `[label](target)`.
  const link = /\[[^\]\n]*\]\(\s*<?([^()<>\s]+)>?\s*\)/gu;
  for (let match = link.exec(memoryIndex); match !== null; match = link.exec(memoryIndex)) {
    candidates.push(match[1]!);
  }
  // Standalone canonical path list entries such as `- memories/m1.md`.
  const entry = /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*(memories\/[^/ \t()[\]<>]+\.md)[ \t]*$/gmu;
  for (let match = entry.exec(memoryIndex); match !== null; match = entry.exec(memoryIndex)) {
    candidates.push(match[1]!);
  }
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('://')) continue;
    const segments = trimmed.replace(/^\.\//u, '').split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) continue;
    let canonical: string | undefined;
    if (segments.length === 1 && segments[0]!.endsWith('.md')) canonical = `memories/${segments[0]!}`;
    else if (segments.length === 2 && segments[0] === 'memories' && segments[1]!.endsWith('.md')) canonical = `memories/${segments[1]!}`;
    if (canonical === undefined || !/^memories\/[^/]+\.md$/u.test(canonical)) continue;
    if (canonical.toLowerCase() === 'memories/index.md') continue;
    targets.add(canonical);
  }
  return targets;
}

/**
 * Validate the memory selector's strict JSON: at most three `{ path, reason }`
 * picks, each an existing root `memories/*.md` file listed in the frozen index.
 * A malformed result is reported, never repaired.
 */
function parseMemoryPicks(
  text: string,
  memoryIndex: string,
): { ok: true; picks: { path: string; reason: string }[] } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (error) {
    return { ok: false, reason: `memory-search output is not valid JSON: ${messageOf(error)}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'memory-search output must be a JSON object' };
  }
  const picks = (value as { picks?: unknown }).picks;
  if (!Array.isArray(picks)) return { ok: false, reason: 'memory-search output must contain a picks array' };
  const indexedTargets = canonicalMemoryTargets(memoryIndex);
  const result: { path: string; reason: string }[] = [];
  for (const raw of picks) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'memory-search pick must be an object' };
    }
    const path = (raw as { path?: unknown }).path;
    const reason = (raw as { reason?: unknown }).reason;
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, reason: 'memory-search pick needs a non-empty path' };
    }
    if (typeof reason !== 'string') return { ok: false, reason: 'memory-search pick needs a reason string' };
    if (!/^memories\/[^/]+\.md$/u.test(path) || path.toLowerCase() === 'memories/index.md') {
      return { ok: false, reason: `memory-search path is not a root memory file: ${path}` };
    }
    if (!indexedTargets.has(path)) {
      return { ok: false, reason: `memory-search path is not in the memory index: ${path}` };
    }
    if (!result.some((pick) => pick.path === path)) result.push({ path, reason });
    if (result.length >= 3) break;
  }
  return { ok: true, picks: result };
}
