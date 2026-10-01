import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, basename } from 'node:path';
import type { FilesPort, SnapshotInput } from './engine.ts';
import type { WorkspaceSnapshot } from './ledger.ts';

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
function safePath(root: string, path: string): string {
  const actualRoot = realpathSync(root);
  const absolute = resolve(actualRoot, path);
  if (!contained(actualRoot, absolute)) throw new Error('Path leaves workspace');
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Path has no workspace ancestor');
    ancestor = parent;
  }
  if (!contained(actualRoot, realpathSync(ancestor))) throw new Error('Symlink leaves workspace');
  return absolute;
}
function readInternal(root: string, path: string): string {
  try {
    const absolute = safePath(root, path);
    if (!existsSync(absolute)) return '';
    return readFileSync(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
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
}
export async function createWorkspaceSnapshot(input: SnapshotInput): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = {
    takenAt: input.takenAt.toISOString(), deviceName: input.deviceName,
    agents: readInternal(input.workspaceRoot, 'AGENTS.md'),
    memoryIndex: readInternal(input.workspaceRoot, 'memories/INDEX.md'),
    builtinTasks: input.builtinTasks.map((task) => ({ ...task })),
    projects: input.projects.map((project) => ({ ...project, tasks: project.tasks.map((task) => ({ ...task })), recentDocs: [] })),
  };
  const source = new WorkspaceFileSource({ workspaceRoot: input.workspaceRoot, snapshot });
  const today = Date.UTC(input.takenAt.getFullYear(), input.takenAt.getMonth(), input.takenAt.getDate());
  for (const project of snapshot.projects) {
    const visited = new Set<string>();
    const walk = (dir: string): void => {
      const absolute = safePath(input.workspaceRoot, dir);
      if (!existsSync(absolute)) return;
      const actual = realpathSync(absolute);
      if (visited.has(actual)) return;
      visited.add(actual);
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const path = dir + '/' + entry.name;
        const target = safePath(input.workspaceRoot, path);
        if (statSync(target).isDirectory()) { walk(path); continue; }
        const match = /^(\d{4}-\d{2}-\d{2})-.+\.md$/u.exec(entry.name);
        if (!match) continue;
        const date = Date.parse(match[1]! + 'T00:00:00Z');
        const age = (today - date) / 86400000;
        if (!Number.isFinite(age) || age < 0 || age >= 7) continue;
        const owner = snapshot.projects.filter((candidate) => path.startsWith(candidate.workspaceDir + '/docs/'))
          .sort((a, b) => b.workspaceDir.length - a.workspaceDir.length)[0];
        if (owner?.id !== project.id) continue;
        const doc = source.read(path);
        if (doc) project.recentDocs.push({ path, title: doc.title });
      }
    };
    for (const type of ['specs', 'plans', 'reports', 'handoff']) walk(project.workspaceDir + '/docs/' + type);
    project.recentDocs.sort((a, b) => basename(b.path).localeCompare(basename(a.path)) || a.path.localeCompare(b.path));
  }
  return snapshot;
}
