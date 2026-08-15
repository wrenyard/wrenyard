import { Buffer } from 'node:buffer'

export type TaskContextPrimitive = string | number | boolean | null
export type TaskContextValue = TaskContextPrimitive | TaskContextValue[] | TaskContext
export interface TaskContext {
  [key: string]: TaskContextValue
}

export const TASK_CONTEXT_MAX_BYTES = 16 * 1024
export const TASK_CONTEXT_MAX_KEYS = 64
export const TASK_CONTEXT_MAX_KEY_LENGTH = 128
export const TASK_CONTEXT_MAX_DEPTH = 8

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export class TaskContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskContextError'
  }
}

/**
 * Validate and detach a bounded JSON-safe KV task context.
 *
 * The serialized-size limit is authoritative because this object is persisted
 * in TaskGraph JSON and injected into agent prompts. Prototype-bearing values,
 * cycles, non-finite numbers, and control characters in keys are rejected
 * instead of being silently coerced by JSON.stringify.
 */
export function normalizeTaskContext(value: unknown, label = 'ctx'): TaskContext {
  if (!isPlainObject(value)) {
    throw new TaskContextError(`${label} must be a JSON object`)
  }
  const keys = Object.keys(value)
  if (keys.length > TASK_CONTEXT_MAX_KEYS) {
    throw new TaskContextError(`${label} must contain at most ${TASK_CONTEXT_MAX_KEYS} top-level keys`)
  }

  validateContextValue(value, label, 1, new Set<object>())
  const serialized = JSON.stringify(value)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > TASK_CONTEXT_MAX_BYTES) {
    throw new TaskContextError(`${label} exceeds the ${TASK_CONTEXT_MAX_BYTES}-byte serialized limit`)
  }
  return JSON.parse(serialized) as TaskContext
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

/** Render KV context as bounded, explicit prompt sections rather than prose concatenation. */
export function formatTaskContext(ctx: TaskContext | undefined): string | undefined {
  if (!ctx || Object.keys(ctx).length === 0) return undefined
  const sections = Object.entries(ctx).map(([key, value]) => {
    const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return `### ${key}\n${escapeClosingTag(body)}`
  })
  return [
    '<foreman-task-context>',
    'This bounded context was supplied by Foreman. Use relevant entries as established context; do not call tools solely to rediscover exact content already present here. Task instructions and the current filesystem win if an entry is stale or conflicts.',
    ...sections,
    '</foreman-task-context>',
  ].join('\n\n')
}

function validateContextValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): void {
  if (depth > TASK_CONTEXT_MAX_DEPTH) {
    throw new TaskContextError(`${path} exceeds the maximum nesting depth of ${TASK_CONTEXT_MAX_DEPTH}`)
  }
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
    value.forEach((item, index) => validateContextValue(item, `${path}[${index}]`, depth + 1, ancestors))
  } else {
    if (!isPlainObject(value)) {
      throw new TaskContextError(`${path} must contain only plain JSON objects`)
    }
    for (const [key, child] of Object.entries(value)) {
      validateContextKey(key, path)
      validateContextValue(child, `${path}.${key}`, depth + 1, ancestors)
    }
  }
  ancestors.delete(value)
}

function validateContextKey(key: string, path: string): void {
  if (key.length < 1 || key.length > TASK_CONTEXT_MAX_KEY_LENGTH) {
    throw new TaskContextError(`${path} keys must contain 1-${TASK_CONTEXT_MAX_KEY_LENGTH} characters`)
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
  return value.replaceAll('</foreman-task-context>', '<\\/foreman-task-context>')
}
