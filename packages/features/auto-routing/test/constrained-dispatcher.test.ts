import assert from 'node:assert/strict';
import test from 'node:test';
import { Catalog, normalizeIntelligenceTier, normalizeReasoningEffort, type DispatchCandidate, type IntelligenceTier, type ModelCapability, type ModelDefinition, type ModelPricing, type ReasoningEffort, type ProviderDefinition, formatRunSyntax, parseRunSyntax, PUBLIC_CLIENT_KEYS, resolveRunSyntax } from '@wrenyard/providers/catalog';
import { resolveConstrainedDispatch, isDynamicFast, type TaskDispatchRequirements } from '../src/index.ts';

function pricingFixture(): ModelPricing {
  return [0.1, 1, 2];
}

/**
 * Registers a provider with the two required Phase-1 reasoning-effort fields
 * injected so fixtures that predate the reasoning-effort contract keep loading:
 * every provider gets a route-owned `convertReasoningEffort`, and every model
 * that does not declare its own ladder defaults to the single `none` level. An
 * explicitly declared field (or `reasoningEffortMappings`) always wins.
 */
function registerProvider(catalog: Catalog, provider: unknown): void {
  const record = provider as { models: readonly ModelDefinition[] } & Record<string, unknown>;
  catalog.registerProvider({
    convertReasoningEffort: () => ({}),
    ...record,
    models: record.models.map((model) => ({ ...model, reasoningEfforts: model.reasoningEfforts ?? ['none'] })),
    reasoningEffortMappings: record.reasoningEffortMappings ?? Object.fromEntries(record.models.map(model => [model.id, Object.fromEntries(catalog.clients().map(client => [client.id, Object.fromEntries((model.reasoningEfforts ?? ['none']).map(e => [e, {effort:e}]))]))])),
  } as unknown as ProviderDefinition);
}

test('registration rejects missing or invalid model list prices', () => {
  // A route that publishes no price at all is legal: its price is unknown and
  // is never inferred as free or as zero. Only a malformed tuple is rejected.
  for (const pricing of [[0.1, 1, Number.NaN], [0.1, -1, 2], [0.1, 1]]) {
    const catalog = new Catalog();
    assert.throws(() => registerProvider(catalog, {
      id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
      models: [{ id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), pricing } as unknown as ModelDefinition],
    }), /pricing/);
  }
});

function speedFixture(tps = 40): number {
  return tps;
}

// A freshly-minted ISO timestamp a few days before the current clock, used so
// local speed samples stay within the 31-day freshness window regardless of when
// the suite runs.
function recentIso(daysAgo = 5): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

test('native routing wins over a shared gateway protocol', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'native', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
    nativeClients: ['native'], models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://example.com/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.equal(catalog.resolveRun('native', 'vendor', 'glm-5.3').mode, 'native');
});

test('gateway models use provider/model ids and resolve to an exact dispatch plan', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'client', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(),
      id: 'glm-5.3',
      displayName: 'M',
      intelligence: 'mid',
      canonicalModel: { id: 'glm-5.3', displayName: 'Shared M' },
      speed: speedFixture(),
    }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://secret.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const gatewayModel = catalog.listGatewayModels('openai_chat')[0];
  assert.equal(gatewayModel?.publicId, 'vendor/glm-5.3');
  assert.equal(gatewayModel && 'canonicalModel' in gatewayModel, false);
  assert.deepEqual(catalog.resolveRun('client', 'vendor', 'glm-5.3'), {
    client: 'client', provider: 'vendor', model: 'glm-5.3', mode: 'gateway', protocol: 'openai_chat',
      });
});

test('model-level supportedClients restricts resolution and hides gateway publication', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'opencode', gatewayProtocols: ['openai_chat'] });
  catalog.registerClient({ id: 'codebuddy', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
    nativeClients: ['opencode'],
    models: [
      { pricing: pricingFixture(), id: 'glm-5.3-flash', displayName: 'Free M', intelligence: 'mid', speed: speedFixture(), free: true, supportedClients: ['opencode'] },
      { pricing: pricingFixture(), id: 'glm-5.3', displayName: 'Paid M', intelligence: 'mid', speed: speedFixture() },
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' }],
  });

  // A restricted model resolves only for its exact declared client, and only
  // through that client's native transport.
  const native = catalog.resolveRun('opencode', 'vendor', 'glm-5.3-flash');
  assert.equal(native.mode, 'native');
  assert.throws(() => catalog.resolveRun('codebuddy', 'vendor', 'glm-5.3-flash'), /is not available on client codebuddy/);

  // Restricted models never appear in the client-agnostic gateway directory nor
  // resolve through a gateway protocol.
  const listed = catalog.listGatewayModels('openai_chat').map((entry) => entry.id);
  assert.ok(!listed.includes('glm-5.3-flash'));
  assert.ok(listed.includes('glm-5.3'));
  assert.throws(() => catalog.resolveGatewayModel('openai_chat', 'glm-5.3-flash', 'vendor'), /not available through the gateway/);
  assert.equal(catalog.resolveGatewayModel('openai_chat', 'glm-5.3', 'vendor').model.id, 'glm-5.3');

  // An EMPTY supportedClients list is a valid declaration: registration succeeds
  // and the model stays resolvable through the client-agnostic gateway directory,
  // but no external client may resolve a task run for it, so enumeration never
  // yields it. Malformed declarations still fail atomically.
  const register = (supportedClients: readonly string[]) => {
    const catalog = new Catalog();
    catalog.registerClient({ id: 'codebuddy', gatewayProtocols: ['openai_chat'], taskCapable: true });
    catalog.registerClient({ id: 'codex', gatewayProtocols: ['openai_chat'], taskCapable: true });
    registerProvider(catalog, {
      id: 'p', displayName: 'P', credentialResolver: 'managed',
      models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), supportedClients }],
      protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
    });
    return catalog;
  };
  const emptyList = register([]);
  assert.ok(emptyList.listGatewayModels('openai_chat').map((entry) => entry.id).includes('glm-5.3'));
  assert.equal(emptyList.resolveGatewayModel('openai_chat', 'glm-5.3', 'p').model.id, 'glm-5.3');
  for (const client of ['codebuddy', 'codex']) {
    assert.throws(() => emptyList.resolveRun(client, 'p', 'glm-5.3'), /not supported by this client/);
  }
  assert.ok(!emptyList.enumerateTaskCandidates().some((candidate) => candidate.provider === 'p' && candidate.model === 'glm-5.3'));
  assert.throws(() => register(['c1', 'c1']), /duplicate supported client c1/);
  assert.throws(() => register(['   ']), /empty supported client id/);
  assert.doesNotThrow(() => register(['c1']));
});

function buildDispatchCatalog(): { catalog: Catalog; candidates: DispatchCandidate[] } {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  const mk = (
    id: string,
    intelligence: IntelligenceTier,
    tps: number,
    outUsd: number | undefined,
    capabilities: readonly ModelCapability[] = ['text'] as readonly ModelCapability[],
  ) => ({ pricing: pricingFixture(),
    id, displayName: id, intelligence, capabilities,
    speed: tps,
    ...(outUsd !== undefined
      ? { pricing: [1, 1, outUsd] as const }
      : {}),
  });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [
      mk('deepseek-v4.1-flash', 'mid', 50, 2),
      mk('claude-opus-5', 'premium', 20, 50, ['text']),
      mk('glm-5.3', 'high', 30, 5),
      mk('deepseek-v4-pro', 'mid', 5, 1),
      mk('hunyuan-hy3', 'low', 40, 3),
      mk('glm-5.3-flash', 'mid', 50, undefined),
      mk('qwen3.8-max', 'mid', 50, 2, ['text']),
      mk('kimi-k2.8', 'mid', 50, 4, ['text', 'image']),
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  registerProvider(catalog, {
    id: 'p2', displayName: 'P2', credentialResolver: 'managed',
    models: [mk('hunyuan-hy4-preview', 'mid', 50, 2)],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p2.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const candidates: DispatchCandidate[] = [
    { profileId: 'fast', client: 'c1', provider: 'p', model: 'deepseek-v4.1-flash' },
    { profileId: 'premium', client: 'c1', provider: 'p', model: 'claude-opus-5' },
    { profileId: 'mid', client: 'c1', provider: 'p', model: 'glm-5.3' },
    { profileId: 'slow', client: 'c1', provider: 'p', model: 'deepseek-v4-pro' },
    { profileId: 'low', client: 'c1', provider: 'p', model: 'hunyuan-hy3' },
    { profileId: 'noprice', client: 'c1', provider: 'p', model: 'glm-5.3-flash' },
    { profileId: 'textonly', client: 'c1', provider: 'p', model: 'qwen3.8-max' },
    { profileId: 'vision', client: 'c1', provider: 'p', model: 'kimi-k2.8' },
  ];
  return { catalog, candidates };
}

test('hard max output price excludes over-budget candidates', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { maxOutputUsdPerMillion: 4 });
  assert.equal(result.ok, true);
  assert.notEqual(result.selected.plan.model, 'claude-opus-5');
  assert.notEqual(result.selected.plan.model, 'glm-5.3');
  assert.ok((result.selected.model.pricing?.[2] ?? Infinity) <= 4);
  const none = resolveConstrainedDispatch(catalog, candidates, { maxOutputUsdPerMillion: 0.5 });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-eligible-candidate');
});

test('intelligence minimum excludes below-min tiers but admits any tier at or above it', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { intelligenceMin: 'mid' });
  assert.equal(result.ok, true);
  assert.notEqual(result.selected.plan.model, 'hunyuan-hy3');
  const intel = result.selected.model.intelligence;
  assert.ok(intel === 'mid' || intel === 'high' || intel === 'premium');
  // A premium candidate above the old high ceiling stays eligible: there is no
  // configurable maximum intelligence band.
  const premiumModel = catalog.provider('p')?.models.find(model => model.id === 'claude-opus-5');
  assert.ok(premiumModel);
  const premium = resolveConstrainedDispatch(catalog, candidates.filter(candidate => candidate.model === 'claude-opus-5'), { intelligenceMin: 'mid', intelligenceExpected: 'mid' });
  assert.equal(premium.ok, true);
  assert.equal(premium.selected.model.intelligence, 'premium');
});

test('explicit exclusions across all candidates yield no eligible result', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    excludeModelIds: candidates.map((c) => c.model),
  });
  assert.equal(result.ok, false);
  assert.equal(result.considered, candidates.length);
  const byProfile = resolveConstrainedDispatch(catalog, candidates, { excludeProfileIds: candidates.map((c) => c.profileId) });
  assert.equal(byProfile.ok, false);
  const byProvider = resolveConstrainedDispatch(catalog, candidates, { excludeProviderIds: ['p'] });
  assert.equal(byProvider.ok, false);
});

test('local 31-day agent_turn_v1 speed overrides catalog default truthfully', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { expectedTps: 60 }, [{ provider: 'p', model: 'deepseek-v4.1-flash', tps: 99, sampleCount: 31, checkedAt: recentIso(5) }]);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'deepseek-v4.1-flash');
  assert.equal(result.selected.speed.source, 'local_31d');
  assert.equal(result.selected.speed.tps, 99);
  assert.equal(result.selected.speed.provider, 'p');
  assert.equal(result.selected.speed.model, 'deepseek-v4.1-flash');
  assert.equal(result.selected.speed.sampleCount, 31);
});

test('falls back to catalog_default speed when no local sample is provided', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {});
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'deepseek-v4-pro');
  assert.equal(result.selected.speed.source, 'catalog_default');
  assert.equal(result.selected.speed.tps, 5);
});

test('minimum TPS is a hard filter and expected TPS drives satisfaction ordering', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { expectedTps: 40, minimumTps: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'deepseek-v4.1-flash');
  assert.equal(result.selected.satisfaction, 1);
  const tooHigh = resolveConstrainedDispatch(catalog, candidates, { minimumTps: 60 });
  assert.equal(tooHigh.ok, false);
  assert.equal(tooHigh.reason, 'no-eligible-candidate');
});

test('deterministic ordering: same expected-speed group orders lower price before preference then identity', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const tied: DispatchCandidate[] = [
    ...candidates,
    { profileId: 'alt', client: 'c1', provider: 'p2', model: 'hunyuan-hy4-preview' },
  ];
  // Both deepseek-v4.1-flash (p, out 2) and hunyuan-hy4-preview (p2, out 2) have tps 50; identity tie-break favours p/deepseek-v4.1-flash.
  const result = resolveConstrainedDispatch(catalog, tied, { expectedTps: 40 }, [{ provider: 'p2', model: 'hunyuan-hy4-preview', tps: 50, sampleCount: 10, checkedAt: recentIso(5) }]);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'deepseek-v4.1-flash');
});

test('a premium floor is satisfied by the configured premium tier', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  // The configured tier is authoritative: the premium fixture is admitted at a
  // premium floor regardless of whether any evidence metadata is present.
  const result = resolveConstrainedDispatch(catalog, candidates, { intelligenceMin: 'premium' });
  assert.equal(result.ok, true);
  assert.equal(result.selected.model.intelligence, 'premium');
  assert.equal(result.considered, candidates.length);
});

test('compatibility normalizer accepts only the four current tiers and rejects frontier/legacy', () => {
  assert.equal(normalizeIntelligenceTier('low'), 'low');
  assert.equal(normalizeIntelligenceTier('mid'), 'mid');
  assert.equal(normalizeIntelligenceTier('high'), 'high');
  assert.equal(normalizeIntelligenceTier('premium'), 'premium');
  // The legacy 'frontier' alias is no longer collapsed to 'high'; it is rejected.
  assert.equal(normalizeIntelligenceTier('frontier'), undefined);
  assert.equal(normalizeIntelligenceTier(undefined), undefined);
  assert.equal(normalizeIntelligenceTier('legacy-unknown'), undefined);
});

test('low eligibility is satisfied by the configured tier', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates.filter((candidate) => candidate.model === 'hunyuan-hy3'), { intelligenceMin: 'low' });
  assert.equal(result.ok, true);
  assert.equal(result.selected.model.intelligence, 'low');
});

test('high dispatch is admitted by the configured high tier', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const high = resolveConstrainedDispatch(catalog, candidates.filter((candidate) => candidate.model === 'glm-5.3'), { intelligenceMin: 'high' });
  assert.equal(high.ok, true);
  assert.equal(high.selected.model.intelligence, 'high');
});

test('a high-tier model fails a premium minimum while a premium tier qualifies', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const highOnly: DispatchCandidate[] = [{ profileId: 'mid', client: 'c1', provider: 'p', model: 'glm-5.3' }];
  const high = resolveConstrainedDispatch(catalog, highOnly, { intelligenceMin: 'premium' });
  assert.equal(high.ok, false);
  assert.equal(high.reason, 'no-eligible-candidate');

  const premiumOnly: DispatchCandidate[] = [{ profileId: 'premium', client: 'c1', provider: 'p', model: 'claude-opus-5' }];
  const premium = resolveConstrainedDispatch(catalog, premiumOnly, { intelligenceMin: 'premium' });
  assert.equal(premium.ok, true);
  assert.equal(premium.selected.model.intelligence, 'premium');
  void candidates;
});

test('registerProvider rejects missing, null, and invalid intelligence atomically', () => {
  const catalog = new Catalog();
  const protocols = [{ protocol: 'openai_chat' as const, endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' as const }];
  const invalidModels: Array<[string, object]> = [
    ['missing', { pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', speed: speedFixture() }],
    ['null', { pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: null, speed: speedFixture() }],
    ['invalid', { pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'frontier', speed: speedFixture() }],
  ];
  for (const [providerID, model] of invalidModels) {
    assert.throws(
      () => registerProvider(catalog, {
        id: providerID, displayName: providerID, credentialResolver: 'managed',
        models: [{ ...model, canonicalModel: { id: 'glm-5.3', displayName: 'Bad Name' } } as ModelDefinition],
        protocols,
      }),
      new RegExp(`provider ${providerID} model glm-5.3.*intelligence`),
    );
    assert.equal(catalog.provider(providerID), undefined);
  }
  registerProvider(catalog, {
    id: 'valid', displayName: 'Valid', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(),
      id: 'glm-5.3', displayName: 'M', intelligence: 'mid',
      canonicalModel: { id: 'glm-5.3', displayName: 'Good Name' },
      speed: speedFixture(),
    }],
    protocols,
  });
  assert.ok(catalog.provider('valid'));
});

test('registerProvider rejects a model missing its required speed default', () => {
  const catalog = new Catalog();
  // ModelDefinition.speed is required: a model without a default speed must be
  // rejected at registration. No dispatch may ever fall back to a synthetic zero.
  assert.throws(
    () => registerProvider(catalog, {
      id: 'p', displayName: 'P', credentialResolver: 'managed',
      models: [{ id: 'glm-5.3', displayName: 'M', intelligence: 'mid' } as ModelDefinition],
      protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
    }),
    /speed/,
  );
});

test('registerProvider rejects non-positive, non-finite, and non-integer default speeds', () => {
  const catalog = new Catalog();
  const protocols = [{ protocol: 'openai_chat' as const, endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' as const }];
  const invalid = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5];
  for (const speed of invalid) {
    assert.throws(
      () => registerProvider(catalog, {
        id: 'p', displayName: 'P', credentialResolver: 'managed',
        models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed }],
        protocols,
      }),
      /speed/,
    );
  }
});

test('registerProvider validates shared canonical model identity atomically', () => {
  const catalog = new Catalog();
  const provider = (
    id: string,
    displayName: string,
    canonicalDisplayName: string,
    endpoint = `https://${id}.example/v1/chat/completions`,
  ) => ({
    id,
    displayName,
    credentialResolver: 'managed' as const,
    models: [{ pricing: pricingFixture(),
      id: 'grok-4.7',
      displayName: `${displayName} route`,
      intelligence: 'mid' as const,
      canonicalModel: { id: 'grok-4.7', displayName: canonicalDisplayName },
      speed: speedFixture(),
    }],
    protocols: [{ protocol: 'openai_chat' as const, endpoint, authScheme: 'bearer' as const }],
  });

  registerProvider(catalog, provider('first', 'First', 'Shared Model V1'));
  registerProvider(catalog, provider('second', 'Second', 'Shared Model V1'));
  assert.throws(
    () => registerProvider(catalog, provider('conflict', 'Conflict', 'Different Model')),
    /conflicting display names/,
  );
  assert.equal(catalog.provider('conflict'), undefined, 'a conflicting provider is not partially registered');

  // Validation after canonical metadata must also be atomic: the invalid HTTP
  // endpoint must not retain a staged display name for a later valid provider.
  assert.throws(
    () => registerProvider(catalog, {
      ...provider('invalid', 'Invalid', 'Shared Model V1', 'http://invalid.example/v1'),
      models: [{ pricing: pricingFixture(),
        id: 'glm-5.3',
        displayName: 'Other route',
        intelligence: 'mid',
        canonicalModel: { id: 'glm-5.3', displayName: 'Staged Bad Name' },
        speed: speedFixture(),
      }],
    }),
    /must use https/,
  );
  registerProvider(catalog, {
    ...provider('valid', 'Valid', 'Shared Model V1'),
    models: [{ pricing: pricingFixture(),
      id: 'glm-5.3',
      displayName: 'Other route',
      intelligence: 'mid',
      canonicalModel: { id: 'glm-5.3', displayName: 'Committed Good Name' },
      speed: speedFixture(),
    }],
  });
  assert.ok(catalog.provider('valid'));
});

test('registerProvider validates modelSpeedOverrides and exact canonical keys only', () => {
  const protocols = [{ protocol: 'openai_chat' as const, endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' as const }];
  const canonicalModel = { pricing: pricingFixture(), id: 'glm-5.3', displayName: 'GLM 5.3', intelligence: 'mid' as const, speed: speedFixture(40) };
  const register = (extra: object) => registerProvider(new Catalog(), {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [canonicalModel],
    protocols,
    ...extra,
  });

  // A valid override for the exact canonical model id is accepted.
  register({ modelSpeedOverrides: { 'glm-5.3': 90 } });

  // An alias key is not a canonical model id and is rejected.
  assert.throws(
    () => register({ modelAliases: { 'legacy-glm': 'glm-5.3' }, modelSpeedOverrides: { 'legacy-glm': 90 } }),
    /exact canonical model/,
  );
  // An unknown model key is rejected.
  assert.throws(
    () => register({ modelSpeedOverrides: { nope: 90 } }),
    /exact canonical model/,
  );
  // Override TPS must satisfy the same rules as a model default speed.
  assert.throws(
    () => register({ modelSpeedOverrides: { 'glm-5.3': 0 } }),
    /speed/,
  );
});

test('per-profile local 31-day samples are accepted individually with sample count', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const fastCheckedAt = recentIso(5);
  const midCheckedAt = recentIso(6);
  const fastOnly: DispatchCandidate[] = [{ profileId: 'fast', client: 'c1', provider: 'p', model: 'deepseek-v4.1-flash' }];
  const fastResult = resolveConstrainedDispatch(catalog, fastOnly, {}, [{ provider: 'p', model: 'deepseek-v4.1-flash', tps: 99, sampleCount: 31, checkedAt: fastCheckedAt }]);
  assert.equal(fastResult.ok, true);
  assert.equal(fastResult.selected.speed.source, 'local_31d');
  assert.equal(fastResult.selected.speed.tps, 99);
  assert.equal(fastResult.selected.speed.provider, 'p');
  assert.equal(fastResult.selected.speed.model, 'deepseek-v4.1-flash');
  assert.equal(fastResult.selected.speed.sampleCount, 31);
  assert.equal(fastResult.selected.speed.checkedAt, fastCheckedAt);

  const midOnly: DispatchCandidate[] = [{ profileId: 'mid', client: 'c1', provider: 'p', model: 'glm-5.3' }];
  const midResult = resolveConstrainedDispatch(catalog, midOnly, {}, [{ provider: 'p', model: 'glm-5.3', tps: 120, sampleCount: 20, checkedAt: midCheckedAt }]);
  assert.equal(midResult.ok, true);
  assert.equal(midResult.selected.speed.source, 'local_31d');
  assert.equal(midResult.selected.speed.tps, 120);
  assert.equal(midResult.selected.speed.provider, 'p');
  assert.equal(midResult.selected.speed.model, 'glm-5.3');
  assert.equal(midResult.selected.speed.sampleCount, 20);
  assert.equal(midResult.selected.speed.checkedAt, midCheckedAt);
});

function buildSpeedTierCatalog(): { catalog: Catalog; overrideModel: DispatchCandidate; defaultModel: DispatchCandidate } {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [
      { pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(30) },
      { pricing: pricingFixture(), id: 'glm-5.3-flash', displayName: 'N', intelligence: 'mid', speed: speedFixture(20) },
    ],
    modelSpeedOverrides: { 'glm-5.3': 60 },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  return {
    catalog,
    overrideModel: { profileId: 'p/glm-5.3:c1', client: 'c1', provider: 'p', model: 'glm-5.3' },
    defaultModel: { profileId: 'p/glm-5.3-flash:c1', client: 'c1', provider: 'p', model: 'glm-5.3-flash' },
  };
}

test('exact speed precedence is local_31d over provider_override over catalog_default', () => {
  const { catalog, overrideModel, defaultModel } = buildSpeedTierCatalog();

  // No local sample and no override for glm-5.3-flash: the required model default is used.
  const catalogDefault = resolveConstrainedDispatch(catalog, [defaultModel], {});
  assert.equal(catalogDefault.ok, true);
  assert.equal(catalogDefault.selected.speed.source, 'catalog_default');
  assert.equal(catalogDefault.selected.speed.tps, 20);

  // No local sample: the exact canonical provider override wins over the default.
  const providerOverride = resolveConstrainedDispatch(catalog, [overrideModel], {});
  assert.equal(providerOverride.ok, true);
  assert.equal(providerOverride.selected.speed.source, 'provider_override');
  assert.equal(providerOverride.selected.speed.tps, 60);

  // A usable exact-profile local sample outranks the provider override.
  const localSample = resolveConstrainedDispatch(catalog, [overrideModel], {}, [
    { provider: 'p', model: 'glm-5.3', tps: 90, sampleCount: 31, checkedAt: recentIso(3) },
  ]);
  assert.equal(localSample.ok, true);
  assert.equal(localSample.selected.speed.source, 'local_31d');
  assert.equal(localSample.selected.speed.tps, 90);
  assert.equal(localSample.selected.speed.provider, 'p');
  assert.equal(localSample.selected.speed.model, 'glm-5.3');
});

test('invalid local samples fall through to the canonical speed tiers', () => {
  const { catalog, overrideModel, defaultModel } = buildSpeedTierCatalog();
  const invalid: Array<{ tps: number; sampleCount: number; checkedAt: string }> = [
    { tps: 0, sampleCount: 31, checkedAt: '2026-09-07' },
    { tps: -5, sampleCount: 31, checkedAt: '2026-09-07' },
    { tps: Number.POSITIVE_INFINITY, sampleCount: 31, checkedAt: '2026-09-07' },
    { tps: Number.NaN, sampleCount: 31, checkedAt: '2026-09-07' },
    { tps: 90, sampleCount: 0, checkedAt: '2026-09-07' },
    { tps: 90, sampleCount: 1.5, checkedAt: '2026-09-07' },
    { tps: 90, sampleCount: 31, checkedAt: '' },
    { tps: 90, sampleCount: 31, checkedAt: '   ' },
  ];
  for (const sample of invalid) {
    // An unusable exact-profile sample is skipped; the provider override applies.
    const viaOverride = resolveConstrainedDispatch(catalog, [overrideModel], {}, [{ provider: 'p', model: 'glm-5.3', ...sample }]);
    assert.equal(viaOverride.ok, true);
    assert.equal(viaOverride.selected.speed.source, 'provider_override');
    assert.equal(viaOverride.selected.speed.tps, 60);

    // A model without an override falls through to its required default speed.
    const viaDefault = resolveConstrainedDispatch(catalog, [defaultModel], {}, [{ provider: 'p', model: 'glm-5.3-flash', ...sample }]);
    assert.equal(viaDefault.ok, true);
    assert.equal(viaDefault.selected.speed.source, 'catalog_default');
    assert.equal(viaDefault.selected.speed.tps, 20);
  }
});

test('exact provider/model local samples are isolated across models and stale samples fall through', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [
      { pricing: pricingFixture(), id: 'glm-5.3', displayName: 'GLM 5.3', intelligence: 'mid', speed: speedFixture(40) },
      { pricing: pricingFixture(), id: 'glm-5.3-flash', displayName: 'Other', intelligence: 'mid', speed: speedFixture(20) },
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const canonicalCandidate: DispatchCandidate = { profileId: 'glm-5.3:cc', client: 'c1', provider: 'p', model: 'glm-5.3' };
  const otherCandidate: DispatchCandidate = { profileId: 'glm-5.3-flash:cc', client: 'c1', provider: 'p', model: 'glm-5.3-flash' };
  const local = [
    { provider: 'p', model: 'glm-5.3', tps: 95, sampleCount: 10, checkedAt: recentIso(2) },
    { provider: 'p', model: 'glm-5.3-flash', tps: 0, sampleCount: 10, checkedAt: recentIso(2) },
  ];
  // The canonical candidate matches its own exact-provider/model sample.
  const viaCanonical = resolveConstrainedDispatch(catalog, [canonicalCandidate], {}, local);
  assert.equal(viaCanonical.ok, true);
  assert.equal(viaCanonical.selected.speed.source, 'local_31d');
  assert.equal(viaCanonical.selected.speed.tps, 95);
  // An invalid zero-TPS sample is skipped; another model's sample cannot replace it.
  const viaOther = resolveConstrainedDispatch(catalog, [otherCandidate], {}, local);
  assert.equal(viaOther.ok, true);
  assert.equal(viaOther.selected.speed.source, 'catalog_default');
  assert.equal(viaOther.selected.speed.tps, 20);
  // A stale (>31-day) local sample falls through to the model default speed.
  const stale = [
    { provider: 'p', model: 'glm-5.3', tps: 200, sampleCount: 10, checkedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() },
  ];
  const viaDefault = resolveConstrainedDispatch(catalog, [canonicalCandidate], {}, stale);
  assert.equal(viaDefault.ok, true);
  assert.equal(viaDefault.selected.speed.source, 'catalog_default');
  assert.equal(viaDefault.selected.speed.tps, 40);
});

test('strict dynamic-fast boundary is tps greater than 80, not 80', () => {
  assert.equal(isDynamicFast(80), false);
  assert.equal(isDynamicFast(80.0001), true);
  assert.equal(isDynamicFast(81), true);
  assert.equal(isDynamicFast(0), false);
  const { catalog, candidates } = buildDispatchCatalog();
  const fast80: DispatchCandidate[] = [{ profileId: 'f80', client: 'c1', provider: 'p', model: 'deepseek-v4.1-flash' }];
  const fast81: DispatchCandidate[] = [{ profileId: 'f81', client: 'c1', provider: 'p', model: 'glm-5.3' }];
  // Override speeds to exactly 80 and 81 for the boundary check.
  const local = [
    { provider: 'p', model: 'deepseek-v4.1-flash', tps: 80, sampleCount: 5, checkedAt: recentIso(5) },
    { provider: 'p', model: 'glm-5.3', tps: 81, sampleCount: 5, checkedAt: recentIso(5) },
  ];
  const result = resolveConstrainedDispatch(catalog, [...fast80, ...fast81], { minimumTps: 81 }, local);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'glm-5.3');
});

test('vision capability is a hard gate', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    requiredCapabilities: ['image'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'kimi-k2.8');
  assert.notEqual(result.selected.plan.model, 'qwen3.8-max');
});

test('same-speed-group lower price wins deterministically', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const subset: DispatchCandidate[] = [
    { profileId: 'textonly', client: 'c1', provider: 'p', model: 'qwen3.8-max' },
    { profileId: 'vision', client: 'c1', provider: 'p', model: 'kimi-k2.8' },
  ];
  const result = resolveConstrainedDispatch(catalog, subset, {
    expectedTps: 40,
  });
  // kimi-k2.6 (out 2) and kimi-k2.8 (out 4) both meet expectedTps 40; lower price wins.
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'qwen3.8-max');
});

test('combined capability and price constraints admit only compliant candidates', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    requiredCapabilities: ['image'],
    maxOutputUsdPerMillion: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'kimi-k2.8');
  assert.ok(result.selected.model.capabilities?.includes('image'));
  assert.ok((result.selected.model.pricing?.[2] ?? Infinity) <= 10);
});

test('canonical alias cannot bypass canonical model exclusion while glm-5.3-flash stays eligible', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    modelAliases: { 'legacy-glm': 'glm-5.3' },
    models: [
      { id: 'glm-5.3', displayName: 'GLM 5.3', intelligence: 'mid', speed: 50, pricing: [1, 1, 1] },
      { id: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash', intelligence: 'mid', speed: 50, pricing: [1, 1, 2] },
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const candidates: DispatchCandidate[] = [
    { profileId: 'legacy', client: 'c1', provider: 'p', model: 'legacy-glm' },
    { profileId: 'flash', client: 'c1', provider: 'p', model: 'glm-5.3-flash' },
  ];
  const result = resolveConstrainedDispatch(catalog, candidates, { excludeModelIds: ['glm-5.3'] }, []);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'glm-5.3-flash');
  assert.notEqual(result.selected.plan.model, 'glm-5.3');
  assert.notEqual(result.selected.plan.model, 'legacy-glm');
});

function buildDualRouteCatalog(): {
  catalog: Catalog;
  native: DispatchCandidate;
  codebuddyGateway: DispatchCandidate;
  grokGateway: DispatchCandidate;
} {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'claude', gatewayProtocols: ['anthropic_messages'] });
  catalog.registerClient({ id: 'codebuddy', gatewayProtocols: ['openai_chat'] });
  catalog.registerClient({ id: 'grok', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
    nativeClients: ['claude'],
    models: [{
      id: 'glm-5.3', displayName: 'M', intelligence: 'mid',
      speed: 30,
      pricing: [1, 1, 2],
    }],
    protocols: [
      { protocol: 'anthropic_messages', endpoint: 'https://api.vendor.example/v1/messages', authScheme: 'x-api-key' },
      { protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' },
    ],
  });
  return {
    catalog,
    native: { profileId: 'vendor/glm-5.3:cc', client: 'claude', provider: 'vendor', model: 'glm-5.3' },
    codebuddyGateway: { profileId: 'vendor/glm-5.3:cb', client: 'codebuddy', provider: 'vendor', model: 'glm-5.3' },
    grokGateway: { profileId: 'vendor/glm-5.3:gk', client: 'grok', provider: 'vendor', model: 'glm-5.3' },
  };
}

test('automatic dispatch collapses the same provider/model to the Catalog-native client after hard gates', () => {
  const { catalog, native, codebuddyGateway, grokGateway } = buildDualRouteCatalog();
  // The gateway and grok candidates are declared first; collapse must still pick
  // the eligible native claude plan as the single representative of vendor/glm-5.3.
  const result = resolveConstrainedDispatch(catalog, [grokGateway, codebuddyGateway, native], {});
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.client, 'claude');
  assert.equal(result.selected.plan.mode, 'native');
  assert.equal(result.selected.plan.provider, 'vendor');
  assert.equal(result.selected.plan.model, 'glm-5.3');
});

test('hard gates run before client collapse: an unusable native path falls back to the grok gateway', () => {
  const { catalog, native, codebuddyGateway, grokGateway } = buildDualRouteCatalog();
  // The exact provider/model local sample is shared identically by every client
  // of vendor/glm-5.3. With the shared sample above the floor, all clients pass the
  // speed gate and collapse picks the eligible native claude plan.
  const result = resolveConstrainedDispatch(catalog, [codebuddyGateway, grokGateway, native], { minimumTps: 60 }, [
    { provider: 'vendor', model: 'glm-5.3', tps: 90, sampleCount: 5, checkedAt: recentIso(5) },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.client, 'claude');
  assert.equal(result.selected.plan.mode, 'native');
  assert.equal(result.selected.speed.source, 'local_31d');
  assert.equal(result.selected.speed.tps, 90);

  // When the shared sample is below the floor, the same speed gate filters every
  // client of the model; client collapse cannot rescue any route.
  const tooSlow = resolveConstrainedDispatch(catalog, [codebuddyGateway, grokGateway, native], { minimumTps: 60 }, [
    { provider: 'vendor', model: 'glm-5.3', tps: 20, sampleCount: 5, checkedAt: recentIso(5) },
  ]);
  assert.equal(tooSlow.ok, false);
  assert.equal(tooSlow.reason, 'no-eligible-candidate');
});

test('with no native route the grok client beats claude for the same provider/model', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'claude', gatewayProtocols: ['anthropic_messages'] });
  catalog.registerClient({ id: 'grok', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
    models: [{
      id: 'glm-5.3', displayName: 'M', intelligence: 'mid',
      speed: 30,
      pricing: [1, 1, 2],
    }],
    protocols: [
      { protocol: 'anthropic_messages', endpoint: 'https://api.vendor.example/v1/messages', authScheme: 'x-api-key' },
      { protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' },
    ],
  });
  const claudeGateway: DispatchCandidate = { profileId: 'vendor/glm-5.3:cc', client: 'claude', provider: 'vendor', model: 'glm-5.3' };
  const grokGateway: DispatchCandidate = { profileId: 'vendor/glm-5.3:gk', client: 'grok', provider: 'vendor', model: 'glm-5.3' };
  const result = resolveConstrainedDispatch(catalog, [claudeGateway, grokGateway], {});
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.client, 'grok');
  assert.equal(result.selected.plan.mode, 'gateway');
});

test('automatic selection stays deterministic when candidate declaration order is reversed', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const forward = resolveConstrainedDispatch(catalog, candidates, { expectedTps: 40 });
  const backward = resolveConstrainedDispatch(catalog, [...candidates].reverse(), { expectedTps: 40 });
  assert.equal(forward.ok, true);
  assert.equal(backward.ok, true);
  assert.deepEqual(backward.selected.plan, forward.selected.plan);
});

test('every approved public client key round-trips through parse and format', () => {
  for (const [publicKey, client] of Object.entries(PUBLIC_CLIENT_KEYS)) {
    const input = `acme/model-x:${publicKey}`;
    const parsed = parseRunSyntax(input);
    assert.deepEqual(parsed, { client, provider: 'acme', model: 'model-x' });
    assert.equal(formatRunSyntax(parsed), input);
    assert.deepEqual(parseRunSyntax(formatRunSyntax(parsed)), parsed);
  }
});

test('model ids containing an additional slash split provider at the first slash only', () => {
  const input = 'acme/models/deepseek-v4:gk';
  assert.deepEqual(parseRunSyntax(input), { client: 'grok', provider: 'acme', model: 'models/deepseek-v4' });
  assert.equal(formatRunSyntax({ client: 'grok', provider: 'acme', model: 'models/deepseek-v4' }), input);
});

test('run syntax rejects malformed strings with precise errors', () => {
  const malformed: Array<[string, RegExp]> = [
    ['', /empty/],
    [' acme/model:cc', /whitespace/],
    ['acme/model :cc', /whitespace/],
    ['acme/model:cc\n', /whitespace/],
    ['acme', /"\//],
    ['acme:cc', /"\//],
    ['acme/model', /":"/],
    ['/model:cc', /provider/],
    ['acme/:cc', /model/],
    ['acme/model:', /client/],
    ['acme/model:cc:cc', /":"/],
  ];
  for (const [input, pattern] of malformed) {
    assert.throws(() => parseRunSyntax(input), pattern);
  }
});

test('OpenRouter free model variants round-trip without losing the suffix', () => {
  const input = 'openrouter/poolside/laguna-xs-2.1:free:oc';
  const parsed = parseRunSyntax(input);
  assert.deepEqual(parsed, { provider: 'openrouter', model: 'poolside/laguna-xs-2.1:free', client: 'opencode' });
  assert.equal(formatRunSyntax(parsed), input);
  assert.throws(() => parseRunSyntax('openrouter/model:free:paid:oc'));
});

test('unknown and alias-like client names are rejected as syntax', () => {
  assert.throws(() => parseRunSyntax('acme/model:fast'), /unknown client key/);
  assert.throws(() => parseRunSyntax('acme/model:claude'), /unknown client key/);
  // A bare profile/alias-like name is not run syntax at all: no provider separator.
  assert.throws(() => parseRunSyntax('fast'), /"\//);
  assert.throws(() => formatRunSyntax({ client: 'unknown', provider: 'acme', model: 'm' }), /unknown client/);
});

test('codex/gpt-6-astra:cc parses to the claude client yet still fails resolution', () => {
  assert.deepEqual(parseRunSyntax('codex/gpt-6-astra:cc'), {
    client: 'claude',
    provider: 'codex',
    model: 'gpt-6-astra',
  });
  const catalog = new Catalog();
  catalog.registerClient({ id: 'claude', gatewayProtocols: ['anthropic_messages'] });
  registerProvider(catalog, {
    id: 'codex', displayName: 'Codex', credentialResolver: 'codex',
    models: [{ pricing: pricingFixture(), id: 'gpt-6-astra', displayName: 'GPT-6 Astra', intelligence: 'mid', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://codex.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  // Parseable identity is not proof of compatibility: resolution fails closed.
  assert.throws(() => resolveRunSyntax(catalog, 'codex/gpt-6-astra:cc'), /cannot serve client claude/);
});

test('a compatible target resolves exactly through Catalog.resolveRun with no fallback', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'claude', gatewayProtocols: ['anthropic_messages'] });
  registerProvider(catalog, {
    id: 'anthropic', displayName: 'Anthropic', credentialResolver: 'claude',
    nativeClients: ['claude'],
    models: [{ pricing: pricingFixture(), id: 'claude-sonnet-5', displayName: 'Claude Sonnet 4', intelligence: 'mid', speed: speedFixture() }],
    protocols: [{ protocol: 'anthropic_messages', endpoint: 'https://api.anthropic.example/v1/messages', authScheme: 'x-api-key' }],
  });
  const viaSyntax = resolveRunSyntax(catalog, 'anthropic/claude-sonnet-5:cc');
  assert.equal(viaSyntax.mode, 'native');
  assert.deepEqual(viaSyntax, catalog.resolveRun('claude', 'anthropic', 'claude-sonnet-5'));
});

function buildTaskCatalog(): Catalog {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'claude', gatewayProtocols: ['anthropic_messages'], taskCapable: true });
  catalog.registerClient({ id: 'codebuddy', gatewayProtocols: ['openai_chat'], taskCapable: true });
  catalog.registerClient({ id: 'codex', gatewayProtocols: ['openai_responses'], taskCapable: true });
  catalog.registerClient({ id: 'dsh', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'anthropic-api', displayName: 'Anthropic', credentialResolver: 'managed',
    modelAliases: { 'sonnet-legacy': 'claude-sonnet-5' },
    models: [
      { pricing: pricingFixture(), id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', intelligence: 'mid', speed: speedFixture() },
      { pricing: pricingFixture(), id: 'claude-sonnet-5-5', displayName: 'Claude Task', taskOnly: true, intelligence: 'mid', speed: speedFixture() },
    ],
    protocols: [{ protocol: 'anthropic_messages', endpoint: 'https://api.anthropic.example/v1/messages', authScheme: 'x-api-key' }],
  });
  registerProvider(catalog, {
    id: 'vendor-api', displayName: 'Vendor', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(), id: 'hunyuan-hy3', displayName: 'M', intelligence: 'mid', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  return catalog;
}

test('task candidate enumeration is deterministic with canonical dynamic syntax keys', () => {
  const catalog = buildTaskCatalog();
  const first = catalog.enumerateTaskCandidates();
  const second = catalog.enumerateTaskCandidates();
  assert.deepEqual(second, first);
  assert.deepEqual(first.map((candidate) => candidate.profileId), [
    'anthropic-api/claude-sonnet-5-5:cc',
    'anthropic-api/claude-sonnet-5:cc',
    'vendor-api/hunyuan-hy3:cb',
  ]);
  for (const candidate of first) {
    const plan = catalog.resolveRun(candidate.client, candidate.provider, candidate.model);
    assert.equal(formatRunSyntax(plan), candidate.profileId);
  }
});

test('task candidate enumeration includes compatible taskOnly models', () => {
  const catalog = buildTaskCatalog();
  const keys = catalog.enumerateTaskCandidates().map((candidate) => candidate.profileId);
  assert.ok(keys.includes('anthropic-api/claude-sonnet-5-5:cc'));
  assert.ok(keys.includes('anthropic-api/claude-sonnet-5:cc'));
  // taskOnly hides the model from the public Gateway /models listing but not from Tasks.
  assert.ok(!catalog.listGatewayModels('anthropic_messages').some((entry) => entry.id === 'claude-sonnet-5-5'));
});

test('task candidate enumeration excludes parseable but non-task-capable dsh', () => {
  const catalog = buildTaskCatalog();
  const candidates = catalog.enumerateTaskCandidates();
  assert.ok(!candidates.some((candidate) => candidate.client === 'dsh'));
  assert.ok(!candidates.some((candidate) => candidate.profileId.endsWith(':dsh')));
  // dsh stays a parseable public key and a compatible gateway route; capability is separate.
  assert.equal(catalog.resolveRun('dsh', 'vendor-api', 'hunyuan-hy3').mode, 'gateway');
  assert.deepEqual(parseRunSyntax('vendor-api/hunyuan-hy3:dsh'), { client: 'dsh', provider: 'vendor-api', model: 'hunyuan-hy3' });
});

test('task candidate enumeration excludes incompatible client/provider pairs', () => {
  const catalog = buildTaskCatalog();
  const keys = catalog.enumerateTaskCandidates().map((candidate) => candidate.profileId);
  assert.ok(!keys.includes('vendor-api/hunyuan-hy3:cc'));
  assert.ok(!keys.some((key) => key.endsWith(':codex')));
  assert.throws(() => catalog.resolveRun('claude', 'vendor-api', 'hunyuan-hy3'), /cannot serve client claude/);
  assert.throws(() => catalog.resolveRun('codex', 'vendor-api', 'hunyuan-hy3'), /cannot serve client codex/);
});

test('client gateway provider boundaries reject protocol-compatible but unexecutable pairs', () => {
  const catalog = new Catalog();
  catalog.registerClient({
    id: 'grok',
    gatewayProtocols: ['openai_chat'],
    unsupportedGatewayProviders: ['codebuddy'],
    taskCapable: true,
  });
  registerProvider(catalog, {
    id: 'codebuddy', displayName: 'CodeBuddy', credentialResolver: 'codebuddy',
    models: [{ pricing: pricingFixture(), id: 'hunyuan-hy3', displayName: 'HY3', intelligence: 'mid', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://codebuddy.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.throws(() => catalog.resolveRun('grok', 'codebuddy', 'hunyuan-hy3'), /cannot serve client grok/);
  assert.ok(!catalog.enumerateTaskCandidates().some((candidate) => candidate.profileId === 'codebuddy/hunyuan-hy3:gk'));
});

test('client gateway provider boundaries reject duplicate declarations', () => {
  const catalog = new Catalog();
  assert.throws(
    () => catalog.registerClient({
      id: 'grok',
      gatewayProtocols: ['openai_chat'],
      unsupportedGatewayProviders: ['codebuddy', 'codebuddy'],
    }),
    /duplicate unsupported gateway provider codebuddy/,
  );
});

test('task candidate enumeration never emits model alias duplicates', () => {
  const catalog = buildTaskCatalog();
  const candidates = catalog.enumerateTaskCandidates();
  const aliased = candidates.filter((candidate) => candidate.model === 'sonnet-legacy');
  assert.deepEqual(aliased, []);
  const canonicalCount = candidates.filter((candidate) => candidate.model === 'claude-sonnet-5').length;
  assert.equal(canonicalCount, 1);
  assert.equal(new Set(candidates.map((candidate) => candidate.profileId)).size, candidates.length);
});

test('native web search is admitted only for a supported native client/provider pair', () => {
  const catalog = new Catalog();
  // Flagged native client whose nativeProvider matches the provider id.
  catalog.registerClient({ id: 'nsearch', nativeProvider: 'vendor', gatewayProtocols: ['openai_chat'], supportsNativeWebSearch: true });
  // Unmarked native client (flag absent) sharing the same nativeProvider.
  catalog.registerClient({ id: 'nplain', nativeProvider: 'vendor', gatewayProtocols: ['openai_chat'] });
  // Gateway-only client that claims the flag but whose nativeProvider is different.
  catalog.registerClient({ id: 'gwclaim', nativeProvider: 'other', gatewayProtocols: ['openai_chat'], supportsNativeWebSearch: true });
  registerProvider(catalog, {
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
    nativeClients: ['nsearch', 'nplain'],
    models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  registerProvider(catalog, {
    id: 'other', displayName: 'Other', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://other.example/v1/chat/completions', authScheme: 'bearer' }],
  });

  // Supported native pair: flag true AND provider === nativeProvider AND mode native.
  const supported = catalog.resolveRun('nsearch', 'vendor', 'glm-5.3');
  assert.equal(supported.mode, 'native');
  assert.equal(supported.supportsWebSearch, true);

  // Unmarked native client: never marked supported.
  assert.equal(catalog.resolveRun('nplain', 'vendor', 'glm-5.3').supportsWebSearch, undefined);

  // Gateway route from a flag-claiming client to a non-native provider: not supported.
  const gw = catalog.resolveRun('gwclaim', 'other', 'glm-5.3');
  assert.equal(gw.mode, 'gateway');
  assert.equal(gw.supportsWebSearch, undefined);

  // The same model reached through a non-native gateway client must not be trusted.
  const nonNativeGw = catalog.resolveRun('gwclaim', 'vendor', 'glm-5.3');
  assert.equal(nonNativeGw.supportsWebSearch, undefined);
});

test('requiresWebSearch filters unsupported combinations but keeps supported dispatch', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'nsearch', nativeProvider: 'vendor', gatewayProtocols: ['openai_chat'], supportsNativeWebSearch: true });
  catalog.registerClient({ id: 'gw', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
    nativeClients: ['nsearch'],
    models: [{ id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), pricing: [1, 1, 1] }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const nativeCand: DispatchCandidate = { profileId: 'vendor/glm-5.3:nsearch', client: 'nsearch', provider: 'vendor', model: 'glm-5.3' };
  const gwCand: DispatchCandidate = { profileId: 'vendor/glm-5.3:gw', client: 'gw', provider: 'vendor', model: 'glm-5.3' };

  // Without the requirement both are eligible; collapse prefers the native route.
  const noReq = resolveConstrainedDispatch(catalog, [gwCand, nativeCand], {});
  assert.equal(noReq.ok, true);
  assert.equal(noReq.selected.plan.client, 'nsearch');

  // With requiresWebSearch the unsupported gateway route is filtered out and the
  // supported native route is retained.
  const req = resolveConstrainedDispatch(catalog, [gwCand, nativeCand], { requiresWebSearch: true });
  assert.equal(req.ok, true);
  assert.equal(req.selected.plan.client, 'nsearch');
  assert.equal(req.selected.plan.supportsWebSearch, true);

  // requiresWebSearch with only an unsupported candidate fails closed.
  const onlyGw = resolveConstrainedDispatch(catalog, [gwCand], { requiresWebSearch: true });
  assert.equal(onlyGw.ok, false);
  assert.equal(onlyGw.reason, 'no-eligible-candidate');

  // A normal task (no requirement) is unaffected by the web search metadata.
  const normal = resolveConstrainedDispatch(catalog, [nativeCand], {});
  assert.equal(normal.ok, true);
  assert.equal(normal.selected.plan.model, 'glm-5.3');
});

// ---------------------------------------------------------------------------
// Thinking contract
// ---------------------------------------------------------------------------

function buildThinkingCatalog(levels?: readonly ReasoningEffort[]): Catalog {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), ...(levels === undefined ? {} : { reasoningEfforts: levels }) }],
    reasoningEffortMappings: {
      'glm-5.3': {
        c1: {
          ...Object.fromEntries((levels ?? []).filter(level => ['low', 'medium', 'high'].includes(level)).map(level => [level, { effort: level }])),
        },
      },
    },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  return catalog;
}

test('normalizeReasoningEffort rejects midium and unknown values', () => {
  assert.equal(normalizeReasoningEffort('midium'), undefined);
  assert.equal(normalizeReasoningEffort('medium'), 'medium');
  assert.equal(normalizeReasoningEffort('max'), 'max');
  assert.equal(normalizeReasoningEffort('ultra'), undefined);
  assert.equal(normalizeReasoningEffort(''), undefined);
  assert.equal(normalizeReasoningEffort(undefined), undefined);
});

test('diagnostic enumeration without an expectation carries no run effort', () => {
  // xhigh/max are declared but unmapped; high is the highest mapped level.
  const catalog = buildThinkingCatalog(['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(catalog.resolveRun('c1', 'p', 'glm-5.3'), {
    client: 'c1', provider: 'p', model: 'glm-5.3', mode: 'gateway', protocol: 'openai_chat',
    });
});

test('a requested level adapts to the smallest supported level at or above it', () => {
  // Medium and high are usable: a low request resolves medium, and
  // a request above the usable ceiling resolves the highest usable level.
  const catalog = buildThinkingCatalog(['medium', 'high']);
  assert.deepEqual(catalog.resolveRun('c1', 'p', 'glm-5.3', 'low'), {
    client: 'c1', provider: 'p', model: 'glm-5.3', mode: 'gateway', protocol: 'openai_chat',
    reasoningEffort: 'medium', clientReasoningEffort: 'medium',
  });
  // xhigh is a legal public level but is not usable here: it clamps to the
  // highest usable level rather than rejecting the request.
  const clamped = catalog.resolveRun('c1', 'p', 'glm-5.3', 'xhigh');
  assert.equal(clamped.reasoningEffort, 'high');
  assert.equal(clamped.clientReasoningEffort, 'high');
});

test('a request above the mapped maximum clamps to the highest usable level', () => {
  // low/high/max are declared, but only low and high are mapped: max is unusable.
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), reasoningEfforts: ['low', 'high', 'max'] }],
    reasoningEffortMappings: {
      'glm-5.3': { c1: { low: { effort: 'low' }, high: { effort: 'high' } } },
    },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const max = catalog.resolveRun('c1', 'p', 'glm-5.3', 'max');
  assert.equal(max.reasoningEffort, 'high');
  assert.equal(max.clientReasoningEffort, 'high');
  // Diagnostic enumeration does not select an operational effort.
  assert.equal(catalog.resolveRun('c1', 'p', 'glm-5.3').reasoningEffort, undefined);
});

test('declaration order never decides the selected level', () => {
  // The declared array is unordered relative to the shared effort order; the selection
  // must still pick by order (ceiling of a low request), not by declaration.
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), reasoningEfforts: ['high', 'low', 'medium'] }],
    reasoningEffortMappings: {
      'glm-5.3': { c1: { low: { effort: 'low' }, medium: { effort: 'medium' }, high: { effort: 'high' } } },
    },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.equal(catalog.resolveRun('c1', 'p', 'glm-5.3', 'low').reasoningEffort, 'low');
  assert.equal(catalog.resolveRun('c1', 'p', 'glm-5.3', 'xhigh').reasoningEffort, 'high');
});

test('a runtime with no exact client mapping is not dispatchable', () => {
  // Model with declared levels but no mappings at all: capability is unknown,
  // so no thinking and no transport is ever invented for any request.
  const unmapped = new Catalog();
  unmapped.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(unmapped, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), reasoningEfforts: ['low', 'high'] }],
    reasoningEffortMappings: {},
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.throws(() => unmapped.resolveRun('c1', 'p', 'glm-5.3', 'low'), /no reasoning-effort mapping/);

  // A model without any declared levels never carries thinking, even when the
  // client has a mapping for that model id.
  const plain = buildThinkingCatalog(undefined);
  assert.throws(() => plain.resolveRun('c1', 'p', 'glm-5.3', 'low'), /no reasoning-effort mapping/);
});

test('a client without an exact mapping for the model id gets no thinking', () => {
  // The mapping exists for c1 only; c2 has no exact-client entry, so the level
  // is unusable and no effort is invented.
  const catalog = buildThinkingCatalog(['low', 'medium', 'high']);
  catalog.registerClient({ id: 'c2', gatewayProtocols: ['openai_chat'] });
  assert.throws(() => catalog.resolveRun('c2', 'p', 'glm-5.3', 'high'), /no reasoning-effort mapping/);
});

test('an invalid public thinking enum value is still rejected', () => {
  const catalog = buildThinkingCatalog(['low', 'medium', 'high']);
  assert.throws(() => catalog.resolveRun('c1', 'p', 'glm-5.3', 'ultra' as never), /invalid reasoning effort/);
});

test('provider thinking mapping may substitute an upstream model and keeps the public model unchanged', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(), id: 'gpt-6-luna', displayName: 'Public M', intelligence: 'mid', speed: speedFixture(), reasoningEfforts: ['low', 'high'] }],
    reasoningEffortMappings: {
      'gpt-6-luna': {
        c1: {
          low: { model: 'upstream-low' },
          high: { model: 'upstream-high', effort: 'high' },
        },
      },
    },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const plan = catalog.resolveRun('c1', 'p', 'gpt-6-luna', 'high');
  assert.equal(plan.model, 'gpt-6-luna');
  assert.equal(plan.reasoningEffort, 'high');
  assert.equal(plan.upstreamModel, 'upstream-high');
  assert.equal(plan.clientReasoningEffort, 'high');
  // An explicit model-only variant propagates the substitution without effort.
  const low = catalog.resolveRun('c1', 'p', 'gpt-6-luna', 'low');
  assert.equal(low.model, 'gpt-6-luna');
  assert.equal(low.upstreamModel, 'upstream-low');
  assert.equal(low.clientReasoningEffort, undefined);
  assert.equal(low.reasoningEffort, 'low');
});

test('independent thinking resolutions never mutate each other or the registered model', () => {
  const catalog = buildThinkingCatalog(['low', 'medium', 'high']);
  const first = catalog.resolveRun('c1', 'p', 'glm-5.3', 'low');
  const second = catalog.resolveRun('c1', 'p', 'glm-5.3', 'high');
  const third = catalog.resolveRun('c1', 'p', 'glm-5.3', 'high');
  assert.equal(first.reasoningEffort, 'low');
  assert.equal(second.reasoningEffort, 'high');
  assert.equal(third.reasoningEffort, 'high');
  // The declared model definition is untouched by resolution.
  assert.deepEqual(catalog.provider('p')?.models[0]?.reasoningEfforts, ['low', 'medium', 'high']);
  assert.equal(catalog.resolveRun('c1', 'p', 'glm-5.3', 'low').reasoningEffort, 'low');
});

test('registerProvider rejects invalid and duplicate thinking levels and bad mapping references', () => {
  const protocols = [{ protocol: 'openai_chat' as const, endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' as const }];
  const register = (extra: object, levels?: readonly unknown[]) => registerProvider(new Catalog(), {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [{ pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), ...(levels === undefined ? {} : { reasoningEfforts: levels as readonly ReasoningEffort[] }) }],
    protocols,
    ...extra,
  });

  // An empty ladder is a legal declaration: the route materializes no effort
  // level, so it is never rejected. Only malformed ladders are rejected.
  assert.throws(() => register({}, ['low', 'low']), /duplicate reasoning effort/);
  assert.throws(() => register({}, ['low', 'ultra']), /invalid reasoning effort/);
  // Mapping for an unknown model id is rejected.
  assert.throws(() => register({ reasoningEffortMappings: { nope: { c1: { low: { effort: 'low' } } } } }, ['low']), /exact declared model id/);
  // Mapping with an illegal level is rejected.
  assert.throws(() => register({ reasoningEffortMappings: { 'glm-5.3': { c1: { ultra: { effort: 'ultra' } } as never } } }, ['low']), /invalid reasoning effort/);
  // Mapping with an empty effort value is rejected.
  assert.throws(() => register({ reasoningEffortMappings: { 'glm-5.3': { c1: { low: { effort: '   ' } } } } }, ['low']), /effort must be a non-empty string/);
  // Mapping with an empty model value is rejected.
  assert.throws(() => register({ reasoningEffortMappings: { 'glm-5.3': { c1: { low: { model: '' } } } } }, ['low']), /model must be a non-empty string/);
  // A valid mapping registers.
  assert.doesNotThrow(() => register({ reasoningEffortMappings: { 'glm-5.3': { c1: { low: { effort: 'low' } } } } }, ['low']));
});

test('resolveConstrainedDispatch adapts requirements.reasoningEffort into the selected plan parameters', () => {
  const pricing = (out: number): ModelPricing => [1, 1, out];
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'], taskCapable: true });
  catalog.registerClient({ id: 'c2', gatewayProtocols: ['openai_chat'], taskCapable: true });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [
      { id: 'kimi-k3', displayName: 'Thinking', intelligence: 'mid', speed: speedFixture(), reasoningEfforts: ['low', 'high'], pricing: pricing(1) },
      { id: 'qwen3.8-max', displayName: 'Plain', intelligence: 'mid', speed: speedFixture(), pricing: pricing(2) },
    ],
    reasoningEffortMappings: {
      'qwen3.8-max': { c1: { none: { effort: 'none' } }, c2: { none: { effort: 'none' } } },
      'kimi-k3': {
        c1: { low: { effort: 'low' }, high: { effort: 'high' } },
        // c2 explicitly only supports low; a high request must adapt to low.
        c2: { low: { effort: 'low' } },
      },
    },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const candidates: DispatchCandidate[] = ['c1', 'c2'].flatMap(client => ['kimi-k3', 'qwen3.8-max'].map(model => ({profileId: `${client}-${model}`, client, provider: 'p', model})));
  const high = resolveConstrainedDispatch(catalog, candidates, { expectedReasoningEffort: 'high' });
  assert.equal(high.ok, true);
  assert.equal(high.selected.plan.model, 'kimi-k3');
  assert.equal(high.selected.plan.client, 'c1');
  // The selected runtime parameter reflects the adapted level and its mapping.
  assert.equal(high.selected.plan.reasoningEffort, 'high');
  assert.equal(high.selected.plan.clientReasoningEffort, 'high');
  assert.deepEqual(high.selected.plan, catalog.resolveRun('c1', 'p', 'kimi-k3', 'high'));

  // With no explicit request the plain model has no thinking capability and the
  // thinking model defaults to its highest mapped level.
  const auto = resolveConstrainedDispatch(catalog, candidates, {});
  assert.equal(auto.ok, true);
  assert.equal(auto.selected.plan.reasoningEffort, undefined);

  // A request against a model with no usable level at all is still eligible:
  // the resolution is selected and simply carries no invented wire effort.
  const plain = resolveConstrainedDispatch(catalog, [{ profileId: 'plain', client: 'c1', provider: 'p', model: 'qwen3.8-max' }], { expectedReasoningEffort: 'low' });
  assert.equal(plain.ok, true);
  assert.equal(plain.selected.plan.model, 'qwen3.8-max');
  assert.equal(plain.selected.plan.reasoningEffort, 'none');
  assert.equal(plain.selected.plan.clientReasoningEffort, 'none');
});

test('thinking never changes candidate ranking or admission', () => {
  // Two models differ only in how they map the requested level: glm-5.3-flash clamps a
  // low request to medium, grok-4.7 honors it exactly. Ranking is price-first,
  // so the thinking request must not reorder them and the winner's downstream
  // mapping must remain its own.
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'], taskCapable: true });
  const pricing = (out: number): ModelPricing => [1, 1, out];
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [
      { id: 'glm-5.3-flash', displayName: 'Cheap', intelligence: 'mid', speed: speedFixture(), reasoningEfforts: ['medium', 'high'], pricing: pricing(1) },
      { id: 'grok-4.7', displayName: 'Expensive', intelligence: 'mid', speed: speedFixture(), reasoningEfforts: ['low', 'high'], pricing: pricing(3) },
    ],
    reasoningEffortMappings: {
      'glm-5.3-flash': { c1: { medium: { effort: 'medium' }, high: { effort: 'high' } } },
      'grok-4.7': { c1: { low: { effort: 'low' }, high: { effort: 'high' } } },
    },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const candidates: DispatchCandidate[] = [
    { profileId: 'cheap', client: 'c1', provider: 'p', model: 'glm-5.3-flash' },
    { profileId: 'expensive', client: 'c1', provider: 'p', model: 'grok-4.7' },
  ];

  const withoutThinking = resolveConstrainedDispatch(catalog, candidates, {});
  const withLow = resolveConstrainedDispatch(catalog, candidates, { expectedReasoningEffort: 'low' });
  const withHigh = resolveConstrainedDispatch(catalog, candidates, { expectedReasoningEffort: 'high' });

  assert.equal(withoutThinking.ok, true);
  assert.equal(withLow.ok, true);
  assert.equal(withHigh.ok, true);
  // Eligibility and ranking are identical across thinking requests.
  assert.equal(withLow.selected.plan.provider, withoutThinking.selected.plan.provider);
  assert.equal(withLow.selected.plan.model, withoutThinking.selected.plan.model);
  assert.equal(withHigh.selected.plan.model, withoutThinking.selected.plan.model);
  assert.equal(withLow.selected.rank, withoutThinking.selected.rank);
  // Only the selected plan's runtime parameters change, via its own mapping.
  assert.equal(withoutThinking.selected.plan.reasoningEffort, undefined);
  assert.equal(withLow.selected.plan.reasoningEffort, 'medium');
  assert.equal(withLow.selected.plan.clientReasoningEffort, 'medium');
  assert.equal(withHigh.selected.plan.reasoningEffort, 'high');
  assert.equal(withHigh.selected.plan.clientReasoningEffort, 'high');
});

test('gateway model listing includes reasoningEfforts', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  registerProvider(catalog, {
    id: 'p', displayName: 'P', credentialResolver: 'managed',
    models: [
      { pricing: pricingFixture(), id: 'glm-5.3', displayName: 'M', intelligence: 'mid', speed: speedFixture(), reasoningEfforts: ['low', 'medium'] },
      { pricing: pricingFixture(), id: 'glm-5.3-flash', displayName: 'N', intelligence: 'mid', speed: speedFixture() },
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const listed = catalog.listGatewayModels('openai_chat');
  assert.deepEqual(listed.find((entry) => entry.id === 'glm-5.3')?.reasoningEfforts, ['low', 'medium']);
  assert.deepEqual(listed.find((entry) => entry.id === 'glm-5.3-flash')?.reasoningEfforts, ['none']);
});
