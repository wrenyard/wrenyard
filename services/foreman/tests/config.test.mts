import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { createDefaultForemanConfigData } from '../lib/config/data.mts'
import { ForemanConfigManager } from '../lib/config/manager.mts'
import { normalizeForemanServiceConfig } from '../lib/config/normalize.mts'
import { resolveDefaultForemanConfigPath, resolveForemanConfigDir } from '../lib/config/path.mts'
import {
  applyTaskAgentRuntimeOverride,
  normalizeTaskAgentRuntimeOverrides,
  readTaskAgentRuntimeOverrides,
} from '../lib/config/task-runtime-override.mts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'foreman-config-'))
  roots.push(root)
  writeFileSync(join(root, 'FWA.md'), '# FWA\n')
  writeFileSync(join(root, 'WORK.md'), '# Work\n')
  return root
}

describe('Foreman config', () => {
  it('normalizes native FWA, Work, principals, and delivery routes', () => {
    const root = workspace()
    const config = normalizeForemanServiceConfig({
      service: { bind: '127.0.0.1:9876' },
      workspace: { root },
      fwa: { workspace_root: root, llm: { model: 'wrenyard-public/model' } },
      work: { workspace_root: root, llm: { model: 'wrenyard-public/model' } },
      message: {
        principals: {
          operator: {
            kind: 'human',
            can_send: true,
            can_receive: true,
            delivery_route: 'operator.telegram',
            grants: [{ name: 'message.send' }, { name: 'work.read' }],
          },
        },
        routes: {
          'operator.telegram': { transport: 'telegram', format: 'telegram-html' },
        },
      },
    }, { configDir: root, env: {} })

    assert.equal(config.service.port, 9876)
    assert.equal(config.workspaceRoot, root)
    assert.equal(config.fwa?.workspaceRoot, root)
    assert.equal(config.work?.workspaceRoot, root)
    assert.equal(config.message.principals.codex.canSend, true)
    assert.equal(config.message.principals.codex.canReceive, false)
    assert.equal(config.message.principals['foreman-work'].canReceive, true)
    assert.equal(config.message.routes?.['operator.telegram'].transport, 'telegram')
  })

  it('requires FWA.md and WORK.md at configured roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'foreman-config-missing-'))
    roots.push(root)
    assert.throws(
      () => normalizeForemanServiceConfig({
        fwa: { workspace_root: root, llm: { model: 'wrenyard-public/model' } },
      }, { configDir: root, env: {} }),
      /FWA\.md/,
    )
    assert.throws(
      () => normalizeForemanServiceConfig({
        work: { workspace_root: root, llm: { model: 'wrenyard-public/model' } },
      }, { configDir: root, env: {} }),
      /WORK\.md/,
    )
  })

  it('defaults to the current principal model without a resident agent role', () => {
    const defaults = createDefaultForemanConfigData({ env: {} })
    assert.ok(defaults.message?.principals?.codex)
    assert.equal(defaults.message?.principals?.['wrenyard-agent'], undefined)
    assert.equal(defaults.message?.routes?.['wrenyard.message-mcp'], undefined)
  })

  it('rejects removed resident-agent and message compatibility keys', () => {
    const root = workspace()
    assert.throws(
      () => normalizeForemanServiceConfig({ daily_session: { workspace_root: root } }, { configDir: root, env: {} }),
      /daily_session/u,
    )
    assert.throws(
      () => normalizeForemanServiceConfig({
        fwa: { backend: 'opencode', workspace_root: root, llm: { model: 'test' } },
      }, { configDir: root, env: {} }),
      /fwa\.backend/u,
    )
    assert.throws(
      () => normalizeForemanServiceConfig({ message: { local_role: 'wrenyard-agent' } }, { configDir: root, env: {} }),
      /message\.local_role/u,
    )
    assert.throws(
      () => normalizeForemanServiceConfig({
        message: { principals: { codex: { canSend: true } } },
      }, { configDir: root, env: {} }),
      /removed compatibility key/u,
    )
  })

  it('defaults config paths to the wrenyard config dir and honors primary env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrenyard-config-'))
    roots.push(dir)
    assert.equal(resolveForemanConfigDir({ XDG_CONFIG_HOME: dir }), join(dir, 'wrenyard'))
    assert.equal(resolveForemanConfigDir({ WRENYARD_CONFIG_HOME: dir }), dir)
  })

  it('reads a legacy ~/.config/foreman config as migration fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrenyard-config-legacy-'))
    roots.push(dir)
    mkdirSync(join(dir, 'foreman'), { recursive: true })
    writeFileSync(join(dir, 'foreman', 'config.json'), '{}\n', 'utf-8')
    assert.equal(
      resolveDefaultForemanConfigPath({ XDG_CONFIG_HOME: dir }),
      join(dir, 'foreman', 'config.json'),
    )
    mkdirSync(join(dir, 'wrenyard'), { recursive: true })
    writeFileSync(join(dir, 'wrenyard', 'config.json'), '{}\n', 'utf-8')
    assert.equal(
      resolveDefaultForemanConfigPath({ XDG_CONFIG_HOME: dir }),
      join(dir, 'wrenyard', 'config.json'),
    )
  })

  it('implicit writes create the wrenyard config and never touch legacy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrenyard-config-write-'))
    roots.push(dir)
    mkdirSync(join(dir, 'foreman'), { recursive: true })
    writeFileSync(
      join(dir, 'foreman', 'config.json'),
      '{"service":{"bind":"127.0.0.1:9999"}}\n',
      'utf-8',
    )
    const legacyPath = join(dir, 'foreman', 'config.json')
    const primaryPath = join(dir, 'wrenyard', 'config.json')
    const env = { XDG_CONFIG_HOME: dir }

    // Legacy-only read fallback: with no primary config the read resolves to
    // the legacy file.
    const manager = new ForemanConfigManager({ env })
    assert.equal(manager.resolvePath(), legacyPath)
    assert.deepEqual(
      JSON.parse(readFileSync(legacyPath, 'utf-8')) as { service: { bind: string } },
      { service: { bind: '127.0.0.1:9999' } },
    )

    // Implicit write targets the primary Wrenyard path and leaves the legacy
    // file byte-for-byte unchanged.
    manager.saveUserData(undefined, { service: { enabled: true } })
    assert.equal(existsSync(primaryPath), true)
    assert.equal(existsSync(legacyPath), true)
    assert.deepEqual(
      JSON.parse(readFileSync(legacyPath, 'utf-8')) as { service: { bind: string } },
      { service: { bind: '127.0.0.1:9999' } },
    )
    assert.deepEqual(
      JSON.parse(readFileSync(primaryPath, 'utf-8')) as { service: { enabled: boolean } },
      { service: { enabled: true } },
    )
  })

  it('honors WRENYARD_WORKSPACE with legacy FOREMAN_WORKSPACE read fallback', () => {
    assert.equal(
      createDefaultForemanConfigData({ env: { WRENYARD_WORKSPACE: '/wrenyard-ws' } }).workspace?.root,
      '/wrenyard-ws',
    )
    assert.equal(
      createDefaultForemanConfigData({ env: { FOREMAN_WORKSPACE: '/legacy-ws' } }).workspace?.root,
      '/legacy-ws',
    )
    const root = workspace()
    const config = normalizeForemanServiceConfig({}, { configDir: root, env: { WRENYARD_WORKSPACE: '/wrenyard-ws' } })
    assert.equal(config.workspaceRoot, '/wrenyard-ws')
  })

})

describe('tasks.agentRuntime overlay', () => {
  it('treats a missing or empty map as a no-op', () => {
    assert.deepEqual(normalizeTaskAgentRuntimeOverrides(undefined), {})
    assert.deepEqual(normalizeTaskAgentRuntimeOverrides({}), {})
    assert.equal(applyTaskAgentRuntimeOverride('commit', 'forge/fast', {}), 'forge/fast')
  })

  it('replaces declared runtimes for named tasks only', () => {
    const overrides = normalizeTaskAgentRuntimeOverrides({
      commit: 'forge/codex-spark',
      'explore-commit': ' forge/codex-spark ',
    })
    assert.equal(overrides.commit, 'forge/codex-spark')
    assert.equal(overrides['explore-commit'], 'forge/codex-spark')
    assert.equal(applyTaskAgentRuntimeOverride('commit', 'forge/fast', overrides), 'forge/codex-spark')
    assert.equal(applyTaskAgentRuntimeOverride('edit', 'forge/fast', overrides), 'forge/fast')
  })

  it('rejects invalid agentRuntime values', () => {
    assert.throws(
      () => normalizeTaskAgentRuntimeOverrides({ commit: 'codex-spark' }),
      /tasks\.agentRuntime\.commit/,
    )
    assert.throws(
      () => normalizeTaskAgentRuntimeOverrides({ commit: 'claude/sonnet' }),
      /Unsupported runtime/,
    )
    assert.throws(
      () => normalizeTaskAgentRuntimeOverrides('forge/codex-spark'),
      /must be an object/,
    )
  })

  it('reads overrides from the live Wrenyard config file', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'foreman-task-runtime-config-'))
    roots.push(configHome)
    mkdirSync(join(configHome, 'wrenyard'), { recursive: true })
    writeFileSync(
      join(configHome, 'wrenyard', 'config.json'),
      JSON.stringify({
        tasks: {
          agentRuntime: {
            commit: 'forge/codex-spark',
            'explore-commit': 'forge/codex-spark',
          },
        },
      }),
      'utf-8',
    )
    const env = { XDG_CONFIG_HOME: configHome }
    const overrides = readTaskAgentRuntimeOverrides(env)
    assert.equal(overrides.commit, 'forge/codex-spark')
    assert.equal(overrides['explore-commit'], 'forge/codex-spark')
    assert.equal(applyTaskAgentRuntimeOverride('commit', 'forge/fast', undefined, env), 'forge/codex-spark')
    assert.equal(applyTaskAgentRuntimeOverride('edit', 'forge/fast', undefined, env), 'forge/fast')
  })
})
