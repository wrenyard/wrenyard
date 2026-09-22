import { isDeepStrictEqual } from 'node:util'

import type {
  JsonObject,
  JsonValue,
  NodeId,
  TaskGraph,
} from './model.mts'

export const CONDITION_COMPARISON_OPS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'in',
] as const

export const CONDITION_PRESENCE_OPS = ['exists', 'missing'] as const

export type ConditionComparisonOp = (typeof CONDITION_COMPARISON_OPS)[number]
export type ConditionPresenceOp = (typeof CONDITION_PRESENCE_OPS)[number]

export type ConditionPredicate =
  | { path: string; op: ConditionComparisonOp; value: JsonValue }
  | { path: string; op: ConditionPresenceOp }
  | { all: ConditionPredicate[] }
  | { any: ConditionPredicate[] }
  | { not: ConditionPredicate }

export interface ConditionCase {
  when: ConditionPredicate
  branch: NodeId
}

export interface ConditionParams {
  cases: ConditionCase[]
  default: NodeId
}

export interface ConditionParamsIssue {
  path: string
  message: string
}

export interface ConditionEvaluation {
  branch: NodeId
  caseIndex: number | null
}

interface PathResult {
  found: boolean
  value?: JsonValue
}

type PathSegment =
  | { kind: 'field'; value: string }
  | { kind: 'index'; value: number }

export function validateConditionParams(
  graph: Pick<TaskGraph, 'nodes'>,
  conditionNodeId: NodeId,
  value: JsonObject,
): ConditionParamsIssue[] {
  const issues: ConditionParamsIssue[] = []
  const keys = Object.keys(value)
  for (const key of keys) {
    if (key !== 'cases' && key !== 'default') {
      issues.push({ path: key, message: `unknown condition params key "${key}"` })
    }
  }

  const cases = value.cases
  if (!Array.isArray(cases)) {
    issues.push({ path: 'cases', message: 'condition params.cases must be an array' })
  } else {
    for (let index = 0; index < cases.length; index += 1) {
      const entry = cases[index]
      const path = `cases[${index}]`
      if (!isRecord(entry)) {
        issues.push({ path, message: 'condition case must be an object' })
        continue
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'when' && key !== 'branch') {
          issues.push({ path: `${path}.${key}`, message: `unknown condition case key "${key}"` })
        }
      }
      issues.push(...validatePredicate(entry.when, `${path}.when`))
      if (typeof entry.branch !== 'string' || entry.branch.length === 0) {
        issues.push({ path: `${path}.branch`, message: 'condition branch must be a nonempty node id' })
      } else {
        validateBranchTarget(graph, conditionNodeId, entry.branch, `${path}.branch`, issues)
      }
    }
  }

  if (typeof value.default !== 'string' || value.default.length === 0) {
    issues.push({ path: 'default', message: 'condition params.default must be a nonempty node id' })
  } else {
    validateBranchTarget(graph, conditionNodeId, value.default, 'default', issues)
  }

  return issues
}

export function evaluateCondition(params: ConditionParams, input: JsonObject): ConditionEvaluation {
  for (let index = 0; index < params.cases.length; index += 1) {
    if (evaluatePredicate(params.cases[index].when, input)) {
      return { branch: params.cases[index].branch, caseIndex: index }
    }
  }
  return { branch: params.default, caseIndex: null }
}

export function parseConditionParams(value: JsonObject): ConditionParams {
  return value as unknown as ConditionParams
}

export function evaluatePredicate(predicate: ConditionPredicate, input: JsonObject): boolean {
  if ('all' in predicate) return predicate.all.every((entry) => evaluatePredicate(entry, input))
  if ('any' in predicate) return predicate.any.some((entry) => evaluatePredicate(entry, input))
  if ('not' in predicate) return !evaluatePredicate(predicate.not, input)

  const actual = readReferencePath(input, predicate.path)
  if (predicate.op === 'exists') return actual.found
  if (predicate.op === 'missing') return !actual.found
  if (!actual.found) return false
  if (!('value' in predicate)) return false

  const expected = predicate.value
  switch (predicate.op) {
    case 'eq':
      return isDeepStrictEqual(actual.value, expected)
    case 'neq':
      return !isDeepStrictEqual(actual.value, expected)
    case 'lt':
      return typeof actual.value === 'number' && typeof expected === 'number' && actual.value < expected
    case 'lte':
      return typeof actual.value === 'number' && typeof expected === 'number' && actual.value <= expected
    case 'gt':
      return typeof actual.value === 'number' && typeof expected === 'number' && actual.value > expected
    case 'gte':
      return typeof actual.value === 'number' && typeof expected === 'number' && actual.value >= expected
    case 'contains':
      if (typeof actual.value === 'string' && typeof expected === 'string') {
        return actual.value.includes(expected)
      }
      return Array.isArray(actual.value)
        && actual.value.some((entry) => isDeepStrictEqual(entry, expected))
    case 'in':
      return Array.isArray(expected)
        && expected.some((entry) => isDeepStrictEqual(entry, actual.value))
  }
}

export function readReferencePath(input: JsonObject, path: string): PathResult {
  const segments = parseReferencePath(path)
  if (!segments) return { found: false }

  let current: JsonValue = input
  for (const segment of segments) {
    if (segment.kind === 'field') {
      if (!isRecord(current) || !Object.hasOwn(current, segment.value)) return { found: false }
      current = current[segment.value] as JsonValue
    } else {
      if (!Array.isArray(current) || segment.value >= current.length) return { found: false }
      current = current[segment.value]
    }
  }
  return { found: true, value: current }
}

function validatePredicate(value: unknown, path: string): ConditionParamsIssue[] {
  if (!isRecord(value)) return [{ path, message: 'predicate must be an object' }]

  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === 'all') {
    return validatePredicateArray(value.all, `${path}.all`)
  }
  if (keys.length === 1 && keys[0] === 'any') {
    return validatePredicateArray(value.any, `${path}.any`)
  }
  if (keys.length === 1 && keys[0] === 'not') {
    return validatePredicate(value.not, `${path}.not`)
  }

  const issues: ConditionParamsIssue[] = []
  if (typeof value.path !== 'string' || parseReferencePath(value.path) === null) {
    issues.push({
      path: `${path}.path`,
      message: 'predicate path must use restricted "$.field[index]" syntax',
    })
  }

  if (typeof value.op !== 'string') {
    issues.push({ path: `${path}.op`, message: 'predicate op is required' })
    return issues
  }

  const comparison = (CONDITION_COMPARISON_OPS as readonly string[]).includes(value.op)
  const presence = (CONDITION_PRESENCE_OPS as readonly string[]).includes(value.op)
  if (!comparison && !presence) {
    issues.push({ path: `${path}.op`, message: `unknown predicate op "${value.op}"` })
    return issues
  }

  const allowed = presence ? new Set(['path', 'op']) : new Set(['path', 'op', 'value'])
  for (const key of keys) {
    if (!allowed.has(key)) {
      issues.push({ path: `${path}.${key}`, message: `unknown predicate key "${key}"` })
    }
  }
  if (comparison && !Object.hasOwn(value, 'value')) {
    issues.push({ path: `${path}.value`, message: `predicate op "${value.op}" requires value` })
  }
  if (presence && Object.hasOwn(value, 'value')) {
    issues.push({ path: `${path}.value`, message: `predicate op "${value.op}" does not accept value` })
  }
  return issues
}

function validatePredicateArray(value: unknown, path: string): ConditionParamsIssue[] {
  if (!Array.isArray(value)) return [{ path, message: 'predicate group must be an array' }]
  return value.flatMap((entry, index) => validatePredicate(entry, `${path}[${index}]`))
}

function validateBranchTarget(
  graph: Pick<TaskGraph, 'nodes'>,
  conditionNodeId: NodeId,
  branch: NodeId,
  path: string,
  issues: ConditionParamsIssue[],
): void {
  const target = Object.hasOwn(graph.nodes, branch) ? graph.nodes[branch] : undefined
  if (!target) {
    issues.push({ path, message: `condition branch "${branch}" does not exist` })
    return
  }
  if (!target.deps.includes(conditionNodeId)) {
    issues.push({
      path,
      message: `condition branch "${branch}" must declare "${conditionNodeId}" as a dependency`,
    })
  }
}

function parseReferencePath(path: string): PathSegment[] | null {
  if (path === '$') return []
  if (!path.startsWith('$')) return null

  const segments: PathSegment[] = []
  let offset = 1
  while (offset < path.length) {
    const suffix = path.slice(offset)
    const field = /^\.([A-Za-z_][A-Za-z0-9_]*)/u.exec(suffix)
    if (field) {
      segments.push({ kind: 'field', value: field[1] })
      offset += field[0].length
      continue
    }
    const index = /^\[(0|[1-9][0-9]*)\]/u.exec(suffix)
    if (index) {
      segments.push({ kind: 'index', value: Number(index[1]) })
      offset += index[0].length
      continue
    }
    return null
  }
  return segments
}

function isRecord(value: unknown): value is Record<string, JsonValue | undefined> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
