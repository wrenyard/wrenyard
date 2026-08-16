import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import type { ForemanPetConfig } from '../lib/config/index.mts'
import { resolveRuntimeBin } from '../lib/layout/runtime-bin.mts'
import { packagedPetExecutablePath, resolvePackagedPetExecutable } from '../lib/pet/packaged-pet.mts'
import { ForemanPetService, petRuntimePaths, resolvePetSpawnCommand, type PetSpawn } from '../lib/pet/pet-service.mts'

describe('ForemanPetService', () => {
  it('starts and stops an independent pet app child over IPC JSON-RPC config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-service-'))
    writeFileSync(join(dir, 'package.json'), '{}\n', 'utf-8')
    const stateRoot = join(dir, 'state')
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ pet: { enabled: false } }), 'utf-8')
    const fakeSpawn = createFakePetSpawn()

    const service = new ForemanPetService({
      config: petConfig({
        command: process.execPath,
        args: ['pet-child.mjs'],
        cwd: dir,
      }),
      configPath,
      foremanIpcPath: '/tmp/foreman-test.sock',
      stateRoot,
      spawnProcess: fakeSpawn.spawn,
      now: fixedClock([
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:01:00.000Z',
      ]),
    })

    try {
      await service.start()

      const started = service.status()
      assert.equal(started.state, 'running')
      assert.equal(started.enabled, true)
      assert.equal(started.running, true)
      assert.equal(started.transport, 'ipc-jsonrpc')
      assert.equal(started.command, process.execPath)
      assert.deepEqual(started.args, ['pet-child.mjs'])
      assert.equal(started.cwd, dir)
      assert.equal(started.ipc_path, '/tmp/foreman-test.sock')
      assert.equal(started.started_at, '2026-07-01T00:00:00.000Z')
      assert.equal(readPetEnabled(configPath), true)
      const runtimePaths = petRuntimePaths(stateRoot)
      assert.equal(readFileIfExists(runtimePaths.pidPath), '4300\n')
      assert.deepEqual(JSON.parse(readFileSync(runtimePaths.statePath, 'utf-8')), {
        version: 1,
        pid: 4300,
        ...(process.platform === 'win32' ? {} : { pgid: 4300 }),
        startedAt: '2026-07-01T00:00:00.000Z',
        command: process.execPath,
        args: ['pet-child.mjs'],
        cwd: dir,
        ipcPath: '/tmp/foreman-test.sock',
      })
      assert.equal(fakeSpawn.calls.length, 1)
      assert.equal(fakeSpawn.calls[0].command, process.execPath)
      assert.deepEqual(fakeSpawn.calls[0].args, ['pet-child.mjs'])
      assert.equal(fakeSpawn.calls[0].options.cwd, dir)
      assert.deepEqual(petEnvSnapshot(fakeSpawn.calls[0].options.env), {
        ipc: '/tmp/foreman-test.sock',
        managed: '1',
        runtime: resolveRuntimeBin(process.env),
      })

      await service.stop()
      const stopped = service.status()
      assert.equal(stopped.state, 'stopped')
      assert.equal(stopped.enabled, false)
      assert.equal(stopped.running, false)
      assert.equal(stopped.stopped_at, '2026-07-01T00:01:00.000Z')
      assert.equal(readPetEnabled(configPath), false)
      assert.equal(existsSync(runtimePaths.pidPath), false)
      assert.equal(existsSync(runtimePaths.statePath), false)
    } finally {
      await service.stop({ persist: false }).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('daemon autostart does not rewrite pet.enabled on shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-autostart-'))
    writeFileSync(join(dir, 'package.json'), '{}\n', 'utf-8')
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ pet: { enabled: true } }), 'utf-8')
    const fakeSpawn = createFakePetSpawn()

    const service = new ForemanPetService({
      config: petConfig({
        enabled: true,
        command: process.execPath,
        args: ['pet-child.mjs'],
        cwd: dir,
      }),
      configPath,
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: fakeSpawn.spawn,
    })

    try {
      await service.start({ persist: false })
      await service.stop({ persist: false })

      assert.equal(readPetEnabled(configPath), true)
      assert.equal(service.status().enabled, true)
    } finally {
      await service.stop({ persist: false }).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds the pet before restart and keeps the running child when the build fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-restart-build-'))
    writeFileSync(join(dir, 'package.json'), '{}\n', 'utf-8')
    const fakeSpawn = createFakePetSpawn()
    const buildCalls: string[] = []
    let buildError: Error | undefined
    const service = new ForemanPetService({
      config: petConfig({ cwd: dir }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: fakeSpawn.spawn,
      buildPet: async (cwd) => {
        buildCalls.push(cwd)
        if (buildError) throw buildError
      },
    })

    try {
      await service.start({ persist: false })
      const originalPid = service.status().pid
      buildError = new Error('pet build failed')

      await assert.rejects(service.restart({ persist: false }), /pet build failed/u)

      assert.deepEqual(buildCalls, [dir])
      assert.equal(service.status().state, 'running')
      assert.equal(service.status().pid, originalPid)
      assert.equal(fakeSpawn.calls.length, 1)
    } finally {
      await service.stop({ persist: false }).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restarts with freshly built pet artifacts after a successful build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-restart-built-'))
    writeFileSync(join(dir, 'package.json'), '{}\n', 'utf-8')
    const fakeSpawn = createFakePetSpawn()
    const order: string[] = []
    const service = new ForemanPetService({
      config: petConfig({ cwd: dir }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: (command, args, options) => {
        order.push('spawn')
        return fakeSpawn.spawn(command, args, options)
      },
      buildPet: async () => { order.push('build') },
    })

    try {
      await service.restart({ persist: false })

      assert.deepEqual(order, ['build', 'spawn'])
      assert.equal(service.status().state, 'running')
    } finally {
      await service.stop({ persist: false }).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('daemon shutdown does not clean up an untracked disabled pet app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-disabled-stop-'))
    const scriptsDir = join(dir, 'scripts')
    const markerPath = join(dir, 'stop-marker.txt')
    writeFileSync(join(dir, 'package.json'), '{}\n', 'utf-8')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(
      join(scriptsDir, 'stop.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerPath)}, 'cleaned')\n`,
      'utf-8',
    )

    const service = new ForemanPetService({
      config: petConfig({
        enabled: false,
        cwd: dir,
      }),
      foremanIpcPath: '/tmp/foreman-test.sock',
    })

    try {
      await service.stop({ persist: false })

      assert.equal(service.status().state, 'stopped')
      assert.equal(readFileIfExists(markerPath), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clears stale Foreman-owned runtime state when no child is attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-stale-runtime-'))
    const stateRoot = join(dir, 'state')
    const runtimePaths = petRuntimePaths(stateRoot)
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(runtimePaths.pidPath, '999999\n', 'utf-8')
    writeFileSync(runtimePaths.statePath, JSON.stringify({
      version: 1,
      pid: 999999,
      startedAt: '2026-07-01T00:00:00.000Z',
      command: 'npm',
      args: ['start'],
      cwd: dir,
    }), 'utf-8')

    const service = new ForemanPetService({
      config: petConfig({ cwd: dir }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      stateRoot,
    })

    try {
      await service.stop({ persist: false })

      assert.equal(existsSync(runtimePaths.pidPath), false)
      assert.equal(existsSync(runtimePaths.statePath), false)
      assert.equal(service.status().state, 'stopped')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports launch failures without loading pet UI code into Foreman', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-fail-'))
    const service = new ForemanPetService({
      config: petConfig({
        command: process.execPath,
        args: [join(dir, 'missing.mjs')],
        cwd: join(dir, 'missing-cwd'),
      }),
      foremanIpcPath: '/tmp/foreman-test.sock',
    })

    await assert.rejects(
      service.start({ persist: false }),
      /pet\.cwd does not exist/u,
    )
    assert.equal(service.status().state, 'failed')
    assert.match(service.status().last_error ?? '', /pet\.cwd does not exist/u)

    rmSync(dir, { recursive: true, force: true })
  })

  it('fails start when cwd exists but has no package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-no-pkg-'))
    const service = new ForemanPetService({
      config: petConfig({
        command: process.execPath,
        args: [join(dir, 'pet-child.mjs')],
        cwd: dir,
      }),
      foremanIpcPath: '/tmp/foreman-test.sock',
    })

    await assert.rejects(
      service.start({ persist: false }),
      /pet\.cwd must contain a package\.json file/u,
    )
    assert.equal(service.status().state, 'failed')
    assert.match(service.status().last_error ?? '', /package\.json/u)

    rmSync(dir, { recursive: true, force: true })
  })

  it('fails start when the pet process exits before the startup window is stable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-early-exit-'))
    writeFileSync(join(dir, 'package.json'), '{}\n', 'utf-8')
    const fakeSpawn = createFakePetSpawn({ exitAfterSpawn: { code: 42 } })
    const service = new ForemanPetService({
      config: petConfig({
        command: process.execPath,
        args: ['pet-child.mjs'],
        cwd: dir,
      }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: fakeSpawn.spawn,
    })

    await assert.rejects(
      service.start({ persist: false }),
      /pet child exited during startup: code 42/u,
    )
    assert.equal(service.status().state, 'failed')
    assert.match(service.status().last_error ?? '', /code 42/u)

    rmSync(dir, { recursive: true, force: true })
  })

  it('hides taskkill when terminating Windows pet process trees', () => {
    const source = readFileSync(join(process.cwd(), 'lib/pet/pet-service.mts'), 'utf-8')
    const taskkillCalls = source.match(/execFileAsync\('taskkill'/gu) ?? []

    assert.equal(taskkillCalls.length, 1)
    assert.match(source, /const HIDDEN_EXEC_OPTIONS: ExecFileOptions = \{ windowsHide: true \}/u)
    assert.match(
      source,
      /execFileAsync\('taskkill', \['\/pid', String\(pid\), '\/t', '\/f'\], HIDDEN_EXEC_OPTIONS\)/u,
    )
  })

  it('nests default pet runtime state under the XDG Wrenyard state root', () => {
    const paths = petRuntimePaths()
    assert.ok(paths.stateDir.endsWith(join('wrenyard', 'pet')))
    assert.ok(paths.pidPath.endsWith(join('wrenyard', 'pet', 'pet.pid')))
    assert.ok(paths.statePath.endsWith(join('wrenyard', 'pet', 'pet.json')))
  })

  it('starts a packaged pet executable without a top-level package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-packaged-start-'))
    const exe = packagedPetExecutablePath(dir, process.platform)
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, '#!/bin/sh\n', 'utf-8')
    const fakeSpawn = createFakePetSpawn()
    const service = new ForemanPetService({
      config: petConfig({ command: exe, args: [], cwd: dir }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: fakeSpawn.spawn,
    })

    try {
      await service.start({ persist: false })

      assert.equal(service.status().state, 'running')
      assert.equal(existsSync(join(dir, 'package.json')), false)
      assert.equal(fakeSpawn.calls.length, 1)
      assert.equal(fakeSpawn.calls[0].command, exe)
      assert.deepEqual(fakeSpawn.calls[0].args, [])
      assert.equal(fakeSpawn.calls[0].options.cwd, dir)
    } finally {
      await service.stop({ persist: false }).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a missing packaged pet executable before spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-packaged-missing-'))
    const fakeSpawn = createFakePetSpawn()
    const service = new ForemanPetService({
      config: petConfig({
        command: packagedPetExecutablePath(dir, process.platform),
        args: [],
        cwd: dir,
      }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: fakeSpawn.spawn,
    })

    try {
      await assert.rejects(service.start({ persist: false }))
      assert.equal(service.status().state, 'failed')
      assert.equal(fakeSpawn.calls.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty packaged pet executable before spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-packaged-empty-'))
    const exe = packagedPetExecutablePath(dir, process.platform)
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, '', 'utf-8')
    const fakeSpawn = createFakePetSpawn()
    const service = new ForemanPetService({
      config: petConfig({ command: exe, args: [], cwd: dir }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: fakeSpawn.spawn,
    })

    try {
      await assert.rejects(service.start({ persist: false }))
      assert.equal(service.status().state, 'failed')
      assert.equal(fakeSpawn.calls.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a wrong packaged pet executable that is not the canonical layout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-packaged-wrong-'))
    writeFileSync(join(dir, 'not-the-host-executable'), '#!/bin/sh\n', 'utf-8')
    const fakeSpawn = createFakePetSpawn()
    const service = new ForemanPetService({
      config: petConfig({
        command: join(dir, 'not-the-host-executable'),
        args: [],
        cwd: dir,
      }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: fakeSpawn.spawn,
    })

    try {
      await assert.rejects(service.start({ persist: false }))
      assert.equal(service.status().state, 'failed')
      assert.equal(fakeSpawn.calls.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restarts a packaged pet without building via npm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-packaged-restart-'))
    const exe = packagedPetExecutablePath(dir, process.platform)
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, '#!/bin/sh\n', 'utf-8')
    const fakeSpawn = createFakePetSpawn()
    const buildCalls: string[] = []
    const service = new ForemanPetService({
      config: petConfig({ command: exe, args: [], cwd: dir }),
      foremanIpcPath: '/tmp/foreman-test.sock',
      spawnProcess: fakeSpawn.spawn,
      buildPet: async (cwd) => { buildCalls.push(cwd) },
    })

    try {
      await service.restart({ persist: false })

      assert.equal(service.status().state, 'running')
      assert.deepEqual(buildCalls, [])
      assert.equal(fakeSpawn.calls.length, 1)
    } finally {
      await service.stop({ persist: false }).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolvePetSpawnCommand', () => {
  it('returns command/args unchanged on non-Windows platforms', () => {
    const result = resolvePetSpawnCommand('npm', ['start'], 'linux')
    assert.equal(result.command, 'npm')
    assert.deepEqual(result.args, ['start'])
  })

  it('returns .exe command/args unchanged on Windows', () => {
    const result = resolvePetSpawnCommand('node.exe', ['server.mjs'], 'win32')
    assert.equal(result.command, 'node.exe')
    assert.deepEqual(result.args, ['server.mjs'])
  })

  it('resolves a no-extension npm command to cmd.exe /d /s /c on Windows', () => {
    const result = resolvePetSpawnCommand('npm', ['start'], 'win32')
    assert.equal(result.command, 'cmd.exe')
    assert.deepEqual(result.args, ['/d', '/s', '/c', 'npm start'])
    assert.equal(result.windowsVerbatimArguments, true)
  })

  it('launches npm start through node directly on Windows when a foreground script exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-foreground-'))
    const scriptsDir = join(dir, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    const foregroundScript = join(scriptsDir, 'run-foreground.mjs')
    writeFileSync(foregroundScript, '// foreground\n', 'utf-8')
    try {
      const result = resolvePetSpawnCommand('npm', ['start'], 'win32', dir)
      assert.equal(result.command, process.execPath)
      assert.deepEqual(result.args, [foregroundScript])
      assert.equal(result.windowsVerbatimArguments, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to cmd.exe for npm start on Windows without a foreground script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-no-foreground-'))
    try {
      const result = resolvePetSpawnCommand('npm', ['start'], 'win32', dir)
      assert.equal(result.command, 'cmd.exe')
      assert.deepEqual(result.args, ['/d', '/s', '/c', 'npm start'])
      assert.equal(result.windowsVerbatimArguments, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('launches an npm.cmd full path through node directly on Windows when a foreground script exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-foreground-cmd-'))
    const scriptsDir = join(dir, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    const foregroundScript = join(scriptsDir, 'run-foreground.mjs')
    writeFileSync(foregroundScript, '// foreground\n', 'utf-8')
    try {
      const result = resolvePetSpawnCommand(
        'C:\\Program Files\\nodejs\\npm.cmd',
        ['start'],
        'win32',
        dir,
      )
      assert.equal(result.command, process.execPath)
      assert.deepEqual(result.args, [foregroundScript])
      assert.equal(result.windowsVerbatimArguments, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('quotes a .cmd path with spaces in the /c command line on Windows', () => {
    const result = resolvePetSpawnCommand(
      'C:\\Program Files\\nodejs\\npm.cmd',
      ['start'],
      'win32',
    )
    assert.equal(result.command, 'cmd.exe')
    assert.deepEqual(result.args, [
      '/d',
      '/s',
      '/c',
      '""C:\\Program Files\\nodejs\\npm.cmd" start"',
    ])
    assert.equal(result.windowsVerbatimArguments, true)
  })
})

describe('packaged pet layout resolver', () => {
  it('resolves direct macOS, Windows, and Linux packaged executable layouts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-layout-'))
    try {
      assert.equal(
        packagedPetExecutablePath(dir, 'darwin'),
        join(dir, 'Wrenyard Pet.app', 'Contents', 'MacOS', 'Wrenyard Pet'),
      )
      assert.equal(packagedPetExecutablePath(dir, 'win32'), join(dir, 'Wrenyard Pet.exe'))
      assert.equal(packagedPetExecutablePath(dir, 'linux'), join(dir, 'wrenyard-pet'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts only an existing non-empty regular packaged executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-layout-accept-'))
    try {
      assert.equal(resolvePackagedPetExecutable(dir, 'linux'), undefined)

      writeFileSync(join(dir, 'wrenyard-pet'), '', 'utf-8')
      assert.equal(resolvePackagedPetExecutable(dir, 'linux'), undefined)

      writeFileSync(join(dir, 'wrenyard-pet'), '#!/bin/sh\n', 'utf-8')
      assert.equal(resolvePackagedPetExecutable(dir, 'linux'), join(dir, 'wrenyard-pet'))

      rmSync(join(dir, 'wrenyard-pet'))
      mkdirSync(join(dir, 'wrenyard-pet'))
      assert.equal(resolvePackagedPetExecutable(dir, 'linux'), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves each platform layout only when its artifact exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-pet-layout-platforms-'))
    try {
      const macExe = packagedPetExecutablePath(dir, 'darwin')
      mkdirSync(dirname(macExe), { recursive: true })
      writeFileSync(macExe, '#!/bin/sh\n', 'utf-8')
      assert.equal(resolvePackagedPetExecutable(dir, 'darwin'), macExe)
      assert.equal(resolvePackagedPetExecutable(dir, 'linux'), undefined)

      const winExe = packagedPetExecutablePath(dir, 'win32')
      writeFileSync(winExe, 'MZ\x00\x00', 'utf-8')
      assert.equal(resolvePackagedPetExecutable(dir, 'win32'), winExe)

      const linuxExe = packagedPetExecutablePath(dir, 'linux')
      writeFileSync(linuxExe, '#!/bin/sh\n', 'utf-8')
      assert.equal(resolvePackagedPetExecutable(dir, 'linux'), linuxExe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function petConfig(overrides: Partial<ForemanPetConfig> = {}): ForemanPetConfig {
  return {
    enabled: false,
    command: 'npm',
    args: ['start'],
    cwd: process.cwd(),
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    restartOnExit: false,
    restartDelayMs: 10,
    ...overrides,
  }
}

function readPetEnabled(configPath: string): boolean | undefined {
  const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as { pet?: { enabled?: boolean } } | null
  return parsed?.pet?.enabled
}

function readFileIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf-8') : undefined
}

interface FakePetSpawnCall {
  command: string
  args: string[]
  options: SpawnOptions
}

function createFakePetSpawn(behavior: { exitAfterSpawn?: { code?: number; signal?: NodeJS.Signals }; pid?: number } = {}): { spawn: PetSpawn; calls: FakePetSpawnCall[]; children: ChildProcess[] } {
  const calls: FakePetSpawnCall[] = []
  const children: ChildProcess[] = []
  return {
    calls,
    children,
    spawn(command, args, spawnOptions) {
      calls.push({ command, args: [...args], options: spawnOptions })
      const child = createFakeChildProcess(behavior.pid ?? 4300)
      children.push(child)
      queueMicrotask(() => {
        child.emit('spawn')
        if (behavior.exitAfterSpawn) {
          queueMicrotask(() => {
            child.emit('exit', behavior.exitAfterSpawn?.code ?? null, behavior.exitAfterSpawn?.signal ?? null)
          })
        }
      })
      return child
    },
  }
}

function createFakeChildProcess(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess & {
    emit(event: string, ...args: unknown[]): boolean
    exitCode: number | null
    killed: boolean
    kill(signal?: NodeJS.Signals | number): boolean
    unref(): void
  }
  child.exitCode = null
  child.killed = false
  Object.defineProperty(child, 'pid', { value: pid, configurable: true })
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (child.killed) return true
    child.killed = true
    queueMicrotask(() => child.emit('exit', null, typeof signal === 'string' ? signal : 'SIGTERM'))
    return true
  }
  child.unref = () => {}
  return child
}

function petEnvSnapshot(env: SpawnOptions['env']): { ipc?: string; managed?: string; runtime?: string } {
  return {
    ipc: env?.WRENYARD_IPC_PATH,
    managed: env?.WRENYARD_PET_MANAGED,
    runtime: env?.WRENYARD_RUNTIME_BIN,
  }
}

function fixedClock(values: string[]): () => Date {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return new Date(value)
  }
}
