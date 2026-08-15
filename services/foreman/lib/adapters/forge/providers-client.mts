import type { SpawnOptions } from 'node:child_process'
import { spawnForge } from './exec.mts'

export type ForgeProviderProtocol = 'openai' | 'anthropic'

export interface ForgeProvider {
  id: string
  raw_llm: ForgeProviderProtocol[] | null
}

export type ForgeProvidersMap = Map<string, ForgeProvider>

export interface ForgeProvidersRunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export function buildForgeProvidersDescribeCommand(): string[] {
  return ['providers', 'describe', '--json']
}

export async function runForgeProvidersDescribe(opts: ForgeProvidersRunOptions = {}): Promise<ForgeProvider[]> {
  const child = spawnForge(buildForgeProvidersDescribeCommand(), {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const [stdout, stderr, exit] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    waitForExit(child),
  ])

  if (exit.code !== 0) {
    const detail = stderr.trim() || stdout.trim() || (exit.signal ? `signal ${exit.signal}` : 'no output')
    throw new Error(`forge providers describe failed with exit code ${exit.code ?? 'null'}: ${tail(detail)}`)
  }

  return parseForgeProviders(stdout)
}

/**
 * Parse the stable Forge `providers describe --json` response into a typed
 * list of provider raw LLM capabilities. The deployed contract is a JSON
 * array of descriptors `{ id: string, raw_llm: ("openai"|"anthropic")[] | null }`.
 * A `null` raw_llm is treated as an empty capability list. Fails clearly on
 * non-JSON, non-array, missing/invalid fields, or unknown protocol strings
 * rather than silently coercing.
 */
export function parseForgeProviders(raw: string): ForgeProvider[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`forge providers describe returned non-JSON output: ${errorMessage(error)}`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error('forge providers describe output must be a JSON array of provider descriptors')
  }

  const providers: ForgeProvider[] = []
  for (const entry of parsed) {
    providers.push(parseForgeProviderEntry(entry))
  }
  return providers
}

function parseForgeProviderEntry(value: unknown): ForgeProvider {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('forge providers describe output contains a malformed provider descriptor')
  }

  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new Error('forge providers describe output contains a provider descriptor with a missing or invalid id')
  }

  if (!('raw_llm' in entry)) {
    throw new Error(`forge providers describe output for provider ${entry.id} is missing the raw_llm capability list`)
  }

  if (entry.raw_llm === null) {
    return { id: entry.id, raw_llm: null }
  }

  if (!Array.isArray(entry.raw_llm)) {
    throw new Error(`forge providers describe output for provider ${entry.id} has a non-array raw_llm value`)
  }

  const protocols: ForgeProviderProtocol[] = []
  for (const item of entry.raw_llm) {
    if (item !== 'openai' && item !== 'anthropic') {
      throw new Error(
        `forge providers describe output for provider ${entry.id} declares an unknown raw_llm protocol: ${String(item)}`,
      )
    }
    protocols.push(item)
  }

  return { id: entry.id, raw_llm: protocols }
}

export function indexProviders(providers: ForgeProvider[]): ForgeProvidersMap {
  const map = new Map<string, ForgeProvider>()
  for (const provider of providers) map.set(provider.id, provider)
  return map
}

export function providerSupportsProtocol(provider: ForgeProvider | undefined, protocol: ForgeProviderProtocol): boolean {
  if (!provider) return false
  if (provider.raw_llm === null) return false
  return provider.raw_llm.includes(protocol)
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return ''
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function waitForExit(child: ReturnType<typeof spawnForge>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

function tail(value: string): string {
  return value.length > 2000 ? value.slice(-2000) : value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
