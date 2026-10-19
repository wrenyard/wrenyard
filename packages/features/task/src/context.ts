export type TaskContextPrimitive = string | number | boolean | null
export type TaskContextValue = TaskContextPrimitive | TaskContextValue[] | TaskContext
export interface TaskContext {
  [key: string]: TaskContextValue
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export class TaskContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskContextError'
  }
}

/**
 * Validate and detach a JSON-safe KV task context.
 *
 * Prototype-bearing values, cycles, non-finite numbers, and control characters in keys are rejected
 * instead of being silently coerced by JSON.stringify.
 */
export function normalizeTaskContext(value: unknown, label = 'ctx'): TaskContext {
  if (!isPlainObject(value)) {
    throw new TaskContextError(`${label} must be a JSON object`)
  }

  try {
    validateContextValue(value, label, new Set<object>())
    const serialized = JSON.stringify(value)
    return JSON.parse(serialized) as TaskContext
  } catch (error) {
    if (error instanceof TaskContextError) throw error
    throw new TaskContextError(`Cannot serialize task context: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Merge inherited/global context first, then let the nearer context override it. */
export function mergeTaskContexts(
  inherited: TaskContext | undefined,
  nearer: TaskContext | undefined,
): TaskContext | undefined {
  if (!inherited && !nearer) return undefined
  return normalizeTaskContext({ ...(inherited ?? {}), ...(nearer ?? {}) })
}

/**
 * Reserve an object input's `ctx` member for the task-run protocol. The member
 * is removed before task-definition validation, so task schemas remain focused
 * on their domain input. Embedded context overrides inherited graph/API values.
 */
export function splitTaskInputContext(
  input: unknown,
  inherited?: TaskContext,
): { input: unknown; ctx?: TaskContext } {
  if (!isPlainObject(input) || !Object.hasOwn(input, 'ctx')) {
    return { input, ...(inherited ? { ctx: normalizeTaskContext(inherited) } : {}) }
  }

  const embedded = normalizeTaskContext(input.ctx, 'input.ctx')
  const taskInput = { ...input }
  delete taskInput.ctx
  const ctx = mergeTaskContexts(inherited, embedded)
  return { input: taskInput, ...(ctx ? { ctx } : {}) }
}

/** Render KV context as explicit prompt sections rather than prose concatenation. */
export function formatTaskContext(ctx: TaskContext | undefined): string | undefined {
  if (!ctx || Object.keys(ctx).length === 0) return undefined
  const sections = Object.entries(ctx).map(([key, value]) => {
    const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return `### ${key}\n${escapeClosingTag(body)}`
  })
  return [
    '<wy-ctx-task>',
    'This context was supplied by Foreman. Use relevant entries as established context; do not call tools solely to rediscover exact content already present here. Task instructions and the current filesystem win if an entry is stale or conflicts.',
    ...sections,
    '</wy-ctx-task>',
  ].join('\n\n')
}

function validateContextValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TaskContextError(`${path} must contain only finite numbers`)
    return
  }
  if (typeof value !== 'object') {
    throw new TaskContextError(`${path} must contain only JSON-serializable values`)
  }
  if (ancestors.has(value)) throw new TaskContextError(`${path} must not contain cycles`)

  ancestors.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateContextValue(item, `${path}[${index}]`, ancestors))
  } else {
    if (!isPlainObject(value)) {
      throw new TaskContextError(`${path} must contain only plain JSON objects`)
    }
    for (const [key, child] of Object.entries(value)) {
      validateContextKey(key, path)
      validateContextValue(child, `${path}.${key}`, ancestors)
    }
  }
  ancestors.delete(value)
}

function validateContextKey(key: string, path: string): void {
  if (key.length < 1) {
    throw new TaskContextError(`${path} keys must not be empty`)
  }
  if (FORBIDDEN_KEYS.has(key) || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new TaskContextError(`${path} contains an unsafe key '${key}'`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function escapeClosingTag(value: string): string {
  return value.replaceAll('</wy-ctx-task>', '<\\/wy-ctx-task>')
}
