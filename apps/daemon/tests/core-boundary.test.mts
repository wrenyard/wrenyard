import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

describe('core dependency boundary', () => {
  it('keeps lib/core independent from protocol, transport, client, and server layers', () => {
    const coreRoot = join(process.cwd(), 'lib', 'core')
    const forbiddenSpecifiers = [
      'node:net',
    ]
    const forbiddenPath = /(^|\/|\\)(protocol|transport|client|server)(\/|\\|\.mts$)/

    for (const file of listMtsFiles(coreRoot)) {
      const source = readFileSync(file, 'utf8')
      const importSpecifiers = [...source.matchAll(/\b(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1])

      for (const specifier of importSpecifiers) {
        const crossesCoreBoundary = specifier.startsWith('../') || specifier.startsWith('..\\')
        assert(
          !forbiddenSpecifiers.includes(specifier)
            && !(crossesCoreBoundary && forbiddenPath.test(specifier)),
          `${file} imports forbidden outer-layer dependency ${specifier}`,
        )
      }
    }
  })
})

function listMtsFiles(root: string): string[] {
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const absolute = join(root, entry)
    const stats = statSync(absolute)
    if (stats.isDirectory()) {
      files.push(...listMtsFiles(absolute))
      continue
    }
    if (absolute.endsWith('.mts')) files.push(absolute)
  }
  return files
}
