export function parsePositiveIntegerFlag(value: string | boolean | undefined, flagName: string, defaultValue: number): number {
  if (value === undefined || value === false) return defaultValue
  if (typeof value !== 'string' || !/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error(`${flagName} must be a positive integer`)
  }
  return Number(value)
}

export function requireNoPositionals(positionals: string[], usage: string): void {
  if (positionals.length > 0) {
    throw new Error(`Unexpected positional argument: ${positionals[0]}\nUsage: ${usage}`)
  }
}

export function requireSinglePositional(positionals: string[], usage: string): string {
  if (positionals.length === 0) {
    throw new Error(`Usage: ${usage}`)
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected positional argument: ${positionals[1]}\nUsage: ${usage}`)
  }
  return positionals[0]
}
