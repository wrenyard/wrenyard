import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import {
  compileSchema,
  generateInputExample,
  isZodSchema,
  normalizeSchema,
  zodToJsonSchema,
} from '../../lib/workspace/schema-loader.mts'
import {
  AssessmentSchema,
  GoalSchema,
  EvidenceSchema,
  QuestionSchema,
  FindingSchema,
} from '../../lib/core/task/concepts.mts'
import { collectStructuredOutput, type StructuredOutputAgent } from '../../lib/core/task/structured-output.mts'

describe('schema-loader — isZodSchema detection', () => {
  it('recognizes a Zod 4 schema object', () => {
    assert.equal(isZodSchema(GoalSchema), true)
    assert.equal(isZodSchema(z.object({ a: z.string() })), true)
    assert.equal(isZodSchema(z.string()), true)
  })

  it('rejects plain JSON Schema, records, and primitives', () => {
    assert.equal(isZodSchema({ type: 'object' }), false)
    assert.equal(isZodSchema({ a: { type: 'string' } }), false)
    assert.equal(isZodSchema(null), false)
    assert.equal(isZodSchema(undefined), false)
    assert.equal(isZodSchema('string'), false)
    assert.equal(isZodSchema(42), false)
  })
})

describe('schema-loader — zodToJsonSchema produces draft-07 (AC-5)', () => {
  it('uses z.toJSONSchema(schema, { target: "draft-07" })', () => {
    const json = zodToJsonSchema(GoalSchema) as Record<string, unknown>
    assert.equal(json.$schema, 'http://json-schema.org/draft-07/schema#')
    assert.equal(json.type, 'object')
    assert.deepEqual((json as any).required, ['outcome'])
    assert.deepEqual((json as any).properties.outcome, { type: 'string' })
  })

  it('AssessmentSchema conversion preserves the not_supported enum value', () => {
    const json = zodToJsonSchema(AssessmentSchema) as any
    assert.deepEqual(
      json.properties.status.enum,
      ['passed', 'failed', 'blocked', 'not_supported'],
    )
  })

  it('zod-derived JSON Schema does not carry unresolvable $ref entries', () => {
    const json = JSON.stringify(zodToJsonSchema(FindingSchema))
    assert.doesNotMatch(json, /"\$ref"/u)
  })
})

describe('schema-loader — normalizeSchema accepts ZodType only (AC-5)', () => {
  it('normalizes a zod schema to draft-07 JSON Schema', () => {
    const normalized = normalizeSchema(GoalSchema) as Record<string, unknown>
    assert.equal(normalized.$schema, 'http://json-schema.org/draft-07/schema#')
    assert.equal(normalized.type, 'object')
    assert.deepEqual(normalized.required, ['outcome'])
  })

  it('returns undefined for undefined input', () => {
    assert.equal(normalizeSchema(undefined), undefined)
  })

  it('rejects non-Zod definition schemas clearly', () => {
    assert.throws(
      () => normalizeSchema({ type: 'object' } as any),
      /must be a ZodType|no longer supported/i,
    )
    assert.throws(
      () => normalizeSchema({ a: { type: 'string' } } as any),
      /must be a ZodType|no longer supported/i,
    )
  })
})

describe('schema-loader — compileSchema Zod -> AJV validation path (AC-5)', () => {
  it('compiles a zod schema and validates valid input', () => {
    const compiled = compileSchema(GoalSchema)
    assert.equal(compiled.validate({ outcome: 'do something' }), true)
    assert.equal(compiled.validate.errors, null)
  })

  it('compiles a zod schema and rejects invalid input with AJV errors', () => {
    const compiled = compileSchema(GoalSchema)
    assert.equal(compiled.validate({}), false)
    assert.ok(compiled.validate.errors && compiled.validate.errors.length > 0)
    const missingProp = compiled.validate.errors!.find((e) =>
      (e.params as any)?.missingProperty === 'outcome',
    )
    assert.ok(missingProp, 'AJV must report missing required property outcome')
  })

  it('compiled schema carries the draft-07 $schema marker', () => {
    const compiled = compileSchema(AssessmentSchema)
    assert.equal((compiled.schema as any).$schema, 'http://json-schema.org/draft-07/schema#')
  })

  it('compiles every concept schema without error', () => {
    const schemas = [
      GoalSchema, QuestionSchema, EvidenceSchema, FindingSchema, AssessmentSchema,
    ]
    for (const schema of schemas) {
      assert.doesNotThrow(() => compileSchema(schema))
    }
  })

  it('no longer exposes a workspace schema registry or $ref path', async () => {
    const mod = await import('../../lib/workspace/schema-loader.mts')
    assert.equal((mod as any).registerWorkspaceSchemas, undefined)
    assert.equal((mod as any).resetSchemaRegistry, undefined)
    assert.equal((mod as any).expandSchemaRefs, undefined)
    assert.equal((mod as any).scanSchemaFiles, undefined)
    assert.equal((mod as any).isFullJsonSchema, undefined)
  })
})

describe('schema-loader — generateInputExample on zod', () => {
  it('produces an example object for a zod schema with required string fields', () => {
    const example = generateInputExample(QuestionSchema)
    assert.deepEqual(example, { id: 'string', ask: 'string', blocking: true })
  })

  it('returns undefined for undefined schemas', () => {
    assert.equal(generateInputExample(undefined), undefined)
  })
})

describe('schema-loader — collectStructuredOutput with zod output schema (end-to-end)', () => {
  it('validates the structured output against a zod schema via z.toJSONSchema → AJV', async () => {
    const OutputSchema = z.object({
      question_id: z.string(),
      answer: z.string(),
    })

    const fakeAgent: StructuredOutputAgent = async (_profile, _prompt) => ({
      status: 'done',
      output: [
        '<foreman-task-output>',
        '<summary>answered</summary>',
        '<result>',
        JSON.stringify({ question_id: 'q1', answer: 'yes' }),
        '</result>',
        '</foreman-task-output>',
      ].join('\n'),
    })

    const result = await collectStructuredOutput({
      profile: 'test',
      instructions: 'answer the question',
      outputSchema: OutputSchema,
      timeoutMs: 1000,
      maxResumeAttempts: 0,
      runAgent: fakeAgent,
    })

    assert.deepEqual(result, { question_id: 'q1', answer: 'yes' })
  })

  it('rejects output that fails the zod-derived schema with AJV errors', async () => {
    const OutputSchema = z.object({
      question_id: z.string(),
      answer: z.string(),
    })

    const fakeAgent: StructuredOutputAgent = async () => ({
      status: 'done',
      output: [
        '<foreman-task-output>',
        '<summary>answered</summary>',
        '<result>',
        JSON.stringify({ question_id: 'q1' }),  // missing answer
        '</result>',
        '</foreman-task-output>',
      ].join('\n'),
    })

    await assert.rejects(
      collectStructuredOutput({
        profile: 'test',
        instructions: 'answer the question',
        outputSchema: OutputSchema,
        timeoutMs: 1000,
        maxResumeAttempts: 0,
        runAgent: fakeAgent,
      }),
      /GateFailureError|schema validation|missing|structured output errors/u,
    )
  })
})
