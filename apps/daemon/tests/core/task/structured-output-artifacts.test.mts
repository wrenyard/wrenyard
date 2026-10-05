import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { z } from 'zod'
import {
  createTaskArtifactDirectory,
  outputSchemaDeclaresArtifacts,
  validateTaskArtifacts,
  type TaskArtifactDiagnostic,
} from '../../../lib/core/task/artifacts.mts'
import { GateFailureError } from '../../../lib/core/task/failure.mts'
import { MAX_TASK_ARTIFACTS, TaskArtifactSchema } from '../../../lib/core/task/schemas/artifacts.mts'
import {
  collectStructuredOutput,
  type StructuredOutputAgent,
  type StructuredOutputOptions,
  type StructuredOutputPreSchemaTransform,
} from '../../../lib/core/task/structured-output.mts'

const ARTIFACT_VALIDATION_FILENAME = '.artifact-validation.json'

function readArtifactErrorsFromDirectory(directory: string): TaskArtifactDiagnostic[] {
  try {
    return (JSON.parse(readFileSync(join(directory, ARTIFACT_VALIDATION_FILENAME), 'utf8')) as { errors: TaskArtifactDiagnostic[] }).errors
  } catch {
    return []
  }
}

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ArtifactOutputSchema = z.object({
  result: z.string(),
  artifacts: z.array(TaskArtifactSchema).optional(),
})

const UnionArtifactSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), result: z.string() }),
  z.object({ kind: z.literal('files'), result: z.string(), artifacts: z.array(TaskArtifactSchema) }),
])

function writeFileArtifact(directory: string, name: string): string {
  const file = join(directory, name)
  writeFileSync(file, `payload:${name}`)
  return file
}

function validEntry(path: string, overrides: Record<string, unknown> = {}) {
  return { path, kind: 'file', role: 'artifact', description: 'an artifact', ...overrides }
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

/**
 * Public collectStructuredOutput harness that wires the same pre-schema hook
 * shape the daemon kernel uses, backed by the real validateTaskArtifacts and
 * real temp files. No agent is paid: runAgent is entirely mocked.
 */
function artifactCollector(
  artifactDirectory: string,
  agent: StructuredOutputAgent,
  overrides: Partial<StructuredOutputOptions> = {},
): {
  run: () => Promise<unknown>
  hookCalls: () => number
  diagnostics: () => TaskArtifactDiagnostic[]
} {
  let hookCalls = 0
  let diagnostics: TaskArtifactDiagnostic[] = []
  const preSchemaTransform: StructuredOutputPreSchemaTransform = async (data) => {
    hookCalls += 1
    const validation = await validateTaskArtifacts(data, artifactDirectory)
    diagnostics = validation.artifactErrors
    return validation.output
  }
  return {
    run: () => collectStructuredOutput({
      profile: 'test',
      instructions: 'artifacts',
      outputSchema: ArtifactOutputSchema,
      timeoutMs: 1000,
      maxResumeAttempts: 0,
      runAgent: agent,
      preSchemaTransform,
      ...overrides,
    }),
    hookCalls: () => hookCalls,
    diagnostics: () => diagnostics,
  }
}

describe('collectStructuredOutput — pre-schema artifact hook', () => {
  it('strips unsupported kind and missing fields before strict validation and preserves valid entries', async () => {
    const stateRoot = makeTempDir('wy-so-artifacts-')
    const artifactDirectory = await createTaskArtifactDirectory('task_hook_strip', stateRoot)
    const valid = writeFileArtifact(artifactDirectory, 'valid.txt')

    let attempts = 0
    const collector = artifactCollector(artifactDirectory, async () => {
      attempts += 1
      return {
        status: 'done',
        output: xmlOutput({
          result: 'ok',
          artifacts: [
            validEntry(valid),
            { path: valid },
            validEntry(valid, { kind: 'video' }),
          ],
        }),
      }
    })

    const result = await collector.run()

    assert.equal(attempts, 1, 'malformed artifact metadata must not trigger a correction')
    assert.equal(collector.hookCalls(), 1, 'the hook runs exactly once per collected attempt')
    assert.deepEqual(result, { result: 'ok', artifacts: [validEntry(valid)] })
    assert.equal(collector.diagnostics().length, 2)

    assert.equal(existsSync(join(artifactDirectory, ARTIFACT_VALIDATION_FILENAME)), true)
    const persisted = readArtifactErrorsFromDirectory(artifactDirectory)
    assert.equal(persisted.length, 2)
    assert.deepEqual(collector.diagnostics(), persisted)
  })

  it('replaces a non-array artifacts field with an empty array and still validates', async () => {
    const stateRoot = makeTempDir('wy-so-artifacts-')
    const artifactDirectory = await createTaskArtifactDirectory('task_hook_nonarray', stateRoot)

    const collector = artifactCollector(artifactDirectory, async () => ({
      status: 'done',
      output: xmlOutput({ result: 'ok', artifacts: 'nope' }),
    }))

    const result = await collector.run()
    assert.deepEqual(result, { result: 'ok', artifacts: [] })
    assert.equal(collector.diagnostics().length, 1)
    assert.equal(readArtifactErrorsFromDirectory(artifactDirectory).length, 1)
  })

  it('bounds declared artifacts at 128 entries before strict validation', async () => {
    const stateRoot = makeTempDir('wy-so-artifacts-')
    const artifactDirectory = await createTaskArtifactDirectory('task_hook_bound', stateRoot)
    const file = writeFileArtifact(artifactDirectory, 'many.txt')
    const declared = Array.from({ length: MAX_TASK_ARTIFACTS + 2 }, () => validEntry(file))

    const collector = artifactCollector(artifactDirectory, async () => ({
      status: 'done',
      output: xmlOutput({ result: 'ok', artifacts: declared }),
    }))

    const result = await collector.run()
    const artifacts = (result as { artifacts: unknown[] }).artifacts
    assert.equal(artifacts.length, MAX_TASK_ARTIFACTS)
    assert.equal(collector.diagnostics().length, 2)
    assert.match(collector.diagnostics()[0].reason, /exceeds the 128 entry limit/u)
    assert.equal(readArtifactErrorsFromDirectory(artifactDirectory).length, 2)
  })

  it('still retries an unrelated schema error and keeps diagnostics from the successful attempt', async () => {
    const stateRoot = makeTempDir('wy-so-artifacts-')
    const artifactDirectory = await createTaskArtifactDirectory('task_hook_retry', stateRoot)
    const firstFile = writeFileArtifact(artifactDirectory, 'first.txt')
    const secondFile = writeFileArtifact(artifactDirectory, 'second.txt')

    let attempts = 0
    const collector = artifactCollector(artifactDirectory, async () => {
      attempts += 1
      if (attempts === 1) {
        return {
          status: 'done',
          nativeSessionId: 'native_artifacts_retry',
          output: xmlOutput({
            result: 123,
            artifacts: [validEntry(firstFile, { kind: 'video' })],
          }),
        }
      }
      return {
        status: 'done',
        nativeSessionId: 'native_artifacts_retry',
        output: xmlOutput({
          result: 'corrected',
          artifacts: [validEntry(secondFile, { kind: 'video' })],
        }),
      }
    }, { maxResumeAttempts: 1 })

    const result = await collector.run()

    assert.equal(attempts, 2, 'an unrelated strict schema error still triggers the original correction')
    assert.equal(collector.hookCalls(), 2)
    assert.deepEqual(result, { result: 'corrected', artifacts: [] })
    const persisted = readArtifactErrorsFromDirectory(artifactDirectory)
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].path, secondFile,
      'the persisted diagnostics must correspond to the successful attempt, not a failed one')
  })

  it('sanitizes artifacts declared in a discriminated union branch', async () => {
    const stateRoot = makeTempDir('wy-so-artifacts-')
    const artifactDirectory = await createTaskArtifactDirectory('task_union', stateRoot)
    const file = writeFileArtifact(artifactDirectory, 'union.txt')

    let diagnostics: TaskArtifactDiagnostic[] = []
    const result = await collectStructuredOutput({
      profile: 'test',
      instructions: 'union',
      outputSchema: UnionArtifactSchema,
      timeoutMs: 1000,
      maxResumeAttempts: 0,
      runAgent: async () => ({
        status: 'done',
        output: xmlOutput({
          kind: 'files',
          result: 'ok',
          artifacts: [validEntry(file), validEntry(file, { kind: 'video' })],
        }),
      }),
      preSchemaTransform: async (data) => {
        const validation = await validateTaskArtifacts(data, artifactDirectory)
        diagnostics = validation.artifactErrors
        return validation.output
      },
    })

    assert.deepEqual(result, { kind: 'files', result: 'ok', artifacts: [validEntry(file)] })
    assert.equal(diagnostics.length, 1)
  })
})

describe('collectStructuredOutput — default no-hook behavior', () => {
  it('keeps the strict artifact schema when no pre-schema hook is supplied', async () => {
    const malformed = validEntry('/tmp/whatever-artifact.txt', { kind: 'video' })
    let attempts = 0
    let caughtErr: unknown
    try {
      await collectStructuredOutput({
        profile: 'test',
        instructions: 'artifacts',
        outputSchema: ArtifactOutputSchema,
        timeoutMs: 1000,
        maxResumeAttempts: 0,
        runAgent: async () => {
          attempts += 1
          return { status: 'done', output: xmlOutput({ result: 'ok', artifacts: [malformed] }) }
        },
      })
    } catch (err) {
      caughtErr = err
    }

    assert.equal(attempts, 1, 'without a hook the malformed artifact reaches strict schema validation')
    assert.ok(caughtErr instanceof GateFailureError, `Expected GateFailureError, got ${caughtErr?.constructor?.name}`)
    const evidence = (caughtErr as GateFailureError).failure.evidence as { validation_errors?: string[] } | undefined
    assert.ok(evidence?.validation_errors?.some((error) => /schema error/u.test(error)))
  })

  it('accepts a valid artifact through the strict schema with no hook and writes no sidecar', async () => {
    const stateRoot = makeTempDir('wy-so-artifacts-')
    const artifactDirectory = await createTaskArtifactDirectory('task_no_hook_ok', stateRoot)
    const file = writeFileArtifact(artifactDirectory, 'ok.txt')

    const result = await collectStructuredOutput({
      profile: 'test',
      instructions: 'artifacts',
      outputSchema: ArtifactOutputSchema,
      timeoutMs: 1000,
      maxResumeAttempts: 0,
      runAgent: async () => ({ status: 'done', output: xmlOutput({ result: 'ok', artifacts: [validEntry(file)] }) }),
    })

    assert.deepEqual(result, { result: 'ok', artifacts: [validEntry(file)] })
    assert.equal(existsSync(join(artifactDirectory, ARTIFACT_VALIDATION_FILENAME)), false,
      'no hook means no artifact sanitization sidecar')
  })

  it('leaves the non-artifact collection path unchanged without a hook', async () => {
    const nonArtifactSchema = z.object({ label: z.string() })
    assert.equal(outputSchemaDeclaresArtifacts(nonArtifactSchema), false)

    const result = await collectStructuredOutput({
      profile: 'test',
      instructions: 'classify',
      outputSchema: nonArtifactSchema,
      timeoutMs: 1000,
      maxResumeAttempts: 0,
      runAgent: async () => ({ status: 'done', output: xmlOutput({ label: 'plain' }) }),
    })

    assert.deepEqual(result, { label: 'plain' })
  })
})

describe('outputSchemaDeclaresArtifacts — object and discriminated union coverage', () => {
  it('detects artifact declarations in object and discriminated-union output schemas', () => {
    assert.equal(outputSchemaDeclaresArtifacts(ArtifactOutputSchema), true)
    assert.equal(outputSchemaDeclaresArtifacts(z.object({ result: z.string() })), false)
    assert.equal(outputSchemaDeclaresArtifacts(UnionArtifactSchema), true)

    const noArtifacts = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), result: z.string() }),
      z.object({ kind: z.literal('count'), value: z.number() }),
    ])
    assert.equal(outputSchemaDeclaresArtifacts(noArtifacts), false)
  })
})
