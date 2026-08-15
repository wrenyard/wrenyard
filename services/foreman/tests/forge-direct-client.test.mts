import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildForgeCommand } from '../lib/adapters/forge/direct-client.mts'

describe('forge direct client', () => {
  it('builds the synchronous direct runtime command without lifecycle flags', () => {
    const opts = {
      profile: 'forge/codex-spark',
      permission: 'readonly' as const,
      cwd: process.cwd(),
      prompt: 'hello',
    }

    const args = buildForgeCommand(opts)

    assert.deepEqual(args, [
      '--profile',
      'codex-spark',
      '--permission',
      'readonly',
      '-C',
      process.cwd(),
      '-f',
      'stream-json',
    ])
    assert.equal(args.includes('agent'), false)
    assert.equal(args.includes('--background'), false)
    assert.equal(args.includes('--work-dir'), false)
    assert.equal(args.includes('--prompt-file'), false)
    assert.equal(args.includes(opts.prompt), false)
  })

  it('rejects legacy Forge task-session ids as direct runtime resume ids', () => {
    assert.throws(
      () => buildForgeCommand({
        profile: 'forge/codex-spark',
        permission: 'readonly',
        cwd: process.cwd(),
        prompt: 'hello',
        resume: 'fg_20260620_abcd',
      }),
      /native session id.*legacy Forge task-session id/u,
    )
  })

  it('uses --profile-policy for forge policy config-ids (fast/general/ultra)', () => {
    const policyArgs = buildForgeCommand({
      profile: 'forge/general',
      permission: 'readonly',
      cwd: process.cwd(),
      prompt: 'hello',
    })

    assert.deepEqual(policyArgs, [
      '--profile-policy', 'general',
      '--permission', 'readonly',
      '-C', process.cwd(),
      '-f', 'stream-json',
    ])
  })

  it('uses --profile for forge concrete profile config-ids', () => {
    const args = buildForgeCommand({
      profile: 'forge/codex-luna',
      permission: 'readonly',
      cwd: process.cwd(),
      prompt: 'hello',
    })

    assert.deepEqual(args, [
      '--profile', 'codex-luna',
      '--permission', 'readonly',
      '-C', process.cwd(),
      '-f', 'stream-json',
    ])
  })

  it('resolvedProfile always uses --profile regardless of policy classification', () => {
    const args = buildForgeCommand({
      profile: 'forge/general',
      permission: 'readonly',
      cwd: process.cwd(),
      prompt: 'hello',
      resolvedProfile: 'codex-luna',
    })

    assert.deepEqual(args, [
      '--profile', 'codex-luna',
      '--permission', 'readonly',
      '-C', process.cwd(),
      '-f', 'stream-json',
    ])
  })

  it('rejects malformed agentRuntime (empty runtime)', () => {
    assert.throws(
      () => buildForgeCommand({
        profile: '/codex-luna',
        permission: 'readonly',
        cwd: process.cwd(),
        prompt: 'hello',
      }),
      /agentRuntime must be in the format/u,
    )
  })

  it('falls back to --profile for non-agentRuntime legacy strings', () => {
    const args = buildForgeCommand({
      profile: 'codex-flash',
      permission: 'readonly',
      cwd: process.cwd(),
      prompt: 'hello',
    })

    assert.deepEqual(args, [
      '--profile', 'codex-flash',
      '--permission', 'readonly',
      '-C', process.cwd(),
      '-f', 'stream-json',
    ])
  })

  it('emits no --cap when capabilities is absent', () => {
    const args = buildForgeCommand({
      profile: 'forge/codex-spark',
      permission: 'readonly',
      cwd: process.cwd(),
      prompt: 'hello',
    })
    assert.equal(args.includes('--cap'), false)
  })

  it('emits no --cap when capabilities is empty', () => {
    const args = buildForgeCommand({
      profile: 'forge/codex-spark',
      permission: 'readonly',
      cwd: process.cwd(),
      prompt: 'hello',
      capabilities: [],
    })
    assert.equal(args.includes('--cap'), false)
  })

  it('emits one --cap pair for a single capability', () => {
    const args = buildForgeCommand({
      profile: 'forge/codex-spark',
      permission: 'readonly',
      cwd: process.cwd(),
      prompt: 'hello',
      capabilities: ['browser-use'],
    })
    assert.equal(args.includes('--cap'), true)
    const capIdx = args.indexOf('--cap')
    assert.equal(args[capIdx + 1], 'browser-use')
    assert.equal(args.lastIndexOf('--cap'), capIdx)
  })

  it('emits two --cap pairs for two capabilities in declaration order', () => {
    const args = buildForgeCommand({
      profile: 'forge/codex-spark',
      permission: 'readonly',
      cwd: process.cwd(),
      prompt: 'hello',
      capabilities: ['browser-use', 'computer-use'],
    })
    const indices: number[] = []
    args.forEach((arg, i) => { if (arg === '--cap') indices.push(i) })
    assert.equal(indices.length, 2)
    assert.equal(args[indices[0] + 1], 'browser-use')
    assert.equal(args[indices[1] + 1], 'computer-use')
  })
})
