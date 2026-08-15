import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverProjects } from '../core/project/loader.mts'
import { listAllManagedWorktreePaths } from '../core/project/manager.mts'
import { foremanStateRoot } from '../config/state.mts'
import type {
  PermissionMode,
  RegisteredTask,
  ResolvedTarget,
  TaskConfig,
  TaskDefinition,
} from '../types.mts'
import {
  STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
  TASK_TIMEOUT_SCOPE,
  assertValidTimeoutMs,
  effectiveTaskTimeoutMs,
  type TaskTimeoutScope,
} from '../task-timeouts.mts'
import { installRuntimeGlobals } from '../daemon/execution/runtime-globals.mts'
import { generateInputExample, normalizeSchema } from './schema-loader.mts'
import { parseAgentRuntime, AgentRuntimeParseError, synthesizeAgentRuntime } from '../core/agent-runtime.mts'
import {
  BUILTIN_SOURCE_PATH,
  BUILTIN_TASKS,
} from '../standard/index.mts'

/**
 * Definition identity is a plain id (`name`) plus scope metadata (`source` /
 * `project`). There is no composite `project/id` identity. Same-id
 * definitions in different layers are intentional
 * overrides resolved by precedence; only duplicate definitions within the
 * same scope are an error/diagnostic.
 */

export type DefinitionSource = 'builtin' | 'project'

/**
 * Thrown when a caller passes a qualified `scope/id` style definition id.
 * Public/runtime task identity is always a plain id; legacy qualified ids are
 * rejected rather than parsed.
 */
export class QualifiedDefinitionIdError extends Error {
  constructor(id: string) {
    super(
      `Qualified definition ids containing '/' are not supported: '${id}'. ` +
        `Use a plain task id.`,
    )
    this.name = 'QualifiedDefinitionIdError'
  }
}

export interface GenericLoadError {
  /** Discriminator — `undefined` for generic load errors. */
  kind?: undefined
  sourcePath: string
  /** Human-readable error message. */
  load_error: string
  failedAt: string
  stale: true
}

export interface DuplicateDefinitionLoadError {
  /** Discriminator — always `'duplicate_definition'`. */
  kind: 'duplicate_definition'
  sourcePath: string
  /** Plain id that is duplicated within the same scope. */
  id: string
  /** Scope where the duplicate was detected: a project id. */
  scope: string
  /** Human-readable explanation of the duplicate. */
  message: string
  /** Mirrors `message` for consumers that read `load_error` as a string. */
  load_error: string
  failedAt: string
  stale: true
}

export type LoadError = GenericLoadError | DuplicateDefinitionLoadError

interface Registry {
  workspaceRoot: string
  discovered: boolean
  dirty: boolean
  tasks: RegisteredTask[]
  fileIndex: Map<string, { mtimeMs: number; kind: 'task' }>
  loadErrors: LoadError[]
}

export interface ListedDefinition {
  name: string
  /** Provenance: `'builtin'` or `'project'`. */
  source: DefinitionSource
  /** Registered project id; only for `source === 'project'`. */
  project?: string
  path: string
  description?: string
  /** Resolved optional task category ({id, displayLabel}); present only when
   *  the final (project-overridden) definition declares one. */
  category?: {
    id: string
    displayLabel: string
  }
  agentRuntime?: string
  input_schema?: unknown
  output_schema?: unknown
  structured?: boolean
  input_example?: Record<string, unknown>
  gates?: {
    pre?: Array<{ id: string; description?: string }>
    post?: Array<{ id: string; description?: string }>
  }
  permission?: PermissionMode
  timeoutMs?: number
  effectiveTimeoutMs?: number
  structuredRetryTimeoutMs?: number
  timeoutScope?: TaskTimeoutScope
  /** Available Forge capability pack ids declared by the task config.
   *  Present only when the task declares capabilities. */
  capabilities?: readonly string[]
  /** `legacy` definitions remain exactly describable/resolvable for persisted
   *  work, but are omitted from new-work list surfaces. */
  scheduling?: 'active' | 'legacy'
}

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'coverage', '.nyc_output'])
const EXCLUDED_FILE_PREFIXES = ['.foreman-load-']
const VALID_PERMISSIONS = new Set(['readonly', 'edit', 'yolo'])
const VALID_SCHEDULING = new Set(['active', 'legacy'])

function extractGateMetadata(config: import('../types.mts').TaskConfig): ListedDefinition['gates'] {
  const pre = config.gates?.pre?.map((g) => ({ id: g.id, ...(g.description ? { description: g.description } : {}) }))
  const post = config.gates?.post?.map((g) => ({ id: g.id, ...(g.description ? { description: g.description } : {}) }))
  if (!pre?.length && !post?.length) return undefined
  return {
    ...(pre?.length ? { pre } : {}),
    ...(post?.length ? { post } : {}),
  }
}

function timeoutMetadata(config: TaskConfig): Pick<ListedDefinition, 'timeoutMs' | 'effectiveTimeoutMs' | 'structuredRetryTimeoutMs' | 'timeoutScope'> {
  return {
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    effectiveTimeoutMs: effectiveTaskTimeoutMs(config.timeoutMs),
    structuredRetryTimeoutMs: STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS,
    timeoutScope: TASK_TIMEOUT_SCOPE,
  }
}

function resolveTaskAgentRuntime(config: TaskConfig): string {
  if (config.agentRuntime) {
    parseAgentRuntime(config.agentRuntime)
    return config.agentRuntime
  }
  return synthesizeAgentRuntime(config.profile ?? '').toString()
}

function validateAgentRuntimeSelector(config: TaskConfig, sourcePath: string): void {
  if (config.agentRuntime && config.profile) {
    throw new Error(`${sourcePath} task config must not declare both agentRuntime and profile; use agentRuntime only`)
  }
  if (!config.agentRuntime && !config.profile) {
    throw new Error(`${sourcePath} task config must declare agentRuntime or profile`)
  }
  if (config.agentRuntime) {
    try {
      parseAgentRuntime(config.agentRuntime)
    } catch (error) {
      if (error instanceof AgentRuntimeParseError) {
        throw new Error(`Invalid agentRuntime in ${sourcePath}: ${error.message}`)
      }
      throw error
    }
  }
}

const CATEGORY_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u
const CATEGORY_DISPLAY_MAX = 24

/**
 * Validate an optional task category and return its canonical normalized form.
 * `id` must match `^[a-z][a-z0-9-]{0,31}$` and `displayLabel` must be a trimmed
 * single line of 1..24 UTF-16 code units. Returns `undefined` when the task
 * declares no category (backwards compatible); throws on an invalid category.
 * The returned `{ id, displayLabel }` is the single canonical value stored in
 * every list/describe surface, so a padded displayLabel is trimmed exactly once
 * and raw config never leaks into summaries.
 */
function resolveTaskCategory(config: TaskConfig, sourcePath: string): { id: string; displayLabel: string } | undefined {
  const category = config.category
  if (category === undefined) return undefined
  if (category === null || typeof category !== 'object' || Array.isArray(category)) {
    throw new Error(`${sourcePath} task config category must be an object { id, displayLabel } when present`)
  }
  if (typeof category.id !== 'string' || !CATEGORY_ID_PATTERN.test(category.id)) {
    throw new Error(
      `${sourcePath} task config category.id must match ^[a-z][a-z0-9-]{0,31}$ (lowercase letter start, 1..32 chars), got '${String(category.id)}'`,
    )
  }
  if (typeof category.displayLabel !== 'string') {
    throw new Error(`${sourcePath} task config category.displayLabel must be a string`)
  }
  const displayLabel = category.displayLabel.trim()
  if (displayLabel.length === 0) {
    throw new Error(`${sourcePath} task config category.displayLabel must be a non-empty string after trimming whitespace`)
  }
  if (/[\r\n]/u.test(displayLabel)) {
    throw new Error(`${sourcePath} task config category.displayLabel must not contain CR or LF line breaks`)
  }
  if (displayLabel.length > CATEGORY_DISPLAY_MAX) {
    throw new Error(`${sourcePath} task config category.displayLabel must not exceed ${CATEGORY_DISPLAY_MAX} UTF-16 code units`)
  }
  return { id: category.id, displayLabel }
}
const EXCLUDED_PATH_SEGMENTS = ['node_modules', '.git', 'dist', 'out', 'build', 'coverage']
const registries = new Map<string, Registry>()
let definitionImportQueue: Promise<void> = Promise.resolve()

export async function ensureDiscovered(workspaceRoot: string, skipRefresh = false): Promise<void> {
  const registry = registryFor(workspaceRoot)
  if (!registry.discovered) {
    await discoverTasks(workspaceRoot)
    return
  }
  if (registry.dirty && !skipRefresh) {
    await refreshDefinitionsIfDirty(workspaceRoot)
  }
}

export function markDirty(workspaceRoot: string): void {
  const registry = registryFor(workspaceRoot)
  registry.dirty = true
}

export async function discoverTasks(workspaceRoot: string): Promise<void> {
  const registry = registryFor(workspaceRoot)
  registry.tasks = []
  registry.fileIndex.clear()
  registry.loadErrors = []
  registry.discovered = true
  registry.dirty = false

  cleanupStaleImportCopies(registry.workspaceRoot)

  for (const filePath of scanFiles(registry.workspaceRoot)) {
    try {
      await registerTaskFile(filePath, registry.workspaceRoot)
      registry.fileIndex.set(filePath, { mtimeMs: statSync(filePath).mtimeMs, kind: 'task' })
    } catch (error) {
      if (error instanceof QualifiedDefinitionIdError) {
        // A definition file whose id contains '/' cannot be registered; the
        // id is invalid. Record a generic load error.
        registry.loadErrors.push({
          sourcePath: filePath,
          load_error: error.message,
          failedAt: new Date().toISOString(),
          stale: true,
        })
        continue
      }
      const message = error instanceof Error ? error.message : String(error)
      registry.loadErrors.push({
        sourcePath: filePath,
        load_error: message,
        failedAt: new Date().toISOString(),
        stale: true,
      })
    }
  }

  injectBuiltins(registry)
}

/**
 * Re-scans the workspace for changed, new, or deleted definition files.
 * Compares mtimes from the file index, reloads modified files, removes
 * deleted ones, and preserves last-good versions on load failure.
 */
async function refreshDefinitionsIfDirty(workspaceRoot: string): Promise<void> {
  const registry = registryFor(workspaceRoot)
  if (!registry.dirty) return
  registry.dirty = false
  registry.loadErrors = []

  cleanupStaleImportCopies(registry.workspaceRoot)

  const currentFiles = new Set<string>()
  for (const filePath of scanFiles(registry.workspaceRoot)) {
    currentFiles.add(filePath)
    const existing = registry.fileIndex.get(filePath)
    const mtimeMs = statSync(filePath).mtimeMs

    if (!existing || existing.mtimeMs !== mtimeMs || existing.kind !== 'task') {
      // New or changed file — reload
      try {
        await registerTaskFile(filePath, registry.workspaceRoot)
        registry.fileIndex.set(filePath, { mtimeMs, kind: 'task' })
      } catch (error) {
        if (error instanceof QualifiedDefinitionIdError) {
          registry.loadErrors.push({
            sourcePath: filePath,
            load_error: error.message,
            failedAt: new Date().toISOString(),
            stale: true,
          })
          continue
        }
        // Load failure — preserve last-good, record error
        const message = error instanceof Error ? error.message : String(error)
        registry.loadErrors.push({
          sourcePath: filePath,
          load_error: message,
          failedAt: new Date().toISOString(),
          stale: true,
        })
      }
    }
  }

  // Remove deleted files (in index but not on disk)
  for (const [filePath] of registry.fileIndex.entries()) {
    if (!currentFiles.has(filePath)) {
      registry.fileIndex.delete(filePath)
      removeBySourcePath(registry.tasks, filePath)
    }
  }

  // Unchanged duplicate files are not re-imported during a dirty refresh;
  // reassert their same-scope diagnostics from the retained entries.
  recordDuplicateErrorsForEntries(registry, registry.tasks)

  // Reassert builtin entries — always present, regardless of refresh results.
  injectBuiltins(registry)
}

/**
 * Inject (or reassert) the builtin task entries as a global builtin
 * layer. Called after external scan completes and on dirty refresh. Same-id
 * project-scoped external definitions intentionally override builtins via
 * layered resolution; they are NOT rejected as conflicts.
 */
function injectBuiltins(registry: Registry): void {
  registry.tasks = registry.tasks.filter((entry) => entry.source !== 'builtin')
  for (const builtin of BUILTIN_TASKS) {
    registry.tasks.push({
      name: builtin.name,
      definition: builtin.definition,
      sourcePath: BUILTIN_SOURCE_PATH,
      mtime: 0,
      source: 'builtin',
    })
  }
}

export async function registerTaskFile(filePath: string, workspaceRoot: string): Promise<RegisteredTask> {
  const registry = registryFor(workspaceRoot)
  const absolutePath = resolve(filePath)
  const scope = deriveScope(absolutePath, registry.workspaceRoot)
  const name = basename(absolutePath, '.task.ts')
  assertPlainDefinitionId(name)
  const definition = await importDefinition<TaskDefinition>(absolutePath)
  if (definition.__type !== 'task') {
    throw new Error(`${absolutePath} must export default defineTask(...)`)
  }
  assertTaskSchemas(definition.config, absolutePath)
  try {
    assertValidTimeoutMs(definition.config.timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid timeoutMs in ${absolutePath}. ${message}.`)
  }
  if (definition.config.permission === undefined) {
    throw new Error(`Missing required permission in ${absolutePath}. Must be one of: readonly, edit, yolo`)
  }
  if (!VALID_PERMISSIONS.has(definition.config.permission)) {
    throw new Error(`Invalid permission '${definition.config.permission}' in ${absolutePath}. Must be one of: readonly, edit, yolo`)
  }
  if (definition.config.scheduling !== undefined && !VALID_SCHEDULING.has(definition.config.scheduling)) {
    throw new Error(`Invalid scheduling '${String(definition.config.scheduling)}' in ${absolutePath}. Must be one of: active, legacy`)
  }
  if (definition.config.writeTargets !== undefined && definition.config.permission !== 'edit') {
    throw new Error(`writeTargets in ${absolutePath} requires permission 'edit'`)
  }
  validateAgentRuntimeSelector(definition.config, absolutePath)
  resolveTaskCategory(definition.config, absolutePath)

  const duplicate = findDuplicateInScope(registry.tasks, name, scope, absolutePath)
  if (duplicate) {
    recordDuplicateError(registry, name, scope, absolutePath)
  }

  // Remove old entry only after successful import (last-good preservation)
  removeBySourcePath(registry.tasks, absolutePath)
  definition.sourcePath = absolutePath
  const entry: RegisteredTask = {
    name,
    definition,
    sourcePath: absolutePath,
    mtime: statSync(absolutePath).mtimeMs,
    source: scope.source,
    ...(scope.source === 'project' ? { project: scope.project } : {}),
  }
  registry.tasks.push(entry)
  return entry
}

export function invalidateFile(filePath: string, workspaceRoot: string): void {
  const registry = registryFor(workspaceRoot)
  const absolutePath = resolve(filePath)
  removeBySourcePath(registry.tasks, absolutePath)
}

export function resolveTaskTarget(name: string, workspaceRoot: string, currentProject?: string): ResolvedTarget | null {
  const registry = registryFor(workspaceRoot)
  const entry = resolveEntry(registry.tasks, name, currentProject)
  return entry ? taskTarget(entry) : null
}

export function resolveRunTarget(name: string, workspaceRoot: string, currentProject?: string): ResolvedTarget | null {
  return resolveTaskTarget(name, workspaceRoot, currentProject)
}

export function describeTask(name: string, workspaceRoot: string, currentProject?: string): ListedDefinition | null {
  const registry = registryFor(workspaceRoot)
  const entry = resolveEntry(registry.tasks, name, currentProject)
  return entry ? taskToListed(entry) : null
}

export function listTasks(workspaceRoot: string, currentProject?: string): ListedDefinition[] {
  const registry = registryFor(workspaceRoot)
  return effectiveEntries(registry.tasks, currentProject)
    .filter((entry) => entry.definition.config.scheduling !== 'legacy')
    .map((entry) => taskToListed(entry))
}

export function listTaskDefinitions(workspaceRoot: string, currentProject?: string): Array<{
  name: string
  source: DefinitionSource
  project?: string
  description?: string
  category?: {
    id: string
    displayLabel: string
  }
  timeoutMs?: number
  effectiveTimeoutMs?: number
  structuredRetryTimeoutMs?: number
  timeoutScope?: TaskTimeoutScope
}> {
  const registry = registryFor(workspaceRoot)
  return effectiveEntries(registry.tasks, currentProject)
    .filter((entry) => entry.definition.config.scheduling !== 'legacy')
    .map((entry) => {
    const category = resolveTaskCategory(entry.definition.config, entry.sourcePath)
    return {
      name: entry.name,
      source: entry.source,
      ...(entry.project ? { project: entry.project } : {}),
      ...(entry.definition.config.description ? { description: entry.definition.config.description } : {}),
      ...(category ? { category } : {}),
      ...timeoutMetadata(entry.definition.config),
    }
    })
}

export function findTaskDefinition(name: string, workspaceRoot: string, currentProject?: string): ListedDefinition | null {
  return describeTask(name, workspaceRoot, currentProject)
}

export function getLoadErrors(workspaceRoot: string): LoadError[] {
  return registryFor(workspaceRoot).loadErrors
}

export function isPathStale(sourcePath: string, workspaceRoot: string): boolean {
  const registry = registryFor(workspaceRoot)
  return registry.loadErrors.some((e) => e.sourcePath === sourcePath && e.stale)
}

export function resetRegistry(workspaceRoot?: string): void {
  if (workspaceRoot) {
    registries.delete(resolve(workspaceRoot))
    return
  }
  registries.clear()
}

// ── Scope / resolution helpers ───────────────────────────────────────

function assertPlainDefinitionId(name: string): void {
  if (name.includes('/')) {
    throw new QualifiedDefinitionIdError(name)
  }
}

/**
 * Derive the definition scope for a file. Dynamic `.task.ts`
 * definitions are accepted only when they belong to an actual registered
 * project (the registered project whose `.fmproj` directory or managed
 * worktree metadata root contains them). Files outside any registered
 * project root — base checkout dirPath or managed worktree path — have no
 * valid scope and are rejected with a generic invalid-scope error that
 * callers record as a load failure.
 *
 * Both the base checkout root and managed worktree metadata roots map to
 * the same registered project id. When multiple registered roots contain
 * the file, the longest root (most specific) wins.
 */
function deriveScope(filePath: string, workspaceRoot: string): { source: 'project'; project: string } {
  const projects = discoverProjects(workspaceRoot)
  const absolutePath = resolve(filePath)

  const matches: Array<{ projectId: string; rootLen: number }> = []

  // Check each registered project's base checkout root (dirPath).
  for (const [projectId, node] of projects) {
    const dirPath = resolve(node.dirPath)
    if (isWithin(absolutePath, dirPath)) {
      matches.push({ projectId, rootLen: dirPath.length })
    }
  }

  // Check every managed worktree metadata root.
  try {
    const worktreeRoots = listAllManagedWorktreePaths(foremanStateRoot())
    for (const [worktreePath, projectId] of worktreeRoots) {
      if (isWithin(absolutePath, resolve(worktreePath))) {
        matches.push({ projectId, rootLen: resolve(worktreePath).length })
      }
    }
  } catch {
    // State root not configured or unavailable — skip worktree check.
  }

  // Pick the longest matching root (most specific path).
  if (matches.length > 0) {
    matches.sort((a, b) => b.rootLen - a.rootLen)
    return { source: 'project', project: matches[0].projectId }
  }

  throw new Error(
    `${filePath} is outside any registered project; dynamic definitions must live under a project directory. ` +
    `Searched ${projects.size} registered projects and their managed worktree roots.`,
  )
}

/**
 * Resolve one effective definition by id and execution project context.
 * Precedence: nearest/current project scope > ancestor project scopes (near
 * to far) > builtin layer. Returns null if no layer provides the id. Throws
 * `QualifiedDefinitionIdError` for ids containing '/'.
 */
function resolveEntry<T extends RegisteredTask>(
  entries: T[],
  rawName: string,
  currentProject: string | undefined,
): T | null {
  const name = rawName.trim()
  if (!name) return null
  if (name.includes('/')) throw new QualifiedDefinitionIdError(name)

  if (currentProject) {
    for (const projectId of projectAncestorIds(currentProject)) {
      const match = entries.find((entry) => entry.source === 'project' && entry.project === projectId && entry.name === name)
      if (match) return match
    }
  }

  const builtinMatch = entries.find((entry) => entry.source === 'builtin' && entry.name === name)
  return builtinMatch ?? null
}

/**
 * Return the effective overlay of entries for listing. Without a project
 * context, returns the builtin layer (one entry per id). With a project
 * context, returns the project/ancestor/builtin overlay (one entry per id,
 * highest precedence wins).
 */
function effectiveEntries<T extends RegisteredTask>(
  entries: T[],
  currentProject: string | undefined,
): T[] {
  const ids = new Set(entries.map((entry) => entry.name))
  const result: T[] = []
  for (const id of ids) {
    const effective = resolveEntry(entries, id, currentProject)
    if (effective) result.push(effective)
  }
  return result.sort(compareEntries)
}

/**
 * Ancestor project ids for layered resolution, nearest first. Project ids
 * are exact slash-separated paths, so the hierarchy is deterministic even
 * when a test workspace has no `.fmproj` metadata.
 */
function projectAncestorIds(currentProject: string): string[] {
  const normalized = toPosix(currentProject.trim()).replace(/^\/+|\/+$/gu, '')
  if (!normalized) return []
  const segments = normalized.split('/').filter(Boolean)
  const ids: string[] = []
  for (let end = segments.length; end > 0; end -= 1) {
    const projectId = segments.slice(0, end).join('/')
    ids.push(projectId)
  }
  return ids
}

function findDuplicateInScope<T extends RegisteredTask>(
  entries: T[],
  name: string,
  scope: { source: 'project'; project: string },
  sourcePath: string,
): T | undefined {
  return entries.find((entry) => {
    if (entry.name !== name) return false
    if (resolve(entry.sourcePath) !== sourcePath && entry.source !== 'builtin') {
      // Same id, different file, same scope.
      if (scope.source === 'project' && entry.source === 'project' && entry.project === scope.project) return true
    }
    return false
  })
}

function recordDuplicateError(
  registry: Registry,
  name: string,
  scope: { source: 'project'; project: string },
  sourcePath: string,
): void {
  const scopeLabel = scope.project
  if (registry.loadErrors.some((error) =>
    error.kind === 'duplicate_definition' &&
    error.sourcePath === sourcePath &&
    error.id === name &&
    error.scope === scopeLabel,
  )) return
  const message = `Duplicate definition '${name}' in scope '${scopeLabel}'; already registered from another file.`
  registry.loadErrors.push({
    kind: 'duplicate_definition',
    sourcePath,
    id: name,
    scope: scopeLabel,
    message,
    load_error: message,
    failedAt: new Date().toISOString(),
    stale: true,
  })
}

function recordDuplicateErrorsForEntries(
  registry: Registry,
  entries: Array<RegisteredTask>,
): void {
  const seen = new Map<string, RegisteredTask>()
  for (const entry of entries) {
    if (entry.source === 'builtin') continue
    const scopeKey = entry.project ?? ''
    const key = `${entry.source}:${scopeKey}:${entry.name}`
    if (!seen.has(key)) {
      seen.set(key, entry)
      continue
    }
    recordDuplicateError(
      registry,
      entry.name,
      { source: 'project', project: entry.project! },
      resolve(entry.sourcePath),
    )
  }
}

function taskToListed(entry: RegisteredTask): ListedDefinition {
  const normalizedInput = taskInputSchemaWithContext(normalizeSchema(entry.definition.config.input as any))
  const category = resolveTaskCategory(entry.definition.config, entry.sourcePath)
  return {
    name: entry.name,
    source: entry.source,
    ...(entry.project ? { project: entry.project } : {}),
    path: entry.sourcePath,
    ...(entry.definition.config.description ? { description: entry.definition.config.description } : {}),
    ...(category ? { category } : {}),
    agentRuntime: resolveTaskAgentRuntime(entry.definition.config),
    input_schema: normalizedInput,
    output_schema: normalizeSchema(entry.definition.config.output as any),
    structured: true,
    ...(normalizedInput ? { input_example: generateInputExample(normalizedInput as any) } : {}),
    ...(extractGateMetadata(entry.definition.config) ? { gates: extractGateMetadata(entry.definition.config) } : {}),
    permission: entry.definition.config.permission,
    ...timeoutMetadata(entry.definition.config),
    ...capabilitiesMetadata(entry.definition.config),
    ...(entry.definition.config.scheduling
      ? { scheduling: entry.definition.config.scheduling }
      : {}),
  }
}

/** Expose the reserved task-run ctx member without changing definition schemas. */
function taskInputSchemaWithContext(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const value = schema as Record<string, unknown>
  if (Array.isArray(value.anyOf)) {
    return { ...value, anyOf: value.anyOf.map(taskInputSchemaWithContext) }
  }
  if (value.type !== 'object') return schema
  const properties = value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)
    ? value.properties as Record<string, unknown>
    : {}
  return {
    ...value,
    properties: {
      ...properties,
      ctx: {
        type: 'object',
        description: 'Bounded JSON-safe KV context; stripped before task input validation.',
        additionalProperties: true,
      },
    },
  }
}

function capabilitiesMetadata(config: import('../types.mts').TaskConfig): { capabilities?: readonly string[] } {
  if (!config.capabilities) return {}
  return { capabilities: [...config.capabilities.available] }
}

function assertTaskSchemas(config: import('../types.mts').TaskConfig, sourcePath: string): void {
  if (config.input === undefined) {
    throw new Error(`${sourcePath} task config must declare an input schema; use input: {} for tasks with no input`)
  }
  if (config.output === undefined) {
    throw new Error(`${sourcePath} task config must declare an output schema`)
  }
  if (normalizeSchema(config.input as any) === undefined) {
    throw new Error(`${sourcePath} task config input schema is invalid`)
  }
  if (normalizeSchema(config.output as any) === undefined) {
    throw new Error(`${sourcePath} task config output schema is invalid`)
  }
}

function registryFor(workspaceRoot: string): Registry {
  const root = resolve(workspaceRoot)
  let registry = registries.get(root)
  if (!registry) {
    registry = {
      workspaceRoot: root,
      discovered: false,
      dirty: false,
      tasks: [],
      fileIndex: new Map(),
      loadErrors: [],
    }
    registries.set(root, registry)
  }
  return registry
}

function scanFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  scanDirectory(root, files)
  return files
}

function scanDirectory(dir: string, files: string[], depth = 0): void {
  // Safety limit: prevent runaway recursion in edge cases (e.g. deep nesting, symlink cycles)
  if (depth > 20) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      // Additional safety: skip paths containing excluded segments
      if (EXCLUDED_PATH_SEGMENTS.some((seg) => fullPath.includes(`/${seg}/`) || fullPath.endsWith(`/${seg}`))) continue
      scanDirectory(fullPath, files, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (EXCLUDED_FILE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
    if (entry.name.endsWith('.task.ts')) files.push(fullPath)
  }
}

async function importDefinition<T>(filePath: string): Promise<T> {
  let releaseImport: () => void = () => {}
  const previousImport = definitionImportQueue
  definitionImportQueue = new Promise<void>((resolveImport) => {
    releaseImport = resolveImport
  })

  await previousImport
  try {
    return await importDefinitionUnlocked<T>(filePath)
  } finally {
    releaseImport()
  }
}

async function importDefinitionUnlocked<T>(filePath: string): Promise<T> {
  const restore = installRuntimeGlobals({})
  let importPath: string | null = null
  try {
    importPath = createImportCopy(filePath)
    const url = pathToFileURL(importPath)
    url.searchParams.set('v', `${Date.now()}-${Math.random()}`)
    const module = await import(url.href) as { default?: T }
    if (!module.default) throw new Error(`${filePath} must have a default export`)
    return module.default
  } finally {
    if (importPath) rmSync(importPath, { force: true })
    restore()
  }
}

function createImportCopy(filePath: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const importPath = resolve(dirname(filePath), `.foreman-load-${suffix}.ts`)
  copyFileSync(filePath, importPath)
  return importPath
}

function taskTarget(entry: RegisteredTask): ResolvedTarget {
  return {
    definition: entry.definition,
    type: 'task',
    name: entry.name,
    ...(entry.project ? { project: entry.project } : {}),
    source: entry.source,
    sourcePath: entry.sourcePath,
  }
}

function removeBySourcePath<T extends RegisteredTask>(entries: T[], sourcePath: string): void {
  const absolute = resolve(sourcePath)
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].source !== 'builtin' && resolve(entries[i].sourcePath) === absolute) {
      entries.splice(i, 1)
    }
  }
}

function compareEntries(a: RegisteredTask, b: RegisteredTask): number {
  if (a.name !== b.name) return a.name.localeCompare(b.name)
  return a.source.localeCompare(b.source)
}

function isWithin(filePath: string, dirPath: string): boolean {
  const rel = relative(dirPath, filePath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function toPosix(path: string): string {
  return path.replace(/\\/gu, '/')
}

function cleanupStaleImportCopies(root: string): void {
  if (!existsSync(root)) return
  const dirs: string[] = [root]
  const processed = new Set<string>()
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    const resolved = resolve(dir)
    if (processed.has(resolved)) continue
    processed.add(resolved)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = resolve(dir, entry)
      try {
        const st = statSync(fullPath)
        if (st.isDirectory()) {
          const name = entry
          if (EXCLUDED_DIRS.has(name)) continue
          dirs.push(fullPath)
          continue
        }
        if (!st.isFile()) continue
        if (!entry.startsWith('.foreman-load-') || !entry.endsWith('.ts')) continue
        // Stale import copy: remove it
        rmSync(fullPath, { force: true })
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
