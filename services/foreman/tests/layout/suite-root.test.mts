import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  foremanPackageRoot,
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
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "services/*"\n', 'utf-8')
  writeFileSync(join(root, 'release-manifest.json'), '{"release":"test"}\n', 'utf-8')
  return root
}

test('foremanPackageRoot derives to the services/foreman package root', () => {
  assert.ok(foremanPackageRoot.endsWith('services/foreman'))
})

test('resolves the suite root upward from a nested package directory', () => {
  const suite = makeSuiteRoot()
  const nested = join(suite, 'services', 'foreman', 'lib', 'layout')
  mkdirSync(nested, { recursive: true })
  assert.equal(resolveWrenyardSuiteRoot({ packageRoot: nested }), realpathSync(suite))
})

test('WRENYARD_ROOT takes precedence over upward marker discovery', () => {
  const suite = makeSuiteRoot()
  const explicit = makeSuiteRoot()
  const resolved = resolveWrenyardSuiteRoot({
    packageRoot: suite,
    env: { WRENYARD_ROOT: explicit },
  })
  assert.equal(resolved, realpathSync(explicit))
})

test('rejects an explicit WRENYARD_ROOT that does not exist', () => {
  const missing = join(tempDir('wrenyard-missing-'), 'does-not-exist')
  assert.throws(
    () => resolveWrenyardSuiteRoot({ env: { WRENYARD_ROOT: missing } }),
    /WRENYARD_ROOT/u,
  )
})

test('rejects an explicit WRENYARD_ROOT that lacks suite markers', () => {
  const plain = tempDir('wrenyard-explicit-nomarkers-')
  assert.throws(
    () => resolveWrenyardSuiteRoot({ env: { WRENYARD_ROOT: plain } }),
    /WRENYARD_ROOT.*(pnpm-workspace\.yaml|release-manifest\.json)/u,
  )
})

test('rejects when no ancestor contains both suite markers', () => {
  const dir = tempDir('wrenyard-nomarkers-')
  assert.throws(
    () => resolveWrenyardSuiteRoot({ packageRoot: dir }),
    /pnpm-workspace\.yaml.*release-manifest\.json/u,
  )
})

test('resolveDependencyPackageRoot finds tsx under the installed pnpm workspace', () => {
  const tsxRoot = resolveDependencyPackageRoot(foremanPackageRoot, 'tsx')
  const pkg = JSON.parse(readFileSync(join(tsxRoot, 'package.json'), 'utf-8')) as { name?: unknown }
  assert.equal(pkg.name, 'tsx')
})

test('resolveDependencyPackageRoot finds pnpm when its package.json subpath is not exported', () => {
  const pnpmRoot = resolveDependencyPackageRoot(foremanPackageRoot, 'pnpm')
  const pkg = JSON.parse(readFileSync(join(pnpmRoot, 'package.json'), 'utf-8')) as {
    name?: unknown
    exports?: unknown
  }
  assert.equal(pkg.name, 'pnpm')
  assert.ok(pkg.exports !== undefined)
})
