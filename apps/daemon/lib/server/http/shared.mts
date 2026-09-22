import type { IncomingMessage, ServerResponse } from 'node:http'

export type JsonRecord = Record<string, unknown>

export function sendJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.statusCode = statusCode
  res.end(JSON.stringify(value))
}

export function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.statusCode = 405
  res.setHeader('Allow', allow)
  res.end(JSON.stringify({ error: 'method not allowed' }))
}

export async function readJsonBody(req: IncomingMessage): Promise<JsonRecord | string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) return 'request body is too large'
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (!text) return 'request body is required'
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonRecord
    return 'request body must be a JSON object'
  } catch {
    return 'request body must be valid JSON'
  }
}

export function requiredBodyString(body: JsonRecord, key: string): string | { error: string } {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) return { error: `${key} is required` }
  return value.trim()
}

export function parseJsonValue(value: string | null): unknown | undefined {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export function compactRecord(value: JsonRecord): JsonRecord {
  const next: JsonRecord = {}
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined && field !== null) next[key] = field
  }
  return next
}

export function parseNonNegativeInteger(raw: string | null, name: string, fallback: number): number | string {
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return `${name} must be a non-negative integer`
  return value
}

export function isDbUnavailable(error: unknown): boolean {
  return errorMessage(error).includes('Foreman DB has not been initialized')
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
