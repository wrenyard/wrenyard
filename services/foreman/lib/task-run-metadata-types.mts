/**
 * Shared task run dispatch and usage shapes.
 *
 * This dependency-free module sits below both core execution and protocol
 * schemas so neither layer needs to import the other.
 */

export type TaskUsageCompleteness = 'complete' | 'partial' | 'unavailable'

export interface TaskResolvedSpeed {
  effective_tps: number
  source: 'local_31d' | 'catalog_default'
  sample_count: number
  checked_at: string
  expected_tps_met: boolean
  degradation_reason?: string
}

export interface TaskReferencePricing {
  input_usd_per_million?: number
  output_usd_per_million?: number
  cached_input_usd_per_million?: number
  cache_write_input_usd_per_million?: number
  source: string
  checked_at: string
}

export interface TaskResolvedDispatch {
  requested_agent_runtime: string
  profile: string
  client: string
  provider: string
  model: string
  model_id: string
  mode: 'native' | 'gateway'
  speed: TaskResolvedSpeed
  intelligence: string
  reference_pricing: TaskReferencePricing
  protocol?: string
}

export interface TaskUsage {
  completeness: TaskUsageCompleteness
  attempt_count: number
  usage_event_count: number
  input_tokens?: number
  cached_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  agent_turn_ms?: number
  output_tps?: number
  tps_contract?: 'agent_turn_v1'
  reference_cost_usd?: number
  reference_cost_complete: boolean
  reference_cost_basis?: 'catalog_reference'
}
