import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePowerShellForemanArgs, resolveCliArgs } from '../lib/client/cli/args.mts'

describe('Foreman CLI argument normalization', () => {
  it('preserves tail JSON from raw PowerShell invocation lines', () => {
    const args = parsePowerShellForemanArgs(
      `foreman task run explore-code -p app '{"focus":"check task api","limit":5}'`,
    )

    assert.deepEqual(args, [
      'task',
      'run',
      'explore-code',
      '-p',
      'app',
      '{"focus":"check task api","limit":5}',
    ])
  })

  it('handles npm PowerShell shim path invocations', () => {
    const args = parsePowerShellForemanArgs(
      `& 'C:\\Users\\operator\\AppData\\Roaming\\npm\\foreman.ps1' task run echo -p app '{"text":"hello world"}'`,
    )

    assert.deepEqual(args, [
      'task',
      'run',
      'echo',
      '-p',
      'app',
      '{"text":"hello world"}',
    ])
  })

  it('falls back to argv when the raw line is not a foreman invocation', () => {
    assert.deepEqual(resolveCliArgs(['task', 'list'], 'node script.mjs task run'), ['task', 'list'])
  })
})
