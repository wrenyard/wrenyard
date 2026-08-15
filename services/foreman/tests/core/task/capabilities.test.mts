import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveCapabilities } from '../../../lib/core/task/capabilities.mts'
import type { TaskCapabilityConfig } from '../../../lib/core/task/types.mts'

describe('core task resolveCapabilities', () => {
  it('returns [] when config is undefined', () => {
    assert.deepEqual(resolveCapabilities(undefined, {}), [])
  })

  it('returns all available when select is absent', () => {
    const config: TaskCapabilityConfig = { available: ['browser-use', 'computer-use'] }
    assert.deepEqual(resolveCapabilities(config, {}), ['browser-use', 'computer-use'])
  })

  it('returns selected ids from select function', () => {
    const config: TaskCapabilityConfig = {
      available: ['browser-use', 'computer-use'],
      select: (input: unknown) => {
        const data = input as { capability?: string }
        return data.capability ? [data.capability] : []
      },
    }
    assert.deepEqual(resolveCapabilities(config, { capability: 'browser-use' }), ['browser-use'])
  })

  it('deduplicates selected ids', () => {
    const config: TaskCapabilityConfig = {
      available: ['browser-use', 'computer-use'],
      select: () => ['browser-use', 'browser-use'],
    }
    assert.deepEqual(resolveCapabilities(config, {}), ['browser-use'])
  })

  it('returns [] when select() returns empty array', () => {
    const config: TaskCapabilityConfig = {
      available: ['browser-use'],
      select: () => [],
    }
    assert.deepEqual(resolveCapabilities(config, {}), [])
  })

  it('throws when select() returns undefined', () => {
    const config: TaskCapabilityConfig = {
      available: ['browser-use'],
      select: () => undefined as unknown as readonly string[],
    }
    assert.throws(() => resolveCapabilities(config, {}), /array of non-empty strings/)
  })

  it('throws when selected id is not in available', () => {
    const config: TaskCapabilityConfig = {
      available: ['browser-use'],
      select: () => ['computer-use'],
    }
    assert.throws(() => resolveCapabilities(config, {}), /not in the declared available set/)
  })

  it('throws when available contains duplicates', () => {
    assert.throws(
      () => resolveCapabilities(
        { available: ['browser-use', 'browser-use'] } as TaskCapabilityConfig,
        {},
      ),
      /Duplicate/,
    )
  })

  it('throws when available contains empty string', () => {
    assert.throws(
      () => resolveCapabilities(
        { available: ['browser-use', ''] } as TaskCapabilityConfig,
        {},
      ),
      /non-empty string/,
    )
  })

  it('preserves declaration order after dedup', () => {
    const config: TaskCapabilityConfig = {
      available: ['browser-use', 'computer-use'],
      select: () => ['computer-use', 'browser-use'],
    }
    assert.deepEqual(resolveCapabilities(config, {}), ['computer-use', 'browser-use'])
  })
})
