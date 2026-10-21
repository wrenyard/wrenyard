/**
 * workspace memory writing: one narrow, non-destructive upsert into the
 * workspace `memories/` store. It is used only after a terminal reply has been
 * accepted, so it exposes exactly one index read and one name-based save; it
 * never deletes or renames an existing memory.
 */

import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

/** One file a save actually changed: a memory file, or the memory index. */
export interface MemoryChange {
  /** Workspace-relative path of the written file. */
  path: string;
  /** The saved memory file, or the affected index line for `INDEX.md`. */
  content: string;
}

/** One memory file as listed: its name, its file, and its size and write time. */
export interface MemoryFileEntry {
  /** Frontmatter name of the memory; the file stem. */
  name: string;
  /** File name inside the memory directory. */
  filename: string;
  size: number;
  updatedAt: string;
}

/** One memory file with its full text, frontmatter included. */
export interface MemoryFileText {
  name: string;
  filename: string;
  text: string;
}

/** The memory to remove, with the exact body it must still carry. */
export interface MemoryRemoval {
  /** Frontmatter name of the memory. */
  name: string;
  /** Exact current body; when supplied a mismatch refuses the removal. */
  previous?: string;
}

/** Bounded summary of one serialized consolidation pass. */
export interface MemoryConsolidationReport {
  /** Frontmatter names whose duplicate files were merged into the keeper. */
  merged: string[];
  /** Frontmatter names removed during merge or prune. */
  pruned: string[];
  /** Whether `INDEX.md` was rewritten from the surviving memory set. */
  indexRebuilt: boolean;
}

/** The narrow workspace memory surface the engine may use after a reply. */
export interface WorkspaceMemoryPort {
  /** Current `memories/INDEX.md` text, or the empty string when unreadable. */
  index(): string;
  /** Every memory file except the index, ordered by file name. */
  list(): MemoryFileEntry[];
  /** Read one memory by its frontmatter name; a missing one fails. */
  read(name: string): MemoryFileText;
  /** Upsert one memory by frontmatter name; records every real file write. */
  save(candidate: unknown, record: (change: MemoryChange) => Promise<void>): Promise<void>;
  /** Delete one memory by name and drop its index line; records both. */
  remove(candidate: unknown, record: (change: MemoryChange) => Promise<void>): Promise<void>;
  /** Merge duplicate subjects, prune orphans, and rebuild the index; serialized per root. */
  consolidate(): Promise<MemoryConsolidationReport>;
}

/** Normalize a memory subject for duplicate detection; kebab names collapse trivial variants. */
export function normalizeMemorySubject(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/_/gu, '-').replace(/-+/gu, '-');
}

/**
 * The memory store one session uses: the host's per-session store when it keeps
 * one (then `undefined` means none), otherwise the workspace store.
 */
export function memoryPortOf(
  ports: { memory?: WorkspaceMemoryPort; memoryFor?(sessionId: string): WorkspaceMemoryPort | undefined },
  sessionId: string,
): WorkspaceMemoryPort | undefined {
  return ports.memoryFor === undefined ? ports.memory : ports.memoryFor(sessionId);
}

const TYPES: ReadonlySet<string> = new Set(['user', 'feedback', 'project', 'reference']);
/** Non-reserved kebab-case: lowercase words joined by single hyphens. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** A safe memory filename: no separators, no traversal, ends in `.md`. */
const FILE = /^[A-Za-z0-9._-]+\.md$/u;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u;

/**
 * Serialize read-modify-write per workspace root across sessions, so two
 * concurrent saves cannot lose an update or interleave a write.
 */
const queues = new Map<string, Promise<void>>();

/** Normalize a body for comparison: LF line endings, no surrounding space. */
function normal(text: string): string {
  return text.replace(/\r\n/gu, '\n').trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface Memory {
  name: string;
  description: string;
  type: string;
  content: string;
  previous?: string;
}

/** Validate one model-supplied candidate; a malformed candidate is refused. */
function parseCandidate(raw: unknown): Memory {
  if (!isObject(raw)) throw new Error('memory candidate must be an object');
  for (const key of ['name', 'description', 'type', 'content']) {
    if (typeof raw[key] !== 'string') throw new Error(`memory ${key} must be a string`);
  }
  const name = raw.name as string;
  const description = raw.description as string;
  const type = raw.type as string;
  const content = raw.content as string;
  if (!NAME.test(name) || name.length > 120 || name === 'index') {
    throw new Error('memory name must be a non-reserved kebab-case name');
  }
  if (!TYPES.has(type)) throw new Error('memory type must be user, feedback, project or reference');
  if (description.trim() === '' || description.length > 300 || /[\r\n\0]/u.test(description)) {
    throw new Error('memory description must be one nonempty line');
  }
  if (normal(content) === '' || content.length > 4000 || content.includes('\0')) {
    throw new Error('memory content must be a nonempty fact body');
  }
  const previous = raw.previous;
  if (previous !== undefined && typeof previous !== 'string') {
    throw new Error('memory previous body must be a string');
  }
  return {
    name,
    description: description.trim(),
    type,
    content: normal(content),
    ...(previous === undefined ? {} : { previous }),
  };
}

/** Validate one removal: a legal name and an optional exact previous body. */
function parseRemoval(raw: unknown): MemoryRemoval {
  if (!isObject(raw)) throw new Error('memory removal must be an object');
  const name = raw.name;
  if (typeof name !== 'string' || !NAME.test(name) || name === 'index') {
    throw new Error('memory name must be a non-reserved kebab-case name');
  }
  const previous = raw.previous;
  if (previous !== undefined && typeof previous !== 'string') {
    throw new Error('memory previous body must be a string');
  }
  return { name, ...(previous === undefined ? {} : { previous }) };
}

/** `lstat`, with a missing path reported as `undefined` instead of throwing. */
function lstat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * A direct child that must be a regular file. `lstat` does not follow links,
 * so a symlink — including a dangling one — is refused rather than read.
 */
function directFile(path: string): Stats | undefined {
  const stat = lstat(path);
  if (stat !== undefined && !stat.isFile()) {
    throw new Error(`memory path is a symlink or not a regular file: ${path}`);
  }
  return stat;
}

/** A direct child that must be a real directory, never a symlink. */
function directDirectory(path: string): Stats | undefined {
  const stat = lstat(path);
  if (stat !== undefined && !stat.isDirectory()) {
    throw new Error(`memory path is a symlink or not a directory: ${path}`);
  }
  return stat;
}

/** Parse an existing memory's YAML frontmatter and normalized body. */
function readFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (match === null) throw new Error('existing memory has no frontmatter');
  const data: unknown = parse(match[1]!);
  if (!isObject(data) || typeof data.name !== 'string') {
    throw new Error('existing memory frontmatter has no name');
  }
  return { data, body: normal(match[2]!) };
}

/** Replace a file atomically through a unique sibling then rename. */
function atomicWrite(path: string, content: string): void {
  const mode = lstat(path)?.mode;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: mode === undefined ? 0o600 : mode & 0o777 });
    renameSync(temporary, path);
  } finally {
    // Only this operation's temporary file, never an existing memory.
    rmSync(temporary, { force: true });
  }
}

/** The one index line for a memory, in the existing Markdown link syntax. */
function indexLine(name: string, filename: string, description: string): string {
  return `- [${name}](${filename}) — ${description}`;
}

/** True when an index line already points at this name or file. */
function references(line: string, name: string, filename: string): boolean {
  for (const match of line.matchAll(/\[([^\]\r\n]*)\]\(\s*<?([^()<>\s]+)>?\s*\)/gu)) {
    const target = match[2]!.replace(/^\.\//u, '').replace(/^memories\//u, '');
    if (match[1] === name || target === filename) return true;
  }
  const bare = line.trim().replace(/^[-*+]\s+/u, '');
  return bare === `memories/${filename}` || bare === `./${filename}` || bare === filename;
}

/** The memory name a file name carries: its stem without the `.md` suffix. */
function stemOf(filename: string): string {
  return filename.slice(0, -'.md'.length);
}

/** Drop every index line that points at one memory; other lines stay as they are. */
function dropFromIndex(text: string, name: string, filename: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.split(/\r?\n/u).filter((line) => !references(line, name, filename)).join(eol);
}

/**
 * Keep exactly one link line for the targeted memory: the first matching line is
 * replaced in place and later duplicates are dropped, so unrelated entries are
 * left byte-for-byte. A missing entry is appended.
 */
function updateIndex(
  text: string,
  name: string,
  filename: string,
  description: string,
): { text: string; entry: string } {
  const entry = indexLine(name, filename, description);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let replaced = false;
  const lines = text.split(/\r?\n/u).flatMap((line) => {
    if (!references(line, name, filename)) return [line];
    if (replaced) return [];
    replaced = true;
    return [entry];
  });
  if (!replaced) {
    if (lines.at(-1) === '') lines.pop();
    lines.push(entry, '');
  }
  return { text: lines.join(eol), entry };
}

/**
 * Build the memory store over one root. `directoryName` defaults to the
 * workspace `memories` store; a bot passes `memory` so its memories live in
 * `<bot directory>/memory` without changing the workspace default.
 */
export function createWorkspaceMemory(workspaceRoot: string, directoryName = 'memories'): WorkspaceMemoryPort {
  const root = realpathSync(workspaceRoot);
  const directory = join(root, directoryName);
  const indexPath = join(directory, 'INDEX.md');

  const index = (): string => {
    try {
      if (directDirectory(directory) === undefined) return '';
      if (directFile(indexPath) === undefined) return '';
      return readFileSync(indexPath, 'utf8');
    } catch {
      // Retrieval stays available without an index; saves report path errors.
      return '';
    }
  };

  type ParsedMemory = { filename: string; data: Record<string, unknown>; body: string };

  /** Every parsed memory file in the directory, skipping malformed entries. */
  const listParsed = (): ParsedMemory[] => {
    if (directDirectory(directory) === undefined) return [];
    const found: ParsedMemory[] = [];
    for (const filename of readdirSync(directory).sort()) {
      if (filename === 'INDEX.md' || !filename.endsWith('.md')) continue;
      const path = join(directory, filename);
      directFile(path);
      try {
        const parsed = readFrontmatter(readFileSync(path, 'utf8'));
        found.push({ filename, ...parsed });
      } catch {
        continue;
      }
    }
    return found;
  };

  /**
   * The stored memory for one subject. Exact frontmatter name wins; otherwise
   * the first file whose normalized subject matches.
   */
  const findBySubject = (name: string): ParsedMemory | undefined => {
    const subject = normalizeMemorySubject(name);
    const matches = listParsed().filter((entry) => {
      const entryName = typeof entry.data.name === 'string' ? entry.data.name : stemOf(entry.filename);
      return entry.data.name === name || normalizeMemorySubject(entryName) === subject;
    });
    if (matches.length > 1) throw new Error('existing memory subject is ambiguous');
    return matches[0];
  };

  const list = (): MemoryFileEntry[] => {
    try {
      if (directDirectory(directory) === undefined) return [];
    } catch {
      return [];
    }
    const found: MemoryFileEntry[] = [];
    for (const filename of readdirSync(directory).sort()) {
      if (filename === 'INDEX.md' || !FILE.test(filename)) continue;
      const path = join(directory, filename);
      const stat = lstat(path);
      if (stat === undefined || !stat.isFile()) continue;
      found.push({
        name: stemOf(filename),
        filename,
        size: stat.size,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      });
    }
    return found;
  };

  const read = (name: string): MemoryFileText => {
    if (!NAME.test(name) || name === 'index') {
      throw new Error('memory name must be a non-reserved kebab-case name');
    }
    const filename = `${name}.md`;
    const path = join(directory, filename);
    if (directFile(path) === undefined) throw new Error(`memory ${name} does not exist`);
    return { name, filename, text: readFileSync(path, 'utf8') };
  };

  const applyRemove = async (
    raw: unknown,
    record: (change: MemoryChange) => Promise<void>,
  ): Promise<void> => {
    const candidate = parseRemoval(raw);
    // Prevalidate every path this removal may touch before the first change.
    directDirectory(directory);
    const before = findBySubject(candidate.name);
    if (before === undefined) throw new Error(`memory ${candidate.name} does not exist`);
    if (candidate.previous !== undefined && normal(candidate.previous) !== before.body) {
      throw new Error('memory changed or was not read; supply its exact current body as previous');
    }
    const path = join(directory, before.filename);
    directFile(path);
    const oldIndex = directFile(indexPath) !== undefined ? readFileSync(indexPath, 'utf8') : '';
    const nextIndex = dropFromIndex(oldIndex, candidate.name, before.filename);

    rmSync(path);
    if (nextIndex !== oldIndex) {
      atomicWrite(indexPath, nextIndex);
      await record({ path: `${directoryName}/INDEX.md`, content: '' });
    }
    await record({ path: `${directoryName}/${before.filename}`, content: '' });
  };

  const apply = async (raw: unknown, record: (change: MemoryChange) => Promise<void>): Promise<void> => {
    const candidate = parseCandidate(raw);
    // Prevalidate every path this save may touch before the first write.
    const directoryExists = directDirectory(directory) !== undefined;
    directFile(indexPath);

    const before = findBySubject(candidate.name);
    // Upsert by name: keep the existing filename, never rename an existing memory.
    const filename = before?.filename ?? `${candidate.name}.md`;
    if (!FILE.test(filename) || filename.toLowerCase() === 'index.md') {
      throw new Error(`memory filename cannot be safely indexed: ${filename}`);
    }
    const path = join(directory, filename);
    if (before === undefined && directFile(path) !== undefined) {
      throw new Error(`memory filename already belongs to another entry: ${filename}`);
    }

    const metadata = before?.data.metadata;
    const oldType = isObject(metadata) ? metadata.type : undefined;
    const bodyChanged = before !== undefined && before.body !== candidate.content;
    const metaChanged = before === undefined
      || before.data.description !== candidate.description
      || oldType !== candidate.type;
    // A changed existing fact may only be replaced when its exact current body
    // was supplied, so a stale or blind write can never drop valid content.
    if (bodyChanged
      && (candidate.previous === undefined || normal(candidate.previous) !== before!.body)) {
      throw new Error('memory changed or was not read; supply its exact current body as previous');
    }

    const now = new Date().toISOString();
    const created = typeof before?.data.created === 'string' ? before.data.created : now;
    const content = `---\n${stringify({
      ...(before?.data ?? {}),
      name: candidate.name,
      description: candidate.description,
      created,
      updated: now,
      metadata: { ...(isObject(metadata) ? metadata : {}), type: candidate.type },
    })}---\n\n${candidate.content}\n`;
    const oldIndex = directFile(indexPath) !== undefined ? readFileSync(indexPath, 'utf8') : '';
    const nextIndex = updateIndex(oldIndex, candidate.name, filename, candidate.description);

    if (!directoryExists) mkdirSync(directory, { recursive: true });
    atomicWrite(path, content);
    await record({ path: `${directoryName}/${filename}`, content });
    if (nextIndex.text !== oldIndex || metaChanged) {
      directDirectory(directory);
      directFile(indexPath);
      atomicWrite(indexPath, nextIndex.text);
      await record({ path: `${directoryName}/INDEX.md`, content: nextIndex.entry });
    }
  };

  const applyConsolidate = async (): Promise<MemoryConsolidationReport> => {
    if (directDirectory(directory) === undefined) {
      return { merged: [], pruned: [], indexRebuilt: false };
    }
    const merged: string[] = [];
    const pruned: string[] = [];
    const parsed = listParsed();
    const bySubject = new Map<string, ParsedMemory[]>();
    for (const entry of parsed) {
      const entryName = typeof entry.data.name === 'string' ? entry.data.name : stemOf(entry.filename);
      const subject = normalizeMemorySubject(entryName);
      const group = bySubject.get(subject) ?? [];
      group.push(entry);
      bySubject.set(subject, group);
    }
    for (const group of bySubject.values()) {
      if (group.length <= 1) continue;
      const sorted = [...group].sort((left, right) => {
        const leftUpdated = typeof left.data.updated === 'string' ? left.data.updated : '';
        const rightUpdated = typeof right.data.updated === 'string' ? right.data.updated : '';
        return rightUpdated.localeCompare(leftUpdated) || left.filename.localeCompare(right.filename);
      });
      const keeper = sorted[0]!;
      const keeperName = typeof keeper.data.name === 'string' ? keeper.data.name : stemOf(keeper.filename);
      let body = keeper.body;
      const metadata = keeper.data.metadata;
      const keeperType = isObject(metadata) ? metadata.type : undefined;
      for (const duplicate of sorted.slice(1)) {
        body = body === duplicate.body ? body : `${body}\n\n${duplicate.body}`;
        pruned.push(typeof duplicate.data.name === 'string' ? duplicate.data.name : stemOf(duplicate.filename));
        rmSync(join(directory, duplicate.filename));
      }
      if (sorted.length > 1) merged.push(keeperName);
      const now = new Date().toISOString();
      const created = typeof keeper.data.created === 'string' ? keeper.data.created : now;
      const description = typeof keeper.data.description === 'string' ? keeper.data.description : keeperName;
      const content = `---\n${stringify({
        ...keeper.data,
        name: keeperName,
        description,
        created,
        updated: now,
        metadata: { ...(isObject(metadata) ? metadata : {}), ...(keeperType === undefined ? {} : { type: keeperType }) },
      })}---\n\n${body}\n`;
      atomicWrite(join(directory, keeper.filename), content);
    }
    const survivors = listParsed();
    const eol = '\n';
    const indexLines = survivors
      .map((entry) => {
        const entryName = typeof entry.data.name === 'string' ? entry.data.name : stemOf(entry.filename);
        const description = typeof entry.data.description === 'string' ? entry.data.description : entryName;
        return indexLine(entryName, entry.filename, description);
      })
      .sort((left, right) => left.localeCompare(right));
    const rebuilt = indexLines.length === 0 ? '' : `${indexLines.join(eol)}${eol}`;
    const oldIndex = directFile(indexPath) !== undefined ? readFileSync(indexPath, 'utf8') : '';
    const indexRebuilt = rebuilt !== oldIndex;
    if (indexRebuilt) atomicWrite(indexPath, rebuilt);
    return { merged, pruned, indexRebuilt };
  };

  /** Run one read-modify-write at a time, so two calls cannot interleave. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(root) ?? Promise.resolve();
    const run: Promise<T> = previous.then(() => task());
    // Keep the queue alive after a failure so later calls still run.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(root, tail);
    void tail.then(() => {
      if (queues.get(root) === tail) queues.delete(root);
    });
    return run;
  };

  return {
    index,
    list,
    read,
    save(raw, record) {
      return enqueue(() => apply(raw, record));
    },
    remove(raw, record) {
      return enqueue(() => applyRemove(raw, record));
    },
    consolidate() {
      return enqueue(() => applyConsolidate());
    },
  };
}
