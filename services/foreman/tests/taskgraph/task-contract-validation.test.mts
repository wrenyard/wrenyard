/**
 * task-contract-validation.test.mts — B7 definition contract validation.
 *
 * Exercises workspace-registry-backed task definition contract
 * validation for: create, request_patch preview, confirm_patch revalidation;
 * missing name/id and missing project; array-root literal pass/fail;
 * nested/array $inputs template deferral; errors identify node, definition id,
 * instance/schema path; graph slot schema is never subset-compared and does not
 * emit MAP_TYPE_MISMATCH/TypeError; resolver registry discovery.
 *
 * Post-image ledger semantics: duplicate Add, frozen Replace, Add then Remove,
 * Replace then Remove, and failed ops are not contract-dereferenced or mutated.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  TaskGraph,
  TaskGraphNode,
  TaskGraphTaskContractResolver,
  ResolvedDefinitionContract,
  NodeId,
  NodeRunStateType,
  JsonObject,
  ObjectJsonSchema,
  PatchOperation,
  FrozenDetail,
  WiringFrozenDetail,
} from '../../lib/core/taskgraph/index.mts'

import {
  validateTaskGraphPostImage,
  NULL_CONTRACT_RESOLVER,
} from '../../lib/core/taskgraph/index.mts'
import { makeResolver, emptyGraph, startNode, taskNode, endNode } from './validator-helpers.mts'
import diagnoseReproTask from '../../lib/standard/tasks/diagnose-repro.mts'
import { normalizeSchema } from '../../lib/workspace/schema-loader.mts'

// ─── Fake contract resolver ───────────────────────────────────────────────────

class FakeContractResolver implements TaskGraphTaskContractResolver {
  private readonly contracts = new Map<string, { input: unknown; scheduling?: 'active' | 'legacy' }>()

  /** Register a definition with an optional input schema. */
  setContract(
    kind: 'task',
    name: string,
    project: string,
    inputSchema?: unknown,
    scheduling?: 'active' | 'legacy',
  ): void {
    const key = `${kind}:${project}:${name}`
    this.contracts.set(key, { input: inputSchema, ...(scheduling ? { scheduling } : {}) })
  }

  resolveDefinitionContract(
    kind: 'task',
    name: string,
    project: string,
  ): ResolvedDefinitionContract | null {
    const key = `${kind}:${project}:${name}`
    if (!this.contracts.has(key)) return null
    return {
      definitionId: name,
      kind,
      project,
      input: this.contracts.get(key)!.input as any,
      ...(this.contracts.get(key)!.scheduling
        ? { scheduling: this.contracts.get(key)!.scheduling }
        : {}),
    }
  }
}

// ─── Graph model helpers ──────────────────────────────────────────────────────

function objectSchema(
  properties: Record<string, JsonObject>,
  required = Object.keys(properties),
): TaskGraphNode['input_schema'] {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

/** Narrowing guard: only WiringFrozenDetail carries node_id + slot. */
function isWiringDetail(d: FrozenDetail): d is WiringFrozenDetail {
  return d.category === 'wiring'
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('B7 definition contract validation (task-contract-resolver)', () => {

  // ── Create-time validation ────────────────────────────────────────────────

  it('rejects legacy-only tasks when a new graph adds them', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'implement', 'test-project', {
      type: 'object',
      additionalProperties: true,
    }, 'legacy')

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      implementation: taskNode('implementation', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'implement', project: 'test-project', input: {} },
        },
      }),
      end: endNode('end', {
        deps: ['implementation'],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((issue) =>
      issue.category === 'wiring'
      && issue.node_id === 'implementation'
      && issue.message.includes('legacy-only')))
  })

  it('allows a missing deploy definition when params.input is omitted', () => {
    const contractResolver = new FakeContractResolver()
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      deploy: taskNode('deploy', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'deploy', project: 'test-project' },
        },
      }),
      end: endNode('end', {
        deps: ['deploy'],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.ok(result.graph !== null, JSON.stringify(result.issues))
    assert.equal(result.issues.length, 0)
  })

  it('rejects a missing deploy definition when params.input is present', () => {
    const contractResolver = new FakeContractResolver()
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      deploy: taskNode('deploy', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'deploy', project: 'test-project', input: {} },
        },
      }),
      end: endNode('end', {
        deps: ['deploy'],
        input_schema: { type: 'object', properties: {} },
        output_schema: { type: 'object', properties: {} },
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((issue) =>
      issue.category === 'wiring'
      && issue.node_id === 'deploy'
      && issue.message.includes('definition "deploy" not found')))
  })

  it('validates a task literal input against definition schema at create', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'my-task', 'test-project', {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'my-task', project: 'test-project', input: { name: 'hello' } },
        },
        input_schema: objectSchema({ dummy: { type: 'string' } }, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.ok(result.graph !== null, 'valid literal input should pass')
    assert.equal(result.issues.length, 0)
  })

  it('rejects a task literal input that fails definition schema at create', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'my-task', 'test-project', {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'my-task', project: 'test-project', input: { age: 42 } },
        },
        input_schema: objectSchema({ dummy: { type: 'string' } }, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    const contractIssues = result.issues.filter(isWiringDetail).filter((i) => i.node_id === 't' && i.slot === 'action.params.input')
    assert.ok(contractIssues.length > 0, 'should report input validation failure')
    assert.ok(contractIssues[0].message.includes("my-task"), 'message should include definition id')
  })

  it('defers validation when params.input contains $inputs references', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'my-task', 'test-project', {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: objectSchema({ someSlot: { type: 'string' } }, ['someSlot']),
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'someSlot', source: 'start.someSlot' }],
        action: {
          type: 'task',
          params: { name: 'my-task', project: 'test-project', input: { name: '$inputs.someSlot' } },
        },
        input_schema: objectSchema({ someSlot: { type: 'string' } }, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    // $inputs template — must defer, no SCHEMA_INVALID for input validation
    assert.ok(result.graph !== null, 'template input should defer validation')
  })

  // ── Array-root contract ───────────────────────────────────────────────────

  it('validates an array-root task input against array-root definition schema', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'arr-task', 'test-project', {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'arr-task', project: 'test-project', input: [{ id: 'a' }, { id: 'b' }] },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.ok(result.graph !== null, 'valid array literal input should pass')
  })

  it('rejects an array-root task literal input that fails array schema', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'arr-task', 'test-project', {
      type: 'array',
      items: { type: 'number' },
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'arr-task', project: 'test-project', input: ['not-a-number'] },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    assert.ok(result.issues.some((i) => i.code === 'SCHEMA_INVALID'), 'should fail array validation')
  })

  // ── Graph slot schema is never subset-compared ────────────────────────────

  it('does not emit MAP_TYPE_MISMATCH when definition contract differs from graph slot schema', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'no-match', 'test-project', {
      type: 'object',
      properties: { arrField: { type: 'array', items: { type: 'string' } } },
      required: ['arrField'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', { output_schema: objectSchema({ msg: { type: 'string' } }, ['msg']) }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'msg', source: 'start.msg' }],
        action: {
          type: 'task',
          params: { name: 'no-match', project: 'test-project', input: { arrField: ['val'] } },
        },
        // Graph slot schema says msg is string, but definition contract says arrField is array
        input_schema: objectSchema({ msg: { type: 'string' } }, ['msg']),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    // The graph slot schema should NOT be subset-compared with definition input schema.
    // MAP_TYPE_MISMATCH from graph wiring (slot vs materialized input) is still possible,
    // but not from definition contract comparison.
    const mapTypeMismatch = result.graph
      ? []
      : result.issues.filter((i) => i.code === 'MAP_TYPE_MISMATCH')
    if (mapTypeMismatch.length > 0) {
      // Any MAP_TYPE_MISMATCH must come from wiring, not from definition contracts
      for (const issue of mapTypeMismatch) {
        assert.ok(!issue.message.includes('definition'),
          `MAP_TYPE_MISMATCH should not be about definition contracts: ${issue.message}`)
      }
    }
  })

  // ── Patch-time validation ─────────────────────────────────────────────────

  it('validates definition payload at request_patch preview', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'patch-task', 'test-project', {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
    }

    const patch: PatchOperation[] = [{
      op: 'AddNode',
      node: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'patch-task', project: 'test-project', input: { value: 42 } },
        },
        input_schema: objectSchema({}, []),
      }),
    }]

    const result = validateTaskGraphPostImage(
      graph, patch, undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.ok(result.graph !== null, 'valid patch input should pass')
  })

  it('rejects definition payload at request_patch when input is invalid', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'patch-task', 'test-project', {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
    }

    const patch: PatchOperation[] = [{
      op: 'AddNode',
      node: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'patch-task', project: 'test-project', input: { value: 'not-a-number' } },
        },
        input_schema: objectSchema({}, []),
      }),
    }]

    const result = validateTaskGraphPostImage(
      graph, patch, undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    const inputIssues = result.issues.filter(isWiringDetail).filter((i) => i.slot === 'action.params.input')
    assert.ok(inputIssues.length > 0, 'should report input validation failure at patch time')
  })

  it('confirm_patch revalidates stored patch with same contract rules', () => {
    // confirm_patch calls the same validateTaskGraphPostImage — coverage is implicit.
    // This test proves the revalidation path works by transferring a patch scenario
    // identical to request_patch through validateTaskGraphPostImage.
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'reval-task', 'test-project', {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
    }

    const patch: PatchOperation[] = [{
      op: 'AddNode',
      node: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'reval-task', project: 'test-project', input: { ok: true } },
        },
        input_schema: objectSchema({}, []),
      }),
    }]

    const firstPass = validateTaskGraphPostImage(
      graph, patch, undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.ok(firstPass.graph !== null, 'first pass should succeed')

    // Re-validate with same base graph and ops (simulating confirm revalidation)
    const secondPass = validateTaskGraphPostImage(
      graph, patch, undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.ok(secondPass.graph !== null, 'revalidation should also succeed')
  })

  // ── Missing name/id/project ───────────────────────────────────────────────

  it('reports missing name in action params', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: { type: 'task', params: { project: 'test-project', input: {} } },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), new FakeContractResolver(), 'test-project',
    )
    assert.equal(result.graph, null)
    const nameIssues = result.issues.filter((i) => i.message.includes('missing'))
    assert.ok(nameIssues.length > 0, 'should report missing name')
  })

  it('reports unknown definition (not found in registry)', () => {
    const contractResolver = new FakeContractResolver()
    // No contract registered for 'unknown-task'

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'unknown-task', project: 'test-project', input: {} },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    const notFoundIssues = result.issues.filter((i) => i.message.includes('not found'))
    assert.ok(notFoundIssues.length > 0, 'should report definition not found')
  })

  it('reports missing project in action params', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: { type: 'task', params: { name: 'some-task', input: {} } },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), new FakeContractResolver(), 'test-project',
    )
    assert.equal(result.graph, null)
    const projectIssues = result.issues.filter((i) => i.message.includes('project'))
    assert.ok(projectIssues.length > 0, 'should report missing project')
    assert.ok(projectIssues.filter(isWiringDetail).some((i) => i.slot === 'action.params.project'),
      'should report missing project at action.params.project slot')
  })

  // ── Sole-key {const: ...} opaque literal ──────────────────────────────────

  it('preserves sole-key {const: ...} as opaque literal, does not validate', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'const-task', 'test-project', {
      type: 'object',
      properties: { val: { type: 'string' } },
      required: ['val'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'const-task', project: 'test-project', input: { const: '$inputs.x' } },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    // {const: '$inputs.x'} is sole-key — treated as opaque literal, not validated.
    assert.ok(result.graph !== null, 'sole-key const should pass without validation')
  })

  // ── Post-image ledger semantics: no mutation, no deref of failed/frozen ───

  it('does not contract-dereference a duplicate Add node', () => {
    const contractResolver = new FakeContractResolver()
    // No contract registered — would fail if dereferenced

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', { deps: ['start'] }),
    }

    const patch: PatchOperation[] = [{ op: 'AddNode', node: taskNode('t') }] // DUP_ID

    const result = validateTaskGraphPostImage(
      graph, patch, undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    // Should have DUP_ID for 't', but no SCHEMA_INVALID for definition not found
    // because the duplicate node is not contract-dereferenced.
    const dupIssues = result.issues.filter((i) => i.code === 'DUP_ID')
    assert.ok(dupIssues.length > 0, 'should report DUP_ID')
    const defNotFoundIssues = result.issues.filter((i) => i.message.includes('not found'))
    assert.equal(defNotFoundIssues.length, 0, 'should not dereference duplicate node')
  })

  it('does not contract-dereference a frozen Replace node', () => {
    const contractResolver = new FakeContractResolver()
    // No contract registered — would fail if dereferenced

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', { deps: ['start'] }),
    }

    const patch: PatchOperation[] = [{ op: 'ReplaceNode', node: taskNode('t') }]

    const result = validateTaskGraphPostImage(
      graph, patch, { t: 'running' }, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    // Should have FROZEN_NODE for 't', but no SCHEMA_INVALID for definition not found
    const frozenIssues = result.issues.filter((i) => i.code === 'FROZEN_NODE')
    assert.ok(frozenIssues.length > 0, 'should report FROZEN_NODE')
    const defNotFoundIssues = result.issues.filter((i) => i.message.includes('not found'))
    assert.equal(defNotFoundIssues.length, 0, 'should not dereference frozen replacement node')
  })

  it('does not dereference or mutate caller-owned op nodes', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'safe-task', 'test-project', {
      type: 'object',
      properties: { val: { type: 'string' } },
      required: ['val'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
    }

    const originalOp: PatchOperation = {
      op: 'AddNode',
      node: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'safe-task', project: 'test-project', input: { val: 'ok' } },
        },
        input_schema: objectSchema({}, []),
      }),
    }
    const originalJson = JSON.stringify(originalOp)

    const _result = validateTaskGraphPostImage(
      graph, [originalOp], undefined, makeResolver(), contractResolver, 'test-project',
    )

    // Original op must be unchanged
    assert.equal(JSON.stringify(originalOp), originalJson, 'caller-owned op must not be mutated')
  })

  // ── Error shape: node, definition id, instance/schema path ────────────────

  it('error message includes definition id and instance/schema path', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'strict-task', 'test-project', {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'strict-task', project: 'test-project', input: { x: 42 } },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.equal(result.graph, null)
    const issue = result.issues.filter(isWiringDetail).find((i) => i.node_id === 't' && i.slot === 'action.params.input')
    assert.ok(issue, 'should have input validation issue')
    assert.ok(issue.message.includes('strict-task'), 'message should contain definition id')
    assert.ok(issue.message.includes('/x'), 'message should contain instance path')
  })


  // ── Source graph immutability ─────────────────────────────────────────────

  it('does not mutate source graph or patch objects after validation', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'immu-task', 'test-project', {
      type: 'object',
      properties: { val: { type: 'string' } },
      required: ['val'],
    })

    const sourceGraph = emptyGraph()
    sourceGraph.nodes = {
      start: startNode('start'),
    }
    const frozenGraph = JSON.parse(JSON.stringify(sourceGraph)) as TaskGraph

    const patch: PatchOperation[] = [{
      op: 'AddNode',
      node: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'immu-task', project: 'test-project', input: { val: 'ok' } },
        },
        input_schema: objectSchema({}, []),
      }),
    }]
    const frozenPatch = JSON.parse(JSON.stringify(patch)) as PatchOperation[]

    validateTaskGraphPostImage(
      sourceGraph, patch, undefined, makeResolver(), contractResolver, 'test-project',
    )

    assert.deepEqual(sourceGraph, frozenGraph, 'source graph must not be mutated')
    assert.deepEqual(patch, frozenPatch, 'patch ops must not be mutated')
  })

  // ── No contract resolver (NULL_CONTRACT_RESOLVER) ─────────────────────────

  it('skips contract validation when no contract resolver is provided', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'missing-def', project: 'test', input: { bad: 'data' } },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    // No contract resolver — validation should pass (no definition checking)
    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), undefined, 'test',
    )
    assert.ok(result.graph !== null, 'should pass without contract resolver')
  })

  it('skips contract validation with NULL_CONTRACT_RESOLVER', () => {
    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: { name: 'any-task', project: 'test', input: { x: 1 } },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), NULL_CONTRACT_RESOLVER, 'test',
    )
    assert.ok(result.graph !== null, 'should pass with NULL_CONTRACT_RESOLVER')
  })

  // ── Nested/array $inputs template deferral ────────────────────────────────

  it('defers validation when params.input is nested object with $inputs refs', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'nested-task', 'test-project', {
      type: 'object',
      properties: { nested: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] } },
      required: ['nested'],
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: objectSchema({ slot: { type: 'string' } }, ['slot']),
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'slot', source: 'start.slot' }],
        action: {
          type: 'task',
          params: { name: 'nested-task', project: 'test-project', input: { nested: { val: '$inputs.slot' } } },
        },
        input_schema: objectSchema({ slot: { type: 'string' } }, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.ok(result.graph !== null, 'nested $inputs should defer validation')
  })

  it('defers validation when params.input is an array containing $inputs refs', () => {
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'arr-task', 'test-project', {
      type: 'array',
      items: { type: 'string' },
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start', {
        output_schema: objectSchema({ slot: { type: 'string' } }, ['slot']),
      }),
      t: taskNode('t', {
        deps: ['start'],
        input: [{ name: 'slot', source: 'start.slot' }],
        action: {
          type: 'task',
          params: { name: 'arr-task', project: 'test-project', input: ['$inputs.slot'] },
        },
        input_schema: objectSchema({ slot: { type: 'string' } }, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, makeResolver(), contractResolver, 'test-project',
    )
    assert.ok(result.graph !== null, 'array with $inputs should defer validation')
  })

  // ── Production contract regression: diagnose-repro in TaskGraph ───────────

  it('materializes a diagnose-repro node with a string priorFindings contract', () => {
    const inputSchema = normalizeSchema(diagnoseReproTask.config.input) as JsonObject
    const outputSchema = normalizeSchema(diagnoseReproTask.config.output) as JsonObject
    assert.ok(inputSchema, 'diagnose-repro input schema must normalize to draft-07')
    assert.ok(outputSchema, 'diagnose-repro output schema must normalize to draft-07')

    // The narrowed contract emits fully typed draft-07 for priorFindings — an
    // anyOf/record/array/null union here fails graph schema materialization.
    const inputProps = (inputSchema.properties ?? {}) as Record<string, JsonObject>
    const priorFindingsSchema = (inputProps.priorFindings ?? {}) as JsonObject
    assert.equal(priorFindingsSchema.type, 'string')

    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'diagnose-repro', 'test-project', inputSchema)

    const resolver = makeResolver({
      resolveActionSchema(actionType) {
        if (actionType !== 'task') return null
        return {
          input: inputSchema as ObjectJsonSchema,
          output: outputSchema as ObjectJsonSchema,
        }
      },
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: {
            name: 'diagnose-repro',
            project: 'test-project',
            input: {
              issue: 'build fails with a module resolution error',
              project: 'test-project',
              priorFindings: JSON.stringify({
                redirect: 'suspect tsconfig moduleResolution for the build step',
                evidence: ['src/main.ts:120', 'Cannot find module'],
              }),
            },
          },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, resolver, contractResolver, 'test-project',
    )
    assert.ok(result.graph !== null, 'diagnose-repro node must materialize with string priorFindings')
    assert.equal(result.issues.length, 0)
  })

  it('does not treat reserved task ctx as a graph wiring schema', () => {
    const inputSchema: ObjectJsonSchema = {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        ctx: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: ['objective'],
      additionalProperties: false,
    }
    const outputSchema: ObjectJsonSchema = objectSchema({ status: { type: 'string' } })
    const contractResolver = new FakeContractResolver()
    contractResolver.setContract('task', 'implement', 'test-project', inputSchema)
    const resolver = makeResolver({
      resolveActionSchema(actionType) {
        if (actionType !== 'task') return null
        return { input: inputSchema, output: outputSchema }
      },
    })

    const graph = emptyGraph()
    graph.nodes = {
      start: startNode('start'),
      t: taskNode('t', {
        deps: ['start'],
        action: {
          type: 'task',
          params: {
            name: 'implement',
            project: 'test-project',
            input: { objective: 'fix the regression' },
          },
        },
        input_schema: objectSchema({}, []),
      }),
    }

    const result = validateTaskGraphPostImage(
      graph, [], undefined, resolver, contractResolver, 'test-project',
    )
    assert.ok(result.graph !== null, 'reserved task ctx must not invalidate graph wiring')
    assert.equal(result.issues.length, 0)
  })
})
