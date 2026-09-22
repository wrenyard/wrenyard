import { isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { ExecutionError, type Executor, type ExecutionOptions } from './executor.ts';
import { NativeOperationError } from './client-protocol.ts';

/**
 * The subset of the pinned `better-sqlite3` surface this module uses. It is
 * declared structurally rather than imported so the native binding stays a
 * runtime-only, lazily-resolved dependency: a static import would drag the
 * native module into every consumer's bundle, including the Desktop main
 * process, which never reads SQLite itself.
 */
interface SqliteStatement {
  get(...params: unknown[]): unknown;
}
interface SqliteConnection {
  pragma(statement: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }): SqliteConnection;
}
type SqliteValue = string | number | bigint | boolean | Uint8Array | null;

/** Runtime-resolved specifier; never statically analyzable by a bundler. */
const BETTER_SQLITE3_SPECIFIER = 'better-sqlite3';

/** Cached native module, resolved at most once per process. */
let sqliteModule: SqliteModule | undefined;

/**
 * Load `better-sqlite3` on first use. The specifier is intentionally opaque so
 * bundlers keep it as a real runtime import instead of inlining the native
 * binding, and a missing/broken binding surfaces as `sqlite_unavailable`.
 */
async function loadSqlite(): Promise<SqliteModule> {
  if (sqliteModule) return sqliteModule;
  try {
    const loaded = createRequire(import.meta.url)(BETTER_SQLITE3_SPECIFIER) as { default?: SqliteModule };
    const ctor = (loaded.default ?? loaded) as SqliteModule;
    if (typeof ctor !== 'function') throw new Error('better-sqlite3 has no constructor');
    sqliteModule = ctor;
    return ctor;
  } catch {
    throw new NativeOperationError('sqlite_unavailable');
  }
}

/** Bound on a caller-supplied SQL statement; queries are static, never interpolated. */
const MAX_QUERY_BYTES = 8 * 1024;
/** Bound on the returned value so a corrupt database cannot exhaust memory. */
const MAX_VALUE_BYTES = 1024 * 1024;
/** Bound on captured `security` output. A clipped secret is never returned. */
const MAX_KEYCHAIN_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Generic credential primitives. Client modules resolve their own service
 * names, database paths, and queries; these helpers carry no client or
 * provider identity and never log the returned value.
 */
export interface KeychainCredential { kind: 'keychain'; service: string; account?: string; }
export interface SqliteCredential { kind: 'sqlite'; path: string; query: string; params?: readonly (string | number | boolean | null)[]; }
export type CredentialRequest = KeychainCredential | SqliteCredential;

/**
 * Read one OS keychain value using the platform's native generic-password
 * lookup. Only macOS supports a generic keychain read; every other platform
 * rejects with a stable `NativeOperationError`.
 */
export async function readKeychain(execution: Executor, service: string, account?: string, options?: ExecutionOptions): Promise<string> {
  const trimmedService = service?.trim();
  if (!trimmedService) throw new NativeOperationError('invalid_request');
  if (process.platform !== 'darwin') throw new NativeOperationError('keychain_unsupported');

  const args = ['find-generic-password', '-s', trimmedService];
  const trimmedAccount = account?.trim();
  if (trimmedAccount) args.push('-a', trimmedAccount);
  args.push('-w');

  let result;
  try {
    result = await execution.run('security', args, {
      env: options?.env,
      cwd: options?.cwd,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: MAX_KEYCHAIN_OUTPUT_BYTES,
    });
  } catch (error) {
    if (error instanceof ExecutionError && (error.kind === 'timeout' || error.kind === 'aborted')) {
      throw new NativeOperationError(error.kind === 'timeout' ? 'native_operation_timeout' : 'aborted');
    }
    if (error instanceof ExecutionError && error.kind === 'output-limit') {
      throw new NativeOperationError('keychain_value_too_large');
    }
    throw new NativeOperationError('keychain_unavailable');
  }

  const value = result.stdout.trim();
  if (!value) throw new NativeOperationError('keychain_value_empty');
  return value;
}

/**
 * Run one bounded read-only SQLite value query against an absolute path. The
 * database is opened read-only and the connection is pinned with
 * `PRAGMA query_only`, so even a caller-supplied statement cannot mutate a live
 * database. Parameters are always bound, never interpolated, and a boolean
 * binds as the integer 0/1 SQLite stores rather than a string.
 *
 * `executor` is retained in the signature for call-site symmetry with the other
 * native primitives; SQLite is read in-process through the repository's pinned
 * driver rather than through a child process.
 */
export async function readSqliteValue(executor: Executor, path: string, query: string, params: readonly (string | number | boolean | null)[] = [], options?: ExecutionOptions): Promise<string> {
  // SQLite is native, not a subprocess: the executor is unused by design.
  void executor;
  const trimmedPath = path?.trim();
  if (!trimmedPath || !isAbsolute(trimmedPath)) throw new NativeOperationError('invalid_request');
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) throw new NativeOperationError('invalid_request');
  if (Buffer.byteLength(trimmedQuery) > MAX_QUERY_BYTES) throw new NativeOperationError('query_too_large');
  for (const param of params) {
    if (param !== null && typeof param !== 'string' && typeof param !== 'number' && typeof param !== 'boolean') {
      throw new NativeOperationError('invalid_request');
    }
  }

  if (options?.signal?.aborted) throw new NativeOperationError('aborted');

  // Resolve the native binding only now: callers that never read SQLite (the
  // Desktop main process among them) must not load it at all.
  const Database = await loadSqlite();
  let db: SqliteConnection | undefined;
  try {
    db = new Database(trimmedPath, { readonly: true, fileMustExist: true, timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch {
    throw new NativeOperationError('sqlite_unavailable');
  }
  try {
    // query_only is a per-connection pragma; setting and re-reading it on the
    // same handle confirms the connection really is read-only.
    db.pragma('query_only = 1');
    if (db.pragma('query_only', { simple: true }) !== 1) throw new NativeOperationError('sqlite_not_readonly');
    const row = db.prepare(trimmedQuery).get(...params.map(bindSqliteValue)) as unknown;
    if (row === undefined) throw new NativeOperationError('no_stored_value');
    const value = firstColumn(row);
    if (value === undefined) throw new NativeOperationError('no_stored_value');
    return formatSqliteValue(value);
  } catch (error) {
    if (error instanceof NativeOperationError) throw error;
    throw new NativeOperationError('sqlite_read_failed');
  } finally {
    db.close();
  }
}

/**
 * Bind a caller parameter the way SQLite itself represents each JavaScript
 * type: a boolean becomes the integer 0/1 (a string would never match a stored
 * boolean), while strings, numbers, and null bind unchanged.
 */
function bindSqliteValue(param: string | number | boolean | null): SqliteValue {
  if (typeof param === 'boolean') return param ? 1 : 0;
  return param;
}

/**
 * Render one result column as a string. Text and BLOB values are both bounded
 * by `MAX_VALUE_BYTES`; a BLOB is decoded as UTF-8 for the same reason the
 * legacy driver did, and an oversized value rejects instead of returning a
 * clipped secret.
 */
function formatSqliteValue(value: unknown): string {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new NativeOperationError('value_too_large');
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_VALUE_BYTES) throw new NativeOperationError('value_too_large');
    return Buffer.from(value).toString('utf8');
  }
  throw new NativeOperationError('no_stored_value');
}

/** First column of a result row, whether the driver returns an array or object. */
function firstColumn(row: unknown): unknown {
  if (Array.isArray(row)) return row[0];
  if (row !== null && typeof row === 'object') return Object.values(row as Record<string, unknown>)[0];
  return undefined;
}
