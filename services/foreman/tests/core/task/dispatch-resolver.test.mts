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

  it('eligible policy declaration exposes exact choices only, never policy aliases', () => {
    const result = resolver.eligible({
      taskName: 'fast-80-60-eligible',
      declaredRuntime: 'forge/fast',
      requirements: { expectedTps: 80, minimumTps: 60 } satisfies TaskDispatchRequirements,
    })

    assert.equal(result.ok, true)
    const choices = result.choices
    assert.ok(choices.length >= 1)
    for (const choice of choices) {
      // Legacy policy strings are never returned as choices; each row is an
      // exact forge/<profile> pin carrying full resolved dispatch fields.
      assert.notEqual(choice.exactAgentRuntime, 'forge/fast')
      assert.notEqual(choice.exactAgentRuntime, 'forge/general')
      assert.notEqual(choice.exactAgentRuntime, 'forge/ultra')
      assert.match(choice.exactAgentRuntime, /^forge\/[^/]+$/u)
      assert.equal(typeof choice.client, 'string')
      assert.equal(typeof choice.provider, 'string')
      assert.equal(typeof choice.model, 'string')
      assert.equal(typeof choice.model_id, 'string')
      assert.equal(typeof choice.speed, 'object')
      assert.equal(typeof choice.intelligence, 'string')
      assert.equal(typeof choice.reference_pricing, 'object')
    }
  })

  it('eligible shares resolve admission: excluded and over-budget profiles never appear', () => {
    // resolve picks cb-glmf here; eligible must agree on the same hard filters
    // (excludeProfileIds and the output price cap) and expose all survivors.
    const resolution = resolver.resolve({
      taskName: 'eligible-vs-resolve',
      declaredRuntime: 'forge/fast',
      machinePreference: 'forge/cb-ds',
      requirements: { maxOutputUsdPerMillion: 2, excludeProfileIds: ['cb-hy'] } satisfies TaskDispatchRequirements,
    })
    assert.equal(resolution.ok, true)

    const eligible = resolver.eligible({
      taskName: 'eligible-vs-resolve',
      declaredRuntime: 'forge/fast',
      requirements: { maxOutputUsdPerMillion: 2, excludeProfileIds: ['cb-hy'] } satisfies TaskDispatchRequirements,
    })
    assert.equal(eligible.ok, true)

    const exactChoices = eligible.choices.map((choice) => choice.exactAgentRuntime)
    assert.ok(exactChoices.includes(`forge/${resolution.resolved.profile}`))
    // Hard exclusions hold for the projection exactly as for dispatch.
    assert.ok(!exactChoices.includes('forge/cb-ds'))
    assert.ok(!exactChoices.includes('forge/cb-hy'))
  })

  it('eligible exact pin exposes at most the pinned candidate and honors ineligibility', () => {
    // gk-kimi pin passes the image/frontier/$15/min8 requirements: one choice.
    const okEligible = resolver.eligible({
      taskName: 'gk-kimi-eligible',
      declaredRuntime: 'forge/gk-kimi',
      requirements: {
        requiredCapabilities: ['image'] as const,
        intelligenceMin: 'frontier',
        intelligenceMax: 'frontier',
        maxOutputUsdPerMillion: 15,
        minimumTps: 8,
      } satisfies TaskDispatchRequirements,
    })
    assert.equal(okEligible.ok, true)
    assert.equal(okEligible.choices.length, 1)
    assert.equal(okEligible.choices[0].exactAgentRuntime, 'forge/gk-kimi')
    assert.equal(okEligible.choices[0].model, 'k3')
    assert.equal(okEligible.choices[0].intelligence, 'frontier')

    // codex-sol pin fails the $6 output cap: the same admission resolve applies
    // and no choice is produced (at most one, ineligible => zero).
    const failEligible = resolver.eligible({
      taskName: 'codex-sol-eligible',
      declaredRuntime: 'forge/codex-sol',
      requirements: { maxOutputUsdPerMillion: 6 } satisfies TaskDispatchRequirements,
    })
    assert.equal(failEligible.ok, true)
    assert.equal(failEligible.choices.length, 0)
  })
})

describe('core task dispatch-resolver explicit mode (no-model)', () => {
  let resolver: TaskDispatchResolver

  beforeEach(async () => {
    resolver = await createTaskDispatchResolver({
      catalog: createBuiltinCatalog(),
      runtime: createBuiltinProviderRuntime(),
      localSpeed: localSamples,
    })
  })

  it('explicit resolves an exact profile that automatic speed and price filters exclude', () => {
    // cb-ds carries local 65.32 tps and $3.96/m output. Automatic resolve's hard
    // minimum-tps floor (80) and $2 output ceiling both rule it out.
    const autoSpeed = resolver.resolve({
      taskName: 'explicit-vs-auto-speed',
      declaredRuntime: 'forge/cb-ds',
      requirements: { expectedTps: 90, minimumTps: 80 } satisfies TaskDispatchRequirements,
    })
    assert.equal(autoSpeed.ok, false)
    assert.equal(autoSpeed.error.code, 'NO_ELIGIBLE_PROFILE')

    const autoPrice = resolver.resolve({
      taskName: 'explicit-vs-auto-price',
      declaredRuntime: 'forge/cb-ds',
      requirements: { maxOutputUsdPerMillion: 2 } satisfies TaskDispatchRequirements,
    })
    assert.equal(autoPrice.ok, false)
    assert.equal(autoPrice.error.code, 'NO_ELIGIBLE_PROFILE')

    // Explicit mode runs none of those automatic filters: the exact profile is
    // returned with its own truthful local speed and catalog pricing.
    const explicit = resolver.resolveExplicit({ taskName: 'explicit-vs-auto-speed', exactRuntime: 'forge/cb-ds' })
    assert.equal(explicit.ok, true)
    assert.equal(explicit.exactAgentRuntime, 'forge/cb-ds')
    const resolved = explicit.resolved
    assert.equal(resolved.profile, 'cb-ds')
    assert.equal(resolved.requested_agent_runtime, 'forge/cb-ds')
    assert.equal(resolved.speed.effective_tps, 65.32)
    assert.equal(resolved.speed.expected_tps_met, true)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 3.96)
  })

  it('explicit resolves an exact profile that an automatic intelligence filter excludes', () => {
    const auto = resolver.resolve({
      taskName: 'explicit-vs-auto-intel',
      declaredRuntime: 'forge/codex-luna',
      requirements: { intelligenceMin: 'frontier' } satisfies TaskDispatchRequirements,
    })
    assert.equal(auto.ok, false)
    assert.equal(auto.error.code, 'NO_ELIGIBLE_PROFILE')

    const explicit = resolver.resolveExplicit({ taskName: 'explicit-vs-auto-intel', exactRuntime: 'forge/codex-luna' })
    assert.equal(explicit.ok, true)
    assert.equal(explicit.exactAgentRuntime, 'forge/codex-luna')
    assert.equal(explicit.resolved.profile, 'codex-luna')
    assert.equal(explicit.resolved.intelligence, 'mid')
  })

  it('automatic exclusion lists, machine preference, and ranking cannot replace the explicit pin', () => {
    // Automatic resolve honors exclusion and a soft preference by picking a
    // different profile; explicit resolve ignores both and pins cb-ds exactly.
    const auto = resolver.resolve({
      taskName: 'explicit-vs-auto-exclude',
      declaredRuntime: 'forge/fast',
      machinePreference: 'forge/cb-ds',
      requirements: {
        excludeProfileIds: ['cb-ds'],
        expectedTps: 80,
        minimumTps: 60,
      } satisfies TaskDispatchRequirements,
    })
    assert.equal(auto.ok, true)
    assert.notEqual(auto.resolved.profile, 'cb-ds')

    const explicit = resolver.resolveExplicit({ taskName: 'explicit-vs-auto-exclude', exactRuntime: 'forge/cb-ds' })
    assert.equal(explicit.ok, true)
    assert.equal(explicit.exactAgentRuntime, 'forge/cb-ds')
    assert.equal(explicit.resolved.profile, 'cb-ds')
  })

  it('explicit unknown profile returns EXPLICIT_RUNTIME_UNAVAILABLE with a concrete reason and no alternate', () => {
    const explicit = resolver.resolveExplicit({ taskName: 'explicit-unknown', exactRuntime: 'forge/no-such-profile' })
    assert.equal(explicit.ok, false)
    assert.equal(explicit.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.ok(explicit.error.reason.length > 0)
  })

  it('explicit policy alias returns EXPLICIT_RUNTIME_UNAVAILABLE and never falls back to a pooled profile', () => {
    const explicit = resolver.resolveExplicit({ taskName: 'explicit-policy', exactRuntime: 'forge/fast' })
    assert.equal(explicit.ok, false)
    assert.equal(explicit.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.match(explicit.error.reason, /policy/u)
  })

  it('explicit unparseable runtime returns EXPLICIT_RUNTIME_UNAVAILABLE', () => {
    const explicit = resolver.resolveExplicit({ taskName: 'explicit-invalid', exactRuntime: 'not-a-runtime' })
    assert.equal(explicit.ok, false)
    assert.equal(explicit.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.ok(explicit.error.reason.length > 0)
  })

  it('explicit required capability mismatch returns EXPLICIT_RUNTIME_UNAVAILABLE', () => {
    const explicit = resolver.resolveExplicit({
      taskName: 'explicit-capability',
      exactRuntime: 'forge/cb-dsf',
      requiredCapabilities: ['image'] as const,
    })
    assert.equal(explicit.ok, false)
    assert.equal(explicit.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.match(explicit.error.reason, /capabilit/u)
  })

  it('automatic resolve keeps enforcing its original constraints', () => {
    // Auto exact pin still rejects cb-ds under a $2 output cap, even though
    // explicit mode would honor the very same profile.
    const auto = resolver.resolve({
      taskName: 'auto-constraints-unchanged',
      declaredRuntime: 'forge/cb-ds',
      requirements: { maxOutputUsdPerMillion: 2 } satisfies TaskDispatchRequirements,
    })
    assert.equal(auto.ok, false)
    assert.equal(auto.error.code, 'NO_ELIGIBLE_PROFILE')
  })

  it('listExactRuntimes enumerates exact existing configurations with availability and never policy aliases', () => {
    const listed = resolver.listExactRuntimes({ taskName: 'list-exact' })
    assert.equal(listed.ok, true)
    assert.ok(listed.items.length >= 1)

    const byRuntime = new Map(listed.items.map((item) => [item.exactAgentRuntime, item]))
    for (const runtime of ['forge/cb-dsf', 'forge/codex-luna', 'forge/gk-kimi']) {
      assert.ok(byRuntime.has(runtime), `expected ${runtime} in exact runtime list`)
    }
    assert.ok(!byRuntime.has('forge/fast'))
    assert.ok(!byRuntime.has('forge/general'))
    assert.ok(!byRuntime.has('forge/ultra'))

    for (const item of listed.items) {
      assert.match(item.exactAgentRuntime, /^forge\/[^/]+$/u)
      if (item.available) {
        assert.ok(item.resolved)
        assert.equal(item.unavailableReason, undefined)
        assert.equal(item.resolved.profile, item.exactAgentRuntime.slice('forge/'.length))
        assert.equal(item.resolved.requested_agent_runtime, item.exactAgentRuntime)
      } else {
        assert.equal(item.resolved, undefined)
        const reason = item.unavailableReason
        assert.equal(typeof reason, 'string')
        assert.ok(reason && reason.length > 0)
      }
    }
  })

  it('list availability agrees with resolveExplicit under the same capability filter', () => {
    const listed = resolver.listExactRuntimes({ taskName: 'list-agrees', requiredCapabilities: ['image'] as const })
    const direct = resolver.resolveExplicit({
      taskName: 'list-agrees',
      exactRuntime: 'forge/gk-kimi',
      requiredCapabilities: ['image'] as const,
    })
    const gk = listed.items.find((item) => item.exactAgentRuntime === 'forge/gk-kimi')
    assert.ok(gk)
    assert.equal(gk.available, direct.ok)
    if (direct.ok) {
      assert.equal(gk.resolved?.profile, direct.resolved.profile)
    }
  })
})
