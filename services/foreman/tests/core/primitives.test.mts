import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  isForemanOperationName,
  listOperationDescriptors,
  operationRegistry,
} from '../../lib/core/operations/registry.mts'
import {
  createPrimitiveSet,
  isForemanPrimitiveName,
  listPrimitiveDescriptors,
  primitiveRegistry,
} from '../../lib/core/operations/primitives/registry.mts'

describe('operation primitives registry', () => {
  it('registers every supported Foreman operation in the core registry', () => {
    assert.deepEqual(
      Object.keys(operationRegistry).sort(),
      ['agent', 'checkpoint', 'llm', 'shell', 'task'],
    )
    assert.deepEqual(
      listOperationDescriptors().map((entry) => entry.name).sort(),
      ['agent', 'checkpoint', 'llm', 'shell', 'task'],
    )
    assert.equal(isForemanOperationName('task'), true)
    assert.equal(isForemanOperationName('missing'), false)
  })

  it('keeps primitives as a compatibility view of operations', () => {
    assert.deepEqual(
      Object.keys(primitiveRegistry).sort(),
      ['agent', 'checkpoint', 'llm', 'shell', 'task'],
    )
    assert.deepEqual(
      listPrimitiveDescriptors().map((entry) => entry.name).sort(),
      ['agent', 'checkpoint', 'llm', 'shell', 'task'],
    )
    assert.equal(isForemanPrimitiveName('task'), true)
    assert.equal(isForemanPrimitiveName('missing'), false)
  })

  it('creates primitive sets from the central runtime registry', () => {
    const primitives = createPrimitiveSet()
    assert.equal(typeof primitives.agent, 'function')
    assert.equal(typeof primitives.shell, 'function')
    assert.equal(typeof primitives.llm, 'function')
    assert.equal(typeof primitives.checkpoint, 'function')
  })

  it('does not keep legacy primitive or root-level Forge modules', () => {
    const legacyPrimitiveDir = join(process.cwd(), 'lib', 'v2', 'primi' + 'tives')
    const legacyPrimitiveFiles = ['agent.mts', 'llm.mts', 'shell.mts'].map((file) =>
      join(legacyPrimitiveDir, file),
    )
    const legacyForgeDirect = join(process.cwd(), 'lib', 'forge-' + 'direct-client.mts')
    const legacyForgeExec = join(process.cwd(), 'lib', 'forge-' + 'exec.mts')
    for (const file of legacyPrimitiveFiles) assert.equal(existsSync(file), false)
    assert.equal(existsSync(legacyForgeDirect), false)
    assert.equal(existsSync(legacyForgeExec), false)
  })

  it('keeps old primitive and Forge paths out of imports', () => {
    const roots = [join(process.cwd(), 'lib'), join(process.cwd(), 'tests'), join(process.cwd(), 'bin')]
    const forbidden = [
      'v2/primi' + 'tives',
      'v2\\primi' + 'tives',
      'forge-' + 'direct-client.mts',
      'forge-' + 'exec.mts',
    ]

    for (const root of roots) {
      for (const file of listSourceFiles(root)) {
        const source = readFileSync(file, 'utf8')
        for (const marker of forbidden) {
          assert.equal(source.includes(marker), false, `${file} still references ${marker}`)
        }
      }
    }
  })

  it('keeps Forge adapters behind the core primitives boundary', () => {
    const roots = [join(process.cwd(), 'lib'), join(process.cwd(), 'bin')]
    const allowed = [
      join(process.cwd(), 'lib', 'adapters', 'forge'),
      join(process.cwd(), 'lib', 'daemon', 'execution'),
    ]

    for (const root of roots) {
      for (const file of listSourceFiles(root)) {
        if (allowed.some((prefix) => file.startsWith(prefix))) continue
        const source = readFileSync(file, 'utf8')
        assert.equal(source.includes('adapters/forge'), false, `${file} imports Forge adapter directly`)
        assert.equal(source.includes('adapters\\forge'), false, `${file} imports Forge adapter directly`)
      }
    }
  })

  it('keeps core free of daemon and adapter imports', () => {
    const root = join(process.cwd(), 'lib', 'core')
    const forbidden = ['../daemon/', '../adapters/', '../../daemon/', '../../adapters/', 'adapters/']
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8')
      for (const marker of forbidden) {
        assert.equal(source.includes(marker), false, `${file} crosses the core dependency boundary`)
      }
    }
  })

  it('keeps core operations free of direct process execution', () => {
    const root = join(process.cwd(), 'lib', 'core', 'operations')
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, 'utf8')
      assert.equal(source.includes('node:child_process'), false, `${file} imports process execution directly`)
    }
  })
})

function listSourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry)
    const stats = statSync(absolute)
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(absolute))
      continue
    }
    if (absolute.endsWith('.mts') || absolute.endsWith('.ts')) files.push(absolute)
  }
  return files
}
