import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { foremanLogsRoot } from '../lib/message/logs.mts'

const oldStateHome = process.env.XDG_STATE_HOME

afterEach(() => {
  restoreEnv('XDG_STATE_HOME', oldStateHome)
})

test('default log root uses XDG user state, not the repository logs directory', () => {
  delete process.env.XDG_STATE_HOME

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const repoLogs = join(repoRoot, 'logs')

  assert.notEqual(resolve(foremanLogsRoot()), repoLogs)
  assert.equal(resolve(foremanLogsRoot()), resolve(join(homedir(), '.local', 'state', 'wrenyard', 'logs')))
})

test('XDG_STATE_HOME controls the log root', () => {
  const stateHome = join('/tmp', 'foreman-test-state')
  process.env.XDG_STATE_HOME = stateHome

  assert.equal(foremanLogsRoot(), join(resolve(stateHome), 'wrenyard', 'logs'))
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
