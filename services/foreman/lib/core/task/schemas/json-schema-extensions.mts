import { z, type ZodType } from 'zod'

/**
 * # B4 JSON Schema Extension Helpers
 *
 * Zod 4's `z.toJSONSchema(schema, { target: 'draft-07' })` faithfully
 * converts the zod-native constraints (type, pattern, minLength, minItems,
 * minimum, enum, const, required, additionalProperties:false, tuples, etc.).
 *
 * However, several draft-07 constructs have **no zod-native equivalent**
 * (B4 blocker):
 *   - `if` / `then` / `else`               — conditional subschemas
 *   - `allOf`                              — schema intersection
 *   - `not` / `contains`                   — negative / existential array
 *                                            membership constraints
 *   - `uniqueItems`                        — array element uniqueness
 *   - `minProperties`                      — minimum object key count
 *
 * `withExtensions` converts the zod schema to draft-07 and then deep-merges
 * an extension fragment (carrying the missing constructs) into the result.
 * The merge is structural: existing `properties` subschemas are recursively
 * merged so that per-property additions (e.g. `uniqueItems`, nested
 * `minItems`) land on the correct node; top-level constructs (`if`, `then`,
 * `allOf`, `minProperties`) are set verbatim since zod never emits them.
 *
 * Usage:
 *   const jsonSchema = withExtensions(FeaturePointSetSchema, {
 *     if:   { properties: { status: { const: 'confirmed' } }, required: ['status'] },
 *     then: { properties: { design_decision: { properties: {
 *       status: { enum: ['selected', 'combined', 'adjusted'] },
 *       selected_option_refs: { minItems: 1 },
 *     } } } },
 *   })
 *
 * The returned JSON Schema is then compiled by AJV exactly like any other
 * `JsonSchema` input (D25 修正: single `z.toJSONSchema → AJV` path).
 */

type JsonSchemaObject = Record<string, unknown>

function isPlainObject(v: unknown): v is JsonSchemaObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Recursively merge `ext` into `base`. For each key:
 *   - if both values are plain objects, merge recursively (this lets
 *     `properties.foo.properties.bar.uniqueItems` land on the existing
 *     `bar` subschema instead of replacing it);
 *   - otherwise the extension value wins (`if`/`then`/`allOf`/`minProperties`
 *     etc. are set verbatim; arrays like `allOf`/`required` are replaced).
 */
function deepMergeSchema(base: JsonSchemaObject, ext: JsonSchemaObject): JsonSchemaObject {
  const out: JsonSchemaObject = { ...base }
  for (const [key, value] of Object.entries(ext)) {
    const existing = out[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMergeSchema(existing, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Convert `zodSchema` to a draft-07 JSON Schema and deep-merge `extensions`
 * into the result. Use this for any schema that needs B4 constructs zod
 * cannot express natively.
 */
export function withExtensions(
  zodSchema: ZodType,
  extensions: JsonSchemaObject,
): JsonSchemaObject {
  const base = z.toJSONSchema(zodSchema, { target: 'draft-07' }) as JsonSchemaObject
  return deepMergeSchema(base, extensions)
}

/** Convert a zod schema to draft-07 JSON Schema with no extensions. */
export function zodToJsonSchema(zodSchema: ZodType): JsonSchemaObject {
  return z.toJSONSchema(zodSchema, { target: 'draft-07' }) as JsonSchemaObject
}
