// ─── TaskGraph post-image validator ──────────────────────────────────────────
// Pure static validation: op preflight, structural constraints,
// schema materialization, wiring, and definition contract validation.
// No runtime-value validation.
//
// Returns the fully materialized post-image or an exhaustive sorted issue set.
// Never emits STALE_BASE or PATCH_NOT_FOUND (no lifecycle input).

import type {
  TaskGraph,
  TaskGraphNode,
  NodeId,
  PatchOperation,
  JsonObject,
  JsonValue,
  NodeRunStateType,
} from './model.mts';

import type { PatchErrorCode } from './contracts.mts';

import {
  materializeTaskGraphSchemas,
  type TaskGraphAutoSchemaResolver,
  type MaterializationIssue,
} from './materialize.mts';

import {
  parseSourceExpr,
  schemaAt,
  validateGraphSchema,
  compareTypes,
} from './schema-tools.mts';
import { validateConditionParams } from './condition.mts';
import { validateAnyJsonValue } from '../../workspace/schema-loader.mts';
import type { TaskGraphTaskContractResolver } from './task-contract-resolver.mts';
import type { JsonSchema } from '../../types.mts';

// ─── Public result types ──────────────────────────────────────────────────────

export interface OpFrozenDetail {
  category: 'op';
  op_index: number;
  node_id: NodeId;
  code: PatchErrorCode;
  message: string;
}

export interface WiringFrozenDetail {
  category: 'wiring';
  node_id: NodeId;
  slot: string;
  code: PatchErrorCode;
  message: string;
}

export interface GraphFrozenDetail {
  category: 'graph';
  node_ids: NodeId[];
  code: PatchErrorCode;
  message: string;
}

export type FrozenDetail = OpFrozenDetail | WiringFrozenDetail | GraphFrozenDetail;

export interface ValidationSuccess {
  graph: TaskGraph;
  issues: [];
}

export interface ValidationFailure {
  graph: null;
  issues: FrozenDetail[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

// ─── Private helpers ───────────────────────────────────────────────────────────

const INPUTS_RE = /^\$inputs\.(\w+)$/;

function deepCloneNodes(nodes: Record<NodeId, TaskGraphNode>, visited?: Set<object>): Record<NodeId, TaskGraphNode> {
  if (typeof nodes !== 'object' || nodes === null) return nodes;
  const vis = visited ?? new Set<object>();
  if (vis.has(nodes as object)) return nodes; // cycle detected — return original to avoid throw
  vis.add(nodes as object);
  const r: Record<string, unknown> = {};
  for (const k of Object.keys(nodes as Record<string, unknown>)) {
    const v = (nodes as Record<string, unknown>)[k];
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        const mapped = v.map((e) => {
          if (e !== null && typeof e === 'object') return deepCloneNodes(e as Record<NodeId, TaskGraphNode>, vis);
          return e;
        });
        Object.defineProperty(r, k, { value: mapped, writable: true, enumerable: true, configurable: true });
      } else {
        const cloned = deepCloneNodes(v as Record<NodeId, TaskGraphNode>, vis);
        Object.defineProperty(r, k, { value: cloned, writable: true, enumerable: true, configurable: true });
      }
    } else {
      Object.defineProperty(r, k, { value: v, writable: true, enumerable: true, configurable: true });
    }
  }
  return r as Record<NodeId, TaskGraphNode>;
}

/** Collect every `$inputs.<slot>` reference from a JSON subtree. */
function collectInputsRefs(value: JsonValue, refs: string[]): void {
  if (typeof value === 'string') {
    const m = INPUTS_RE.exec(value);
    if (m) refs.push(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectInputsRefs(v, refs);
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, JsonValue>;
    // A sole-key {const: ...} expression is an opaque literal —
    // do not recurse into its wrapped value, even if that value is a string
    // that happens to look like an $inputs reference.
    if (Object.hasOwn(obj, 'const') && Object.keys(obj).length === 1) return;
    for (const v of Object.values(obj)) {
      collectInputsRefs(v, refs);
    }
  }
}

/** Return true when a JSON value recursively contains any `$inputs.<slot>` reference. */
function containsInputsRef(value: unknown): boolean {
  if (typeof value === 'string') {
    return INPUTS_RE.test(value);
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (containsInputsRef(v)) return true;
    }
    return false;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // A sole-key {const: ...} expression is an opaque literal —
    // do not recurse into its wrapped value.
    if (Object.hasOwn(obj, 'const') && Object.keys(obj).length === 1) return false;
    for (const v of Object.values(obj)) {
      if (containsInputsRef(v)) return true;
    }
  }
  return false;
}

/**
 * Detect all unique cycles in the directed dependency graph exhaustively.
 * Every node is explored independently so no cycle is missed because a
 * node was previously marked visited through another path.
 * Each cycle is returned as a lexically-sorted list of node ids,
 * then deterministically deduplicated.
 */
function findAllCycles(nodes: Record<NodeId, TaskGraphNode>): NodeId[][] {
  const cycles: NodeId[][] = [];

  for (const nid of Object.keys(nodes).sort()) {
    const path: NodeId[] = [];
    const pathSet = new Set<NodeId>();

    function dfs(nodeId: NodeId): void {
      if (pathSet.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        const cycle = [...new Set(path.slice(cycleStart))].sort();
        cycles.push(cycle);
        return;
      }

      path.push(nodeId);
      pathSet.add(nodeId);

      const node = Object.hasOwn(nodes, nodeId) ? nodes[nodeId] : undefined;
      if (node) {
        for (const dep of node.deps) {
          dfs(dep);
        }
      }

      path.pop();
      pathSet.delete(nodeId);
    }

    dfs(nid);
  }

  // Deduplicate cycles deterministically.
  const seen = new Set<string>();
  return cycles.filter((c) => {
    const key = c.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isStartNode(node: TaskGraphNode): boolean {
  return node.action.type === 'start';
}

// ─── Error code sort key (position in PATCH_ERROR_CODES) ───────────────────────

import { PATCH_ERROR_CODES } from './contracts.mts';
const ERROR_CODE_ORDER = new Map<PatchErrorCode, number>(
  PATCH_ERROR_CODES.map((code, i) => [code, i]),
);

function errorCodePriority(code: PatchErrorCode): number {
  return ERROR_CODE_ORDER.get(code) ?? 999;
}

// ─── Materialization issue conversion ──────────────────────────────────────────

function matIssueToDetail(issue: MaterializationIssue): WiringFrozenDetail {
  return {
    category: 'wiring',
    node_id: issue.nodeId,
    slot: issue.slot ?? 'input',
    code: issue.code as PatchErrorCode,
    message: issue.message,
  };
}

// ─── Main validator ────────────────────────────────────────────────────────────

/**
 * Validate a set of ops against a current TaskGraph and produce either the
 * fully materialized post-image or an exhaustive, sorted issue array.
 *
 * @param current  Readonly current graph (never mutated).
 * @param ops      Sequence of AddNode / RemoveNode / ReplaceNode.
 * @param nodeStates  Optional per-node run state; absent nodes default to "planned".
 * @param resolver    Auto-schema resolver for graph/output materialization.
 * @param contractResolver  Optional task definition contract resolver
 *                          for definition payload validation (B7).
 * @param project   Required project context for definition contract resolution.
 *
 * @note Apply-time responsibilities outside this pure validator:
 *   - Successful apply must reset materially edited planned/failed nodes to planned
 *     and clear their error, output, and current execution binding.
 *   - Patch apply does not auto-resume the graph.
 */
export function validateTaskGraphPostImage(
  current: Readonly<TaskGraph>,
  ops: readonly PatchOperation[],
  nodeStates: Readonly<Record<NodeId, NodeRunStateType>> | undefined,
  resolver: TaskGraphAutoSchemaResolver,
  contractResolver?: TaskGraphTaskContractResolver,
  project?: string,
): ValidationResult {
  const issues: FrozenDetail[] = [];

  // ── Step 1: Clone current graph ────────────────────────────────────────────
  const clonedNodes = deepCloneNodes(current.nodes);

  // ── Step 2: Preflight op-level rules ───────────────────────────────────────
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];

    switch (op.op) {
      case 'AddNode': {
        const targetId = op.node.id;
        if (Object.hasOwn(clonedNodes, targetId)) {
          issues.push({
            category: 'op',
            op_index: i,
            node_id: targetId,
            code: 'DUP_ID',
            message: `node id "${targetId}" already exists in graph`,
          });
        } else {
          Object.defineProperty(clonedNodes, targetId, {
            value: op.node as TaskGraphNode,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        break;
      }

      case 'RemoveNode': {
        const targetId = op.id;
        const currentState = nodeStates && Object.hasOwn(nodeStates, targetId) ? nodeStates[targetId] : 'planned';
        if (Object.hasOwn(current.nodes, targetId) && currentState !== 'planned' && currentState !== 'failed') {
          issues.push({
            category: 'op',
            op_index: i,
            node_id: targetId,
            code: 'FROZEN_NODE',
            message: `cannot remove node "${targetId}" in state "${currentState}"`,
          });
          // Leave node unchanged in the effective image.
        } else {
          delete clonedNodes[targetId];
        }
        break;
      }

      case 'ReplaceNode': {
        const targetId = op.node.id;
        const currentState = nodeStates && Object.hasOwn(nodeStates, targetId) ? nodeStates[targetId] : 'planned';
        if (Object.hasOwn(current.nodes, targetId) && currentState !== 'planned' && currentState !== 'failed') {
          issues.push({
            category: 'op',
            op_index: i,
            node_id: targetId,
            code: 'FROZEN_NODE',
            message: `cannot replace node "${targetId}" in state "${currentState}"`,
          });
          // Leave node unchanged in the effective image.
        } else {
          Object.defineProperty(clonedNodes, targetId, {
            value: op.node as TaskGraphNode,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        break;
      }
    }
  }

  // ── Step 3: Build post-image scaffold ──────────────────────────────────────
  const postImage: TaskGraph = {
    id: current.id,
    revision: current.revision,
    ...(current.tg_ctx ? { tg_ctx: current.tg_ctx } : {}),
    nodes: clonedNodes,
  };

  // ── Step 4: Structural validation ──────────────────────────────────────────
  const nodeIds = Object.keys(clonedNodes);
  const nodeIdSet = new Set(nodeIds);

  // 4a. Exactly one start node.
  const startNodes = nodeIds.filter((nid) => isStartNode(clonedNodes[nid]));
  if (startNodes.length === 0) {
    issues.push({
      category: 'graph',
      node_ids: [],
      code: 'SCHEMA_INVALID',
      message: 'graph must have exactly one start node; none found',
    });
  } else if (startNodes.length > 1) {
    issues.push({
      category: 'graph',
      node_ids: [...startNodes].sort(),
      code: 'SCHEMA_INVALID',
      message: 'graph must have exactly one start node',
    });
  }

  // 4b. Start node constraints.
  for (const snid of startNodes) {
    const sn = clonedNodes[snid];
    if (sn.deps.length > 0) {
      issues.push({
        category: 'graph',
        node_ids: [snid],
        code: 'SCHEMA_INVALID',
        message: `start node "${snid}" must have empty deps`,
      });
    }
    if (sn.input.length > 0) {
      issues.push({
        category: 'graph',
        node_ids: [snid],
        code: 'SCHEMA_INVALID',
        message: `start node "${snid}" must have empty input slots`,
      });
    }
  }

  // 4c. Per-type structural constraints.
  for (const nid of nodeIds) {
    const node = clonedNodes[nid];

    if (node.action.type === 'convert' && node.deps.length !== 1) {
      issues.push({
        category: 'graph',
        node_ids: [nid],
        code: 'SCHEMA_INVALID',
        message: `convert node "${nid}" must have exactly one dependency`,
      });
    }

    if (node.action.type === 'join' && node.deps.length < 2) {
      issues.push({
        category: 'graph',
        node_ids: [nid],
        code: 'SCHEMA_INVALID',
        message: `join node "${nid}" must have at least two dependencies`,
      });
    }
  }

  // 4d. Every declared dependency must exist.
  for (const nid of nodeIds) {
    const node = clonedNodes[nid];
    for (const depId of node.deps) {
      if (!nodeIdSet.has(depId)) {
        const related = [nid, depId].sort();
        issues.push({
          category: 'graph',
          node_ids: related,
          code: 'DANGLING_DEP',
          message: `node "${nid}" depends on "${depId}" which does not exist`,
        });
      }
    }
  }

  // 4e. Dependency graph must be acyclic.
  const cycles = findAllCycles(clonedNodes);
  for (const cycle of cycles) {
    issues.push({
      category: 'graph',
      node_ids: cycle,
      code: 'CYCLE',
      message: `dependency cycle: ${cycle.join(' -> ')}`,
    });
  }

  // 4f. Condition rules are a closed declarative AST and every branch is a
  // downstream node id that declares the condition as a dependency (D55-D56).
  for (const nid of nodeIds) {
    const node = clonedNodes[nid];
    if (node.action.type !== 'condition') continue;
    for (const issue of validateConditionParams(postImage, nid, node.action.params)) {
      issues.push({
        category: 'wiring',
        node_id: nid,
        slot: `action.params.${issue.path}`,
        code: 'SCHEMA_INVALID',
        message: issue.message,
      });
    }
  }

  // 4g. Schema materialization — validates explicit/inferred schemas, SourceExpr
  // parsing, upstream projections, and resolver conflicts.
  const materialized = materializeTaskGraphSchemas(postImage, resolver);
  for (const matIssue of materialized.issues) {
    issues.push(matIssueToDetail(matIssue));
  }

  // 4h. Validate every materialized node schema structurally.
  //     Rejects malformed, untyped, boolean, any, or unknown schema fragments.
  const materializedNodes = materialized.graph.nodes;
  for (const nid of nodeIds) {
    const matNode = materializedNodes[nid];
    if (!matNode) continue;
    const schemaIssues: { slot: string; path: string; message: string }[] = [];
    for (const { schema, slot } of [
      { schema: matNode.input_schema as JsonObject, slot: 'input' },
      { schema: matNode.output_schema as JsonObject, slot: 'output' },
    ]) {
      // Root schema must be type:"object".  Primitive, boolean, or null roots
      // are forbidden — only nested child schemas may carry primitive types.
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        schemaIssues.push({ slot, path: `${nid}.${slot}_schema`, message: 'root schema must be a JSON object; boolean/primitive root schemas are forbidden' });
        continue;
      }
      if (schema.type !== 'object') {
        schemaIssues.push({ slot, path: `${nid}.${slot}_schema`, message: `root schema must have type \"object\", got "${String(schema.type)}"` });
        // Fall through to validateGraphSchema — child subschema failures
        // are still independently provable even when the parent type is wrong.
      }
      for (const si of validateGraphSchema(schema, `${nid}.${slot}_schema`)) {
        schemaIssues.push({ slot, path: si.path, message: si.message });
      }
    }
    for (const si of schemaIssues) {
      issues.push({
        category: 'wiring',
        node_id: nid,
        slot: si.slot,
        code: 'SCHEMA_INVALID',
        message: `[${si.path}] ${si.message}`,
      });
    }
  }

  // 4h. Additional wiring checks beyond materialization:
  //     - each source node must be in deps
  //     - $inputs.<slot> reference validation
  //     - required input coverage
  for (const nid of nodeIds) {
    const node = clonedNodes[nid];

    // Build slot -> projected schema map for this node.
    const slotSchemas = new Map<string, JsonObject>();
    for (const inp of node.input) {
      const parsed = parseSourceExpr(inp.source, nodeIdSet);
      if (!parsed) {
        issues.push({
          category: 'wiring',
          node_id: nid,
          slot: inp.name,
          code: 'MAP_PATH_UNKNOWN',
          message: `cannot parse source expression "${inp.source}" for slot "${inp.name}"`,
        });
        continue;
      }

      // Source node must be in deps.
      if (!node.deps.includes(parsed.nodeId)) {
        issues.push({
          category: 'wiring',
          node_id: nid,
          slot: inp.name,
          code: 'MAP_NOT_IN_DEPS',
          message: `source "${inp.source}" references node "${parsed.nodeId}" which is not in dependencies of "${nid}"`,
        });
      }

      if (!Object.hasOwn(materializedNodes, parsed.nodeId)) {
        issues.push({
          category: 'wiring',
          node_id: nid,
          slot: inp.name,
          code: 'MAP_PATH_UNKNOWN',
          message: `source node "${parsed.nodeId}" not found in materialized graph for slot "${inp.name}"`,
        });
      } else {
        const sourceNode = materializedNodes[parsed.nodeId];
        const projected = schemaAt(sourceNode.output_schema as JsonObject, parsed.projection);
        if (projected.found) {
          slotSchemas.set(inp.name, projected.schema);
        } else {
          issues.push({
            category: 'wiring',
            node_id: nid,
            slot: inp.name,
            code: 'MAP_PATH_UNKNOWN',
            message: `projection failed for slot "${inp.name}": ${projected.reason}`,
          });
        }
      }
    }

    const matNode = materialized.graph.nodes[nid];

    // Compare each projected slot schema against the materialized destination
    // input schema field.  Emit MAP_TYPE_MISMATCH on incompatibility.
    const matInputSchema = matNode?.input_schema as JsonObject | undefined;
    if (matInputSchema && matInputSchema.properties) {
      const matProps = matInputSchema.properties as Record<string, JsonObject>;
      for (const [slotName, slotSchema] of slotSchemas) {
        if (!Object.hasOwn(matProps, slotName)) continue;
        const destField = matProps[slotName];
        const typeResult = compareTypes(slotSchema, destField);
        if (!typeResult.match) {
          issues.push({
            category: 'wiring',
            node_id: nid,
            slot: slotName,
            code: 'MAP_TYPE_MISMATCH',
            message: `source schema for slot "${slotName}" incompatible with materialized input: ${typeResult.details}`,
          });
        }
      }
    }

    // Collect every `$inputs.<slot>` reference from action params and assemble.
    const paramsRefs: string[] = [];
    collectInputsRefs(node.action.params as JsonValue, paramsRefs);

    const assemble = node.action.params.assemble as Record<string, JsonValue> | undefined;
    const assembleRefs: string[] = [];
    if (assemble) {
      collectInputsRefs(assemble as JsonValue, assembleRefs);
    }

    // Check that every $inputs.<slot> reference targets an existing slot.
    const allRefs = [...new Set([...paramsRefs, ...assembleRefs])];
    for (const slotName of allRefs) {
      if (!slotSchemas.has(slotName)) {
        issues.push({
          category: 'wiring',
          node_id: nid,
          slot: slotName,
          code: 'INPUT_INCOMPLETE',
          message: `input slot "${slotName}" referenced but not defined on node "${nid}"`,
        });
      }
    }

    // Check that every required field in the materialized input schema is covered
    // by either a declared input slot or a top-level action param property.
    // The materialized schema's `required` array is the SSOT — declared slots
    // satisfy coverage without needing a separate $inputs reference, and
    // literal/config params also cover the field. Assemble outputs are not
    // counted as input coverage.
    const matRequired = matNode?.input_schema?.required;
    if (Array.isArray(matRequired)) {
      for (const field of matRequired) {
        const coveredBySlot = node.input.some((inp) => inp.name === field);
        const coveredByParam = Object.hasOwn(node.action.params as Record<string, unknown>, field);
        if (!coveredBySlot && !coveredByParam) {
          issues.push({
            category: 'wiring',
            node_id: nid,
            slot: field,
            code: 'INPUT_INCOMPLETE',
            message: `required input field "${field}" on node "${nid}" is not provided via input slots or action params`,
          });
        }
      }
    }
  }

  // ── Step 4i: Definition contract validation (B7) ──────────────────────────
  // Validate task action.params.input against the resolved definition
  // input schema, but only for successful final AddNode/ReplaceNode ledger entries.
  // Do not inspect failed ops, removed nodes, frozen/rejected replacements,
  // or dereference/mutate caller-owned op nodes.
  if (contractResolver && project) {
    const survivingTaskNodes = new Set<NodeId>();

    if (ops.length === 0) {
      // Direct post-image/create fixture validation (no ops): validate all
      // task nodes present in the cloned post-image.
      for (const nid of nodeIds) {
        const node = clonedNodes[nid];
        if (node && node.action.type === 'task') {
          survivingTaskNodes.add(nid);
        }
      }
    } else {
      for (const op of ops) {
        if (op.op === 'AddNode' || op.op === 'ReplaceNode') {
          const nid = op.node.id;
          // Check this op succeeded (no FROZEN_NODE, no DUP_ID for AddNode)
          const isFrozen = nodeStates && Object.hasOwn(current.nodes, nid) &&
            nodeStates[nid] !== 'planned' && nodeStates[nid] !== 'failed';
          const isDupAdd = op.op === 'AddNode' && Object.hasOwn(current.nodes, nid);
          if (!isFrozen && !isDupAdd) {
            survivingTaskNodes.add(nid);
          }
        }
      }
    }

    for (const nid of survivingTaskNodes) {
      const node = clonedNodes[nid] as TaskGraphNode | undefined;
      if (!node) continue;
      const actionType = node.action.type;
      if (actionType !== 'task') continue;

      const params = node.action.params as Record<string, unknown>;
      const name = typeof params.name === 'string' && params.name.trim() ? params.name : undefined;
      if (!name) {
        issues.push({
          category: 'wiring',
          node_id: nid,
          slot: 'action.params.name',
          code: 'SCHEMA_INVALID',
          message: `node "${nid}": missing or non-string definition name in action params`,
        });
        continue;
      }

      const actionProject = typeof params.project === 'string' && params.project.trim() ? params.project : undefined;
      if (!actionProject) {
        issues.push({
          category: 'wiring',
          node_id: nid,
          slot: 'action.params.project',
          code: 'SCHEMA_INVALID',
          message: `node "${nid}": missing or non-string project in action params`,
        });
        continue;
      }

      const resolvedContract = contractResolver.resolveDefinitionContract(actionType, name, actionProject);
      if (resolvedContract === undefined) continue; // Validation disabled/skip
      if (resolvedContract === null) {
        // Placeholder task nodes (notably closeout `deploy`) omit params.input
        // so authors can ReplaceNode later. Supplying input still fail-closes.
        const rawInput = Object.hasOwn(params, 'input') ? params.input : undefined;
        if (name === 'deploy' && rawInput === undefined) {
          continue;
        }
        issues.push({
          category: 'wiring',
          node_id: nid,
          slot: 'action.params.name',
          code: 'SCHEMA_INVALID',
          message: `node "${nid}": definition "${name}" not found for project "${actionProject}"`,
        });
        continue;
      }

      if (resolvedContract.scheduling === 'legacy') {
        issues.push({
          category: 'wiring',
          node_id: nid,
          slot: 'action.params.name',
          code: 'SCHEMA_INVALID',
          message: `node "${nid}": definition "${name}" is legacy-only and cannot be added to new work; compose atomic edit and test tasks instead`,
        });
      }

      const defInputSchema = resolvedContract.input;
      if (!defInputSchema) continue; // No input contract to validate against.

      const rawInput = Object.hasOwn(params, 'input') ? params.input : undefined;

      // When params.input is a sole-key {const: ...}, treat as opaque literal
      // consistent with existing semantics — skip payload validation.
      if (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
        const inputObj = rawInput as Record<string, unknown>;
        if (Object.hasOwn(inputObj, 'const') && Object.keys(inputObj).length === 1) {
          continue;
        }
      }

      // If params.input recursively contains any real $inputs reference,
      // defer payload validation to runtime/TaskService.
      if (rawInput !== undefined && rawInput !== null) {
        const hasInputsRef = containsInputsRef(rawInput);
        if (!hasInputsRef) {
          // Pure literal — validate now.
          const validation = validateAnyJsonValue(defInputSchema as any, rawInput);
          if (!validation.valid) {
            for (const err of validation.errors) {
              issues.push({
                category: 'wiring',
                node_id: nid,
                slot: 'action.params.input',
                code: 'SCHEMA_INVALID',
                message: `node "${nid}" definition "${name}" input validation: ${err}`,
              });
            }
          }
        }
        // If $inputs reference exists, defer — no validation at write time.
      }
    }
  }

  // ── Step 5: If any issues exist, return null graph with deduplicated/sorted issues ──
  if (issues.length > 0) {
    // Deduplicate identical issues.
    const seen = new Set<string>();
    const uniqueIssues: FrozenDetail[] = [];

    for (const issue of issues) {
      let key: string;
      switch (issue.category) {
        case 'op':
          key = `op:${issue.op_index}:${issue.node_id}:${issue.code}`;
          break;
        case 'wiring':
          key = `wiring:${issue.node_id}:${issue.slot}:${issue.code}:${issue.message}`;
          break;
        case 'graph':
          key = `graph:${[...issue.node_ids].sort().join(',')}:${issue.code}:${issue.message}`;
          break;
      }
      if (!seen.has(key)) {
        seen.add(key);
        uniqueIssues.push(issue);
      }
    }

    // Sort: category (op → wiring → graph), then secondary keys.
    const CAT_ORDER: Record<string, number> = { op: 0, wiring: 1, graph: 2 };

    uniqueIssues.sort((a, b) => {
      // Primary: category
      const catDiff = CAT_ORDER[a.category] - CAT_ORDER[b.category];
      if (catDiff !== 0) return catDiff;

      // Secondary: within same category
      if (a.category === 'op' && b.category === 'op') {
        if (a.op_index !== b.op_index) return a.op_index - b.op_index;
        const nc = String(a.node_id).localeCompare(String(b.node_id));
        if (nc !== 0) return nc;
        const pc = errorCodePriority(a.code) - errorCodePriority(b.code);
        if (pc !== 0) return pc;
        return String(a.message).localeCompare(String(b.message));
      }

      if (a.category === 'wiring' && b.category === 'wiring') {
        const nc = String(a.node_id).localeCompare(String(b.node_id));
        if (nc !== 0) return nc;
        const sc = String(a.slot).localeCompare(String(b.slot));
        if (sc !== 0) return sc;
        const pc = errorCodePriority(a.code) - errorCodePriority(b.code);
        if (pc !== 0) return pc;
        return String(a.message).localeCompare(String(b.message));
      }

      if (a.category === 'graph' && b.category === 'graph') {
        const idsA = [...a.node_ids].sort().join(',');
        const idsB = [...b.node_ids].sort().join(',');
        const ic = String(idsA).localeCompare(String(idsB));
        if (ic !== 0) return ic;
        const pc = errorCodePriority(a.code) - errorCodePriority(b.code);
        if (pc !== 0) return pc;
        return String(a.message).localeCompare(String(b.message));
      }

      return 0;
    });

    return { graph: null, issues: uniqueIssues };
  }

  // ── Step 6: Return fully materialized clone on success ─────────────────────
  return { graph: materialized.graph, issues: [] };
}
