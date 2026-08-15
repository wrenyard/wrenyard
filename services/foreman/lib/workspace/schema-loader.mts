import AjvClass from 'ajv'
import type { ErrorObject, ValidateFunction } from 'ajv'
import { z, type ZodType } from 'zod'
import type { JsonSchema } from '../types.mts'

const ajv = new (AjvClass as any)({
  allErrors: true,
  strict: false,
})

export class V2SchemaValidationError extends Error {
  readonly details: string[]

  constructor(message: string, details: string[] = []) {
    super(message)
    this.name = 'V2SchemaValidationError'
    this.details = details
  }
}

export interface CompiledSchema {
  schema: JsonSchema
  validate: ValidateFunction
}

/**
 * Detect whether a value is a Zod 4 schema (duck-typed via `_zod` brand).
 */
export function isZodSchema(value: unknown): value is ZodType {
  return typeof value === 'object'
    && value !== null
    && (('_zod' in value) || ('_def' in value))
    && typeof (value as { parse?: unknown }).parse === 'function'
}

/**
 * Convert a Zod schema to a draft-07 JSON Schema.
 *
 * AC-5 single conversion path (Zod 4 native `z.toJSONSchema`). Task/flow
 * definition schemas are funneled through this into AJV validation.
 */
export function zodToJsonSchema(schema: ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-07' }) as JsonSchema
}

/**
 * Convert a task/flow definition Zod schema to a draft-07 JSON Schema for
 * serialization (e.g. `input_schema`/`output_schema` in registry metadata).
 *
 * AC-5: definition schemas accept ZodType only. The legacy
 * `Record<string, SchemaField>` and raw JSON Schema definition paths were
 * retired; a non-Zod definition schema is rejected with a clear error.
 */
export function normalizeSchema(value: ZodType | undefined): JsonSchema | undefined {
  if (value === undefined) return undefined
  if (!isZodSchema(value)) {
    throw new Error(
      'Task/flow definition schemas must be a ZodType; legacy Record<SchemaField> '
      + 'and raw JSON Schema definition forms are no longer supported (AC-5).',
    )
  }
  return zodToJsonSchema(value)
}

/**
 * Compile a schema for AJV validation.
 *
 * Task/flow definition schemas are ZodType (converted to draft-07 JSON
 * Schema first). Protocol JSON Schemas unrelated to task definitions (e.g.
 * checkpoint `expectedSchema`) are passed through unchanged (AC-5).
 */
export function compileSchema(schema: ZodType | JsonSchema): CompiledSchema {
  const normalized = isZodSchema(schema) ? zodToJsonSchema(schema) : schema
  return {
    schema: normalized,
    validate: ajv.compile(normalized as any),
  }
}

export function validateAgainstSchema(schema: CompiledSchema, value: unknown, subject: string): void {
  if (schema.validate(value)) return
  const details = formatAjvErrors(schema.validate.errors)
  throw new V2SchemaValidationError(`${subject} validation failed: ${details.join('; ')}`, details)
}

export function parseStrictJson(raw: string): unknown {
  const text = raw.trim()
  if (!text) throw new V2SchemaValidationError('Output is empty', ['Output is empty'])

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const message = `Output is not strict JSON: ${(error as Error).message}`
    throw new V2SchemaValidationError(message, [message])
  }
}

export function parseAndValidateJson(schema: CompiledSchema, raw: string, subject: string): unknown {
  const parsed = parseStrictJson(raw)
  validateAgainstSchema(schema, parsed, subject)
  return parsed
}

/**
 * Produce a placeholder example object for the required fields of a
 * task/flow definition schema (AC-5: ZodType or an already-converted JSON
 * Schema produced by `normalizeSchema`).
 */
export function generateInputExample(schema: ZodType | JsonSchema | undefined): Record<string, unknown> | undefined {
  const normalized: JsonSchema | undefined = isZodSchema(schema as unknown)
    ? zodToJsonSchema(schema as ZodType)
    : (schema as JsonSchema | undefined)
  if (!normalized || typeof normalized === 'boolean') return undefined

  const props = normalized.properties as Record<string, Record<string, unknown>> | undefined
  const required = (normalized.required as string[] | undefined) ?? []
  if (!props) return {}

  const example: Record<string, unknown> = {}
  for (const key of required) {
    const field = props[key]
    if (!field || typeof field !== 'object') {
      example[key] = 'string'
      continue
    }
    example[key] = placeholderForType(field)
  }
  return example
}

function placeholderForType(field: Record<string, unknown>): unknown {
  const type = field.type
  if (type === 'string') return 'string'
  if (type === 'number' || type === 'integer') return 0
  if (type === 'boolean') return true
  if (type === 'array') return []
  if (type === 'object') return {}
  return 'string'
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['validation failed']
  return errors.map((error) => {
    const sp = error.schemaPath || '#'
    return `${error.instancePath || '/'} ${error.message ?? 'failed validation'} (schema: ${sp})`
  })
}

/**
 * General JSON-value validation primitive — compiles any valid JSON Schema root
 * (including array root, boolean schemas) and validates a value.
 *
 * Returns deterministic errors with instance/schema paths on failure.
 * Unlike compileSchema which requires ZodType | JsonSchema, this accepts
 * any raw JSON Schema object (e.g. an array-root schema from definition metadata).
 */
export function validateAnyJsonValue(schema: JsonSchema, value: unknown): {
  valid: boolean
  errors: string[]
} {
  const validate = ajv.compile(schema as any)
  if (validate(value)) return { valid: true, errors: [] }
  return { valid: false, errors: formatAjvErrors(validate.errors) }
}
