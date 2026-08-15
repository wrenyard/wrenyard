import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { spawnForge } from '../lib/adapters/forge/exec.mts'
import {
  buildForgeProvidersDescribeCommand,
  parseForgeProviders,
  providerSupportsProtocol,
  runForgeProvidersDescribe,
} from '../lib/adapters/forge/providers-client.mts'

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

// Forge's deployed `providers describe --json` contract: an array of
// descriptors `{ id: string, raw_llm: ("openai"|"anthropic")[] | null }`.
// `raw_llm: null` means the provider exposes no raw LLM capabilities.
const SAMPLE = [
  { id: 'acme', raw_llm: ['openai'] },
  { id: 'codex', raw_llm: ['openai', 'anthropic'] },
  { id: 'kimi', raw_llm: ['openai'] },
  { id: 'zhipu', raw_llm: ['anthropic'] },
  { id: 'unsupported', raw_llm: null },
]

describe('forge providers client', () => {
  it('builds the exact forge providers describe --json argv', () => {
    assert.deepEqual(buildForgeProvidersDescribeCommand(), ['providers', 'describe', '--json'])
  })

  it('parses provider capabilities and answers protocol lookups', () => {
    const providers = parseForgeProviders(JSON.stringify(SAMPLE))
    assert.deepEqual(providers, SAMPLE)
    assert.equal(providerSupportsProtocol(providers.find((p) => p.id === 'codex'), 'anthropic'), true)
    assert.equal(providerSupportsProtocol(providers.find((p) => p.id === 'codex'), 'openai'), true)
    assert.equal(providerSupportsProtocol(providers.find((p) => p.id === 'kimi'), 'anthropic'), false)
    assert.equal(providerSupportsProtocol(providers.find((p) => p.id === 'zhipu'), 'openai'), false)
    assert.equal(providerSupportsProtocol(providers.find((p) => p.id === 'unsupported'), 'openai'), false)
    assert.equal(providerSupportsProtocol(undefined, 'openai'), false)
  })

  it('runs forge providers describe through the Forge invocation adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-forge-providers-'))
    tempDirs.push(dir)
    const script = join(dir, 'fake-forge.mjs')
    const argsPath = join(dir, 'args.json')
    writeFileSync(script, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(${JSON.stringify(JSON.stringify(SAMPLE))})
`, 'utf-8')
    process.env.WRENYARD_RUNTIME_BIN = process.execPath
    process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])

    const providers = await runForgeProvidersDescribe()
    assert.deepEqual(providers, SAMPLE)
    const args = JSON.parse(readFileSync(argsPath, 'utf-8')) as string[]
    assert.deepEqual(args, ['providers', 'describe', '--json'])
  })

  it('rejects when forge providers describe exits nonzero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-forge-providers-fail-'))
    tempDirs.push(dir)
    const script = join(dir, 'fake-forge.mjs')
    writeFileSync(script, `
process.stderr.write('boom')
process.exit(2)
`, 'utf-8')
    process.env.WRENYARD_RUNTIME_BIN = process.execPath
    process.env.WRENYARD_FORGE_ARGS_PREFIX = JSON.stringify([script])

    await assert.rejects(
      () => runForgeProvidersDescribe(),
      /forge providers describe failed with exit code 2/u,
    )
  })

  it('rejects on non-JSON output', () => {
    assert.throws(() => parseForgeProviders('not json'), /non-JSON/u)
  })

  it('rejects on a malformed provider descriptor', () => {
    assert.throws(() => parseForgeProviders(JSON.stringify([42])), /malformed/u)
  })

  it('rejects when the output is not a provider array', () => {
    assert.throws(() => parseForgeProviders(JSON.stringify({ providers: [] })), /JSON array/u)
  })

  it('rejects a descriptor with a missing or invalid id', () => {
    assert.throws(
      () => parseForgeProviders(JSON.stringify([{ raw_llm: ['openai'] }])),
      /missing or invalid id/u,
    )
    assert.throws(
      () => parseForgeProviders(JSON.stringify([{ id: 5, raw_llm: ['openai'] }])),
      /missing or invalid id/u,
    )
  })

  it('rejects a descriptor missing the raw_llm capability list', () => {
    assert.throws(
      () => parseForgeProviders(JSON.stringify([{ id: 'x' }])),
      /missing the raw_llm capability list/u,
    )
  })

  it('rejects an unknown raw_llm protocol string', () => {
    assert.throws(
      () => parseForgeProviders(JSON.stringify([{ id: 'x', raw_llm: ['bogus'] }])),
      /unknown raw_llm protocol/u,
    )
  })

  it('integration: parses providers from the installed forge binary when present', async (t) => {
    if (!(await forgeInstalled())) {
      t.skip('forge binary not installed; set WRENYARD_RUNTIME_BIN to enable this test')
      return
    }

    const providers = await runForgeProvidersDescribe()
    assert.ok(Array.isArray(providers))
    for (const provider of providers) {
      assert.equal(typeof provider.id, 'string')
      assert.ok(
        provider.raw_llm === null ||
          (Array.isArray(provider.raw_llm) &&
            provider.raw_llm.every((p) => p === 'openai' || p === 'anthropic')),
        `provider ${provider.id} has an unexpected raw_llm shape`,
      )
    }
  })
})

async function forgeInstalled(): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnForge(['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      })
      child.once('error', reject)
      child.once('close', () => resolve())
    })
    return true
  } catch {
    return false
  }
}
