export function toJsonText(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch (error) {
    return JSON.stringify({ unserializable: errorMessage(error) })
  }
}

export function toOutputText(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value === 'string') return value
  return toJsonText(value)
}

export function compactJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined && field !== null) compact[key] = field
  }
  return compact
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
