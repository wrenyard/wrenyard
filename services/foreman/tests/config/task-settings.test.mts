import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ADDITIONAL_INSTRUCTIONS_MAX_LENGTH,
  SYSTEM_DEFAULT_MODE,
  SYSTEM_DEFAULT_TIMEOUT_MS,
  normalizeTaskSettingsLayer,
  readBuiltinSettingsSelection,
  readGlobalTaskSettings,
  readLegacyRuntimePin,
  readPerTaskSettings,
  resolveEffectiveTaskSettings,
  taskDefaultsToSettingsLayer,
  taskSettingsIdentity,
  TaskSettingsValidationError,
  type EffectiveTaskSettings,
  type TaskRuntimeCatalog,
  type TaskSettingsLayer,
  type TaskSettingsLayersInput,
} from '../../lib/config/task-settings.mts'

const CATALOG: TaskRuntimeCatalog = {
  exactRuntimeIds: ['codex-cli', 'runtime-x'],
  policyRuntimeIds: ['auto', 'fast'],
}

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
    assert.equal(result.runtime, undefined)
    assert.equal(result.additionalInstructions, undefined)
    assert.deepEqual(result.dispatch, {})
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
        agentRuntime: 'codex-cli',
        timeoutMs: 2000,
      },
      userGlobal: { timeoutMs: 3000 },
      userTask: { timeoutMs: 4000 },
      invocation: { timeoutMs: 5000 },
    }
    const layered = resolveEffectiveTaskSettings(base, CATALOG)
    assert.equal(layered.mode, 'explicit')
    assert.equal(layered.runtime, 'codex-cli')
    assert.equal(layered.timeoutMs, 5000)
    assert.equal(layered.sources.timeoutMs, 'invocation')

    // Dropping the invocation override re-inherits the user-task value.
    const withoutInvocation = resolveEffectiveTaskSettings(
      { ...base, invocation: {} },
      CATALOG,
    )
    assert.equal(withoutInvocation.timeoutMs, 4000)
    assert.equal(withoutInvocation.sources.timeoutMs, 'user_task')
  })

  it('lets the user global layer override system and builtin fields', () => {
    const result = resolveEffectiveTaskSettings(
      {
        system: { timeoutMs: 15 * 60 * 1000 },
        builtin: { selectionMode: 'explicit', agentRuntime: 'codex-cli', timeoutMs: 30_000 },
        userGlobal: { timeoutMs: 60_000, additionalInstructions: 'g' },
      },
      CATALOG,
    )
    assert.equal(result.timeoutMs, 60_000)
    assert.equal(result.sources.timeoutMs, 'user_global')
    assert.equal(result.additionalInstructions, 'g')
    assert.equal(result.sources.additionalInstructions, 'user_global')
  })

  it('lets the user task layer override the user global layer', () => {
    const result = resolveEffectiveTaskSettings(
      {
        userGlobal: { timeoutMs: 60_000 },
        userTask: { timeoutMs: 120_000 },
      },
      CATALOG,
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
      CATALOG,
    )
    assert.equal(result.timeoutMs, 60_000)
    assert.equal(result.sources.timeoutMs, 'user_global')

    // A fully deleted userGlobal layer re-inherits builtin.
    const result2 = resolveEffectiveTaskSettings(
      { builtin: { timeoutMs: 30_000 } },
      CATALOG,
    )
    assert.equal(result2.timeoutMs, 30_000)
    assert.equal(result2.sources.timeoutMs, 'builtin_task')
  })

  it('preserves the builtin explicit timeout default', () => {
    const result = resolveEffectiveTaskSettings(
      {
        builtin: { selectionMode: 'explicit', agentRuntime: 'codex-cli', timeoutMs: 25_000 },
      },
      CATALOG,
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
    })
    assert.equal(result.sources.dispatch?.expectedTps, 'user_global')
    assert.equal(result.sources.dispatch?.intelligenceMin, 'user_global')
    assert.equal(result.sources.dispatch?.intelligenceMax, 'user_task')
    assert.equal(result.sources.dispatch?.excludeModelIds, 'invocation')
  })

  it('does not mutate any input layer when invocation wins', () => {
    const layers: TaskSettingsLayersInput = {
      system: { timeoutMs: 1000 },
      builtin: { selectionMode: 'explicit', agentRuntime: 'codex-cli', timeoutMs: 2000 },
      userGlobal: { timeoutMs: 3000, additionalInstructions: 'g' },
      userTask: { dispatch: { expectedTps: 4 } },
      invocation: { timeoutMs: 5000, dispatch: { expectedTps: 9 } },
    }
    const snapshot = structuredClone(layers)
    const result = resolveEffectiveTaskSettings(layers, CATALOG)
    assert.equal(result.timeoutMs, 5000)
    assert.equal(result.sources.timeoutMs, 'invocation')
    assert.equal(result.dispatch.expectedTps, 9)
    assert.deepEqual(layers, snapshot)
  })
})

describe('resolveEffectiveTaskSettings mode switching', () => {
  it('ignores an inherited explicit runtime pin when a higher layer is automatic', () => {
    const result = resolveEffectiveTaskSettings(
      {
        builtin: { selectionMode: 'explicit', agentRuntime: 'stale-pin' },
        userGlobal: { selectionMode: 'automatic' },
      },
      CATALOG,
    )
    assert.equal(result.mode, 'automatic')
    assert.equal(result.runtime, undefined)
    assert.equal(result.sources.agentRuntime, undefined)
  })

  it('ignores a runtime pin layered under a higher automatic mode', () => {
    const result = resolveEffectiveTaskSettings(
      {
        builtin: { selectionMode: 'explicit', agentRuntime: 'codex-cli' },
        userGlobal: { agentRuntime: 'runtime-x' },
        userTask: { selectionMode: 'automatic' },
      },
      CATALOG,
    )
    assert.equal(result.mode, 'automatic')
    assert.equal(result.runtime, undefined)
  })

  it('rejects explicit mode without any runtime', () => {
    assert.throws(
      () => resolveEffectiveTaskSettings({ userGlobal: { selectionMode: 'explicit' } }, CATALOG),
      TaskSettingsValidationError,
    )
  })

  it('rejects policy aliases in explicit mode', () => {
    assert.throws(
      () =>
        resolveEffectiveTaskSettings(
          {
            builtin: { selectionMode: 'automatic' },
            userTask: { selectionMode: 'explicit', agentRuntime: 'auto' },
          },
          CATALOG,
        ),
      /policy alias/,
    )
    assert.throws(
      () =>
        resolveEffectiveTaskSettings(
          { invocation: { selectionMode: 'explicit', agentRuntime: 'fast' } },
          CATALOG,
        ),
      /policy alias/,
    )
  })

  it('rejects unknown runtimes in explicit mode when catalog is authoritative', () => {
    assert.throws(
      () =>
        resolveEffectiveTaskSettings(
          { invocation: { selectionMode: 'explicit', agentRuntime: 'nope' } },
          CATALOG,
        ),
      /not a known exact runtime/,
    )
  })

  it('accepts an exact existing runtime in explicit mode', () => {
    const result = resolveEffectiveTaskSettings(
      { invocation: { selectionMode: 'explicit', agentRuntime: 'runtime-x' } },
      CATALOG,
    )
    assert.equal(result.mode, 'explicit')
    assert.equal(result.runtime, 'runtime-x')
    assert.equal(result.sources.agentRuntime, 'invocation')
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

  it('throws on oversized additional instructions', () => {
    const long = 'x'.repeat(ADDITIONAL_INSTRUCTIONS_MAX_LENGTH + 1)
    assert.throws(
      () => normalizeTaskSettingsLayer({ additionalInstructions: long }),
      TaskSettingsValidationError,
    )
  })

  it('throws on non-plain-text additional instructions', () => {
    assert.throws(
      () => normalizeTaskSettingsLayer({ additionalInstructions: 'a\u0000b' }),
      TaskSettingsValidationError,
    )
    assert.throws(
      () => normalizeTaskSettingsLayer({ additionalInstructions: 'a\u001Fb' }),
      TaskSettingsValidationError,
    )
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

  it('accepts a bounded plain-text instruction and treats null as unset', () => {
    const layer = normalizeTaskSettingsLayer({
      additionalInstructions: 'always explain line by line\nwith examples',
      timeoutMs: null,
    })
    assert.equal(
      layer.additionalInstructions,
      'always explain line by line\nwith examples',
    )
    assert.equal(layer.timeoutMs, undefined)
  })
})

describe('additional instructions override behavior', () => {
  it('is a plain-text override that never replaces the builtin dynamic prompt', () => {
    const builtinPrompt = 'sync files into the vault'
    const result = resolveEffectiveTaskSettings(
      {
        builtin: { selectionMode: 'explicit', agentRuntime: 'codex-cli' },
        invocation: { additionalInstructions: 'always read the manifest first' },
      },
      CATALOG,
    )
    assert.equal(result.additionalInstructions, 'always read the manifest first')
    assert.equal(builtinPrompt, 'sync files into the vault')
    assert.equal(result.additionalInstructions.includes(builtinPrompt), false)
  })
})

describe('taskDefaultsToSettingsLayer', () => {
  it('maps policy runtimes to automatic and exact runtimes to explicit', () => {
    const automatic = taskDefaultsToSettingsLayer({ runtime: 'auto' }, CATALOG)
    assert.deepEqual(automatic, { selectionMode: 'automatic' })

    const exact = taskDefaultsToSettingsLayer(
      { runtime: 'codex-cli', timeoutMs: 30_000 },
      CATALOG,
    )
    assert.deepEqual(exact, {
      selectionMode: 'explicit',
      agentRuntime: 'codex-cli',
      timeoutMs: 30_000,
    })

    // An unrecognized declared runtime behaves like a policy/profile.
    const unknown = taskDefaultsToSettingsLayer({ runtime: 'profile-heavy' }, CATALOG)
    assert.deepEqual(unknown, { selectionMode: 'automatic' })
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

  it('applies the legacy agentRuntime fallback only for builtin tasks with no new byTask selection', () => {
    const withSelection = {
      agentRuntime: { clean: 'codex-cli' },
      settings: { byTask: { 'builtin:clean': { timeoutMs: 5000 } } },
    }
    const selected = readBuiltinSettingsSelection(withSelection, 'clean')
    assert.equal(selected.source, 'task')
    assert.equal(selected.layer?.timeoutMs, 5000)

    const withLegacy = { agentRuntime: { clean: 'runtime-x' } }
    const legacy = readBuiltinSettingsSelection(withLegacy, 'clean')
    assert.equal(legacy.source, 'legacy')
    assert.deepEqual(legacy.layer, { selectionMode: 'explicit', agentRuntime: 'runtime-x' })

    const none = readBuiltinSettingsSelection({}, 'clean')
    assert.equal(none.source, 'none')
    assert.equal(none.layer, undefined)
  })

  it('never applies the legacy fallback to project tasks', () => {
    const tasks = { agentRuntime: { clean: 'runtime-x' } }
    const projectLayer = readPerTaskSettings(tasks, 'project:projA:clean')
    assert.equal(projectLayer, undefined)
    assert.equal(readLegacyRuntimePin(tasks, 'clean'), 'runtime-x')
  })
})

describe('resolveEffectiveTaskSettings integration', () => {
  it('produces a complete effective result across all five layers', () => {
    const builtin = taskDefaultsToSettingsLayer(
      { runtime: 'codex-cli', timeoutMs: 30_000 },
      CATALOG,
    )
    const result: EffectiveTaskSettings = resolveEffectiveTaskSettings(
      {
        builtin,
        userGlobal: { additionalInstructions: 'g' },
        userTask: { timeoutMs: 45_000, dispatch: { minimumTps: 1 } },
        invocation: { dispatch: { minimumTps: 2 } },
      },
      CATALOG,
    )
    assert.deepEqual(result, {
      mode: 'explicit',
      runtime: 'codex-cli',
      timeoutMs: 45_000,
      additionalInstructions: 'g',
      dispatch: { minimumTps: 2 },
      sources: {
        selectionMode: 'builtin_task',
        agentRuntime: 'builtin_task',
        timeoutMs: 'user_task',
        additionalInstructions: 'user_global',
        dispatch: { minimumTps: 'invocation' },
      },
    } satisfies EffectiveTaskSettings)
  })
})
