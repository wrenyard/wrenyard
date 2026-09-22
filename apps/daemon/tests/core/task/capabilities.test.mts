import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveFeatures } from '../../../lib/core/task/features.mts'
import type { TaskFeatureConfig } from '../../../lib/core/task/types.mts'

describe('core task resolveFeatures', () => {
  it('returns [] when config is undefined', () => {
    assert.deepEqual(resolveFeatures(undefined, {}), [])
  })

  it('returns all available when select is absent', () => {
    const config: TaskFeatureConfig = { available: ['browser-use', 'computer-use'] }
    assert.deepEqual(resolveFeatures(config, {}), ['browser-use', 'computer-use'])
  })

  it('returns selected ids from select function', () => {
    const config: TaskFeatureConfig = {
      available: ['browser-use', 'computer-use'],
      select: (input: unknown) => {
        const data = input as { capability?: string }
        return data.capability ? [data.capability] : []
      },
    }
    assert.deepEqual(resolveFeatures(config, { capability: 'browser-use' }), ['browser-use'])
  })

  it('deduplicates selected ids', () => {
    const config: TaskFeatureConfig = {
      available: ['browser-use', 'computer-use'],
      select: () => ['browser-use', 'browser-use'],
    }
    assert.deepEqual(resolveFeatures(config, {}), ['browser-use'])
  })

  it('returns [] when select() returns empty array', () => {
    const config: TaskFeatureConfig = {
      available: ['browser-use'],
      select: () => [],
    }
    assert.deepEqual(resolveFeatures(config, {}), [])
  })

  it('throws when select() returns undefined', () => {
    const config: TaskFeatureConfig = {
      available: ['browser-use'],
      select: () => undefined as unknown as readonly string[],
    }
    assert.throws(() => resolveFeatures(config, {}), /array of non-empty strings/)
  })

  it('throws when selected id is not in available', () => {
    const config: TaskFeatureConfig = {
      available: ['browser-use'],
      select: () => ['computer-use'],
    }
    assert.throws(() => resolveFeatures(config, {}), /not in the declared available set/)
  })

  it('throws when available contains duplicates', () => {
    assert.throws(
      () => resolveFeatures(
        { available: ['browser-use', 'browser-use'] } as TaskFeatureConfig,
        {},
      ),
      /Duplicate/,
    )
  })

  it('throws when available contains empty string', () => {
    assert.throws(
      () => resolveFeatures(
        { available: ['browser-use', ''] } as TaskFeatureConfig,
        {},
      ),
      /non-empty string/,
    )
  })

  it('preserves declaration order after dedup', () => {
    const config: TaskFeatureConfig = {
      available: ['browser-use', 'computer-use'],
      select: () => ['computer-use', 'browser-use'],
    }
    assert.deepEqual(resolveFeatures(config, {}), ['computer-use', 'browser-use'])
  })
})
