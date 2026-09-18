import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Durable diagnostics for the latest in-app update install attempt.
 *
 * Exactly one JSON record is kept at <userData>/update-attempt.json. The file
 * lives outside every update cleanup root (`.wrenyard-update-*` under userData
 * and `.wrenyard-desktop-update-*` next to the install), so a failed update
 * never erases its own diagnostics. It is overwritten only when a NEW install
 * attempt begins — never by update discovery or checks — and everything written
 * into it is bounded and sanitized: no credentials, tokens, URLs, personal
 * absolute paths, request bodies or environment content.
 */
export const UPDATE_ATTEMPT_SCHEMA = 'wrenyard.desktop-update-attempt.v1';
export const UPDATE_ATTEMPT_FILENAME = 'update-attempt.json';

const DETAIL_LIMIT = 240;
const VERSION_PATTERN = /^v?[0-9A-Za-z.+-]{1,64}$/u;

export type UpdateAttemptStatus = 'in-progress' | 'succeeded' | 'failed' | 'cancelled';

/** Current phase while in progress; the failing phase once the attempt failed. */
export type UpdateAttemptPhase =
  | 'prepare'
  | 'download'
  | 'checksum'
  | 'extract'
  | 'stage'
  | 'waiting'
  | 'launch-helper'
  | 'parent-wait'
  | 'backup'
  | 'swap'
  | 'verify'
  | 'suite-update'
  | 'relaunch'
  | 'unknown';

/** What happened to the previously installed Desktop after a failed swap. */
export type UpdateAttemptRecovery =
  | 'none'
  | 'restored-previous'
  | 'removed-incomplete'
  | 'restore-failed'
  | 'cleanup-only';

export interface UpdateAttemptRecord {
  schema: string;
  sourceVersion: string;
  targetVersion: string;
  startedAt: number;
  completedAt?: number;
  status: UpdateAttemptStatus;
  phase: UpdateAttemptPhase;
  error?: string;
  exitCode?: number | null;
  recovery?: UpdateAttemptRecovery;
}

const STATUSES: readonly UpdateAttemptStatus[] = ['in-progress', 'succeeded', 'failed', 'cancelled'];
const PHASES: readonly UpdateAttemptPhase[] = [
  'prepare',
  'download',
  'checksum',
  'extract',
  'stage',
  'waiting',
  'launch-helper',
  'parent-wait',
  'backup',
  'swap',
  'verify',
  'suite-update',
  'relaunch',
  'unknown',
];
const RECOVERIES: readonly UpdateAttemptRecovery[] = [
  'none',
  'restored-previous',
  'removed-incomplete',
  'restore-failed',
  'cleanup-only',
];

export function updateAttemptPath(userDataPath: string): string {
  return join(userDataPath, UPDATE_ATTEMPT_FILENAME);
}

/**
 * Bounded, sanitized free-form detail. Credentials are redacted before URL and
 * path stripping so a secret used as a URL or path value never survives.
 */
export function sanitizeUpdateAttemptDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\b(?:authorization|passwd|password|secret|(?:access[-_]?|refresh[-_]?)?token|api[-_]?key|access[-_]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:Bearer\s+|Basic\s+)?[^\s,;]+)/giu, '[redacted]')
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/[A-Za-z]:[\\/][^\s"']*/gu, '[path]')
    .replace(/\\\\[^\s"']*/gu, '[path]')
    .replace(/(^|[\s"'])(?:~|\/(?:Users|home|private|var|tmp)\/)[^\s"']*/gu, '$1[path]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, DETAIL_LIMIT);
  return sanitized.length > 0 ? sanitized : undefined;
}

function boundedVersion(value: unknown): string | undefined {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : undefined;
}

function boundedTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read and re-sanitize the durable record. A malformed, foreign or hand-edited
 * document is treated as absent; this never throws.
 */
export function readUpdateAttempt(userDataPath: string): UpdateAttemptRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(updateAttemptPath(userDataPath), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schema !== UPDATE_ATTEMPT_SCHEMA) return undefined;
  const sourceVersion = boundedVersion(record.sourceVersion);
  const targetVersion = boundedVersion(record.targetVersion);
  const startedAt = boundedTimestamp(record.startedAt);
  const status = STATUSES.find((candidate) => candidate === record.status);
  if (!sourceVersion || !targetVersion || startedAt === undefined || !status) return undefined;
  const completedAt = boundedTimestamp(record.completedAt);
  const error = sanitizeUpdateAttemptDetail(record.error);
  const exitCode = record.exitCode === null ? null
    : typeof record.exitCode === 'number' && Number.isFinite(record.exitCode) ? record.exitCode
      : undefined;
  const recovery = RECOVERIES.find((candidate) => candidate === record.recovery);
  return {
    schema: UPDATE_ATTEMPT_SCHEMA,
    sourceVersion,
    targetVersion,
    startedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    status,
    phase: PHASES.find((candidate) => candidate === record.phase) ?? 'unknown',
    ...(error !== undefined ? { error } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(recovery !== undefined ? { recovery } : {}),
  };
}

/** Atomically replace the single durable record (temp file + rename, mode 0600). */
export function writeUpdateAttempt(userDataPath: string, record: UpdateAttemptRecord): void {
  const path = updateAttemptPath(userDataPath);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...record, error: sanitizeUpdateAttemptDetail(record.error) })}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}
