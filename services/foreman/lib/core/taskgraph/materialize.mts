// ─── TaskGraph schema materialization ─────────────────────────────────────────
// Dependency-aware pure transformation over a cloned post-image.
// Never mutates caller-owned data; returns pinned schemas or structured issues.

import type { TaskGraphNode, TaskGraph, NodeId, JsonObject, ObjectJsonSchema, JsonValue } from './model.mts';

import {
  parseSourceExpr,
  schemaAt,
  assertSubset,
  compareTypes,
  inferSchemaFromLiteral,
  validateGraphSchema,
  type ProjectionSegment,
  type SchemaValidationIssue,
} from './schema-tools.mts';

// ─── Auto schema resolver ─────────────────────────────────────────────────────

/**
 * Narrow resolver over FU-001 action types.
 *
 * Must be supplied explicitly; does not import the live registry.
 */
export interface TaskGraphAutoSchemaResolver {
  /** Return input/output schema pair for a task action. */
  resolveActionSchema(actionType: 'task', params: JsonObject): {
    input: ObjectJsonSchema;
    output: ObjectJsonSchema;
  } | null;

  /** Return the input schema for an LLM action. */
  resolveLlmInputSchema(params: JsonObject): ObjectJsonSchema | null;

  /** Return structured output opts for an LLM action, if declared. */
  resolveLlmStructuredOpts(params: JsonObject): { outputSchema?: ObjectJsonSchema } | null;
}

// ─── Materialization issue ────────────────────────────────────────────────────

export interface MaterializationIssue {
  nodeId: NodeId;
  slot?: 'input' | 'output' | 'dep_input';
  depId?: NodeId;
  code: 'SCHEMA_INVALID' | 'SCHEMA_REQUIRED' | 'MAP_PATH_UNKNOWN' | 'MAP_TYPE_MISMATCH';
  message: string;
}

// ─── Frozen materialization table ─────────────────────────────────────────────

type ActionType = TaskGraphNode['action']['type'];

/**
 * Determine whether an action type has frozen auto-source materialization.
 */
function hasAutoSource(actionType: ActionType): boolean {
  return !['shell'].includes(actionType);
}

function isPinnedObjectSchema(
  schema: ObjectJsonSchema,
  props: Record<string, JsonObject> | null,
): boolean {
  if (props && Object.keys(props).length > 0) return true
  return typeof schema === 'object'
    && schema !== null
    && !Array.isArray(schema)
    && schema.additionalProperties === false
}

/**
 * Materialize omitted schemas for a single node, given its resolved upstream
 * schemas and the auto resolver.
 *
 * Returns the materialized input_schema, output_schema, and any issues.
 */
function materializeNodeSchemas(
  node: TaskGraphNode,
  depInputSchemas: Map<NodeId, ObjectJsonSchema>,
  depOutputSchemas: Map<NodeId, ObjectJsonSchema>,
  resolver: TaskGraphAutoSchemaResolver,
  nodeIds: Set<NodeId>,
): {
  inputSchema: ObjectJsonSchema;
  outputSchema: ObjectJsonSchema;
  issues: MaterializationIssue[];
} {
  const issues: MaterializationIssue[] = [];
  const actionType = node.action.type;
  const params = node.action.params;
  const nid = node.id;

  // ── Guard schema roots against malformed runtime values ──────────────────

  /**
   * Safely extract properties from a potentially malformed schema root.
   * Returns [null] if the root or its properties are malformed (an issue
   * is emitted for every provable malformation), or [Record] otherwise.
   * This makes every Object.keys/clone/merge/type-read path total.
   */
  function guardSchemaRoot(schema: ObjectJsonSchema, slot: 'input' | 'output'): Record<string, JsonObject> | null {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      issues.push({
        nodeId: nid,
        slot,
        code: 'SCHEMA_INVALID',
        message: `${slot} schema root must be a non-null JSON object`,
      });
      return null;
    }
    // Root must have type: 'object'.
    if (schema.type !== 'object') {
      issues.push({
        nodeId: nid,
        slot,
        code: 'SCHEMA_INVALID',
        message: `${slot} schema root must have type "object", got "${String(schema.type)}"`,
      });
      return null;
    }
    // Validate properties shape before Object.keys, cloning, or merging.
    if (schema.properties === null) {
      issues.push({
        nodeId: nid,
        slot,
        code: 'SCHEMA_INVALID',
        message: `${slot} schema.properties must not be null`,
      });
      return null;
    }
    if (schema.properties !== undefined &&
        (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
      issues.push({
        nodeId: nid,
        slot,
        code: 'SCHEMA_INVALID',
        message: `${slot} schema.properties must be a non-null non-array object`,
      });
      return null;
    }
    // Validate required shape before iteration (object properties have the
    // same issue code — structural invalidity, not a type mismatch).
    if (schema.required === null) {
      issues.push({
        nodeId: nid,
        slot,
        code: 'SCHEMA_INVALID',
        message: `${slot} schema.required must not be null`,
      });
      // Fall-through: still return properties so other checks can proceed.
    } else if (schema.required !== undefined && !Array.isArray(schema.required)) {
      issues.push({
        nodeId: nid,
        slot,
        code: 'SCHEMA_INVALID',
        message: `${slot} schema.required must be an array`,
      });
      // Fall-through: still return properties so other checks can proceed.
    }
    // Recursively validate each property entry — reject null, boolean, or array values.
    const rawProps = schema.properties as Record<string, JsonValue> | null | undefined;
    if (rawProps !== undefined && rawProps !== null) {
      for (const [pname, pval] of Object.entries(rawProps)) {
        if (pval === null || typeof pval !== 'object' || Array.isArray(pval)) {
          issues.push({
            nodeId: nid,
            slot,
            code: 'SCHEMA_INVALID',
            message: `${slot} schema property "${pname}" must be a non-null non-array object`,
          });
        }
      }
    }
    return (schema.properties ?? {}) as Record<string, JsonObject>;
  }

  // ── Recursive schema validation (maps from validateGraphSchema) ──────────

  /**
   * Recursively validate schema-bearing children of a non-null object schema.
   * Pushes a SCHEMA_INVALID issue for every malformed nested child.
   */
  function emitSchemaValidationIssues(schema: JsonObject, slot: 'input' | 'output'): void {
    for (const si of validateGraphSchema(schema, `${nid}.${slot}_schema`)) {
      if (issues.some((i) => i.code === 'SCHEMA_INVALID' && i.message.startsWith(`[${si.path}]`))) continue;
      issues.push({
        nodeId: nid,
        slot,
        code: 'SCHEMA_INVALID',
        message: `[${si.path}] ${si.message}`,
      });
    }
  }

  const inputProps = guardSchemaRoot(node.input_schema, 'input');
  const outputProps = guardSchemaRoot(node.output_schema, 'output');

  // Recursively validate explicit schemas.  The issues are accumulated
  // unconditionally even when an auto schema replaces the explicit one.
  if (typeof node.input_schema === 'object' && node.input_schema !== null && !Array.isArray(node.input_schema)) {
    emitSchemaValidationIssues(node.input_schema as JsonObject, 'input');
  }
  if (typeof node.output_schema === 'object' && node.output_schema !== null && !Array.isArray(node.output_schema)) {
    emitSchemaValidationIssues(node.output_schema as JsonObject, 'output');
  }


  // ── Cycle-safe clone wrapper (pushes issues on cycle) ─────────────────────

  function cloneSchema<T extends ObjectJsonSchema | JsonObject>(s: T, slot?: 'input' | 'output', label?: string): T {
    const result = deepClone(s);
    if (result === CLONE_CYCLE_SENTINEL) {
      issues.push({
        nodeId: nid,
        slot,
        code: 'SCHEMA_INVALID',
        message: `${label ?? 'schema'}: cyclic reference detected during clone`,
      });
      return s;
    }
    return result;
  }

  // ── Parse inputs.<slot>[.field][[index]] ref ───────────────────────────────

  function parseInputsRef(expr: string): { slot: string; projection: ProjectionSegment[] } | null {
    const trimmed = expr.trim();
    const re = /^inputs\.([a-zA-Z_]\w*)((?:\.[a-zA-Z_]\w*|\[\d+\])*)$/;
    const m = re.exec(trimmed);
    if (!m) return null;
    const slot = m[1];
    const suffix = m[2];
    const projection: ProjectionSegment[] = [];
    if (suffix) {
      const tokenRe = /\.([a-zA-Z_]\w*)|\[(\d+)\]/g;
      let token: RegExpExecArray | null;
      while ((token = tokenRe.exec(suffix)) !== null) {
        if (token[1] !== undefined) {
          projection.push({ kind: 'field', value: token[1] });
        } else {
          projection.push({ kind: 'index', value: parseInt(token[2], 10) });
        }
      }
    }
    return { slot, projection };
  }

  // ── Set schema at dot-separated path in output builder ─────────────────────

  type SetNestedPropResult =
    | { ok: true }
    | { ok: false; code: 'MAP_TYPE_MISMATCH' | 'SCHEMA_INVALID'; message: string };

  /** Recursively merge two object schemas, reporting type conflicts at every leaf. */
  function mergeNestedObjects(
    existing: ObjectJsonSchema,
    incoming: ObjectJsonSchema,
    contextPath: string,
  ): { ok: true; merged: ObjectJsonSchema } | { ok: false; code: 'MAP_TYPE_MISMATCH' | 'SCHEMA_INVALID'; message: string } {
    // Validate runtime shapes before accessing properties/required.
    if (existing.properties !== undefined && existing.properties !== null &&
        (typeof existing.properties !== 'object' || Array.isArray(existing.properties))) {
      return { ok: false, code: 'SCHEMA_INVALID', message: `malformed existing.properties at "${contextPath}"` };
    }
    if (incoming.properties !== undefined && incoming.properties !== null &&
        (typeof incoming.properties !== 'object' || Array.isArray(incoming.properties))) {
      return { ok: false, code: 'SCHEMA_INVALID', message: `malformed incoming.properties at "${contextPath}"` };
    }
    if (existing.required !== undefined && existing.required !== null && !Array.isArray(existing.required)) {
      return { ok: false, code: 'SCHEMA_INVALID', message: `malformed existing.required at "${contextPath}"` };
    }
    if (incoming.required !== undefined && incoming.required !== null && !Array.isArray(incoming.required)) {
      return { ok: false, code: 'SCHEMA_INVALID', message: `malformed incoming.required at "${contextPath}"` };
    }

    const existingProps = (existing.properties ?? {}) as Record<string, JsonObject>;
    const incomingProps = (incoming.properties ?? {}) as Record<string, JsonObject>;
    const mergedProps: Record<string, JsonObject> = {};

    // Validate each property entry before cloning.
    for (const [k, v] of Object.entries(existingProps)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, code: 'SCHEMA_INVALID', message: `malformed existing property "${k}" at "${contextPath}"` };
      }
      defineOwnProp(mergedProps, k, cloneSchema(v as ObjectJsonSchema) as JsonObject);
    }

    const mergedReq = [...((existing.required ?? []) as string[])];
    for (const k of incoming.required ?? []) {
      if (typeof k !== 'string') {
        return { ok: false, code: 'SCHEMA_INVALID', message: `malformed required entry "${String(k)}" at "${contextPath}"` };
      }
      if (!mergedReq.includes(k)) mergedReq.push(k);
    }

    for (const [k, v] of Object.entries(incomingProps)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, code: 'SCHEMA_INVALID', message: `malformed incoming property "${k}" at "${contextPath}"` };
      }
      if (Object.hasOwn(mergedProps, k)) {
        const existVal = mergedProps[k] as ObjectJsonSchema;
        const incomingVal = v as ObjectJsonSchema;
        if (existVal.type !== incomingVal.type) {
          return {
            ok: false,
            code: 'MAP_TYPE_MISMATCH',
            message: `incompatible type at "${contextPath}.${k}": existing "${existVal.type}" vs "${incomingVal.type}"`,
          };
        }
        if (existVal.type === 'object') {
          const sub = mergeNestedObjects(existVal, incomingVal, `${contextPath}.${k}`);
          if (!sub.ok) return sub;
          defineOwnProp(mergedProps, k, sub.merged as JsonObject);
        }
      } else {
        defineOwnProp(mergedProps, k, cloneSchema(v as ObjectJsonSchema) as JsonObject);
        if (!mergedReq.includes(k)) mergedReq.push(k);
      }
    }

    return {
      ok: true,
      merged: { type: 'object', properties: mergedProps, required: mergedReq } as ObjectJsonSchema,
    };
  }

  function setNestedProp(
    parent: ObjectJsonSchema,
    path: string[],
    schema: ObjectJsonSchema,
    key: string,
  ): SetNestedPropResult {
    // Validate parent.properties shape before access.
    if (parent.properties !== undefined && parent.properties !== null &&
        (typeof parent.properties !== 'object' || Array.isArray(parent.properties))) {
      return {
        ok: false,
        code: 'SCHEMA_INVALID',
        message: `malformed parent.properties at "${key}"`,
      };
    }
    const props = (parent.properties ?? {}) as Record<string, JsonObject>;
    const [head, ...rest] = path;
    if (rest.length === 0) {
      if (Object.hasOwn(props, head)) {
        const existing = props[head];
        // Validate existing property value before accessing .type.
        if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
          return {
            ok: false,
            code: 'SCHEMA_INVALID',
            message: `malformed existing property "${head}" at "${key}"`,
          };
        }
        if ((existing as ObjectJsonSchema).type !== schema.type) {
          return {
            ok: false,
            code: 'MAP_TYPE_MISMATCH',
            message: `incompatible type at "${head}": existing "${(existing as ObjectJsonSchema).type}" vs "${schema.type}"`,
          };
        }
        if (schema.type === 'object') {
          const existObj = cloneSchema(existing as ObjectJsonSchema);
          // Recursively merge and compare object leaves for conflicts.
          const mergeResult = mergeNestedObjects(existObj, cloneSchema(schema), key === head ? head : `${key}.${head}`);
          if (!mergeResult.ok) {
            return mergeResult;
          }
          defineOwnProp(props, head, mergeResult.merged as JsonObject);
        }
      } else {
        // Validate schema before cloning.
        if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
          return {
            ok: false,
            code: 'SCHEMA_INVALID',
            message: `malformed schema for property "${head}" at "${key}"`,
          };
        }
        defineOwnProp(props, head, cloneSchema(schema) as JsonObject);
        const parentReq = parent.required ?? ([] as string[]);
        if (!parentReq.includes(head)) parentReq.push(head);
        parent.required = parentReq;
      }
      parent.properties = props;
      return { ok: true };
    }
    // Intermediate segment — ensure it is an object
    if (!Object.hasOwn(props, head) || (props[head] as ObjectJsonSchema).type !== 'object') {
      if (Object.hasOwn(props, head)) {
        // Validate existing intermediate property before accessing .type.
        const existing = props[head];
        if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
          return {
            ok: false,
            code: 'SCHEMA_INVALID',
            message: `malformed intermediate property "${head}" at "${key}"`,
          };
        }
        return {
          ok: false,
          code: 'MAP_TYPE_MISMATCH',
          message: `cannot nest "${key}" under non-object path "${head}"`,
        };
      }
      const newObj: ObjectJsonSchema = { type: 'object', properties: {}, required: [] };
      defineOwnProp(props, head, newObj as JsonObject);
      const parentReq = parent.required ?? ([] as string[]);
      if (!parentReq.includes(head)) parentReq.push(head);
      parent.required = parentReq;
    }
    parent.properties = props;
    const childObj = props[head] as ObjectJsonSchema;
    return setNestedProp(childObj, rest, schema, key);
  }

  // ── Derive input from upstream projections ─────────────────────────────────

  function deriveInputFromUpstream(): { schema: ObjectJsonSchema; iss: MaterializationIssue[] } {
    const iss: MaterializationIssue[] = [];
    const properties: Record<string, JsonObject> = {};
    const required: string[] = [];

    for (const inp of node.input) {
      const parsed = parseSourceExpr(inp.source, nodeIds);
      if (!parsed) {
        iss.push({
          nodeId: nid,
          slot: 'input',
          code: 'MAP_PATH_UNKNOWN',
          message: `cannot parse source expression "${inp.source}"`,
        });
        continue;
      }

      // Resolve dep output schema for the source node.
      const depSchema = depOutputSchemas.get(parsed.nodeId);
      if (!depSchema) {
        iss.push({
          nodeId: nid,
          slot: 'dep_input',
          depId: parsed.nodeId,
          code: 'MAP_PATH_UNKNOWN',
          message: `source node "${parsed.nodeId}" has no materialized output schema`,
        });
        continue;
      }

      // Guard dep schema root before schemaAt access.
      if (typeof depSchema !== 'object' || depSchema === null || Array.isArray(depSchema)) {
        iss.push({
          nodeId: nid,
          slot: 'dep_input',
          depId: parsed.nodeId,
          code: 'SCHEMA_INVALID',
          message: `source node "${parsed.nodeId}" output schema root is malformed`,
        });
        continue;
      }

      const projected = schemaAt(depSchema as JsonObject, parsed.projection);
      if (!projected.found) {
        iss.push({
          nodeId: nid,
          slot: 'input',
          code: 'MAP_PATH_UNKNOWN',
          message: `cannot resolve source "${inp.source}": ${projected.reason}`,
        });
        continue;
      }

      defineOwnProp(properties, inp.name, cloneSchema(projected.schema as ObjectJsonSchema, 'input', `projection for "${inp.source}"`) as JsonObject);
      if (!inp.optional) {
        required.push(inp.name);
      }
    }

    return {
      schema: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      } as ObjectJsonSchema,
      iss,
    };
  }

  // ── Construct output from assemble ──────────────────────────────────────────

  function constructOutputFromAssemble(
    inputSchema: ObjectJsonSchema | undefined,
  ): { schema: ObjectJsonSchema; iss: MaterializationIssue[] } {
    const iss: MaterializationIssue[] = [];
    const outProps: Record<string, JsonObject> = {};
    const outRequired: string[] = [];

    // Assemble is encoded in node.action.params.assemble.
    const hasAssemble = Object.hasOwn(params, 'assemble');
    if (!hasAssemble) {
      iss.push({
        nodeId: nid,
        slot: 'output',
        code: 'SCHEMA_REQUIRED',
        message: 'no assemble block found; cannot construct output schema',
      });
      return { schema: { type: 'object', properties: {} } as ObjectJsonSchema, iss };
    }

    const rawAssemble = params.assemble;
    if (rawAssemble === null || Array.isArray(rawAssemble) || typeof rawAssemble !== 'object') {
      iss.push({
        nodeId: nid,
        slot: 'output',
        code: 'SCHEMA_INVALID',
        message: `assemble block must be a non-null non-array object, got ${rawAssemble === null ? 'null' : typeof rawAssemble}`,
      });
      return { schema: { type: 'object', properties: {} } as ObjectJsonSchema, iss };
    }

    const assemble = rawAssemble as Record<string, JsonValue>;

    // ── Resolve a single assemble value to a schema ─────────────────────────
    function resolveValue(val: JsonValue): JsonObject | null {
      if (typeof val === 'string') {
        // Try inputs.<slot> reference
        const ref = parseInputsRef(val);
        if (ref) {
          if (!inputSchema) {
            iss.push({
              nodeId: nid,
              slot: 'output',
              code: 'MAP_PATH_UNKNOWN',
              message: `assemble field: no input schema to resolve "${val}"`,
            });
            return null;
          }
          // Guard inputSchema root before property access.
          if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
            iss.push({
              nodeId: nid,
              slot: 'output',
              code: 'SCHEMA_INVALID',
              message: `assemble field: input schema root is malformed when resolving "${val}"`,
            });
            return null;
          }
          // Look up slot in input schema properties first
          const inputProps = (inputSchema.properties ?? {}) as Record<string, JsonObject>;
          if (!Object.hasOwn(inputProps, ref.slot)) {
            iss.push({
              nodeId: nid,
              slot: 'output',
              code: 'MAP_PATH_UNKNOWN',
              message: `assemble field: slot "${ref.slot}" not found in input schema`,
            });
            return null;
          }
          const slotSchema = inputProps[ref.slot];
          // Walk remaining projection from the slot schema
          if (ref.projection.length === 0) {
            return cloneSchema(slotSchema as ObjectJsonSchema) as JsonObject;
          }
          const projected = schemaAt(slotSchema as JsonObject, ref.projection);
          if (!projected.found) {
            iss.push({
              nodeId: nid,
              slot: 'output',
              code: 'MAP_PATH_UNKNOWN',
              message: `assemble field: cannot resolve "${val}": ${projected.reason}`,
            });
            return null;
          }
          return cloneSchema(projected.schema as ObjectJsonSchema) as JsonObject;
        }
        // Bare string that is not an inputs ref → MAP_PATH_UNKNOWN
        iss.push({
          nodeId: nid,
          slot: 'output',
          code: 'MAP_PATH_UNKNOWN',
          message: `assemble field: cannot parse "${val}" as inputs.<slot> reference`,
        });
        return null;
      }

      // `{ const: <JSON value> }` — unwrap and infer
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const obj = val as Record<string, JsonValue>;
        if ('const' in obj && Object.keys(obj).length === 1) {
          return inferSchemaFromLiteral(obj.const);
        }
        // Plain literal object — recursively resolve each property value
        // so that nested input projections and {const} are resolved, while
        // bare strings at any depth produce MAP_PATH_UNKNOWN.
        const resolvedProps: Record<string, JsonObject> = {};
        const resolvedRequired: string[] = [];
        let childFailed = false;
        for (const [k, v] of Object.entries(obj)) {
          const subResult = resolveValue(v);
          if (subResult === null) {
            childFailed = true;
            continue;
          }
          defineOwnProp(resolvedProps, k, subResult as JsonObject);
          resolvedRequired.push(k);
        }
        if (childFailed) { return null; }
        return {
          type: 'object',
          properties: resolvedProps,
          required: resolvedRequired.length > 0 ? resolvedRequired : undefined,
          additionalProperties: false,
        } as JsonObject;
      }

      // Array — resolve every element through unified scalar expression rules
      if (Array.isArray(val)) {
        let itemSchema: JsonObject | null = null;
        let arrayFailed = false;

        for (const item of val) {
          let elemSchema: JsonObject | null = null;

          if (typeof item === 'string') {
            // String must be a valid inputs.<slot> projection or MAP_PATH_UNKNOWN
            const ref = parseInputsRef(item);
            if (ref) {
              if (!inputSchema) {
                iss.push({
                  nodeId: nid,
                  slot: 'output',
                  code: 'MAP_PATH_UNKNOWN',
                  message: `assemble field: no input schema to resolve "${item}"`,
                });
                continue;
              }
              // Guard inputSchema root before property access in array item.
              if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
                iss.push({
                  nodeId: nid,
                  slot: 'output',
                  code: 'SCHEMA_INVALID',
                  message: `assemble field: input schema root is malformed when resolving array item "${item}"`,
                });
                continue;
              }
              const inputProps = (inputSchema.properties ?? {}) as Record<string, JsonObject>;
              if (!Object.hasOwn(inputProps, ref.slot)) {
                iss.push({
                  nodeId: nid,
                  slot: 'output',
                  code: 'MAP_PATH_UNKNOWN',
                  message: `assemble field: slot "${ref.slot}" not found in input schema`,
                });
                continue;
              }
              const slotSchema = inputProps[ref.slot];
              if (ref.projection.length === 0) {
                elemSchema = cloneSchema(slotSchema as ObjectJsonSchema) as JsonObject;
              } else {
                const projected = schemaAt(slotSchema as JsonObject, ref.projection);
                if (!projected.found) {
                  iss.push({
                    nodeId: nid,
                    slot: 'output',
                    code: 'MAP_PATH_UNKNOWN',
                    message: `assemble field: cannot resolve "${item}": ${projected.reason}`,
                  });
                  continue;
                }
                elemSchema = cloneSchema(projected.schema as ObjectJsonSchema) as JsonObject;
              }
            } else {
              // Bare string — not a valid inputs ref, reject
              iss.push({
                nodeId: nid,
                slot: 'output',
                code: 'MAP_PATH_UNKNOWN',
                message: `assemble field: bare string constant "${item}" in array not allowed; use {const: "${item}"} for literal values`,
              });
              continue;
            }
          } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            const obj = item as Record<string, JsonValue>;
            if ('const' in obj && Object.keys(obj).length === 1) {
              // {const: value} infers from the wrapped value
              elemSchema = inferSchemaFromLiteral(obj.const);
            } else {
              // Plain literal object — recursively resolve each property
              const resolved: Record<string, JsonObject> = {};
              const resReq: string[] = [];
              let failed = false;
              for (const [k, v] of Object.entries(obj)) {
                const subResult = resolveValue(v);
                if (subResult === null) { failed = true; continue; }
                defineOwnProp(resolved, k, subResult as JsonObject);
                resReq.push(k);
              }
              if (failed) { arrayFailed = true; continue; }
              elemSchema = {
                type: 'object',
                properties: resolved,
                required: resReq.length > 0 ? resReq : undefined,
                additionalProperties: false,
              } as JsonObject;
            }
          } else if (Array.isArray(item)) {
            // Nested array — recursively resolve each element
            let nestedItemSchema: JsonObject | null = null;
            let nestedFailed = false;
            for (const nestedItem of item) {
              const subResult = resolveValue(nestedItem as JsonValue);
              if (subResult === null) { nestedFailed = true; continue; }
              if (nestedItemSchema) {
                const comp = compareTypes(subResult as JsonObject, nestedItemSchema as JsonObject);
                if (!comp.match) {
                  iss.push({
                    nodeId: nid,
                    slot: 'output',
                    code: 'MAP_TYPE_MISMATCH',
                    message: `assemble field: nested array element type mismatch: ${comp.details}`,
                  });
                  nestedFailed = true;
                  continue;
                }
              } else {
                nestedItemSchema = subResult;
              }
            }
            if (nestedFailed) { arrayFailed = true; continue; }
            if (!nestedItemSchema) {
              elemSchema = { type: 'array' as JsonValue } as JsonObject;
            } else {
              elemSchema = { type: 'array' as JsonValue, items: nestedItemSchema } as JsonObject;
            }
          } else {
            // Number, boolean, null
            elemSchema = inferSchemaFromLiteral(item as JsonValue);
          }

          // Compare element schemas for type compatibility
          if (elemSchema) {
            if (itemSchema) {
              const comp = compareTypes(elemSchema as JsonObject, itemSchema as JsonObject);
              if (!comp.match) {
                iss.push({
                  nodeId: nid,
                  slot: 'output',
                  code: 'MAP_TYPE_MISMATCH',
                  message: `assemble field: array element type mismatch: ${comp.details}`,
                });
                continue;
              }
            } else {
              itemSchema = elemSchema;
            }
          }
        }

        if (arrayFailed) return null;
        if (!itemSchema) return { type: 'array' as JsonValue } as JsonObject;
        return { type: 'array' as JsonValue, items: itemSchema } as JsonObject;
      }

      // Number, boolean, null
      return inferSchemaFromLiteral(val as JsonValue);
    }

    for (const [key, val] of Object.entries(assemble)) {
      const resolved = resolveValue(val);
      if (resolved === null) continue;

      const path = key.split('.');
      if (path.length === 1) {
        // Simple flat key
        if (Object.hasOwn(outProps, path[0])) {
          const existing = outProps[path[0]] as ObjectJsonSchema;
          if (existing.type !== (resolved as ObjectJsonSchema).type) {
            iss.push({
              nodeId: nid,
              slot: 'output',
              code: 'MAP_TYPE_MISMATCH',
              message: `assemble field "${key}": incompatible type at "${path[0]}"`,
            });
            continue;
          }
          // Same type — recursively merge object properties via mergeNestedObjects.
          if ((resolved as ObjectJsonSchema).type === 'object') {
            const existObj = cloneSchema(existing as ObjectJsonSchema);
            const mergeResult = mergeNestedObjects(existObj, resolved as ObjectJsonSchema, path[0]);
            if (!mergeResult.ok) {
              iss.push({
                nodeId: nid,
                slot: 'output',
                code: mergeResult.code,
                message: `assemble field "${key}": ${mergeResult.message}`,
              });
              continue;
            }
            defineOwnProp(outProps, path[0], mergeResult.merged as JsonObject);
          }
        } else {
          defineOwnProp(outProps, path[0], cloneSchema(resolved as ObjectJsonSchema) as JsonObject);
          outRequired.push(path[0]);
        }
      } else {
        // Nested path — check for collision with existing flat key at root
        if (Object.hasOwn(outProps, path[0])) {
          const existing = outProps[path[0]] as ObjectJsonSchema;
          if (existing.type !== 'object') {
            iss.push({
              nodeId: nid,
              slot: 'output',
              code: 'MAP_TYPE_MISMATCH',
              message: `assemble field "${key}": cannot nest under non-object path "${path[0]}"`,
            });
            continue;
          }
        } else if (outRequired.includes(path[0])) {
          // Already set as top-level required — collision at root
          continue;
        } else {
          defineOwnProp(outProps, path[0], { type: 'object', properties: {} as Record<string, JsonObject> } as JsonObject);
          outRequired.push(path[0]);
        }
        const childObj = outProps[path[0]] as ObjectJsonSchema;
        const result = setNestedProp(childObj, path.slice(1), resolved as ObjectJsonSchema, key);
        if (!result.ok) {
          iss.push({
            nodeId: nid,
            slot: 'output',
            code: result.code,
            message: `assemble field "${key}": ${result.message}`,
          });
        }
      }
    }

    return {
      schema: {
        type: 'object',
        properties: outProps,
        required: outRequired,
        additionalProperties: false,
      } as ObjectJsonSchema,
      iss,
    };
  }

  // ── Frozen action-type rules ────────────────────────────────────────────────

  let inputSchema: ObjectJsonSchema;
  let outputSchema: ObjectJsonSchema;

  switch (actionType) {
    case 'start': {
      // Start: empty deps and slots + handwritten object output.
      inputSchema = { type: 'object', properties: {} as Record<string, JsonObject> } as ObjectJsonSchema;
      outputSchema = node.output_schema;
      break;
    }

    case 'end': {
      // End: handwritten input and output.
      inputSchema = node.input_schema;
      outputSchema = node.output_schema;
      break;
    }

    case 'task': {
      const resolved = resolver.resolveActionSchema(actionType, params);
      if (resolved === null || resolved === undefined) {
        // Documented resolver absence is legal when the graph already carries
        // pinned object schemas. Empty `properties` plus
        // `additionalProperties: false` is the compact/template pin for "no
        // graph wiring slots" and must not demand auto-resolution.
        if (!isPinnedObjectSchema(node.input_schema, inputProps)) {
          issues.push({
            nodeId: nid,
            slot: 'input',
            code: 'SCHEMA_REQUIRED',
            message: `cannot auto-resolve ${actionType} input schema; supply explicit schema`,
          });
        }
        if (!isPinnedObjectSchema(node.output_schema, outputProps)) {
          issues.push({
            nodeId: nid,
            slot: 'output',
            code: 'SCHEMA_REQUIRED',
            message: `cannot auto-resolve ${actionType} output schema; supply explicit schema`,
          });
        }
        inputSchema = node.input_schema;
        outputSchema = node.output_schema;
      } else if (typeof resolved !== 'object' || Array.isArray(resolved)) {
        issues.push({
          nodeId: nid,
          code: 'SCHEMA_INVALID',
          message: `resolver provided malformed ${actionType} result (must be null or object)`,
        });
        inputSchema = node.input_schema;
        outputSchema = node.output_schema;
      } else {
        // Graph input_schema describes wiring slots, not the definition's
        // payload contract (B7). The definition input is validated separately
        // by the contract resolver and may contain task-run-only members such
        // as the reserved open `ctx` object, so it must not enter graph-schema
        // validation here.
        const resolvOutput = resolved.output;

        if (typeof resolvOutput !== 'object' || resolvOutput === null || Array.isArray(resolvOutput)) {
          issues.push({
            nodeId: nid,
            slot: 'output',
            code: 'SCHEMA_INVALID',
            message: `resolver provided malformed output schema for ${actionType} action`,
          });
        }

        // Only output participates in graph schema materialization. Definition
        // input contracts remain owned by create/patch payload validation.
        if (typeof resolvOutput === 'object' && resolvOutput !== null && !Array.isArray(resolvOutput)) {
          emitSchemaValidationIssues(resolvOutput as JsonObject, 'output');
        }

        // Node.input_schema is always preserved as-is (graph wiring slots only,
        // never replaced or subset-compared with definition input contracts per B7).
        inputSchema = node.input_schema;

        // Output auto-resolution still applies (B7 preserves output auto-schema).
        if (resolvOutput && outputProps && Object.keys(outputProps).length > 0) {
          const check = assertSubset(resolvOutput as JsonObject, node.output_schema as JsonObject);
          if (!check.match) {
            issues.push({
              nodeId: nid,
              slot: 'output',
              code: 'MAP_TYPE_MISMATCH',
              message: `resolved output schema conflicts with explicit: ${check.details}`,
            });
          }
        }
        outputSchema = resolvOutput ? cloneSchema(resolvOutput, 'output', 'resolver output') : node.output_schema;
      }
      break;
    }

    case 'llm': {
      const resolvedInput = resolver.resolveLlmInputSchema(params);
      const structured = resolver.resolveLlmStructuredOpts(params);

      // Input: distinguish resolver absence (null/undefined) from malformed runtime values.
      if (resolvedInput === null || resolvedInput === undefined) {
        // Documented absence — preserve explicit input.
        inputSchema = node.input_schema;
      } else if (typeof resolvedInput !== 'object' || resolvedInput === null || Array.isArray(resolvedInput)) {
        issues.push({
          nodeId: nid,
          slot: 'input',
          code: 'SCHEMA_INVALID',
          message: 'resolver provided malformed LLM input schema',
        });
        inputSchema = node.input_schema;
      } else {
        if (inputProps && Object.keys(inputProps).length > 0) {
          const check = assertSubset(resolvedInput as JsonObject, node.input_schema as JsonObject);
          if (!check.match) {
            issues.push({
              nodeId: nid,
              slot: 'input',
              code: 'MAP_TYPE_MISMATCH',
              message: `resolved LLM input conflicts with explicit: ${check.details}`,
            });
          }
        }
        inputSchema = cloneSchema(resolvedInput, 'input', 'resolver llm input');
      }

      // Output: use own-property presence for structured.outputSchema.
      if (structured === null || structured === undefined) {
        // No structured opts — canonical text output.
        outputSchema = {
          type: 'object',
          properties: { text: { type: 'string' } as JsonObject },
          required: ['text'],
          additionalProperties: false,
        } as ObjectJsonSchema;
      } else if (typeof structured !== 'object' || Array.isArray(structured)) {
        issues.push({
          nodeId: nid,
          slot: 'output',
          code: 'SCHEMA_INVALID',
          message: 'resolver provided malformed LLM structured opts (must be null or object)',
        });
        outputSchema = {
          type: 'object',
          properties: { text: { type: 'string' } as JsonObject },
          required: ['text'],
          additionalProperties: false,
        } as ObjectJsonSchema;
      } else if (Object.hasOwn(structured, 'outputSchema')) {
        const rawSchema = structured.outputSchema;
        if (rawSchema !== null && typeof rawSchema === 'object' && !Array.isArray(rawSchema)) {
          // Recursively validate before clone.
          emitSchemaValidationIssues(rawSchema as JsonObject, 'output');
          // Valid structured output schema.
          outputSchema = cloneSchema(rawSchema, 'output', 'resolver structured output');
        } else {
          // Present own property but not a valid schema object — malformed.
          issues.push({
            nodeId: nid,
            slot: 'output',
            code: 'SCHEMA_INVALID',
            message: 'resolver provided malformed LLM structured output schema (own outputSchema present but invalid)',
          });
          outputSchema = {
            type: 'object',
            properties: { text: { type: 'string' } as JsonObject },
            required: ['text'],
            additionalProperties: false,
          } as ObjectJsonSchema;
        }
      } else {
        // structured opts object present but no outputSchema own property — no structured output.
        outputSchema = {
          type: 'object',
          properties: { text: { type: 'string' } as JsonObject },
          required: ['text'],
          additionalProperties: false,
        } as ObjectJsonSchema;
      }
      break;
    }

    case 'convert': {
      if (node.deps.length !== 1) {
        issues.push({
          nodeId: nid,
          code: 'SCHEMA_INVALID',
          message: 'convert must have exactly one dependency',
        });
      }
      const derivedInput = deriveInputFromUpstream();
      issues.push(...derivedInput.iss);
      inputSchema = derivedInput.schema;

      const derivedOutput = constructOutputFromAssemble(derivedInput.schema);
      issues.push(...derivedOutput.iss);
      outputSchema = derivedOutput.schema;
      break;
    }

    case 'join': {
      if (node.deps.length < 2) {
        issues.push({
          nodeId: nid,
          code: 'SCHEMA_INVALID',
          message: 'join must have at least two dependencies',
        });
      }
      const derivedInput = deriveInputFromUpstream();
      issues.push(...derivedInput.iss);
      inputSchema = derivedInput.schema;

      const derivedOutput = constructOutputFromAssemble(derivedInput.schema);
      issues.push(...derivedOutput.iss);
      outputSchema = derivedOutput.schema;
      break;
    }

    case 'condition': {
      // Reuse the assembled upstream input, then add the selected downstream
      // node id as the routing fact required by D55.
      const derivedInput = deriveInputFromUpstream();
      issues.push(...derivedInput.iss);
      inputSchema = derivedInput.schema;

      outputSchema = {
        type: 'object',
        properties: {
          branch: { type: 'string' as JsonValue },
        } as Record<string, JsonObject>,
        required: ['branch'],
        additionalProperties: false,
      } as ObjectJsonSchema;
      break;
    }

    case 'checkpoint': {
      // Reuse upstream input.
      const derivedInput = deriveInputFromUpstream();
      issues.push(...derivedInput.iss);
      inputSchema = derivedInput.schema;

      // Require handwritten output.
      outputSchema = node.output_schema;
      break;
    }

    case 'shell': {
      // No frozen auto source — preserve explicit schemas, report SCHEMA_REQUIRED if omitted.
      inputSchema = node.input_schema;
      outputSchema = node.output_schema;
      if (inputProps && Object.keys(inputProps).length === 0) {
        issues.push({
          nodeId: nid,
          slot: 'input',
          code: 'SCHEMA_REQUIRED',
          message: 'shell action requires explicit input schema',
        });
      }
      if (outputProps && Object.keys(outputProps).length === 0) {
        issues.push({
          nodeId: nid,
          slot: 'output',
          code: 'SCHEMA_REQUIRED',
          message: 'shell action requires explicit output schema',
        });
      }
      break;
    }

    default: {
      // Unknown action type — preserve.
      inputSchema = node.input_schema;
      outputSchema = node.output_schema;
      break;
    }
  }

  return { inputSchema, outputSchema, issues };
}

// ─── Own-data writer ──────────────────────────────────────────────────────────

/**
 * Define an own data property on an object using Object.defineProperty.
 * This ensures keys like "__proto__", "constructor", and "toString" are stored
 * as ordinary own data properties rather than mutating the prototype chain or
 * being shadowed by Object.prototype members.
 */
function defineOwnProp<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// ─── Deep-clone helper ──────────────────────────────────────────────────────

/** Sentinel value returned when a cyclic reference is detected during clone. */
const CLONE_CYCLE_SENTINEL = {};

/**
 * Pure recursive deep clone with cycle detection.
 * Returns `CLONE_CYCLE_SENTINEL` on cyclic reference instead of throwing.
 */
function deepClone<T>(v: T, ancestors?: Set<object>): T {
  if (typeof v !== 'object' || v === null) return v;
  const anc = ancestors ?? new Set<object>();
  if (anc.has(v as object)) return CLONE_CYCLE_SENTINEL as unknown as T;
  anc.add(v as object);
  try {
    if (Array.isArray(v)) {
      const result: unknown[] = [];
      for (const e of v) {
        const cloned = deepClone(e, anc);
        if (cloned === CLONE_CYCLE_SENTINEL) return CLONE_CYCLE_SENTINEL as unknown as T;
        result.push(cloned);
      }
      return result as unknown as T;
    }
    const r: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const cloned = deepClone((v as Record<string, unknown>)[k], anc);
      if (cloned === CLONE_CYCLE_SENTINEL) return CLONE_CYCLE_SENTINEL as unknown as T;
      defineOwnProp(r, k, cloned);
    }
    return r as T;
  } finally {
    anc.delete(v as object);
  }
}

// ─── Topological sort ─────────────────────────────────────────────────────────

/**
 * Return a deterministic dependency order for the given node records.
 * Uses Kahn's algorithm for acyclic graphs; any remaining cyclic nodes
 * are appended in sorted id order for predictable iteration.
 */
function topologicalNodeOrder(nodes: Record<NodeId, TaskGraphNode>): NodeId[] {
  const nodeIds = Object.keys(nodes).sort();
  const inDegree = new Map<NodeId, number>();
  const adjacency = new Map<NodeId, NodeId[]>();

  for (const nid of nodeIds) {
    inDegree.set(nid, 0);
    adjacency.set(nid, []);
  }
  for (const nid of nodeIds) {
    for (const dep of nodes[nid].deps) {
      if (adjacency.has(dep)) {
        adjacency.get(dep)!.push(nid);
        inDegree.set(nid, (inDegree.get(nid) ?? 0) + 1);
      }
    }
  }

  const queue: NodeId[] = [];
  for (const nid of nodeIds) {
    if ((inDegree.get(nid) ?? 0) === 0) {
      queue.push(nid);
    }
  }

  const order: NodeId[] = [];
  while (queue.length > 0) {
    const nid = queue.shift()!;
    order.push(nid);
    for (const dep of adjacency.get(nid) ?? []) {
      const deg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, deg);
      if (deg === 0) {
        queue.push(dep);
      }
    }
  }

  // Append any nodes that remain in cycles (could not be reached).
  const sorted = nodeIds.filter((nid) => !order.includes(nid));
  order.push(...sorted);

  return order;
}

// ─── Top-level materialization ────────────────────────────────────────────────

/** Pure recursive deep clone with cycle detection.  Delegates to deepClone. */
function deepCloneNodes<T>(nodes: T): T {
  return deepClone(nodes);
}

/**
 * Materialize all omitted schemas in a cloned post-image of a TaskGraph.
 *
 * For each node, applies the frozen materialization table:
 * - task: preserve explicit graph slot input_schema; auto-resolve output
 * - llm: copies resolver input; canonical { text: string } output unless structured opts
 * - convert: derive input from upstream projections; construct output from assemble
 * - join: same as convert
 * - condition: pass through upstream
 * - checkpoint: reuse upstream input; handwritten output
 * - start: empty deps/slots; handwritten output
 * - end: handwritten input and output
 * - shell: preserve explicit; report SCHEMA_REQUIRED
 *
 * Deep-clones every selected or derived schema so successful materialization
 * pins snapshot data and ReplaceNode recomputes from replacement definition.
 */
export function materializeTaskGraphSchemas(
  taskgraph: TaskGraph,
  resolver: TaskGraphAutoSchemaResolver,
): {
  graph: TaskGraph;
  issues: MaterializationIssue[];
} {
  const issues: MaterializationIssue[] = [];
  const clonedNodes = deepCloneNodes(taskgraph.nodes);
  if (clonedNodes === CLONE_CYCLE_SENTINEL) {
    const sortedIds = Object.keys(taskgraph.nodes).sort();
    issues.push({
      nodeId: (sortedIds[0] ?? 'unknown') as NodeId,
      code: 'SCHEMA_INVALID' as const,
      message: `cyclic reference detected when cloning graph nodes; hostile explicit schemas cannot be materialized`,
    });
    return { graph: taskgraph, issues };
  }

  // Build post-image node-id set for SourceExpr resolution.
  const nodeIds = new Set(Object.keys(clonedNodes) as NodeId[]);

  // Build dep output schema map.
  const depOutputSchemas = new Map<NodeId, ObjectJsonSchema>();
  const depInputSchemas = new Map<NodeId, ObjectJsonSchema>();

  for (const node of Object.values(taskgraph.nodes)) {
    depOutputSchemas.set(node.id, node.output_schema);
    depInputSchemas.set(node.id, node.input_schema);
  }

  // Materialize each node in deterministic topological order.
  const materializeOrder = topologicalNodeOrder(clonedNodes);
  for (const nid of materializeOrder) {
    const node = clonedNodes[nid];
    if (!node) continue;
    const result = materializeNodeSchemas(
      node,
      depInputSchemas,
      depOutputSchemas,
      resolver,
      nodeIds,
    );

    // Pin materialized schemas.
    node.input_schema = result.inputSchema;
    node.output_schema = result.outputSchema;
    issues.push(...result.issues);

    // Update dep maps for downstream consumers.
    depOutputSchemas.set(node.id, result.outputSchema);
    depInputSchemas.set(node.id, result.inputSchema);
  }

  return {
    graph: {
      ...taskgraph,
      nodes: clonedNodes,
    },
    issues,
  };
}
