import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderTaskPromptTemplate,
  renderTaskPromptBindings,
  runWithTaskPromptCapture,
  withTaskPromptTemplates,
  getTaskPromptTemplates,
  type TaskPromptTemplate,
} from '../../lib/core/task/prompt-template.mts'

test('renderTaskPromptTemplate interpolates values between fragments', () => {
  const template: TaskPromptTemplate = {
    strings: ['Hello ', ', you are ', ' years old.'],
    label: 'greeting',
  }
  const result = renderTaskPromptTemplate(template, ['Ada', '36'])
  assert.equal(result, 'Hello Ada, you are 36 years old.')
})

test('renderTaskPromptTemplate handles undefined and null values', () => {
  const template: TaskPromptTemplate = { strings: ['a', 'b', 'c'] }
  const result = renderTaskPromptTemplate(template, [undefined, null])
  assert.equal(result, 'aundefinedbnullc')
})

test('renderTaskPromptTemplate handles Unicode values and fragments', () => {
  const template: TaskPromptTemplate = { strings: ['日本語', '→', '🌟'] }
  const result = renderTaskPromptTemplate(template, ['漢字', 'é'])
  assert.equal(result, '日本語漢字→é🌟')
})

test('renderTaskPromptTemplate preserves embedded markdown', () => {
  const template: TaskPromptTemplate = {
    strings: ['## Title\n\nRun `', '` with _', '_ emphasis.\n'],
    label: 'md',
  }
  const result = renderTaskPromptTemplate(template, ['ls -la', 'code'])
  assert.equal(result, '## Title\n\nRun `ls -la` with _code_ emphasis.\n')
})

test('renderTaskPromptTemplate handles empty fragments and values', () => {
  const template: TaskPromptTemplate = { strings: ['', '', ''] }
  const result = renderTaskPromptTemplate(template, ['', ''])
  assert.equal(result, '')
})

test('renderTaskPromptTemplate throws on arity mismatch (too few values)', () => {
  const template: TaskPromptTemplate = { strings: ['x', 'y', 'z'] }
  assert.throws(() => renderTaskPromptTemplate(template, ['only-one']), /Task prompt template arity mismatch/)
})

test('renderTaskPromptTemplate throws on arity mismatch (too many values)', () => {
  const template: TaskPromptTemplate = { strings: ['x', 'y'] }
  assert.throws(() => renderTaskPromptTemplate(template, ['a', 'b', 'c']), /Task prompt template arity mismatch/)
})

test('withTaskPromptTemplates returns the same callable and attaches static metadata', () => {
  let called = false
  const callback = (input: string): string => {
    called = true
    return input.toUpperCase()
  }
  const templates: TaskPromptTemplate[] = [{ strings: ['prefix ', ''], label: 'p' }]
  const wrapped = withTaskPromptTemplates(callback, templates)
  assert.equal(typeof wrapped, 'function')
  assert.deepEqual(getTaskPromptTemplates(wrapped), templates)
  assert.equal(called, false)
  assert.equal(wrapped('hi'), 'HI')
  assert.equal(called, true)
})

test('getTaskPromptTemplates returns [] for an unknown dynamic function', () => {
  const noop = () => 0
  assert.deepEqual(getTaskPromptTemplates(noop), [])
})

test('getTaskPromptTemplates returns [] for a non-function value', () => {
  assert.deepEqual(getTaskPromptTemplates(null), [])
  assert.deepEqual(getTaskPromptTemplates({}), [])
})

test('withTaskPromptTemplates preserves an async callback unchanged and callable', async () => {
  const asyncCallback = async (n: number): Promise<number> => n * 2
  const templates: TaskPromptTemplate[] = [{ strings: ['v=', ''], label: 'async' }]
  const wrapped = withTaskPromptTemplates(asyncCallback, templates)
  assert.equal(typeof wrapped, 'function')
  assert.deepEqual(getTaskPromptTemplates(wrapped), templates)
  assert.equal(await wrapped(21), 42)
})

test('all active builtins expose actual task body fragments without prompt execution', async () => {
  const { BUILTIN_TASKS } = await import('../../lib/standard/index.mts')
  const { taskInstructionTemplate } = await import('../../lib/daemon/services/task-settings-service.mts')
  for (const { name, definition } of BUILTIN_TASKS) {
    if (definition.config.scheduling === 'legacy') continue
    const templates = getTaskPromptTemplates(definition.config.prompt)
    assert.ok(templates.length > 0, `${name} has declared static templates`)
    const segments = taskInstructionTemplate(definition.config)
    assert.ok(segments.some((segment) => segment.kind === 'text' && segment.source.startsWith('task.prompt[')), name)
    for (const template of templates) assert.equal(template.labels?.length, template.strings.length - 1, name)
  }
})

test('settings preview never invokes an input-dependent callback and retains fallback for custom prompts', async () => {
  const { taskInstructionTemplate } = await import('../../lib/daemon/services/task-settings-service.mts')
  const callback = () => { throw new Error('preview must not execute') }
  const template = { strings: ['## Task\n', '\n## Steps\nRead the target.'], labels: ['目标输入'] }
  assert.deepEqual(taskInstructionTemplate({ prompt: callback }), [
    { kind: 'placeholder', source: 'task.prompt', label: '运行时根据任务输入生成任务提示' },
  ])
  const preview = taskInstructionTemplate({ prompt: withTaskPromptTemplates(callback, [template]) })
  assert.deepEqual(preview.map((segment) => segment.kind), ['text', 'placeholder', 'text'])
  assert.ok(preview.some((segment) => segment.kind === 'placeholder' && segment.label === '目标输入'))
})

// ─── Scoped execution rendering ───────────────────────────────────

test('buildTaskPrompt emits a stable prefix for the same builtin across different input and ctx', async () => {
  const { buildTaskPrompt } = await import('../../lib/core/task/prompt.mts')
  const definition = await loadBuiltin('edit')
  const first = await buildTaskPrompt(
    definition,
    { changes: [{ id: 'change-1', target: { kind: 'file', value: 'alpha.mts' }, action: 'update', instruction: 'A' }] },
    { note: 'first' },
  )
  const second = await buildTaskPrompt(
    definition,
    { changes: [{ id: 'change-2', target: { kind: 'file', value: 'omega.mts' }, action: 'remove', instruction: 'B' }] },
    { note: 'second', extra: true },
  )

  const stablePrefix = (prompt: string): string => prompt.slice(0, prompt.indexOf('<task-input-bindings>'))
  assert.equal(stablePrefix(first), stablePrefix(second))
  // The static instruction document is part of the prefix; the input-dependent
  // task body keeps its placeholder after the captured values.
  assert.ok(stablePrefix(first).includes('# Shell Usage'))
  assert.ok(stablePrefix(first).includes('You are an **Edit Executor**'))
  assert.ok(first.slice(first.indexOf('<task-input-bindings>')).includes('[[task-prompt:changes:0]] =\n'))
  assert.ok(first.includes('## Edit Instructions\n[[task-prompt:changes:0]]'))
})

test('buildTaskPrompt preserves original values once, at the parameter tail, without cross-task leakage', async () => {
  const { buildTaskPrompt } = await import('../../lib/core/task/prompt.mts')
  const definition = await loadBuiltin('edit')
  const first = await buildTaskPrompt(
    definition,
    { changes: [{ id: 'change-1', target: { kind: 'file', value: 'alpha.mts' }, action: 'update', instruction: 'A' }] },
  )
  const second = await buildTaskPrompt(
    definition,
    { changes: [{ id: 'change-2', target: { kind: 'file', value: 'omega.mts' }, action: 'remove', instruction: 'B' }] },
  )

  const bindings = first.slice(first.indexOf('<task-input-bindings>'))
  assert.ok(bindings.includes('[[task-prompt:changes:0]] ='))
  assert.ok(bindings.includes('alpha.mts'))
  assert.equal(first.split('alpha.mts').length - 1, 1)
  assert.equal(first.includes('omega.mts'), false)
  assert.equal(second.includes('alpha.mts'), false)
  assert.ok(second.includes('omega.mts'))
})

test('buildTaskPrompt keeps the task context after the static template and parameter tail', async () => {
  const { buildTaskPrompt } = await import('../../lib/core/task/prompt.mts')
  const definition = await loadBuiltin('edit')
  const prompt = await buildTaskPrompt(definition, { changes: [] }, { note: 'ctx-value' })

  const bindingsAt = prompt.indexOf('<task-input-bindings>')
  const contextAt = prompt.indexOf('<foreman-task-context>')
  const bodyAt = prompt.indexOf('You are an **Edit Executor**')
  assert.ok(bodyAt >= 0 && bindingsAt > bodyAt && contextAt > bindingsAt)
  assert.ok(prompt.includes('ctx-value'))
})

test('buildTaskPrompt keeps a custom prompt byte-exact and moves ctx after the body', async () => {
  const { buildTaskPrompt } = await import('../../lib/core/task/prompt.mts')
  const body = 'Custom body with [[task-prompt:looks-like-a-placeholder:0]] left untouched.'
  const definition = {
    __type: 'task' as const,
    config: {
      prompt: withTaskPromptTemplates(async () => body, [{ strings: ['x', 'y'], label: 'custom' }]),
      instructions: ['static instruction'],
    },
    sourcePath: 'lib/standard/tasks/custom.mts',
  }
  const prompt = await buildTaskPrompt(definition as never, {}, { note: 'ctx-value' })

  assert.equal(prompt.includes(body), true)
  assert.ok(prompt.indexOf(body) < prompt.indexOf('<foreman-task-context>'))
  assert.ok(prompt.indexOf('static instruction') < prompt.indexOf(body))
  assert.equal(prompt.includes('<task-input-bindings>'), false)
})

test('buildTaskPrompt isolates concurrent template captures per build', async () => {
  const { buildTaskPrompt } = await import('../../lib/core/task/prompt.mts')
  const slowTemplate = { strings: ['SLOW[', ']'], labels: ['slow'] }
  const fastTemplate = { strings: ['FAST[', ']'], labels: ['fast'] }
  const makeDefinition = (name: string, template: TaskPromptTemplate, delay: number) => ({
    __type: 'task' as const,
    config: {
      prompt: withTaskPromptTemplates(async () => {
        await new Promise((resolve) => setTimeout(resolve, delay))
        return renderTaskPromptTemplate(template, [`${name}-value`])
      }, [template]),
    },
    sourcePath: 'lib/standard/tasks/concurrent.mts',
  })

  const [slow, fast] = await Promise.all([
    buildTaskPrompt(makeDefinition('slow', slowTemplate, 25) as never, {}),
    buildTaskPrompt(makeDefinition('fast', fastTemplate, 1) as never, {}),
  ])

  assert.ok(slow.includes('SLOW[[[task-prompt:slow:0]]]'))
  assert.ok(slow.includes('slow-value'))
  assert.equal(slow.includes('fast-value'), false)
  assert.ok(fast.includes('FAST[[[task-prompt:fast:0]]]'))
  assert.ok(fast.includes('fast-value'))
  assert.equal(fast.includes('slow-value'), false)
})

test('runWithTaskPromptCapture falls back to dynamic rendering outside the scope', () => {
  const template: TaskPromptTemplate = { strings: ['v=', ''], labels: ['value'] }
  assert.equal(renderTaskPromptTemplate(template, ['direct']), 'v=direct')

  const { capture, result } = runWithTaskPromptCapture(() => renderTaskPromptTemplate(template, ['scoped']))
  assert.equal(result, 'v=[[task-prompt:value:0]]')
  assert.deepEqual(capture.values, ['scoped'])
  assert.equal(renderTaskPromptBindings(capture).includes('scoped'), true)
  assert.equal(renderTaskPromptTemplate(template, ['direct-after']), 'v=direct-after')
})

test('renderTaskPromptBindings escapes a closing wrapper tag without dropping content', () => {
  const template: TaskPromptTemplate = { strings: ['', ''], label: 'payload' }
  const { capture, result } = runWithTaskPromptCapture(() =>
    renderTaskPromptTemplate(template, ['before </task-input-bindings> after']))
  assert.equal(result, '[[task-prompt:payload:0]]')
  const bindings = renderTaskPromptBindings(capture)
  assert.ok(bindings.includes('<\\/task-input-bindings>'))
  assert.equal(bindings.split('before').length - 1, 1)
  assert.ok(bindings.includes('after'))
})

async function loadBuiltin(name: 'edit' | 'explore'): Promise<never> {
  const module = name === 'edit'
    ? await import('../../lib/standard/tasks/edit.mts')
    : await import('../../lib/standard/tasks/explore.mts')
  return module.default as never
}
