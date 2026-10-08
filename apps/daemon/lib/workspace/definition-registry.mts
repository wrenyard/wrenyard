import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverProjects } from '../core/project/loader.mts'
import { listAllManagedWorktreePaths } from '../core/project/manager.mts'
import { foremanStateRoot } from '../config/state.mts'
import type {
  InheritanceChainEntry,
  RegisteredTask,
  ResolvedTarget,
  TaskConfig,
  TaskDefinition,
  TaskDispatchRequirements,
  TaskInheritedDeclaration,
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
import { getTaskPromptTemplates, withTaskPromptTemplates } from '../core/task/prompt-template.mts'
import { INTELLIGENCE_ORDER, type IntelligenceTier, normalizeIntelligenceTier, normalizeReasoningEffort } from '@wrenyard/providers/catalog'
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
  /** Loaded `extends` declarations by source path. Each one is merged onto its
   *  base by `resolveAllInherited`; only a successful merge reaches `tasks`. */
  inherited: Map<string, InheritedSource>
  fileIndex: Map<string, { mtimeMs: number; kind: 'task' }>
  loadErrors: LoadError[]
}

interface InheritedSource {
  name: string
  project: string
  sourcePath: string
  mtime: number
  declaration: TaskInheritedDeclaration
}

export interface ListedDefinition {
  name: string
  /** Provenance: `'builtin'` or `'project'`. */
  source: DefinitionSource
  /** Registered project id; only for `source === 'project'`. */
  project?: string
  path: string
  description?: string
  /** Optional authoritative human-facing display label from the final
   *  (project-overridden) definition. Trimmed single-line metadata only. */
  displayName?: string
  /** Resolved optional task category ({id, displayLabel}); present only when
   *  the final (project-overridden) definition declares one. */
  category?: {
    id: string
    displayLabel: string
  }
  input_schema?: unknown
  output_schema?: unknown
  structured?: boolean
  input_example?: Record<string, unknown>
  gates?: {
    pre?: Array<{ id: string; description?: string }>
    post?: Array<{ id: string; description?: string }>
  }
  timeoutMs?: number
  effectiveTimeoutMs?: number
  structuredRetryTimeoutMs?: number
  timeoutScope?: TaskTimeoutScope
  /** Available Wrenyard capability pack ids declared by the task config.
   *  Present only when the task declares execution features. */
  features?: readonly string[]
  /** `legacy` definitions remain exactly describable/resolvable for persisted
   *  work, but are omitted from new-work list surfaces. Current source-authored
   *  legacy definitions are pin-free — exact runtime recovery comes from
   *  persisted run/execution records, never a definition profile. */
  scheduling?: 'active' | 'legacy'
  /** Reserved for historical describe projections only. Current source-authored
   *  legacy definitions never expose a profile pin. */
  profile?: string
  /** Validated explicit dispatch requirements, projected from the task config. */
  dispatch?: TaskDispatchRequirements
  /** Base→effective inheritance chain; present only when the definition was
   *  resolved from an inherited declaration (`defineTask({ extends, ... })`). */
  inheritanceChain?: InheritanceChainEntry[]
}

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'coverage', '.nyc_output'])
const EXCLUDED_FILE_PREFIXES = ['.foreman-load-']
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

/**
 * Validate the runtime-pin contract for a definition. Neither Active nor
 * `scheduling: 'legacy'` Tasks pin a runtime in current source: they select
 * automatically from dispatch, and explicit selection belongs to Task
 * settings, not Task definitions. Definitions carrying the retired
 * `agentRuntime` or `profile` fields — including untyped JS exports — are
 * rejected exactly like the no-pin invariant. `scheduling: 'legacy'` remains a
 * valid discriminated mode so persisted work stays resolvable while omitted
 * from new-work surfaces; exact runtime recovery comes from persisted
 * run/execution records, never a definition profile.
 */
function validateTaskRuntimePin(config: TaskConfig, sourcePath: string): void {
  const raw = config as unknown as Record<string, unknown>
  if ('agentRuntime' in raw) {
    throw new Error(
      `${sourcePath} task config agentRuntime is no longer supported; Tasks select automatically from dispatch`,
    )
  }
  if ('profile' in raw && raw.profile !== undefined) {
    throw new Error(
      `${sourcePath} task config profile is no longer supported in definitions; exact runtime recovery comes from persisted run/execution records, never a definition profile`,
    )
  }
}

/**
 * Runtime compatibility for pre-YOLO source definitions. Permission is no
 * longer task-authoring state and is never projected or sent to execution.
 * Recognized legacy write modes are used once only to retain their conservative
 * repo-wide coordination marker when no explicit writeTargets declaration was
 * authored; every legacy value is then removed from the registered config.
 */
function normalizeLegacyTaskPermission(config: TaskConfig): TaskConfig {
  const raw = config as TaskConfig & { permission?: unknown }
  const { permission, ...current } = raw
  if (
    current.writeTargets === undefined &&
    (permission === 'edit' || permission === 'yolo')
  ) {
    return { ...current, writeTargets: () => [] } as TaskConfig
  }
  return current as TaskConfig
}

/**
 * Validate the optional explicit dispatch requirements against the catalog-shaped
 * contract (single SSOT, `@wrenyard/auto-routing` TaskDispatchRequirements). Every
 * field is individually optional, but a dispatch block must declare at least one
 * recognized hard requirement or it is meaningless. Malformed TPS, price,
 * intelligence tiers, per-axis exclusions, or required capabilities fail
 * definition validation so a bad range can never reach execution. Legacy
 * definitions without a `dispatch` block are preserved untouched. Legacy alias
 * keys (intelligence, maximumOutputUsdPerMillion, exclusions) are rejected
 * explicitly rather than silently accepted so stale shapes fail clearly.
 * Validation never synthesizes a wider profile pool — exact declared profiles
 * remain exact, and resolver behavior is unchanged.
 */
function validateTaskDispatch(config: TaskConfig, sourcePath: string, options?: { inherited?: boolean }): void {
  const raw = config.dispatch as Record<string, unknown> | undefined
  if (raw === undefined) {
    if (options?.inherited) return
    throw new Error(`${sourcePath} task config dispatch.expectedReasoningEffort is required`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${sourcePath} task config dispatch must be an object when present`)
  }

  // The reasoning-effort family replaced the legacy thinking family. ANY legacy
  // `thinking` field — on a definition or an inherited declaration, before merge
  // — is rejected with the exact field id rather than silently accepted.
  if ('thinking' in raw) {
    throw new Error(
      `${sourcePath} task config dispatch.thinking is no longer supported; use dispatch.expectedReasoningEffort`,
    )
  }

  // Reject legacy alias keys explicitly rather than silently accepting them.
  for (const legacyKey of ['intelligence', 'intelligenceMax', 'intelligence_max', 'maximumOutputUsdPerMillion', 'exclusions'] as const) {
    if (legacyKey in raw) {
      throw new Error(
        `${sourcePath} task config dispatch.${legacyKey} is no longer supported; use the current TaskDispatchRequirements shape (expectedTps/minimumTps, intelligenceMin/intelligenceExpected, maxOutputUsdPerMillion, excludeModelIds/excludeProfileIds/excludeClientIds/excludeProviderIds, requiredCapabilities)`,
      )
    }
  }
  for (const removedKey of ['preferredRuntime', 'preferred_runtime'] as const) {
    if (removedKey in raw) {
      throw new Error(
        `${sourcePath} task config dispatch.${removedKey} is no longer supported; choose explicit mode with an alias or exact target through Task Settings`,
      )
    }
  }

  const {
    expectedTps,
    minimumTps,
    maxOutputUsdPerMillion,
    requiredCapabilities,
    excludeModelIds,
    excludeProfileIds,
    excludeClientIds,
    excludeProviderIds,
    requiresWebSearch,
    expectedReasoningEffort,
  } = raw

  // The dispatch object must contain at least one recognized hard requirement.
  const hasRecognizedHardRequirement = [
    expectedTps,
    minimumTps,
    raw.intelligenceMin,
    raw.intelligenceExpected,
    maxOutputUsdPerMillion,
    requiredCapabilities,
    excludeModelIds,
    excludeProfileIds,
    excludeClientIds,
    excludeProviderIds,
    requiresWebSearch,
    expectedReasoningEffort,
  ].some((value) => value !== undefined)
  if (!hasRecognizedHardRequirement) {
    throw new Error(
      `${sourcePath} task config dispatch must declare at least one requirement (expectedTps/minimumTps, intelligenceMin/intelligenceExpected, maxOutputUsdPerMillion, requiredCapabilities, or an exclude* axis)`,
    )
  }

  if (expectedTps !== undefined) {
    if (typeof expectedTps !== 'number' || !Number.isFinite(expectedTps) || expectedTps <= 0) {
      throw new Error(`${sourcePath} task config dispatch.expectedTps must be a positive number`)
    }
  }
  if (minimumTps !== undefined) {
    if (typeof minimumTps !== 'number' || !Number.isFinite(minimumTps) || minimumTps <= 0) {
      throw new Error(`${sourcePath} task config dispatch.minimumTps must be a positive number`)
    }
  }
  if (expectedTps !== undefined && minimumTps !== undefined && expectedTps < minimumTps) {
    throw new Error(
      `${sourcePath} task config dispatch.expectedTps (${expectedTps}) must be >= minimumTps (${minimumTps})`,
    )
  }

  // Strictly validate the intelligence tiers against the four-tier contract.
  // The current strict normalizer rejects the retired `frontier` alias and any
  // unknown value; it will be corrected upstream to the final contract. No
  // legacy normalization or raw mutation is performed here, so the projected
  // definition stays exactly as authored. Missing expected remains undefined.
  const normalizedIntelligenceMin =
    raw.intelligenceMin !== undefined && typeof raw.intelligenceMin === 'string'
      ? normalizeIntelligenceTier(raw.intelligenceMin)
      : undefined
  if (raw.intelligenceMin !== undefined && normalizedIntelligenceMin === undefined) {
    throw new Error(`${sourcePath} task config dispatch.intelligenceMin must be one of: low, mid, high, premium`)
  }
  const normalizedIntelligenceExpected =
    raw.intelligenceExpected !== undefined && typeof raw.intelligenceExpected === 'string'
      ? normalizeIntelligenceTier(raw.intelligenceExpected)
      : undefined
  if (raw.intelligenceExpected !== undefined && normalizedIntelligenceExpected === undefined) {
    throw new Error(`${sourcePath} task config dispatch.intelligenceExpected must be one of: low, mid, high, premium`)
  }
  if (
    normalizedIntelligenceExpected !== undefined &&
    normalizedIntelligenceMin !== undefined &&
    INTELLIGENCE_ORDER[normalizedIntelligenceExpected as IntelligenceTier] < INTELLIGENCE_ORDER[normalizedIntelligenceMin as IntelligenceTier]
  ) {
    throw new Error(`${sourcePath} task config dispatch.intelligenceExpected cannot be below intelligenceMin`)
  }

  if (maxOutputUsdPerMillion !== undefined) {
    if (typeof maxOutputUsdPerMillion !== 'number' || !Number.isFinite(maxOutputUsdPerMillion) || maxOutputUsdPerMillion <= 0) {
      throw new Error(`${sourcePath} task config dispatch.maxOutputUsdPerMillion must be a positive number`)
    }
  }

  if (requiredCapabilities !== undefined && requiredCapabilities !== null) {
    if (!Array.isArray(requiredCapabilities) || !requiredCapabilities.every((entry) => typeof entry === 'string' && entry.length > 0)) {
      throw new Error(`${sourcePath} task config dispatch.requiredCapabilities must be an array of non-empty strings`)
    }
  }

  // Native web search is a recognized dispatch requirement; it is a boolean-only
  // hidden gate (never a search settings UI control). Accept only booleans.
  if (requiresWebSearch !== undefined && requiresWebSearch !== null && typeof requiresWebSearch !== 'boolean') {
    throw new Error(`${sourcePath} task config dispatch.requiresWebSearch must be a boolean`)
  }

  // Reasoning effort is the required dispatch declaration. Every task declares
  // the public level it expects; inherited declarations may omit it to inherit
  // the base's level. Only the six canonical levels are accepted (including
  // `none`); the retired `midium` spelling and every unknown value are rejected.
  if (expectedReasoningEffort === undefined) {
    if (!options?.inherited) {
      throw new Error(
        `${sourcePath} task config dispatch.expectedReasoningEffort is required and must be one of: none, low, medium, high, xhigh, max`,
      )
    }
  } else if (
    typeof expectedReasoningEffort !== 'string'
    || normalizeReasoningEffort(expectedReasoningEffort) === undefined
  ) {
    throw new Error(
      `${sourcePath} task config dispatch.expectedReasoningEffort must be one of: none, low, medium, high, xhigh, max`,
    )
  }

  for (const axis of ['excludeModelIds', 'excludeProfileIds', 'excludeClientIds', 'excludeProviderIds'] as const) {
    const value = raw[axis]
    if (value !== undefined && value !== null) {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
        throw new Error(`${sourcePath} task config dispatch.${axis} must be an array of non-empty strings`)
      }
    }
  }
}

const CATEGORY_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u
const CATEGORY_DISPLAY_MAX = 24
const TASK_DISPLAY_NAME_MAX = 80

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

/**
 * Validate an optional task displayName and return its canonical normalized
 * form. `displayName` is authoritative human-facing display metadata only: a
 * trimmed single-line label of 1..80 UTF-16 code units that never changes the
 * task id, scheduling, resolution, or execution semantics. Returns `undefined`
 * when the task declares none (backwards compatible); throws on an invalid
 * value. The returned string is the single canonical value stored in every
 * list/describe surface, so a padded label is trimmed exactly once and raw
 * config never leaks into summaries.
 */
function resolveTaskDisplayName(config: TaskConfig, sourcePath: string): string | undefined {
  const displayName = config.displayName
  if (displayName === undefined) return undefined
  if (typeof displayName !== 'string') {
    throw new Error(`${sourcePath} task config displayName must be a string when present`)
  }
  const normalized = displayName.trim()
  if (normalized.length === 0) {
    throw new Error(`${sourcePath} task config displayName must be a non-empty string after trimming whitespace`)
  }
  if (/[\r\n]/u.test(normalized)) {
    throw new Error(`${sourcePath} task config displayName must not contain CR or LF line breaks`)
  }
  if (normalized.length > TASK_DISPLAY_NAME_MAX) {
    throw new Error(`${sourcePath} task config displayName must not exceed ${TASK_DISPLAY_NAME_MAX} UTF-16 code units`)
  }
  return normalized
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
  registry.inherited.clear()
  registry.fileIndex.clear()
  registry.loadErrors = []
  registry.discovered = true
  registry.dirty = false

  cleanupStaleImportCopies(registry.workspaceRoot)

  // Builtins are the terminal inheritance layer: inject them before any
  // external definition so a child that extends a builtin resolves regardless
  // of scan order.
  injectBuiltins(registry)

  for (const filePath of scanFiles(registry.workspaceRoot)) {
    try {
      commitLoaded(registry, await loadTaskFile(filePath, registry.workspaceRoot))
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

  // Resolve inherited declarations after the full scan so a project child
  // resolves its ancestor/builtin base regardless of directory order.
  resolveAllInherited(registry)
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
        commitLoaded(registry, await loadTaskFile(filePath, registry.workspaceRoot))
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
      registry.inherited.delete(resolve(filePath))
      removeBySourcePath(registry.tasks, filePath)
    }
  }

  // Unchanged duplicate files are not re-imported during a dirty refresh;
  // reassert their same-scope diagnostics from the retained entries.
  recordDuplicateErrorsForEntries(registry, registry.tasks)

  // Reassert builtin entries — always present, regardless of refresh results.
  injectBuiltins(registry)

  // Recompute every inherited definition so a changed, removed or inserted
  // base propagates through the chain.
  resolveAllInherited(registry)
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
    validateTaskRuntimePin(builtin.definition.config, BUILTIN_SOURCE_PATH)
    registry.tasks.push({
      name: builtin.name,
      definition: builtin.definition,
      sourcePath: BUILTIN_SOURCE_PATH,
      mtime: 0,
      source: 'builtin',
    })
  }
}

/**
 * Import and validate one definition file without mutating the registry. A
 * complete definition comes back as its registry entry; an `extends`
 * declaration comes back unmerged, because its base may not be loaded yet.
 */
async function loadTaskFile(filePath: string, workspaceRoot: string): Promise<RegisteredTask | InheritedSource> {
  const registry = registryFor(workspaceRoot)
  const absolutePath = resolve(filePath)
  const scope = deriveScope(absolutePath, registry.workspaceRoot)
  const name = basename(absolutePath, '.task.ts')
  assertPlainDefinitionId(name)
  const definition = await importDefinition<TaskDefinition>(absolutePath)
  if (definition.__type !== 'task') {
    throw new Error(`${absolutePath} must export default defineTask(...)`)
  }
  const mtime = statSync(absolutePath).mtimeMs

  if (definition.declaration !== undefined) {
    validateInheritedDeclaration(definition.declaration, name, absolutePath)
    return { name, project: scope.project, sourcePath: absolutePath, mtime, declaration: definition.declaration }
  }

  if (Object.prototype.hasOwnProperty.call(definition.config, 'promptAppend')) {
    throw new Error(
      `${absolutePath} task config declares promptAppend without extends; promptAppend is only valid on an inherited definition (defineTask({ extends, promptAppend }))`,
    )
  }
  assertTaskSchemas(definition.config, absolutePath)
  try {
    assertValidTimeoutMs(definition.config.timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid timeoutMs in ${absolutePath}. ${message}.`)
  }
  definition.config = normalizeLegacyTaskPermission(definition.config)
  if (definition.config.scheduling !== undefined && !VALID_SCHEDULING.has(definition.config.scheduling)) {
    throw new Error(`Invalid scheduling '${String(definition.config.scheduling)}' in ${absolutePath}. Must be one of: active, legacy`)
  }
  validateTaskRuntimePin(definition.config, absolutePath)
  validateTaskDispatch(definition.config, absolutePath)
  if (definition.config.dispatch?.expectedReasoningEffort !== undefined) {
    definition.config = { ...definition.config, dispatch: { ...definition.config.dispatch,
      expectedReasoningEffort: normalizeReasoningEffort(definition.config.dispatch.expectedReasoningEffort),
    } }
  }
  resolveTaskCategory(definition.config, absolutePath)
  resolveTaskDisplayName(definition.config, absolutePath)

  definition.sourcePath = absolutePath
  return {
    name,
    definition,
    sourcePath: absolutePath,
    mtime,
    source: scope.source,
    ...(scope.source === 'project' ? { project: scope.project } : {}),
  }
}

/** Detect same-scope duplicates and swap the entry into the registry. */
function commitEntry(registry: Registry, entry: RegisteredTask): void {
  const scope = { source: 'project' as const, project: entry.project ?? '' }
  const duplicate = findDuplicateInScope(registry.tasks, entry.name, scope, entry.sourcePath)
  if (duplicate) {
    recordDuplicateError(registry, entry.name, scope, entry.sourcePath)
  }

  // Remove old entry only after successful import (last-good preservation)
  removeBySourcePath(registry.tasks, entry.sourcePath)
  registry.tasks.push(entry)
}

/**
 * Record one loaded file. An `extends` declaration only joins the pending set:
 * whatever the file last resolved to stays registered until
 * `resolveAllInherited` merges the new declaration successfully.
 */
function commitLoaded(registry: Registry, loaded: RegisteredTask | InheritedSource): void {
  if ('declaration' in loaded) {
    registry.inherited.set(loaded.sourcePath, loaded)
    return
  }
  registry.inherited.delete(loaded.sourcePath)
  commitEntry(registry, loaded)
}

export async function registerTaskFile(filePath: string, workspaceRoot: string): Promise<RegisteredTask> {
  const registry = registryFor(workspaceRoot)
  // A direct registration into a fresh (never-discovered) registry must still
  // see the builtin layer so a child that extends a builtin resolves.
  if (!registry.discovered) injectBuiltins(registry)
  const loaded = await loadTaskFile(filePath, workspaceRoot)
  if (!('declaration' in loaded)) {
    commitLoaded(registry, loaded)
    return loaded
  }
  // Resolve first: a missing or invalid base throws before anything changes.
  const entry = resolveInherited(registry, loaded, new Map())
  registry.inherited.set(loaded.sourcePath, loaded)
  return entry
}

export function invalidateFile(filePath: string, workspaceRoot: string): void {
  const registry = registryFor(workspaceRoot)
  const absolutePath = resolve(filePath)
  registry.inherited.delete(absolutePath)
  removeBySourcePath(registry.tasks, absolutePath)
}

// ── Inheritance resolution ───────────────────────────────────────────

/** Fixed heading inserted between the inherited base prompt and each layer's
 *  `promptAppend` body. */
const INHERITANCE_PROMPT_HEADING = '\n\n## Project task instructions\n\n'

const INHERITED_ALLOWED_FIELDS = new Set([
  'extends',
  'promptAppend',
  'instructions',
  'dispatch',
  'timeoutMs',
  'displayName',
  'description',
  'category',
])

type TaskInstruction = string | ((input?: unknown) => string | Promise<string>)

/**
 * Validate one inherited declaration against the inherited authoring contract.
 * Only the inherited fields are legal; every other key — including a forbidden
 * key whose value is explicit `undefined` or an unknown field — is rejected
 * before any legacy normalization. `extends` must be a non-empty string that
 * exactly equals the filename task id.
 */
function validateInheritedDeclaration(
  declaration: TaskInheritedDeclaration,
  name: string,
  sourcePath: string,
): void {
  const raw = declaration as unknown as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!INHERITED_ALLOWED_FIELDS.has(key)) {
      throw new Error(
        `${sourcePath} task config declares '${key}' on an inherited definition (extends '${String(raw.extends)}'); inherited definitions may only declare ${[...INHERITED_ALLOWED_FIELDS].join(', ')}`,
      )
    }
  }

  const ext = raw.extends
  if (typeof ext !== 'string' || ext.length === 0) {
    throw new Error(`${sourcePath} task config extends must be a non-empty string task id`)
  }
  if (ext !== name) {
    throw new Error(
      `${sourcePath} task config extends '${ext}' must exactly equal the definition file task id '${name}'`,
    )
  }

  const promptAppend = raw.promptAppend
  if (promptAppend !== undefined && typeof promptAppend !== 'string' && typeof promptAppend !== 'function') {
    throw new Error(`${sourcePath} task config promptAppend must be a string or a function returning a string`)
  }

  const instructions = raw.instructions
  if (instructions !== undefined) {
    if (
      !Array.isArray(instructions) ||
      !instructions.every((item) => typeof item === 'string' || typeof item === 'function')
    ) {
      throw new Error(`${sourcePath} task config instructions must be an array of strings or functions`)
    }
  }

  const timeoutMs = raw.timeoutMs
  if (timeoutMs !== undefined) {
    try {
      assertValidTimeoutMs(timeoutMs)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid timeoutMs in ${sourcePath}. ${message}.`)
    }
  }

  // Raw child dispatch is validated on its own before the merge. An inherited
  // declaration may omit expectedReasoningEffort to inherit the base's level,
  // but ANY legacy thinking field is rejected here, before merge.
  validateTaskDispatch({ dispatch: raw.dispatch } as unknown as TaskConfig, sourcePath, { inherited: true })
  resolveTaskCategory({ category: raw.category } as unknown as TaskConfig, sourcePath)
  resolveTaskDisplayName({ displayName: raw.displayName } as unknown as TaskConfig, sourcePath)
}

/** Base instructions first, then the child's, without repeating an entry. */
function mergeInstructions(
  base: TaskInstruction[] | undefined,
  child: TaskInstruction[] | undefined,
): TaskInstruction[] | undefined {
  if (base === undefined && child === undefined) return undefined
  return [...new Set([...(base ?? []), ...(child ?? [])])]
}

function higherIntelligence(
  base: IntelligenceTier | undefined,
  child: IntelligenceTier | undefined,
): IntelligenceTier {
  if (base === undefined) return child as IntelligenceTier
  if (child === undefined) return base
  return INTELLIGENCE_ORDER[child] > INTELLIGENCE_ORDER[base] ? child : base
}

/**
 * Merge a child inherited declaration onto its resolved base config.
 * `requiredCapabilities` forms a stable union and `intelligenceMin` takes the
 * harder tier, so a child omission or empty list can never weaken a base
 * requirement. Every other dispatch field is a plain child override.
 */
function mergeDispatch(
  base: TaskDispatchRequirements | undefined,
  child: TaskDispatchRequirements | undefined,
): TaskDispatchRequirements | undefined {
  if (base === undefined && child === undefined) return undefined
  const merged: Record<string, unknown> = { ...(base ?? {}) }
  if (child !== undefined) {
    for (const [key, value] of Object.entries(child)) {
      if (key === 'requiredCapabilities' || key === 'intelligenceMin') continue
      if (value !== undefined) merged[key] = value
    }
    const baseCapabilities = base?.requiredCapabilities ?? []
    if (baseCapabilities.length > 0 || child.requiredCapabilities !== undefined) {
      merged.requiredCapabilities = [...new Set([...baseCapabilities, ...(child.requiredCapabilities ?? [])])]
    }
    if (base?.intelligenceMin !== undefined || child.intelligenceMin !== undefined) {
      merged.intelligenceMin = higherIntelligence(base?.intelligenceMin, child.intelligenceMin)
    }
    // A child that raises the floor without restating `intelligenceExpected`
    // (an explicit `undefined` counts as restating it) would leave the base
    // expectation below the new floor, which validation rejects; lift the
    // inherited expectation to the floor instead. An expectation the child
    // states itself is left as written.
    const childSuppliesExpected = Object.prototype.hasOwnProperty.call(child, 'intelligenceExpected')
    const effectiveMin = merged.intelligenceMin as IntelligenceTier | undefined
    const effectiveExpected = merged.intelligenceExpected as IntelligenceTier | undefined
    if (
      !childSuppliesExpected &&
      effectiveMin !== undefined &&
      effectiveExpected !== undefined &&
      INTELLIGENCE_ORDER[effectiveExpected] < INTELLIGENCE_ORDER[effectiveMin]
    ) {
      merged.intelligenceExpected = effectiveMin
    }
  }
  return merged as TaskDispatchRequirements
}

/** Compose base prompt + optional per-layer append under the fixed heading. */
function composeInheritedPrompt(
  basePrompt: TaskConfig['prompt'],
  promptAppend: TaskInheritedDeclaration['promptAppend'],
): TaskConfig['prompt'] {
  if (promptAppend === undefined) return basePrompt
  const composed = async (input: unknown): Promise<string> => {
    const baseText = await basePrompt(input)
    const appended = typeof promptAppend === 'function' ? await promptAppend(input) : promptAppend
    if (typeof appended !== 'string') {
      // A function-typed append that resolves to a non-string is a programming
      // error: silently dropping it would discard the user's project rule.
      // An empty string is an explicit no-op that preserves the base prompt.
      throw new Error(
        `Inherited task promptAppend must resolve to a string; received ${typeof appended}`,
      )
    }
    if (appended.length === 0) return baseText
    return `${baseText}${INHERITANCE_PROMPT_HEADING}${appended}`
  }
  // Preserve the base's static template metadata so execution placeholder
  // capture and non-executing previews stay identical across inheritance.
  const templates = getTaskPromptTemplates(basePrompt)
  return templates.length > 0 ? withTaskPromptTemplates(composed, templates) : composed
}

/** Merge one inherited declaration onto a resolved base config. */
function mergeInheritedConfig(
  base: TaskConfig,
  declaration: TaskInheritedDeclaration,
  sourcePath: string,
): TaskConfig {
  const instructions = mergeInstructions(base.instructions, declaration.instructions)
  const dispatch = mergeDispatch(base.dispatch, declaration.dispatch)
  const displayName = resolveTaskDisplayName(declaration as unknown as TaskConfig, sourcePath)
  const category = resolveTaskCategory(declaration as unknown as TaskConfig, sourcePath)
  const merged: TaskConfig = {
    ...base,
    prompt: composeInheritedPrompt(base.prompt, declaration.promptAppend),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(dispatch !== undefined ? { dispatch } : {}),
    ...(declaration.timeoutMs !== undefined ? { timeoutMs: declaration.timeoutMs } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    ...(category !== undefined ? { category } : {}),
  }

  // The merged dispatch must satisfy the same contract as an authored one.
  validateTaskDispatch(merged, sourcePath)
  if (merged.dispatch?.expectedReasoningEffort !== undefined) {
    merged.dispatch = {
      ...merged.dispatch,
      expectedReasoningEffort: normalizeReasoningEffort(merged.dispatch.expectedReasoningEffort),
    }
  }
  return merged
}

function inheritanceDescriptor(entry: RegisteredTask): InheritanceChainEntry {
  return entry.source === 'builtin'
    ? { source: 'builtin', path: entry.sourcePath }
    : { source: 'project', project: entry.project!, path: entry.sourcePath }
}

/**
 * The next lower same-id definition: the nearest ancestor project (never the
 * child's own scope), then the builtin layer. An ancestor that is itself an
 * inherited declaration is resolved first, so the child never merges onto a
 * superseded result.
 */
function resolveInheritanceBase(
  registry: Registry,
  source: InheritedSource,
  resolved: Map<string, RegisteredTask>,
): RegisteredTask | undefined {
  for (const projectId of projectAncestorIds(source.project).slice(1)) {
    const pending = [...registry.inherited.values()].find(
      (candidate) => candidate.project === projectId && candidate.name === source.name,
    )
    if (pending) return resolveInherited(registry, pending, resolved)
    const match = registry.tasks.find(
      (candidate) => candidate.source === 'project' && candidate.project === projectId && candidate.name === source.name,
    )
    if (match) return match
  }
  return registry.tasks.find((candidate) => candidate.source === 'builtin' && candidate.name === source.name)
}

/**
 * Merge one inherited declaration onto its base and register the result.
 * Throws when the base is missing, failed to load, or the merge is invalid;
 * the registry is untouched in that case, so the file's last-good entry stays.
 */
function resolveInherited(
  registry: Registry,
  source: InheritedSource,
  resolved: Map<string, RegisteredTask>,
): RegisteredTask {
  const done = resolved.get(source.sourcePath)
  if (done) return done
  const base = resolveInheritanceBase(registry, source, resolved)
  if (!base) {
    throw new Error(
      `${source.sourcePath} task definition extends '${source.declaration.extends}' but no lower-scope ancestor or builtin definition with that id is registered`,
    )
  }
  // A base whose file failed to reload is still registered with its last-good
  // config. Merging onto it would run this definition from a parent that no
  // longer compiles, so fail here and keep this file's own last-good entry.
  if (registry.loadErrors.some((error) =>
    error.kind === undefined && error.stale && resolve(error.sourcePath) === resolve(base.sourcePath),
  )) {
    throw new Error(
      `${source.sourcePath} task definition extends '${source.declaration.extends}' but its base '${base.sourcePath}' failed to load; retaining last-good resolution`,
    )
  }
  const entry: RegisteredTask = {
    name: source.name,
    definition: {
      __type: 'task',
      config: mergeInheritedConfig(base.definition.config, source.declaration, source.sourcePath),
      sourcePath: source.sourcePath,
    },
    sourcePath: source.sourcePath,
    mtime: source.mtime,
    source: 'project',
    project: source.project,
    inheritanceChain: [
      ...(base.inheritanceChain ?? [inheritanceDescriptor(base)]),
      { source: 'project', project: source.project, path: source.sourcePath },
    ],
  }
  commitEntry(registry, entry)
  resolved.set(source.sourcePath, entry)
  return entry
}

/**
 * Merge every loaded inherited declaration onto its current base. A failure
 * leaves the file's last-good entry registered and records a stale diagnostic.
 */
function resolveAllInherited(registry: Registry): void {
  const resolved = new Map<string, RegisteredTask>()
  for (const source of registry.inherited.values()) {
    try {
      resolveInherited(registry, source, resolved)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!registry.loadErrors.some((existing) => existing.sourcePath === source.sourcePath && existing.load_error === message)) {
        registry.loadErrors.push({
          sourcePath: source.sourcePath,
          load_error: message,
          failedAt: new Date().toISOString(),
          stale: true,
        })
      }
    }
  }
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
  displayName?: string
  category?: {
    id: string
    displayLabel: string
  }
  timeoutMs?: number
  effectiveTimeoutMs?: number
  structuredRetryTimeoutMs?: number
  timeoutScope?: TaskTimeoutScope
  scheduling?: 'active' | 'legacy'
  dispatch?: TaskDispatchRequirements
  inheritanceChain?: InheritanceChainEntry[]
}> {
  const registry = registryFor(workspaceRoot)
  return effectiveEntries(registry.tasks, currentProject)
    .filter((entry) => entry.definition.config.scheduling !== 'legacy')
    .map((entry) => {
    const category = resolveTaskCategory(entry.definition.config, entry.sourcePath)
    const displayName = resolveTaskDisplayName(entry.definition.config, entry.sourcePath)
    return {
      name: entry.name,
      source: entry.source,
      ...(entry.project ? { project: entry.project } : {}),
      ...(entry.definition.config.description ? { description: entry.definition.config.description } : {}),
      ...(displayName ? { displayName } : {}),
      ...(category ? { category } : {}),
      ...(entry.definition.config.scheduling
        ? { scheduling: entry.definition.config.scheduling }
        : {}),
      ...timeoutMetadata(entry.definition.config),
      ...(entry.definition.config.dispatch ? { dispatch: entry.definition.config.dispatch } : {}),
      ...(entry.inheritanceChain ? { inheritanceChain: entry.inheritanceChain } : {}),
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
  const displayName = resolveTaskDisplayName(entry.definition.config, entry.sourcePath)
  const config = entry.definition.config
  return {
    name: entry.name,
    source: entry.source,
    ...(entry.project ? { project: entry.project } : {}),
    path: entry.sourcePath,
    ...(config.description ? { description: config.description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(category ? { category } : {}),
    input_schema: normalizedInput,
    output_schema: normalizeSchema(config.output as any),
    structured: true,
    ...(normalizedInput ? { input_example: generateInputExample(normalizedInput as any) } : {}),
    ...(extractGateMetadata(config) ? { gates: extractGateMetadata(config) } : {}),
    ...timeoutMetadata(config),
    ...featuresMetadata(config),
    ...(config.scheduling
      ? { scheduling: config.scheduling }
      : {}),
    // Historical projection only: current source-authored definitions never
    // carry a profile pin, so this fallback stays inert for new definitions.
    ...(config.scheduling === 'legacy' && typeof config.profile === 'string'
      ? { profile: config.profile }
      : {}),
    ...(config.dispatch ? { dispatch: config.dispatch } : {}),
    ...(entry.inheritanceChain ? { inheritanceChain: entry.inheritanceChain } : {}),
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

function featuresMetadata(config: import('../types.mts').TaskConfig): { features?: readonly string[] } {
  if (!config.features) return {}
  return { features: [...config.features.available] }
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
      inherited: new Map(),
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
    const module = await import(url.href) as { default?: T | { __esModule?: boolean; default?: T } }
    let definition = module.default
    // Node can expose transpiled CommonJS exports through an extra default
    // namespace when a user directory has no ESM package boundary.
    if (definition && typeof definition === 'object'
      && '__esModule' in definition && definition.__esModule === true
      && 'default' in definition) definition = definition.default
    if (!definition) throw new Error(`${filePath} must have a default export`)
    return definition as T
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
