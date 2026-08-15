import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { agent as realAgent, setAgentExecutionSupervisor } from '../../../lib/core/operations/primitives/agent.mts'
import { GateFailureError } from '../../../lib/core/task/failure.mts'
import {
  collectStructuredOutput,
  firstPrompt,
  resumePrompt,
  type StructuredOutputAgent,
  type StructuredOutputAgentOptions,
  type StructuredOutputAgentResult,
  type StructuredOutputJsonSchema,
} from '../../../lib/core/task/structured-output.mts'
import { compileSchema } from '../../../lib/workspace/schema-loader.mts'
import { STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS } from '../../../lib/task-timeouts.mts'
import { z } from 'zod'
import type {
  AgentExecutionSupervisor,
  ExecutionHandle,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
  StartExecutionOpts,
} from '../../../lib/daemon/execution/agent-supervisor.mts'

type StructuredAgentOpts = StructuredOutputAgentOptions
type SupervisorResult = Omit<ExecutionResult, 'executionId'> & { nativeSessionId?: string }

let oldDateNow: (() => number) | undefined

beforeEach(() => {
  oldDateNow = Date.now
})

afterEach(() => {
  if (oldDateNow) Date.now = oldDateNow
})

describe('core task structured-output', () => {
  it('uses the injected supervisor and reads XML delivery output', async () => {
    const starts = installSupervisor(() => ({
      status: 'done',
      output: xmlOutput({ label: 'from supervisor' }),
      exitCode: 0,
      nativeSessionId: 'native_structured_001',
    }))

    const result = await collectStructuredOutput({
      profile: 'test',
      instructions: 'classify',
      outputSchema: labelSchema(),
      timeoutMs: 1000,
      maxResumeAttempts: 0,
      runAgent: realAgent,
    })

    assert.deepEqual(result, { label: 'from supervisor' })
    assert.equal(starts.length, 1)
    assert.equal(starts[0].profile, 'test')
    assert.equal(starts[0].permission, 'edit')
    assert.equal('mcp' in starts[0], false)
    assert.match(starts[0].prompt, /Return one Foreman structured output block/u)
    assert.match(starts[0].prompt, /^classify\n\n<foreman-output-contract mode="structured-xml">/u)
    assert.match(starts[0].prompt, /<foreman-task-output>/u)
    assert.match(starts[0].prompt, /extracts the first complete block/iu)
    assert.doesNotMatch(starts[0].prompt, /submit_result|MCP/u)
  })

  it('accepts XML wrapper and returns only the parsed result JSON', async () => {
    let delivery: { summary?: string; data: unknown } | undefined
    const result = await collectWithAgent(async () => ({
      output: xmlOutput({ label: 'wrapped result' }, 'Classification complete.'),
      status: 'done',
    }), {
      onDelivery: (value) => {
        delivery = value
      },
    })

    assert.deepEqual(result, { label: 'wrapped result' })
    assert.deepEqual(delivery, {
      summary: 'Classification complete.',
      data: { label: 'wrapped result' },
    })
  })

  it('accepts a JSON array when the task output schema is an array', async () => {
    const output = '<foreman-task-output>\n<summary>Edited.</summary>\n<result>\n[{"id":"ev-1"}]\n</result>\n</foreman-task-output>'
    const result = await collectStructuredOutput({
      profile: 'forge/fast',
      instructions: 'edit',
      outputSchema: z.array(z.object({ id: z.string() })),
      maxResumeAttempts: 0,
      runAgent: async () => ({ output, status: 'done' }),
    })

    assert.deepEqual(result, [{ id: 'ev-1' }])
  })

  it('allows protocol-looking text inside result JSON string values', async () => {
    const labels = [
      'see </result> literally',
      'see </foreman-task-output> literally',
      '```json\nnot a wrapper\n```',
    ]

    for (const label of labels) {
      const result = await collectWithAgent(async () => ({
        output: xmlOutput({ label }),
        status: 'done',
      }))

      assert.deepEqual(result, { label })
    }
  })

  it('extracts a complete XML delivery block even when surrounding prose exists', async () => {
    let calls = 0
    const result = await collectWithAgent(async () => {
      calls += 1
      return {
        output: [
          'I found the answer:',
          xmlOutput({ label: 'surrounded' }, 'Summary from block.'),
          'Thanks.',
        ].join('\n\n'),
        status: 'done',
      }
    })

    assert.equal(calls, 1)
    assert.deepEqual(result, { label: 'surrounded' })
  })

  it('rejects fenced JSON inside result as a JSON error', async () => {
    const errors = await validationErrorsForOutput([
      '<foreman-task-output>',
      '<summary>',
      'Done.',
      '</summary>',
      '<result>',
      '```json',
      '{"label":"from terminal text"}',
      '```',
      '</result>',
      '</foreman-task-output>',
    ].join('\n'))

    assert.ok(errors.some((error) => /json error:/iu.test(error)), errors.join('\n'))
    assert.ok(errors.some((error) => /markdown code fences|raw JSON/iu.test(error)), errors.join('\n'))
  })

  it('rejects missing summary closing tag or result tag as protocol errors', async () => {
    const missingSummaryClose = await validationErrorsForOutput([
      '<foreman-task-output>',
      '<summary>',
      'Done.',
      '<result>',
      '{"label":"ok"}',
      '</result>',
      '</foreman-task-output>',
    ].join('\n'))
    assert.ok(missingSummaryClose.some((error) => /protocol error:.*<\/summary>/iu.test(error)), missingSummaryClose.join('\n'))

    const missingResult = await validationErrorsForOutput([
      '<foreman-task-output>',
      '<summary>',
      'Done.',
      '</summary>',
      '</foreman-task-output>',
    ].join('\n'))
    assert.ok(missingResult.some((error) => /protocol error:.*<result>/iu.test(error)), missingResult.join('\n'))
  })

  it('rejects multiple XML delivery wrappers', async () => {
    const errors = await validationErrorsForOutput([
      xmlOutput({ label: 'one' }),
      xmlOutput({ label: 'two' }),
    ].join('\n'))

    assert.ok(errors.some((error) => /protocol error:.*multiple complete <foreman-task-output>/iu.test(error)), errors.join('\n'))
  })

  it('rejects bare JSON when no XML delivery wrapper is present', async () => {
    const errors = await validationErrorsForOutput(JSON.stringify({ label: 'bare output' }))

    assert.ok(errors.some((error) => /protocol error:.*<foreman-task-output>/iu.test(error)), errors.join('\n'))
  })

  it('preserves placeholder rejection through resume prompt and gate evidence', async () => {
    const prompts: string[] = []
    const agent: StructuredOutputAgent = async (_profile, prompt) => {
      prompts.push(prompt)
      return { output: xmlOutput({ label: 'placeholder' }), status: 'done' }
    }

    let caughtErr: unknown
    try {
      await collectWithAgent(agent, { maxResumeAttempts: 1 })
    } catch (err) {
      caughtErr = err
    }

    assert.ok(caughtErr instanceof GateFailureError, `Expected GateFailureError, got ${caughtErr?.constructor?.name}`)
    const evidence = caughtErr.failure.evidence as { validation_errors?: string[] } | undefined
    assert.ok(evidence)
    assert.ok(evidence.validation_errors?.some((error) => error.includes('placeholder')))
    assert.match(caughtErr.failure.actual, /placeholder result rejected/u)
    assert.equal(prompts.length, 2)
    assert.match(prompts[1], /placeholder/u)
  })

  it('retries when final structured output is absent and preserves native session id', async () => {
    let calls = 0
    const resumeIds: Array<string | undefined> = []
    const result = await collectWithAgent(async (_profile, _prompt, opts) => {
      calls += 1
      resumeIds.push((opts as { resume?: string } | undefined)?.resume)
      if (calls === 1) {
        return {
          output: 'missing strict JSON on first attempt',
          status: 'done',
          nativeSessionId: 'native_queued',
        }
      }
      return {
        output: xmlOutput({ label: 'done after retry' }),
        status: 'done',
        nativeSessionId: 'native_queued',
      }
    }, { maxResumeAttempts: 1 })

    assert.equal(calls, 2)
    assert.deepEqual(resumeIds, [undefined, 'native_queued'])
    assert.deepEqual(result, { label: 'done after retry' })
  })

  it('rejects fenced bare JSON because XML delivery is required', async () => {
    let caughtErr: unknown
    try {
      await collectWithAgent(async () => ({
        output: '```json\n{"label":"from terminal text"}\n```',
        status: 'done',
      }))
    } catch (err) {
      caughtErr = err
    }

    assert.ok(caughtErr instanceof GateFailureError, `Expected GateFailureError, got ${caughtErr?.constructor?.name}`)
    assert.match(caughtErr.failure.remediation ?? '', /exactly one <foreman-task-output> block/u)
    assert.doesNotMatch(caughtErr.failure.remediation ?? '', /submit_result|MCP/u)
  })

  it('passes structured execution options through without injecting MCP', async () => {
    let seenProfile: string | undefined
    let seenOpts: StructuredAgentOpts | undefined
    const result = await collectStructuredOutput({
      profile: 'test-profile',
      instructions: 'classify',
      outputSchema: labelSchema(),
      workingDirectory: '/tmp/foreman-structured-work',
      permission: 'readonly',
      timeoutMs: 1000,
      maxResumeAttempts: 0,
      runAgent: async (profile, _prompt, opts) => {
        seenProfile = profile
        seenOpts = opts as StructuredAgentOpts
        return { output: xmlOutput({ label: 'forwarded' }), status: 'done' }
      },
    })

    assert.deepEqual(result, { label: 'forwarded' })
    assert.equal(seenProfile, 'test-profile')
    assert.equal(seenOpts?.workingDirectory, '/tmp/foreman-structured-work')
    assert.equal(seenOpts?.permission, 'readonly')
    assert.equal('mcp' in (seenOpts ?? {}), false)
    assert.equal('mcpServers' in (seenOpts ?? {}), false)
  })

  it('throws a structured timeout error when the primitive reports timeout', async () => {
    let caughtErr: unknown
    try {
      await collectWithAgent(timeoutAgent('still running'), { timeoutMs: 500 })
    } catch (err) {
      caughtErr = err
    }

    assert.ok(caughtErr instanceof Error)
    assert.match(caughtErr.message, /timed out/u)
    const payload = JSON.parse((caughtErr as Error & { error_message?: string }).error_message ?? '{}') as Record<string, unknown>
    assert.equal(payload.type, 'agent_timeout')
    assert.equal(payload.execution_id, 'exec_timeout')
    assert.equal('session_id' in payload, false)
    assert.equal(payload.attempts_used, 1)
  })

  it('does not retry when the primitive reports cancellation', async () => {
    let calls = 0
    let caughtErr: unknown
    try {
      await collectWithAgent(async () => {
        calls += 1
        return {
          output: '',
          status: 'cancelled',
          executionId: 'exec_cancelled',
          executionStatus: 'cancelled',
        } as StructuredOutputAgentResult & { executionId: string; executionStatus: 'cancelled' }
      }, { maxResumeAttempts: 2 })
    } catch (err) {
      caughtErr = err
    }

    assert.equal(calls, 1)
    assert.ok(caughtErr instanceof Error)
    assert.match(caughtErr.message, /cancelled/u)
    const payload = JSON.parse((caughtErr as Error & { error_message?: string }).error_message ?? '{}') as Record<string, unknown>
    assert.equal(payload.type, 'agent_cancelled')
    assert.equal(payload.execution_id, 'exec_cancelled')
  })

  it('uses the short structured-output retry timeout after invalid output', async () => {
    let calls = 0
    const seenTimeouts: Array<number | undefined> = []

    let caughtErr: unknown
    try {
      await collectWithAgent(async (_profile, _prompt, opts) => {
        calls += 1
        seenTimeouts.push(opts?.timeoutMs)
        return { output: xmlOutput({ wrong: true }), status: 'done' }
      }, { timeoutMs: 500, maxResumeAttempts: 2 })
    } catch (err) {
      caughtErr = err
    }

    assert.equal(calls, 3)
    assert.deepEqual(seenTimeouts, [500, STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS, STRUCTURED_OUTPUT_RETRY_TIMEOUT_MS])
    assert.ok(caughtErr instanceof GateFailureError, `Expected GateFailureError, got ${caughtErr?.constructor?.name}`)
  })

  it('recovers when a later primitive attempt returns a valid XML delivery', async () => {
    let calls = 0
    const result = await collectWithAgent(async () => {
      calls += 1
      if (calls === 1) return { output: xmlOutput({ wrong: true }), status: 'done' }
      return { output: xmlOutput({ label: 'all done after retry' }), status: 'done' }
    }, { maxResumeAttempts: 1 })

    assert.equal(calls, 2)
    assert.deepEqual(result, { label: 'all done after retry' })
  })

  it('firstPrompt and resumePrompt require XML delivery without MCP instructions', () => {
    const schema = compileSchema(labelSchema())

    const first = firstPrompt('classify', schema)
    assert.match(first, /Return one Foreman structured output block/u)
    assert.match(first, /^classify\n\n<foreman-output-contract mode="structured-xml">/u)
    assert.match(first, /<foreman-task-output>/u)
    assert.match(first, /<summary>/u)
    assert.match(first, /<result>/u)
    assert.match(first, /Do not include markdown fences/u)
    assert.match(first, /extracts the first complete block/u)
    assert.match(first, /<\/foreman-output-contract>$/u)
    assert.doesNotMatch(first, /\n---\n/u)
    assert.doesNotMatch(first, /submit_result|MCP|FALLBACK/u)
    assert.match(first, /Output schema/u)
    assert.ok(first.includes(JSON.stringify(schema.schema, null, 2)))

    const resume = resumePrompt(2, schema, [
      'protocol error: missing </summary> closing tag',
      'json error: <result> is not valid JSON',
      'schema error: <result> schema validation failed: / must have required property label',
    ])
    assert.match(resume, /Retry 2/u)
    assert.match(resume, /<foreman-task-output>/u)
    assert.match(resume, /Protocol errors:/u)
    assert.match(resume, /JSON errors:/u)
    assert.match(resume, /Schema errors:/u)
    assert.match(resume, /missing <\/summary>/u)
    assert.match(resume, /not valid JSON/u)
    assert.match(resume, /required property label/u)
    assert.doesNotMatch(resume, /submit_result|MCP|FALLBACK/u)
    assert.match(resume, /Output schema/u)
  })

  it('timeout status wins over valid-looking terminal JSON', async () => {
    await assert.rejects(
      () => collectWithAgent(async () => ({
        output: JSON.stringify({ label: 'too late' }),
        status: 'failed',
        executionId: 'exec_deadline_edge',
        executionStatus: 'timeout',
      } as StructuredOutputAgentResult & { executionId: string; executionStatus: 'timeout' }), {
        timeoutMs: 500,
        maxResumeAttempts: 0,
      }),
      /timed out/u,
    )
  })

  it('retries with forge/<resolvedProfile> when policy attempt resolves a concrete profile', async () => {
    let calls = 0
    const seenProfiles: string[] = []
    const agent: StructuredOutputAgent = async (profile, _prompt, opts) => {
      calls += 1
      seenProfiles.push(profile)
      if (calls === 1) {
        return {
          output: 'no output block',
          status: 'done',
          nativeSessionId: 'native_resolved',
          resolvedProfile: 'codex-luna',
        } as StructuredOutputAgentResult & { nativeSessionId: string; resolvedProfile: string }
      }
      return {
        output: xmlOutput({ label: 'retried with concrete' }),
        status: 'done',
        nativeSessionId: 'native_resolved',
      }
    }

    const result = await collectWithAgent(agent, { maxResumeAttempts: 1 })
    assert.equal(calls, 2)
    assert.deepEqual(result, { label: 'retried with concrete' })
    assert.equal(seenProfiles[0], 'test')
    assert.equal(seenProfiles[1], 'forge/codex-luna',
      'retry must use forge/<resolvedProfile>, not the original policy agentRuntime')
  })

  it('fails deterministically when retry is required without a resolved profile for policy', async () => {
    let caughtErr: unknown
    try {
      await collectWithAgent(async () => ({
        output: 'invalid output',
        status: 'done',
      }), { maxResumeAttempts: 1, profile: 'forge/general' })
    } catch (err) {
      caughtErr = err
    }

    assert.ok(caughtErr instanceof Error, `Expected Error, got ${caughtErr?.constructor?.name}`)
    assert.match(caughtErr.message, /concrete resolved profile/)
  })

  it('preserves the first runtime failure for policy without a resolved profile', async () => {
    let calls = 0
    let caughtErr: unknown
    try {
      await collectWithAgent(async () => {
        calls += 1
        return {
          output: 'partial output',
          status: 'failed',
          executionId: 'exec_failed',
          error: 'runtime exploded: auth rejected',
        } as StructuredOutputAgentResult & { executionId: string; error: string }
      }, { maxResumeAttempts: 1, profile: 'forge/general' })
    } catch (err) {
      caughtErr = err
    }

    assert.equal(calls, 1, 'runtime failure must stop after one attempt')
    assert.ok(caughtErr instanceof Error)
    const failed = caughtErr as Error & { failure_category?: string; error_message?: string }
    assert.equal(failed.failure_category, 'agent_failed')
    assert.doesNotMatch(failed.message, /concrete resolved profile/u,
      'runtime failure must not be masked by the policy retry-profile error')
    const payload = JSON.parse(failed.error_message ?? '{}') as Record<string, unknown>
    assert.equal(payload.type, 'agent_failed')
    assert.equal(payload.execution_id, 'exec_failed')
    assert.equal(payload.status, 'failed')
    assert.match(payload.detail as string, /auth rejected/u,
      'the original agent error text must be preserved')
  })

  it('retries safely for non-policy profiles without resolvedProfile', async () => {
    let calls = 0
    const result = await collectWithAgent(async () => {
      calls += 1
      if (calls === 1) return { output: 'bad output', status: 'done' }
      return { output: xmlOutput({ label: 'retried ok' }), status: 'done' }
    }, { maxResumeAttempts: 1, profile: 'forge/codex-luna' })

    assert.equal(calls, 2)
    assert.deepEqual(result, { label: 'retried ok' })
  })

  it('forwards selected capabilities to first attempt and retry', async () => {
    const seenCaps: Array<readonly string[] | undefined> = []
    const agent: StructuredOutputAgent = async (_profile, _prompt, opts) => {
      seenCaps.push((opts as { capabilities?: readonly string[] } | undefined)?.capabilities)
      if (seenCaps.length === 1) {
        return { output: 'invalid output', status: 'done', nativeSessionId: 'native_cap' }
      }
      return { output: xmlOutput({ label: 'cap forwarded' }), status: 'done' }
    }

    const result = await collectWithAgent(agent, {
      maxResumeAttempts: 1,
      capabilities: ['browser-use', 'computer-use'],
    })

    assert.deepEqual(result, { label: 'cap forwarded' })
    assert.equal(seenCaps.length, 2, 'should have 2 attempts')
    assert.deepEqual(seenCaps[0], ['browser-use', 'computer-use'], 'first attempt must have capabilities')
    assert.deepEqual(seenCaps[1], ['browser-use', 'computer-use'], 'retry attempt must preserve capabilities')
  })

  it('passes capabilities without throwing when no capabilities provided', async () => {
    const result = await collectWithAgent(async () => ({
      output: xmlOutput({ label: 'no caps' }),
      status: 'done',
    }), { maxResumeAttempts: 0 })

    assert.deepEqual(result, { label: 'no caps' })
  })
})

function labelSchema(): StructuredOutputJsonSchema {
  return z.object({
    label: z.string(),
  })
}

function xmlOutput(data: unknown, summary = 'Done.'): string {
  return [
    '<foreman-task-output>',
    '<summary>',
    summary,
    '</summary>',
    '<result>',
    JSON.stringify(data),
    '</result>',
    '</foreman-task-output>',
  ].join('\n')
}

async function validationErrorsForOutput(output: string): Promise<string[]> {
  try {
    await collectWithAgent(async () => ({ output, status: 'done' }), { maxResumeAttempts: 0 })
  } catch (error) {
    assert.ok(error instanceof GateFailureError, `Expected GateFailureError, got ${error?.constructor?.name}`)
    const evidence = error.failure.evidence as { validation_errors?: string[] } | undefined
    return evidence?.validation_errors ?? []
  }
  assert.fail('expected structured output collection to fail')
}

function collectWithAgent(
  agent: StructuredOutputAgent,
  overrides: Partial<Parameters<typeof collectStructuredOutput>[0]> = {},
): Promise<unknown> {
  return collectStructuredOutput({
    profile: 'test',
    instructions: 'classify',
    outputSchema: labelSchema(),
    timeoutMs: 1000,
    maxResumeAttempts: 0,
    runAgent: agent,
    ...overrides,
  })
}

function timeoutAgent(output: string): StructuredOutputAgent {
  return async () => ({
    output,
    status: 'failed',
    executionId: 'exec_timeout',
    executionStatus: 'timeout',
    error: 'timed out',
  } as StructuredOutputAgentResult & { executionId: string; executionStatus: 'timeout'; error: string })
}

function installSupervisor(handler: (opts: StartExecutionOpts, executionId: string) => SupervisorResult | Promise<SupervisorResult>): StartExecutionOpts[] {
  const starts: StartExecutionOpts[] = []
  const records = new Map<string, ExecutionRecord>()

  const supervisor = {
    async startExecution(opts: StartExecutionOpts): Promise<ExecutionHandle> {
      starts.push(opts)
      const executionId = `exec_structured_${starts.length}`
      const record = makeExecutionRecord(executionId, opts, 'running')
      records.set(executionId, record)
      const waitPromise = Promise.resolve()
        .then(() => handler(opts, executionId))
        .then((partial): ExecutionResult => {
          record.status = partial.status
          record.output = partial.output ?? null
          record.error = partial.error ?? null
          record.exit_code = partial.exitCode ?? null
          record.kill_reason = partial.killReason ?? null
          record.native_session_id = partial.nativeSessionId ?? null
          return {
            executionId,
            status: partial.status,
            output: partial.output,
            error: partial.error,
            exitCode: partial.exitCode,
            killReason: partial.killReason,
          }
        })

      return {
        executionId,
        wait: () => waitPromise,
        cancel: async () => {
          record.status = 'cancelled'
        },
      }
    },
    getExecution(executionId: string): ExecutionRecord | undefined {
      return records.get(executionId)
    },
  } as unknown as AgentExecutionSupervisor

  setAgentExecutionSupervisor(supervisor)
  return starts
}

function makeExecutionRecord(id: string, opts: StartExecutionOpts, status: ExecutionStatus): ExecutionRecord {
  return {
    id,
    task_id: opts.taskId ?? null,
    profile: opts.profile,
    permission: opts.permission,
    cwd: opts.cwd,
    prompt: opts.prompt,
    status,
    native_session_id: opts.resume ?? null,
    client_family: opts.clientFamily ?? null,
    pid: null,
    pgid: null,
    output: null,
    raw_result: null,
    error: null,
    exit_code: null,
    kill_reason: null,
    timeout_ms: opts.timeoutMs ?? null,
  }
}
