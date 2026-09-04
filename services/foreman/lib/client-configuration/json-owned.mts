import type { JsonValue } from './types.mts'

export interface OwnedJsonField {
  present: boolean
  value?: JsonValue
}

export type OwnedJsonState = Record<string, OwnedJsonField>

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function parseJsonObject(content: string, path: string): Record<string, unknown> {
  if (!content.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`invalid JSON configuration ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = object(value)
  if (!parsed) throw new Error(`JSON configuration must contain an object: ${path}`)
  return parsed
}

function key(path: readonly string[]): string {
  return path.join('.')
}

function readPath(root: Record<string, unknown>, path: readonly string[]): OwnedJsonField {
  let cursor: unknown = root
  for (let index = 0; index < path.length; index += 1) {
    const record = object(cursor)
    if (!record || !Object.prototype.hasOwnProperty.call(record, path[index])) return { present: false }
    cursor = record[path[index]]
  }
  return { present: true, value: structuredClone(cursor) as JsonValue }
}

function writePath(root: Record<string, unknown>, path: readonly string[], field: OwnedJsonField): void {
  let cursor = root
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index]
    const next = object(cursor[part])
    if (next) cursor = next
    else {
      const created: Record<string, unknown> = {}
      cursor[part] = created
      cursor = created
    }
  }
  const leaf = path.at(-1)
  if (!leaf) throw new Error('owned JSON path must not be empty')
  if (field.present) cursor[leaf] = structuredClone(field.value)
  else delete cursor[leaf]
}

export function snapshotOwnedJson(
  content: string,
  filePath: string,
  paths: readonly (readonly string[])[],
): OwnedJsonState {
  const root = parseJsonObject(content, filePath)
  return Object.fromEntries(paths.map((path) => [key(path), readPath(root, path)]))
}

export function patchOwnedJson(
  content: string,
  filePath: string,
  values: ReadonlyMap<readonly string[], OwnedJsonField>,
): string {
  const root = parseJsonObject(content, filePath)
  for (const [path, value] of values) writePath(root, path, value)
  return `${JSON.stringify(root, null, 2)}\n`
}

export function jsonField(value: JsonValue): OwnedJsonField {
  return { present: true, value }
}
