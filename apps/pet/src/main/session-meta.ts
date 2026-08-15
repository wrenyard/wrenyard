// src/main/session-meta.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionMetaData } from './forge-types';

// ── Project inference from workDir ──

/**
 * Walk up from `workDir` to find a directory containing `.fmproj`.
 * Returns the basename of that directory (the project name), or undefined.
 */
function findProjectFromWorkDir(workDir: string): string | undefined {
  let current = path.resolve(workDir);
  const root = path.parse(current).root;

  for (let i = 0; i < 32; i++) {
    const fmprojPath = path.join(current, '.fmproj');
    if (fs.existsSync(fmprojPath)) {
      return path.basename(current);
    }
    if (current === root) break;
    current = path.dirname(current);
  }

  return undefined;
}

// ── isWorktree inference from path heuristics ──

/**
 * Detect if `workDir` is a git worktree:
 * 1. Path contains `.worktrees/` segment
 * 2. `.git` exists as a FILE (worktree pointer) rather than a directory (normal repo)
 */
function isWorktreeFromPath(workDir: string): boolean {
  // Heuristic: path contains .worktrees segment
  if (workDir.includes('.worktrees')) return true;

  // Check if .git is a file (worktree pointer) vs directory (normal repo)
  const gitPath = path.join(workDir, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isFile()) return true;  // worktree: .git is a file
    // .git is a directory → normal repo
  } catch {
    // .git doesn't exist at all
  }

  return false;
}

// ── Internal loader (pure function, takes sessionDir path) ──

interface RawSessionJson {
  fg_id?: string;
  profile?: string;
  client_family?: string;
  work_dir?: string;
  label?: string;
  status?: string;
}

/**
 * Load session metadata from a forge session directory path.
 * This is the internal helper function — callable directly for unit testing.
 *
 * - Reads `session.json` for basic fields
 * - Infers project name from `work_dir` by finding `.fmproj` ancestor
 * - Infers `isWorktree` from path heuristics
 *
 * Returns null if session.json is missing or malformed.
 */
export function loadSessionMeta(sessionDir: string): SessionMetaData | null;
/**
 * Load session metadata by workerIdentityKey, resolving the session directory via sessionsRoot.
 * Per final review: this is the primary entry point.
 *
 * @param workerIdentityKey - forge session ID
 * @param sessionsRoot - root directory containing session directories
 */
export function loadSessionMeta(workerIdentityKey: string, sessionsRoot: string): SessionMetaData | null;
export function loadSessionMeta(
  sessionDirOrKey: string,
  sessionsRoot?: string,
): SessionMetaData | null {
  // If sessionsRoot is provided, resolve workerIdentityKey→sessionDir first
  const sessionDir = sessionsRoot !== undefined
    ? path.join(sessionsRoot, sessionDirOrKey)
    : sessionDirOrKey;

  const sessionJsonPath = path.join(sessionDir, 'session.json');

  if (!fs.existsSync(sessionJsonPath)) return null;

  let raw: RawSessionJson;
  try {
    raw = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf-8'));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object') return null;

  const workerIdentityKey = raw.fg_id ?? path.basename(sessionDir);
  const profile = raw.profile ?? 'unknown';
  const clientFamily = typeof raw.client_family === 'string' ? raw.client_family : undefined;
  const workDir = raw.work_dir ?? '';
  const status = raw.status ?? 'unknown';

  const project = workDir ? findProjectFromWorkDir(workDir) : undefined;
  const worktree = workDir ? isWorktreeFromPath(workDir) : false;

  const meta: SessionMetaData = {
    workerIdentityKey,
    profile,
    workDir,
    status,
    isWorktree: worktree,
  };

  if (clientFamily !== undefined) {
    meta.clientFamily = clientFamily;
  }
  if (raw.label !== undefined) {
    meta.label = raw.label;
  }
  if (project !== undefined) {
    meta.project = project;
  }

  return meta;
}
