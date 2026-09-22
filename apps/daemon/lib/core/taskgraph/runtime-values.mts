import { Ajv } from 'ajv'
import type { ErrorObject } from 'ajv'

import type {
  JsonObject,
  JsonValue,
  NodeId,
  ObjectJsonSchema,
  TaskGraph,
  TaskGraphNode,
} from './model.mts'
import type { TaskGraphNodeStateProjection } from './store.mts'
import { parseSourceExpr, type ProjectionSegment } from './schema-tools.mts'

export interface ValueResolutionFailure {
  code: string
  message: string
  details?: JsonObject
}

export type ValueResolution<T> =
  | { ok: true; value: T }
  | { ok: false; error: ValueResolutionFailure }

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false })

export function resolveNodeInputs(
  graph: TaskGraph,
  node: TaskGraphNode,
  nodeStates: Readonly<Record<NodeId, TaskGraphNodeStateProjection>>,
): ValueResolution<JsonObject> {
  const input: JsonObject = Object.create(null) as JsonObject
  const nodeIds = new Set(Object.keys(graph.nodes))
  for (const slot of node.input) {
    const parsed = parseSourceExpr(slot.source, nodeIds)
    if (!parsed) {
      return {
        ok: false,
        error: {
          code: 'INPUT_RESOLVE_FAILED',
          message: `cannot parse source "${slot.source}" for slot "${slot.name}"`,
        },
      }
    }
    const sourceState = Object.hasOwn(nodeStates, parsed.nodeId)
      ? nodeStates[parsed.nodeId]
      : undefined
    if (!sourceState?.output) {
      if (slot.optional) continue
      return {
        ok: false,
        error: {
          code: 'INPUT_RESOLVE_FAILED',
          message: `source node "${parsed.nodeId}" has no output for slot "${slot.name}"`,
        },
      }
    }
    const projected = projectValue(sourceState.output, parsed.projection)
    if (!projected.found) {
      if (slot.optional) continue
      return {
        ok: false,
        error: {
          code: 'INPUT_RESOLVE_FAILED',
          message: `source "${slot.source}" is absent for slot "${slot.name}"`,
        },
      }
    }
    defineOwn(input, slot.name, cloneJson(projected.value as JsonValue))
  }
  return { ok: true, value: input }
}

export function resolveActionTemplate(
  value: JsonValue,
  inputs: JsonObject,
): ValueResolution<JsonValue> {
  if (typeof value === 'string') {
    const ref = parseInputsValueRef(value)
    if (!ref) return { ok: true, value }
    if (!Object.hasOwn(inputs, ref.slot)) {
      return {
        ok: false,
        error: {
          code: 'INPUT_RESOLVE_FAILED',
          message: `input slot "${ref.slot}" is absent`,
        },
      }
    }
    const projected = projectValue(inputs[ref.slot], ref.projection)
    if (!projected.found) {
      return {
        ok: false,
        error: {
          code: 'INPUT_RESOLVE_FAILED',
          message: `input reference "${value}" is absent`,
        },
      }
    }
    return { ok: true, value: cloneJson(projected.value as JsonValue) }
  }

  if (Array.isArray(value)) {
    const output: JsonValue[] = []
    for (const entry of value) {
      const resolved = resolveActionTemplate(entry, inputs)
      if (!resolved.ok) return resolved
      output.push(resolved.value)
    }
    return { ok: true, value: output }
  }

  if (value !== null && typeof value === 'object') {
    const record = value as JsonObject
    if (Object.keys(record).length === 1 && Object.hasOwn(record, 'const')) {
      return { ok: true, value: cloneJson(record.const) }
    }
    const output: JsonObject = Object.create(null) as JsonObject
    for (const [key, entry] of Object.entries(record)) {
      const resolved = resolveActionTemplate(entry, inputs)
      if (!resolved.ok) return resolved
      defineOwn(output, key, resolved.value)
    }
    return { ok: true, value: output }
  }
  return { ok: true, value }
}

export function assembleNodeOutput(
  assemble: JsonValue | undefined,
  inputs: JsonObject,
): ValueResolution<JsonObject> {
  if (!isJsonObject(assemble)) {
    return {
      ok: false,
      error: {
        code: 'OUTPUT_ASSEMBLE_FAILED',
        message: 'action.params.assemble must be an object',
      },
    }
  }
  const output: JsonObject = Object.create(null) as JsonObject
  for (const [targetPath, expression] of Object.entries(assemble)) {
    const resolved = resolveActionTemplate(expression, inputs)
    if (!resolved.ok) return resolved
    if (!setTargetPath(output, targetPath, resolved.value)) {
      return {
        ok: false,
        error: {
          code: 'OUTPUT_ASSEMBLE_FAILED',
          message: `invalid assemble target path "${targetPath}"`,
        },
      }
    }
  }
  return { ok: true, value: output }
}

export function validateJsonObject(
  schema: ObjectJsonSchema,
  value: JsonObject,
  code: string,
): ValueResolution<JsonObject> {
  let validate
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    return {
      ok: false,
      error: {
        code,
        message: `schema compilation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
  if (validate(value)) return { ok: true, value }
  return {
    ok: false,
    error: {
      code,
      message: (validate.errors ?? [])
        .map((entry: ErrorObject) => `${entry.instancePath || '/'} ${entry.message ?? 'failed validation'}`)
        .join('; '),
    },
  }
}

function parseInputsValueRef(
  value: string,
): { slot: string; projection: ProjectionSegment[] } | null {
  const match = /^\$?inputs\.([A-Za-z_][A-Za-z0-9_]*)(.*)$/u.exec(value)
  if (!match) return null
  const projection: ProjectionSegment[] = []
  let suffix = match[2]
  while (suffix.length > 0) {
    const field = /^\.([A-Za-z_][A-Za-z0-9_]*)/u.exec(suffix)
    if (field) {
      projection.push({ kind: 'field', value: field[1] })
      suffix = suffix.slice(field[0].length)
      continue
    }
    const index = /^\[(0|[1-9][0-9]*)\]/u.exec(suffix)
    if (index) {
      projection.push({ kind: 'index', value: Number(index[1]) })
      suffix = suffix.slice(index[0].length)
      continue
    }
    return null
  }
  return { slot: match[1], projection }
}

function projectValue(
  root: JsonValue,
  projection: readonly ProjectionSegment[],
): { found: boolean; value?: JsonValue } {
  let value = root
  for (const segment of projection) {
    if (segment.kind === 'field') {
      if (!isJsonObject(value) || !Object.hasOwn(value, segment.value)) return { found: false }
      value = value[segment.value]
    } else {
      if (!Array.isArray(value) || segment.value >= value.length) return { found: false }
      value = value[segment.value]
    }
  }
  return { found: true, value }
}

function setTargetPath(output: JsonObject, path: string, value: JsonValue): boolean {
  const segments = path.split('.')
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return false
  let cursor = output
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    const existing = Object.hasOwn(cursor, segment) ? cursor[segment] : undefined
    if (existing !== undefined && !isJsonObject(existing)) return false
    if (existing === undefined) {
      const nested: JsonObject = Object.create(null) as JsonObject
      defineOwn(cursor, segment, nested)
      cursor = nested
    } else {
      cursor = existing
    }
  }
  defineOwn(cursor, segments.at(-1) as string, cloneJson(value))
  return true
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function defineOwn(record: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
