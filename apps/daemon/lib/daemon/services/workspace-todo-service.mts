/**
 * Workspace todo service — daemon-owned authority for workspace-native todos.
 *
 * Each todo is one Markdown file at `<workspaceRoot>/todos/<id>.md`. The file
 * is authoritative: YAML front matter carries the structured fields and the
 * body carries the Request and Acceptance criteria. A disposable SQLite index
 * mirrors the parsed front-matter fields; it is reconciled incrementally with
 * per-record writes, and an unchanged scan reuses cached parses and touches no
 * database. An externally edited index is repaired by a rebuild. There is
 * deliberately no deletion of todos (cancel is a status).
 * Every write is validated and atomic, and dependency
 * existence plus acyclicity are checked on writes only so reads can still
 * surface externally broken dependencies.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import type { Database as DatabaseInstance } from 'better-sqlite3'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { TodoComment, TodoCompact, TodoListParams } from '@wrenyard/protocol/workspace'

/** Todos live in this directory under the workspace root. */
const TODO_DIRECTORY = 'todos'

/** Every todo is one Markdown file named by its id. */
const TODO_EXT = '.md'

/**
 * The disposable index schema: only the parsed front-matter fields are mirrored,
 * never the Markdown body. Rows are reconciled individually.
 */
const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS todo_index (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  project    TEXT,
  depends_on TEXT NOT NULL,
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL
)
`

/** Insert or update one indexed row without disturbing other rows. */
const INDEX_UPSERT_SQL = `INSERT INTO todo_index (id, title, status, project, depends_on, created, updated)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  status = excluded.status,
  project = excluded.project,
  depends_on = excluded.depends_on,
  created = excluded.created,
  updated = excluded.updated`

/** Delete one stale indexed row. */
const INDEX_DELETE_SQL = 'DELETE FROM todo_index WHERE id = ?'

/** Read the indexed snapshot in a stable, deterministic order. */
const INDEX_SELECT_SQL =
  'SELECT id, title, status, project, depends_on, created, updated FROM todo_index ORDER BY id'

/** Index rows applied per transaction before yielding to the event loop. */
const INDEX_WRITE_BATCH = 500

/** Todo files scanned between yields while a large directory is processed. */
const FILE_SCAN_BATCH = 200

/** A short, path-safe, lowercase id used verbatim as the file stem. */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/u

/** An ISO 8601 timestamp with an explicit UTC offset. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

/** The only front matter fields a todo file may declare. */
const FRONT_MATTER_KEYS = new Set(['id', 'title', 'status', 'project', 'depends_on', 'created', 'updated', 'tags'])

/** The valid todo statuses; a stored legacy `accepted` reads as `done`. */
export type TodoStatus = 'open' | 'in_progress' | 'done' | 'cancelled'

/** The complete, ordered set of valid todo statuses. */
export const TODO_STATUSES: readonly TodoStatus[] = ['open', 'in_progress', 'done', 'cancelled']

/** A workspace todo as stored in its Markdown file. */
export interface Todo {
  id: string
  title: string
  status: TodoStatus
  project?: string
  depends_on: string[]
  created: string
  updated: string
  request: string
  acceptance: string
  attachments: string[]
  tags: string[]
  comments: TodoComment[]
}

/** The parsed front-matter fields mirrored into the disposable SQLite index. */
export interface TodoIndexRecord {
  id: string
  title: string
  status: TodoStatus
  project?: string
  depends_on: string[]
  created: string
  updated: string
}

/** The filesystem facts that decide whether a cached parse is still valid. */
interface FileSignature {
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
}

/** One cached parse plus the file signature it was produced from. */
interface CachedTodo {
  signature: FileSignature
  todo: Todo
}

/**
 * The index database and its WAL sidecar. A missing file is represented by
 * `null` because an absent sidecar is normal and must not be an error.
 */
interface IndexFileSignature {
  db: FileSignature | null
  wal: FileSignature | null
}

/** One file skipped during a scan because it could not be parsed. */
export interface SkippedTodoFile {
  file: string
  reason: string
}

/** Input for {@link WorkspaceTodoService.createTodo}. */
export interface TodoCreateInput {
  title: string
  status?: TodoStatus
  project?: string
  depends_on?: string[]
  request?: string
  acceptance?: string
  attachments?: string[]
}

/** Input for {@link WorkspaceTodoService.updateTodo}; absent fields are kept. */
export interface TodoUpdateInput {
  id: string
  title?: string
  status?: TodoStatus
  project?: string
  depends_on?: string[]
  request?: string
  acceptance?: string
  attachments?: string[]
  old_title?: string
  old_request?: string
  old_acceptance?: string
}

export interface TodoTagMutationResult { tags: string[]; changed: boolean }
export interface TodoCommentMutationResult { comments: TodoComment[]; changed: boolean }

/** Structured failure for todo operations, carrying a specific code. */
export class WorkspaceTodoError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceTodoError'
    this.code = code
  }
}

export class WorkspaceTodoService {
  private readonly workspaceRoot: string
  private readonly todosDir: string
  /** The disposable index path, or undefined when only the files are consulted. */
  private readonly indexDbPath: string | undefined
  /** Parsed todos keyed by file name, reused while the file signature holds. */
  private readonly parseCache = new Map<string, CachedTodo>()
  /** The last index rows this instance wrote, or null until reconciled once. */
  private indexSnapshot: Map<string, TodoIndexRecord> | null = null
  /**
   * The database/WAL signature observed after this instance's own last
   * reconcile, or null until then. Another instance can change the shared index
   * without touching this instance's snapshot, so the signature decides whether
   * that snapshot is still a trustworthy diff baseline.
   */
  private indexSignature: IndexFileSignature | null = null
  /** Files that failed to parse during the most recent scan. */
  private skippedFiles: SkippedTodoFile[] = []

  constructor(workspaceRoot: string, indexDbPath?: string) {
    // Resolve the supplied root once, ensure it exists, then canonicalize to
    // handle ancestor symlinks (e.g. macOS /var -> /private/var).
    const resolvedRoot = resolve(workspaceRoot)
    mkdirSync(resolvedRoot, { recursive: true })
    this.workspaceRoot = realpathSync(resolvedRoot)
    this.todosDir = join(this.workspaceRoot, TODO_DIRECTORY)
    // The index path is injected by the caller (the daemon points it at its own
    // local state), never derived from the workspace tree.
    this.indexDbPath = indexDbPath === undefined ? undefined : resolve(indexDbPath)
  }

  /** Every todo currently on disk, ordered by id. Unparseable files are skipped. */
  async listTodos(params: TodoListParams = {}): Promise<Todo[] | TodoCompact[]> {
    const fields = params.fields ?? 'compact'
    const todos = await this.withLock(async () => {
      const scanned = await this.scanLocked()
      await this.reconcileIndexLocked(scanned)
      return scanned
    })
    let filtered = todos
    if (params.status !== undefined) {
      filtered = filtered.filter((todo) => todo.status === params.status)
    }
    if (params.project !== undefined) {
      filtered = filtered.filter((todo) => todo.project === params.project)
    }
    if (params.tag !== undefined) {
      filtered = filtered.filter((todo) => todo.tags.includes(params.tag!))
    }
    if (fields === 'full') return filtered.map(cloneTodo)
    return filtered.map(toCompactTodo)
  }

  /** Files skipped during the most recent directory scan because they could not be parsed. */
  getLastSkippedTodoFiles(): SkippedTodoFile[] {
    return [...this.skippedFiles]
  }

  /** One todo by id; a missing or non-regular target is an error. */
  async getTodo(id: string): Promise<Todo> {
    const todo = await this.readTodoFile(this.todoPath(id), id)
    await this.refreshIndex()
    return todo
  }

  /** Create a new todo with a freshly generated immutable id. */
  async createTodo(input: TodoCreateInput): Promise<Todo> {
    return this.withLock(async () => {
      const id = this.nextId()
      const now = new Date().toISOString()
      const project = input.project === undefined ? undefined : requireProject(input.project, id)
      const todo: Todo = {
        id,
        title: requireTitle(input.title, id),
        status: input.status === undefined ? 'open' : requireStatus(input.status, id),
        ...(project !== undefined ? { project } : {}),
        depends_on: requireDependencies(input.depends_on, id),
        created: now,
        updated: now,
        request: input.request ?? '',
        acceptance: input.acceptance ?? '',
        attachments: requireAttachments(input.attachments, id),
        tags: [],
        comments: [],
      }
      await this.assertDependenciesKnownLocked(todo)
      const filePath = this.todoPath(id)
      if (existsSync(filePath)) throw new WorkspaceTodoError('exists', `Todo already exists: ${id}`)
      this.writeTodo(filePath, todo)
      await this.refreshIndexLocked()
      return todo
    })
  }

  /** Update an existing todo; id and created are preserved, updated refreshed. */
  async updateTodo(input: TodoUpdateInput): Promise<Todo> {
    return this.withLock(async () => {
      const filePath = this.todoPath(input.id)
      const current = await this.readTodoFile(filePath, input.id)
      assertDescriptionCurrent(input.title, input.old_title, current.title, 'title', current.id)
      assertDescriptionCurrent(input.request, input.old_request, current.request, 'request', current.id)
      assertDescriptionCurrent(input.acceptance, input.old_acceptance, current.acceptance, 'acceptance', current.id)
      const next: Todo = {
        ...current,
        title: input.title === undefined ? current.title : requireTitle(input.title, current.id),
        status: input.status === undefined ? current.status : requireStatus(input.status, current.id),
        depends_on: input.depends_on === undefined ? current.depends_on : requireDependencies(input.depends_on, current.id),
        request: input.request === undefined ? current.request : input.request,
        acceptance: input.acceptance === undefined ? current.acceptance : input.acceptance,
        attachments: input.attachments === undefined ? current.attachments : requireAttachments(input.attachments, current.id),
        updated: new Date().toISOString(),
      }
      if (input.project !== undefined) next.project = requireProject(input.project, current.id)
      await this.assertDependenciesKnownLocked(next)
      this.writeTodo(filePath, next)
      await this.refreshIndexLocked()
      return next
    })
  }

  async addTodoTags(id: string, tags: string[]): Promise<TodoTagMutationResult> {
    return this.withLock(async () => {
      const filePath = this.todoPath(id)
      const todo = await this.readTodoFile(filePath, id)
      const additions = requireTags(tags, id)
      const nextTags = [...todo.tags]
      for (const tag of additions) if (!nextTags.includes(tag)) nextTags.push(tag)
      const changed = nextTags.length !== todo.tags.length
      if (changed) this.writeTodo(filePath, { ...todo, tags: nextTags, updated: new Date().toISOString() })
      await this.refreshIndexLocked()
      return { tags: nextTags, changed }
    })
  }

  async removeTodoTag(id: string, tag: string): Promise<TodoTagMutationResult> {
    return this.withLock(async () => {
      const filePath = this.todoPath(id)
      const todo = await this.readTodoFile(filePath, id)
      const target = requireTag(tag, id)
      const tags = todo.tags.filter((entry) => entry !== target)
      const changed = tags.length !== todo.tags.length
      if (changed) this.writeTodo(filePath, { ...todo, tags, updated: new Date().toISOString() })
      await this.refreshIndexLocked()
      return { tags, changed }
    })
  }

  async appendTodoComment(id: string, author: string, text: string): Promise<TodoCommentMutationResult> {
    return this.withLock(async () => {
      const filePath = this.todoPath(id)
      const todo = await this.readTodoFile(filePath, id)
      const comment: TodoComment = { id: this.nextCommentId(todo.comments), author: requireCommentAuthor(author, id), at: new Date().toISOString(), text }
      const comments = [...todo.comments, comment]
      this.writeTodo(filePath, { ...todo, comments, updated: new Date().toISOString() })
      await this.refreshIndexLocked()
      return { comments, changed: true }
    })
  }

  async deleteTodoComment(id: string, commentId: string, author: string): Promise<TodoCommentMutationResult> {
    return this.withLock(async () => {
      const filePath = this.todoPath(id)
      const todo = await this.readTodoFile(filePath, id)
      const trustedAuthor = requireCommentAuthor(author, id)
      const existing = todo.comments.find((comment) => comment.id === commentId)
      if (!existing) throw new WorkspaceTodoError('missing_comment', `Todo ${id}: comment not found: ${commentId}`)
      if (existing.author !== trustedAuthor) throw new WorkspaceTodoError('comment_forbidden', `Todo ${id}: cannot delete another author's comment`)
      const comments = todo.comments.filter((comment) => comment.id !== commentId)
      this.writeTodo(filePath, { ...todo, comments, updated: new Date().toISOString() })
      await this.refreshIndexLocked()
      return { comments, changed: true }
    })
  }

  private nextCommentId(comments: TodoComment[]): string {
    let id = randomBytes(3).toString('hex')
    while (comments.some((comment) => comment.id === id)) id = randomBytes(3).toString('hex')
    return id
  }

  /**
   * Rebuild the disposable index from the Markdown files and return the indexed
   * snapshot. Every file is read and validated first, so a malformed file fails
   * here and can never leave a partially rebuilt index behind.
   */
  async rebuildIndex(): Promise<TodoIndexRecord[]> {
    return this.withLock(async () => {
      const todos = await this.scanLocked()
      this.indexSnapshot = null
      await this.reconcileIndexLocked(todos)
      return todos.map(toIndexRecord)
    })
  }

  /** The current index snapshot, read without touching the Markdown files. */
  async readIndex(): Promise<TodoIndexRecord[]> {
    const path = this.indexDbPath
    if (path === undefined) return (await this.scan()).map(toIndexRecord)
    const db = openIndex(path)
    try {
      return readIndexRows(db)
    } finally {
      db.close()
    }
  }

  /** Reconcile the index from disk after a read; a no-op without a configured path. */
  private async refreshIndex(): Promise<void> {
    if (this.indexDbPath === undefined) return
    await this.withLock(() => this.refreshIndexLocked())
  }

  /** Reconcile the index from disk while the caller already holds the lock. */
  private async refreshIndexLocked(): Promise<void> {
    if (this.indexDbPath === undefined) return
    await this.reconcileIndexLocked(await this.scanLocked())
  }

  /**
   * Apply only the rows that differ from a trusted snapshot. The snapshot is
   * trusted only while the database/WAL signature still matches the one
   * recorded after this instance's own last reconcile; otherwise the current
   * rows are re-read, so another instance's write can never be masked by a
   * stale baseline. An unchanged scan with a matching snapshot therefore opens
   * no database and runs no SQL beyond the stat calls.
   */
  private async reconcileIndexLocked(todos: Todo[]): Promise<void> {
    const path = this.indexDbPath
    if (path === undefined) return
    const next = new Map(todos.map((todo) => [todo.id, toIndexRecord(todo)] as const))
    const observed = await indexFileSignature(path)
    let current = this.indexSnapshot
    if (
      current === null ||
      observed.db === null ||
      this.indexSignature === null ||
      !sameIndexSignature(observed, this.indexSignature)
    ) {
      current = this.readIndexSnapshot(path)
    }
    const removed: string[] = []
    const changed: TodoIndexRecord[] = []
    for (const [id, record] of next) {
      const prior = current.get(id)
      if (prior === undefined || !sameIndexRecord(prior, record)) changed.push(record)
    }
    for (const id of current.keys()) {
      if (!next.has(id)) removed.push(id)
    }
    if (removed.length > 0 || changed.length > 0) {
      try {
        await this.writeIndexChanges(path, removed, changed)
      } catch (error) {
        // A failed batch may have applied partially, so neither the rows nor
        // the signature can be trusted as a baseline after this point.
        this.indexSnapshot = null
        this.indexSignature = null
        throw error
      }
    }
    this.indexSnapshot = next
    this.indexSignature = await indexFileSignature(path)
  }

  /** Read the current index rows without touching the Markdown files. */
  private readIndexSnapshot(path: string): Map<string, TodoIndexRecord> {
    const db = openIndex(path)
    try {
      return new Map(readIndexRows(db).map((record) => [record.id, record]))
    } finally {
      db.close()
    }
  }

  /**
   * Delete and upsert the given rows in bounded transactions, yielding between
   * batches so a large first reconciliation cannot block the event loop.
   */
  private async writeIndexChanges(path: string, removed: string[], changed: TodoIndexRecord[]): Promise<void> {
    const db = openIndex(path)
    try {
      const remove = db.prepare(INDEX_DELETE_SQL)
      const upsert = db.prepare(INDEX_UPSERT_SQL)
      const total = removed.length + changed.length
      for (let start = 0; start < total; start += INDEX_WRITE_BATCH) {
        const end = Math.min(start + INDEX_WRITE_BATCH, total)
        db.transaction(() => {
          for (let index = start; index < end; index += 1) {
            if (index < removed.length) {
              remove.run(removed[index])
            } else {
              const row = changed[index - removed.length]
              upsert.run(row.id, row.title, row.status, row.project ?? null, JSON.stringify(row.depends_on), row.created, row.updated)
            }
          }
        })()
        if (end < total) await yieldToEventLoop()
      }
    } finally {
      db.close()
    }
  }

  /** Resolve an id to its file path, refusing anything that could escape. */
  private todoPath(id: string): string {
    const safeId = requireTodoId(id, 'Todo')
    const absolute = resolve(this.todosDir, `${safeId}${TODO_EXT}`)
    if (!absolute.startsWith(this.todosDir + sep)) {
      throw new WorkspaceTodoError('outside_workspace', `Todo resolves outside the todos directory: ${id}`)
    }
    return absolute
  }

  /**
   * Scan every todo file, reusing cached parses while a file's signature holds.
   * The cache is replaced only after all present files parsed, so a malformed
   * file rejects the scan without changing the previous snapshot.
   */
  private async scanLocked(): Promise<Todo[]> {
    let names: string[]
    try {
      const entries = await readdir(this.todosDir, { withFileTypes: true })
      names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(TODO_EXT)).map((entry) => entry.name)
    } catch (error) {
      if (!isNotFound(error)) throw error
      names = []
    }
    const next = new Map<string, CachedTodo>()
    const todos: Todo[] = []
    const skipped: SkippedTodoFile[] = []
    let processed = 0
    for (const name of names) {
      const filePath = join(this.todosDir, name)
      let info
      try {
        info = await lstat(filePath)
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }
      if (!info.isFile()) continue
      const signature: FileSignature = { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, ino: info.ino }
      const cached = this.parseCache.get(name)
      let todo: Todo
      if (cached !== undefined && sameSignature(cached.signature, signature)) {
        todo = cached.todo
      } else {
        try {
          todo = parseTodoFile(filePath, await readFile(filePath, 'utf-8'))
        } catch (error) {
          if (isNotFound(error)) continue
          // Skip the file instead of failing the whole store read; the file
          // keeps its stale cache entry out of `next` so it is retried later.
          const reason = error instanceof Error ? error.message : String(error)
          skipped.push({ file: name, reason })
          console.warn(`Skipping todo file ${name}: ${reason}`)
          continue
        }
      }
      next.set(name, { signature, todo })
      todos.push(todo)
      processed += 1
      if (processed % FILE_SCAN_BATCH === 0) await yieldToEventLoop()
    }
    this.parseCache.clear()
    for (const [name, entry] of next) this.parseCache.set(name, entry)
    this.skippedFiles = skipped
    todos.sort((a, b) => a.id.localeCompare(b.id))
    return todos
  }

  /** Run a scan under the workspace lock so concurrent callers cannot interleave. */
  private scan(): Promise<Todo[]> {
    return this.withLock(() => this.scanLocked())
  }

  /**
   * Serialize one complete read-modify-write cycle against every other operation
   * on the same todos directory, in this process and in any other service
   * instance sharing it. A caller that already holds the lock must call the
   * `…Locked` helpers instead of re-entering this method.
   */
  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withWorkspaceLock(this.todosDir, operation)
  }

  /** Read and parse one todo file, mapping absence to the documented errors. */
  private async readTodoFile(filePath: string, id: string): Promise<Todo> {
    let info
    try {
      info = await lstat(filePath)
    } catch (error) {
      if (isNotFound(error)) throw new WorkspaceTodoError('missing', `Todo not found: ${id}`)
      throw error
    }
    if (!info.isFile()) throw new WorkspaceTodoError('not_a_file', `Todo is not a regular file: ${id}`)
    return parseTodoFile(filePath, await readFile(filePath, 'utf-8'))
  }

  /**
   * A write-time dependency check: every dependency must resolve to a known
   * todo and the combined graph must be acyclic. Reads skip this so a file with
   * an externally missing dependency can still be inspected. The caller holds
   * the workspace lock, so this uses the unlocked scan.
   */
  private async assertDependenciesKnownLocked(todo: Todo): Promise<void> {
    const graph = new Map<string, string[]>()
    for (const other of await this.scanLocked()) {
      if (other.id !== todo.id) graph.set(other.id, other.depends_on)
    }
    graph.set(todo.id, todo.depends_on)
    for (const dependency of todo.depends_on) {
      if (!graph.has(dependency)) {
        throw new WorkspaceTodoError('unknown_dependency', `Todo ${todo.id}: depends on unknown todo: ${dependency}`)
      }
    }
    assertAcyclic(todo.id, graph)
  }

  /** A fresh unique 8 lowercase hex id, checked against existing files. */
  private nextId(): string {
    let id = randomBytes(4).toString('hex')
    while (existsSync(join(this.todosDir, `${id}${TODO_EXT}`))) id = randomBytes(4).toString('hex')
    return id
  }

  /** Atomically write one todo: temp file plus rename, temp removed on failure. */
  private writeTodo(filePath: string, todo: Todo): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tempPath, serializeTodo(todo), { encoding: 'utf-8', flag: 'wx' })
      renameSync(tempPath, filePath)
    } catch (error) {
      try {
        unlinkSync(tempPath)
      } catch {
        // The temp file may never have been created; ignore cleanup failure.
      }
      throw error
    }
  }
}

// Module-level helpers (no instance state needed)

/**
 * Process-wide serialization keyed by the canonical todos directory. Separate
 * service instances (the daemon RPC host and the bot host) share one workspace
 * and one index file, so an instance-local queue alone cannot stop one instance
 * from applying a stale snapshot over another's newer write.
 */
const workspaceLocks = new Map<string, Promise<void>>()

/**
 * Run `operation` after every earlier operation on the same key has settled. A
 * failure reaches only its own caller: the stored chain always continues
 * resolved, so later operations are never blocked by an earlier error.
 */
function withWorkspaceLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = workspaceLocks.get(key) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  workspaceLocks.set(key, settled)
  void settled.then(() => {
    // Drop the entry only while it is still the tail of the chain.
    if (workspaceLocks.get(key) === settled) workspaceLocks.delete(key)
  })
  return result
}

/**
 * The disposable index location for one workspace, under the daemon's local
 * state root and keyed by the workspace root, so it never lands inside the
 * workspace Git tree or the runtime database.
 */
export function todoIndexPath(stateRoot: string, workspaceRoot: string): string {
  const digest = createHash('sha256').update(resolve(workspaceRoot), 'utf8').digest('hex')
  return join(resolve(stateRoot), 'workspace-todos', `${digest}.db`)
}

/**
 * Open the index with the repository's SQLite pragmas and ensure its table
 * exists, so a missing or deleted database file is recreated on demand.
 */
function openIndex(path: string): DatabaseInstance {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
    db.exec(INDEX_SCHEMA)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Project one todo onto the fields the index mirrors. */
function toIndexRecord(todo: Todo): TodoIndexRecord {
  return {
    id: todo.id,
    title: todo.title,
    status: todo.status,
    ...(todo.project !== undefined ? { project: todo.project } : {}),
    depends_on: [...todo.depends_on],
    created: todo.created,
    updated: todo.updated,
  }
}

/** Whether two file signatures describe the same unchanged content. */
function sameSignature(a: FileSignature, b: FileSignature): boolean {
  return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino
}

/** Stat one index file without opening it; absence is represented by null. */
async function statFileSignature(path: string): Promise<FileSignature | null> {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, ino: info.ino }
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/**
 * The signature of the index database plus its `-wal` sidecar. Computing it
 * never opens the database, and a missing sidecar is a normal null signature.
 */
async function indexFileSignature(path: string): Promise<IndexFileSignature> {
  const [db, wal] = await Promise.all([statFileSignature(path), statFileSignature(`${path}-wal`)])
  return { db, wal }
}

/** Whether two database/WAL signatures describe the same files. */
function sameIndexSignature(a: IndexFileSignature, b: IndexFileSignature): boolean {
  return sameNullableSignature(a.db, b.db) && sameNullableSignature(a.wal, b.wal)
}

function sameNullableSignature(a: FileSignature | null, b: FileSignature | null): boolean {
  if (a === null || b === null) return a === b
  return sameSignature(a, b)
}

/** Whether two indexed records carry identical values. */
function sameIndexRecord(a: TodoIndexRecord, b: TodoIndexRecord): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.status === b.status &&
    a.project === b.project &&
    a.created === b.created &&
    a.updated === b.updated &&
    a.depends_on.length === b.depends_on.length &&
    a.depends_on.every((entry, index) => entry === b.depends_on[index])
  )
}

/** Copy a todo so callers never share a mutable object with the parse cache. */
function cloneTodo(todo: Todo): Todo {
  return { ...todo, depends_on: [...todo.depends_on], attachments: [...todo.attachments], tags: [...todo.tags], comments: todo.comments.map((comment) => ({ ...comment })) }
}

function toCompactTodo(todo: Todo): TodoCompact {
  const cloned = cloneTodo(todo)
  const compact: TodoCompact = {
    id: cloned.id,
    title: cloned.title,
    status: cloned.status,
    depends_on: cloned.depends_on,
    updated: cloned.updated,
    tags: cloned.tags,
  }
  if (cloned.project !== undefined) compact.project = cloned.project
  return compact
}

/** Whether a filesystem error means the target is absent. */
function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/** Yield to the event loop between bounded batches of blocking work. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Read the indexed snapshot in its stable order. */
function readIndexRows(db: DatabaseInstance): TodoIndexRecord[] {
  const rows = db.prepare(INDEX_SELECT_SQL).all() as Array<{
    id: string
    title: string
    status: string
    project: string | null
    depends_on: string
    created: string
    updated: string
  }>
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status === 'accepted' ? 'done' : (row.status as TodoStatus),
    ...(row.project === null ? {} : { project: row.project }),
    depends_on: JSON.parse(row.depends_on) as string[],
    created: row.created,
    updated: row.updated,
  }))
}

/** Require a short path-safe id, used both for fields and for file stems. */
function requireTodoId(value: unknown, context: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new WorkspaceTodoError('bad_id', `${context}: id must be a short lowercase identifier`)
  }
  return value
}

/** Require a nonempty title. */
function requireTitle(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkspaceTodoError('bad_title', `Todo ${id}: title must be a nonempty string`)
  }
  return value
}

/** Require one of the known statuses. */
function requireStatus(value: unknown, id: string): TodoStatus {
  if (typeof value !== 'string' || !(TODO_STATUSES as readonly string[]).includes(value)) {
    throw new WorkspaceTodoError('bad_status', `Todo ${id}: status must be one of ${TODO_STATUSES.join(', ')}`)
  }
  return value as TodoStatus
}

/** Read a stored status; the retired `accepted` presents as `done`, never written back. */
function readStatus(value: unknown, id: string): TodoStatus {
  if (value === 'accepted') return 'done'
  return requireStatus(value, id)
}

/** Require a nonempty project label without control characters. */
function requireProject(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new WorkspaceTodoError('bad_project', `Todo ${id}: project must be a nonempty string`)
  }
  return value
}

/** Require an ISO 8601 timestamp. */
function requireTimestamp(value: unknown, id: string, label: string): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new WorkspaceTodoError('bad_timestamp', `Todo ${id}: ${label} must be an ISO 8601 timestamp`)
  }
  return value
}

/** Require a list of unique, valid, non-self dependency ids. */
function requireDependencies(value: unknown, id: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new WorkspaceTodoError('bad_dependency', `Todo ${id}: depends_on must be a list of todo ids`)
  }
  const dependencies = value.map((entry) => requireTodoId(entry, `Todo ${id}: dependency`))
  if (new Set(dependencies).size !== dependencies.length) {
    throw new WorkspaceTodoError('bad_dependency', `Todo ${id}: depends_on must not contain duplicates`)
  }
  if (dependencies.includes(id)) {
    throw new WorkspaceTodoError('dependency_self', `Todo ${id}: a todo cannot depend on itself`)
  }
  return dependencies
}

/** Require a list of safe relative attachment paths. */
function requireAttachments(value: unknown, id: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new WorkspaceTodoError('bad_attachment', `Todo ${id}: attachments must be a list of relative paths`)
  }
  return value.map((entry) => requireRelativePath(entry, id))
}

/** Require a relative path that cannot be absolute or escape upward. */
function requireRelativePath(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkspaceTodoError('bad_attachment', `Todo ${id}: attachment must be a nonempty relative path`)
  }
  const path = value.trim()
  if (isAbsolute(path) || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(path) || path.includes('\0')) {
    throw new WorkspaceTodoError('bad_attachment', `Todo ${id}: attachment must be relative: ${path}`)
  }
  const segments = path.split(/[\\/]/u)
  if (segments.some((segment) => segment === '' || segment === '..')) {
    throw new WorkspaceTodoError('bad_attachment', `Todo ${id}: attachment must not escape the workspace: ${path}`)
  }
  return path
}

/** Reject any dependency cycle reachable from the combined id graph. */
function assertAcyclic(id: string, graph: Map<string, string[]>): void {
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (node: string): void => {
    if (done.has(node)) return
    if (visiting.has(node)) {
      throw new WorkspaceTodoError('dependency_cycle', `Todo ${id}: dependency cycle detected`)
    }
    visiting.add(node)
    for (const dependency of graph.get(node) ?? []) {
      if (graph.has(dependency)) visit(dependency)
    }
    visiting.delete(node)
    done.add(node)
  }
  for (const node of graph.keys()) visit(node)
}

/** Split a todo file into its YAML front matter and Markdown body. */
function splitFrontMatter(content: string, id: string): { front: string; body: string } {
  const normalized = content.replace(/\r\n/gu, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized)
  if (!match) {
    throw new WorkspaceTodoError('malformed', `Todo ${id}: file must start with a YAML front matter block`)
  }
  return { front: match[1], body: normalized.slice(match[0].length) }
}

/** Index a Markdown body's `## Heading` sections by heading text. */
function parseBodySections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  let heading: string | null = null
  let lines: string[] = []
  let inComments = false
  const flush = (): void => {
    if (heading !== null) sections.set(heading, lines.join('\n').trim())
  }
  for (const line of body.split('\n')) {
    if (inComments) {
      lines.push(line)
      continue
    }
    const match = /^##\s+(.+?)\s*$/u.exec(line)
    if (match) {
      flush()
      heading = match[1]
      lines = []
      inComments = heading === 'Comments'
    } else if (heading !== null) {
      lines.push(line)
    }
  }
  flush()
  return sections
}

function parseComments(body: string, updated: string, todoId: string): TodoComment[] {
  const sections = parseBodySections(body)
  if (sections.has('Comments')) {
    const comments: TodoComment[] = []
    const lines = body.replace(/\r\n/gu, '\n').split('\n')
    let current: TodoComment | null = null
    let rawBodyLines: string[] = []
    const flush = (): void => { if (current) comments.push(current) }
    let inComments = false
    for (const line of lines) {
      if (!inComments) {
        if (line === '## Comments') inComments = true
        continue
      }
      const heading = /^### ([0-9a-f]{6}) · ([^·\r\n]+?) · (.+)$/u.exec(line)
      if (heading && isValidCommentTime(heading[3])) {
        flush()
        const withoutPreviousSeparator = rawBodyLines.at(-1) === '' ? rawBodyLines.slice(0, -1) : rawBodyLines
        const bodyLines = withoutPreviousSeparator[0] === '' ? withoutPreviousSeparator.slice(1) : withoutPreviousSeparator
        const textLines = bodyLines.map((bodyLine) => /^\\+### [0-9a-f]{6} · .+ · .+$/u.test(bodyLine) ? bodyLine.slice(1) : bodyLine)
        if (current) current.text = textLines.join('\n')
        rawBodyLines = []
        current = { id: heading[1], author: heading[2], at: heading[3], text: '' }
      } else if (current) {
        rawBodyLines.push(line)
      }
    }
    if (current) {
      const withoutEndSeparator = rawBodyLines.at(-1) === '' ? rawBodyLines.slice(0, -1) : rawBodyLines
      const bodyLines = withoutEndSeparator[0] === '' ? withoutEndSeparator.slice(1) : withoutEndSeparator
      current.text = bodyLines.map((bodyLine) => /^\\+### [0-9a-f]{6} · .+ · .+$/u.test(bodyLine) ? bodyLine.slice(1) : bodyLine).join('\n')
    }
    flush()
    if (new Set(comments.map((comment) => comment.id)).size !== comments.length) {
      throw new WorkspaceTodoError('malformed', `Todo ${todoId}: duplicate comment id`)
    }
    return comments
  }
  const legacy = sections.get('Result summary')
  return legacy === undefined ? [] : [{ id: createHash('sha256').update(`${todoId}\0${updated}\0${legacy}`, 'utf8').digest('hex').slice(0, 6), author: 'legacy', at: updated, text: legacy }]
}

function escapeCommentText(text: string): string {
  return text.replace(/^(\\*### [0-9a-f]{6} · .* · .+)$/gmu, '\\$1')
}

function isValidCommentTime(value: string): boolean {
  return ISO_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value))
}

function requireTag(value: unknown, id: string): string {
  if (typeof value !== 'string' || !/^[^\s\p{Cc}]+$/u.test(value)) {
    throw new WorkspaceTodoError('bad_tag', `Todo ${id}: tags must be nonempty and contain no whitespace or control characters`)
  }
  return value
}

function requireTags(value: unknown, id: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new WorkspaceTodoError('bad_tag', `Todo ${id}: tags must be a list`)
  return [...new Set(value.map((tag) => requireTag(tag, id)))]
}

function requireCommentAuthor(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n\p{Cc}]/u.test(value)) {
    throw new WorkspaceTodoError('bad_comment', `Todo ${id}: comment author must be a nonempty single-line string`)
  }
  return value
}

function assertDescriptionCurrent(next: string | undefined, old: string | undefined, current: string, field: string, id: string): void {
  if (next === undefined) return
  if (old !== current) {
    throw new WorkspaceTodoError('stale_description', `Todo ${id}: stale ${field}; current text follows:\n${current}`)
  }
}

/** Read attachment list entries, validating each relative path. */
function parseAttachments(section: string, id: string): string[] {
  const attachments: string[] = []
  for (const line of section.split('\n')) {
    const match = /^\s*[-*]\s+(.+?)\s*$/u.exec(line)
    if (!match) continue
    attachments.push(requireRelativePath(match[1], id))
  }
  return attachments
}

/** Parse and validate one todo file; the file stem is the authoritative id. */
function parseTodoFile(filePath: string, content: string): Todo {
  const id = basename(filePath, TODO_EXT)
  const { front, body } = splitFrontMatter(content, id)
  let decoded: unknown
  try {
    decoded = parseYaml(front)
  } catch {
    throw new WorkspaceTodoError('malformed', `Todo ${id}: front matter is not valid YAML`)
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new WorkspaceTodoError('malformed', `Todo ${id}: front matter must be a mapping`)
  }
  const record = decoded as Record<string, unknown>
  // The core schema turns unquoted numeric-looking scalars into numbers, so a
  // second parse under the failsafe schema recovers the original scalar text
  // for fields that must stay strings (id and every depends_on entry).
  const failsafeDecoded = parseYaml(front, { schema: 'failsafe' }) as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!FRONT_MATTER_KEYS.has(key)) {
      throw new WorkspaceTodoError('unknown_field', `Todo ${id}: unknown front matter field: ${key}`)
    }
  }
  const declaredId = requireTodoId(failsafeDecoded.id, `Todo ${id}`)
  if (declaredId !== id) {
    throw new WorkspaceTodoError('bad_id', `Todo ${id}: front matter id "${declaredId}" does not match the file name`)
  }
  const title = requireTitle(record.title, id)
  const status = readStatus(record.status, id)
  const project = record.project === undefined ? undefined : requireProject(record.project, id)
  const failsafeDependsOn = failsafeDecoded.depends_on
  const failsafeTags = failsafeDecoded.tags
  const tagSource = record.tags !== undefined && Array.isArray(failsafeTags) && Array.isArray(record.tags) && failsafeTags.length === record.tags.length
    ? failsafeTags
    : record.tags
  const dependsOnSource =
    record.depends_on !== null &&
    Array.isArray(record.depends_on) &&
    Array.isArray(failsafeDependsOn) &&
    failsafeDependsOn.length === record.depends_on.length
      ? failsafeDependsOn
      : record.depends_on
  const depends_on = requireDependencies(dependsOnSource, id)
  const created = requireTimestamp(record.created, id, 'created')
  const updated = requireTimestamp(record.updated, id, 'updated')
  const sections = parseBodySections(body)
  return {
    id,
    title,
    status,
    ...(project !== undefined ? { project } : {}),
    depends_on,
    created,
    updated,
    request: sections.get('Request') ?? '',
    acceptance: sections.get('Acceptance criteria') ?? '',
    attachments: parseAttachments(sections.get('Attachments') ?? '', id),
    tags: requireTags(tagSource, id),
    comments: parseComments(body, updated, id),
  }
}

/** Serialize a todo back to its canonical Markdown representation. */
function serializeTodo(todo: Todo): string {
  const front: Record<string, unknown> = {
    id: todo.id,
    title: todo.title,
    status: todo.status,
  }
  if (todo.project !== undefined) front.project = todo.project
  if (todo.depends_on.length > 0) front.depends_on = todo.depends_on
  if (todo.tags.length > 0) front.tags = todo.tags
  front.created = todo.created
  front.updated = todo.updated
  const parts = [
    '---',
    stringifyYaml(front).trimEnd(),
    '---',
    '',
    '## Request',
    '',
    todo.request.trimEnd(),
    '',
    '## Acceptance criteria',
    '',
    todo.acceptance.trimEnd(),
  ]
  if (todo.attachments.length > 0) {
    parts.push('', '## Attachments', '', ...todo.attachments.map((path) => `- ${path}`))
  }
  if (todo.comments.length > 0) {
    parts.push('', '## Comments')
    for (const comment of todo.comments) {
      parts.push('', `### ${comment.id} · ${comment.author} · ${comment.at}`, '', escapeCommentText(comment.text))
    }
  }
  return `${parts.join('\n')}\n`
}
