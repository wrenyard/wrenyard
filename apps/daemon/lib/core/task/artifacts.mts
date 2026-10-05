import { readFileSync } from 'node:fs'
import { mkdir, open, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ZodType } from 'zod'
import { foremanStateRoot } from '../../config/state.mts'
import { MAX_TASK_ARTIFACTS, TaskArtifactSchema } from './schemas/artifacts.mts'

/**
 * Task artifact runtime.
 *
 * Each run gets its own directory, `<stateRoot>/artifacts/<taskRunId>`. A
 * declared artifact must be a regular file inside that directory. Entries that
 * fail validation are stripped from the output and reported as diagnostics
 * (returned, and persisted next to the artifacts), so a bad artifact never
 * fails the task or triggers a structured retry.
 */

const MAX_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024
const ARTIFACT_VALIDATION_FILENAME = '.artifact-validation.json'

// ─── Artifact directory ─────────────────────────────────────────────

function artifactDirectoryPath(taskRunId: string, stateRoot: string): string {
  const id = taskRunId.trim()
  if (!id || id === '.' || id === '..' || /[\0/\\]/u.test(id)) {
    throw new Error(`Task run id '${taskRunId}' is not a single safe path segment`)
  }
  return join(resolve(stateRoot), 'artifacts', id)
}

/**
 * Create the per-run artifact directory and return its real path, so it
 * compares equal to the real path of the files a task later writes into it.
 */
export async function createTaskArtifactDirectory(
  taskRunId: string,
  stateRoot: string = foremanStateRoot(),
): Promise<string> {
  const directory = artifactDirectoryPath(taskRunId, stateRoot)
  await mkdir(directory, { recursive: true })
  return realpath(directory)
}

// ─── Validation ─────────────────────────────────────────────────────

export interface TaskArtifactDiagnostic {
  /** Position of the entry in the declared array (-1 for whole-array errors). */
  index: number
  /** Declared path when it was a string. */
  path?: string
  reason: string
}

export interface TaskArtifactValidationResult {
  /** Output with invalid artifact entries stripped and all other fields preserved. */
  output: unknown
  /** Diagnostics for every stripped entry. Never throws for entry-level problems. */
  artifactErrors: TaskArtifactDiagnostic[]
}

function isInside(child: string, root: string): boolean {
  const rel = relative(root, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Match PNG / JPEG / GIF / WebP magic bytes. */
function matchesImageMagic(bytes: Uint8Array): boolean {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return true
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return true
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true
  return false
}

async function hasImageMagic(file: string): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(12)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return matchesImageMagic(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** The reason one declared entry is rejected, or `undefined` when it is valid. */
async function artifactRejection(entry: unknown, artifactDirectory: string): Promise<string | undefined> {
  const parsed = TaskArtifactSchema.safeParse(entry)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'artifact'}: ${issue.message}`)
      .join('; ')
    return `invalid artifact metadata (${detail})`
  }
  const artifact = parsed.data
  try {
    // The real path decides containment, so a link cannot point outside.
    const real = await realpath(resolve(artifact.path))
    const info = await stat(real)
    if (!info.isFile()) return 'artifact is not a regular file'
    if (info.size > MAX_ARTIFACT_FILE_BYTES) {
      return `artifact file exceeds the ${MAX_ARTIFACT_FILE_BYTES} byte limit`
    }
    if (!isInside(real, artifactDirectory)) return 'artifact file is outside the artifact directory'
    if (artifact.kind === 'image' && !(await hasImageMagic(real))) {
      return 'image artifact is not a recognized PNG/JPEG/WebP/GIF file'
    }
  } catch {
    return 'artifact file does not exist or could not be read'
  }
  return undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a collected task output's declared artifacts against the run's
 * artifact directory (as returned by {@link createTaskArtifactDirectory}).
 *
 * Only object outputs that declare an `artifacts` field are processed; every
 * other output is returned unchanged. Invalid entries are stripped, valid
 * entries keep their original shape, and all other output fields are
 * preserved. Diagnostics are persisted next to the artifacts and returned.
 */
export async function validateTaskArtifacts(
  output: unknown,
  artifactDirectory: string,
): Promise<TaskArtifactValidationResult> {
  if (!isPlainObject(output) || !('artifacts' in output)) {
    return { output, artifactErrors: [] }
  }
  const errors: TaskArtifactDiagnostic[] = []
  const valid: unknown[] = []
  const declared = output.artifacts
  if (!Array.isArray(declared)) {
    errors.push({ index: -1, reason: 'declared artifacts must be an array' })
  } else {
    for (let index = 0; index < declared.length; index += 1) {
      const entry = declared[index]
      const reason = index < MAX_TASK_ARTIFACTS
        ? await artifactRejection(entry, artifactDirectory)
        : `artifact entry exceeds the ${MAX_TASK_ARTIFACTS} entry limit`
      if (reason === undefined) {
        valid.push(entry)
        continue
      }
      const path = isPlainObject(entry) && typeof entry.path === 'string' ? entry.path : undefined
      errors.push({ index, ...(path === undefined ? {} : { path }), reason })
    }
  }
  // A diagnostics write failure is itself a diagnostic, never a task failure.
  try {
    await writeFile(
      join(artifactDirectory, ARTIFACT_VALIDATION_FILENAME),
      JSON.stringify({ validatedAt: new Date().toISOString(), errors }, null, 2),
      'utf8',
    )
  } catch (error) {
    errors.push({
      index: -1,
      reason: `artifact diagnostics could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  return { output: { ...output, artifacts: valid }, artifactErrors: errors }
}

/** Read the diagnostics persisted for one task run; none when absent. */
export function readTaskArtifactErrors(
  taskRunId: string,
  stateRoot: string = foremanStateRoot(),
): TaskArtifactDiagnostic[] {
  try {
    const sidecar = join(artifactDirectoryPath(taskRunId, stateRoot), ARTIFACT_VALIDATION_FILENAME)
    const errors = (JSON.parse(readFileSync(sidecar, 'utf8')) as { errors?: unknown }).errors
    return Array.isArray(errors)
      ? errors.filter((value): value is TaskArtifactDiagnostic =>
        isPlainObject(value) && typeof value.index === 'number' && typeof value.reason === 'string')
      : []
  } catch {
    return []
  }
}

// ─── Prompt guidance ────────────────────────────────────────────────

/** Fixed English paragraph appended to a task prompt that declares artifacts. */
export function taskArtifactPromptParagraph(artifactDirectory: string): string {
  return [
    '## Artifacts',
    `Files you produce are collected from the runtime-provided artifact directory: ${artifactDirectory}`,
    'Place screenshots or other generated files in that directory and declare each one in the optional `artifacts` output array.',
    'Each entry is `{ "path": "<absolute path>", "kind": "image" | "file", "role": "<short role>", "description": "<what it shows>" }`.',
    'Use `kind: "image"` only for PNG, JPEG, WebP, or GIF files. Files outside the artifact directory are not accepted as artifacts.',
  ].join('\n')
}

/**
 * Resolve a local JSON pointer (`#`, `#/a/b`) against the converted schema
 * root, supporting both `#/$defs/...` and `#/definitions/...`. Remote or
 * external refs and unresolvable pointers return `undefined` (never fetched).
 */
function resolveLocalSchemaRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const rawSegment of ref.slice(2).split('/')) {
    if (!isPlainObject(current)) return undefined
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * Walk a converted JSON schema for an `artifacts` property, descending through
 * `anyOf` / `oneOf` / `allOf` union branches and local `$ref` pointers. Object
 * identity and ref-string guards keep recursive schemas from looping.
 */
function schemaNodeDeclaresArtifacts(
  node: unknown,
  root: unknown,
  visitedNodes: Set<object>,
  visitedRefs: Set<string>,
): boolean {
  if (!isPlainObject(node)) return false
  if (visitedNodes.has(node)) return false
  visitedNodes.add(node)

  const properties = node.properties
  if (isPlainObject(properties) && Object.prototype.hasOwnProperty.call(properties, 'artifacts')) {
    return true
  }

  const ref = node.$ref
  // Local refs only; remote/external refs are intentionally left unresolved.
  if (typeof ref === 'string' && ref.startsWith('#') && !visitedRefs.has(ref)) {
    visitedRefs.add(ref)
    if (schemaNodeDeclaresArtifacts(resolveLocalSchemaRef(root, ref), root, visitedNodes, visitedRefs)) {
      return true
    }
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[keyword]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      if (schemaNodeDeclaresArtifacts(branch, root, visitedNodes, visitedRefs)) return true
    }
  }

  return false
}

/**
 * Whether a task output schema declares an `artifacts` property. Detection
 * descends into union (`anyOf`/`oneOf`/`allOf`) output branches and local
 * `$ref` pointers so discriminated-union outputs still receive the artifact
 * directory prompt.
 */
export function outputSchemaDeclaresArtifacts(schema: unknown): boolean {
  try {
    const json = z.toJSONSchema(schema as ZodType, { target: 'draft-07' }) as Record<string, unknown>
    return schemaNodeDeclaresArtifacts(json, json, new Set<object>(), new Set<string>())
  } catch {
    return false
  }
}
