import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  createBuiltinCatalog,
  createBuiltinProviderRuntime,
  type LocalSpeedSample,
  type ProviderRuntime,
  type TaskDispatchRequirements,
} from '@wrenyard/providers'
import {
  createTaskDispatchResolver,
  type TaskDispatchResolver,
} from '../../../lib/core/task/dispatch-resolver.mts'

// Real catalog stamped checked_at (from the builtin provider fixture).
const CATALOG_CHECKED_AT = '2026-09-05'
// Real, injected local sample timestamp — must appear verbatim in the snapshot,
// never a fabricated `new Date()` value.
const LOCAL_CHECKED_AT = '2026-09-01T08:30:00.000Z'

function localSamples(): LocalSpeedSample[] {
  return [
    { profileId: 'cb-dsf', tps: 82.42, sampleCount: 12, checkedAt: LOCAL_CHECKED_AT },
    { profileId: 'cb-hy', tps: 73.89, sampleCount: 9, checkedAt: LOCAL_CHECKED_AT },
    { profileId: 'cb-ds', tps: 65.32, sampleCount: 7, checkedAt: LOCAL_CHECKED_AT },
  ]
}

describe('core task dispatch-resolver (no-model)', () => {
  let resolver: TaskDispatchResolver

  beforeEach(async () => {
    resolver = await createTaskDispatchResolver({
      catalog: createBuiltinCatalog(),
      runtime: createBuiltinProviderRuntime(),
      localSpeed: localSamples,
    })
  })

  it('fast 80/60 dynamically chooses cheaper Luna 107 over eligible local cb-dsf 82.42', () => {
    const resolution = resolver.resolve({
      taskName: 'fast-80-60',
      declaredRuntime: 'forge/fast',
      requirements: { expectedTps: 80, minimumTps: 60 } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, true)
    const resolved = resolution.resolved
    // Bare profile id, not a forge/ prefix.
    assert.equal(resolved.profile, 'codex-luna')
    assert.equal(resolved.requested_agent_runtime, 'forge/fast')
    assert.equal(resolved.client, 'codex')
    assert.equal(resolved.provider, 'codex')
    assert.equal(resolved.model, 'gpt-5.6-luna')
    assert.equal(resolved.model_id, 'codex/gpt-5.6-luna')
    assert.equal(resolved.mode, 'native')
    assert.equal(resolved.intelligence, 'mid')
    // Luna has no local sample, so the sourced catalog default is used.
    assert.equal(resolved.speed.source, 'catalog_default')
    assert.equal(resolved.speed.effective_tps, 107)
    assert.equal(resolved.speed.sample_count, 0)
    assert.equal(resolved.speed.checked_at, CATALOG_CHECKED_AT)
    assert.equal(resolved.speed.expected_tps_met, true)
    // Per-million reference pricing from the catalog, with a real source stamp.
    assert.equal(resolved.reference_pricing.input_usd_per_million, 0.2)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 1.2)
    assert.equal(resolved.reference_pricing.cached_input_usd_per_million, 0.02)
    assert.equal(resolved.reference_pricing.source, 'https://developers.openai.com')
    assert.equal(resolved.reference_pricing.checked_at, CATALOG_CHECKED_AT)
  })

  it('exact codex-sol pin with a $6 output cap fails (NO_ELIGIBLE_PROFILE)', () => {
    const resolution = resolver.resolve({
      taskName: 'codex-sol-cap',
      declaredRuntime: 'forge/codex-sol',
      requirements: { maxOutputUsdPerMillion: 6 } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, false)
    assert.equal(resolution.error.code, 'NO_ELIGIBLE_PROFILE')
  })

  it('exact gk-kimi pin with image/frontier/$15/min8 succeeds from catalog K3 metadata', () => {
    const resolution = resolver.resolve({
      taskName: 'gk-kimi-image',
      declaredRuntime: 'forge/gk-kimi',
      requirements: {
        requiredCapabilities: ['image'] as const,
        intelligenceMin: 'frontier',
        intelligenceMax: 'frontier',
        maxOutputUsdPerMillion: 15,
        minimumTps: 8,
      } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, true)
    const resolved = resolution.resolved
    assert.equal(resolved.profile, 'gk-kimi')
    assert.equal(resolved.requested_agent_runtime, 'forge/gk-kimi')
    assert.equal(resolved.client, 'grok')
    assert.equal(resolved.provider, 'kimi-coding')
    assert.equal(resolved.model, 'k3')
    assert.equal(resolved.model_id, 'kimi-coding/k3')
    assert.equal(resolved.mode, 'gateway')
    assert.equal(resolved.protocol, 'openai_chat')
    assert.equal(resolved.intelligence, 'frontier')
    // No local sample for gk-kimi: speed is the real catalog K3 metadata.
    assert.equal(resolved.speed.source, 'catalog_default')
    assert.equal(resolved.speed.effective_tps, 39.2)
    assert.equal(resolved.speed.checked_at, CATALOG_CHECKED_AT)
    assert.equal(resolved.speed.expected_tps_met, true)
    assert.equal(resolved.reference_pricing.input_usd_per_million, 3)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 15)
    assert.equal(resolved.reference_pricing.cached_input_usd_per_million, 0.30)
    assert.equal(resolved.reference_pricing.source, 'https://www.kimi.com/en/blog/kimi-k3')
    assert.equal(resolved.reference_pricing.checked_at, CATALOG_CHECKED_AT)
  })

  it('machine exact preference cannot bypass an exclusion', () => {
    // Soft preference for cb-ds, but cb-ds is explicitly excluded: the resolver
    // must still resolve a different eligible profile, never the preferred one.
    const resolution = resolver.resolve({
      taskName: 'pref-exclusion',
      declaredRuntime: 'forge/fast',
      machinePreference: 'forge/cb-ds',
      requirements: { excludeProfileIds: ['cb-ds'] } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, true)
    assert.equal(resolution.resolved.profile, 'cb-glmf')
    assert.notEqual(resolution.resolved.profile, 'cb-ds')
  })

  it('machine exact preference cannot bypass an output price cap', () => {
    // Soft preference for cb-ds (output 3.96/m), but the cap of $2 excludes it
    // (and cb-hy at 2.501); the resolver resolves the cheaper eligible GLM Flash.
    const resolution = resolver.resolve({
      taskName: 'pref-cap',
      declaredRuntime: 'forge/fast',
      machinePreference: 'forge/cb-ds',
      requirements: { maxOutputUsdPerMillion: 2 } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, true)
    assert.equal(resolution.resolved.profile, 'cb-glmf')
    assert.notEqual(resolution.resolved.profile, 'cb-ds')
  })

  it('ultra preserves the frontier floor and selects K3 instead of mid-tier Luna', () => {
    const resolution = resolver.resolve({
      taskName: 'ultra-frontier-floor',
      declaredRuntime: 'forge/ultra',
      requirements: {
        expectedTps: 20,
        minimumTps: 8,
        intelligenceMin: 'frontier',
        intelligenceMax: 'premium',
        maxOutputUsdPerMillion: 60,
      } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, true)
    assert.equal(resolution.resolved.profile, 'cb-kimi')
    assert.equal(resolution.resolved.model_id, 'codebuddy/kimi-k3')
    assert.equal(resolution.resolved.intelligence, 'frontier')
    assert.notEqual(resolution.resolved.profile, 'codex-luna')
  })

  it('an invalid declared runtime fails closed instead of opening the policy pool', () => {
    const resolution = resolver.resolve({
      taskName: 'invalid-runtime',
      declaredRuntime: 'not-a-runtime',
      requirements: { minimumTps: 1 } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, false)
    assert.equal(resolution.error.code, 'NO_ELIGIBLE_PROFILE')
  })

  it('exact cb-dsf pin keeps Catalog eligibility and hides the upstream iOA route label', async () => {
    // A fake runtime that aliases the canonical CodeBuddy deepseek-v4-flash to its
    // upstream iOA identity. This must NOT affect Catalog eligibility: cb-dsf stays
    // selectable on its logical profile identity, while the public resolved
    // snapshot keeps canonical identity and Forge retains the private route.
    const baseRuntime = createBuiltinProviderRuntime()
    const ioaRuntime: ProviderRuntime = {
      ...baseRuntime,
      resolveUpstreamModel(_provider, model): string {
        if (model === 'deepseek-v4-flash') return 'deepseek-v4-flash-ioa'
        return model
      },
    }

    const ioaResolver = await createTaskDispatchResolver({
      catalog: createBuiltinCatalog(),
      runtime: ioaRuntime,
      localSpeed: localSamples,
    })

    const resolution = ioaResolver.resolve({
      taskName: 'cb-dsf-ioa',
      declaredRuntime: 'forge/cb-dsf',
      requirements: {} satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, true)
    const resolved = resolution.resolved
    // Exact pin resolves the logical Catalog profile.
    assert.equal(resolved.profile, 'cb-dsf')
    assert.equal(resolution.exactAgentRuntime, 'forge/cb-dsf')
    // Internal iOA route labels never leak into the public model identity.
    assert.equal(resolved.model, 'deepseek-v4-flash')
    assert.equal(resolved.model_id, 'codebuddy/deepseek-v4-flash')
    // Local sample drives speed; catalog drives pricing.
    assert.equal(resolved.speed.effective_tps, 82.42)
    assert.equal(resolved.reference_pricing.input_usd_per_million, 0.44)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 1.32)
  })
})
