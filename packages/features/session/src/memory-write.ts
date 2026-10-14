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

/** The narrow workspace memory surface the engine may use after a reply. */
export interface WorkspaceMemoryPort {
  /** Current `memories/INDEX.md` text, or the empty string when unreadable. */
  index(): string;
  /** Upsert one memory by frontmatter name; records every real file write. */
  save(candidate: unknown, record: (change: MemoryChange) => Promise<void>): Promise<void>;
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

/** Build the memory store over one workspace root. */
export function createWorkspaceMemory(workspaceRoot: string): WorkspaceMemoryPort {
  const root = realpathSync(workspaceRoot);
  const directory = join(root, 'memories');
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

  const apply = async (raw: unknown, record: (change: MemoryChange) => Promise<void>): Promise<void> => {
    const candidate = parseCandidate(raw);
    // Prevalidate every path this save may touch before the first write.
    const directoryExists = directDirectory(directory) !== undefined;
    directFile(indexPath);

    const matches: { filename: string; data: Record<string, unknown>; body: string }[] = [];
    if (directoryExists) {
      for (const filename of readdirSync(directory).sort()) {
        if (filename === 'INDEX.md' || !filename.endsWith('.md')) continue;
        const path = join(directory, filename);
        directFile(path);
        let parsed: { data: Record<string, unknown>; body: string };
        try {
          parsed = readFrontmatter(readFileSync(path, 'utf8'));
        } catch {
          // An unrelated malformed file is left untouched, not repaired.
          continue;
        }
        if (parsed.data.name === candidate.name) matches.push({ filename, ...parsed });
      }
    }
    if (matches.length > 1) throw new Error('existing memory name is ambiguous');
    const before = matches[0];
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
    const changed = before === undefined
      || before.data.description !== candidate.description
      || oldType !== candidate.type
      || before.body !== candidate.content;
    // A changed existing fact may only be replaced when its exact current body
    // was supplied, so a stale or blind write can never drop valid content.
    if (before !== undefined && changed
      && (candidate.previous === undefined || normal(candidate.previous) !== before.body)) {
      throw new Error('memory changed or was not read; supply its exact current body as previous');
    }

    const content = `---\n${stringify({
      ...(before?.data ?? {}),
      name: candidate.name,
      description: candidate.description,
      metadata: { ...(isObject(metadata) ? metadata : {}), type: candidate.type },
    })}---\n\n${candidate.content}\n`;
    const oldIndex = directFile(indexPath) !== undefined ? readFileSync(indexPath, 'utf8') : '';
    const nextIndex = updateIndex(oldIndex, candidate.name, filename, candidate.description);

    if (!directoryExists) mkdirSync(directory, { recursive: true });
    if (changed) {
      atomicWrite(path, content);
      await record({ path: `memories/${filename}`, content });
    }
    if (nextIndex.text !== oldIndex) {
      directDirectory(directory);
      directFile(indexPath);
      atomicWrite(indexPath, nextIndex.text);
      await record({ path: 'memories/INDEX.md', content: nextIndex.entry });
    }
  };

  return {
    index,
    save(raw, record) {
      const previous = queues.get(root) ?? Promise.resolve();
      const run = previous.then(() => apply(raw, record));
      // Keep the queue alive after a failure so later saves still run.
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      queues.set(root, tail);
      void tail.then(() => {
        if (queues.get(root) === tail) queues.delete(root);
      });
      return run;
    },
  };
}
