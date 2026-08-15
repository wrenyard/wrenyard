/**
 * Work config tests: validation, normalization, WORK.md requirement.
 *
 * Verifies:
 * - work config requires workspace_root with WORK.md
 * - work config requires llm.model
 * - normalizeWorkConfig throws on missing WORK.md
 * - work config normalization produces correct types
 */

import { describe, it, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeForemanServiceConfig } from '../../lib/config/normalize.mts'
import type { ConfigRecord } from '../../lib/config/types.mts'

// ── Helpers ───────────────────────────────────────────────────────────

function createWorkDir(withWorkMd = true): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'foreman-work-config-'))
  if (withWorkMd) {
    writeFileSync(join(root, 'WORK.md'), '# Foreman Work\n\nYou are a helpful agent.\n')
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function baseConfig(): ConfigRecord {
  return {
    service: {
      enabled: true,
      bind: '127.0.0.1:8787',
    },
    workspace: {
      root: '/tmp/test-workspace',
    },
    message: {
      principals: {},
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('normalizeWorkConfig', () => {
  const tempDirs: Array<{ cleanup: () => void }> = []

  afterEach(() => {
    for (const dir of tempDirs) dir.cleanup()
    tempDirs.length = 0
  })

  it('returns undefined when no work config is present', () => {
    const cfg = baseConfig()
    const result = normalizeForemanServiceConfig(cfg, { configDir: '/tmp/test-config' })
    assert.equal(result.work, undefined, 'work should be undefined when not configured')
  })

  it('throws on missing WORK.md', () => {
    const { root } = createWorkDir(false)
    tempDirs.push({ cleanup: () => rmSync(root, { recursive: true, force: true }) })

    const cfg = {
      ...baseConfig(),
      work: {
        workspace_root: root,
        llm: {
          model: 'test/model',
        },
      },
    }

    assert.throws(
      () => normalizeForemanServiceConfig(cfg, { configDir: '/tmp/test-config' }),
      /WORK\.md/,
      'Should throw when WORK.md is missing',
    )
  })

  it('throws on missing llm.model', () => {
    const { root, cleanup } = createWorkDir()
    tempDirs.push({ cleanup })

    const cfg = {
      ...baseConfig(),
      work: {
        workspace_root: root,
        llm: {
          // model is omitted
        },
      },
    }

    assert.throws(
      () => normalizeForemanServiceConfig(cfg, { configDir: '/tmp/test-config' }),
      /model/,
      'Should throw when llm.model is missing',
    )
  })

  it('normalizes valid work config', () => {
    const { root, cleanup } = createWorkDir()
    tempDirs.push({ cleanup })

    const cfg = {
      ...baseConfig(),
      work: {
        workspace_root: root,
        llm: {
          model: 'foreman-public/work-v3',
          turn_timeout_ms: 600_000,
          http_timeout_ms: 90_000,
          max_retries: 4,
          retry_backoff_ms: 1000,
        },
      },
    }

    const result = normalizeForemanServiceConfig(cfg, { configDir: '/tmp/test-config' })
    assert.ok(result.work, 'work config should be present')
    assert.equal(result.work!.workspaceRoot, resolve(root), 'workspaceRoot should be resolved absolute path')
    assert.equal(result.work!.llm.model, 'foreman-public/work-v3')
    assert.equal(result.work!.llm.turn_timeout_ms, 600_000)
    assert.equal(result.work!.llm.http_timeout_ms, 90_000)
    assert.equal(result.work!.llm.max_retries, 4)
    assert.equal(result.work!.llm.retry_backoff_ms, 1000)
  })

  it('uses default LLM values when optional fields omitted', () => {
    const { root, cleanup } = createWorkDir()
    tempDirs.push({ cleanup })

    const cfg = {
      ...baseConfig(),
      work: {
        workspace_root: root,
        llm: {
          model: 'test/model',
        },
      },
    }

    const result = normalizeForemanServiceConfig(cfg, { configDir: '/tmp/test-config' })
    assert.ok(result.work)
    assert.equal(result.work!.llm.turn_timeout_ms, 300_000, 'default turn_timeout_ms should be 300000')
    assert.equal(result.work!.llm.http_timeout_ms, 120_000, 'default http_timeout_ms should be 120000')
    assert.equal(result.work!.llm.max_retries, 2, 'default max_retries should be 2')
    assert.equal(result.work!.llm.retry_backoff_ms, 500, 'default retry_backoff_ms should be 500')
  })

  it('normalizes valid work config with an explicit models list', () => {
    const { root, cleanup } = createWorkDir()
    tempDirs.push({ cleanup })

    const cfg = {
      ...baseConfig(),
      work: {
        workspace_root: root,
        llm: {
          model: 'foreman-public/work-v3',
          models: ['foreman-public/work-v3', 'foreman-public/work-v4'],
        },
      },
    }

    const result = normalizeForemanServiceConfig(cfg, { configDir: '/tmp/test-config' })
    assert.ok(result.work)
    assert.deepEqual(result.work!.llm.models, ['foreman-public/work-v3', 'foreman-public/work-v4'])
  })

  it('omits models when work.llm.models is absent', () => {
    const { root, cleanup } = createWorkDir()
    tempDirs.push({ cleanup })

    const cfg = {
      ...baseConfig(),
      work: {
        workspace_root: root,
        llm: {
          model: 'test/model',
        },
      },
    }

    const result = normalizeForemanServiceConfig(cfg, { configDir: '/tmp/test-config' })
    assert.ok(result.work)
    assert.equal(result.work!.llm.models, undefined, 'models should be absent when not configured')
  })

  it('rejects stale max_iterations', () => {
    const { root, cleanup } = createWorkDir()
    tempDirs.push({ cleanup })

    const cfg = {
      ...baseConfig(),
      work: {
        workspace_root: root,
        llm: {
          model: 'test/model',
          max_iterations: 5,
        },
      },
    }

    assert.throws(
      () => normalizeForemanServiceConfig(cfg, { configDir: '/tmp/test-config' }),
      /max_iterations/,
      'Should reject stale max_iterations; turn termination is via turn_timeout_ms and cycle detection',
    )
  })
})
