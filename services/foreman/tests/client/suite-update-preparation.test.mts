import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildSuitePreparationCommands,
  prepareWrenyardSuite,
  resolveDependencyPackageRoot,
  SuitePreparationError,
  type SuitePreparationCommand,
  type SuitePreparationRunner,
} from '../../lib/client/cli/suite-update-preparation.mts'

/** Create a temporary checkout with the minimal suite markers (no real build). */
function makeCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'suite-prep-'))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - services/*\n')
  writeFileSync(join(root, 'release-manifest.json'), '{"version":"0.1.0-dev.0"}\n')
  mkdirSync(join(root, 'runtime', 'forge'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'forge', 'go.mod'), 'module wrenyard/runtime/forge\n\ngo 1.22\n')
  mkdirSync(join(root, 'services', 'foreman'), { recursive: true })
  writeFileSync(join(root, 'services', 'foreman', 'package.json'), '{"name":"foreman"}\n')
  return root
}

const FORGE_ARTIFACT = process.platform === 'win32' ? 'forge.exe' : 'forge'

describe('buildSuitePreparationCommands', () => {
  it('emits the exact five-command sequence with the injected pnpm CLI', () => {
    const root = makeCheckout()
    try {
      const pnpmCliPath = join(root, 'node_modules', '.pnpm', 'pnpm@11.19.0', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      // The injected CLI must exist on disk: preparation validates the CLI
      // path before returning any command.
      mkdirSync(join(root, 'node_modules', '.pnpm', 'pnpm@11.19.0', 'node_modules', 'pnpm', 'bin'), { recursive: true })
      writeFileSync(pnpmCliPath, '')
      const commands = buildSuitePreparationCommands(root, { pnpmCliPath })

      assert.equal(commands.length, 5)
      // Frozen install via the injected (detached-updater-safe) pnpm CLI.
      assert.deepEqual(commands[0], {
        command: process.execPath,
        args: [pnpmCliPath, 'install', '--frozen-lockfile'],
        cwd: root,
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
      })
      assert.deepEqual(commands[1].args, [pnpmCliPath, 'run', 'typecheck'])
      assert.deepEqual(commands[2].args, [pnpmCliPath, 'run', 'build'])
      // Go build into the platform-specific Forge artifact under runtime/forge/bin.
      assert.deepEqual(commands[3], {
        command: 'go',
        args: [
          '-C',
          join(root, 'runtime', 'forge'),
          'build',
          '-o',
          join(root, 'runtime', 'forge', 'bin', FORGE_ARTIFACT),
          './cmd/forge',
        ],
        cwd: root,
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
      })
      // Replay-safe Forge self-install using the freshly built binary.
      assert.deepEqual(commands[4], {
        command: join(root, 'runtime', 'forge', 'bin', FORGE_ARTIFACT),
        args: ['setup', '--self-install'],
        cwd: root,
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
      })
      for (const command of commands) {
        assert.equal(command.cwd, root)
        assert.equal(command.shell, false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails before producing any command when a suite marker is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-prep-missing-'))
    try {
      const pnpmCliPath = join(root, 'pnpm.cjs')
      assert.throws(
        () => buildSuitePreparationCommands(root, { pnpmCliPath }),
        (error: unknown) =>
          error instanceof SuitePreparationError && error.code === 'missing_suite_marker',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the pnpm package root through Node package semantics when no CLI is injected', () => {
    const root = makeCheckout()
    try {
      const pnpmPackageRoot = join(root, 'node_modules', 'pnpm')
      mkdirSync(join(pnpmPackageRoot, 'bin'), { recursive: true })
      writeFileSync(
        join(pnpmPackageRoot, 'package.json'),
        JSON.stringify({ name: 'pnpm', version: '11.19.0', bin: { pnpm: 'bin/pnpm.cjs' } }),
      )
      writeFileSync(join(pnpmPackageRoot, 'index.js'), 'module.exports = {}')
      writeFileSync(join(pnpmPackageRoot, 'bin', 'pnpm.cjs'), '')
      assert.equal(resolveDependencyPackageRoot(root, 'pnpm'), realpathSync(pnpmPackageRoot))
      const commands = buildSuitePreparationCommands(root)
      assert.ok(commands[0].args[0].endsWith(join('node_modules', 'pnpm', 'bin', 'pnpm.cjs')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails before the runner when an injected pnpm CLI does not exist', async () => {
    const root = makeCheckout()
    try {
      let runs = 0
      const runner: SuitePreparationRunner = {
        run: async () => {
          runs++
          return { status: 0, signal: null }
        },
      }
      await assert.rejects(
        prepareWrenyardSuite(root, {
          pnpmCliPath: join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
          runner,
        }),
        (error: unknown) =>
          error instanceof SuitePreparationError && error.code === 'dependency_package_not_found',
      )
      assert.equal(runs, 0, 'no command may run when the injected pnpm CLI is missing')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('prepareWrenyardSuite', () => {
  it('runs every command in exact order when each succeeds', async () => {
    const root = makeCheckout()
    try {
      const pnpmCliPath = join(root, 'pnpm.cjs')
      writeFileSync(pnpmCliPath, '')
      const runs: string[] = []
      const runner: SuitePreparationRunner = {
        run: async (command: SuitePreparationCommand) => {
          runs.push(command.args[command.args.length - 1])
          return { status: 0, signal: null }
        },
      }
      await prepareWrenyardSuite(root, { pnpmCliPath, runner })
      assert.deepEqual(runs, [
        '--frozen-lockfile',
        'typecheck',
        'build',
        './cmd/forge',
        '--self-install',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails on missing markers without invoking the runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-prep-prep-missing-'))
    try {
      let runs = 0
      const runner: SuitePreparationRunner = {
        run: async () => {
          runs++
          return { status: 0, signal: null }
        },
      }
      await assert.rejects(
        prepareWrenyardSuite(root, { pnpmCliPath: join(root, 'pnpm.cjs'), runner }),
        (error: unknown) =>
          error instanceof SuitePreparationError && error.code === 'missing_suite_marker',
      )
      assert.equal(runs, 0, 'no command may run when the checkout is not a suite')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops subsequent commands when an injected runner reports nonzero', async () => {
    const root = makeCheckout()
    try {
      const pnpmCliPath = join(root, 'pnpm.cjs')
      writeFileSync(pnpmCliPath, '')
      const ran: string[] = []
      let failing = true
      const runner: SuitePreparationRunner = {
        run: async (command: SuitePreparationCommand) => {
          ran.push(command.args[command.args.length - 1])
          if (failing) {
            failing = false
            return { status: 1, signal: null }
          }
          return { status: 0, signal: null }
        },
      }
      await assert.rejects(
        prepareWrenyardSuite(root, { pnpmCliPath, runner }),
        (error: unknown) =>
          error instanceof SuitePreparationError && error.code === 'suite_command_failed',
      )
      assert.equal(ran.length, 1, 'subsequent commands must not run after the first failure')
      assert.deepEqual(ran, ['--frozen-lockfile'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('wraps a runner startup error in a stable SuitePreparationError', async () => {
    const root = makeCheckout()
    try {
      const runner: SuitePreparationRunner = {
        run: async () => {
          throw new Error('spawn ENOENT')
        },
      }
      writeFileSync(join(root, 'pnpm.cjs'), '')
      await assert.rejects(
        prepareWrenyardSuite(root, { pnpmCliPath: join(root, 'pnpm.cjs'), runner }),
        (error: unknown) =>
          error instanceof SuitePreparationError && error.code === 'suite_command_error',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
