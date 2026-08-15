export const SENSITIVE_KEYS: string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'private_key',
  'access_key',
]

const TOOL_RESULT_OUTPUT_TAIL_MAX_LEN = 500
const REDACTED = '[REDACTED]'
const TRUNCATION_MARKER = '…'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase()
  const normalizedKey = normalizeKey(key)
  if (isTokenUsageKey(normalizedKey)) return false
  return SENSITIVE_KEYS.some((sensitiveKey) =>
    lowerKey.includes(sensitiveKey) || normalizedKey.includes(normalizeKey(sensitiveKey))
  )
}

function isTokenUsageKey(normalizedKey: string): boolean {
  return [
    'inputtokens',
    'outputtokens',
    'totaltokens',
    'reasoningoutputtokens',
    'cachedinputtokens',
    // Structural provenance for normalized token usage. This is not a bearer
    // token or credential; preserving it is required for the versioned TPS
    // contract. Credential-shaped keys such as access_token remain redacted.
    'tokenscope',
  ].includes(normalizedKey)
}

function looksLikeJsonContainer(value: string): boolean {
  const trimmed = value.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

export function redactString(s: string, maxLen?: number): string {
  if (maxLen === undefined || !Number.isFinite(maxLen)) return s

  const limit = Math.max(0, Math.floor(maxLen))
  if (s.length <= limit) return s
  if (limit === 0) return ''
  if (limit <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, limit)
  }

  return `${s.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
}

export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item))
  }

  if (typeof value === 'string') {
    return redactJsonString(value)
  }

  if (!isRecord(value)) {
    return value
  }

  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : redactJson(item)
  }

  return redacted
}

export function redactValue(value: unknown): unknown {
  return redactJson(value)
}

export function redactJsonString(value: string): string {
  if (!looksLikeJsonContainer(value)) return value

  try {
    const parsed = JSON.parse(value) as unknown
    const original = JSON.stringify(parsed)
    const redacted = JSON.stringify(redactValue(parsed))
    if (redacted === undefined) return value
    return redacted === original ? value : redacted
  } catch {
    return value
  }
}

export function redactForLog(record: unknown): unknown {
  if (Array.isArray(record)) {
    return redactJson(record)
  }

  if (!isRecord(record)) {
    return record
  }

  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : redactJson(value)
  }

  return redacted
}

export function redactEvent(type: string, data: unknown): unknown {
  const redacted = redactJson(data)

  if (type !== 'tool_result' || !isRecord(redacted)) {
    return redacted
  }

  const outputTail = redacted.output_tail
  if (typeof outputTail !== 'string') {
    return redacted
  }

  return {
    ...redacted,
    output_tail: redactString(outputTail, TOOL_RESULT_OUTPUT_TAIL_MAX_LEN),
  }
}
