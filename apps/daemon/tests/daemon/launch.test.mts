import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { packagedDaemonLaunch } from '../../lib/daemon/launch.mts'

test('packagedDaemonLaunch runs the daemon bundle with the suite Node and an explicit config', () => {
  const suite = join('C:', 'Program Files', 'wrenyard-desktop', 'resources', 'wrenyard')
  const config = join('C:', 'Users', 'me', '.config', 'wrenyard', 'config.json')
  const launch = packagedDaemonLaunch(suite, config)
  assert.equal(launch.command, join(suite, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))
  assert.deepEqual(launch.args, [join(suite, 'daemon', 'daemon.mjs'), 'run', '--config', config])
  assert.equal(launch.cwd, suite)
  assert.equal('env' in launch, false)
})
