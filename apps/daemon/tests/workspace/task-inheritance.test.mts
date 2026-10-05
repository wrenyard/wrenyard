import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  describeTask,
  discoverTasks,
  ensureDiscovered,
  getLoadErrors,
  isPathStale,
  listTaskDefinitions,
  listTasks,
  markDirty,
  registerTaskFile,
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
  writeFileSync(join(projectDir, `${name}.fmproj`), `name: ${name}\ndescription: test project\n`, 'utf-8')
}

function writeFile(dir: string, name: string, source: string): string {
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${name}.task.ts`)
  writeFileSync(filePath, source, 'utf-8')
  return filePath
}

/** A complete (non-inherited) replacement definition. */
function fullSource(promptFn: string, extra = ''): string {
  return `export default defineTask({
${extra}  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: ${promptFn},
})
`
}

/** An inherited declaration whose `extends` matches its filename id. */
function inheritedSource(name: string, extra = ''): string {
  return `export default defineTask({
  extends: '${name}',
${extra}})
`
}

function configOf(name: string, workspace: string, project?: string) {
  const target = resolveTaskTarget(name, workspace, project)
  assert.ok(target, `expected '${name}' to resolve in project '${project ?? '<none>'}'`)
  return target.definition.config
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

describe('task definition inheritance', () => {
  it('rejects forbidden inherited fields including explicit undefined and unknown fields', async () => {
    const workspace = makeTempDir('wrenyard-inherit-fields-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')

    const cases: Array<{ name: string; extra: string; pattern: RegExp }> = [
      { name: 'bad-input', extra: '  input: foremanSchemas.z.object({}),\n', pattern: /declares 'input'/ },
      { name: 'bad-input-undefined', extra: '  input: undefined,\n', pattern: /declares 'input'/ },
      { name: 'bad-output', extra: '  output: foremanSchemas.z.object({}),\n', pattern: /declares 'output'/ },
      { name: 'bad-prompt', extra: "  prompt: () => '',\n", pattern: /declares 'prompt'/ },
      { name: 'bad-writeTargets', extra: '  writeTargets: () => [],\n', pattern: /declares 'writeTargets'/ },
      { name: 'bad-features', extra: "  features: { available: [] },\n", pattern: /declares 'features'/ },
      { name: 'bad-gates', extra: '  gates: {},\n', pattern: /declares 'gates'/ },
      { name: 'bad-scheduling', extra: "  scheduling: 'legacy',\n", pattern: /declares 'scheduling'/ },
      { name: 'bad-profile', extra: "  profile: 'p',\n", pattern: /declares 'profile'/ },
      { name: 'bad-agentRuntime', extra: "  agentRuntime: 'forge/x',\n", pattern: /declares 'agentRuntime'/ },
      { name: 'bad-permission', extra: "  permission: 'edit',\n", pattern: /declares 'permission'/ },
      { name: 'bad-unknown', extra: '  unknownField: 1,\n', pattern: /declares 'unknownField'/ },
    ]

    for (const testCase of cases) {
      writeFile(projectDir, testCase.name, inheritedSource(testCase.name, testCase.extra))
    }

    await discoverTasks(workspace)

    const errors = getLoadErrors(workspace)
    for (const testCase of cases) {
      assert.equal(resolveTaskTarget(testCase.name, workspace, 'app'), null, `${testCase.name} must not register`)
      assert.ok(
        errors.some((error) => error.load_error.match(testCase.pattern)),
        `${testCase.name} should record ${testCase.pattern}`,
      )
    }
  })

  it('rejects a cross-id extends, a missing base, empty extends, and standalone promptAppend', async () => {
    const workspace = makeTempDir('wrenyard-inherit-invalid-')
    const projectDir = join(workspace, 'projects', 'app')
    registerProject(projectDir, 'app')

    writeFile(projectDir, 'cross', inheritedSource('other'))
    writeFile(projectDir, 'orphan', inheritedSource('orphan'))
    writeFile(projectDir, 'empty-extends', `export default defineTask({\n  extends: '',\n})\n`)
    writeFile(projectDir, 'standalone-append', fullSource("() => 'x'", '  promptAppend: \'y\',\n'))

    await discoverTasks(workspace)

    const errors = getLoadErrors(workspace)
    assert.ok(errors.some((error) => /must exactly equal the definition file task id 'cross'/.test(error.load_error)))
    assert.ok(errors.some((error) => /no lower-scope ancestor or builtin/.test(error.load_error)))
    assert.ok(errors.some((error) => /extends must be a non-empty string/.test(error.load_error)))
    assert.ok(errors.some((error) => /promptAppend without extends/.test(error.load_error)))
    assert.equal(resolveTaskTarget('standalone-append', workspace, 'app'), null)
  })

  it('inherits schemas/writeTargets by reference and merges async prompts and instructions', async () => {
    const workspace = makeTempDir('wrenyard-inherit-merge-')
    registerProject(join(workspace, 'projects', 'base'), 'base')
    registerProject(join(workspace, 'projects', 'base', 'child'), 'child')

    const sharedFn = '() => []'
    writeFile(
      join(workspace, 'projects', 'base'),
      'doc',
      fullSource(
        "async () => 'BASE'",
        `  description: 'base doc',\n  displayName: 'Base Doc',\n  timeoutMs: 1234,\n  writeTargets: ${sharedFn},\n  instructions: ['shared', () => 'dyn'],\n`,
      ),
    )
    writeFile(
      join(workspace, 'projects', 'base', 'child'),
      'doc',
      inheritedSource(
        'doc',
        `  promptAppend: async () => 'CHILD',\n  instructions: ['shared', 'child-only'],\n  displayName: 'Child Doc',\n  description: 'child doc',\n  timeoutMs: 4321,\n  dispatch: { minimumTps: 5 },\n`,
      ),
    )

    await discoverTasks(workspace)

    const base = configOf('doc', workspace, 'base')
    const child = configOf('doc', workspace, 'base/child')

    // Inherited schemas/writeTargets keep base identity.
    assert.equal(child.input, base.input)
    assert.equal(child.output, base.output)
    assert.equal(child.writeTargets, base.writeTargets)

    // Base prompt evaluated once, then the fixed heading + append text.
    assert.equal(await child.prompt({}), 'BASE\n\n## Project task instructions\n\nCHILD')

    // Stable dedupe: base 'shared' + base fn + child 'shared' + child 'child-only'.
    assert.deepEqual(
      child.instructions?.map((entry) => (typeof entry === 'string' ? entry : 'fn')),
      ['shared', 'fn', 'child-only'],
    )

    // Child metadata overrides only when supplied.
    assert.equal(child.displayName, 'Child Doc')
    assert.equal(child.description, 'child doc')
    assert.equal(child.timeoutMs, 4321)
    assert.equal(child.dispatch?.minimumTps, 5)
  })

  it('exposes one effective id with inherited metadata and a base→effective chain', async () => {
    const workspace = makeTempDir('wrenyard-inherit-meta-')
    const baseDir = join(workspace, 'projects', 'base')
    const childDir = join(workspace, 'projects', 'base', 'child')
    registerProject(baseDir, 'base')
    registerProject(childDir, 'child')
    writeFile(baseDir, 'doc', fullSource("() => 'BASE'"))
    const childPath = writeFile(childDir, 'doc', inheritedSource('doc', `  promptAppend: 'CHILD',\n`))

    await discoverTasks(workspace)

    const listed = listTasks(workspace, 'base/child').filter((task) => task.name === 'doc')
    assert.equal(listed.length, 1)
    assert.ok(listed[0].inheritanceChain)
    assert.deepEqual(listed[0].inheritanceChain, [
      { source: 'project', project: 'base', path: join(baseDir, 'doc.task.ts') },
      { source: 'project', project: 'base/child', path: childPath },
    ])

    const described = describeTask('doc', workspace, 'base/child')
    assert.ok(described?.inheritanceChain)
    assert.deepEqual(described?.inheritanceChain?.map((entry) => entry.project), ['base', 'base/child'])

    const definitions = listTaskDefinitions(workspace, 'base/child').filter((entry) => entry.name === 'doc')
    assert.equal(definitions.length, 1)
    assert.ok(definitions[0].inheritanceChain)
    assert.equal(definitions[0].inheritanceChain?.length, 2)
  })

  it('layers builtin → ancestor project → nearest project in prompt order', async () => {
    const workspace = makeTempDir('wrenyard-inherit-layers-')
    registerProject(join(workspace, 'projects', 'base'), 'base')
    registerProject(join(workspace, 'projects', 'base', 'child'), 'child')
    writeFile(join(workspace, 'projects', 'base'), 'edit', inheritedSource('edit', `  promptAppend: 'ANCESTOR',\n`))
    writeFile(
      join(workspace, 'projects', 'base', 'child'),
      'edit',
      inheritedSource('edit', `  promptAppend: 'NEAREST',\n`),
    )

    await discoverTasks(workspace)

    const child = configOf('edit', workspace, 'base/child')
    const promptText = await child.prompt({})
    const ancestorIndex = promptText.indexOf('\n\n## Project task instructions\n\nANCESTOR')
    const nearestIndex = promptText.indexOf('\n\n## Project task instructions\n\nNEAREST')
    assert.ok(ancestorIndex >= 0, 'ancestor append present')
    assert.ok(nearestIndex > ancestorIndex, 'nearest append ordered after ancestor')
    assert.ok(promptText.endsWith('\n\n## Project task instructions\n\nNEAREST'))

    const described = describeTask('edit', workspace, 'base/child')
    assert.deepEqual(described?.inheritanceChain, [
      { source: 'builtin', path: '(builtin)' },
      { source: 'project', project: 'base', path: join(workspace, 'projects', 'base', 'edit.task.ts') },
      { source: 'project', project: 'base/child', path: join(workspace, 'projects', 'base', 'child', 'edit.task.ts') },
    ])
  })

  it('resolves a builtin fallback and keeps no-extends definitions as full replacements', async () => {
    const workspace = makeTempDir('wrenyard-inherit-builtin-')
    const appDir = join(workspace, 'projects', 'app')
    registerProject(appDir, 'app')
    writeFile(appDir, 'edit', inheritedSource('edit', `  promptAppend: 'APP EDIT',\n`))
    writeFile(appDir, 'explore', fullSource("() => 'CUSTOM EXPLORE'"))

    await discoverTasks(workspace)

    const edit = configOf('edit', workspace, 'app')
    assert.ok((await edit.prompt({})).endsWith('\n\n## Project task instructions\n\nAPP EDIT'))
    const describedEdit = describeTask('edit', workspace, 'app')
    assert.ok(describedEdit?.inheritanceChain)
    assert.deepEqual(describedEdit?.inheritanceChain, [
      { source: 'builtin', path: '(builtin)' },
      { source: 'project', project: 'app', path: join(appDir, 'edit.task.ts') },
    ])

    // No `extends` means a whole replacement: no inherited metadata.
    const explore = configOf('explore', workspace, 'app')
    assert.equal(await explore.prompt({}), 'CUSTOM EXPLORE')
    assert.equal(describeTask('explore', workspace, 'app')?.inheritanceChain, undefined)
    assert.equal(describeTask('explore', workspace, 'app')?.inheritanceChain, undefined)
  })

  it('recomputes descendants on parent edit, removal, and reinsertion with last-good safety', async () => {
    const workspace = makeTempDir('wrenyard-inherit-refresh-')
    const parentDir = join(workspace, 'projects', 'p')
    const childDir = join(workspace, 'projects', 'p', 'c')
    registerProject(parentDir, 'p')
    registerProject(childDir, 'c')
    const basePath = writeFile(parentDir, 'thing', fullSource("() => 'V1'"))
    const childPath = writeFile(childDir, 'thing', inheritedSource('thing', `  promptAppend: 'CHILD',\n`))

    await discoverTasks(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'V1\n\n## Project task instructions\n\nCHILD')
    assert.equal(getLoadErrors(workspace).length, 0)

    // Parent edit propagates to the descendant.
    writeFile(parentDir, 'thing', fullSource("() => 'V2'"))
    markDirty(workspace)
    await ensureDiscovered(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'V2\n\n## Project task instructions\n\nCHILD')
    assert.equal(getLoadErrors(workspace).length, 0)

    // Parent removal keeps the last-good resolved descendant and marks it stale.
    rmSync(basePath, { force: true })
    markDirty(workspace)
    await ensureDiscovered(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'V2\n\n## Project task instructions\n\nCHILD')
    assert.equal(isPathStale(childPath, workspace), true)
    assert.ok(getLoadErrors(workspace).some((error) => error.sourcePath === childPath))

    // Reinsertion recomputes cleanly.
    writeFile(parentDir, 'thing', fullSource("() => 'V3'"))
    markDirty(workspace)
    await ensureDiscovered(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'V3\n\n## Project task instructions\n\nCHILD')
    assert.equal(getLoadErrors(workspace).filter((error) => error.sourcePath === childPath).length, 0)
  })

  it('resolves inheritance through a direct registerTaskFile call', async () => {
    const workspace = makeTempDir('wrenyard-inherit-direct-')
    const parentDir = join(workspace, 'projects', 'p')
    const childDir = join(workspace, 'projects', 'p', 'c')
    registerProject(parentDir, 'p')
    registerProject(childDir, 'c')
    writeFile(parentDir, 'thing', fullSource("() => 'DIRECT'"))

    await discoverTasks(workspace)

    const childPath = writeFile(childDir, 'thing', inheritedSource('thing', `  promptAppend: 'C',\n`))
    const entry = await registerTaskFile(childPath, workspace)
    assert.ok(entry.inheritanceChain)
    assert.equal(await entry.definition.config.prompt({}), 'DIRECT\n\n## Project task instructions\n\nC')
    assert.deepEqual(entry.inheritanceChain?.map((layer) => layer.source), ['project', 'project'])
  })

  it('clamps an inherited intelligenceExpected up to a child-raised intelligenceMin floor', async () => {
    const workspace = makeTempDir('wrenyard-inherit-clamp-')
    const appDir = join(workspace, 'projects', 'app')
    registerProject(appDir, 'app')
    writeFile(
      appDir,
      'edit',
      inheritedSource('edit', `  dispatch: { intelligenceMin: 'high' },\n  promptAppend: 'MIN',\n`),
    )

    await discoverTasks(workspace)

    const edit = configOf('edit', workspace, 'app')
    assert.equal(edit.dispatch?.intelligenceMin, 'high')
    assert.equal(edit.dispatch?.intelligenceExpected, 'high')
    assert.ok((await edit.prompt({})).endsWith('\n\n## Project task instructions\n\nMIN'))
  })

  it('rejects a child that explicitly supplies an expected below the merged floor', async () => {
    const workspace = makeTempDir('wrenyard-inherit-expected-')
    const appDir = join(workspace, 'projects', 'app')
    registerProject(appDir, 'app')

    const childPath = writeFile(
      appDir,
      'edit',
      inheritedSource('edit', `  dispatch: { intelligenceMin: 'high', intelligenceExpected: 'mid' },\n`),
    )

    await discoverTasks(workspace)

    assert.ok(getLoadErrors(workspace).some((error) => error.sourcePath === childPath))
    // No live inherited definition: the valid builtin remains the effective one.
    const described = describeTask('edit', workspace, 'app')
    assert.equal(described?.inheritanceChain, undefined)
    assert.equal(described?.inheritanceChain, undefined)
    assert.equal(described?.dispatch?.intelligenceMin, 'low')
    assert.equal(described?.dispatch?.intelligenceExpected, 'mid')
  })

  it('rejects a child that explicitly supplies expected as undefined below the merged floor', async () => {
    const workspace = makeTempDir('wrenyard-inherit-expected-undefined-')
    const appDir = join(workspace, 'projects', 'app')
    registerProject(appDir, 'app')
    const childPath = writeFile(
      appDir,
      'edit',
      inheritedSource('edit', `  dispatch: { intelligenceMin: 'high', intelligenceExpected: undefined },\n`),
    )

    await discoverTasks(workspace)

    assert.ok(getLoadErrors(workspace).some((error) => error.sourcePath === childPath))
    const described = describeTask('edit', workspace, 'app')
    assert.equal(described?.inheritanceChain, undefined)
    assert.equal(described?.dispatch?.intelligenceMin, 'low')
    assert.equal(described?.dispatch?.intelligenceExpected, 'mid')
  })

  it('retains last-good config and chain when an edited inherited declaration fails to merge', async () => {
    const workspace = makeTempDir('wrenyard-inherit-lastgood-')
    const parentDir = join(workspace, 'projects', 'p')
    const childDir = join(workspace, 'projects', 'p', 'c')
    registerProject(parentDir, 'p')
    registerProject(childDir, 'c')
    writeFile(
      parentDir,
      'thing',
      `export default defineTask({
  dispatch: { intelligenceMin: 'high' },
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: async () => 'BASE',
  writeTargets: () => [],
})
`,
    )
    const childPath = writeFile(childDir, 'thing', inheritedSource('thing', `  promptAppend: 'CHILD',\n`))

    await discoverTasks(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'BASE\n\n## Project task instructions\n\nCHILD')

    // Edit the child so the raw declaration is valid alone but the merged
    // dispatch is invalid (explicit mid below the parent min high floor).
    writeFile(
      childDir,
      'thing',
      inheritedSource('thing', `  promptAppend: 'CHILD',\n  dispatch: { intelligenceExpected: 'mid' },\n`),
    )
    markDirty(workspace)
    await ensureDiscovered(workspace)

    // The old prompt/writeTargets config and chain survive; the child is stale.
    const degraded = configOf('thing', workspace, 'p/c')
    assert.equal(await degraded.prompt({}), 'BASE\n\n## Project task instructions\n\nCHILD')
    assert.equal(typeof degraded.writeTargets, 'function')
    const degradedDescription = describeTask('thing', workspace, 'p/c')
    assert.ok(degradedDescription?.inheritanceChain)
    assert.deepEqual(degradedDescription?.inheritanceChain?.map((layer) => layer.project), ['p', 'p/c'])
    assert.equal(isPathStale(childPath, workspace), true)

    // A corrected child heals and clears the stale marker.
    writeFile(childDir, 'thing', inheritedSource('thing', `  promptAppend: 'HEALED',\n  dispatch: { intelligenceMin: 'high' },\n`))
    markDirty(workspace)
    await ensureDiscovered(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'BASE\n\n## Project task instructions\n\nHEALED')
    assert.equal(isPathStale(childPath, workspace), false)
  })

  it('retains a prior full replacement config when it is edited into a failing inherited declaration', async () => {
    const workspace = makeTempDir('wrenyard-inherit-full-to-inherit-lastgood-')
    const parentDir = join(workspace, 'projects', 'p')
    const childDir = join(workspace, 'projects', 'p', 'c')
    registerProject(parentDir, 'p')
    registerProject(childDir, 'c')
    writeFile(
      parentDir,
      'thing',
      `export default defineTask({
  dispatch: { intelligenceMin: 'high' },
  input: foremanSchemas.z.object({}),
  output: foremanSchemas.z.object({ result: foremanSchemas.z.string() }),
  prompt: async () => 'BASE',
  writeTargets: () => [],
})
`,
    )

    // The child starts as a full replacement (no inheritance) with its own
    // prompt, schemas, and writeTargets distinct from the parent.
    const childPath = writeFile(
      childDir,
      'thing',
      `export default defineTask({
  input: foremanSchemas.z.object({ original: foremanSchemas.z.string() }),
  output: foremanSchemas.z.object({ answer: foremanSchemas.z.number() }),
  prompt: async () => 'ORIGINAL',
  writeTargets: () => ['original'],
})
`,
    )

    await discoverTasks(workspace)

    const original = configOf('thing', workspace, 'p/c')
    const originalInput = original.input
    const originalOutput = original.output
    const originalWriteTargets = original.writeTargets
    assert.equal(await original.prompt({}), 'ORIGINAL')
    const originalDescription = describeTask('thing', workspace, 'p/c')
    assert.equal(originalDescription?.inheritanceChain, undefined)
    assert.equal(originalDescription?.inheritanceChain, undefined)

    // Edit the child into an inherited declaration whose raw dispatch is valid
    // alone but whose final merge is invalid (explicit mid below the parent
    // intelligenceMin high floor). The prior full config must survive.
    writeFile(childDir, 'thing', inheritedSource('thing', `  dispatch: { intelligenceExpected: 'mid' },\n`))
    markDirty(workspace)
    await ensureDiscovered(workspace)

    const degraded = configOf('thing', workspace, 'p/c')
    assert.equal(await degraded.prompt({}), 'ORIGINAL')
    assert.equal(degraded.input, originalInput)
    assert.equal(degraded.output, originalOutput)
    assert.equal(degraded.writeTargets, originalWriteTargets)
    const degradedDescription = describeTask('thing', workspace, 'p/c')
    assert.equal(degradedDescription?.inheritanceChain, undefined)
    assert.equal(degradedDescription?.inheritanceChain, undefined)
    assert.equal(isPathStale(childPath, workspace), true)
    const listed = listTasks(workspace, 'p/c').filter((task) => task.name === 'thing')
    assert.equal(listed.length, 1)
    assert.equal(listed[0].path, childPath)

    // A corrected inherited declaration heals and clears the stale marker.
    writeFile(childDir, 'thing', inheritedSource('thing', `  promptAppend: 'HEALED',\n  dispatch: { intelligenceExpected: 'high' },\n`))
    markDirty(workspace)
    await ensureDiscovered(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'BASE\n\n## Project task instructions\n\nHEALED')
    const healedDescription = describeTask('thing', workspace, 'p/c')
    assert.ok(healedDescription?.inheritanceChain)
    assert.deepEqual(healedDescription?.inheritanceChain?.map((layer) => layer.project), ['p', 'p/c'])
    assert.equal(isPathStale(childPath, workspace), false)
  })

  it('never exposes a first-load unresolved orphan and resolves after a later base insert', async () => {
    const workspace = makeTempDir('wrenyard-inherit-orphan-')
    const parentDir = join(workspace, 'projects', 'p')
    const childDir = join(workspace, 'projects', 'p', 'c')
    registerProject(parentDir, 'p')
    registerProject(childDir, 'c')
    const childPath = writeFile(childDir, 'thing', inheritedSource('thing', `  promptAppend: 'CHILD',\n`))

    await discoverTasks(workspace)

    assert.equal(resolveTaskTarget('thing', workspace, 'p/c'), null)
    assert.equal(describeTask('thing', workspace, 'p/c'), null)
    assert.equal(listTasks(workspace, 'p/c').some((task) => task.name === 'thing'), false)
    assert.ok(getLoadErrors(workspace).some((error) => error.sourcePath === childPath))

    writeFile(parentDir, 'thing', fullSource("() => 'BASE'"))
    markDirty(workspace)
    await ensureDiscovered(workspace)
    const resolved = configOf('thing', workspace, 'p/c')
    assert.equal(await resolved.prompt({}), 'BASE\n\n## Project task instructions\n\nCHILD')
  })

  it('falls back to a valid builtin when a first-loaded override is merge-invalid', async () => {
    const workspace = makeTempDir('wrenyard-inherit-builtin-invalid-')
    const appDir = join(workspace, 'projects', 'app')
    registerProject(appDir, 'app')
    const childPath = writeFile(
      appDir,
      'edit',
      inheritedSource('edit', `  dispatch: { intelligenceMin: 'high', intelligenceExpected: undefined },\n`),
    )

    await discoverTasks(workspace)

    assert.ok(getLoadErrors(workspace).some((error) => error.sourcePath === childPath))
    const described = describeTask('edit', workspace, 'app')
    assert.equal(described?.inheritanceChain, undefined)
    assert.equal(described?.dispatch?.intelligenceMin, 'low')
    assert.equal(described?.dispatch?.intelligenceExpected, 'mid')
  })

  it('stales descendants when a parent fails to reload instead of executing the prior parent', async () => {
    const workspace = makeTempDir('wrenyard-inherit-parentfail-')
    const parentDir = join(workspace, 'projects', 'p')
    const childDir = join(workspace, 'projects', 'p', 'c')
    registerProject(parentDir, 'p')
    registerProject(childDir, 'c')
    writeFile(parentDir, 'thing', fullSource("() => 'V1'"))
    const childPath = writeFile(childDir, 'thing', inheritedSource('thing', `  promptAppend: 'CHILD',\n`))

    await discoverTasks(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'V1\n\n## Project task instructions\n\nCHILD')

    // Parent becomes invalid: it has an input schema but no output schema.
    writeFile(parentDir, 'thing', `export default defineTask({\n  input: foremanSchemas.z.object({}),\n})\n`)
    markDirty(workspace)
    await ensureDiscovered(workspace)

    // Descendant keeps its last-good prompt/schema/chain and is marked stale.
    const degraded = configOf('thing', workspace, 'p/c')
    assert.equal(await degraded.prompt({}), 'V1\n\n## Project task instructions\n\nCHILD')
    const described = describeTask('thing', workspace, 'p/c')
    assert.ok(described?.inheritanceChain)
    assert.deepEqual(described?.inheritanceChain?.map((layer) => layer.source), ['project', 'project'])
    assert.equal(isPathStale(childPath, workspace), true)

    // Correcting the parent recovers the descendant.
    writeFile(parentDir, 'thing', fullSource("() => 'V2'"))
    markDirty(workspace)
    await ensureDiscovered(workspace)
    assert.equal(await configOf('thing', workspace, 'p/c').prompt({}), 'V2\n\n## Project task instructions\n\nCHILD')
    assert.equal(isPathStale(childPath, workspace), false)
  })

  it('resolves a builtin-extending child via registerTaskFile in a fresh registry', async () => {
    const workspace = makeTempDir('wrenyard-inherit-fresh-direct-')
    const appDir = join(workspace, 'projects', 'app')
    registerProject(appDir, 'app')
    const childPath = writeFile(appDir, 'edit', inheritedSource('edit', `  promptAppend: 'FRESH',\n`))

    // No discoverTasks: register directly into a fresh registry.
    resetRegistry(workspace)
    const entry = await registerTaskFile(childPath, workspace)
    assert.ok(entry.inheritanceChain)
    assert.ok((await entry.definition.config.prompt({})).endsWith('\n\n## Project task instructions\n\nFRESH'))
    assert.deepEqual(entry.inheritanceChain?.map((layer) => layer.source), ['builtin', 'project'])
  })

  it('throws on a non-string promptAppend result and treats an empty append as a no-op', async () => {
    const workspace = makeTempDir('wrenyard-inherit-append-')
    const appDir = join(workspace, 'projects', 'app')
    registerProject(appDir, 'app')
    writeFile(appDir, 'edit', inheritedSource('edit', `  promptAppend: async () => 123,\n`))

    await discoverTasks(workspace)
    const bad = configOf('edit', workspace, 'app')
    await assert.rejects(async () => bad.prompt({}), /promptAppend must resolve to a string/)

    // An explicit empty string is a no-op that preserves the base prompt.
    writeFile(appDir, 'edit', inheritedSource('edit', `  promptAppend: '',\n`))
    markDirty(workspace)
    await ensureDiscovered(workspace)
    const empty = configOf('edit', workspace, 'app')
    const text = await empty.prompt({})
    assert.ok(!text.includes('## Project task instructions'))
  })
})
