/**
 * Workspace todo service — daemon-owned authority for workspace-native todos.
 *
 * Each todo is one Markdown file at `<workspaceRoot>/todos/<id>.md`. The file
 * is authoritative: YAML front matter carries the structured fields and the
 * body carries the Request and Acceptance criteria. A disposable SQLite index
 * mirrors the parsed front-matter fields; it is rebuilt from the files on every
 * read and after every write, so an externally edited or deleted index can
 * never disagree with the files for long and deleting it is recovered by a
 * rebuild. There is deliberately no deletion of todos (cancel is a status).
 * Every write is validated and atomic, `done` (execution finished) and
 * `accepted` (acceptance passed) remain distinct stored states, and dependency
 * existence plus acyclicity are checked on writes only so reads can still
 * surface externally broken dependencies.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import type { Database as DatabaseInstance } from 'better-sqlite3'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Todos live in this directory under the workspace root. */
const TODO_DIRECTORY = 'todos'

/** Every todo is one Markdown file named by its id. */
const TODO_EXT = '.md'

/**
 * The disposable index schema: only the parsed front-matter fields are mirrored,
 * never the Markdown body. The whole snapshot is replaced in one transaction.
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

/** Insert one indexed row; the snapshot is replaced row by row inside one transaction. */
const INDEX_INSERT_SQL =
  'INSERT INTO todo_index (id, title, status, project, depends_on, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)'

/** Read the indexed snapshot in a stable, deterministic order. */
const INDEX_SELECT_SQL =
  'SELECT id, title, status, project, depends_on, created, updated FROM todo_index ORDER BY id'

/** A short, path-safe, lowercase id used verbatim as the file stem. */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/u

/** An ISO 8601 timestamp with an explicit UTC offset. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

/** The only front matter fields a todo file may declare. */
const FRONT_MATTER_KEYS = new Set(['id', 'title', 'status', 'project', 'depends_on', 'created', 'updated'])

/** Execution-finished (`done`) and acceptance-passed (`accepted`) are separate. */
export type TodoStatus = 'open' | 'in_progress' | 'done' | 'accepted' | 'cancelled'

/** The complete, ordered set of valid todo statuses. */
export const TODO_STATUSES: readonly TodoStatus[] = ['open', 'in_progress', 'done', 'accepted', 'cancelled']

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
  resultSummary?: string
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
}

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

  /** Every todo currently on disk, ordered by id. Malformed files are errors. */
  async listTodos(): Promise<Todo[]> {
    const todos = this.readAllTodos()
    this.writeIndex(todos)
    return todos
  }

  /** One todo by id; a missing or non-regular target is an error. */
  async getTodo(id: string): Promise<Todo> {
    const filePath = this.todoPath(id)
    if (!existsSync(filePath)) throw new WorkspaceTodoError('missing', `Todo not found: ${id}`)
    if (!lstatSync(filePath).isFile()) throw new WorkspaceTodoError('not_a_file', `Todo is not a regular file: ${id}`)
    const todo = parseTodoFile(filePath, readFileSync(filePath, 'utf-8'))
    this.refreshIndex()
    return todo
  }

  /** Create a new todo with a freshly generated immutable id. */
  async createTodo(input: TodoCreateInput): Promise<Todo> {
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
    }
    this.assertDependenciesKnown(todo)
    const filePath = this.todoPath(id)
    if (existsSync(filePath)) throw new WorkspaceTodoError('exists', `Todo already exists: ${id}`)
    this.writeTodo(filePath, todo)
    this.refreshIndex()
    return todo
  }

  /** Update an existing todo; id and created are preserved, updated refreshed. */
  async updateTodo(input: TodoUpdateInput): Promise<Todo> {
    const filePath = this.todoPath(input.id)
    if (!existsSync(filePath)) throw new WorkspaceTodoError('missing', `Todo not found: ${input.id}`)
    if (!lstatSync(filePath).isFile()) throw new WorkspaceTodoError('not_a_file', `Todo is not a regular file: ${input.id}`)
    const current = parseTodoFile(filePath, readFileSync(filePath, 'utf-8'))
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
    this.assertDependenciesKnown(next)
    this.writeTodo(filePath, next)
    this.refreshIndex()
    return next
  }

  /** Persist an execution summary without changing todo metadata or timestamps. */
  async annotateTodo(id: string, resultSummary: string): Promise<Todo> {
    const filePath = this.todoPath(id)
    if (!existsSync(filePath)) throw new WorkspaceTodoError('missing', `Todo not found: ${id}`)
    if (!lstatSync(filePath).isFile()) throw new WorkspaceTodoError('not_a_file', `Todo is not a regular file: ${id}`)
    const todo = parseTodoFile(filePath, readFileSync(filePath, 'utf-8'))
    const annotated = { ...todo, resultSummary }
    this.writeTodo(filePath, annotated)
    this.refreshIndex()
    return annotated
  }

  /**
   * Rebuild the disposable index from the Markdown files and return the indexed
   * snapshot. Every file is read and validated first, so a malformed file fails
   * here and can never leave a partially rebuilt index behind.
   */
  async rebuildIndex(): Promise<TodoIndexRecord[]> {
    const todos = this.readAllTodos()
    this.writeIndex(todos)
    return todos.map(toIndexRecord)
  }

  /** The current index snapshot, read without touching the Markdown files. */
  async readIndex(): Promise<TodoIndexRecord[]> {
    const path = this.indexDbPath
    if (path === undefined) return this.readAllTodos().map(toIndexRecord)
    const db = openIndex(path)
    try {
      return readIndexRows(db)
    } finally {
      db.close()
    }
  }

  /** Rebuild the index from disk after a read; a no-op without a configured path. */
  private refreshIndex(): void {
    if (this.indexDbPath === undefined) return
    this.writeIndex(this.readAllTodos())
  }

  /**
   * Replace the whole indexed snapshot with `todos` in one transaction. A no-op
   * when no index path was configured, and the connection is always closed
   * before returning so nothing is retained between calls.
   */
  private writeIndex(todos: Todo[]): void {
    const path = this.indexDbPath
    if (path === undefined) return
    const records = todos.map(toIndexRecord)
    const db = openIndex(path)
    try {
      db.transaction((rows: TodoIndexRecord[]) => {
        db.prepare('DELETE FROM todo_index').run()
        const insert = db.prepare(INDEX_INSERT_SQL)
        for (const row of rows) {
          insert.run(row.id, row.title, row.status, row.project ?? null, JSON.stringify(row.depends_on), row.created, row.updated)
        }
      })(records)
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

  /** Read and parse every todo file; a missing directory is simply empty. */
  private readAllTodos(): Todo[] {
    if (!existsSync(this.todosDir)) return []
    const todos: Todo[] = []
    for (const entry of readdirSync(this.todosDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(TODO_EXT)) continue
      const filePath = join(this.todosDir, entry.name)
      todos.push(parseTodoFile(filePath, readFileSync(filePath, 'utf-8')))
    }
    todos.sort((a, b) => a.id.localeCompare(b.id))
    return todos
  }

  /**
   * A write-time dependency check: every dependency must resolve to a known
   * todo and the combined graph must be acyclic. Reads skip this so a file with
   * an externally missing dependency can still be inspected.
   */
  private assertDependenciesKnown(todo: Todo): void {
    const graph = new Map<string, string[]>()
    for (const other of this.readAllTodos()) {
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
    status: row.status as TodoStatus,
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
  const flush = (): void => {
    if (heading !== null) sections.set(heading, lines.join('\n').trim())
  }
  for (const line of body.split('\n')) {
    const match = /^##\s+(.+?)\s*$/u.exec(line)
    if (match) {
      flush()
      heading = match[1]
      lines = []
    } else if (heading !== null) {
      lines.push(line)
    }
  }
  flush()
  return sections
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
  for (const key of Object.keys(record)) {
    if (!FRONT_MATTER_KEYS.has(key)) {
      throw new WorkspaceTodoError('unknown_field', `Todo ${id}: unknown front matter field: ${key}`)
    }
  }
  const declaredId = requireTodoId(record.id, `Todo ${id}`)
  if (declaredId !== id) {
    throw new WorkspaceTodoError('bad_id', `Todo ${id}: front matter id "${declaredId}" does not match the file name`)
  }
  const title = requireTitle(record.title, id)
  const status = requireStatus(record.status, id)
  const project = record.project === undefined ? undefined : requireProject(record.project, id)
  const depends_on = requireDependencies(record.depends_on, id)
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
    ...(sections.has('Result summary') ? { resultSummary: sections.get('Result summary') ?? '' } : {}),
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
  if (todo.resultSummary !== undefined) {
    parts.push('', '## Result summary', '', todo.resultSummary.trimEnd())
  }
  return `${parts.join('\n')}\n`
}
