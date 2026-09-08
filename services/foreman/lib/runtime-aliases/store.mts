/**
 * Daemon-owned runtime alias store.
 *
 * Persists <XDG_CONFIG_HOME or ~/.config>/wrenyard/runtime/config.json as a
 * JSON document whose top-level contract is a non-negative integer `revision`
 * and an `aliases` object mapping a user alias name to a canonical
 * "provider/model:client" run string. Any unrelated top-level fields are
 * preserved verbatim across writes.
 *
 * Every mutation re-reads the file immediately before writing and applies an
 * optimistic expected-revision CAS: a mismatch raises RevisionConflictError
 * and never overwrites. Same-name data is only ever replaced through an
 * explicit put(). Invalid individual alias entries are surfaced as per-entry
 * issues while valid aliases remain usable; a malformed file or root fails
 * closed (MalformedStoreError) and is never rewritten.
 *
 * Writes are atomic: the parent directory is created and chmod'd to 0700, the
 * body is written to a same-directory temp file opened with mode 0600, the
 * file is fsynced, renamed over the target, and the directory fsync is
 * best-effort; temp residue is removed on failure.
 *
 * This module never reads credentials, the Go ProfileRecipe, source presets,
 * or shell shortcuts. Values are validated and canonicalized through the
 * shared @wrenyard/catalog parseRunSyntax/formatRunSyntax functions.
 */

import { promises as defaultFs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import { formatRunSyntax, parseRunSyntax } from '@wrenyard/catalog';

export type StoreFileSystem = Pick<
  typeof defaultFs,
  'mkdir' | 'chmod' | 'open' | 'readFile' | 'rename' | 'unlink'
>;

export interface RuntimeAliasStoreOptions {
  /** fs facade; every member defaults to node:fs/promises. */
  fs?: Partial<StoreFileSystem>;
  /** path facade; defaults to node:path. */
  path?: { join: typeof joinPath };
  /** HOME used only when XDG_CONFIG_HOME is absent. */
  home?: string;
  /** Environment snapshot consulted for XDG_CONFIG_HOME; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Explicit config directory; overrides env/home resolution. */
  configRoot?: string;
}

export interface AliasStoreIssue {
  alias: string;
  value: unknown;
  problem: string;
}

export interface AliasStoreSnapshot {
  revision: number;
  /** Only entries that parsed successfully; keys are raw names, values canonical. */
  aliases: Record<string, string>;
  issues: AliasStoreIssue[];
  exists: boolean;
}

export interface AliasMutationResult {
  alias: string;
  canonical: string;
  revision: number;
}

export interface AliasRemovalResult {
  alias: string;
  removed: boolean;
  revision: number;
}

export class RuntimeAliasStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class RevisionConflictError extends RuntimeAliasStoreError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`runtime alias revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = 'RevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class MalformedStoreError extends RuntimeAliasStoreError {
  readonly reason: string;

  constructor(reason: string) {
    super(`malformed runtime alias store: ${reason}`);
    this.name = 'MalformedStoreError';
    this.reason = reason;
  }
}

export class AliasValidationError extends RuntimeAliasStoreError {
  constructor(message: string) {
    super(message);
    this.name = 'AliasValidationError';
  }
}

/** Longest permitted alias name, in characters. */
const ALIAS_NAME_MAX_LENGTH = 64;

/**
 * Deterministic alias-name contract shared by put(), remove(), and persisted
 * entry classification: an ASCII name of 1-64 characters whose first
 * character is a lowercase letter or digit and whose remaining characters are
 * lowercase letters, digits, dot, underscore, or hyphen. Empty, overlength,
 * uppercase, whitespace, slash, colon, and any other characters are rejected.
 */
const ALIAS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Public alias-name validation boundary used by put()/remove() and suitable
 * for direct RPC/UI use. Throws AliasValidationError unless `name` is a
 * string satisfying the 1-64 ASCII alias-name contract.
 */
export function validateAliasName(name: unknown): void {
  if (typeof name !== 'string') {
    throw new AliasValidationError('alias name must be a string');
  }
  if (name.length === 0) {
    throw new AliasValidationError('alias name must not be empty');
  }
  if (name.length > ALIAS_NAME_MAX_LENGTH) {
    throw new AliasValidationError(
      `alias name must be at most ${ALIAS_NAME_MAX_LENGTH} ASCII characters (got ${name.length})`,
    );
  }
  if (!ALIAS_NAME_PATTERN.test(name)) {
    throw new AliasValidationError(
      'alias name must start with a lowercase letter or digit and contain only lowercase letters, digits, dot, underscore, or hyphen',
    );
  }
}

export function resolveConfigDir(
  env: Record<string, string | undefined>,
  homeDir: string,
  joinFn: typeof joinPath = joinPath,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = typeof xdg === 'string' && xdg.trim().length > 0 ? xdg : joinFn(homeDir, '.config');
  return joinFn(base, 'wrenyard', 'runtime');
}

type CanonicalResult = { canonical: string } | { error: string };

function describeCause(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);
}

function canonicalizeTarget(input: string): CanonicalResult {
  let parsed: unknown;
  try {
    parsed = parseRunSyntax(input);
  } catch (cause) {
    return { error: describeCause(cause) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `unrecognized run syntax: ${JSON.stringify(input)}` };
  }
  try {
    const canonical = formatRunSyntax(parsed as Parameters<typeof formatRunSyntax>[0]);
    if (typeof canonical !== 'string' || canonical.length === 0) {
      return { error: `could not canonicalize run syntax: ${JSON.stringify(input)}` };
    }
    return { canonical };
  } catch (cause) {
    return { error: describeCause(cause) };
  }
}

interface ReadState {
  revision: number;
  rawAliases: Record<string, unknown>;
  validAliases: Record<string, string>;
  issues: AliasStoreIssue[];
  extra: Record<string, unknown>;
  exists: boolean;
}

function emptyState(): ReadState {
  return { revision: 0, rawAliases: {}, validAliases: {}, issues: [], extra: {}, exists: false };
}

function classifyAliasEntries(raw: Record<string, unknown>): {
  valid: Record<string, string>;
  issues: AliasStoreIssue[];
} {
  const valid: Record<string, string> = {};
  const issues: AliasStoreIssue[] = [];
  for (const [alias, value] of Object.entries(raw)) {
    try {
      validateAliasName(alias);
    } catch (cause) {
      issues.push({ alias, value, problem: describeCause(cause) });
      continue;
    }
    if (typeof value !== 'string') {
      issues.push({ alias, value, problem: 'alias target must be a string' });
      continue;
    }
    const result = canonicalizeTarget(value);
    if ('error' in result) {
      issues.push({ alias, value, problem: result.error });
    } else {
      valid[alias] = result.canonical;
    }
  }
  return { valid, issues };
}

function parseStoreRoot(root: unknown): ReadState {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new MalformedStoreError('file root must be a JSON object');
  }
  const record = root as Record<string, unknown>;
  const { revision, aliases, ...extra } = record;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new MalformedStoreError(
      `"revision" must be a non-negative integer (got ${JSON.stringify(revision)})`,
    );
  }
  if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) {
    throw new MalformedStoreError('"aliases" must be an object');
  }
  const { valid, issues } = classifyAliasEntries(aliases as Record<string, unknown>);
  return {
    revision,
    rawAliases: aliases as Record<string, unknown>,
    validAliases: valid,
    issues,
    extra,
    exists: true,
  };
}

function parseStoreText(text: string): ReadState {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch (cause) {
    throw new MalformedStoreError(`invalid JSON: ${describeCause(cause)}`);
  }
  return parseStoreRoot(root);
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
}

/**
 * Daemon-owned, CAS-guarded, atomic alias store. fs/path/home/env are
 * injectable so tests can pin every instance to an isolated directory and
 * simulate failure modes without touching real user files.
 */
export class RuntimeAliasStore {
  readonly configDir: string;
  readonly configFilePath: string;

  private readonly fs: StoreFileSystem;
  private readonly join: typeof joinPath;

  /**
   * Serializes every read-check-write mutation (put/remove). Each queued
   * operation re-reads the file inside the queue, so overlapping mutations
   * observe each other's commits and the optimistic expectedRevision CAS
   * admits exactly one winner. The queue swallows rejections so a failed
   * mutation never blocks later ones.
   */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RuntimeAliasStoreOptions = {}) {
    const env: Record<string, string | undefined> =
      options.env ?? (process.env as Record<string, string | undefined>);
    const home = options.home ?? env.HOME ?? homedir();
    this.join = options.path?.join ?? joinPath;
    this.fs = {
      mkdir: options.fs?.mkdir ?? defaultFs.mkdir,
      chmod: options.fs?.chmod ?? defaultFs.chmod,
      open: options.fs?.open ?? defaultFs.open,
      readFile: options.fs?.readFile ?? defaultFs.readFile,
      rename: options.fs?.rename ?? defaultFs.rename,
      unlink: options.fs?.unlink ?? defaultFs.unlink,
    };
    this.configDir = options.configRoot ?? resolveConfigDir(env, home, this.join);
    this.configFilePath = this.join(this.configDir, 'config.json');
  }

  /** Load the current revision, usable (canonical) aliases, and per-entry issues. */
  async load(): Promise<AliasStoreSnapshot> {
    const state = await this.readState();
    return {
      revision: state.revision,
      aliases: { ...state.validAliases },
      issues: state.issues.map((issue) => ({ ...issue })),
      exists: state.exists,
    };
  }

  /** Convenience: only the usable aliases, keyed by raw name with canonical values. */
  async list(): Promise<Record<string, string>> {
    const state = await this.readState();
    return { ...state.validAliases };
  }

  /**
   * Set `alias` to `target`. The re-read / expectedRevision CAS / atomic
   * rewrite sequence runs inside the shared per-store mutation queue, so two
   * overlapping put() calls with the same expectedRevision cannot both
   * commit. Replacing an existing same-name entry is only possible through
   * this explicit put().
   */
  async put(alias: string, target: string, expectedRevision?: number): Promise<AliasMutationResult> {
    validateAliasName(alias);
    if (typeof target !== 'string' || target.length === 0) {
      throw new AliasValidationError('alias target must be a non-empty string');
    }
    const canonicalResult = canonicalizeTarget(target);
    if ('error' in canonicalResult) {
      throw new AliasValidationError(`invalid alias target "${target}": ${canonicalResult.error}`);
    }
    const canonical = canonicalResult.canonical;

    return this.enqueueMutation(async () => {
      const state = await this.readState();
      this.assertRevision(state.revision, expectedRevision);
      const revision = state.revision + 1;
      const aliases: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [name, value] of Object.entries(state.rawAliases)) {
        aliases[name] = value;
      }
      aliases[alias] = canonical;
      await this.writeJson({ ...state.extra, revision, aliases });
      return { alias, canonical, revision };
    });
  }

  /**
   * Remove `alias`. The re-read / expectedRevision CAS / rewrite sequence
   * runs inside the shared per-store mutation queue; removing an unknown
   * alias is a no-op that neither rewrites the file nor bumps the revision.
   */
  async remove(alias: string, expectedRevision?: number): Promise<AliasRemovalResult> {
    validateAliasName(alias);
    return this.enqueueMutation(async () => {
      const state = await this.readState();
      this.assertRevision(state.revision, expectedRevision);
      if (!Object.prototype.hasOwnProperty.call(state.rawAliases, alias)) {
        return { alias, removed: false, revision: state.revision };
      }
      const aliases: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [name, value] of Object.entries(state.rawAliases)) {
        aliases[name] = value;
      }
      delete aliases[alias];
      const revision = state.revision + 1;
      await this.writeJson({ ...state.extra, revision, aliases });
      return { alias, removed: true, revision };
    });
  }

  private assertRevision(actual: number, expected?: number): void {
    if (expected !== undefined && expected !== actual) {
      throw new RevisionConflictError(expected, actual);
    }
  }

  /**
   * Append a mutation onto the per-store queue. The returned promise adopts
   * the mutation outcome (success or rejection); the queue tail itself always
   * settles so one rejected mutation never blocks later ones.
   */
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readState(): Promise<ReadState> {
    let text: string;
    try {
      const data = await this.fs.readFile(this.configFilePath, 'utf8');
      text = typeof data === 'string' ? data : String(data);
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) {
        return emptyState();
      }
      throw cause;
    }
    return parseStoreText(text);
  }

  private async writeJson(payload: Record<string, unknown>): Promise<void> {
    const dir = this.configDir;
    await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.fs.chmod(dir, 0o700);

    const tempPath = this.join(dir, `.runtime-config.${process.pid}.${randomUUID()}.tmp`);
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    let handle: Awaited<ReturnType<StoreFileSystem['open']>> | null = null;
    try {
      handle = await this.fs.open(tempPath, 'wx', 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(tempPath, this.configFilePath);
    } catch (cause) {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          /* close errors are secondary to the original failure */
        }
      }
      try {
        await this.fs.unlink(tempPath);
      } catch {
        /* the temp file may never have been created */
      }
      throw cause;
    }
    await this.fsyncDir(dir);
  }

  private async fsyncDir(dir: string): Promise<void> {
    try {
      const handle = await this.fs.open(dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* directory fsync is best-effort */
    }
  }
}

export default RuntimeAliasStore;
