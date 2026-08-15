import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  buildForgeLlmCommand,
  runForgeLlm,
  serializeLlmInput,
} from '../lib/adapters/forge/llm-client.mts'

let tempDirs: string[] = []
const oldForgeBin = process.env.WRENYARD_RUNTIME_BIN
const oldForgeArgsPrefix = process.env.WRENYARD_FORGE_ARGS_PREFIX

afterEach(() => {
  if (oldForgeBin === undefined) delete process.env.WRENYARD_RUNTIME_BIN
  else process.env.WRENYARD_RUNTIME_BIN = oldForgeBin
  if (oldForgeArgsPrefix === undefined) delete process.env.WRENYARD_FORGE_ARGS_PREFIX
  else process.env.WRENYARD_FORGE_ARGS_PREFIX = oldForgeArgsPrefix
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('forge llm client', () => {
  it('builds forge llm commands without Foreman-owned provider credentials', () => {
    assert.deepEqual(buildForgeLlmCommand('hello', {
      model: 'kimi-for-coding',
      maxTokens: 32,
      temperature: 0.2,
    }), [
      'llm',
      '-m',
      'kimi-for-coding',
      '-p',
      'hello',
      '--max-tokens',
      '32',
    ])
  })

  it('runs forge llm through the Forge invocation adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-forge-llm-'))
    tempDirs.push(dir)
    const script = join(dir, 'fake-forge.mjs')
    const argsPath = join(dir, 'args.json')
    writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write('forge llm response\\n')
`, 'utf-8')
    process.env.WRENYARD_RUNTIME_BIN = process.execPath
    process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])

    const result = await runForgeLlm('hello', { model: 'kimi-for-coding', maxTokens: 4 })

    assert.equal(result, 'forge llm response')
    assert.deepEqual(JSON.parse(readFileSync(argsPath, 'utf-8')) as string[], [
      'llm',
      '-m',
      'kimi-for-coding',
      '-p',
      'hello',
      '--max-tokens',
      '4',
    ])
  })

  it('builds forge llm commands for a native request body', () => {
    const body = { model: 'gpt-4', messages: [] }
    assert.deepEqual(buildForgeLlmCommand(body, { protocol: 'openai', maxTokens: 16 }), [
      'llm',
      '--protocol',
      'openai',
      '--stdin',
      '--max-tokens',
      '16',
    ])
  })

  it('forwards explicit timeout and bounded retry flags to forge llm', () => {
    const body = { model: 'glm-5.2', messages: [] }
    assert.deepEqual(buildForgeLlmCommand(body, {
      model: 'zhipu-coding/glm-5.2',
      protocol: 'openai',
      timeoutMs: 90_000,
      maxRetries: 2,
      retryBackoffMs: 500,
    }), [
      'llm',
      '-m',
      'zhipu-coding/glm-5.2',
      '--timeout-ms',
      '90000',
      '--max-retries',
      '2',
      '--retry-backoff-ms',
      '500',
      '--protocol',
      'openai',
      '--stdin',
    ])
  })

  it('forwards a native OpenAI request body with --stdin and single JSON serialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-forge-llm-native-openai-'))
    tempDirs.push(dir)
    const script = join(dir, 'fake-forge.mjs')
    const argsPath = join(dir, 'args.json')
    const stdinPath = join(dir, 'stdin.txt')
    writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)))
let stdinData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { stdinData += chunk })
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(stdinPath)}, stdinData)
  process.stdout.write('forge llm response\\n')
})
`, 'utf-8')
    process.env.WRENYARD_RUNTIME_BIN = process.execPath
    process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])

    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }
    const result = await runForgeLlm(body, { model: 'gpt-4', protocol: 'openai' })

    assert.equal(result, 'forge llm response')
    const args = JSON.parse(readFileSync(argsPath, 'utf-8')) as string[]
    assert.deepEqual(args, [
      'llm',
      '-m',
      'gpt-4',
      '--protocol',
      'openai',
      '--stdin',
    ])
    const stdinContent = readFileSync(stdinPath, 'utf-8')
    assert.equal(stdinContent, serializeLlmInput(body))
  })

  it('forwards a native Anthropic request body with --stdin and --protocol anthropic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-forge-llm-native-anthropic-'))
    tempDirs.push(dir)
    const script = join(dir, 'fake-forge.mjs')
    const argsPath = join(dir, 'args.json')
    const stdinPath = join(dir, 'stdin.txt')
    writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)))
let stdinData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { stdinData += chunk })
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(stdinPath)}, stdinData)
  process.stdout.write('forge llm response\\n')
})
`, 'utf-8')
    process.env.WRENYARD_RUNTIME_BIN = process.execPath
    process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])

    const body = { model: 'claude-3-opus', messages: [{ role: 'user', content: 'hi' }] }
    const result = await runForgeLlm(body, { protocol: 'anthropic' })

    assert.equal(result, 'forge llm response')
    const args = JSON.parse(readFileSync(argsPath, 'utf-8')) as string[]
    assert.deepEqual(args, [
      'llm',
      '--protocol',
      'anthropic',
      '--stdin',
    ])
    const stdinContent = readFileSync(stdinPath, 'utf-8')
    assert.equal(stdinContent, serializeLlmInput(body))
  })

  it('sends a payload above 200 KiB over stdin instead of in argv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-forge-llm-large-'))
    tempDirs.push(dir)
    const script = join(dir, 'fake-forge.mjs')
    const argsPath = join(dir, 'args.json')
    const stdinPath = join(dir, 'stdin.txt')
    writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)))
let stdinData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { stdinData += chunk })
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(stdinPath)}, stdinData)
  process.stdout.write('forge llm response\\n')
})
`, 'utf-8')
    process.env.WRENYARD_RUNTIME_BIN = process.execPath
    process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])

    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'x'.repeat(210_000) }] }
    const payload = serializeLlmInput(body)
    assert(payload.length > 200_000, `payload length ${payload.length} must exceed 200 KiB`)

    const result = await runForgeLlm(body, { model: 'gpt-4', protocol: 'openai' })

    assert.equal(result, 'forge llm response')
    const args = JSON.parse(readFileSync(argsPath, 'utf-8')) as string[]
    // Args must NOT contain the body JSON — no payload in argv
    assert(!args.some((a) => a.length > 200_000), 'args must not contain the large JSON payload')
    assert.deepEqual(args.slice(-2), ['openai', '--stdin'])
    assert(args.includes('--stdin'), 'args must include --stdin')
    const stdinContent = readFileSync(stdinPath, 'utf-8')
    assert.equal(stdinContent, payload)
  })

  it('rejects when forge llm exits nonzero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-forge-llm-fail-'))
    tempDirs.push(dir)
    const script = join(dir, 'fake-forge.mjs')
    writeFileSync(script, `
import { writeFileSync } from 'node:fs'
process.stderr.write('boom')
process.exit(3)
`, 'utf-8')
    process.env.WRENYARD_RUNTIME_BIN = process.execPath
    process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])

    await assert.rejects(
      () => runForgeLlm('hello', {}),
      /forge llm failed with exit code 3/u,
    )
  })

  it('rejects cleanly when forge process exits immediately without reading stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-forge-llm-immediate-exit-'))
    tempDirs.push(dir)
    const script = join(dir, 'immediate-exit.mjs')
    writeFileSync(script, `
process.exit(1)
`, 'utf-8')
    process.env.WRENYARD_RUNTIME_BIN = process.execPath
    process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])

    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'x'.repeat(50_000) }] }
    await assert.rejects(
      () => runForgeLlm(body, { model: 'gpt-4', protocol: 'openai' }),
      /forge llm failed with exit code 1/u,
    )
  })

  it('rejects cleanly on unavailable forge executable', async () => {
    process.env.WRENYARD_RUNTIME_BIN = '/nonexistent/forge'

    await assert.rejects(
      () => runForgeLlm('hello', {}),
      /ENOENT|spawn.*enoent/i,
    )
  })
})
