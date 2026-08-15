import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, it } from 'node:test'
import {
  resolveForgeEnv,
  resolveForgeSpawnInvocation,
  resolveRuntimeBin,
  resolveWindowsHideOption,
} from '../lib/adapters/forge/exec.mts'

describe('forge exec environment', () => {
  it('prepends the user local bin directory to PATH for forge subprocesses', () => {
    const env = resolveForgeEnv({ PATH: '/usr/bin' })
    const parts = env.PATH?.split(delimiter)

    if (process.platform === 'win32') {
      assert.equal(parts?.[0], '/usr/bin')
    } else {
      assert.equal(parts?.[0], join(homedir(), '.local', 'bin'))
      assert.equal(parts?.[1], '/usr/bin')
    }
  })

  it('does not duplicate the user local bin directory when already present', () => {
    const localBin = join(homedir(), '.local', 'bin')
    const env = resolveForgeEnv({ PATH: `${localBin}${delimiter}/usr/bin` })
    const parts = env.PATH?.split(delimiter).filter((part) => part === localBin)

    assert.equal(parts?.length, 1)
  })
})

describe('forge exec windows behavior', () => {
  it('hides subprocess windows by default on Windows', () => {
    assert.equal(resolveWindowsHideOption({}), process.platform === 'win32' ? true : undefined)
  })

  it('honors explicit windowsHide overrides', () => {
    assert.equal(resolveWindowsHideOption({ windowsHide: false }), false)
    assert.equal(resolveWindowsHideOption({ windowsHide: true }), true)
  })
})

describe('forge runtime resolution precedence', () => {
  function suiteWith(runtimePaths: string[]): { suiteRoot: string; cleanup: () => void } {
    const suiteRoot = mkdtempSync(join(tmpdir(), 'wrenyard-suite-'))
    mkdirSync(join(suiteRoot, 'runtime', 'forge', 'bin'), { recursive: true })
    for (const relative of runtimePaths) {
      const absolute = join(suiteRoot, relative)
      mkdirSync(join(absolute, '..'), { recursive: true })
      writeFileSync(absolute, '')
    }
    return { suiteRoot, cleanup: () => rmSync(suiteRoot, { recursive: true, force: true }) }
  }

  it('prefers an explicit WRENYARD_RUNTIME_BIN over any suite runtime', () => {
    const suite = suiteWith(['.wrenyard/runtime/forge'])
    try {
      const env = { WRENYARD_RUNTIME_BIN: '/opt/forge', FOREMAN_FORGE_BIN: '/legacy/forge' }
      assert.equal(resolveRuntimeBin(env, { suiteRoot: suite.suiteRoot }), '/opt/forge')
    } finally {
      suite.cleanup()
    }
  })

  it('prefers the packed CLI .wrenyard runtime over suite zip and source runtimes', () => {
    const suite = suiteWith([
      '.wrenyard/runtime/forge',
      'bin/forge',
      'runtime/forge/bin/forge',
    ])
    try {
      assert.equal(
        resolveRuntimeBin({}, { suiteRoot: suite.suiteRoot }),
        join(suite.suiteRoot, '.wrenyard', 'runtime', 'forge'),
      )
    } finally {
      suite.cleanup()
    }
  })

  it('prefers the suite zip bin runtime over the source checkout runtime', () => {
    const suite = suiteWith(['bin/forge', 'runtime/forge/bin/forge'])
    try {
      assert.equal(
        resolveRuntimeBin({}, { suiteRoot: suite.suiteRoot }),
        join(suite.suiteRoot, 'bin', 'forge'),
      )
    } finally {
      suite.cleanup()
    }
  })

  it('falls back to the source checkout runtime when nothing packed exists', () => {
    const suite = suiteWith(['runtime/forge/bin/forge'])
    try {
      assert.equal(
        resolveRuntimeBin({}, { suiteRoot: suite.suiteRoot }),
        join(suite.suiteRoot, 'runtime', 'forge', 'bin', 'forge'),
      )
    } finally {
      suite.cleanup()
    }
  })

  it('falls back to a legacy FOREMAN_FORGE_BIN when no suite runtime exists', () => {
    const suite = suiteWith([])
    try {
      const env = { FOREMAN_FORGE_BIN: '/legacy/forge' }
      assert.equal(resolveRuntimeBin(env, { suiteRoot: suite.suiteRoot }), '/legacy/forge')
    } finally {
      suite.cleanup()
    }
  })

  it('returns bare `forge` as the final fallback when nothing else resolves', () => {
    const suite = suiteWith([])
    try {
      assert.equal(resolveRuntimeBin({}, { suiteRoot: suite.suiteRoot }), 'forge')
    } finally {
      suite.cleanup()
    }
  })

  it('uses .exe naming for the win32 platform', () => {
    const suite = suiteWith(['.wrenyard/runtime/forge.exe'])
    try {
      assert.equal(
        resolveRuntimeBin({}, { suiteRoot: suite.suiteRoot, platform: 'win32' }),
        join(suite.suiteRoot, '.wrenyard', 'runtime', 'forge.exe'),
      )
    } finally {
      suite.cleanup()
    }
  })

  it('respects an injected existsSync probe over the real filesystem', () => {
    const fakeExists = (path: string) => path === join('/virtual', 'bin', 'forge')
    assert.equal(
      resolveRuntimeBin({}, { suiteRoot: '/virtual', existsSync: fakeExists }),
      join('/virtual', 'bin', 'forge'),
    )
  })

  it('continues to legacy fallbacks when suite-root discovery fails', () => {
    const env = { FOREMAN_FORGE_BIN: '/legacy/forge' }
    assert.equal(resolveRuntimeBin(env, { existsSync: () => false }), '/legacy/forge')
  })

  it('threads the injected env through resolveForgeSpawnInvocation', () => {
    const env = { WRENYARD_RUNTIME_BIN: '/opt/forge', FOREMAN_FORGE_ARGS_PREFIX: '["--x"]' }
    const invocation = resolveForgeSpawnInvocation(['run'], env)
    assert.equal(invocation.command, '/opt/forge')
    assert.deepEqual(invocation.args, ['--x', 'run'])
  })
})
