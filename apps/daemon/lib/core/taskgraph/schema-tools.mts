// ─── Internal pure JSON Schema toolbox for the TaskGraph ─────────────────────
// Side-effect-free helpers.  No runtime-value compilation or validation.
//
// SSOT:
//   SourceExpr starts with nodeId and is followed only by ".field" / "[index]";
//   static validation proves paths from schemas, while optional runtime value
//   absence remains outside this module.

import type { SourceExpr, NodeId, JsonObject, JsonValue } from './model.mts';

import { Ajv } from 'ajv';

// ─── SourceExpr parsing ───────────────────────────────────────────────────────

export type ProjectionSegment =
  | { kind: 'field'; value: string }
  | { kind: 'index'; value: number };

export interface ParsedSourceExpr {
  nodeId: NodeId;
  projection: ProjectionSegment[];
}

/**
 * Parse a SourceExpr into its base node id and ordered projection segments.
 *
 * A valid SourceExpr starts with a node id from the admitted node-id set and is
 * followed by zero or more `.field` or `[index]` segments.  When multiple node
 * ids match as a prefix, the *longest* match is used (deterministic disambiguation).
 *
 * Returns `null` when the expression cannot be parsed deterministically.
 */
export function parseSourceExpr(expr: SourceExpr, nodeIds: Set<NodeId>): ParsedSourceExpr | null {
  // Phase 1: exact match — parse the original expression as-is, supporting
  // whitespace-bearing NodeIds.  The longest admitted node-id whose prefix
  // of the raw expression leaves a valid projection remainder wins.
  let bestNodeId: NodeId | null = null;
  let bestLen = 0;

  for (const nid of nodeIds) {
    if (!nid || nid.length <= bestLen) continue;
    if (expr.startsWith(nid)) {
      const suffix = expr.slice(nid.length);
      if (suffix === '' || suffix.startsWith('.') || suffix.startsWith('[')) {
        bestNodeId = nid;
        bestLen = nid.length;
      }
    }
  }

  // Phase 2: fallback — try the trimmed expression for surrounding-whitespace
  // ergonomics only when no exact candidate was found.
  if (!bestNodeId) {
    const trimmed = expr.trim();
    if (trimmed && trimmed !== expr) {
      for (const nid of nodeIds) {
        if (!nid || nid.length <= bestLen) continue;
        if (trimmed.startsWith(nid)) {
          const suffix = trimmed.slice(nid.length);
          if (suffix === '' || suffix.startsWith('.') || suffix.startsWith('[')) {
            bestNodeId = nid;
            bestLen = nid.length;
          }
        }
      }
    }
    if (!bestNodeId) return null;
  }

  // Determine the effective expression for suffix extraction.
  const effectiveExpr = expr.startsWith(bestNodeId) ? expr : expr.trim();
  const suffix = effectiveExpr.slice(bestLen);
  const projection: ProjectionSegment[] = [];
  if (suffix) {
    // Consume .field and [index] projection tokens left-to-right.
    const fieldRe = /^\.([a-zA-Z_]\w*)/;
    const indexRe = /^\[(\d+)\]/;
    let pos = 0;
    while (pos < suffix.length) {
      const rest = suffix.slice(pos);
      const fieldMatch = fieldRe.exec(rest);
      if (fieldMatch) {
        projection.push({ kind: 'field', value: fieldMatch[1] });
        pos += fieldMatch[0].length;
        continue;
      }
      const indexMatch = indexRe.exec(rest);
      if (indexMatch) {
        projection.push({ kind: 'index', value: parseInt(indexMatch[1], 10) });
        pos += indexMatch[0].length;
        continue;
      }
      // Invalid token in suffix — expression cannot be parsed.
      return null;
    }
  }

  return { nodeId: bestNodeId, projection };
}

// ─── Schema projection (schemaAt) ─────────────────────────────────────────────

export type SchemaAtResult =
  | { found: true; schema: JsonObject }
  | { found: false; reason: string };

/**
 * Walk a JSON Schema along a projection path, returning the subschema at the
 * final segment or a failure reason.
 *
 * - Object fields project through `properties`.
 * - Array indexes project through `items` (must be a single schema, not a tuple).
 * - Unprovable or unsupported segments are reported via `found: false`.
 */
export function schemaAt(
  schema: JsonObject,
  projection: ProjectionSegment[],
): SchemaAtResult {
  // Total guard: reject non-object, null, or array root schema.
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { found: false, reason: 'root schema must be a non-null JSON object' };
  }
  // Root must be an object schema with properties for field traversal.
  if (projection.length > 0 && projection[0].kind === 'field' && schema.type !== 'object') {
    return { found: false, reason: `root schema must have type "object" for field traversal, got "${String(schema.type)}"` };
  }
  if (projection.length > 0 && projection[0].kind === 'index' && schema.type !== 'array') {
    return { found: false, reason: `root schema must have type "array" for index traversal, got "${String(schema.type)}"` };
  }
  let current: JsonObject = schema;

  for (const seg of projection) {
    // Total guard: reject malformed current schema before property/index access.
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return { found: false, reason: `malformed schema at segment "${seg.value}": must be a non-null JSON object` };
    }
    // Validate each traversed schema has a valid type.
    if (typeof current.type !== 'string' || !current.type) {
      return { found: false, reason: `schema at segment "${seg.value}" has no valid type` };
    }
      if (seg.kind === 'field') {
        // Require object schema for field traversal.
        if (current.type !== 'object') {
          return { found: false, reason: `schema at segment "${seg.value}" must have type "object" for field traversal, got "${String(current.type)}"` };
        }
        const props = current.properties;
        if (!props || typeof props !== 'object' || Array.isArray(props)) {
          return { found: false, reason: `no properties at segment "${seg.value}"` };
        }
        const propRecord = props as Record<string, JsonValue>;
        if (!Object.hasOwn(propRecord, seg.value)) {
          return { found: false, reason: `property "${seg.value}" not found` };
        }
        const subschema = propRecord[seg.value];
        if (subschema === null || typeof subschema !== 'object' || Array.isArray(subschema)) {
          return { found: false, reason: `property "${seg.value}" is not a valid schema` };
        }
        current = subschema as JsonObject;
    } else {
      // index kind
      if (current.type !== 'array') {
        return { found: false, reason: `cannot index into non-array at [${seg.value}]` };
      }
      const items = current.items;
      if (!items || typeof items !== 'object' || Array.isArray(items) || items === null) {
        return { found: false, reason: `array items schema missing or not a single schema at [${seg.value}]` };
      }
      current = items as JsonObject;
    }
  }

  // Validate final projected schema before returning found:true.
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    return { found: false, reason: 'final projected schema must be a non-null JSON object' };
  }
  // Final schema must have a valid type.
  if (typeof current.type !== 'string' || !current.type) {
    return { found: false, reason: 'final projected schema has no valid type' };
  }

  return { found: true, schema: current };
}

// ─── Recursive graph-schema validation ────────────────────────────────────────

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

/**
 * Recursively validate that a JSON Schema is structurally valid using AJV,
 * plus enforce frozen forbidden shapes:
 *
 * - Every subschema in a TaskGraph node input/output schema must be a top-level
 *   object (no boolean schemas).
 * - No empty schema ({}), missing `type`, `any` (no type constraint), or
 *   `unknown`-like shapes are accepted.
 *
 * Returns an array of issues; an empty array means the schema is valid.
 */
export function validateGraphSchema(
  schema: JsonObject,
  path: string = '#',
  visited: Set<JsonObject> = new Set(),
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];

  // Avoid infinite recursion on circular references — report as schema-invalid.
  if (visited.has(schema)) {
    issues.push({ path, message: 'cyclic schema reference detected' });
    return issues;
  }
  visited.add(schema);

  // 1. Must be an object (not boolean).
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    issues.push({ path, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    return issues;
  }

  // 2. Must have a `type`.
  if (!schema.type || typeof schema.type !== 'string') {
    issues.push({ path, message: 'schema is missing a type property' });
    // Fall through to scan child subschema-bearing keywords even when parent is malformed.
  }

  // 3. Forbidden shapes: any/unknown — no type constraint or wide-open type.
  if (schema.type === 'any' || schema.type === 'unknown') {
    issues.push({ path, message: `forbidden schema type "${String(schema.type)}"` });
    // Fall through to scan child subschema-bearing keywords even when parent is malformed.
  }

  // 4. Run AJV validation to catch structural JSON Schema errors.
  try {
    const ajv = new Ajv({
      strict: true,
      // Draft-07 tuple-form `items` arrays are legal without a redundant
      // minItems/maxItems/additionalItems declaration.  Narrow the strictTuples
      // check so valid catalog contracts materialize, while every other strict
      // mode check (unknown keywords, malformed shapes, etc.) stays active.
      strictTuples: false,
      validateFormats: false,
      keywords: [
        'prefixItems',
        'dependentSchemas',
        'unevaluatedProperties',
        'unevaluatedItems',
      ],
    });
    // Compile a tiny wrapper to check just this sub-schema.
    // If the schema itself is structurally invalid (bad keyword types,
    // unknown keywords in strict mode, etc.), compile throws.
    ajv.compile(schema);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push({ path, message: `schema validation error: ${msg}` });
    // Even if AJV rejects it, continue recursion to collect all errors.
  }

  // 5. Recurse into properties — independent of parent type.
  if (Object.hasOwn(schema, 'properties')) {
    const rawProps = schema.properties;
    if (typeof rawProps !== 'object' || rawProps === null || Array.isArray(rawProps)) {
      issues.push({ path: `${path}.properties`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    } else {
      for (const key of Object.keys(rawProps as Record<string, unknown>)) {
        if (!Object.hasOwn(rawProps as Record<string, unknown>, key)) continue;
        const propSchema = (rawProps as Record<string, unknown>)[key];
        if (propSchema === undefined) {
          issues.push({ path: `${path}.properties.${key}`, message: 'present-undefined property schema is invalid' });
        } else if (propSchema !== null && typeof propSchema === 'object' && !Array.isArray(propSchema)) {
          issues.push(
            ...validateGraphSchema(propSchema as JsonObject, `${path}.properties.${key}`, visited),
          );
        } else {
          // null, boolean, array, or other non-object child schema — reject
          issues.push({ path: `${path}.properties.${key}`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
        }
      }
    }
  }

  // 6. Recurse into array items — independent of parent type.
  //    Supports single schema, tuple array (indexed paths), and boolean rejection.
  if (Object.hasOwn(schema, 'items')) {
    if (typeof schema.items === 'object' && !Array.isArray(schema.items) && schema.items !== null) {
      // Single schema
      issues.push(
        ...validateGraphSchema(schema.items as JsonObject, `${path}.items`, visited),
      );
    } else if (Array.isArray(schema.items)) {
      // Tuple array — each element at its indexed path, own-property-aware
      const itemsArr = schema.items as unknown[];
      for (let i = 0; i < itemsArr.length; i++) {
        if (!Object.hasOwn(itemsArr, i)) continue; // skip holes
        const sub = itemsArr[i];
        if (sub !== undefined && sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
          issues.push(...validateGraphSchema(sub as JsonObject, `${path}.items[${i}]`, visited));
        } else if (sub === undefined) {
          issues.push({ path: `${path}.items[${i}]`, message: 'present-undefined item schema is invalid' });
        } else {
          issues.push({ path: `${path}.items[${i}]`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
        }
      }
    } else {
      issues.push({ path: `${path}.items`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 7. Recurse into oneOf / anyOf / allOf / not — emit issue for boolean subschemas.
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (!Object.hasOwn(schema, combinator)) continue;
    const arr = schema[combinator];
    if (!Array.isArray(arr)) {
      issues.push({ path: `${path}.${combinator}`, message: `${combinator} must be an array` });
    } else {
      for (let i = 0; i < arr.length; i++) {
        if (!Object.hasOwn(arr, i)) continue; // skip holes
        const sub = arr[i];
        if (sub !== undefined && sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
          issues.push(...validateGraphSchema(sub as JsonObject, `${path}.${combinator}[${i}]`, visited));
        } else if (sub === undefined) {
          issues.push({ path: `${path}.${combinator}[${i}]`, message: 'present-undefined combinator schema is invalid' });
        } else {
          issues.push({ path: `${path}.${combinator}[${i}]`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
        }
      }
    }
  }
  if (Object.hasOwn(schema, 'not')) {
    const notVal = schema.not;
    if (typeof notVal === 'object' && notVal !== null && !Array.isArray(notVal)) {
      issues.push(...validateGraphSchema(notVal as JsonObject, `${path}.not`, visited));
    } else {
      issues.push({ path: `${path}.not`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 8. additionalProperties — allow false as canonical closed-object control,
  //    reject true as a forbidden wide-open/any contract, recurse into object
  //    subschemas, and reject any other malformed value.
  if (Object.hasOwn(schema, 'additionalProperties')) {
    const ap = schema.additionalProperties;
    if (ap === false) {
      // Canonical closed-object control — valid, no issue.
    } else if (ap === true) {
      issues.push({ path: `${path}.additionalProperties`, message: 'forbidden wide-open schema: additionalProperties:true allows any extra properties' });
    } else if (typeof ap === 'object' && ap !== null && !Array.isArray(ap)) {
      issues.push(...validateGraphSchema(ap as JsonObject, `${path}.additionalProperties`, visited));
    } else {
      issues.push({ path: `${path}.additionalProperties`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 9. patternProperties (object of schemas keyed by regex pattern).
  if (Object.hasOwn(schema, 'patternProperties')) {
    const rawPP = schema.patternProperties;
    if (typeof rawPP !== 'object' || rawPP === null || Array.isArray(rawPP)) {
      issues.push({ path: `${path}.patternProperties`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    } else {
      for (const key of Object.keys(rawPP as Record<string, unknown>)) {
        if (!Object.hasOwn(rawPP as Record<string, unknown>, key)) continue;
        const sub = (rawPP as Record<string, unknown>)[key];
        if (sub === undefined) {
          issues.push({ path: `${path}.patternProperties["${key}"]`, message: 'present-undefined pattern property schema is invalid' });
        } else if (sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
          issues.push(...validateGraphSchema(sub as JsonObject, `${path}.patternProperties["${key}"]`, visited));
        } else {
          issues.push({ path: `${path}.patternProperties["${key}"]`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
        }
      }
    }
  }

  // 10. propertyNames (single schema validating each property name).
  if (Object.hasOwn(schema, 'propertyNames')) {
    const pn = schema.propertyNames;
    if (typeof pn === 'object' && pn !== null && !Array.isArray(pn)) {
      issues.push(...validateGraphSchema(pn as JsonObject, `${path}.propertyNames`, visited));
    } else {
      issues.push({ path: `${path}.propertyNames`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 11. contains (single schema validating at least one array element).
  if (Object.hasOwn(schema, 'contains')) {
    const cs = schema.contains;
    if (typeof cs === 'object' && cs !== null && !Array.isArray(cs)) {
      issues.push(...validateGraphSchema(cs as JsonObject, `${path}.contains`, visited));
    } else {
      issues.push({ path: `${path}.contains`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 12. if / then / else conditional keywords.
  for (const cond of ['if', 'then', 'else'] as const) {
    if (!Object.hasOwn(schema, cond)) continue;
    const cv = schema[cond];
    if (typeof cv === 'object' && cv !== null && !Array.isArray(cv)) {
      issues.push(...validateGraphSchema(cv as JsonObject, `${path}.${cond}`, visited));
    } else {
      issues.push({ path: `${path}.${cond}`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 13. dependentSchemas (object of schemas keyed by property name).
  if (Object.hasOwn(schema, 'dependentSchemas')) {
    const rawDS = schema.dependentSchemas;
    if (typeof rawDS !== 'object' || rawDS === null || Array.isArray(rawDS)) {
      issues.push({ path: `${path}.dependentSchemas`, message: 'dependentSchemas must be a non-null non-array object' });
    } else {
      for (const key of Object.keys(rawDS as Record<string, unknown>)) {
        if (!Object.hasOwn(rawDS as Record<string, unknown>, key)) continue;
        const sub = (rawDS as Record<string, unknown>)[key];
        if (sub === undefined) {
          issues.push({ path: `${path}.dependentSchemas["${key}"]`, message: 'present-undefined dependent schema is invalid' });
        } else if (sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
          issues.push(...validateGraphSchema(sub as JsonObject, `${path}.dependentSchemas["${key}"]`, visited));
        } else {
          issues.push({ path: `${path}.dependentSchemas["${key}"]`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
        }
      }
    }
  }

  // 14. $defs and definitions (schema containers keyed by name).
  for (const defKey of ['$defs', 'definitions'] as const) {
    if (!Object.hasOwn(schema, defKey)) continue;
    const defs = schema[defKey];
    if (typeof defs !== 'object' || defs === null || Array.isArray(defs)) {
      issues.push({ path: `${path}.${defKey}`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    } else {
      for (const key of Object.keys(defs as Record<string, unknown>)) {
        if (!Object.hasOwn(defs as Record<string, unknown>, key)) continue;
        const sub = (defs as Record<string, unknown>)[key];
        if (sub === undefined) {
          issues.push({ path: `${path}.${defKey}["${key}"]`, message: 'present-undefined definition schema is invalid' });
        } else if (sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
          issues.push(...validateGraphSchema(sub as JsonObject, `${path}.${defKey}["${key}"]`, visited));
        } else {
          issues.push({ path: `${path}.${defKey}["${key}"]`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
        }
      }
    }
  }

  // 15. prefixItems (tuple-style ordered array of schemas).
  if (Object.hasOwn(schema, 'prefixItems')) {
    if (!Array.isArray(schema.prefixItems)) {
      issues.push({ path: `${path}.prefixItems`, message: 'prefixItems must be an array' });
    } else {
      const piArr = schema.prefixItems as unknown[];
      for (let i = 0; i < piArr.length; i++) {
        if (!Object.hasOwn(piArr, i)) continue; // skip holes
        const sub = piArr[i];
        if (sub !== undefined && sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
          issues.push(...validateGraphSchema(sub as JsonObject, `${path}.prefixItems[${i}]`, visited));
        } else if (sub === undefined) {
          issues.push({ path: `${path}.prefixItems[${i}]`, message: 'present-undefined prefixItems schema is invalid' });
        } else {
          issues.push({ path: `${path}.prefixItems[${i}]`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
        }
      }
    }
  }

  // 16. additionalItems — schema validating extra items beyond a tuple definition.
  if (Object.hasOwn(schema, 'additionalItems')) {
    const ai = schema.additionalItems;
    if (typeof ai === 'boolean') {
      issues.push({ path: `${path}.additionalItems`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    } else if (typeof ai === 'object' && ai !== null && !Array.isArray(ai)) {
      issues.push(...validateGraphSchema(ai as JsonObject, `${path}.additionalItems`, visited));
    } else {
      issues.push({ path: `${path}.additionalItems`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 17. unevaluatedProperties — schema validating any property not evaluated by
  //     properties/patternProperties/additionalProperties.
  if (Object.hasOwn(schema, 'unevaluatedProperties')) {
    const ue = schema.unevaluatedProperties;
    if (typeof ue === 'boolean') {
      issues.push({ path: `${path}.unevaluatedProperties`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    } else if (typeof ue === 'object' && ue !== null && !Array.isArray(ue)) {
      issues.push(...validateGraphSchema(ue as JsonObject, `${path}.unevaluatedProperties`, visited));
    } else {
      issues.push({ path: `${path}.unevaluatedProperties`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 18. unevaluatedItems — schema validating any item position not evaluated by
  //     items/prefixItems/additionalItems.
  if (Object.hasOwn(schema, 'unevaluatedItems')) {
    const ui = schema.unevaluatedItems;
    if (typeof ui === 'boolean') {
      issues.push({ path: `${path}.unevaluatedItems`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    } else if (typeof ui === 'object' && ui !== null && !Array.isArray(ui)) {
      issues.push(...validateGraphSchema(ui as JsonObject, `${path}.unevaluatedItems`, visited));
    } else {
      issues.push({ path: `${path}.unevaluatedItems`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 19. contentSchema — schema for the decoded content of a string with contentMediaType.
  if (Object.hasOwn(schema, 'contentSchema')) {
    const cs = schema.contentSchema;
    if (typeof cs === 'object' && cs !== null && !Array.isArray(cs)) {
      issues.push(...validateGraphSchema(cs as JsonObject, `${path}.contentSchema`, visited));
    } else {
      issues.push({ path: `${path}.contentSchema`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    }
  }

  // 20. Legacy dependencies (draft-4 to draft-7) — property-name-keyed schema
  //     or string-array conditional requirements.
  if (Object.hasOwn(schema, 'dependencies')) {
    const rawDep = schema.dependencies;
    if (typeof rawDep !== 'object' || rawDep === null || Array.isArray(rawDep)) {
      issues.push({ path: `${path}.dependencies`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
    } else {
      for (const key of Object.keys(rawDep as Record<string, unknown>)) {
        if (!Object.hasOwn(rawDep as Record<string, unknown>, key)) continue;
        const dep = (rawDep as Record<string, unknown>)[key];
        if (dep === undefined) {
          issues.push({ path: `${path}.dependencies["${key}"]`, message: 'present-undefined dependency is invalid' });
        } else if (typeof dep === 'object' && dep !== null && !Array.isArray(dep)) {
          // Schema dependency — recurse
          issues.push(...validateGraphSchema(dep as JsonObject, `${path}.dependencies["${key}"]`, visited));
        } else if (Array.isArray(dep)) {
          // String-array dependencies are property requirements, not subschemas —
          // no recursive validation needed.
        } else if (dep !== undefined) {
          issues.push({ path: `${path}.dependencies["${key}"]`, message: 'schema must be a JSON object; boolean schemas are forbidden' });
        }
      }
    }
  }

  return issues;
}

// ─── Recursive structural type comparison ─────────────────────────────────────

export interface TypeComparisonResult {
  match: boolean;
  details?: string;
}

/**
 * Recursively compare two JSON Schemas for structural type equivalence.
 *
 * Object properties are compared field-by-field; array items are compared
 * structurally. Required versus optional fields are preserved from `expected`.
 */
export function compareTypes(
  actual: JsonObject,
  expected: JsonObject,
): TypeComparisonResult {
  // Total guard: reject non-object, null, or array inputs at any recursion level.
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    return { match: false, details: 'actual must be a non-null JSON object schema' };
  }
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    return { match: false, details: 'expected must be a non-null JSON object schema' };
  }

  // Both must have a string type.
  if (typeof actual.type !== 'string' || !actual.type) {
    return { match: false, details: 'actual must have a string type' };
  }
  if (typeof expected.type !== 'string' || !expected.type) {
    return { match: false, details: 'expected must have a string type' };
  }
  if (actual.type !== expected.type) {
    return { match: false, details: `type mismatch: ${String(actual.type)} vs ${String(expected.type)}` };
  }

  const type = actual.type as string;

  if (type === 'object') {
    // Reject null properties/required and malformed property shapes.
    if (actual.properties !== undefined &&
        (actual.properties === null || typeof actual.properties !== 'object' || Array.isArray(actual.properties))) {
      return { match: false, details: 'malformed actual.properties: must be a non-null non-array object' };
    }
    if (expected.properties !== undefined &&
        (expected.properties === null || typeof expected.properties !== 'object' || Array.isArray(expected.properties))) {
      return { match: false, details: 'malformed expected.properties: must be a non-null non-array object' };
    }
    if (actual.required !== undefined &&
        (actual.required === null || !Array.isArray(actual.required))) {
      return { match: false, details: 'malformed actual.required: must be an array' };
    }
    if (expected.required !== undefined &&
        (expected.required === null || !Array.isArray(expected.required))) {
      return { match: false, details: 'malformed expected.required: must be an array' };
    }

    // Validate every required entry is a string.
    if (actual.required !== undefined && actual.required !== null && Array.isArray(actual.required)) {
      for (const entry of actual.required as unknown[]) {
        if (typeof entry !== 'string') {
          return { match: false, details: `malformed actual.required entry: "${String(entry)}" must be a string` };
        }
      }
    }
    if (expected.required !== undefined && expected.required !== null && Array.isArray(expected.required)) {
      for (const entry of expected.required as unknown[]) {
        if (typeof entry !== 'string') {
          return { match: false, details: `malformed expected.required entry: "${String(entry)}" must be a string` };
        }
      }
    }

    // Pre-validation: validate every own property schema in both operands,
    // including optional/unmatched properties, so malformed fragments are
    // caught deterministically before structural comparison begins.
    if (expected.properties !== undefined) {
      const expectedPropsRaw = expected.properties as Record<string, unknown>;
      for (const key of Object.keys(expectedPropsRaw)) {
        if (!Object.hasOwn(expectedPropsRaw, key)) continue;
        const val = expectedPropsRaw[key];
        if (val === null || typeof val !== 'object' || Array.isArray(val)) {
          return { match: false, details: `property "${key}": malformed expected property value` };
        }
      }
    }
    if (actual.properties !== undefined) {
      const actualPropsRaw = actual.properties as Record<string, unknown>;
      for (const key of Object.keys(actualPropsRaw)) {
        if (!Object.hasOwn(actualPropsRaw, key)) continue;
        const val = actualPropsRaw[key];
        if (val === null || typeof val !== 'object' || Array.isArray(val)) {
          return { match: false, details: `property "${key}": malformed actual property value` };
        }
      }
    }

    const actualProps = (actual.properties as Record<string, JsonObject> | undefined) ?? {};
    const expectedProps = (expected.properties as Record<string, JsonObject> | undefined) ?? {};
    const actualRequired = new Set(actual.required as string[] ?? []);
    const expectedRequired = new Set(expected.required as string[] ?? []);

    // Check that every expected required property exists in actual with matching type.
    for (const key of expectedRequired) {
      if (!Object.hasOwn(actualProps, key)) {
        return { match: false, details: `expected required property "${key}" missing from actual` };
      }
      if (actualProps[key] === null || typeof actualProps[key] !== 'object' || Array.isArray(actualProps[key])) {
        return { match: false, details: `property "${key}": malformed actual property value` };
      }
      // Validate expected property value before recursion.
      if (expectedProps[key] === null || typeof expectedProps[key] !== 'object' || Array.isArray(expectedProps[key])) {
        return { match: false, details: `property "${key}": malformed expected property value` };
      }
      const sub = compareTypes(actualProps[key], expectedProps[key]);
      if (!sub.match) {
        return { match: false, details: `property "${key}": ${sub.details}` };
      }
    }

    // Check that every expected optional property, if present, matches.
    for (const key of Object.keys(expectedProps)) {
      if (expectedRequired.has(key)) continue; // already checked
      if (Object.hasOwn(actualProps, key)) {
        if (actualProps[key] === null || typeof actualProps[key] !== 'object' || Array.isArray(actualProps[key])) {
          return { match: false, details: `optional property "${key}": malformed actual property value` };
        }
        // Validate expected optional property value before recursion.
        if (expectedProps[key] === null || typeof expectedProps[key] !== 'object' || Array.isArray(expectedProps[key])) {
          return { match: false, details: `optional property "${key}": malformed expected property value` };
        }
        const sub = compareTypes(actualProps[key], expectedProps[key]);
        if (!sub.match) {
          return { match: false, details: `optional property "${key}": ${sub.details}` };
        }
      }
    }

    return { match: true };
  }

  if (type === 'array') {
    const actualItems = actual.items as JsonObject | undefined;
    const expectedItems = expected.items as JsonObject | undefined;

    if (!actualItems || !expectedItems) {
      return { match: false, details: 'array schemas must have items' };
    }

    // Validate items are schemas before recursion.
    if (typeof actualItems !== 'object' || actualItems === null || Array.isArray(actualItems)) {
      return { match: false, details: 'actual items must be a non-null JSON object' };
    }
    if (typeof expectedItems !== 'object' || expectedItems === null || Array.isArray(expectedItems)) {
      return { match: false, details: 'expected items must be a non-null JSON object' };
    }

    return compareTypes(actualItems, expectedItems);
  }

  // Primitive types (string, number, boolean, integer, null) — exact type match
  // already checked above.
  return { match: true };
}

/**
 * Assertion comparison: `inferred` must exist within `explicit`.
 *
 * Every required field from `inferred` must be present in `explicit` with
 * matching recursive type. Extra optional fields in `explicit` are legal.
 */
export function assertSubset(
  inferred: JsonObject,
  explicit: JsonObject,
): TypeComparisonResult {
  // Total guard: reject non-object, null, or array inputs at any recursion level.
  if (typeof inferred !== 'object' || inferred === null || Array.isArray(inferred)) {
    return { match: false, details: 'inferred must be a non-null JSON object schema' };
  }
  if (typeof explicit !== 'object' || explicit === null || Array.isArray(explicit)) {
    return { match: false, details: 'explicit must be a non-null JSON object schema' };
  }

  // Same shape as compareTypes but direction matters: inferred fields must
  // be a subset of explicit fields (not necessarily equal).
  if (typeof inferred.type !== 'string' || !inferred.type) {
    return { match: false, details: 'inferred must have a string type' };
  }
  if (typeof explicit.type !== 'string' || !explicit.type) {
    return { match: false, details: 'explicit must have a string type' };
  }
  if (inferred.type !== explicit.type) {
    return { match: false, details: `type mismatch: ${String(inferred.type)} vs ${String(explicit.type)}` };
  }

  const type = inferred.type as string;

  if (type === 'object') {
    // Reject null properties/required and malformed property shapes.
    if (inferred.properties !== undefined &&
        (inferred.properties === null || typeof inferred.properties !== 'object' || Array.isArray(inferred.properties))) {
      return { match: false, details: 'malformed inferred.properties: must be a non-null non-array object' };
    }
    if (explicit.properties !== undefined &&
        (explicit.properties === null || typeof explicit.properties !== 'object' || Array.isArray(explicit.properties))) {
      return { match: false, details: 'malformed explicit.properties: must be a non-null non-array object' };
    }
    if (inferred.required !== undefined &&
        (inferred.required === null || !Array.isArray(inferred.required))) {
      return { match: false, details: 'malformed inferred.required: must be an array' };
    }
    if (explicit.required !== undefined &&
        (explicit.required === null || !Array.isArray(explicit.required))) {
      return { match: false, details: 'malformed explicit.required: must be an array' };
    }

    // Validate every required entry is a string.
    if (inferred.required !== undefined && inferred.required !== null && Array.isArray(inferred.required)) {
      for (const entry of inferred.required as unknown[]) {
        if (typeof entry !== 'string') {
          return { match: false, details: `malformed inferred.required entry: "${String(entry)}" must be a string` };
        }
      }
    }
    if (explicit.required !== undefined && explicit.required !== null && Array.isArray(explicit.required)) {
      for (const entry of explicit.required as unknown[]) {
        if (typeof entry !== 'string') {
          return { match: false, details: `malformed explicit.required entry: "${String(entry)}" must be a string` };
        }
      }
    }

    // Pre-validation: validate every own property schema in both operands,
    // including optional/unmatched properties, so malformed fragments are
    // caught deterministically before structural comparison begins.
    if (explicit.properties !== undefined) {
      const explicitPropsRaw = explicit.properties as Record<string, unknown>;
      for (const key of Object.keys(explicitPropsRaw)) {
        if (!Object.hasOwn(explicitPropsRaw, key)) continue;
        const val = explicitPropsRaw[key];
        if (val === null || typeof val !== 'object' || Array.isArray(val)) {
          return { match: false, details: `property "${key}": malformed explicit property value` };
        }
      }
    }
    if (inferred.properties !== undefined) {
      const inferredPropsRaw = inferred.properties as Record<string, unknown>;
      for (const key of Object.keys(inferredPropsRaw)) {
        if (!Object.hasOwn(inferredPropsRaw, key)) continue;
        const val = inferredPropsRaw[key];
        if (val === null || typeof val !== 'object' || Array.isArray(val)) {
          return { match: false, details: `property "${key}": malformed inferred property value` };
        }
      }
    }

    const inferredProps = (inferred.properties as Record<string, JsonObject> | undefined) ?? {};
    const explicitProps = (explicit.properties as Record<string, JsonObject> | undefined) ?? {};
    const inferredRequired = new Set(inferred.required as string[] ?? []);

    for (const key of inferredRequired) {
      if (!Object.hasOwn(explicitProps, key)) {
        return { match: false, details: `inferred required property "${key}" not found in explicit` };
      }
      if (explicitProps[key] === null || typeof explicitProps[key] !== 'object' || Array.isArray(explicitProps[key])) {
        return { match: false, details: `property "${key}": malformed explicit property value` };
      }
      // Validate inferred property value before recursion.
      if (inferredProps[key] === null || typeof inferredProps[key] !== 'object' || Array.isArray(inferredProps[key])) {
        return { match: false, details: `property "${key}": malformed inferred property value` };
      }
      const sub = assertSubset(inferredProps[key], explicitProps[key]);
      if (!sub.match) {
        return { match: false, details: `property "${key}": ${sub.details}` };
      }
    }

    // Extra optional fields in explicit are legal — no check.

    return { match: true };
  }

  if (type === 'array') {
    const inferredItems = inferred.items as JsonObject | undefined;
    const explicitItems = explicit.items as JsonObject | undefined;

    if (!inferredItems || !explicitItems) {
      return { match: false, details: 'array schemas must have items for subset check' };
    }

    // Validate items are schemas before recursion.
    if (typeof inferredItems !== 'object' || inferredItems === null || Array.isArray(inferredItems)) {
      return { match: false, details: 'inferred items must be a non-null JSON object' };
    }
    if (typeof explicitItems !== 'object' || explicitItems === null || Array.isArray(explicitItems)) {
      return { match: false, details: 'explicit items must be a non-null JSON object' };
    }

    return assertSubset(inferredItems, explicitItems);
  }

  return { match: true };
}

// ─── Literal-to-schema inference ──────────────────────────────────────────────

/**
 * Infer a deterministic JSON Schema from a literal value.
 *
 * Handles: primitives, arrays (homogeneous), objects (recursive).
 * Returns a plain JsonObject suitable for use as a JSON Schema.
 */
export function inferSchemaFromLiteral(value: JsonObject | JsonValue): JsonObject {
  if (value === null) {
    return { type: 'null' };
  }
  if (typeof value === 'string') {
    return { type: 'string' };
  }
  if (typeof value === 'number') {
    return { type: 'number' };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }
  if (Array.isArray(value)) {
    // Infer items from the first element; omit items for empty arrays.
    if (value.length > 0) {
      const itemSchema = inferSchemaFromLiteral(value[0] as JsonValue);
      return {
        type: 'array',
        items: itemSchema,
      };
    }
    return { type: 'array' };
  }
  // Plain object
  const properties: Record<string, JsonObject> = {};
  const required: string[] = [];
  for (const [key, val] of Object.entries(value)) {
    Object.defineProperty(properties, key, {
      value: inferSchemaFromLiteral(val as JsonValue),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    required.push(key);
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}
