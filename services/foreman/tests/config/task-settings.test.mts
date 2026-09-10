import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  SYSTEM_DEFAULT_MODE,
  SYSTEM_DEFAULT_TIMEOUT_MS,
  normalizeTaskSettingsLayer,
  readGlobalTaskSettings,
  readPerTaskSettings,
  resolveEffectiveTaskSettings,
  taskDefaultsToSettingsLayer,
  taskSettingsIdentity,
  TaskSettingsValidationError,
  type EffectiveTaskSettings,
  type TaskExplicitRuntime,
  type TaskSettingsLayer,
  type TaskSettingsLayersInput,
} from '../../lib/config/task-settings.mts'

const ALIAS_REF: TaskExplicitRuntime = { kind: 'alias', name: 'cc-glmf' }
const TARGET_REF: TaskExplicitRuntime = { kind: 'target', target: 'zhipu-coding/glm-5.3-flash:cc' }

describe('task settings identity', () => {
  it('builds builtin identity as builtin:<name>', () => {
    assert.equal(taskSettingsIdentity({ kind: 'builtin', name: 'clean' }), 'builtin:clean')
    assert.equal(taskSettingsIdentity({ name: 'clean' }), 'builtin:clean')
  })

  it('builds project identity as project:<project>:<name>', () => {
    assert.equal(
      taskSettingsIdentity({ kind: 'project', name: 'clean', project: 'projA' }),
      'project:projA:clean',
    )
  })

  it('keeps builtin identity cross-project but isolates same-name project tasks', () => {
    const builtinA = taskSettingsIdentity({ kind: 'builtin', name: 'clean' })
    const builtinB = taskSettingsIdentity({ kind: 'builtin', name: 'clean', project: 'projA' })
    const projA = taskSettingsIdentity({ kind: 'project', name: 'clean', project: 'projA' })
    const projB = taskSettingsIdentity({ kind: 'project', name: 'clean', project: 'projB' })
    assert.equal(builtinA, builtinB)
    assert.notEqual(projA, projB)

    const byTask = {
      'project:projA:clean': { timeoutMs: 1000 },
      'project:projB:clean': { timeoutMs: 2000 },
    }
    const layerA = readPerTaskSettings({ settings: { byTask } }, projA)
    const layerB = readPerTaskSettings({ settings: { byTask } }, projB)
    assert.equal(layerA?.timeoutMs, 1000)
    assert.equal(layerB?.timeoutMs, 2000)
  })
})

describe('resolveEffectiveTaskSettings defaults', () => {
  it('inherits system automatic mode and 15m total timeout', () => {
    const result = resolveEffectiveTaskSettings({})
    assert.equal(result.mode, 'automatic')
    assert.equal(result.mode, SYSTEM_DEFAULT_MODE)
    assert.equal(result.timeoutMs, 15 * 60 * 1000)
    assert.equal(result.timeoutMs, SYSTEM_DEFAULT_TIMEOUT_MS)
    assert.equal(result.explicitRuntime, undefined)
    // The implicit system default expectation is `mid` (no minimum is set).
    assert.deepEqual(result.dispatch, { intelligenceExpected: 'mid' })
    assert.equal(result.sources.dispatch?.intelligenceExpected, 'system_global')
    assert.equal(result.sources.timeoutMs, 'system_global')
    assert.equal(result.sources.selectionMode, 'system_global')
  })
})

describe('resolveEffectiveTaskSettings precedence', () => {
  it('merges field-by-field in exact five-layer order (rightmost defined wins)', () => {
    const base: TaskSettingsLayersInput = {
      system: { selectionMode: 'automatic', timeoutMs: 1000 },
      builtin: {
        selectionMode: 'explicit',
        explicitRuntime: ALIAS_REF,
        timeoutMs: 2000,
      },
      userGlobal: { timeoutMs: 3000 },
      userTask: { timeoutMs: 4000 },
      invocation: { timeoutMs: 5000 },
    }
    const layered = resolveEffectiveTaskSettings(base)
    assert.equal(layered.mode, 'explicit')
    assert.deepEqual(layered.explicitRuntime, ALIAS_REF)
    assert.equal(layered.sources.explicitRuntime, 'builtin_task')
    assert.equal(layered.timeoutMs, 5000)
    assert.equal(layered.sources.timeoutMs, 'invocation')

    // Dropping the invocation override re-inherits the user-task value.
    const withoutInvocation = resolveEffectiveTaskSettings(
      { ...base, invocation: {} },
    )
    assert.equal(withoutInvocation.timeoutMs, 4000)
    assert.equal(withoutInvocation.sources.timeoutMs, 'user_task')
  })

  it('lets the user global layer override system and builtin fields', () => {
    const result = resolveEffectiveTaskSettings(
      {
        system: { timeoutMs: 15 * 60 * 1000 },
        builtin: { selectionMode: 'explicit', explicitRuntime: TARGET_REF, timeoutMs: 30_000 },
        userGlobal: { timeoutMs: 60_000 },
      },
    )
    assert.equal(result.timeoutMs, 60_000)
    assert.equal(result.sources.timeoutMs, 'user_global')
  })

  it('lets the user task layer override the user global layer', () => {
    const result = resolveEffectiveTaskSettings(
      {
        userGlobal: { timeoutMs: 60_000 },
        userTask: { timeoutMs: 120_000 },
      },
    )
    assert.equal(result.timeoutMs, 120_000)
    assert.equal(result.sources.timeoutMs, 'user_task')
  })

  it('resets by omission so a deleted field re-inherits the lower layer', () => {
    // userTask deletes (omits) timeoutMs entirely -> userGlobal value shows.
    const result = resolveEffectiveTaskSettings(
      {
        builtin: { timeoutMs: 30_000 },
        userGlobal: { timeoutMs: 60_000 },
        userTask: {},
        invocation: {},
      },
    )
    assert.equal(result.timeoutMs, 60_000)
    assert.equal(result.sources.timeoutMs, 'user_global')

    // A fully deleted userGlobal layer re-inherits builtin.
    const result2 = resolveEffectiveTaskSettings(
      { builtin: { timeoutMs: 30_000 } },
    )
    assert.equal(result2.timeoutMs, 30_000)
    assert.equal(result2.sources.timeoutMs, 'builtin_task')
  })

  it('preserves the builtin explicit timeout default', () => {
    const result = resolveEffectiveTaskSettings(
      {
        builtin: { selectionMode: 'explicit', explicitRuntime: TARGET_REF, timeoutMs: 25_000 },
      },
    )
    assert.equal(result.timeoutMs, 25_000)
    assert.equal(result.sources.timeoutMs, 'builtin_task')
  })

  it('merges dispatch fields per field with per-field sources', () => {
    const result = resolveEffectiveTaskSettings({
      system: { dispatch: { expectedTps: 5 } },
      userGlobal: { dispatch: { expectedTps: 20, intelligenceMin: 'mid' } },
      userTask: { dispatch: { intelligenceMax: 'premium' } },
      invocation: { dispatch: { excludeModelIds: ['model-a'] } },
    })
    assert.deepEqual(result.dispatch, {
      expectedTps: 20,
      intelligenceMin: 'mid',
      intelligenceMax: 'premium',
      excludeModelIds: ['model-a'],
      intelligenceExpected: 'mid',
    })
    assert.equal(result.sources.dispatch?.expectedTps, 'user_global')
    assert.equal(result.sources.dispatch?.intelligenceMin, 'user_global')
    assert.equal(result.sources.dispatch?.intelligenceMax, 'user_task')
    assert.equal(result.sources.dispatch?.excludeModelIds, 'invocation')
    assert.equal(result.sources.dispatch?.intelligenceExpected, 'system_global')
  })

  it('does not mutate any input layer when invocation wins', () => {
    const layers: TaskSettingsLayersInput = {
      system: { timeoutMs: 1000 },
      builtin: { selectionMode: 'explicit', explicitRuntime: ALIAS_REF, timeoutMs: 2000 },
      userGlobal: { timeoutMs: 3000 },
      userTask: { dispatch: { expectedTps: 4 } },
      invocation: { timeoutMs: 5000, dispatch: { expectedTps: 9 } },
    }
    const snapshot = structuredClone(layers)
    const result = resolveEffectiveTaskSettings(layers)
    assert.equal(result.timeoutMs, 5000)
    assert.equal(result.sources.timeoutMs, 'invocation')
    assert.equal(result.dispatch.expectedTps, 9)
    assert.deepEqual(layers, snapshot)
  })
})

describe('resolveEffectiveTaskSettings requiredCapabilities hard minimum', () => {
  it('keeps a builtin image requirement when user layers set text, [], and []', () => {
    const result = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiredCapabilities: ['image'] } },
      userGlobal: { dispatch: { requiredCapabilities: ['text'] } },
      userTask: { dispatch: { requiredCapabilities: [] } },
      invocation: { dispatch: { requiredCapabilities: [] } },
    })
    assert.deepEqual(result.dispatch.requiredCapabilities, ['image'])
    // An explicit empty user array must not remove the task-declared image.
    assert.equal(result.sources.dispatch?.requiredCapabilities, 'builtin_task')
  })

  it('does not let a single empty user layer erase a builtin image requirement', () => {
    const withEmptyTask = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiredCapabilities: ['image'] } },
      userTask: { dispatch: { requiredCapabilities: [] } },
    })
    assert.deepEqual(withEmptyTask.dispatch.requiredCapabilities, ['image'])
    assert.equal(withEmptyTask.sources.dispatch?.requiredCapabilities, 'builtin_task')

    const withEmptyGlobal = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiredCapabilities: ['image'] } },
      userGlobal: { dispatch: { requiredCapabilities: [] } },
    })
    assert.deepEqual(withEmptyGlobal.dispatch.requiredCapabilities, ['image'])
    assert.equal(withEmptyGlobal.sources.dispatch?.requiredCapabilities, 'builtin_task')
  })

  it('adds image to a task declaring text input without dropping text', () => {
    const result = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiredCapabilities: ['text'] } },
      invocation: { dispatch: { requiredCapabilities: ['image'] } },
    })
    assert.deepEqual(result.dispatch.requiredCapabilities, ['text', 'image'])
    assert.equal(result.sources.dispatch?.requiredCapabilities, 'invocation')
  })

  it('restores inherited requirements when the user override is removed', () => {
    const withOverride = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiredCapabilities: ['image'] } },
      userTask: { dispatch: { requiredCapabilities: ['text'] } },
    })
    assert.deepEqual(withOverride.dispatch.requiredCapabilities, ['text', 'image'])
    assert.equal(withOverride.sources.dispatch?.requiredCapabilities, 'user_task')

    // Dropping the user-task override re-inherits the builtin image minimum.
    const withoutOverride = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiredCapabilities: ['image'] } },
    })
    assert.deepEqual(withoutOverride.dispatch.requiredCapabilities, ['image'])
    assert.equal(withoutOverride.sources.dispatch?.requiredCapabilities, 'builtin_task')
  })

  it('keeps ordinary override semantics for requirements not declared by the task', () => {
    const text = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { requiredCapabilities: ['image'] } },
      userTask: { dispatch: { requiredCapabilities: ['text'] } },
    })
    assert.deepEqual(text.dispatch.requiredCapabilities, ['text'])
    const empty = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { requiredCapabilities: ['image'] } },
      invocation: { dispatch: { requiredCapabilities: [] } },
    })
    assert.deepEqual(empty.dispatch.requiredCapabilities, [])
    assert.equal(empty.sources.dispatch?.requiredCapabilities, 'invocation')
  })

  it('leaves requiredCapabilities absent when no layer declares any', () => {
    const result = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { expectedTps: 10 } },
    })
    assert.equal(result.dispatch.requiredCapabilities, undefined)
    assert.equal(result.sources.dispatch?.requiredCapabilities, undefined)
  })

  it('preserves ordinary field precedence unaffected by the capability minimum', () => {
    const result = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiredCapabilities: ['image'], expectedTps: 3 } },
      userGlobal: { dispatch: { requiredCapabilities: ['text'], expectedTps: 20 } },
      invocation: { dispatch: { expectedTps: 9 } },
    })
    assert.deepEqual(result.dispatch.requiredCapabilities, ['text', 'image'])
    assert.equal(result.dispatch.expectedTps, 9)
    assert.equal(result.sources.dispatch?.expectedTps, 'invocation')
    assert.equal(result.sources.dispatch?.requiredCapabilities, 'user_global')
  })
})

describe('resolveEffectiveTaskSettings requiresWebSearch', () => {
  it('rejects a non-boolean dispatch.requiresWebSearch', () => {
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { requiresWebSearch: 'yes' } }),
      /dispatch\.requiresWebSearch must be a boolean/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { requires_web_search: 1 } }),
      /dispatch\.requiresWebSearch must be a boolean/,
    )
  })

  it('normal rightmost-wins boolean precedence when builtin does not declare search', () => {
    const unset = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { expectedTps: 10 } },
    })
    assert.equal(unset.dispatch.requiresWebSearch, undefined)

    const userTrue = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { requiresWebSearch: true } },
    })
    assert.equal(userTrue.dispatch.requiresWebSearch, true)
    assert.equal(userTrue.sources.dispatch?.requiresWebSearch, 'user_global')

    // A later layer overrides the normal winner.
    const overridden = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { requiresWebSearch: true } },
      userTask: { dispatch: { requiresWebSearch: false } },
    })
    assert.equal(overridden.dispatch.requiresWebSearch, false)
    assert.equal(overridden.sources.dispatch?.requiresWebSearch, 'user_task')
  })

  it('keeps a builtin requiresWebSearch:true mandatory across user false and resets', () => {
    const withUserFalse = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiresWebSearch: true } },
      userGlobal: { dispatch: { requiresWebSearch: false } },
    })
    assert.equal(withUserFalse.dispatch.requiresWebSearch, true)
    assert.equal(withUserFalse.sources.dispatch?.requiresWebSearch, 'builtin_task')

    const withUserReset = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiresWebSearch: true } },
      userTask: {},
      invocation: { dispatch: { requiresWebSearch: false } },
    })
    assert.equal(withUserReset.dispatch.requiresWebSearch, true)
    assert.equal(withUserReset.sources.dispatch?.requiresWebSearch, 'builtin_task')
  })

  it('preserves builtin true even when a higher layer also declares true', () => {
    const result = resolveEffectiveTaskSettings({
      builtin: { dispatch: { requiresWebSearch: true } },
      userGlobal: { dispatch: { requiresWebSearch: true } },
    })
    assert.equal(result.dispatch.requiresWebSearch, true)
    assert.equal(result.sources.dispatch?.requiresWebSearch, 'builtin_task')
  })
})

describe('resolveEffectiveTaskSettings mode switching', () => {
  it('ignores an inherited explicit reference when a higher layer is automatic', () => {
    const result = resolveEffectiveTaskSettings(
      {
        builtin: { selectionMode: 'explicit', explicitRuntime: ALIAS_REF },
        userGlobal: { selectionMode: 'automatic' },
      },
    )
    assert.equal(result.mode, 'automatic')
    assert.equal(result.explicitRuntime, undefined)
    assert.equal(result.sources.explicitRuntime, undefined)
  })

  it('ignores an explicit reference layered under a higher automatic mode', () => {
    const result = resolveEffectiveTaskSettings(
      {
        builtin: { selectionMode: 'explicit', explicitRuntime: ALIAS_REF },
        userGlobal: { explicitRuntime: TARGET_REF },
        userTask: { selectionMode: 'automatic' },
      },
    )
    assert.equal(result.mode, 'automatic')
    assert.equal(result.explicitRuntime, undefined)
  })

  it('never resolves or validates a reference in automatic mode', () => {
    // Automatic mode must not consult any reference, so even a structurally
    // valid but unknown alias name is ignored without error.
    const result = resolveEffectiveTaskSettings(
      {
        userGlobal: {
          selectionMode: 'explicit',
          explicitRuntime: { kind: 'alias', name: 'stale-unknown-alias' },
        },
        invocation: { selectionMode: 'automatic' },
      },
    )
    assert.equal(result.mode, 'automatic')
    assert.equal(result.explicitRuntime, undefined)
  })

  it('rejects explicit mode without any structural reference', () => {
    assert.throws(
      () => resolveEffectiveTaskSettings({ userGlobal: { selectionMode: 'explicit' } }),
      TaskSettingsValidationError,
    )
    assert.throws(
      () => resolveEffectiveTaskSettings({ invocation: { selectionMode: 'explicit' } }),
      /explicit runtime reference/,
    )
  })

  it('accepts an alias reference in explicit mode and reports its winning source', () => {
    const result = resolveEffectiveTaskSettings(
      { invocation: { selectionMode: 'explicit', explicitRuntime: ALIAS_REF } },
    )
    assert.equal(result.mode, 'explicit')
    assert.deepEqual(result.explicitRuntime, ALIAS_REF)
    assert.equal(result.sources.explicitRuntime, 'invocation')
  })

  it('accepts an inline target reference in explicit mode', () => {
    const result = resolveEffectiveTaskSettings(
      { userTask: { selectionMode: 'explicit', explicitRuntime: TARGET_REF } },
    )
    assert.equal(result.mode, 'explicit')
    assert.deepEqual(result.explicitRuntime, TARGET_REF)
    assert.equal(result.sources.explicitRuntime, 'user_task')
  })

  it('carries references structurally without resolving them here', () => {
    // Alias resolution and compatibility checking happen in the daemon, never
    // in the settings model; a not-yet-known alias still resolves to explicit.
    const result = resolveEffectiveTaskSettings(
      {
        userGlobal: {
          selectionMode: 'explicit',
          explicitRuntime: { kind: 'alias', name: 'not-yet-registered-alias' },
        },
      },
    )
    assert.equal(result.mode, 'explicit')
    assert.deepEqual(result.explicitRuntime, { kind: 'alias', name: 'not-yet-registered-alias' })
  })
})

describe('normalizeTaskSettingsLayer validation', () => {
  it('throws on non-positive or non-integer timeouts', () => {
    assert.throws(() => normalizeTaskSettingsLayer({ timeoutMs: 0 }), TaskSettingsValidationError)
    assert.throws(() => normalizeTaskSettingsLayer({ timeoutMs: -5 }), TaskSettingsValidationError)
    assert.throws(() => normalizeTaskSettingsLayer({ timeoutMs: 1.5 }), TaskSettingsValidationError)
  })

  it('throws on inverted intelligence ordering within a layer', () => {
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { intelligenceMin: 'premium', intelligenceMax: 'mid' } }),
      /intelligenceMin/,
    )
  })

  it('throws on inverted effective intelligence ordering across layers', () => {
    assert.throws(
      () =>
        resolveEffectiveTaskSettings({
          userGlobal: { dispatch: { intelligenceMin: 'premium' } },
          userTask: { dispatch: { intelligenceMax: 'mid' } },
        }),
      /intelligenceMin/,
    )
  })

  it('rejects the legacy frontier intelligence alias through camel and snake keys', () => {
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { intelligenceMin: 'frontier' } }),
      /dispatch\.intelligenceMin must be one of: low, mid, high, premium/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { intelligence_min: 'frontier' } }),
      /intelligenceMin must be one of/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { intelligenceMax: 'frontier' } }),
      /intelligenceMax must be one of/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { intelligenceExpected: 'frontier' } }),
      /intelligenceExpected must be one of/,
    )
  })

  it('carries optional intelligenceExpected with per-field inheritance and rejects out-of-range', () => {
    // absent stays absent (never defaults to a minimum)
    const base = normalizeTaskSettingsLayer({ dispatch: { intelligenceMin: 'low', intelligenceMax: 'high' } })
    assert.equal((base.dispatch as { intelligenceExpected?: string }).intelligenceExpected, undefined)

    // per-field inheritance: invocation wins over user global
    const layered = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { intelligenceMin: 'low', intelligenceMax: 'high', intelligenceExpected: 'low' } },
      invocation: { dispatch: { intelligenceExpected: 'mid' } },
    })
    assert.equal(layered.dispatch.intelligenceExpected, 'mid')
    assert.equal(layered.sources.dispatch?.intelligenceExpected, 'invocation')

    // out-of-range below min is rejected
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { intelligenceMin: 'mid', intelligenceMax: 'high', intelligenceExpected: 'low' } }),
      /intelligenceExpected cannot be below dispatch.intelligenceMin/,
    )
    // out-of-range above max is rejected
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { intelligenceMin: 'low', intelligenceMax: 'mid', intelligenceExpected: 'high' } }),
      /intelligenceExpected cannot exceed dispatch.intelligenceMax/,
    )
  })

  it('accepts the persisted snake explicit_runtime alias', () => {
    const layer = normalizeTaskSettingsLayer({
      selection_mode: 'explicit',
      explicit_runtime: { kind: 'alias', name: 'cc-glmf' },
      timeout_ms: 42_000,
    })
    assert.deepEqual(layer, {
      selectionMode: 'explicit',
      explicitRuntime: ALIAS_REF,
      timeoutMs: 42_000,
    })
  })

  it('trims reference name and target values', () => {
    const alias = normalizeTaskSettingsLayer({
      explicitRuntime: { kind: 'alias', name: '  cc-glmf  ' },
    })
    assert.deepEqual(alias, { explicitRuntime: { kind: 'alias', name: 'cc-glmf' } })
    const target = normalizeTaskSettingsLayer({
      explicitRuntime: { kind: 'target', target: ' zhipu-coding/glm-5.3-flash:cc ' },
    })
    assert.deepEqual(target, { explicitRuntime: TARGET_REF })
  })

  it('rejects a non-object explicitRuntime and unknown kinds', () => {
    assert.throws(
      () => normalizeTaskSettingsLayer({ explicitRuntime: 'codex-cli' }),
      /explicitRuntime must be an object/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ explicitRuntime: { kind: 'bogus', name: 'x' } }),
      /"alias" or "target"/,
    )
  })

  it('rejects missing or blank reference name/target', () => {
    assert.throws(
      () => normalizeTaskSettingsLayer({ explicitRuntime: { kind: 'alias' } }),
      /non-empty trimmed name/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ explicitRuntime: { kind: 'alias', name: '   ' } }),
      /non-empty trimmed name/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ explicitRuntime: { kind: 'target' } }),
      /non-empty trimmed target/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ explicitRuntime: { kind: 'target', target: '' } }),
      /non-empty trimmed target/,
    )
  })

  it('rejects extra and mixed reference fields', () => {
    assert.throws(
      () =>
        normalizeTaskSettingsLayer({
          explicitRuntime: { kind: 'alias', name: 'cc-glmf', target: 'zhipu/...' },
        }),
      /does not accept field "target"/,
    )
    assert.throws(
      () =>
        normalizeTaskSettingsLayer({
          explicitRuntime: { kind: 'target', name: 'cc-glmf', target: 'zhipu/...' },
        }),
      /does not accept field "name"/,
    )
    assert.throws(
      () =>
        normalizeTaskSettingsLayer({
          explicitRuntime: { kind: 'alias', name: 'cc-glmf', extra: 1 },
        }),
      /does not accept field "extra"/,
    )
  })

  it('drops legacy agentRuntime layer keys as unknown input', () => {
    const layer = normalizeTaskSettingsLayer({
      agentRuntime: 'codex-cli',
      agent_runtime: 'stale',
      timeoutMs: 5000,
    } as unknown as TaskSettingsLayer)
    assert.deepEqual(layer, { timeoutMs: 5000 })

    const effective = resolveEffectiveTaskSettings(
      {
        userGlobal: { timeoutMs: 60_000 },
        invocation: { agent_runtime: 'stale-pin' },
      } as unknown as TaskSettingsLayersInput,
    )
    assert.equal(effective.timeoutMs, 60_000)
    assert.equal(effective.explicitRuntime, undefined)
    assert.deepEqual(effective.dispatch, { intelligenceExpected: 'mid' })
  })

  it('drops historical preferredRuntime dispatch keys instead of treating them as a current setting', () => {
    const layer = normalizeTaskSettingsLayer({
      timeoutMs: 5000,
      dispatch: {
        preferredRuntime: { client: 'codex', provider: 'codex', model: 'gpt-5.6-sol' },
        preferred_runtime: { client: 'claude', provider: 'kimi-coding', model: 'k3' },
      },
    } as unknown as TaskSettingsLayer)
    assert.deepEqual(layer, { timeoutMs: 5000 })
  })

  it('throws on unknown selectionMode and malformed dispatch', () => {
    assert.throws(
      () => normalizeTaskSettingsLayer({ selectionMode: 'manual' }),
      TaskSettingsValidationError,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { excludeModelIds: 'model-a' } }),
      TaskSettingsValidationError,
    )
  })
})

describe('taskDefaultsToSettingsLayer', () => {
  it('always authors automatic selection for Task defaults', () => {
    const defaults = taskDefaultsToSettingsLayer({ timeoutMs: 30_000 })
    assert.deepEqual(defaults, { selectionMode: 'automatic', timeoutMs: 30_000 })
  })

  it('defaults every Task to automatic regardless of legacy-looking runtime input', () => {
    // Legacy TaskConfig inputs (runtime strings, profile selectors) must never
    // flip the builtin layer to explicit nor carry a runtime forward.
    const withLegacyRuntime = taskDefaultsToSettingsLayer({
      timeoutMs: 30_000,
      runtime: 'codex-cli',
    } as unknown as Parameters<typeof taskDefaultsToSettingsLayer>[0])
    assert.deepEqual(withLegacyRuntime, { selectionMode: 'automatic', timeoutMs: 30_000 })

    const withPolicySelector = taskDefaultsToSettingsLayer({
      runtime: 'fast',
    } as unknown as Parameters<typeof taskDefaultsToSettingsLayer>[0])
    assert.deepEqual(withPolicySelector, { selectionMode: 'automatic' })
  })

  it('carries only timeout and dispatch defaults', () => {
    const layer = taskDefaultsToSettingsLayer({
      timeoutMs: 60_000,
      dispatch: { minimumTps: 1, expectedTps: 5 },
    })
    assert.deepEqual(layer, {
      selectionMode: 'automatic',
      timeoutMs: 60_000,
      dispatch: { minimumTps: 1, expectedTps: 5 },
    })
  })
})

describe('persisted settings readers', () => {
  it('reads normalized tasks.settings.global', () => {
    const layer = readGlobalTaskSettings({
      settings: { global: { selectionMode: 'automatic', timeoutMs: 60_000 } },
    })
    assert.deepEqual(layer, { selectionMode: 'automatic', timeoutMs: 60_000 })
    assert.equal(readGlobalTaskSettings({}), undefined)
  })

  it('reads normalized per-task settings by stable identity', () => {
    const tasks = {
      settings: { byTask: { 'builtin:clean': { timeoutMs: 5000 } } },
    }
    assert.deepEqual(readPerTaskSettings(tasks, 'builtin:clean'), { timeoutMs: 5000 })
    assert.equal(readPerTaskSettings(tasks, 'builtin:other'), undefined)
  })

  it('keeps byTask the only per-task user selection source and ignores tasks.agentRuntime', () => {
    // A legacy tasks.agentRuntime root is never consulted by any reader.
    const tasks = {
      agentRuntime: { clean: 'codex-cli', 'builtin:clean': 'runtime-x' },
      settings: {
        byTask: { 'builtin:clean': { selectionMode: 'explicit', explicitRuntime: ALIAS_REF } },
      },
    } as unknown as Parameters<typeof readPerTaskSettings>[0]

    assert.equal(readGlobalTaskSettings(tasks), undefined)
    assert.deepEqual(readPerTaskSettings(tasks, 'builtin:clean'), {
      selectionMode: 'explicit',
      explicitRuntime: ALIAS_REF,
    })

    // byTask entries can still author automatic, which ignores any inherited pin.
    const autoTasks = {
      settings: { byTask: { 'builtin:clean': { selectionMode: 'automatic' } } },
    }
    assert.deepEqual(readPerTaskSettings(autoTasks, 'builtin:clean'), {
      selectionMode: 'automatic',
    })
  })
})

describe('maxAutoOutputUsdPerMillion global-only cap', () => {
  it('normalizes zero and positive values through camel and snake aliases', () => {
    assert.deepEqual(normalizeTaskSettingsLayer({ maxAutoOutputUsdPerMillion: 0 }), {
      maxAutoOutputUsdPerMillion: 0,
    })
    assert.deepEqual(normalizeTaskSettingsLayer({ maxAutoOutputUsdPerMillion: 12.5 }), {
      maxAutoOutputUsdPerMillion: 12.5,
    })
    assert.deepEqual(normalizeTaskSettingsLayer({ max_auto_output_usd_per_million: 25 }), {
      maxAutoOutputUsdPerMillion: 25,
    })
    // camelCase wins when both aliases are present.
    assert.deepEqual(
      normalizeTaskSettingsLayer({
        maxAutoOutputUsdPerMillion: 0,
        max_auto_output_usd_per_million: 5,
      }),
      { maxAutoOutputUsdPerMillion: 0 },
    )
  })

  it('rejects negative, non-finite, and non-number values', () => {
    for (const raw of [
      { maxAutoOutputUsdPerMillion: -1 },
      { maxAutoOutputUsdPerMillion: -0.01 },
      { maxAutoOutputUsdPerMillion: Number.POSITIVE_INFINITY },
      { maxAutoOutputUsdPerMillion: Number.NaN },
      { maxAutoOutputUsdPerMillion: '5' },
    ]) {
      assert.throws(() => normalizeTaskSettingsLayer(raw), TaskSettingsValidationError)
    }
  })

  it('treats null and absence as cleared, and keeps positive dispatch price caps strictly positive', () => {
    assert.deepEqual(normalizeTaskSettingsLayer({ maxAutoOutputUsdPerMillion: null }), {})
    assert.deepEqual(
      normalizeTaskSettingsLayer({ max_auto_output_usd_per_million: null, timeoutMs: 5000 }),
      { timeoutMs: 5000 },
    )
    assert.equal(
      readGlobalTaskSettings({ settings: { global: { max_auto_output_usd_per_million: 2 } } })
        ?.maxAutoOutputUsdPerMillion,
      2,
    )
    assert.equal(
      readGlobalTaskSettings({ settings: { global: {} } })?.maxAutoOutputUsdPerMillion,
      undefined,
    )
    // dispatch.maxOutputUsdPerMillion remains independent and strictly positive.
    assert.deepEqual(
      normalizeTaskSettingsLayer({
        maxAutoOutputUsdPerMillion: 0,
        dispatch: { maxOutputUsdPerMillion: 15 },
      }),
      { maxAutoOutputUsdPerMillion: 0, dispatch: { maxOutputUsdPerMillion: 15 } },
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { maxOutputUsdPerMillion: 0 } }),
      /positive number/,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ dispatch: { maxOutputUsdPerMillion: -1 } }),
      /positive number/,
    )
  })

  it('sources the cap only from userGlobal and ignores the same field on other layers', () => {
    const capped = resolveEffectiveTaskSettings({
      userGlobal: { maxAutoOutputUsdPerMillion: 0 },
      userTask: { maxAutoOutputUsdPerMillion: 40 },
      invocation: { maxAutoOutputUsdPerMillion: 90 },
    })
    assert.equal(capped.maxAutoOutputUsdPerMillion, 0)
    assert.equal(capped.sources.maxAutoOutputUsdPerMillion, 'user_global')

    const positiveCap = resolveEffectiveTaskSettings({
      userGlobal: { maxAutoOutputUsdPerMillion: 12.5 },
    })
    assert.equal(positiveCap.maxAutoOutputUsdPerMillion, 12.5)
    assert.equal(positiveCap.sources.maxAutoOutputUsdPerMillion, 'user_global')

    // A cap only ever present on non-userGlobal layers stays undefined, so a
    // stale system/user-task/invocation pin can never leak into auto admission.
    const uncapped = resolveEffectiveTaskSettings({
      system: { maxAutoOutputUsdPerMillion: 7 },
      builtin: { maxAutoOutputUsdPerMillion: 8 },
      userTask: { maxAutoOutputUsdPerMillion: 40 },
      invocation: { maxAutoOutputUsdPerMillion: 90 },
    })
    assert.equal(uncapped.maxAutoOutputUsdPerMillion, undefined)
    assert.equal(uncapped.sources.maxAutoOutputUsdPerMillion, undefined)
  })
})

describe('resolveEffectiveTaskSettings integration', () => {
  it('produces a complete effective result across all five layers', () => {
    const builtin = taskDefaultsToSettingsLayer({ timeoutMs: 30_000 })
    const result: EffectiveTaskSettings = resolveEffectiveTaskSettings(
      {
        builtin,
        userTask: {
          selectionMode: 'explicit',
          explicitRuntime: ALIAS_REF,
          timeoutMs: 45_000,
          dispatch: { minimumTps: 1 },
        },
        invocation: { dispatch: { minimumTps: 2 } },
      },
    )
    assert.deepEqual(result, {
      mode: 'explicit',
      explicitRuntime: ALIAS_REF,
      timeoutMs: 45_000,
      dispatch: { minimumTps: 2, intelligenceExpected: 'mid' },
      maxAutoOutputUsdPerMillion: undefined,
      sources: {
        selectionMode: 'user_task',
        explicitRuntime: 'user_task',
        timeoutMs: 'user_task',
        dispatch: { minimumTps: 'invocation', intelligenceExpected: 'system_global' },
      },
    } satisfies EffectiveTaskSettings)
  })
})

describe('resolveEffectiveTaskSettings intelligence expectation default', () => {
  it('clamps the implicit mid default up to a high minimum', () => {
    const result = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { intelligenceMin: 'high' } },
    })
    assert.equal(result.dispatch.intelligenceExpected, 'high')
    assert.equal(result.dispatch.intelligenceMin, 'high')
    assert.equal(result.sources.dispatch?.intelligenceExpected, 'system_global')
  })

  it('clamps the implicit mid default down to a low maximum', () => {
    const result = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { intelligenceMax: 'low' } },
    })
    assert.equal(result.dispatch.intelligenceExpected, 'low')
    assert.equal(result.dispatch.intelligenceMax, 'low')
    assert.equal(result.sources.dispatch?.intelligenceExpected, 'system_global')
  })

  it('keeps the implicit mid default within an explicit low..high range', () => {
    const result = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { intelligenceMin: 'low', intelligenceMax: 'high' } },
    })
    assert.equal(result.dispatch.intelligenceExpected, 'mid')
    assert.equal(result.sources.dispatch?.intelligenceExpected, 'system_global')
  })

  it('honors an explicit minimum high with an explicit expected premium', () => {
    const result = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { intelligenceMin: 'high', intelligenceExpected: 'premium' } },
    })
    assert.equal(result.dispatch.intelligenceMin, 'high')
    assert.equal(result.dispatch.intelligenceExpected, 'premium')
    assert.equal(result.sources.dispatch?.intelligenceExpected, 'user_global')
  })

  it('rejects an explicit expected below an explicit minimum', () => {
    assert.throws(
      () => resolveEffectiveTaskSettings({
        userGlobal: { dispatch: { intelligenceMin: 'high', intelligenceExpected: 'mid' } },
      }),
      /intelligenceExpected cannot be below dispatch.intelligenceMin/,
    )
  })

  it('rejects an explicit expected above an explicit maximum', () => {
    assert.throws(
      () => resolveEffectiveTaskSettings({
        userGlobal: { dispatch: { intelligenceMax: 'mid', intelligenceExpected: 'high' } },
      }),
      /intelligenceExpected cannot exceed dispatch.intelligenceMax/,
    )
  })

  it('re-inherits the system mid default when an explicit expectation is reset', () => {
    const withExpected = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { intelligenceExpected: 'premium' } },
    })
    assert.equal(withExpected.dispatch.intelligenceExpected, 'premium')
    assert.equal(withExpected.sources.dispatch?.intelligenceExpected, 'user_global')

    const reset = resolveEffectiveTaskSettings({})
    assert.equal(reset.dispatch.intelligenceExpected, 'mid')
    assert.equal(reset.sources.dispatch?.intelligenceExpected, 'system_global')
  })

  it('lets the user task layer override the system mid default', () => {
    const result = resolveEffectiveTaskSettings({
      userGlobal: { dispatch: { intelligenceExpected: 'low' } },
      userTask: { dispatch: { intelligenceExpected: 'high' } },
    })
    assert.equal(result.dispatch.intelligenceExpected, 'high')
    assert.equal(result.sources.dispatch?.intelligenceExpected, 'user_task')
  })
})
