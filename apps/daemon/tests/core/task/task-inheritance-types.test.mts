import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import type {
  DefineTask,
  TaskConfig,
  TaskInheritedDeclaration,
} from '../../../lib/types.mts'
import { installRuntimeGlobals } from '../../../lib/daemon/execution/runtime-globals.mts'

// Compile-time assertion surface: `DefineTask` has one overload for a complete
// TaskConfig and one for an inherited declaration. Excess-property checking on
// each overload rejects mixed/forbidden shapes. The stub is only a runtime host
// for the type-checked calls.
const defineTaskFn = ((config: unknown) => ({
  __type: 'task',
  config,
  sourcePath: '',
})) as unknown as DefineTask

describe('inherited declaration authoring types', () => {
  it('accepts a valid inherited declaration and a valid full config', () => {
    defineTaskFn({ extends: 'edit' })

    const declaration: TaskInheritedDeclaration = {
      extends: 'edit',
      promptAppend: 'extra',
      instructions: ['doc'],
      dispatch: { minimumTps: 3 },
      timeoutMs: 1000,
      displayName: 'Display',
      description: 'description',
      category: { id: 'edit', displayLabel: 'Editing' },
    }
    defineTaskFn(declaration)

    const full: TaskConfig = {
      input: z.object({}),
      output: z.object({}),
      prompt: () => '',
    }
    defineTaskFn(full)
    assert.ok(true)
  })

  it('rejects forbidden/unknown inherited fields at the type level', () => {
    // @ts-expect-error inherited definitions cannot declare input
    defineTaskFn({ extends: 'edit', input: z.object({}) })
    // @ts-expect-error inherited definitions cannot redeclare output
    defineTaskFn({ extends: 'edit', output: z.object({}) })
    // @ts-expect-error inherited definitions cannot redeclare prompt
    defineTaskFn({ extends: 'edit', prompt: () => '' })
    // @ts-expect-error inherited definitions cannot declare writeTargets
    defineTaskFn({ extends: 'edit', writeTargets: () => [] })
    // @ts-expect-error inherited definitions reject unknown fields
    defineTaskFn({ extends: 'edit', unknownField: 1 })
    // @ts-expect-error promptAppend without extends is invalid
    defineTaskFn({ promptAppend: 'x' })
    assert.ok(true)
  })

  it('rejects stored mixed/forbidden shapes that literal excess-property checking cannot catch', () => {
    // A stored variable with `extends` plus a full config must not slip through
    // the full TaskConfig overload: `extends` is type-level impossible there.
    const mixed = {
      extends: 'edit',
      input: z.object({}),
      output: z.object({}),
      prompt: () => '',
    }
    // @ts-expect-error stored extends + full config is rejected
    defineTaskFn(mixed)

    // A stored inherited declaration that redeclares a resolved-config field.
    const inheritedWithInput = {
      extends: 'edit',
      input: z.object({}),
    }
    // @ts-expect-error inherited declaration cannot declare input
    defineTaskFn(inheritedWithInput)

    // A stored full config carrying promptAppend without extends.
    const fullWithAppend = {
      input: z.object({}),
      output: z.object({}),
      prompt: () => '',
      promptAppend: 'x',
    }
    // @ts-expect-error standalone promptAppend is rejected
    defineTaskFn(fullWithAppend)

    assert.ok(true)
  })

  it('captures the raw inherited declaration on the definition', () => {
    const restore = installRuntimeGlobals({})
    try {
      const inherited = globalThis.defineTask!({ extends: 'edit', promptAppend: 'x' })
      assert.equal(inherited.__type, 'task')
      assert.equal(inherited.declaration?.extends, 'edit')
      assert.equal(inherited.declaration?.promptAppend, 'x')

      const full = globalThis.defineTask!({
        input: z.object({}),
        output: z.object({}),
        prompt: () => '',
      })
      assert.equal(full.declaration, undefined)
    } finally {
      restore()
    }
  })
})
