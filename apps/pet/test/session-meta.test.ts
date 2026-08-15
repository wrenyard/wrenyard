// test/session-meta.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSessionMeta } from '../src/main/session-meta';
import type { SessionMetaData } from '../src/main/forge-types';

// ── Temp dir helpers ──

let tempDirs: string[] = [];

function makeTempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fpet-sm-'));
  tempDirs.push(d);
  return d;
}

function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function makeSessionDir(parent: string, workerIdentityKey: string): string {
  const d = path.join(parent, workerIdentityKey);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── SessionMeta — basic parsing ──

describe('loadSessionMeta', () => {
  it('parses session.json into SessionMetaData', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_meta_01');

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      fg_id: 'fg_meta_01',
      profile: 'cb-dsf',
      client_family: 'codex',
      work_dir: '/tmp/work',
      label: 'my task',
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta).toEqual<SessionMetaData>({
      workerIdentityKey: 'fg_meta_01',
      profile: 'cb-dsf',
      clientFamily: 'codex',
      workDir: '/tmp/work',
      label: 'my task',
      project: undefined,
      isWorktree: false,
      status: 'running',
    });
  });

  it('returns null when session.json is missing', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_no_meta');
    // No session.json created

    const meta = loadSessionMeta(sessDir);
    expect(meta).toBeNull();
  });

  it('returns null for malformed session.json', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_bad_meta');
    writeFile(path.join(sessDir, 'session.json'), 'not valid {{{ json');

    const meta = loadSessionMeta(sessDir);
    expect(meta).toBeNull();
  });

  it('uses fg_id from session.json when available', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_from_file');

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      fg_id: 'fg_override',
      profile: 'cb-ds',
      work_dir: '/tmp/w',
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.workerIdentityKey).toBe('fg_override');
  });

  it('handles missing optional fields gracefully', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_minimal');

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      // minimal: only required fields
      profile: 'codex',
      work_dir: '/tmp/min',
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.workerIdentityKey).toBe('fg_minimal');  // falls back to dir name
    expect(meta?.profile).toBe('codex');
    expect(meta?.label).toBeUndefined();
    expect(meta?.project).toBeUndefined();
    expect(meta?.isWorktree).toBe(false);
  });
});

// ── workerIdentityKey-based entry (per 终审) ──

describe('loadSessionMeta — workerIdentityKey-based entry', () => {
  it('resolves workerIdentityKey to sessionDir via sessionsRoot', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_from_id');

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      profile: 'cb-dsf',
      work_dir: '/tmp/w',
      status: 'running',
    }));

    // Call with 2 args: (workerIdentityKey, sessionsRoot)
    const meta = loadSessionMeta('fg_from_id', root);
    expect(meta).not.toBeNull();
    expect(meta?.workerIdentityKey).toBe('fg_from_id');
  });
});

// ── Project detection from workDir ──

describe('loadSessionMeta — project inference', () => {
  it('detects project from .fmproj in workDir', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_project');

    // Create workDir with .fmproj
    const workDir = path.join(root, 'work_project');
    fs.mkdirSync(workDir, { recursive: true });
    // Create a mock .fmproj host directory
    fs.mkdirSync(path.join(workDir, '.fmproj'), { recursive: true });

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      profile: 'cb-dsf',
      work_dir: workDir,
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.project).toBe(path.basename(workDir));
    expect(meta?.isWorktree).toBe(false);
  });

  it('detects project from .fmproj in ancestor directory', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_ancestor');

    const projectRoot = path.join(root, 'my-app');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.fmproj'), { recursive: true });

    const nestedDir = path.join(projectRoot, 'src', 'lib');
    fs.mkdirSync(nestedDir, { recursive: true });

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      profile: 'codex',
      work_dir: nestedDir,
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.project).toBe('my-app');
  });

  it('project is undefined when no .fmproj found', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_no_project');

    const workDir = path.join(root, 'no_project_here');
    fs.mkdirSync(workDir, { recursive: true });

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      profile: 'cb-dsf',
      work_dir: workDir,
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.project).toBeUndefined();
  });
});

// ── isWorktree detection ──

describe('loadSessionMeta — isWorktree inference', () => {
  it('detects isWorktree from path containing worktree marker', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_wt');

    // Path that looks like a git worktree
    const workDir = path.join(root, 'main-project', '.worktrees', 'feature-branch');
    fs.mkdirSync(workDir, { recursive: true });

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      profile: 'codex',
      work_dir: workDir,
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.isWorktree).toBe(true);
  });

  it('detects isWorktree from .git file (not directory)', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_git_file');

    const workDir = path.join(root, 'worktree-loc');
    fs.mkdirSync(workDir, { recursive: true });
    // Create .git as a FILE (worktree indicator) instead of directory
    writeFile(path.join(workDir, '.git'), 'gitdir: /some/other/path/.git/worktrees/wt\n');

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      profile: 'cb-dsf',
      work_dir: workDir,
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.isWorktree).toBe(true);
  });

  it('returns isWorktree=false for normal git repos', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_normal');

    const workDir = path.join(root, 'normal-repo');
    fs.mkdirSync(workDir, { recursive: true });
    // .git as a DIRECTORY (normal repo)
    fs.mkdirSync(path.join(workDir, '.git'), { recursive: true });

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      profile: 'cb-dsf',
      work_dir: workDir,
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.isWorktree).toBe(false);
  });

  it('returns isWorktree=false when no git directory exists', () => {
    const root = makeTempDir();
    const sessDir = makeSessionDir(root, 'fg_no_git');

    const workDir = path.join(root, 'no-git-here');
    fs.mkdirSync(workDir, { recursive: true });

    writeFile(path.join(sessDir, 'session.json'), JSON.stringify({
      profile: 'cb-dsf',
      work_dir: workDir,
      status: 'running',
    }));

    const meta = loadSessionMeta(sessDir);
    expect(meta?.isWorktree).toBe(false);
  });
});
