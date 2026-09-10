import type { JsonSchema } from './jsonrpc.mts'
import type {
  TaskAutoRoutingDecision,
  TaskResolvedDispatch,
  TaskUsage,
} from '../task-run-metadata-types.mts'
export type {
  TaskAutoRoutingDecision,
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

/**
 * Strict shared wire schema for the privacy-safe automatic-routing decision
 * that may accompany a resolved automatic dispatch. Mirrors the exact
 * `TaskAutoRoutingDecision` DTO key set and field types so a persisted decision
 * stays valid across the stats/delivery wire paths while explicit and legacy
 * resolved dispatches (which never carry one) stay valid without it.
 */
export const taskAutoRoutingDecisionSchema = {
  type: 'object',
  required: [
    'snapshot_id',
    'selected_rank',
    'supply_class',
    'quota_tier',
    'quota_coverage_complete',
    'quota_headroom_trusted',
    'reference_output_usd_per_million',
    'routing_output_usd_per_million',
    'effective_cap_usd_per_million',
    'score',
    'reasons',
  ],
  properties: {
    snapshot_id: { type: 'string' },
    selected_rank: { type: 'number' },
    supply_class: { enum: ['confirmed_free', 'standard'] },
    quota_tier: { enum: ['healthy', 'unknown', 'strained'] },
    quota_coverage_complete: { type: 'boolean' },
    quota_headroom_trusted: { type: 'boolean' },
    reference_output_usd_per_million: { type: 'number' },
    routing_output_usd_per_million: { type: 'number' },
    effective_cap_usd_per_million: { type: 'number' },
    score: { type: 'number' },
    scoring: {
      type: 'object',
      required: ['version', 'price', 'speed', 'quota', 'intelligence'],
      properties: {
        version: { const: 'normalized-v1' },
        price: { type: 'number', minimum: 0, maximum: 1 },
        speed: { type: 'number', minimum: 0, maximum: 1 },
        quota: { type: 'number', minimum: 0, maximum: 1 },
        intelligence: { type: 'number', minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
    reasons: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  additionalProperties: false,
} as const satisfies JsonSchema

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
    auto_routing: taskAutoRoutingDecisionSchema,
    speed: {
      type: 'object',
      required: ['effective_tps', 'source', 'sample_count', 'checked_at', 'expected_tps_met'],
      properties: {
        effective_tps: { type: 'number' },
        source: { enum: ['local_31d', 'provider_override', 'catalog_default'] },
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
