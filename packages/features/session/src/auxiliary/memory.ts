/**
 * The memory auxiliary task once per turn: a cached BM25 lexical pass over index
 * metadata and memory bodies may recall without a model call; when candidates
 * stay ambiguous, a bounded memory-search agent loop selects at most three root
 * memory files from the BM25 shortlist and publishes each changed one as a
 * `memory.recalled` event with source `memory-search`.
 */

import {
  bindCatalog,
  createLoopRecord,
  getAuxiliaryDefinition,
  protocolTools,
  runAuxiliaryLoop,
  type CallRunRequest,
  type CallRunResult,
  type LoopRecord,
  type MethodCatalogPort,
  type MethodInfo,
} from '@wrenyard/agent-loop';

import { contentVersion } from '../documents.ts';
import { messageOf } from '../errors.ts';
import { turnId, type LedgerEvent } from '../ledger/store.ts';
import { escapeBody, renderEventsBlock, tag } from '../context/render.ts';
import type { SessionCallHost } from '../ports.ts';
import type { SessionRuntime, TurnRuntime } from '../turn/runtime.ts';
import { latestReasonText } from './reply.ts';
import { memoryPortOf, type WorkspaceMemoryPort } from '../memory-write.ts';

/** How much of one action result the memory-search view carries. */
const ACTION_RESULT_EXCERPT = 200;

export interface MemorySearchViewInput {
  memoryIndex: string;
  loadedPaths: string[];
  userText: string;
  lastReasonText: string;
  actionResults: { name: string; status: string; text: string }[];
}

// ─── Memory selection limits ──────────────────────────────────────────────────

const MEMORY_SELECTION = {
  maxPicks: 3,
  pathPattern: /^memories\/[^/]+\.md$/u,
  indexFile: 'memories/index.md',
};

function buildMemorySearchUser(input: MemorySearchViewInput): string {
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
  return tag('wy-memory-search', [], body);
}

const MEMORY_METHOD_INFOS: readonly MethodInfo[] = [
  {
    name: 'memory.index.read',
    description: 'Read the current memory index and valid root memory paths.',
    params: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'memory.entry.read',
    description: 'Read one root memory file from the index.',
    params: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Canonical memories/*.md path.' } },
      required: ['path'],
    },
  },
];

// ─── Lexical memory recall ──────────────────────────────────────────────────

/** Project memories with an updated age beyond this are stale for recall ranking. */
const STALE_AFTER_DAYS = 30;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
const STALE_SCORE_FACTOR = 0.5;

/** At most this many eligible BM25 paths are offered to the LLM selector. */
const LEXICAL_SHORTLIST_MAX = 8;
/** Eligible BM25 scores must be at least this floor. */
const LEXICAL_SCORE_FLOOR = 1;
/** Eligible scores must be at least this fraction of the top score. */
const LEXICAL_RELATIVE_CUTOFF = 0.5;
/** Direct top-three recall when the third score beats the fourth by this factor. */
const LEXICAL_TOP3_CLEAR_RATIO = 1.5;
/** Max plain-text body excerpt per shortlist candidate in the selector index. */
const SHORTLIST_BODY_EXCERPT = 240;
/** Max injected bytes for one recalled memory file. */
const MEMORY_RECALL_PER_MEMORY_CAP = 4000;
/** Max injected bytes across all memories recalled in one search. */
const MEMORY_RECALL_TOTAL_CAP = 9000;
/** Max leading body bytes kept when a memory is section-truncated. */
const MEMORY_RECALL_HEAD_EXCERPT = 600;
/** Shortlist section labels appended per candidate. */
const SHORTLIST_SECTION_HEADINGS_MAX = 8;
const SHORTLIST_SECTION_HEADING_CHARS = 40;
const MEMORY_TRUNCATION_MARKER = '\n\n… [memory truncated]\n';
const BM25_K1 = 1.2;
const BM25_B = 0.75;

type MemoryPick = { path: string; reason: string; section?: string };

interface LexicalMemoryDoc {
  path: string;
  termFreq: Map<string, number>;
  tokenCount: number;
  title: string;
  description: string;
  body: string;
  /** Raw file content fingerprint; unchanged recalls are skipped before selection. */
  contentVersion: string;
  /** Tokens from the index line plus parsed name and description only. */
  metadataTokens: Set<string>;
  memoryType: string;
  createdAt: string;
  updatedAt: string;
  stale: boolean;
}

interface LexicalCorpus {
  docs: LexicalMemoryDoc[];
  n: number;
  avgLen: number;
  df: Map<string, number>;
}

interface LexicalCacheEntry extends LexicalCorpus {
  fingerprint: string;
}

/** Per memory port (bot isolation) or per session files snapshot when there is no port. */
const lexicalCacheForPort = new WeakMap<WorkspaceMemoryPort, LexicalCacheEntry>();
const lexicalCacheForFiles = new WeakMap<SessionRuntime['files'], LexicalCacheEntry>();

const MEMORY_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u;

type LexicalRecall =
  | { kind: 'direct'; picks: MemoryPick[] }
  | { kind: 'empty' }
  | { kind: 'llm'; shortlist: string[] };

/** The first index line for each canonical path in the frozen index. */
function indexLineByPath(memoryIndex: string): Map<string, string> {
  const lineByPath = new Map<string, string>();
  for (const line of memoryIndex.split('\n')) {
    for (const path of canonicalMemoryTargets(line)) {
      if (!lineByPath.has(path)) lineByPath.set(path, line);
    }
  }
  return lineByPath;
}

function frontmatterField(frontmatter: string, field: string): string {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'mu').exec(frontmatter);
  return match === null ? '' : match[1]!.trim();
}

/** Top-level `recall:` in leading frontmatter only; indented keys are ignored. */
function topLevelRecallMode(frontmatter: string): 'auto' | 'off' | 'manual' {
  for (const line of frontmatter.split('\n')) {
    if (/^[ \t]/u.test(line)) continue;
    const match = /^recall:\s*(.+)$/iu.exec(line);
    if (match === null) continue;
    const value = match[1]!.trim().toLowerCase();
    if (value === 'false') return 'off';
    if (value === 'manual') return 'manual';
    return 'auto';
  }
  return 'auto';
}

function memoryRecallExcluded(rawContent: string): boolean {
  const match = rawContent.match(MEMORY_FRONTMATTER);
  if (match === null) return false;
  const mode = topLevelRecallMode(match[1]!);
  return mode === 'off' || mode === 'manual';
}

interface MemoryBodySection {
  heading: string;
  body: string;
  index: number;
}

function splitMemoryBodySections(body: string): { head: string; sections: MemoryBodySection[] } {
  const lines = body.split(/\r?\n/u);
  const sections: MemoryBodySection[] = [];
  let headLines: string[] = [];
  let currentHeading = '';
  let currentBody: string[] = [];
  let sectionIndex = 0;
  const flush = () => {
    if (currentHeading === '') return;
    sections.push({
      heading: currentHeading,
      body: currentBody.join('\n'),
      index: sectionIndex,
    });
    sectionIndex += 1;
    currentHeading = '';
    currentBody = [];
  };
  for (const line of lines) {
    const headingMatch = /^(#{1,6})[ \t]+(.+?)[ \t]*$/u.exec(line);
    if (headingMatch !== null) {
      flush();
      currentHeading = headingMatch[2]!.trim();
      continue;
    }
    if (currentHeading === '') headLines.push(line);
    else currentBody.push(line);
  }
  flush();
  return { head: headLines.join('\n'), sections };
}

function sectionOverlapScore(section: MemoryBodySection, query: readonly string[]): number {
  if (query.length === 0) return 0;
  const headingTokens = new Set(recallTokens(section.heading));
  const bodyTokens = new Set(recallTokens(section.body));
  let score = 0;
  for (const term of new Set(query)) {
    if (headingTokens.has(term)) score += 2;
    else if (bodyTokens.has(term)) score += 1;
  }
  return score;
}

function pickSectionBody(
  head: string,
  sections: readonly MemoryBodySection[],
  query: readonly string[],
  namedSection?: string,
): string {
  if (namedSection !== undefined && namedSection.trim() !== '') {
    const needle = namedSection.trim().toLowerCase();
    const explicit = sections.find((section) => section.heading.toLowerCase().includes(needle));
    if (explicit !== undefined) return explicit.body;
  }
  if (sections.length === 0) return head;
  let best = sections[0]!;
  let bestScore = sectionOverlapScore(best, query);
  for (let index = 1; index < sections.length; index += 1) {
    const section = sections[index]!;
    const score = sectionOverlapScore(section, query);
    if (score > bestScore) {
      best = section;
      bestScore = score;
    }
  }
  if (bestScore === 0) return sections[0]!.body;
  return best.body;
}

function assembleRecalledMemoryContent(
  rawContent: string,
  queryTokens: readonly string[],
  namedSection: string | undefined,
  cap: number,
): string {
  if (rawContent.length <= cap) return rawContent;
  const match = rawContent.match(MEMORY_FRONTMATTER);
  const prefix = match === null ? '' : rawContent.slice(0, match[0].length);
  const body = match === null ? rawContent : (match[2] ?? '');
  const { head, sections } = splitMemoryBodySections(body);
  const selected = pickSectionBody(head, sections, queryTokens, namedSection);
  const headBit = head.trim() === '' ? '' : head.trim().slice(0, MEMORY_RECALL_HEAD_EXCERPT);
  const chunks: string[] = [];
  if (headBit !== '') chunks.push(headBit);
  if (selected.trim() !== '') chunks.push(selected.trim());
  let bodyText = chunks.join('\n\n');
  const marker = MEMORY_TRUNCATION_MARKER;
  const maxBody = cap - prefix.length;
  if (maxBody <= 0) return rawContent.slice(0, cap);
  if (prefix.length + bodyText.length <= cap) return prefix + bodyText;
  const markerBudget = marker.length;
  const sliceBudget = Math.max(0, maxBody - markerBudget);
  if (sliceBudget <= 0) return (prefix + bodyText).slice(0, cap);
  bodyText = bodyText.slice(0, sliceBudget) + marker;
  if (prefix.length + bodyText.length > cap) return (prefix + bodyText).slice(0, cap);
  return prefix + bodyText;
}

function sectionHeadingsForShortlist(body: string): string[] {
  const headings: string[] = [];
  for (const line of body.split('\n')) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*$/u.exec(line);
    if (match === null) continue;
    let label = match[2]!.trim();
    if (label.length > SHORTLIST_SECTION_HEADING_CHARS) {
      label = label.slice(0, SHORTLIST_SECTION_HEADING_CHARS);
    }
    headings.push(label);
    if (headings.length >= SHORTLIST_SECTION_HEADINGS_MAX) break;
  }
  return headings;
}

function memoryTypeFromFrontmatter(frontmatter: string): string {
  const inline = /metadata:\s*\{[^}]*type:\s*([^,}\s]+)/u.exec(frontmatter);
  if (inline !== null) return inline[1]!.trim();
  const block = /metadata:\s*\n(?:[ \t]+.*\n)*?[ \t]+type:\s*(\S+)/mu.exec(frontmatter);
  return block === null ? '' : block[1]!.trim();
}

function parseMemoryTimestamps(frontmatter: string, mtimeIso: string): { createdAt: string; updatedAt: string } {
  const created = frontmatterField(frontmatter, 'created');
  const updated = frontmatterField(frontmatter, 'updated');
  return {
    createdAt: created === '' ? mtimeIso : created,
    updatedAt: updated === '' ? mtimeIso : updated,
  };
}

function isStaleProjectMemory(memoryType: string, updatedAt: string, nowMs: number): boolean {
  if (memoryType !== 'project') return false;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return false;
  return nowMs - updatedMs > STALE_AFTER_MS;
}

function parsedMemoryFields(indexLine: string, fileContent: string): {
  title: string;
  description: string;
  body: string;
  lexicalText: string;
} {
  const match = fileContent.match(MEMORY_FRONTMATTER);
  if (match === null) {
    return {
      title: '',
      description: '',
      body: fileContent,
      lexicalText: `${indexLine}\n${fileContent}`,
    };
  }
  const frontmatter = match[1]!;
  const body = match[2] ?? '';
  const title = frontmatterField(frontmatter, 'name');
  const description = frontmatterField(frontmatter, 'description');
  return {
    title,
    description,
    body,
    lexicalText: `${indexLine}\n${title}\n${description}\n${body}`,
  };
}

function lexicalMemoryDoc(
  path: string,
  indexLine: string,
  rawContent: string,
  fields: { title: string; description: string; body: string; lexicalText: string },
  timestamps: { createdAt: string; updatedAt: string },
  memoryType: string,
  nowMs: number,
): LexicalMemoryDoc {
  const termFreq = new Map<string, number>();
  let tokenCount = 0;
  for (const token of recallTokens(fields.lexicalText)) {
    tokenCount += 1;
    termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
  }
  const metadataTokens = new Set(recallTokens(`${indexLine}\n${fields.title}\n${fields.description}`));
  const stale = isStaleProjectMemory(memoryType, timestamps.updatedAt, nowMs);
  return {
    path,
    termFreq,
    tokenCount,
    title: fields.title,
    description: fields.description,
    body: fields.body,
    contentVersion: contentVersion(rawContent),
    metadataTokens,
    memoryType,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    stale,
  };
}

function corpusDocumentFrequencies(docs: readonly LexicalMemoryDoc[]): { n: number; avgLen: number; df: Map<string, number> } {
  const n = docs.length;
  const avgLen = docs.reduce((sum, doc) => sum + doc.tokenCount, 0) / n || 1;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of doc.termFreq.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return { n, avgLen, df };
}

function portCorpusFingerprint(
  memoryIndex: string,
  paths: readonly string[],
  listByFilename: ReadonlyMap<string, { size: number; updatedAt: string }>,
): string {
  const stamps: string[] = [memoryIndex];
  for (const path of [...paths].sort()) {
    const filename = path.slice(path.indexOf('/') + 1);
    const entry = listByFilename.get(filename);
    stamps.push(`${path}\t${entry?.size ?? ''}\t${entry?.updatedAt ?? ''}`);
  }
  return stamps.join('\n');
}

/**
 * Cached lexical documents for one recall corpus. Refreshes when the index or
 * any indexed memory body changes; incomplete corpora are not cached.
 */
function lexicalCorpusForRecall(
  memoryIndex: string,
  paths: readonly string[],
  memory: WorkspaceMemoryPort | undefined,
  session: SessionRuntime,
): LexicalCorpus {
  const sortedPaths = [...paths].sort();
  const lineByPath = indexLineByPath(memoryIndex);
  if (memory !== undefined) {
    let listByFilename: Map<string, { name: string; filename: string; size: number; updatedAt: string }>;
    try {
      listByFilename = new Map(memory.list().map((item) => [item.filename, item]));
    } catch {
      lexicalCacheForPort.delete(memory);
      return { docs: [], n: 0, avgLen: 1, df: new Map() };
    }
    const fingerprint = portCorpusFingerprint(memoryIndex, sortedPaths, listByFilename);
    const cache = lexicalCacheForPort.get(memory);
    if (cache !== undefined && cache.fingerprint === fingerprint) {
      return { docs: cache.docs, n: cache.n, avgLen: cache.avgLen, df: cache.df };
    }
    const docs: LexicalMemoryDoc[] = [];
    let incomplete = false;
    for (const path of sortedPaths) {
      try {
        const filename = path.slice(path.indexOf('/') + 1);
        const entry = listByFilename.get(filename);
        if (entry === undefined) {
          incomplete = true;
          continue;
        }
        const content = memory.read(entry.name).text;
        if (memoryRecallExcluded(content)) continue;
        const indexLine = lineByPath.get(path) ?? '';
        const fields = parsedMemoryFields(indexLine, content);
        const frontmatter = content.match(MEMORY_FRONTMATTER)?.[1] ?? '';
        const memoryType = memoryTypeFromFrontmatter(frontmatter);
        const timestamps = parseMemoryTimestamps(frontmatter, entry.updatedAt);
        docs.push(lexicalMemoryDoc(path, indexLine, content, fields, timestamps, memoryType, Date.now()));
      } catch {
        incomplete = true;
      }
    }
    const stats = corpusDocumentFrequencies(docs);
    const corpus: LexicalCorpus = { docs, ...stats };
    if (!incomplete) lexicalCacheForPort.set(memory, { fingerprint, ...corpus });
    return corpus;
  }

  const stamps: string[] = [memoryIndex];
  const contentByPath = new Map<string, string>();
  let incomplete = false;
  for (const path of sortedPaths) {
    try {
      const file = session.files.read(path);
      stamps.push(`${path}\t${file === undefined ? '' : contentVersion(file.content)}`);
      if (file === undefined) {
        incomplete = true;
        continue;
      }
      if (!memoryRecallExcluded(file.content)) contentByPath.set(path, file.content);
    } catch {
      incomplete = true;
    }
  }
  const fingerprint = stamps.join('\n');
  const cache = lexicalCacheForFiles.get(session.files);
  if (!incomplete && cache !== undefined && cache.fingerprint === fingerprint) {
    return { docs: cache.docs, n: cache.n, avgLen: cache.avgLen, df: cache.df };
  }
  const docs: LexicalMemoryDoc[] = [];
  for (const path of sortedPaths) {
    const content = contentByPath.get(path);
    if (content === undefined) continue;
    if (memoryRecallExcluded(content)) continue;
    const indexLine = lineByPath.get(path) ?? '';
    const fields = parsedMemoryFields(indexLine, content);
    const frontmatter = content.match(MEMORY_FRONTMATTER)?.[1] ?? '';
    const memoryType = memoryTypeFromFrontmatter(frontmatter);
    const mtimeIso = new Date().toISOString();
    const timestamps = parseMemoryTimestamps(frontmatter, mtimeIso);
    docs.push(lexicalMemoryDoc(path, indexLine, content, fields, timestamps, memoryType, Date.now()));
  }
  const stats = corpusDocumentFrequencies(docs);
  const corpus: LexicalCorpus = { docs, ...stats };
  if (!incomplete) lexicalCacheForFiles.set(session.files, { fingerprint, ...corpus });
  return corpus;
}

/** Strip link targets, delimiters, and memory paths so shortlist text cannot admit extra picks. */
function sanitizeShortlistText(text: string): string {
  return text
    .replace(/\[[^\]\n]*\]\(\s*<?[^()<>\s]+>?\s*\)/gu, ' ')
    .replace(/memories\/[^/\s)]+\.md/giu, ' ')
    .replace(/[[\]<>()]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Safe shortlist link label: canonical filename stem only, not memory title text. */
function shortlistLinkLabel(path: string): string {
  const filename = path.split('/').pop() ?? path;
  const stem = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  const safe = sanitizeShortlistText(stem);
  return safe === '' ? stem.replace(/[^\w.-]+/gu, '_') : safe;
}

function bodyExcerptNearQuery(body: string, query: readonly string[], maxLen: number): string {
  const plain = sanitizeShortlistText(body);
  if (plain === '') return '';
  const lower = plain.toLowerCase();
  let anchor = -1;
  for (const term of query) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0) {
      anchor = index;
      break;
    }
  }
  if (anchor < 0) return plain.slice(0, maxLen);
  const half = Math.floor(maxLen / 2);
  const start = Math.max(0, anchor - half);
  return plain.slice(start, start + maxLen);
}

/** Synthetic index for the LLM selector: one link per shortlist path plus safe excerpts. */
function buildShortlistMemoryIndex(
  shortlist: readonly string[],
  docs: readonly LexicalMemoryDoc[],
  query: readonly string[],
): string {
  const docByPath = new Map(docs.map((doc) => [doc.path, doc]));
  const lines: string[] = [];
  for (const path of shortlist) {
    const doc = docByPath.get(path);
    const title = doc === undefined ? '' : sanitizeShortlistText(doc.title);
    const baseLabel = title !== '' ? title : shortlistLinkLabel(path);
    const label = baseLabel + (doc?.stale === true ? ' (stale)' : '');
    lines.push(`- [${label}](${path})`);
    if (doc !== undefined && doc.description !== '') lines.push(sanitizeShortlistText(doc.description));
    const excerpt = doc === undefined ? '' : bodyExcerptNearQuery(doc.body, query, SHORTLIST_BODY_EXCERPT);
    if (excerpt !== '') lines.push(excerpt);
    if (doc !== undefined) {
      for (const heading of sectionHeadingsForShortlist(doc.body)) {
        lines.push(sanitizeShortlistText(heading));
      }
    }
  }
  return lines.join('\n');
}

/** Lowercase Latin/digit/underscore tokens plus CJK unigrams or bigrams. */
function recallTokens(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9_]+/gu)) tokens.push(match[0]!);
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;
  for (const match of text.matchAll(cjk)) {
    const run = match[0]!;
    if (run.length === 1) tokens.push(run);
    else {
      for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2));
    }
  }
  return tokens;
}

/** Standard BM25 scores using precomputed corpus statistics from the lexical cache. */
function bm25Scores(query: readonly string[], corpus: LexicalCorpus): number[] {
  const { docs, n, avgLen, df } = corpus;
  if (n === 0) return [];
  return docs.map((doc) => {
    const len = doc.tokenCount;
    const freq = doc.termFreq;
    let score = 0;
    for (const term of query) {
      const f = freq.get(term) ?? 0;
      if (f === 0) continue;
      const docFreq = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * len / avgLen));
    }
    return score;
  });
}

function recallQueryTokens(input: MemorySearchViewInput): string[] {
  const queryText = [
    input.userText,
    input.lastReasonText,
    ...input.actionResults.map((result) => `${result.name} ${result.status} ${result.text}`),
  ].join('\n');
  return [...new Set(recallTokens(queryText))];
}

/** Query terms that are not overly common in the full recall corpus. */
function informativeQueryTerms(query: readonly string[], corpus: LexicalCorpus): Set<string> {
  const maxDf = Math.max(1, Math.floor(corpus.n * 0.25));
  const informative = new Set<string>();
  for (const term of query) {
    if ((corpus.df.get(term) ?? 0) <= maxDf) informative.add(term);
  }
  return informative;
}

function distinctInformativeDocMatches(doc: LexicalMemoryDoc, informative: ReadonlySet<string>): number {
  let count = 0;
  for (const term of informative) {
    if ((doc.termFreq.get(term) ?? 0) > 0) count += 1;
  }
  return count;
}

function distinctInformativeMetadataMatches(doc: LexicalMemoryDoc, informative: ReadonlySet<string>): number {
  let count = 0;
  for (const term of informative) {
    if (doc.metadataTokens.has(term)) count += 1;
  }
  return count;
}

/**
 * Heuristic direct-recall gate; precision and model-free share need external measurement.
 * Strong when metadata carries two informative query terms or the body carries three.
 */
function hasStrongLexicalEvidence(doc: LexicalMemoryDoc, informative: ReadonlySet<string>): boolean {
  if (distinctInformativeMetadataMatches(doc, informative) >= 2) return true;
  return distinctInformativeDocMatches(doc, informative) >= 3;
}

/** Latest recalled content version per path from the session ledger. */
function latestRecalledVersions(events: readonly LedgerEvent[]): Map<string, string> {
  const versions = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'memory.recalled') versions.set(event.path, event.version);
  }
  return versions;
}

/**
 * Deterministic lexical outcome: direct recall, empty (skip model), or bounded shortlist LLM.
 * BM25 uses the full corpus; candidates drop only when content is unchanged at recall time
 * or lack informative term overlap. Confidence thresholds are explicit heuristics only.
 */
function evaluateLexicalRecall(
  input: MemorySearchViewInput,
  corpus: LexicalCorpus,
  latestRecalledByPath: ReadonlyMap<string, string>,
): LexicalRecall {
  const query = recallQueryTokens(input);
  if (query.length === 0) return { kind: 'empty' };
  const docByPath = new Map(corpus.docs.map((doc) => [doc.path, doc]));
  const scores = bm25Scores(query, corpus).map((score, index) => {
    const doc = corpus.docs[index];
    return doc?.stale === true ? score * STALE_SCORE_FACTOR : score;
  });
  const ranked = scores
    .map((score, index) => ({ score, path: corpus.docs[index]!.path }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const topScore = ranked[0]?.score ?? 0;
  const threshold = Math.max(LEXICAL_SCORE_FLOOR, topScore * LEXICAL_RELATIVE_CUTOFF);
  const scoreEligible = ranked.filter((entry) => entry.score >= threshold);
  const informative = informativeQueryTerms(query, corpus);
  const eligible = scoreEligible.filter((entry) => {
    const doc = docByPath.get(entry.path);
    if (doc === undefined) return false;
    const latest = latestRecalledByPath.get(entry.path);
    if (latest !== undefined && doc.contentVersion === latest) return false;
    return distinctInformativeDocMatches(doc, informative) > 0;
  });
  if (eligible.length === 0) return { kind: 'empty' };
  const directPick = (entry: { score: number; path: string }): MemoryPick => ({
    path: entry.path,
    reason: `lexical match (score ${entry.score.toFixed(2)})`,
  });
  const topDoc = docByPath.get(eligible[0]!.path);
  if (topDoc !== undefined && hasStrongLexicalEvidence(topDoc, informative)) {
    const picks: MemoryPick[] = [];
    for (const entry of eligible) {
      if (picks.length >= MEMORY_SELECTION.maxPicks) break;
      const doc = docByPath.get(entry.path);
      if (doc === undefined || !hasStrongLexicalEvidence(doc, informative)) continue;
      picks.push(directPick(entry));
    }
    if (picks.length > 0) return { kind: 'direct', picks };
  }
  if (eligible.length <= MEMORY_SELECTION.maxPicks) {
    return { kind: 'direct', picks: eligible.map(directPick) };
  }
  const score3 = eligible[2]!.score;
  const score4 = eligible[3]!.score;
  if (score3 >= LEXICAL_TOP3_CLEAR_RATIO * score4) {
    return { kind: 'direct', picks: eligible.slice(0, MEMORY_SELECTION.maxPicks).map(directPick) };
  }
  const shortlist = eligible.slice(0, LEXICAL_SHORTLIST_MAX).map((entry) => entry.path);
  return { kind: 'llm', shortlist };
}

// ─── Memory search ──────────────────────────────────────────────────────────

/** The engine surface one memory search needs. */
export type MemorySearchHost = Pick<SessionCallHost, 'ledger' | 'invoke' | 'ports'>;

/**
 * One memory search per turn: a cached BM25 lexical pass may recall without a
 * model call; when candidates stay ambiguous, a memory-search agent loop reads
 * only the BM25 shortlist and may load at most three root memory files. Loop
 * failure records a `system.warning` and the step continues without recalled
 * memory.
 */
export async function runMemorySearch(
  host: MemorySearchHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  step: number,
): Promise<void> {
  const memory = memoryPortOf(host.ports, session.sessionId);
  const memoryIndex = memory?.index() ?? (host.ports.memoryFor === undefined ? session.snapshot.memoryIndex : '');
  const targets = [...canonicalMemoryTargets(memoryIndex)];
  if (targets.length === 0) return;
  const events = host.ledger.read(session.sessionId);
  const input: MemorySearchViewInput = {
    memoryIndex,
    loadedPaths: memoryPathsInContext(events),
    userText: turn.userText,
    lastReasonText: latestReasonText(events),
    actionResults: turnActionResults(turn, events),
  };
  const corpus = lexicalCorpusForRecall(memoryIndex, targets, memory, session);
  const latestRecalledByPath = latestRecalledVersions(events);
  const lexical = evaluateLexicalRecall(input, corpus, latestRecalledByPath);
  const queryTokens = recallQueryTokens(input);
  if (lexical.kind === 'direct') {
    await publishMemoryPicks(host, session, turn, step, events, memory, lexical.picks, turnId(turn.turn), queryTokens);
    return;
  }
  if (lexical.kind === 'empty') return;

  const shortlist = lexical.shortlist;
  const allowedTargets = new Set(shortlist);
  const shortlistIndex = buildShortlistMemoryIndex(shortlist, corpus.docs, queryTokens);
  const loopInput: MemorySearchViewInput = {
    ...input,
    memoryIndex: shortlistIndex,
    loadedPaths: input.loadedPaths.filter((path) => allowedTargets.has(path)),
  };

  const pickedPaths: string[] = [];
  const record = createLoopRecord();
  const catalog = createMemorySearchCatalog(memory, session, shortlistIndex, allowedTargets, pickedPaths, record);
  const definition = getAuxiliaryDefinition('memory-search');
  if (definition === undefined) {
    await appendMemoryWarning(host, session, turn, step, turnId(turn.turn), 'memory-search auxiliary definition is missing');
    return;
  }
  const ctx = memorySearchContext(host, session, turn, step);
  const helpers = { messageOf, escapeBody, renderEventsBlock };
  const loopDeps = {
    host: bindCatalog(catalog, 'memory-search'),
    calls: {
      holdSpan: () => {},
      releaseSpan: async () => {},
      run: async (request: CallRunRequest): Promise<CallRunResult> => {
        const outcome = await host.invoke(session, turn, 'memory-search', {
          messages: [...request.messages],
          layers: request.layers ?? {},
        }, {
          parent: request.parent,
          step: request.step,
          tools: request.tools,
          spanId: request.spanId,
          signal: request.signal,
        });
        if (!outcome.ok) throw new Error(outcome.error ?? 'memory-search call failed');
        return {
          model: '',
          text: outcome.text ?? '',
          toolCalls: outcome.toolCalls ?? [],
          metrics: { attempts: [] },
        };
      },
    },
    helpers,
  };
  const tools = await protocolTools(
    loopDeps.host,
    helpers,
    ctx,
    record,
    definition.methods,
    definition.effects,
  );
  const spanId = `${ctx.actionId}.${definition.spanIdPrefix}`;
  const loopResult = await runAuxiliaryLoop({
    deps: loopDeps,
    ctx,
    role: 'memory-search',
    system: definition.buildSystemPrompt({ documentRules: () => '' }),
    user: buildMemorySearchUser(loopInput),
    tools,
    maxRounds: definition.maxRounds,
    spanIdPrefix: definition.spanIdPrefix,
    record,
  });
  if (loopResult.status !== 'done') {
    await appendMemoryWarning(host, session, turn, step, spanId, loopResult.summary);
    return;
  }
  const picks = pickedPaths.map((path) => ({ path, reason: 'selected by memory-search loop' }));
  await publishMemoryPicks(host, session, turn, step, events, memory, picks, spanId, queryTokens);
}

/** Publish validated memory picks as `memory.recalled` events when content changed. */
async function publishMemoryPicks(
  host: MemorySearchHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  step: number,
  events: readonly LedgerEvent[],
  memory: WorkspaceMemoryPort | undefined,
  picks: readonly MemoryPick[],
  parent: string,
  queryTokens: readonly string[],
): Promise<void> {
  let remainingTotal = MEMORY_RECALL_TOTAL_CAP;
  for (const pick of picks) {
    if (turn.finished || turn.abort.signal.aborted) break;
    if (remainingTotal <= 0) break;
    const file = memory === undefined ? session.files.read(pick.path) : readMemoryFile(memory, pick.path);
    if (!file) continue;
    if (memoryRecallExcluded(file.content)) continue;
    const version = contentVersion(file.content);
    if (latestMemoryVersion(events, pick.path) === version) continue;
    const perMemoryCap = Math.min(MEMORY_RECALL_PER_MEMORY_CAP, remainingTotal);
    const content = assembleRecalledMemoryContent(file.content, queryTokens, pick.section, perMemoryCap);
    remainingTotal -= content.length;
    await host.ledger.append(session.sessionId, {
      type: 'memory.recalled',
      turn: turn.turn,
      step,
      parent,
      path: pick.path,
      content,
      version,
      source: 'memory-search',
    });
  }
}

/** Read one picked `memories/<file>` through the memory store, or undefined when absent. */
function readMemoryFile(memory: WorkspaceMemoryPort, path: string): { content: string } | undefined {
  const filename = path.slice(path.indexOf('/') + 1);
  const entry = memory.list().find((item) => item.filename === filename);
  return entry === undefined ? undefined : { content: memory.read(entry.name).text };
}

/** Report a memory search that produced nothing usable; the step continues. */
async function appendMemoryWarning(
  host: MemorySearchHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  step: number,
  spanId: string,
  message: string,
): Promise<void> {
  try {
    await host.ledger.append(session.sessionId, {
      type: 'system.warning',
      turn: turn.turn,
      step,
      parent: spanId,
      source: 'system',
      code: 'memory-search',
      message,
    });
  } catch {
    // Reporting must never take the pipeline down.
  }
}

function memorySearchContext(
  host: MemorySearchHost,
  session: SessionRuntime,
  turn: TurnRuntime,
  step: number,
) {
  const actionId = `${turnId(turn.turn)}.memory.${step}`;
  return {
    sessionId: session.sessionId,
    turn: turn.turn,
    step,
    actionId,
    snapshot: session.snapshot,
    currentEvents: () => host.ledger.read(session.sessionId),
    projects: session.snapshot.projects,
    signal: turn.abort.signal,
  };
}

function createMemorySearchCatalog(
  memory: WorkspaceMemoryPort | undefined,
  session: SessionRuntime,
  shortlistIndex: string,
  allowedTargets: ReadonlySet<string>,
  pickedPaths: string[],
  record: LoopRecord,
): MethodCatalogPort {
  const local = new Map(MEMORY_METHOD_INFOS.map((info) => [info.name, info]));
  return {
    async methods(names) {
      return names.map((name) => local.get(name)).filter((info): info is MethodInfo => info !== undefined);
    },
    async call(method, params) {
      if (method === 'memory.index.read') {
        return { index: shortlistIndex, targets: [...allowedTargets] };
      }
      if (method === 'memory.entry.read') {
        if (params === null || typeof params !== 'object' || Array.isArray(params)) {
          throw Object.assign(new Error('memory.entry.read params must be an object'), { code: 'invalid_arguments' });
        }
        const path = (params as { path?: unknown }).path;
        if (typeof path !== 'string' || !allowedTargets.has(path)) {
          throw Object.assign(new Error('memory path is not in the memory shortlist'), { code: 'validation_failed' });
        }
        if (pickedPaths.length >= MEMORY_SELECTION.maxPicks) {
          throw Object.assign(new Error(`at most ${MEMORY_SELECTION.maxPicks} memories may be read`), { code: 'validation_failed' });
        }
        const file = memory === undefined ? session.files.read(path) : readMemoryFile(memory, path);
        if (!file) throw Object.assign(new Error(`memory file is missing: ${path}`), { code: 'missing' });
        if (!pickedPaths.includes(path)) pickedPaths.push(path);
        record.observations.push(path);
        return { path, content: file.content };
      }
      throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'method_not_found' });
    },
  };
}

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
    results.push({ name: event.action.type, status: event.status, text: event.result.slice(0, ACTION_RESULT_EXCERPT) });
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
    if (canonical === undefined || !MEMORY_SELECTION.pathPattern.test(canonical)) continue;
    if (canonical.toLowerCase() === MEMORY_SELECTION.indexFile) continue;
    targets.add(canonical);
  }
  return targets;
}
