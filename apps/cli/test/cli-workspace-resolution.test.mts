import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { foremanPackageRoot, resolveWrenyardSuiteRoot } from '@wrenyard/daemon/layout/suite-root'

let tempDirs: string[] = []
let oldTestWorkDir: string | undefined
let oldWorkspace: string | undefined
let oldPath = ''

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeFakeGh(): string {
  const binDir = makeTempDir('foreman-cli-fake-gh-')
  const gh = join(binDir, process.platform === 'win32' ? 'gh.cmd' : 'gh')
  const body = process.platform === 'win32'
    ? '@echo off\r\nexit /b 0\r\n'
    : '#!/bin/sh\nexit 0\n'
  writeFileSync(gh, body, 'utf8')
  chmodSync(gh, 0o755)
  return binDir
}

function runForemanDoctor(env: NodeJS.ProcessEnv): string {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const binary = join(projectRoot, 'src', 'index.mts')
  const tsxBin = join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  const command = process.platform === 'win32' ? 'cmd' : tsxBin
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', tsxBin, binary, 'doctor']
    : [binary, 'doctor']
  return execFileSync(command, args, {
    encoding: 'utf-8',
    env,
  })
}

// WRENYARD_* spellings outrank the FOREMAN_* ones under test, so a developer
// shell exporting them must not leak into the resolution cases.
const OVERRIDING_KEYS = ['WRENYARD_WORKSPACE', 'WRENYARD_TEST_WORK_DIR', 'WRENYARD_WORK_DIR'] as const
let overridden: Partial<Record<(typeof OVERRIDING_KEYS)[number], string>> = {}

beforeEach(() => {
  oldTestWorkDir = process.env.FOREMAN_TEST_WORK_DIR
  oldWorkspace = process.env.FOREMAN_WORKSPACE
  oldPath = process.env.PATH ?? ''
  overridden = {}
  for (const key of OVERRIDING_KEYS) {
    if (process.env[key] !== undefined) overridden[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(overridden)) process.env[key] = value
  if (oldTestWorkDir === undefined) {
    delete process.env.FOREMAN_TEST_WORK_DIR
  } else {
    process.env.FOREMAN_TEST_WORK_DIR = oldTestWorkDir
  }

  if (oldWorkspace === undefined) {
    delete process.env.FOREMAN_WORKSPACE
  } else {
    process.env.FOREMAN_WORKSPACE = oldWorkspace
  }

  process.env.PATH = oldPath

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('foreman CLI workspace resolution', () => {
  it('keeps FOREMAN_WORKSPACE as the external workspace while suiteDir points to the monorepo', () => {
    const workspaceDir = makeTempDir('foreman-cli-workspace-')
    const fakeGhDir = makeFakeGh()
    delete process.env.FOREMAN_TEST_WORK_DIR
    process.env.FOREMAN_WORKSPACE = workspaceDir
    process.env.PATH = `${fakeGhDir}${delimiter}${oldPath}`
    mkdirSync(join(workspaceDir, '.git'), { recursive: true })
    const expectedSuiteDir = resolveWrenyardSuiteRoot({ packageRoot: foremanPackageRoot })

    const output = runForemanDoctor(process.env)

    assert.match(output, new RegExp(`Workspace: ${workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'))
    assert.match(output, new RegExp(`Suite: ${expectedSuiteDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'))
    assert.match(output, new RegExp(`Git repo OK \\(${expectedSuiteDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'u'))
    assert.doesNotMatch(output, new RegExp(`Git repo OK \\(${workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'u'))
    assert.doesNotMatch(output, /Git repo not found at C:\\Users\\someone\\Documents/u)
  })

  it('keeps FOREMAN_TEST_WORK_DIR above FOREMAN_WORKSPACE for the work dir', () => {
    const testWorkDir = makeTempDir('foreman-cli-test-workdir-')
    const workspaceDir = makeTempDir('foreman-cli-workspace-')
    const fakeGhDir = makeFakeGh()
    process.env.FOREMAN_TEST_WORK_DIR = testWorkDir
    process.env.FOREMAN_WORKSPACE = workspaceDir
    process.env.PATH = `${fakeGhDir}${delimiter}${oldPath}`
    mkdirSync(join(testWorkDir, '.git'), { recursive: true })
    const expectedSuiteDir = resolveWrenyardSuiteRoot({ packageRoot: foremanPackageRoot })

    const output = runForemanDoctor(process.env)

    assert.match(output, new RegExp(`Work dir: ${testWorkDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'))
    assert.doesNotMatch(output, new RegExp(`Work dir: ${workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'))
    assert.match(output, new RegExp(`Git repo OK \\(${expectedSuiteDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'u'))
    assert.doesNotMatch(output, new RegExp(`Git repo OK \\(${testWorkDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'u'))
  })
})
