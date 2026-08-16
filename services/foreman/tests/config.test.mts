import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { createDefaultForemanConfigData } from '../lib/config/data.mts'
import { ForemanConfigManager } from '../lib/config/manager.mts'
import { normalizeForemanServiceConfig } from '../lib/config/normalize.mts'
import { resolveDefaultForemanConfigPath, resolveForemanConfigDir } from '../lib/config/path.mts'
import { packagedPetExecutablePath } from '../lib/pet/packaged-pet.mts'

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

function suite(): string {
  const root = mkdtempSync(join(tmpdir(), 'foreman-config-suite-'))
  roots.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
  writeFileSync(join(root, 'release-manifest.json'), '{}\n')
  const petDir = join(root, 'apps', 'pet')
  mkdirSync(petDir, { recursive: true })
  writeFileSync(join(petDir, 'package.json'), '{ "name": "pet" }\n')
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

  it('defaults pet.cwd to the suite apps/pet under WRENYARD_ROOT', () => {
    const root = suite()
    const config = normalizeForemanServiceConfig({}, { configDir: root, env: { WRENYARD_ROOT: root } })
    assert.ok(config.pet)
    assert.equal(config.pet.cwd, join(realpathSync(root), 'apps', 'pet'))
  })

  it('resolves the canonical apps/pet candidate without a package.json and never throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'foreman-config-suite-nopet-'))
    roots.push(root)
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
    writeFileSync(join(root, 'release-manifest.json'), '{}\n')
    // Pet is optional and separately packaged: status-style config loads must
    // normalize successfully even when apps/pet/package.json is absent.
    const config = normalizeForemanServiceConfig({}, { configDir: root, env: { WRENYARD_ROOT: root } })
    assert.ok(config.pet)
    assert.equal(config.pet.cwd, join(realpathSync(root), 'apps', 'pet'))
    assert.equal(existsSync(join(config.pet.cwd, 'package.json')), false)
  })

  it('keeps explicit relative pet.cwd relative to configDir, overriding the suite default', () => {
    const root = suite()
    const configDir = mkdtempSync(join(tmpdir(), 'foreman-config-cwd-'))
    roots.push(configDir)
    const config = normalizeForemanServiceConfig({ pet: { cwd: 'pet-local' } }, { configDir, env: { WRENYARD_ROOT: root } })
    assert.ok(config.pet)
    assert.equal(config.pet.cwd, join(configDir, 'pet-local'))
  })

  it('selects the packaged pet executable with empty args when a release artifact exists', () => {
    const root = suite()
    const petDir = join(realpathSync(root), 'apps', 'pet')
    rmSync(join(petDir, 'package.json'))
    const exe = packagedPetExecutablePath(petDir, process.platform)
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, '#!/bin/sh\n', 'utf-8')

    const config = normalizeForemanServiceConfig({}, { configDir: root, env: { WRENYARD_ROOT: root } })
    assert.ok(config.pet)
    assert.equal(config.pet.command, exe)
    assert.deepEqual(config.pet.args, [])
    assert.equal(config.pet.cwd, petDir)
  })

  it('keeps the npm start source defaults for a development pet checkout', () => {
    const root = suite()
    const config = normalizeForemanServiceConfig({}, { configDir: root, env: { WRENYARD_ROOT: root } })
    assert.ok(config.pet)
    assert.equal(config.pet.command, 'npm')
    assert.deepEqual(config.pet.args, ['start'])
  })

  it('explicit pet command, args, and cwd override packaged detection', () => {
    const root = suite()
    const petDir = join(realpathSync(root), 'apps', 'pet')
    const exe = packagedPetExecutablePath(petDir, process.platform)
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, '#!/bin/sh\n', 'utf-8')

    const config = normalizeForemanServiceConfig({
      pet: { command: 'custom-pet', args: ['--flag'], cwd: 'pet-local' },
    }, { configDir: root, env: { WRENYARD_ROOT: root } })
    assert.ok(config.pet)
    assert.equal(config.pet.command, 'custom-pet')
    assert.deepEqual(config.pet.args, ['--flag'])
    assert.equal(config.pet.cwd, join(root, 'pet-local'))
  })
})
