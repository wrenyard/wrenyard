import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  describeTask,
  discoverTasks,
  getLoadErrors,
  listTasks,
  resetRegistry,
  resolveTaskTarget,
} from '../../lib/workspace/task-loader.mts'
import { invalidateProjectCache } from '../../lib/core/project/loader.mts'

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function registerProject(projectDir: string, name: string): void {
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${name}.fmproj`), `name: ${name}
description: test project
`, 'utf-8')
}

function taskSource(extraConfig = ''): string {
  return `export default defineTask({
  profile: 'test',
  permission: 'readonly',
${extraConfig}
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: () => 'probe',
})
`
}

function writeTaskFile(projectDir: string, name: string, extraConfig: string): string {
  const taskPath = join(projectDir, `${name}.task.ts`)
  writeFileSync(taskPath, taskSource(extraConfig), 'utf-8')
  return taskPath
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

describe('task definition categories', () => {
  it('assigns stable Chinese display labels to builtin daily task categories', async () => {
    const workspace = makeTempDir('foreman-category-builtin-')
    await discoverTasks(workspace)

    const tasks = listTasks(workspace)
    const categoryOf = (name: string): { id: string; displayLabel: string } | undefined =>
      tasks.find((task) => task.name === name)?.category

    assert.deepEqual(categoryOf('edit'), { id: 'edit', displayLabel: '编码' })
    assert.deepEqual(categoryOf('test'), { id: 'test', displayLabel: '测试' })
    assert.deepEqual(categoryOf('verify-fix'), { id: 'test', displayLabel: '测试' })
    assert.deepEqual(categoryOf('write-failing-test'), { id: 'test', displayLabel: '测试' })
    assert.deepEqual(categoryOf('code-review'), { id: 'code-review', displayLabel: '代码审查' })
    assert.deepEqual(categoryOf('conform-review'), { id: 'code-review', displayLabel: '代码审查' })
    assert.deepEqual(categoryOf('explore'), { id: 'explore', displayLabel: '代码探索' })
    assert.deepEqual(categoryOf('explore-code'), { id: 'explore', displayLabel: '代码探索' })
    assert.deepEqual(categoryOf('architect'), { id: 'architecture', displayLabel: '架构分析' })
    assert.deepEqual(categoryOf('oracle'), { id: 'architecture', displayLabel: '架构分析' })
    assert.deepEqual(categoryOf('commit'), { id: 'commit', displayLabel: '提交' })
    assert.deepEqual(categoryOf('librarian'), { id: 'research', displayLabel: '资料研究' })
    assert.deepEqual(categoryOf('deep-research-scope'), { id: 'research', displayLabel: '资料研究' })
  })

  it('flows a project category through list and describe summaries', async () => {
    const workspace = makeTempDir('foreman-category-flow-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeTaskFile(projectDir, 'categorised', '  category: { id: "edit", displayLabel: "编码" },\n')

    await discoverTasks(workspace)

    const listed = listTasks(workspace, 'app').find((task) => task.name === 'categorised')
    assert.ok(listed, 'categorised task should be listed')
    assert.deepEqual(listed.category, { id: 'edit', displayLabel: '编码' })

    const described = describeTask('categorised', workspace, 'app')
    assert.ok(described, 'categorised task should be describable')
    assert.deepEqual(described.category, { id: 'edit', displayLabel: '编码' })

    const target = resolveTaskTarget('categorised', workspace, 'app')
    assert.ok(target)
    assert.ok(target.definition.__type === 'task')
    assert.deepEqual(target.definition.config.category, { id: 'edit', displayLabel: '编码' })
  })

  it('keeps tasks without a category fully backwards compatible', async () => {
    const workspace = makeTempDir('foreman-category-absent-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeTaskFile(projectDir, 'plain', '')

    await discoverTasks(workspace)

    const listed = listTasks(workspace, 'app').find((task) => task.name === 'plain')
    assert.ok(listed, 'plain task should be listed')
    assert.equal(listed.category, undefined)
    const described = describeTask('plain', workspace, 'app')
    assert.equal(described?.category, undefined)
    assert.equal(getLoadErrors(workspace).length, 0)
  })

  it('fails definition validation for an invalid category id', async () => {
    const workspace = makeTempDir('foreman-category-badid-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    const taskPath = writeTaskFile(
      projectDir,
      'bad-category-id',
      '  category: { id: "Edit Task", displayLabel: "编码" },\n',
    )

    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('bad-category-id', workspace, 'app'), null)
    const errors = getLoadErrors(workspace)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].sourcePath, taskPath)
    assert.match(errors[0].load_error, /category\.id must match/u)
  })

  it('fails definition validation for an invalid displayLabel', async () => {
    const cases: Array<{ label: string; extra: string; expect: RegExp }> = [
      {
        label: 'empty after trimming',
        extra: '  category: { id: "edit", displayLabel: "   " },\n',
        expect: /displayLabel must be a non-empty string/u,
      },
      {
        label: 'multiline',
        extra: '  category: { id: "edit", displayLabel: "line one\\nline two" },\n',
        expect: /must not contain CR or LF/u,
      },
      {
        label: 'over 24 UTF-16 units',
        extra: `  category: { id: "edit", displayLabel: "${'x'.repeat(25)}" },\n`,
        expect: /must not exceed 24 UTF-16 code units/u,
      },
    ]

    for (const testCase of cases) {
      resetRegistry()
      invalidateProjectCache()
      const workspace = makeTempDir('foreman-category-badlabel-')
      const projectDir = join(workspace, 'projects', 'app')
      registerProject(projectDir, 'app')
      const taskPath = writeTaskFile(projectDir, 'bad-display', testCase.extra)
      await discoverTasks(workspace)
      assert.equal(resolveTaskTarget('bad-display', workspace, 'app'), null)
      const errors = getLoadErrors(workspace)
      assert.equal(errors.length, 1)
      assert.equal(errors[0].sourcePath, taskPath)
      assert.match(errors[0].load_error, testCase.expect)
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a category at exactly the displayLabel limit and trims whitespace', async () => {
    const workspace = makeTempDir('foreman-category-limit-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeTaskFile(
      projectDir,
      'limit-category',
      `  category: { id: "edit", displayLabel: "  ${'x'.repeat(24)}  " },\n`,
    )

    await discoverTasks(workspace)

    const listed = listTasks(workspace, 'app').find((task) => task.name === 'limit-category')
    assert.ok(listed, 'limit-category task should be listed')
    assert.deepEqual(listed.category, { id: 'edit', displayLabel: 'x'.repeat(24) })
    assert.equal(getLoadErrors(workspace).length, 0)
  })

  it('resolves the project category as the final overridden definition', async () => {
    const workspace = makeTempDir('foreman-category-override-')
    // A project that overrides the builtin `edit` task with its own category.
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')
    writeTaskFile(projectDir, 'edit', '  category: { id: "my-category", displayLabel: "我的分类" },\n')

    await discoverTasks(workspace)

    // Without project context the builtin category wins.
    const builtin = listTasks(workspace).find((task) => task.name === 'edit')
    assert.deepEqual(builtin?.category, { id: 'edit', displayLabel: '编码' })

    // With project context the final resolved (project) definition wins.
    const overridden = listTasks(workspace, 'app').find((task) => task.name === 'edit')
    assert.deepEqual(overridden?.category, { id: 'my-category', displayLabel: '我的分类' })
  })
})
