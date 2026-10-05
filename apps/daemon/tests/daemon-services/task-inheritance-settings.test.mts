import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { TaskService } from '../../lib/core/task/service.mts'
import {
  discoverTasks,
  resetRegistry,
  resolveTaskTarget,
} from '../../lib/workspace/task-loader.mts'
import { invalidateProjectCache } from '../../lib/core/project/loader.mts'
import {
  resolveEffectiveTaskSettings,
  taskDefaultsToSettingsLayer,
} from '../../lib/config/task-settings.mts'

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function registerProject(projectDir: string, name: string): void {
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, `${name}.fmproj`),
    `name: ${name}\ndescription: test project\nhosts:\n  ${hostname()}: ${JSON.stringify(projectDir)}\n`,
    'utf-8',
  )
}

function writeFile(dir: string, name: string, source: string): string {
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${name}.task.ts`)
  writeFileSync(filePath, source, 'utf-8')
  return filePath
}

function fullSource(dispatch: string): string {
  return `export default defineTask({
  dispatch: { ${dispatch} },
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: () => 'IMG',
})
`
}

function inheritedSource(name: string, dispatch: string): string {
  return `export default defineTask({
  extends: '${name}',
  dispatch: { ${dispatch} },
})
`
}

beforeEach(() => {
  resetRegistry()
  invalidateProjectCache()
})

afterEach(() => {
  resetRegistry()
  invalidateProjectCache()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('task inheritance settings path', () => {
  it('merges inherited dispatch and lets a caller layer override the definition intelligence floor', async () => {
    const workspace = makeTempDir('wrenyard-inherit-settings-')
    const baseDir = join(workspace, 'projects', 'base')
    const childDir = join(workspace, 'projects', 'base', 'child')
    registerProject(baseDir, 'base')
    registerProject(childDir, 'child')
    writeFile(baseDir, 'img', fullSource("requiredCapabilities: ['image'], intelligenceMin: 'high'"))
    writeFile(
      childDir,
      'img',
      inheritedSource('img', "requiredCapabilities: [], intelligenceMin: 'mid'"),
    )

    await discoverTasks(workspace)

    const target = resolveTaskTarget('img', workspace, 'base/child')
    assert.ok(target, 'inherited img definition must resolve')
    const config = target.definition.config

    // The merge preserves the base hard requirements: an empty child capability
    // list does not clear 'image' and a child 'mid' cannot lower the 'high' floor.
    assert.deepEqual(config.dispatch?.requiredCapabilities, ['image'])
    assert.equal(config.dispatch?.intelligenceMin, 'high')

    // A caller layer overrides the definition's intelligence floor; required
    // capabilities stay a hard minimum.
    const builtinLayer = taskDefaultsToSettingsLayer({
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.dispatch !== undefined ? { dispatch: config.dispatch } : {}),
    })
    const effective = resolveEffectiveTaskSettings({
      builtin: builtinLayer,
      invocation: { dispatch: { requiredCapabilities: [], intelligenceMin: 'low' } },
    })
    assert.deepEqual(effective.dispatch.requiredCapabilities, ['image'])
    assert.equal(effective.dispatch.intelligenceMin, 'low')
    assert.equal(effective.sources.dispatch?.requiredCapabilities, 'builtin_task')
    assert.equal(effective.sources.dispatch?.intelligenceMin, 'invocation')
  })

  it('carries inherited metadata through the task service list projection', async () => {
    const workspace = makeTempDir('wrenyard-inherit-settings-list-')
    const baseDir = join(workspace, 'projects', 'base')
    const childDir = join(workspace, 'projects', 'base', 'child')
    registerProject(baseDir, 'base')
    registerProject(childDir, 'child')
    writeFile(baseDir, 'img', fullSource("requiredCapabilities: ['image']"))
    const childPath = writeFile(childDir, 'img', inheritedSource('img', 'requiredCapabilities: []'))

    const service = new TaskService({ workspaceRoot: workspace })
    const listed = (await service.list('base/child')).filter((item) => item.name === 'img')
    assert.equal(listed.length, 1)
    assert.ok(listed[0].inheritanceChain)
    assert.deepEqual(listed[0].inheritanceChain, [
      { source: 'project', project: 'base', path: join(baseDir, 'img.task.ts') },
      { source: 'project', project: 'base/child', path: childPath },
    ])
    assert.deepEqual(listed[0].dispatch?.requiredCapabilities, ['image'])
  })
})
