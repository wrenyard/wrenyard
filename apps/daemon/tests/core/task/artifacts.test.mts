import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { z } from 'zod'
import {
  createTaskArtifactDirectory,
  outputSchemaDeclaresArtifacts,
  readTaskArtifactErrors,
  taskArtifactPromptParagraph,
  validateTaskArtifacts,
} from '../../../lib/core/task/artifacts.mts'
import {
  MAX_TASK_ARTIFACTS,
  TaskArtifactSchema,
  TaskArtifactsSchema,
} from '../../../lib/core/task/schemas/artifacts.mts'
import { TestOutputSchema } from '../../../lib/standard/tasks/test.mts'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ARTIFACT_VALIDATION_FILENAME = '.artifact-validation.json'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function writePng(file: string): void {
  writeFileSync(file, Buffer.concat([PNG_MAGIC, Buffer.from([0, 0, 0, 0])]))
}

function validArtifact(path: string, overrides: Record<string, unknown> = {}) {
  return { path, kind: 'file', role: 'screenshot', description: 'a file', ...overrides }
}

describe('task artifact schema', () => {
  it('accepts a valid artifact and rejects invalid shape', () => {
    const parsed = TaskArtifactSchema.parse({
      path: '/tmp/a.png',
      kind: 'image',
      role: 'screenshot',
      description: 'evidence',
    })
    assert.equal(parsed.kind, 'image')

    assert.throws(() => TaskArtifactSchema.parse({
      path: 'relative/a.png', kind: 'image', role: 'screenshot', description: 'x',
    }))
    assert.throws(() => TaskArtifactSchema.parse({
      path: '/tmp/a.png', kind: 'image', role: '', description: 'x',
    }))
    assert.throws(() => TaskArtifactSchema.parse({
      path: '/tmp/a.png', kind: 'video', role: 'r', description: 'x',
    }))
    // strict: no extra fields
    assert.throws(() => TaskArtifactSchema.parse({
      path: '/tmp/a.png', kind: 'file', role: 'r', description: 'x', extra: true,
    }))
  })

  it('bounds the artifact array at 128 entries', () => {
    const entry = validArtifact('/tmp/a.txt')
    assert.equal(TaskArtifactsSchema.parse(Array.from({ length: MAX_TASK_ARTIFACTS }, () => entry)).length, MAX_TASK_ARTIFACTS)
    assert.throws(() => TaskArtifactsSchema.parse(Array.from({ length: MAX_TASK_ARTIFACTS + 1 }, () => entry)))
    assert.equal(MAX_TASK_ARTIFACTS, 128)
  })

})

describe('task artifact directory lifecycle', () => {
  it('creates <stateRoot>/artifacts/<id> and returns its real path', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const dir = await createTaskArtifactDirectory('task_abcd1234', stateRoot)
    // The real path accommodates the macOS /var -> /private alias.
    assert.equal(dir, join(realpathSync(stateRoot), 'artifacts', 'task_abcd1234'))
    assert.equal(existsSync(dir), true)
  })

  it('rejects task run ids that are not a single safe path segment', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    await assert.rejects(() => createTaskArtifactDirectory('../escape', stateRoot))
    await assert.rejects(() => createTaskArtifactDirectory('a/b', stateRoot))
    await assert.rejects(() => createTaskArtifactDirectory('..', stateRoot))
  })

})

describe('validateTaskArtifacts — containment', () => {
  it('keeps a file placed in the run artifact directory and preserves other fields', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const artifactDirectory = await createTaskArtifactDirectory('task_run1', stateRoot)
    const file = join(artifactDirectory, 'shot.png')
    writePng(file)

    const output = {
      evidences: [{ id: 'ev-1' }],
      assessments: [],
      artifacts: [validArtifact(file, { kind: 'image' })],
    }
    const result = await validateTaskArtifacts(output, artifactDirectory)
    assert.deepEqual(result.artifactErrors, [])
    const next = result.output as typeof output
    assert.equal(next.artifacts.length, 1)
    assert.deepEqual(next.evidences, output.evidences)
    assert.deepEqual(result.output, output)
  })

})

describe('validateTaskArtifacts — checkout symlink boundaries', () => {
})

describe('validateTaskArtifacts — entry checks', () => {
  it('strips a missing file and records a diagnostic', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const artifactDirectory = await createTaskArtifactDirectory('task_missing', stateRoot)
    const result = await validateTaskArtifacts(
      { artifacts: [validArtifact(join(artifactDirectory, 'nope.png'), { kind: 'image' })] },
      artifactDirectory,
    )
    assert.equal(result.artifactErrors.length, 1)
    assert.match(result.artifactErrors[0].reason, /does not exist/)
  })

  it('strips files larger than 64 MiB', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const artifactDirectory = await createTaskArtifactDirectory('task_big', stateRoot)
    const file = join(artifactDirectory, 'big.bin')
    writeFileSync(file, '')
    truncateSync(file, 64 * 1024 * 1024 + 1)

    const result = await validateTaskArtifacts(
      { artifacts: [validArtifact(file)] },
      artifactDirectory,
    )
    assert.equal(result.artifactErrors.length, 1)
    assert.match(result.artifactErrors[0].reason, /exceeds/)
  })

  it('strips a symlinked file that escapes the artifact directory', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const artifactDirectory = await createTaskArtifactDirectory('task_symlink', stateRoot)
    const outside = makeTempDir('wy-artifacts-outside-')
    const secret = join(outside, 'secret.png')
    writePng(secret)
    const link = join(artifactDirectory, 'link.png')
    symlinkSync(secret, link)

    const result = await validateTaskArtifacts(
      { artifacts: [validArtifact(link, { kind: 'image' })] },
      artifactDirectory,
    )
    assert.equal(result.artifactErrors.length, 1)
  })

  it('strips an image whose magic bytes are not a supported format', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const artifactDirectory = await createTaskArtifactDirectory('task_magic', stateRoot)
    const file = join(artifactDirectory, 'fake.png')
    writeFileSync(file, 'just text')

    const image = await validateTaskArtifacts(
      { artifacts: [validArtifact(file, { kind: 'image' })] },
      artifactDirectory,
    )
    assert.equal(image.artifactErrors.length, 1)
    assert.match(image.artifactErrors[0].reason, /PNG\/JPEG\/WebP\/GIF/)

    // The same file is a valid plain `file` artifact.
    const plain = await validateTaskArtifacts(
      { artifacts: [validArtifact(file)] },
      artifactDirectory,
    )
    assert.deepEqual(plain.artifactErrors, [])
  })
})

describe('validateTaskArtifacts — undeclared and malformed artifacts', () => {
  it('returns outputs without declared artifacts unchanged and writes no sidecar', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const artifactDirectory = await createTaskArtifactDirectory('task_none', stateRoot)
    const output = { evidences: [], assessments: [] }
    const result = await validateTaskArtifacts(output, artifactDirectory)
    assert.equal(result.output, output)
    assert.deepEqual(result.artifactErrors, [])
    assert.equal(existsSync(join(artifactDirectory, ARTIFACT_VALIDATION_FILENAME)), false)

    const raw = 'not an object'
    assert.equal((await validateTaskArtifacts(raw, artifactDirectory)).output, raw)
  })

  it('replaces a non-array artifacts field with an empty array and records a diagnostic', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const artifactDirectory = await createTaskArtifactDirectory('task_bad_shape', stateRoot)
    const result = await validateTaskArtifacts(
      { artifacts: 'nope', evidences: [] },
      artifactDirectory,
    )
    assert.equal(result.artifactErrors.length, 1)
    assert.deepEqual((result.output as { artifacts: unknown[] }).artifacts, [])
  })
})

describe('task artifact diagnostics readback', () => {
  it('persists diagnostics next to the artifacts and reads them back', async () => {
    const stateRoot = makeTempDir('wy-artifacts-root-')
    const artifactDirectory = await createTaskArtifactDirectory('task_diag', stateRoot)
    await validateTaskArtifacts(
      { artifacts: [validArtifact(join(artifactDirectory, 'missing.png'), { kind: 'image' })] },
      artifactDirectory,
    )

    assert.equal(existsSync(join(artifactDirectory, ARTIFACT_VALIDATION_FILENAME)), true)
    const byRun = readTaskArtifactErrors('task_diag', stateRoot)
    assert.equal(byRun.length, 1)
    assert.equal(typeof byRun[0].index, 'number')

    assert.deepEqual(readTaskArtifactErrors('task_absent', stateRoot), [])
  })
})

describe('task artifact prompt and schema detection', () => {
  it('emits a fixed English paragraph containing the absolute directory', () => {
    const paragraph = taskArtifactPromptParagraph('/state/artifacts/task_x')
    assert.match(paragraph, /## Artifacts/)
    assert.match(paragraph, /\/state\/artifacts\/task_x/)
    assert.match(paragraph, /`artifacts`/)
  })

  it('detects whether a schema declares artifacts', () => {
    assert.equal(outputSchemaDeclaresArtifacts(TestOutputSchema), true)
    assert.equal(outputSchemaDeclaresArtifacts(z.object({ result: z.string() })), false)
    assert.equal(outputSchemaDeclaresArtifacts(undefined), false)
  })

  it('detects artifacts declared in a union branch', () => {
    const withBranch = z.union([
      z.object({ result: z.string() }),
      z.object({ artifacts: z.array(z.string()) }),
    ])
    assert.equal(outputSchemaDeclaresArtifacts(withBranch), true)

    const withoutBranch = z.union([
      z.object({ result: z.string() }),
      z.object({ value: z.number() }),
    ])
    assert.equal(outputSchemaDeclaresArtifacts(withoutBranch), false)
  })

  it('detects artifacts in a discriminated union branch', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), result: z.string() }),
      z.object({ kind: z.literal('files'), artifacts: z.array(z.string()) }),
    ])
    assert.equal(outputSchemaDeclaresArtifacts(schema), true)

    const noArtifacts = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), result: z.string() }),
      z.object({ kind: z.literal('count'), value: z.number() }),
    ])
    assert.equal(outputSchemaDeclaresArtifacts(noArtifacts), false)
  })

  it('detects artifacts in an allOf intersection branch', () => {
    const schema = z.object({ result: z.string() }).and(z.object({ artifacts: z.array(z.string()) }))
    assert.equal(outputSchemaDeclaresArtifacts(schema), true)
  })

  it('resolves local $ref branches and terminates on recursive schemas', () => {
    interface Recursive {
      value?: string
      next?: Recursive
    }
    const recursive: z.ZodType<Recursive> = z.lazy(() =>
      z.object({ value: z.string().optional(), next: recursive.optional() }),
    )
    // `next` converts to `allOf: [{ $ref: "#" }]`, which cycles back to the
    // root; the guard must terminate and still report no artifacts.
    assert.equal(outputSchemaDeclaresArtifacts(recursive), false)

    interface RecursiveArtifacts {
      artifacts?: string[]
      next?: RecursiveArtifacts
    }
    const recursiveArtifacts: z.ZodType<RecursiveArtifacts> = z.lazy(() =>
      z.object({ artifacts: z.array(z.string()).optional(), next: recursiveArtifacts.optional() }),
    )
    assert.equal(outputSchemaDeclaresArtifacts(recursiveArtifacts), true)
  })

  it('yields a usable runtime artifact paragraph for union output schemas', () => {
    const schema = z.union([
      z.object({ result: z.string() }),
      z.object({ artifacts: z.array(z.string()) }),
    ])
    assert.equal(outputSchemaDeclaresArtifacts(schema), true)
    const paragraph = taskArtifactPromptParagraph('/state/artifacts/task_union')
    assert.match(paragraph, /\/state\/artifacts\/task_union/)
    assert.match(paragraph, /`artifacts`/)
  })
})

describe('builtin test task — optional artifacts output', () => {
  it('parses outputs with and without artifacts', () => {
    const without = TestOutputSchema.parse({ evidences: [], assessments: [] })
    assert.equal(without.artifacts, undefined)

    const withArtifacts = TestOutputSchema.parse({
      evidences: [],
      assessments: [],
      artifacts: [validArtifact('/tmp/a.png', { kind: 'image' })],
    })
    assert.equal(withArtifacts.artifacts?.length, 1)
  })

  it('rejects malformed artifact entries', () => {
    assert.throws(() => TestOutputSchema.parse({
      evidences: [],
      assessments: [],
      artifacts: [validArtifact('relative/a.png', { kind: 'image' })],
    }))
  })
})
