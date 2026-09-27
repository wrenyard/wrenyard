import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  foremanPackageRoot,
  readSuiteVersion,
  resolveDependencyPackageRoot,
  resolveWrenyardSuiteRoot,
} from '../../lib/layout/suite-root.mts'

const tempDirs: string[] = []
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeSuiteRoot(): string {
  const root = tempDir('wrenyard-suite-')
  mkdirSync(join(root, 'contracts'), { recursive: true })
  writeFileSync(
    join(root, 'contracts', 'versions.json'),
    '{"schema_version":"wrenyard.contract-versions.v1"}\n',
    'utf-8',
  )
  return root
}

test('resolves the suite root upward from a nested package directory', () => {
  const suite = makeSuiteRoot()
  const nested = join(suite, 'apps', 'daemon', 'lib', 'layout')
  mkdirSync(nested, { recursive: true })
  assert.equal(resolveWrenyardSuiteRoot({ packageRoot: nested, env: {} }), realpathSync(suite))
})

test('readSuiteVersion prefers the SUITE_VERSION marker', () => {
  const root = makeSuiteRoot()
  writeFileSync(join(root, 'SUITE_VERSION'), '2.3.4\n', 'utf-8')
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}\n', 'utf-8')
  assert.equal(readSuiteVersion(root), '2.3.4')
})

test('resolveDependencyPackageRoot finds tsx under the installed pnpm workspace', () => {
  const tsxRoot = resolveDependencyPackageRoot(foremanPackageRoot, 'tsx')
  const pkg = JSON.parse(readFileSync(join(tsxRoot, 'package.json'), 'utf-8')) as { name?: unknown }
  assert.equal(pkg.name, 'tsx')
})
