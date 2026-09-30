import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bundledSuiteRoot,
  readSuiteVersion,
  resolveWrenyardSuiteRoot,
  runningFromBundle,
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

test('from source the suite root is the checkout root', () => {
  assert.equal(runningFromBundle, false)
  assert.equal(existsSync(join(bundledSuiteRoot, 'contracts', 'versions.json')), true)
  assert.equal(existsSync(join(bundledSuiteRoot, 'apps', 'daemon', 'package.json')), true)
})

test('resolveWrenyardSuiteRoot validates the marker', () => {
  const suite = makeSuiteRoot()
  assert.equal(resolveWrenyardSuiteRoot({ suiteRoot: suite }), realpathSync(suite))
  assert.throws(() => resolveWrenyardSuiteRoot({ suiteRoot: tempDir('wrenyard-not-suite-') }), /missing contracts/)
})

test('readSuiteVersion prefers the SUITE_VERSION marker', () => {
  const root = makeSuiteRoot()
  writeFileSync(join(root, 'SUITE_VERSION'), '2.3.4\n', 'utf-8')
  writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}\n', 'utf-8')
  assert.equal(readSuiteVersion(root), '2.3.4')
})
