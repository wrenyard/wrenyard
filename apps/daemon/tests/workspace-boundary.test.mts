import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

describe('workspace dependency boundary', () => {
  it('keeps lib/workspace independent from protocol, server, client, transport, and CLI layers', () => {
    const workspaceRoot = join(process.cwd(), 'lib', 'workspace')
    const forbiddenPath = /(^|\/|\\)(protocol|server|client|transport|bin)(\/|\\|\.mts$)/

    for (const file of listMtsFiles(workspaceRoot)) {
      const source = readFileSync(file, 'utf8')
      const importSpecifiers = [...source.matchAll(/\b(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1])

      for (const specifier of importSpecifiers) {
        const crossesWorkspaceBoundary = specifier.startsWith('../') || specifier.startsWith('..\\')
        assert(
          !(crossesWorkspaceBoundary && forbiddenPath.test(specifier)),
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
