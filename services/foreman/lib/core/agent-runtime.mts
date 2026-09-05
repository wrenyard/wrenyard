const FORGE_POLICY_IDS = new Set(['fast', 'general', 'ultra'])
const SUPPORTED_RUNTIMES = new Set(['forge'])

export interface AgentRuntime {
  readonly runtime: string
  readonly configId: string
  readonly isPolicy: boolean
  toString(): string
}

interface ParsedAgentRuntime {
  runtime: string
  configId: string
}

export function parseAgentRuntime(raw: string): AgentRuntime {
  const parsed = parseAgentRuntimeRaw(raw)
  return freezeAgentRuntime(parsed.runtime, parsed.configId)
}

export function parseAgentRuntimeRaw(raw: string): ParsedAgentRuntime {
  if (!raw.trim()) {
    throw new AgentRuntimeParseError('agentRuntime must not be empty')
  }
  const trimmed = raw.trim()
  const slashIndex = trimmed.indexOf('/')
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    throw new AgentRuntimeParseError(
      `agentRuntime must be in the format '<runtime>/<config-id>', received: ${JSON.stringify(raw)}`,
    )
  }
  const runtime = trimmed.slice(0, slashIndex)
  const configId = trimmed.slice(slashIndex + 1)
  if (!runtime || !configId) {
    throw new AgentRuntimeParseError(
      `agentRuntime '<runtime>' and '<config-id>' must both be non-empty, received: ${JSON.stringify(raw)}`,
    )
  }
  if (!SUPPORTED_RUNTIMES.has(runtime)) {
    throw new AgentRuntimeParseError(
      `Unsupported runtime '${runtime}'. Supported runtimes: ${[...SUPPORTED_RUNTIMES].join(', ')}`,
    )
  }
  if (configId.includes('/')) {
    throw new AgentRuntimeParseError(
      `agentRuntime config-id must not contain '/', received: ${JSON.stringify(raw)}`,
    )
  }
  return { runtime, configId }
}

export function freezeAgentRuntime(runtime: string, configId: string): AgentRuntime {
  if (!SUPPORTED_RUNTIMES.has(runtime)) {
    throw new AgentRuntimeParseError(
      `Unsupported runtime '${runtime}'. Supported runtimes: ${[...SUPPORTED_RUNTIMES].join(', ')}`,
    )
  }
  if (configId.includes('/')) {
    throw new AgentRuntimeParseError(
      `agentRuntime config-id must not contain '/', received: ${JSON.stringify(runtime)}/${JSON.stringify(configId)}`,
    )
  }
  const isPolicy = runtime === 'forge' && FORGE_POLICY_IDS.has(configId)
  const obj: Record<string, unknown> = {
    runtime,
    configId,
    isPolicy,
  }
  Object.defineProperty(obj, 'toString', {
    value: () => `${runtime}/${configId}`,
    enumerable: false,
  })
  return Object.freeze(obj) as unknown as AgentRuntime
}

export function synthesizeAgentRuntime(profile: string): AgentRuntime {
  if (!profile.trim()) {
    throw new AgentRuntimeParseError('profile must not be empty to synthesize agentRuntime')
  }
  return freezeAgentRuntime('forge', profile.trim())
}

/**
 * Resolve the Forge policy tier of an `agentRuntime` string, or `null` when it
 * names an exact (non-policy) profile. The daemon resolver uses this to tell a
 * soft policy *preference* (fast/general/ultra) apart from an exact profile
 * identity that can be matched against a concrete dispatch plan. This is a
 * read-only classification helper only — it adds no implicit policy routing.
 */
export function preferredRuntimeTier(raw: string): 'fast' | 'general' | 'ultra' | null {
  try {
    const parsed = parseAgentRuntime(raw)
    if (parsed.isPolicy && FORGE_POLICY_IDS.has(parsed.configId)) {
      return parsed.configId as 'fast' | 'general' | 'ultra'
    }
    return null
  } catch {
    return null
  }
}

/**
 * True when `raw` parses to an exact (non-policy) profile identity rather than a
 * Forge policy preference. Lets the resolver know whether a preference can be
 * matched directly to a plan profile.
 */
export function isExactProfilePreference(raw: string): boolean {
  try {
    return !parseAgentRuntime(raw).isPolicy
  } catch {
    return false
  }
}

export class AgentRuntimeParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentRuntimeParseError'
  }
}
