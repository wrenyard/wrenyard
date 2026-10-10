import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import type { FilesPort } from './ports.ts';
import type { WorkspaceSnapshot } from './ledger.ts';
import { headerField } from './documents.ts';

/** One catalogued project document, derived from its Markdown header. */
export interface DocCatalogEntry {
  path: string;
  title: string;
  status: string;
  updated: string;
  length: number;
}

function title(path: string, content: string): string {
  return /^# (.+)$/m.exec(content)?.[1]?.trim() ?? basename(path);
}
function syntax(path: string): void {
  if (!path || path.includes('\\') || path.includes('\0') || isAbsolute(path)
    || path.includes(':') || path.split('/').some((part) => !part || part === '..' || part === '.')
    || !path.endsWith('.md')) throw new Error('Expected a workspace-relative Markdown path without traversal');
}
function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}
export function safePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!contained(root, absolute)) throw new Error('Path leaves workspace');
  return absolute;
}
export function readInternal(root: string, path: string): string {
  try {
    const absolute = safePath(root, path);
    if (!existsSync(absolute)) return '';
    return readFileSync(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
/** Read a `状态`/`status` (or `更新`/`updated`) value from a `>` header block. */
export function readDocumentRules(workspaceRoot: string): string {
  return readInternal(workspaceRoot, 'instructions/documents.md');
}
export class WorkspaceFileSource implements FilesPort {
  private readonly root: string;
  private readonly snapshot: WorkspaceSnapshot;
  constructor(options: { workspaceRoot: string; snapshot: WorkspaceSnapshot }) {
    this.root = options.workspaceRoot;
    this.snapshot = options.snapshot;
  }
  checkPath(path: string): { ok: true; kind: 'memory' | 'doc' } | { ok: false; reason: string } {
    try {
      syntax(path);
      let kind: 'memory' | 'doc';
      if (/^memories\/[^/]+\.md$/u.test(path) && path.toLowerCase() !== 'memories/index.md') kind = 'memory';
      else {
        const doc = this.snapshot.projects.some((project) => path.startsWith(project.workspaceDir + '/docs/'));
        const instructions = this.snapshot.projects.some((project) =>
          path.endsWith('/AGENTS.md') && (project.workspaceDir === path.slice(0, -10)
            || project.workspaceDir.startsWith(path.slice(0, -10) + '/')));
        if (!doc && !instructions) throw new Error('Path is outside memory, project docs and associated instructions');
        kind = 'doc';
      }
      safePath(this.root, path);
      return { ok: true, kind };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  exists(path: string): boolean {
    if (!this.checkPath(path).ok) return false;
    try { return statSync(safePath(this.root, path)).isFile(); } catch { return false; }
  }
  read(path: string): { path: string; title: string; content: string } | undefined {
    if (!this.checkPath(path).ok) return undefined;
    try {
      const absolute = safePath(this.root, path);
      if (!statSync(absolute).isFile()) return undefined;
      const content = readFileSync(absolute, 'utf8');
      return { path, title: title(path, content), content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  instructionChain(workspaceDir: string, _docPath: string): string[] {
    const pieces = workspaceDir.split('/');
    if (pieces[0] !== 'projects' || pieces.length < 2) return [];
    const paths: string[] = [];
    for (let length = 2; length <= pieces.length; length++) {
      const path = pieces.slice(0, length).join('/') + '/AGENTS.md';
      if (this.exists(path)) paths.push(path);
    }
    return paths;
  }
  readDocumentRules(): string { return readDocumentRules(this.root); }
  /** Catalogue every registered project document, most-specific owner, path sorted. */
  listDocuments(): DocCatalogEntry[] {
    const entries = new Map<string, DocCatalogEntry>();
    for (const project of this.snapshot.projects) {
      this.walkDocuments(project.workspaceDir + '/docs', (path, content) => {
        const owner = this.snapshot.projects
          .filter((candidate) => path.startsWith(candidate.workspaceDir + '/docs/'))
          .sort((a, b) => b.workspaceDir.length - a.workspaceDir.length)[0];
        if (owner?.id !== project.id || entries.has(path)) return;
        entries.set(path, {
          path,
          title: title(path, content),
          status: headerField(content, ['状态', 'status']),
          updated: headerField(content, ['更新', '更新时间', 'updated', 'update']),
          length: content.length,
        });
      });
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  private walkDocuments(dir: string, visit: (path: string, content: string) => void): void {
    let absolute: string;
    try { absolute = safePath(this.root, dir); } catch { return; }
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { this.walkDocuments(path, visit); continue; }
      if (!entry.isFile() || !path.endsWith('.md')) continue;
      const doc = this.read(path);
      if (doc) visit(path, doc.content);
    }
  }
}
