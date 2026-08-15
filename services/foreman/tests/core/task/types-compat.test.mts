import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  AgentResult,
  AgentOpts,
  CheckpointFn,
  ExecutionOptions,
  JsonSchema,
  LlmOpts,
  PermissionMode,
  PrimitiveSet,
  ResolvedTarget,
  SchemaField,
  ShellOpts,
  ShellResult,
  // Task-domain types — must still be re-exported from lib/types.mts:
  GateContext,
  GateFail,
  GatePass,
  RegisteredTask,
  TaskConfig,
  TaskDefinition,
  TaskExecutionResult,
  TaskGate,
  TaskListEntry,
  TaskRunResult,
} from '../../../lib/types.mts'

import type {
  TaskSchemaInput,
} from '../../../lib/core/task/types.mts'

import type { ZodType } from 'zod'
import { z } from 'zod'

/**
 * Type-compatibility tests for the Core Concept 7 migration:
 * task-domain types now live in `lib/core/task/types.mts` and are
 * re-exported from `lib/types.mts` to keep the 14 existing callers'
 * import paths unchanged (AC-2).
 */
describe('lib/types.mts re-export shim (AC-2, Core Concept 7)', () => {
  it('re-exports every task-domain type from the new SSOT location', () => {
    // Compile-time-only assertions — each `type` import above would fail to
    // resolve if the re-export shim dropped an entry. Reference each type
    // at runtime via a small factory to keep TypeScript honest.
    const samples: Array<unknown> = []
    const taskConfig: TaskConfig = {
      profile: 'p',
      input: z.object({}),
      output: z.object({}),
      prompt: () => '',
    }
    const taskDef: TaskDefinition = { __type: 'task', config: taskConfig, sourcePath: '/x' }
    const registered: RegisteredTask = {
      name: 'n',
      definition: taskDef,
      project: 'p',
      source: 'project',
      sourcePath: '/x',
      mtime: 0,
    }
    const exec: TaskExecutionResult = {
      task_id: 't',
      name: 'n',
      project: 'p',
      status: 'done',
      output: null,
      structured: true,
    }
    const run: TaskRunResult = { task_run_id: 'r', hint: 'h' }
    const list: TaskListEntry = { name: 'n', project: 'p' }
    const pass: GatePass = { ok: true }
    const fail: GateFail = { ok: false, expected: 'e', actual: 'a' }
    const ctx: GateContext = {
      task: { name: 'n', sourcePath: '/x' },
      input: null,
      workDir: '/',
      workspaceRoot: '/',
      project: 'p',
      taskId: 't',
      state: {},
      shell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }
    const gate: TaskGate = { id: 'g', run: () => ({ ok: true }) }

    samples.push(taskConfig, taskDef, registered, exec, run, list, pass, fail, ctx, gate)
    assert.ok(samples.length === 10)
  })

  it('RegisteredTask requires explicit source provenance', () => {
    const entry: RegisteredTask = {
      name: 'edit',
      definition: { __type: 'task', config: { profile: 'p', input: z.object({}), output: z.object({}), prompt: () => '' }, sourcePath: '(builtin)' },
      project: 'foreman',
      sourcePath: '(builtin)',
      mtime: 0,
      source: 'builtin',
    }
    assert.equal(entry.source, 'builtin')

    const projectEntry: RegisteredTask = {
      name: 'edit',
      definition: entry.definition,
      project: 'workspace',
      sourcePath: '/x',
      mtime: 0,
      source: 'project',
    }
    assert.equal(projectEntry.source, 'project')
  })

  it('retains JsonSchema/SchemaField/PermissionMode/AgentResult at lib/types.mts', () => {
    const schema: JsonSchema = { type: 'object' }
    const field: SchemaField = { type: 'string', required: true }
    const perm: PermissionMode = 'edit'
    const agentResult: AgentResult = { output: '', status: 'done' }

    assert.ok(schema && field && perm && agentResult)
  })

  it('retains execution primitives and ExecutionOptions', () => {
    const opts: AgentOpts = { permission: 'edit' }
    const shellOpts: ShellOpts = {}
    const shellResult: ShellResult = { exitCode: 0, stdout: '', stderr: '' }
    const llmOpts: LlmOpts = { temperature: 0 }
    const execOpts: ExecutionOptions = { workspaceRoot: '/' }
    const checkpoint: CheckpointFn = async () => ({})
    const primitives: PrimitiveSet = {
      agent: async () => ({ output: '', status: 'done' }),
      shell: async () => shellResult,
      llm: async () => '',
      checkpoint,
    }
    const resolved: ResolvedTarget = {
      definition: { __type: 'task', config: { profile: 'p', input: z.object({}), output: z.object({}), prompt: () => '' }, sourcePath: '/x' },
      type: 'task',
      name: 't',
      project: 'foreman',
      source: 'project',
      sourcePath: '/x',
    }

    assert.ok(opts && shellOpts && shellResult && llmOpts && execOpts && primitives && resolved)
  })
})

describe('TaskConfig accepts ZodType only (AC-5)', () => {
  it('TaskSchemaInput is ZodType', () => {
    const zodSchema: ZodType = z.object({ a: z.string() })
    const input: TaskSchemaInput = zodSchema
    assert.ok(input)
  })

  it('TaskConfig.input/output accept a zod schema', () => {
    const zodInput = z.object({ question: z.string() })
    const zodOutput = z.object({ answer: z.string() })
    const config: TaskConfig = {
      profile: 'p',
      input: zodInput,
      output: zodOutput,
      prompt: () => '',
    }
    assert.equal(typeof config.input, 'object')
    assert.equal(typeof config.output, 'object')
  })
})
