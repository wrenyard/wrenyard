import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { buildDaemonInvocation, resolveDaemonSupervisorPaths } from '../../lib/client/cli/daemon-supervisor.mts'
import type { DaemonLifecycleOptions } from '../../lib/client/cli/daemon-supervisor.mts'
import type { ForemanServiceConfig } from '../../lib/config/index.mts'

const CONFIG_PATH = '/tmp/foreman-cfg/foreman.json'

// Minimal typed fixture: buildDaemonInvocation reads resolvedConfigPath and
// cliValues; the service config is supplied to satisfy the options type.
function makeOptions(cliValues?: Record<string, unknown>): DaemonLifecycleOptions {
  const config = {
    service: {
      host: '127.0.0.1',
      port: 4759,
    },
  } as unknown as ForemanServiceConfig
  return {
    config,
    resolvedConfigPath: CONFIG_PATH,
    ...(cliValues ? { cliValues } : {}),
  }
}

describe('buildDaemonInvocation', () => {
  it('uses process.execPath with on-disk tsx preflight/loader and the daemon entrypoint', () => {
    const inv = buildDaemonInvocation(makeOptions())
    assert.equal(inv.command, process.execPath)

    const preflight = inv.args[inv.args.indexOf('--require') + 1]
    const loader = fileURLToPath(inv.args[inv.args.indexOf('--import') + 1])
    const entrypoint = inv.args[inv.args.indexOf('--config') - 1]

    assert.ok(existsSync(preflight), `preflight must exist on disk: ${preflight}`)
    assert.ok(existsSync(loader), `loader must exist on disk: ${loader}`)
    assert.ok(
      entrypoint.endsWith(join('services', 'foreman', 'bin', 'foreman-deamon.mts')),
      `entrypoint must end with services/foreman/bin/foreman-deamon.mts, got: ${entrypoint}`,
    )
  })

  it('does not construct tsx paths from a hardcoded services/foreman/node_modules/tsx literal', () => {
    const inv = buildDaemonInvocation(makeOptions())
    const hardcodedLocalTsx = join('services', 'foreman', 'node_modules', 'tsx')
    for (const arg of inv.args) {
      assert.ok(
        !arg.includes(hardcodedLocalTsx),
        `argument must not reference a hardcoded local tsx path, got: ${arg}`,
      )
    }
  })

  it('uses wrenyard-daemon pid/json files and wrenyard logs', () => {
    const paths = resolveDaemonSupervisorPaths()
    assert.ok(paths.pidPath.endsWith(join('wrenyard', 'wrenyard-daemon.pid')))
    assert.ok(paths.statePath.endsWith(join('wrenyard', 'wrenyard-daemon.json')))
    assert.ok(paths.logPaths.stdout.endsWith(join('wrenyard', 'logs', 'wrenyard-out.log')))
    assert.ok(paths.logPaths.stderr.endsWith(join('wrenyard', 'logs', 'wrenyard-error.log')))
  })

  it('keeps config and host/port overrides as discrete arguments', () => {
    const inv = buildDaemonInvocation(makeOptions({ host: '127.0.0.1', port: '9999' }))
    assert.ok(inv.args.includes('--config'))
    assert.ok(inv.args.includes(CONFIG_PATH))
    assert.ok(inv.args.includes('--host'))
    assert.ok(inv.args.includes('127.0.0.1'))
    assert.ok(inv.args.includes('--port'))
    assert.ok(inv.args.includes('9999'))
  })
})
