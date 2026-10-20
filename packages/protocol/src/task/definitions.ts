import type { JsonRecord } from '../common/jsonrpc.ts'
import type { ReasoningEffort } from './run-metadata.ts'

export interface TaskDispatchRequirements {
  expectedTps?: number
  minimumTps?: number
  intelligenceMin?: 'low' | 'mid' | 'high' | 'premium'
  intelligenceExpected?: 'low' | 'mid' | 'high' | 'premium'
  maxOutputUsdPerMillion?: number
  requiredCapabilities?: readonly ('text' | 'image')[]
  excludeModelIds?: readonly string[]
  excludeProfileIds?: readonly string[]
  excludeClientIds?: readonly string[]
  excludeProviderIds?: readonly string[]
  /** Hidden dispatch requirement: the dispatched plan must admit native web
   *  search. Enforced as a hard gate; never surfaced in any search settings UI. */
  requiresWebSearch?: boolean
  /** Requests the provider's verified Fast mode for the dispatched runtime.
   *  Independent from reasoning effort; explicit false means Fast is off. */
  fast?: boolean
  /** The expected reasoning-effort level for the dispatched runtime. It is a
   *  resolved runtime parameter adapted to the nearest usable level; the catalog
   *  omits it only for enumeration. Every task declares one. */
  expectedReasoningEffort?: ReasoningEffort
}

/** One provenance layer of a resolved inherited definition. Ordered
 *  base→effective and always includes the effective definition. A builtin layer
 *  carries `path: '(builtin)'` and no project. */
export interface TaskInheritanceChainEntry {
  source: 'builtin' | 'project'
  project?: string
  path: string
}

export interface TaskDefinitionSummary {
  name: string
  /** Authoritative human-readable task label parsed from the definition;
   *  consumers fall back to the exact task `name`. */
  displayName?: string
  source: string
  project?: string
  description?: string
  category?: {
    id: string
    displayLabel: string
  }
  timeoutMs?: number
  effectiveTimeoutMs?: number
  structuredRetryTimeoutMs?: number
  timeoutScope?: 'task_execution'
  scheduling?: 'active' | 'legacy'
  dispatch?: TaskDispatchRequirements
  /** Base→effective inheritance chain; present only when this effective
   *  definition was resolved from an inherited declaration
   *  (`defineTask({ extends, ... })`). */
  inheritanceChain?: TaskInheritanceChainEntry[]
}

export interface TaskDefinitionDetail extends TaskDefinitionSummary {
  path: string
  profile?: string
  input_schema?: unknown
  output_schema?: unknown
  structured?: boolean
  input_example?: JsonRecord
  gates?: {
    pre?: Array<{ id: string; description?: string }>
    post?: Array<{ id: string; description?: string }>
  }
}

export interface TaskDefinitionListParams {
  project?: string
}

export type TaskDefinitionListResult = TaskDefinitionSummary[]

export interface TaskDefinitionDescribeParams {
  task_id: string
  project?: string
}

export type TaskDefinitionDescribeResult = TaskDefinitionDetail
