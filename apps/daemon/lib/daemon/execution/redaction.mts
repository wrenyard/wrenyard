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
    'cachereadinputtokens',
    'cachecreationinputtokens',
    // Structural provenance for normalized token usage. This is not a bearer
    // token or credential; preserving it is required for the versioned TPS
    // contract. Credential-shaped keys such as access_token remain redacted.
    'tokenscope',
    // Source timestamp (first_token_at_ms) in the TPS sample. This is a
    // numeric timestamp describing when the first token was produced, not a
    // credential. It must survive redaction; credential keys such as
    // access_token / auth_token remain redacted.
    'firsttokenatms',
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

/**
 * Conservatively recognized credential token prefixes. This is deliberately a
 * short allow-list of well-known shapes, not a general secret detector: an
 * arbitrary or unlabeled secret is not claimed to be discoverable.
 */
const DIAGNOSTIC_TOKEN_PREFIXES: readonly RegExp[] = [
  /\bsk-(?:live|test)-[A-Za-z0-9]{8,}\b/g,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
]

const DIAGNOSTIC_AUTHORIZATION = /\b(authorization|proxy-authorization)\b(\s*[:=]\s*)(?:bearer|basic)\s+[^\s"'`,;]+/gi
const DIAGNOSTIC_BEARER_BASIC = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi
const DIAGNOSTIC_KEY_VALUE = /("[A-Za-z0-9_.-]+"|'[A-Za-z0-9_.-]+'|[A-Za-z0-9_.-]+)(\s*[:=]\s*)("([^"\n]*)"|'([^'\n]*)'|[^\s,;{}]+)?/g

/**
 * Redact credentials from free-form diagnostic text (child stderr, error
 * messages, retained log tails). Unlike `redactJsonString`, which is a no-op
 * unless the whole string is a single JSON container, this scrubs:
 *   1. JSON / JSONL lines by sensitive key (reusing the existing sensitive-key
 *      rule, including its token-usage exclusions);
 *   2. plain `key=value` / `key: value` pairs, including quoted values;
 *   3. `Authorization: Bearer|Basic` headers (and bare `Bearer|Basic` tokens);
 *   4. conservatively recognized credential token prefixes.
 * Callers must run this before any truncation. It does not promise to detect
 * arbitrary or unlabeled secrets.
 */
export function redactDiagnosticText(text: string): string {
  if (!text) return text
  return text.split('\n').map(redactDiagnosticLine).join('\n')
}

function redactDiagnosticLine(line: string): string {
  let result = line
  const trimmed = line.trim()
  if (looksLikeJsonContainer(trimmed)) {
    const redacted = redactJsonString(trimmed)
    if (redacted !== trimmed) result = `${line.slice(0, line.indexOf(trimmed))}${redacted}`
  }

  result = result
    .replace(DIAGNOSTIC_AUTHORIZATION, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(DIAGNOSTIC_BEARER_BASIC, (_match, scheme: string) => `${scheme} ${REDACTED}`)

  result = redactDiagnosticKeyValues(result)

  for (const prefix of DIAGNOSTIC_TOKEN_PREFIXES) {
    result = result.replace(prefix, REDACTED)
  }
  return result
}

/**
 * Redact every sensitive `key=value` / `key: value` pair, quoted or not. A
 * non-sensitive key only advances past its own name and separator, so a
 * sensitive pair nested inside another value (`error: api_key=…`) is still
 * inspected instead of being swallowed by the outer match.
 */
function redactDiagnosticKeyValues(text: string): string {
  DIAGNOSTIC_KEY_VALUE.lastIndex = 0
  let result = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = DIAGNOSTIC_KEY_VALUE.exec(text)) !== null) {
    const key = match[1].replace(/["']/g, '')
    // A sensitive key with no value token (dangling `key=` / `key:`) is
    // advanced past exactly like a non-sensitive skip: substituting
    // [REDACTED] here would consume the bare label, so value bytes arriving in
    // a later chunk could no longer associate with it.
    if (!isSensitiveKey(key) || match[3] === undefined) {
      DIAGNOSTIC_KEY_VALUE.lastIndex = match.index + match[1].length + match[2].length
      continue
    }
    result += `${text.slice(last, match.index)}${match[1]}${match[2]}${REDACTED}`
    last = match.index + match[0].length
  }
  return result + text.slice(last)
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
