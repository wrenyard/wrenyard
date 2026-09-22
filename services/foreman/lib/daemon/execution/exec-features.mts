import type { ExecutionFeature, McpServer } from '@wrenyard/exec'
import { createBrowserUseFeature } from '@wrenyard/browser-use'
import { createComputerUseFeature } from '@wrenyard/computer-use'

/**
 * Configured execution-feature registry for the raw prompt path.
 *
 * A feature is a named bundle of MCP servers plus optional prompt instructions
 * that an exec request activates by id (see `@wrenyard/exec`
 * `ExecutionFeature`). BOTH features are declared here as EXPLICIT environment
 * descriptors, each carrying a full JSON `McpServer` value:
 *
 *   - `WRENYARD_BROWSER_USE_MCP`   -> feature id `browser-use`
 *   - `WRENYARD_COMPUTER_USE_MCP`  -> feature id `computer-use`
 *
 * The JSON is the transport definition verbatim:
 *
 *   stdio: { "transport": "stdio", "command": "...", "args": [...], "env": {...}, "cwd": "..." }
 *   http:  { "transport": "http", "url": "...", "headers": {...} }
 *
 * A malformed descriptor is a startup configuration failure, not a silently
 * skipped feature: an operator who sets the variable expects the feature to be
 * selectable, so a bad value is rejected loudly. A descriptor whose transport
 * is missing its defining field is rejected the same way. Credentials are never
 * read from or written to these descriptors beyond the explicit JSON the
 * operator supplies locally; nothing here crosses the public IPC surface.
 */
export const BROWSER_USE_FEATURE_ID = 'browser-use'
export const COMPUTER_USE_FEATURE_ID = 'computer-use'

export const BROWSER_USE_MCP_ENV = 'WRENYARD_BROWSER_USE_MCP'
export const COMPUTER_USE_MCP_ENV = 'WRENYARD_COMPUTER_USE_MCP'

/** Names of the environment variables that configure the exec feature registry. */
export const EXEC_FEATURE_ENV_VARS: readonly string[] = [
  BROWSER_USE_MCP_ENV,
  COMPUTER_USE_MCP_ENV,
]

/**
 * Build the execution-feature registry from the two explicit environment
 * descriptors. Every configured descriptor becomes exactly one feature with the
 * same id; an unset variable simply omits that feature, so a deployment that
 * enables neither exposes no feature ids and every request with a `features`
 * entry fails loudly.
 */
export function createExecFeatureRegistry(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, ExecutionFeature> {
  const features = new Map<string, ExecutionFeature>()
  const browser = readFeature(env, BROWSER_USE_MCP_ENV, BROWSER_USE_FEATURE_ID)
  if (browser) features.set(browser.id, browser)
  const computer = readFeature(env, COMPUTER_USE_MCP_ENV, COMPUTER_USE_FEATURE_ID)
  if (computer) features.set(computer.id, computer)
  return features
}

function readFeature(
  env: NodeJS.ProcessEnv,
  variable: string,
  id: string,
): ExecutionFeature | undefined {
  const raw = env[variable]?.trim()
  if (!raw) return undefined
  const server = parseMcpServer(raw, variable)
  return id === BROWSER_USE_FEATURE_ID ? createBrowserUseFeature(server) : createComputerUseFeature(server)
}

/** Parse and validate one `McpServer` JSON descriptor. Throws on any defect. */
export function parseMcpServer(raw: string, variable: string): McpServer {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `${variable} must be a JSON MCP server descriptor: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${variable} must be a JSON object describing one MCP server`)
  }
  const record = value as Record<string, unknown>
  const transport = record.transport
  if (transport === 'stdio') {
    const command = record.command
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error(`${variable} stdio MCP server requires a non-empty 'command'`)
    }
    const args = optionalStringArray(record.args, `${variable} 'args'`)
    const env = optionalStringRecord(record.env, `${variable} 'env'`)
    const cwd = optionalString(record.cwd, `${variable} 'cwd'`)
    return {
      transport: 'stdio',
      command: command.trim(),
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    }
  }
  if (transport === 'http') {
    const url = record.url
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error(`${variable} http MCP server requires a non-empty 'url'`)
    }
    const headers = optionalStringRecord(record.headers, `${variable} 'headers'`)
    return {
      transport: 'http',
      url: url.trim(),
      ...(headers ? { headers } : {}),
    }
  }
  throw new Error(`${variable} MCP server transport must be 'stdio' or 'http'`)
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
  return value as string[]
}

function optionalStringRecord(value: unknown, label: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object of strings`)
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') throw new Error(`${label} must be an object of strings`)
    record[key] = entry
  }
  return record
}
