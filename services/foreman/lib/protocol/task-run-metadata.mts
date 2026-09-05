import type { JsonSchema } from './jsonrpc.mts'
import type {
  TaskResolvedDispatch,
  TaskUsage,
} from '../task-run-metadata-types.mts'
export type {
  TaskReferencePricing,
  TaskResolvedDispatch,
  TaskResolvedSpeed,
  TaskUsage,
  TaskUsageCompleteness,
} from '../task-run-metadata-types.mts'

/**
 * Exclusive shared protocol schema for a task run's resolved dispatch and
 * reference usage. Delivery (status / output / wait) and Desktop (stats) both
 * consume these exact types so the projected dispatch/usage never diverges
 * between producers and consumers. All numeric fields are optional in the
 * wire type: unknown numerics must be omitted, never zero-filled.
 */

export const taskResolvedDispatchSchema = {
  type: 'object',
  required: [
    'requested_agent_runtime',
    'profile',
    'client',
    'provider',
    'model',
    'model_id',
    'mode',
    'speed',
    'intelligence',
    'reference_pricing',
  ],
  properties: {
    requested_agent_runtime: { type: 'string' },
    profile: { type: 'string' },
    client: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    model_id: { type: 'string' },
    mode: { enum: ['native', 'gateway'] },
    protocol: { type: 'string' },
    speed: {
      type: 'object',
      required: ['effective_tps', 'source', 'sample_count', 'checked_at', 'expected_tps_met'],
      properties: {
        effective_tps: { type: 'number' },
        source: { enum: ['local_31d', 'catalog_default'] },
        sample_count: { type: 'integer', minimum: 0 },
        checked_at: { type: 'string' },
        expected_tps_met: { type: 'boolean' },
        degradation_reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    intelligence: { type: 'string' },
    reference_pricing: {
      type: 'object',
      required: ['source', 'checked_at'],
      properties: {
        input_usd_per_million: { type: 'number' },
        output_usd_per_million: { type: 'number' },
        cached_input_usd_per_million: { type: 'number' },
        cache_write_input_usd_per_million: { type: 'number' },
        source: { type: 'string' },
        checked_at: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

export const taskUsageSchema = {
  type: 'object',
  required: ['completeness', 'attempt_count', 'usage_event_count', 'reference_cost_complete'],
  properties: {
    completeness: { enum: ['complete', 'partial', 'unavailable'] },
    attempt_count: { type: 'integer', minimum: 0 },
    usage_event_count: { type: 'integer', minimum: 0 },
    input_tokens: { type: 'number', minimum: 0 },
    cached_input_tokens: { type: 'number', minimum: 0 },
    cache_read_input_tokens: { type: 'number', minimum: 0 },
    cache_creation_input_tokens: { type: 'number', minimum: 0 },
    output_tokens: { type: 'number', minimum: 0 },
    total_tokens: { type: 'number', minimum: 0 },
    agent_turn_ms: { type: 'number', minimum: 0 },
    output_tps: { type: 'number', minimum: 0 },
    tps_contract: { const: 'agent_turn_v1' },
    reference_cost_usd: { type: 'number' },
    reference_cost_complete: { type: 'boolean' },
    reference_cost_basis: { const: 'catalog_reference' },
  },
  additionalProperties: false,
} as const satisfies JsonSchema
