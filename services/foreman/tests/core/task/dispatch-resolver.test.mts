import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { Catalog } from '@wrenyard/catalog'
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

// Catalog-default speed samples are stamped checked_at (from the builtin
// provider fixture); speed assertions use this truthful date. Catalog pricing
// rows keep their own truthful checked_at dates, asserted inline per model.
const SPEED_CHECKED_AT = '2026-09-09'
// Real, injected local sample timestamp — must appear verbatim in the snapshot,
// never a fabricated `new Date()` value. Derived from the current clock so the
// sample stays within the 31-day freshness window regardless of run time.
const LOCAL_CHECKED_AT = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()

// Canonical dynamic targets (provider/model:client) for the builtin catalog.
const DSF_CB = 'codebuddy/deepseek-v4-flash:cb'
const PRO_CB = 'codebuddy/deepseek-v4-pro:cb'
const HY_CB = 'codebuddy/hy4-preview:cb'
const HY3_CB = 'codebuddy/hy3:cb'
const HY3_GK = 'codebuddy/hy3:gk'
const GLMF_CB = 'codebuddy/glm-5.3-flash:cb'
const LUNA_CODEX = 'codex/gpt-5.6-luna:codex'
const LUNA_OPENAI_CB = 'openai/gpt-5.6-luna:cb'
const K3_GK = 'kimi-coding/k3:gk'
const POLICY_RUNTIMES = ['forge/fast', 'forge/general', 'forge/ultra']

function localSamples(): LocalSpeedSample[] {
  return [
    { provider: 'codebuddy', model: 'deepseek-v4-flash', tps: 82.42, sampleCount: 12, checkedAt: LOCAL_CHECKED_AT },
    { provider: 'codebuddy', model: 'hy4-preview', tps: 73.89, sampleCount: 9, checkedAt: LOCAL_CHECKED_AT },
    { provider: 'codebuddy', model: 'deepseek-v4-pro', tps: 65.32, sampleCount: 7, checkedAt: LOCAL_CHECKED_AT },
  ]
}

const CANONICAL_TARGET_RE = /^[^/\s]+\/[^:\s]+:[a-z]+$/u

async function createSpeedOverrideResolver(
  defaultTps: number,
  overrideTps: number,
  localSpeed: LocalSpeedSample[] = [],
): Promise<TaskDispatchResolver> {
  const catalog = new Catalog()
  catalog.registerClient({ id: 'codebuddy', gatewayProtocols: ['openai_chat'], taskCapable: true })
  catalog.registerProvider({
    id: 'p',
    displayName: 'P',
    credentialResolver: 'forge-managed',
    models: [{
      id: 'm',
      displayName: 'M',
      intelligence: 'mid',
      speed: { tps: defaultTps, source: 'default-bench', checkedAt: '2026-09-01' },
      pricing: {
        inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 0.5,
        outputUsdPerMillion: 2,
        source: 'fixture',
        checkedAt: '2026-09-01',
      },
    }],
    modelSpeedOverrides: {
      m: { tps: overrideTps, source: 'override-bench', checkedAt: '2026-09-02' },
    },
    protocols: [{
      protocol: 'openai_chat',
      endpoint: 'https://p.example/v1/chat/completions',
      authScheme: 'bearer',
    }],
  })
  const runtime: ProviderRuntime = {
    credential: async () => undefined,
    resolveUpstreamModel: (_provider, model) => model,
    publicResponseModel: (_provider, _model, _upstreamModel, publicModel) => publicModel,
    configureApiKey: async () => {},
  }
  return createTaskDispatchResolver({ catalog, runtime, localSpeed: () => localSpeed })
}

describe('core task dispatch-resolver automatic mode (no-model)', () => {
  let resolver: TaskDispatchResolver

  beforeEach(async () => {
    resolver = await createTaskDispatchResolver({
      catalog: createBuiltinCatalog(),
      runtime: createBuiltinProviderRuntime(),
      localSpeed: localSamples,
    })
  })

  it('automatic selection over the full task-capable candidate pool picks the cheaper eligible HY3 canonical target', () => {
    // Auto pool is every canonical task-capable candidate from the Catalog.
    // With an 80/60 floor the expected group contains the local-measured
    // DeepSeek Flash (82.42) and the catalog-default HY3 (93.8); HY3 wins on
    // reference output price (0.556) even though the local cb candidate is
    // eligible.
    const resolution = resolver.resolve({
      taskName: 'auto-80-60',
      requirements: { expectedTps: 80, minimumTps: 60 } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, true)
    const resolved = resolution.resolved
    // Canonical identity, not a source preset profile.
    assert.equal(resolved.profile, HY3_CB)
    assert.equal(resolution.exactAgentRuntime, HY3_CB)
    assert.equal(resolved.requested_agent_runtime, '')
    assert.equal(resolved.client, 'codebuddy')
    assert.equal(resolved.provider, 'codebuddy')
    assert.equal(resolved.model, 'hy3')
    assert.equal(resolved.model_id, 'codebuddy/hy3')
    assert.equal(resolved.mode, 'native')
    assert.equal(resolved.intelligence, 'low')
    // HY3 has no local sample, so the sourced catalog default is used.
    assert.equal(resolved.speed.source, 'catalog_default')
    assert.equal(resolved.speed.effective_tps, 93.8)
    assert.equal(resolved.speed.sample_count, 0)
    assert.equal(resolved.speed.checked_at, SPEED_CHECKED_AT)
    assert.equal(resolved.speed.expected_tps_met, true)
    // Per-million reference pricing from the catalog, with a real source stamp.
    assert.equal(resolved.reference_pricing.input_usd_per_million, 0.139)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 0.556)
    assert.equal(resolved.reference_pricing.cached_input_usd_per_million, 0.035)
    assert.equal(resolved.reference_pricing.source, 'https://cloud.tencent.com/document/product/1823/130055')
    assert.equal(resolved.reference_pricing.checked_at, '2026-09-08')
  })

  it('a legacy policy declaredRuntime opens the same automatic pool', () => {
    const withPolicy = resolver.resolve({
      taskName: 'policy-auto',
      declaredRuntime: 'forge/fast',
      requirements: { expectedTps: 80, minimumTps: 60 } satisfies TaskDispatchRequirements,
    })
    const withAbsent = resolver.resolve({
      taskName: 'absent-auto',
      requirements: { expectedTps: 80, minimumTps: 60 } satisfies TaskDispatchRequirements,
    })

    assert.equal(withPolicy.ok, true)
    assert.equal(withPolicy.resolved.requested_agent_runtime, 'forge/fast')
    assert.equal(withPolicy.exactAgentRuntime, HY3_CB)
    assert.equal(withAbsent.ok, true)
    assert.equal(withAbsent.exactAgentRuntime, HY3_CB)
  })

  it('the pre-existing cap deterministically chooses the native GLM Flash target without any machine preference', () => {
    // No machine preference participates: the canonical codebuddy GLM-5.3-Flash
    // target satisfies the cap/min-tps/intelligence requirements, and client
    // collapse selects the native codebuddy route over any equal-priced GLM
    // Flash gateway variant.
    const resolution = resolver.resolve({
      taskName: 'glm-flash-eligible',
      declaredRuntime: 'forge/fast',
      requirements: {
        maxOutputUsdPerMillion: 2,
        minimumTps: 40,
        intelligenceMin: 'mid',
      } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, true)
    assert.equal(resolution.exactAgentRuntime, GLMF_CB)
    const resolved = resolution.resolved
    assert.equal(resolved.profile, GLMF_CB)
    assert.equal(resolved.model, 'glm-5.3-flash')
    assert.equal(resolved.intelligence, 'mid')
    assert.equal(resolved.speed.source, 'catalog_default')
    assert.equal(resolved.speed.effective_tps, 73.1)
    assert.equal(resolved.speed.checked_at, SPEED_CHECKED_AT)
    assert.equal(resolved.reference_pricing.input_usd_per_million, 0.15)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 0.5)
  })

  it('a legacy non-policy forge/<profile> declaredRuntime fails closed (no source preset map)', () => {
    const resolution = resolver.resolve({
      taskName: 'legacy-pin',
      declaredRuntime: 'forge/codex-luna',
      requirements: { minimumTps: 1 } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, false)
    assert.equal(resolution.error.code, 'NO_ELIGIBLE_PROFILE')
  })

  it('an invalid declared runtime fails closed instead of opening the automatic pool', () => {
    const resolution = resolver.resolve({
      taskName: 'invalid-runtime',
      declaredRuntime: 'not-a-runtime',
      requirements: { minimumTps: 1 } satisfies TaskDispatchRequirements,
    })

    assert.equal(resolution.ok, false)
    assert.equal(resolution.error.code, 'NO_ELIGIBLE_PROFILE')
  })

  it('exact canonical target pin keeps Catalog identity and hides the upstream iOA route label', async () => {
    // A fake runtime that aliases the canonical CodeBuddy deepseek-v4-flash to
    // its upstream iOA identity. This must NOT affect Catalog eligibility: the
    // canonical target stays selectable, while the public resolved snapshot
    // keeps canonical identity and Forge retains the private route.
    const baseRuntime = createBuiltinProviderRuntime()
    const ioaRuntime: ProviderRuntime = {
      ...baseRuntime,
      resolveUpstreamModel(provider, model) {
        if (provider.id === 'codebuddy' && model === 'deepseek-v4-flash') return 'deepseek-v4-flash-ioa'
        return model
      },
    }

    const ioaResolver = await createTaskDispatchResolver({
      catalog: createBuiltinCatalog(),
      runtime: ioaRuntime,
      localSpeed: localSamples,
    })

    const resolution = ioaResolver.resolveExplicit({
      taskName: 'dsf-ioa',
      exactRuntime: DSF_CB,
    })

    assert.equal(resolution.ok, true)
    const resolved = resolution.resolved
    // Exact pin resolves the logical Catalog target.
    assert.equal(resolved.profile, DSF_CB)
    assert.equal(resolution.exactAgentRuntime, DSF_CB)
    // Internal iOA route labels never leak into the public model identity.
    assert.equal(resolved.model, 'deepseek-v4-flash')
    assert.equal(resolved.model_id, 'codebuddy/deepseek-v4-flash')
    // Local sample drives speed; catalog drives pricing.
    assert.equal(resolved.speed.source, 'local_31d')
    assert.equal(resolved.speed.effective_tps, 82.42)
    assert.equal(resolved.reference_pricing.input_usd_per_million, 0.44)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 1.32)
  })

  it('eligible policy declaration exposes exact canonical choices only, never policy aliases', () => {
    const result = resolver.eligible({
      taskName: 'fast-80-60-eligible',
      declaredRuntime: 'forge/fast',
      requirements: { expectedTps: 80, minimumTps: 60 } satisfies TaskDispatchRequirements,
    })

    assert.equal(result.ok, true)
    const choices = result.choices
    assert.ok(choices.length >= 1)
    assert.ok(!choices.some((choice) => choice.exactAgentRuntime === HY3_GK))
    for (const choice of choices) {
      // Legacy policy strings are never returned as choices; each row is an
      // exact canonical provider/model:client target carrying full resolved
      // dispatch fields.
      assert.ok(!POLICY_RUNTIMES.includes(choice.exactAgentRuntime))
      assert.match(choice.exactAgentRuntime, CANONICAL_TARGET_RE)
      assert.equal(typeof choice.client, 'string')
      assert.equal(typeof choice.provider, 'string')
      assert.equal(typeof choice.model, 'string')
      assert.equal(typeof choice.model_id, 'string')
      assert.equal(typeof choice.speed, 'object')
      assert.equal(typeof choice.intelligence, 'string')
      assert.equal(typeof choice.reference_pricing, 'object')
    }
  })

  it('eligible shares resolve admission: over-budget and excluded targets never appear', () => {
    // Automatic resolve picks GLM Flash under the cap; eligible must agree on
    // the same hard filters (maxOutputUsdPerMillion, excludeProfileIds) and
    // expose all survivors.
    const resolution = resolver.resolve({
      taskName: 'eligible-vs-resolve',
      requirements: { maxOutputUsdPerMillion: 2, minimumTps: 40, intelligenceMin: 'mid' } satisfies TaskDispatchRequirements,
    })
    assert.equal(resolution.ok, true)

    const eligible = resolver.eligible({
      taskName: 'eligible-vs-resolve',
      requirements: { maxOutputUsdPerMillion: 2, minimumTps: 40, intelligenceMin: 'mid' } satisfies TaskDispatchRequirements,
    })
    assert.equal(eligible.ok, true)

    const exactChoices = eligible.choices.map((choice) => choice.exactAgentRuntime)
    assert.ok(exactChoices.includes(resolution.exactAgentRuntime))
    for (const choice of eligible.choices) {
      assert.ok(choice.reference_pricing.output_usd_per_million! <= 2)
    }
  })

  it('eligible loads the localSpeed supplier once per public call, not once per candidate', async () => {
    // Counting supplier: eligible evaluates every candidate in the (large) task
    // pool, so the pre-optimization per-candidate localSpeed reads would invoke
    // the source once per candidate instead of once per public call.
    let calls = 0
    const countingResolver = await createTaskDispatchResolver({
      catalog: createBuiltinCatalog(),
      runtime: createBuiltinProviderRuntime(),
      localSpeed: () => {
        calls += 1
        return localSamples()
      },
    })

    const first = countingResolver.eligible({
      taskName: 'eligible-counted-first',
      requirements: { expectedTps: 80, minimumTps: 60 } satisfies TaskDispatchRequirements,
    })
    assert.equal(first.ok, true)
    assert.ok(first.choices.length >= 1)
    // One public eligible() call reads the source exactly once, whatever the
    // number of candidates evaluated.
    assert.equal(calls, 1)

    const second = countingResolver.eligible({
      taskName: 'eligible-counted-second',
      requirements: { expectedTps: 80, minimumTps: 60 } satisfies TaskDispatchRequirements,
    })
    // A second public call refreshes the sample set exactly once more — no
    // cross-run/global caching.
    assert.equal(second.ok, true)
    assert.equal(calls, 2)

    // The same fresh sample set yields identical choices/eligibility per call.
    assert.deepEqual(
      second.choices.map((choice) => choice.exactAgentRuntime),
      first.choices.map((choice) => choice.exactAgentRuntime),
    )
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

  it('explicit resolves an exact canonical target that automatic filters exclude', () => {
    // PRO_CB carries output $3.96/m. Automatic resolve's $2 output ceiling
    // rules it out (GLM Flash is chosen instead); explicit mode runs none of
    // those automatic filters and returns the exact target with its own
    // truthful local speed and catalog pricing.
    const autoPrice = resolver.resolve({
      taskName: 'explicit-vs-auto-price',
      requirements: { maxOutputUsdPerMillion: 2, minimumTps: 40, intelligenceMin: 'mid' } satisfies TaskDispatchRequirements,
    })
    assert.equal(autoPrice.ok, true)
    assert.notEqual(autoPrice.exactAgentRuntime, PRO_CB)

    const explicit = resolver.resolveExplicit({ taskName: 'explicit-vs-auto-price', exactRuntime: PRO_CB })
    assert.equal(explicit.ok, true)
    assert.equal(explicit.exactAgentRuntime, PRO_CB)
    const resolved = explicit.resolved
    assert.equal(resolved.profile, PRO_CB)
    assert.equal(resolved.requested_agent_runtime, PRO_CB)
    assert.equal(resolved.client, 'codebuddy')
    assert.equal(resolved.model, 'deepseek-v4-pro')
    assert.equal(resolved.intelligence, 'mid')
    assert.equal(resolved.speed.source, 'local_31d')
    assert.equal(resolved.speed.effective_tps, 65.32)
    assert.equal(resolved.speed.expected_tps_met, true)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 3.96)
  })

  it('explicit resolves a gateway canonical target with a required capability', () => {
    // K3 gateway target costs $15/m output, so an automatic $2 cap rules it
    // out; explicit mode runs none of those filters and admits it when the
    // required image capability is satisfied.
    const auto = resolver.resolve({
      taskName: 'explicit-vs-auto-intel',
      requirements: { maxOutputUsdPerMillion: 2, minimumTps: 40, intelligenceMin: 'mid' } satisfies TaskDispatchRequirements,
    })
    assert.equal(auto.ok, true)
    assert.notEqual(auto.exactAgentRuntime, K3_GK)

    const explicit = resolver.resolveExplicit({
      taskName: 'explicit-vs-auto-intel',
      exactRuntime: K3_GK,
      requiredCapabilities: ['image'] as const,
    })
    assert.equal(explicit.ok, true)
    assert.equal(explicit.exactAgentRuntime, K3_GK)
    const resolved = explicit.resolved
    assert.equal(resolved.profile, K3_GK)
    assert.equal(resolved.client, 'grok')
    assert.equal(resolved.provider, 'kimi-coding')
    assert.equal(resolved.model, 'k3')
    assert.equal(resolved.model_id, 'kimi-coding/k3')
    assert.equal(resolved.mode, 'gateway')
    assert.equal(resolved.protocol, 'openai_chat')
    assert.equal(resolved.intelligence, 'high')
    assert.equal(resolved.speed.source, 'catalog_default')
    assert.equal(resolved.speed.effective_tps, 39.7)
    assert.equal(resolved.speed.checked_at, SPEED_CHECKED_AT)
    assert.equal(resolved.reference_pricing.output_usd_per_million, 15)
  })

  it('explicit malformed canonical-looking target is terminal with no fallback', () => {
    // Unknown client key: looks like run syntax but fails the shared parser.
    const malformed = resolver.resolveExplicit({ taskName: 'explicit-malformed', exactRuntime: 'codebuddy/deepseek-v4-flash:zz' })
    assert.equal(malformed.ok, false)
    assert.equal(malformed.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.match(malformed.error.reason, /parseable canonical dynamic target/u)

    const bare = resolver.resolveExplicit({ taskName: 'explicit-malformed', exactRuntime: 'not-a-target' })
    assert.equal(bare.ok, false)
    assert.equal(bare.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.ok(bare.error.reason.length > 0)
  })

  it('explicit policy and legacy non-policy runtimes are never valid exact targets', () => {
    const policy = resolver.resolveExplicit({ taskName: 'explicit-policy', exactRuntime: 'forge/fast' })
    assert.equal(policy.ok, false)
    assert.equal(policy.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.ok(policy.error.reason.length > 0)

    const legacy = resolver.resolveExplicit({ taskName: 'explicit-legacy', exactRuntime: 'forge/codex-luna' })
    assert.equal(legacy.ok, false)
    assert.equal(legacy.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.ok(legacy.error.reason.length > 0)
  })

  it('explicit rejects a protocol-compatible target outside the client-provider execution contract', () => {
    const incompatible = resolver.resolveExplicit({ taskName: 'explicit-incompatible', exactRuntime: HY3_GK })
    assert.equal(incompatible.ok, false)
    assert.equal(incompatible.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.match(incompatible.error.reason, /provider codebuddy cannot serve client grok/u)
  })

  it('explicit unknown provider or model returns EXPLICIT_RUNTIME_UNAVAILABLE', () => {
    const unknownProvider = resolver.resolveExplicit({ taskName: 'explicit-unknown', exactRuntime: 'no-such-provider/deepseek-v4-flash:cb' })
    assert.equal(unknownProvider.ok, false)
    assert.equal(unknownProvider.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.match(unknownProvider.error.reason, /cannot resolve/u)

    const unknownModel = resolver.resolveExplicit({ taskName: 'explicit-unknown', exactRuntime: 'codebuddy/no-such-model:cb' })
    assert.equal(unknownModel.ok, false)
    assert.equal(unknownModel.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.match(unknownModel.error.reason, /cannot resolve/u)
  })

  it('explicit catalog-resolvable but non-task-capable target is terminal', () => {
    // dsh parses and resolves through the Catalog (openai_chat gateway), but the
    // client is not task-capable, so no candidate/runtime plan exists.
    const nonTask = resolver.resolveExplicit({ taskName: 'explicit-non-task', exactRuntime: 'openai/gpt-5.6-luna:dsh' })
    assert.equal(nonTask.ok, false)
    assert.equal(nonTask.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.match(nonTask.error.reason, /task-capable/u)
  })

  it('explicit required capability mismatch returns EXPLICIT_RUNTIME_UNAVAILABLE', () => {
    const explicit = resolver.resolveExplicit({
      taskName: 'explicit-capability',
      exactRuntime: DSF_CB,
      requiredCapabilities: ['image'] as const,
    })
    assert.equal(explicit.ok, false)
    assert.equal(explicit.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.match(explicit.error.reason, /capabilit/u)
  })

  it('explicit stays terminal with no fallback even when automatic mode has other candidates', () => {
    // codebuddy/minimax-m3:cb is a parseable task-capable candidate, but it
    // carries no truthful intelligence/evidence and can never serve. Explicit
    // mode fails terminally even though automatic selection has many eligible
    // alternatives: the explicit error is returned, never a substitute target.
    const unavailable = resolver.resolveExplicit({ taskName: 'explicit-no-fallback', exactRuntime: 'codebuddy/minimax-m3:cb' })
    const auto = resolver.resolve({
      taskName: 'explicit-no-fallback',
      requirements: { maxOutputUsdPerMillion: 2, minimumTps: 40, intelligenceMin: 'mid' } satisfies TaskDispatchRequirements,
    })
    assert.equal(unavailable.ok, false)
    assert.equal(unavailable.error.code, 'EXPLICIT_RUNTIME_UNAVAILABLE')
    assert.ok(unavailable.error.reason.length > 0)
    assert.equal(auto.ok, true)
    assert.notEqual(auto.exactAgentRuntime, 'codebuddy/minimax-m3:cb')
  })

  it('listExactRuntimes enumerates canonical dynamic targets only, never policy aliases', () => {
    const listed = resolver.listExactRuntimes({ taskName: 'list-exact' })
    assert.equal(listed.ok, true)
    assert.ok(listed.items.length >= 1)

    const byRuntime = new Map(listed.items.map((item) => [item.exactAgentRuntime, item]))
    for (const runtime of [DSF_CB, LUNA_CODEX, K3_GK, GLMF_CB]) {
      assert.ok(byRuntime.has(runtime), `expected ${runtime} in exact runtime list`)
    }
    for (const policy of POLICY_RUNTIMES) {
      assert.ok(!byRuntime.has(policy))
    }
    assert.ok(!byRuntime.has(HY3_GK))

    for (const item of listed.items) {
      assert.match(item.exactAgentRuntime, CANONICAL_TARGET_RE)
      assert.ok(!POLICY_RUNTIMES.includes(item.exactAgentRuntime))
      if (item.available) {
        assert.ok(item.resolved)
        assert.equal(item.unavailableReason, undefined)
        assert.equal(item.resolved.profile, item.exactAgentRuntime)
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
      exactRuntime: K3_GK,
      requiredCapabilities: ['image'] as const,
    })
    const k3 = listed.items.find((item) => item.exactAgentRuntime === K3_GK)
    assert.ok(k3)
    assert.equal(k3.available, direct.ok)
    if (direct.ok) {
      assert.equal(k3.resolved?.profile, direct.resolved.profile)
    }
  })
})

describe('core task dispatch-resolver structured failure codes (no-model)', () => {
  let resolver: TaskDispatchResolver

  beforeEach(async () => {
    resolver = await createTaskDispatchResolver({
      catalog: createBuiltinCatalog(),
      runtime: createBuiltinProviderRuntime(),
      localSpeed: localSamples,
    })
  })

  // Deterministic candidate universe, mirroring the automatic pool. Every
  // scenario below keeps only well-known canonical targets so the expected
  // closed code is pinned regardless of unrelated fixture candidates.
  const allTargets = (): string[] =>
    resolver.listExactRuntimes({ taskName: 'codes-universe' }).items.map((item) => item.exactAgentRuntime)

  const excluding = (...keep: string[]): string[] => {
    const keepSet = new Set(keep)
    return allTargets().filter((target) => !keepSet.has(target))
  }

  it('eligible reports price_limit when every remaining candidate exceeds the max output price', () => {
    // PRO ($3.96/m) and K3 ($15/m) both clear the intelligence floor but trip
    // the $2 output-price gate; the closed code is the price gate.
    const result = resolver.eligible({
      taskName: 'code-price-limit',
      requirements: {
        maxOutputUsdPerMillion: 2,
        excludeProfileIds: excluding(PRO_CB, K3_GK),
      } satisfies TaskDispatchRequirements,
    })
    assert.equal(result.ok, false)
    const error = result.error
    assert.equal(error.code, 'NO_ELIGIBLE_PROFILE')
    assert.equal(error.resolutionFailureCode, 'price_limit')
    assert.match(error.message, /no eligible dispatch plan/u)
  })

  it('eligible reports speed_requirement when no candidate meets the minimum TPS', () => {
    // A floor far above every trusted speed sample and catalog default drives
    // the whole pool onto the minimum-speed gate.
    const result = resolver.eligible({
      taskName: 'code-speed-floor',
      requirements: { minimumTps: 1_000_000 } satisfies TaskDispatchRequirements,
    })
    assert.equal(result.ok, false)
    const error = result.error
    assert.equal(error.code, 'NO_ELIGIBLE_PROFILE')
    assert.equal(error.resolutionFailureCode, 'speed_requirement')
    assert.match(error.message, /no eligible dispatch plan/u)
  })

  it('eligible reports no_available_provider when every candidate is excluded by profile', () => {
    const result = resolver.eligible({
      taskName: 'code-all-excluded',
      requirements: { excludeProfileIds: allTargets() } satisfies TaskDispatchRequirements,
    })
    assert.equal(result.ok, false)
    const error = result.error
    assert.equal(error.code, 'NO_ELIGIBLE_PROFILE')
    assert.equal(error.resolutionFailureCode, 'no_available_provider')
    assert.match(error.message, /no eligible dispatch plan/u)
  })

  it('resolve reports no_available_provider for a non-policy declared runtime', () => {
    const resolution = resolver.resolve({
      taskName: 'code-legacy-non-policy',
      declaredRuntime: 'forge/codex-luna',
      requirements: { minimumTps: 1 } satisfies TaskDispatchRequirements,
    })
    assert.equal(resolution.ok, false)
    const error = resolution.error
    assert.equal(error.code, 'NO_ELIGIBLE_PROFILE')
    assert.equal(error.resolutionFailureCode, 'no_available_provider')
    assert.match(error.message, /no eligible dispatch plan/u)
  })

  it('resolve reports speed_requirement when the whole automatic pool fails the minimum TPS gate', () => {
    const resolution = resolver.resolve({
      taskName: 'code-resolve-speed',
      requirements: { minimumTps: 1_000_000 } satisfies TaskDispatchRequirements,
    })
    assert.equal(resolution.ok, false)
    const error = resolution.error
    assert.equal(error.code, 'NO_ELIGIBLE_PROFILE')
    assert.equal(error.resolutionFailureCode, 'speed_requirement')
    assert.match(error.message, /no eligible dispatch plan/u)
  })

  it('uses a below-floor provider override instead of an above-floor model default in diagnostics', async () => {
    const overrideResolver = await createSpeedOverrideResolver(100, 10)
    const result = overrideResolver.resolve({
      taskName: 'override-below-floor',
      requirements: { minimumTps: 50 },
    })

    assert.equal(result.ok, false)
    assert.equal(result.error.resolutionFailureCode, 'speed_requirement')
  })

  it('uses an above-floor provider override instead of a below-floor model default for admission', async () => {
    const overrideResolver = await createSpeedOverrideResolver(10, 100)
    const result = overrideResolver.resolve({
      taskName: 'override-above-floor',
      requirements: { minimumTps: 50 },
    })

    assert.equal(result.ok, true)
    assert.equal(result.resolved.speed.source, 'provider_override')
    assert.equal(result.resolved.speed.effective_tps, 100)
  })

  it('lets a usable exact local sample win over the provider override', async () => {
    const overrideResolver = await createSpeedOverrideResolver(100, 10, [{
      provider: 'p',
      model: 'm',
      tps: 80,
      sampleCount: 2,
      checkedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }])
    const result = overrideResolver.resolve({
      taskName: 'local-wins',
      requirements: { minimumTps: 50 },
    })

    assert.equal(result.ok, true)
    assert.equal(result.resolved.speed.source, 'local_31d')
    assert.equal(result.resolved.speed.effective_tps, 80)
  })

  it('ignores an unusable local sample and reports the provider override gate', async () => {
    const overrideResolver = await createSpeedOverrideResolver(100, 10, [{
      provider: 'p',
      model: 'm',
      tps: 999,
      sampleCount: 0,
      checkedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }])
    const result = overrideResolver.resolve({
      taskName: 'invalid-local-falls-back',
      requirements: { minimumTps: 50 },
    })

    assert.equal(result.ok, false)
    assert.equal(result.error.resolutionFailureCode, 'speed_requirement')
  })

  it('mixed singleton eliminations resolve deterministically to the cheapest candidate gate', () => {
    // LUNA (mid) fails the high floor -> intelligence_requirement at $1.2/m;
    // K3 clears the band but fails the $2 price gate -> price_limit at $15/m.
    // selectTaskResolutionFailure must surface LUNA's intelligence_requirement
    // because it is the candidate the deterministic router would have ranked
    // first had its gate passed.
    const result = resolver.eligible({
      taskName: 'code-mixed',
      requirements: {
        intelligenceMin: 'high',
        maxOutputUsdPerMillion: 2,
        excludeProfileIds: excluding(LUNA_CODEX, K3_GK),
      } satisfies TaskDispatchRequirements,
    })
    assert.equal(result.ok, false)
    const error = result.error
    assert.equal(error.code, 'NO_ELIGIBLE_PROFILE')
    assert.equal(error.resolutionFailureCode, 'intelligence_requirement')
    assert.match(error.message, /no eligible dispatch plan/u)
  })
})
