import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Catalog,
  resolveConstrainedDispatch,
  isDynamicFast,
  INTELLIGENCE_ORDER,
  normalizeIntelligenceTier,
  type DispatchCandidate,
  type IntelligenceTier,
  type ModelCapability,
  type ModelDefinition,
  type ModelSpeedMeta,
  type TaskDispatchRequirements,
  formatRunSyntax,
  parseRunSyntax,
  PUBLIC_CLIENT_KEYS,
  resolveRunSyntax,
} from '../src/index.ts';

function speedFixture(tps = 40, source = 'benchmark-fixture', checkedAt = '2026-09-05'): ModelSpeedMeta {
  return { tps, source, checkedAt };
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
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    nativeClients: ['native'], models: [{ id: 'm', displayName: 'M', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://example.com/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.equal(catalog.resolveRun('native', 'vendor', 'm').mode, 'native');
});

test('gateway models use provider/model ids and resolve to an exact dispatch plan', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'client', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    models: [{
      id: 'm',
      displayName: 'M',
      canonicalModel: { id: 'shared-m', displayName: 'Shared M' },
      speed: speedFixture(),
    }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://secret.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const gatewayModel = catalog.listGatewayModels('openai_chat')[0];
  assert.equal(gatewayModel?.publicId, 'vendor/m');
  assert.equal(gatewayModel && 'canonicalModel' in gatewayModel, false);
  assert.deepEqual(catalog.resolveRun('client', 'vendor', 'm'), {
    client: 'client', provider: 'vendor', model: 'm', mode: 'gateway', protocol: 'openai_chat',
  });
});

function buildDispatchCatalog(): { catalog: Catalog; candidates: DispatchCandidate[] } {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  const mk = (
    id: string,
    intelligence: undefined | 'low' | 'mid' | 'high' | 'premium',
    tps: number,
    outUsd: number | undefined,
    capabilities: readonly ModelCapability[] = ['text'] as readonly ModelCapability[],
  ) => ({
    id, displayName: id, intelligence, capabilities,
    speed: { tps, source: `benchmark-${id}`, checkedAt: '2026-09-05' },
    ...(outUsd !== undefined
      ? { pricing: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: outUsd, source: 'spec', checkedAt: '2026-09-05' } }
      : {}),
  });
  catalog.registerProvider({
    id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
    models: [
      mk('mfast', 'mid', 50, 2),
      mk('mpremium', 'premium', 20, 50, ['text']),
      mk('mmid', 'high', 30, 5),
      mk('mslow', 'mid', 5, 1),
      mk('mlow', 'low', 40, 3),
      mk('mnoprice', 'mid', 50, undefined),
      mk('mnointel', undefined, 50, 2),
      mk('mtextonly', 'mid', 50, 2, ['text']),
      mk('mvision', 'mid', 50, 4, ['text', 'image']),
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  catalog.registerProvider({
    id: 'p2', displayName: 'P2', credentialResolver: 'forge-managed',
    models: [mk('z', 'mid', 50, 2)],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p2.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const candidates: DispatchCandidate[] = [
    { profileId: 'fast', client: 'c1', provider: 'p', model: 'mfast' },
    { profileId: 'premium', client: 'c1', provider: 'p', model: 'mpremium' },
    { profileId: 'mid', client: 'c1', provider: 'p', model: 'mmid' },
    { profileId: 'slow', client: 'c1', provider: 'p', model: 'mslow' },
    { profileId: 'low', client: 'c1', provider: 'p', model: 'mlow' },
    { profileId: 'noprice', client: 'c1', provider: 'p', model: 'mnoprice' },
    { profileId: 'nointel', client: 'c1', provider: 'p', model: 'mnointel' },
    { profileId: 'textonly', client: 'c1', provider: 'p', model: 'mtextonly' },
    { profileId: 'vision', client: 'c1', provider: 'p', model: 'mvision' },
  ];
  return { catalog, candidates };
}

function buildEvidenceCatalog(): { catalog: Catalog; candidates: DispatchCandidate[] } {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  const mk = (
    id: string,
    intelligence: 'low' | 'mid' | 'high' | 'premium',
    provenance?: { source: string; checkedAt: string; score?: number },
  ) => ({
    id, displayName: id, intelligence,
    ...(provenance ? { intelligenceEvidence: provenance } : {}),
    speed: { tps: 50, source: 'bench-evidence', checkedAt: '2026-09-09' },
  });
  catalog.registerProvider({
    id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
    models: [
      mk('high-with-provenance', 'high', { source: 'https://aa.test/high', checkedAt: '2026-09-09', score: 44 }),
      mk('high-no-provenance', 'high'),
      mk('premium-no-provenance', 'premium'),
      mk('mid-with-provenance', 'mid', { source: 'https://aa.test/mid', checkedAt: '2026-09-09', score: 30 }),
      mk('low-no-provenance', 'low'),
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const candidates: DispatchCandidate[] = [
    { profileId: 'high-prov', client: 'c1', provider: 'p', model: 'high-with-provenance' },
    { profileId: 'high-bare', client: 'c1', provider: 'p', model: 'high-no-provenance' },
    { profileId: 'premium-bare', client: 'c1', provider: 'p', model: 'premium-no-provenance' },
    { profileId: 'mid-prov', client: 'c1', provider: 'p', model: 'mid-with-provenance' },
    { profileId: 'low-bare', client: 'c1', provider: 'p', model: 'low-no-provenance' },
  ];
  return { catalog, candidates };
}

test('hard max output price excludes over-budget candidates', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { maxOutputUsdPerMillion: 4 });
  assert.equal(result.ok, true);
  assert.notEqual(result.selected.plan.model, 'mpremium');
  assert.notEqual(result.selected.plan.model, 'mmid');
  assert.ok((result.selected.model.pricing?.outputUsdPerMillion ?? Infinity) <= 4);
  const none = resolveConstrainedDispatch(catalog, candidates, { maxOutputUsdPerMillion: 0.5 });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-eligible-candidate');
});

test('intelligence minimum excludes below-min tiers but admits any tier at or above it', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { intelligenceMin: 'mid' });
  assert.equal(result.ok, true);
  assert.notEqual(result.selected.plan.model, 'mlow');
  const intel = result.selected.model.intelligence;
  assert.ok(intel === 'mid' || intel === 'high' || intel === 'premium');
  // A premium candidate above the old high ceiling stays eligible: there is no
  // configurable maximum intelligence band.
  const premiumModel = catalog.provider('p')?.models.find(model => model.id === 'mpremium');
  assert.ok(premiumModel);
  const premium = resolveConstrainedDispatch(catalog, candidates.filter(candidate => candidate.model === 'mpremium'), { intelligenceMin: 'mid', intelligenceExpected: 'mid' });
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
  const result = resolveConstrainedDispatch(catalog, candidates, { expectedTps: 60 }, [{ provider: 'p', model: 'mfast', tps: 99, sampleCount: 31, checkedAt: recentIso(5) }]);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mfast');
  assert.equal(result.selected.speed.source, 'local_31d');
  assert.equal(result.selected.speed.tps, 99);
  assert.equal(result.selected.speed.provider, 'p');
  assert.equal(result.selected.speed.model, 'mfast');
  assert.equal(result.selected.speed.sampleCount, 31);
});

test('falls back to catalog_default speed when no local sample is provided', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {});
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mslow');
  assert.equal(result.selected.speed.source, 'catalog_default');
  assert.equal(result.selected.speed.tps, 5);
});

test('minimum TPS is a hard filter and expected TPS drives satisfaction ordering', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { expectedTps: 40, minimumTps: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mfast');
  assert.equal(result.selected.satisfaction, 1);
  const tooHigh = resolveConstrainedDispatch(catalog, candidates, { minimumTps: 60 });
  assert.equal(tooHigh.ok, false);
  assert.equal(tooHigh.reason, 'no-eligible-candidate');
});

test('deterministic ordering: same expected-speed group orders lower price before preference then identity', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const tied: DispatchCandidate[] = [
    ...candidates,
    { profileId: 'alt', client: 'c1', provider: 'p2', model: 'z' },
  ];
  // Both mfast (p, out 2) and z (p2, out 2) have tps 50; identity tie-break favours p/mfast.
  const result = resolveConstrainedDispatch(catalog, tied, { expectedTps: 40 }, [{ provider: 'p2', model: 'z', tps: 50, sampleCount: 10, checkedAt: recentIso(5) }]);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mfast');
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

test('intelligence order exposes exactly four current tiers and no frontier', () => {
  assert.deepEqual(Object.keys(INTELLIGENCE_ORDER), ['low', 'mid', 'high', 'premium']);
  assert.equal(INTELLIGENCE_ORDER.low, 0);
  assert.equal(INTELLIGENCE_ORDER.mid, 1);
  assert.equal(INTELLIGENCE_ORDER.high, 2);
  assert.equal(INTELLIGENCE_ORDER.premium, 3);
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

test('low eligibility is satisfied by the configured tier regardless of provenance', () => {
  const { catalog, candidates } = buildEvidenceCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates.filter((candidate) => candidate.model === 'low-no-provenance'), { intelligenceMin: 'low' });
  assert.equal(result.ok, true);
  // A low tier without any evidence metadata still qualifies.
  assert.equal(result.selected.model.intelligence, 'low');
});

test('high dispatch is admitted by the configured high tier with or without provenance', () => {
  const { catalog, candidates } = buildEvidenceCatalog();
  // Only the bare high candidate is offered: no evidence status field exists,
  // yet the configured high tier satisfies a high minimum.
  const bareHigh: DispatchCandidate[] = [{ profileId: 'high-bare', client: 'c1', provider: 'p', model: 'high-no-provenance' }];
  const bare = resolveConstrainedDispatch(catalog, bareHigh, { intelligenceMin: 'high' });
  assert.equal(bare.ok, true);
  assert.equal(bare.selected.model.intelligence, 'high');

  // A high candidate that carries optional provenance is equally admitted.
  const withProv: DispatchCandidate[] = [{ profileId: 'high-prov', client: 'c1', provider: 'p', model: 'high-with-provenance' }];
  const prov = resolveConstrainedDispatch(catalog, withProv, { intelligenceMin: 'high' });
  assert.equal(prov.ok, true);
  assert.equal(prov.selected.model.intelligence, 'high');
});

test('a high-tier model fails a premium minimum while a premium tier qualifies', () => {
  const { catalog, candidates } = buildEvidenceCatalog();
  const highOnly: DispatchCandidate[] = [{ profileId: 'high-bare', client: 'c1', provider: 'p', model: 'high-no-provenance' }];
  const high = resolveConstrainedDispatch(catalog, highOnly, { intelligenceMin: 'premium' });
  assert.equal(high.ok, false);
  assert.equal(high.reason, 'no-eligible-candidate');

  const premiumOnly: DispatchCandidate[] = [{ profileId: 'premium-bare', client: 'c1', provider: 'p', model: 'premium-no-provenance' }];
  const premium = resolveConstrainedDispatch(catalog, premiumOnly, { intelligenceMin: 'premium' });
  assert.equal(premium.ok, true);
  assert.equal(premium.selected.model.intelligence, 'premium');
  void candidates;
});

test('optional provenance never gates routing', () => {
  const { catalog } = buildEvidenceCatalog();
  // Same configured tier, one with provenance and one without: both resolve
  // exactly the same way because the evidence payload is descriptive only.
  const withProv = resolveConstrainedDispatch(catalog, [{ profileId: 'mid-prov', client: 'c1', provider: 'p', model: 'mid-with-provenance' }], { intelligenceMin: 'mid' });
  const bare = resolveConstrainedDispatch(catalog, [{ profileId: 'mid-bare', client: 'c1', provider: 'p', model: 'high-no-provenance' }], { intelligenceMin: 'high' });
  assert.equal(withProv.ok, true);
  assert.equal(bare.ok, true);
  assert.equal(catalog.provider('p')!.models.find(m => m.id === 'mid-with-provenance')!.intelligenceEvidence?.score, 30);
  assert.equal(catalog.provider('p')!.models.find(m => m.id === 'high-no-provenance')!.intelligenceEvidence, undefined);
});

test('missing price metadata fails closed under a max-output-price requirement', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  // mnoprice has no pricing; even though it would be the only candidate, it is excluded.
  const onlyNoPrice: DispatchCandidate[] = [{ profileId: 'noprice', client: 'c1', provider: 'p', model: 'mnoprice' }];
  const result = resolveConstrainedDispatch(catalog, onlyNoPrice, { maxOutputUsdPerMillion: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-eligible-candidate');
  void candidates;
  void catalog;
});

test('missing intelligence metadata fails closed under an intelligence requirement', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const onlyNoIntel: DispatchCandidate[] = [{ profileId: 'nointel', client: 'c1', provider: 'p', model: 'mnointel' }];
  const result = resolveConstrainedDispatch(catalog, onlyNoIntel, { intelligenceMin: 'mid' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-eligible-candidate');
  void catalog;
  void candidates;
});

test('registerProvider rejects a model missing its required speed default', () => {
  const catalog = new Catalog();
  // ModelDefinition.speed is required: a model without a default speed must be
  // rejected at registration. No dispatch may ever fall back to a synthetic zero.
  assert.throws(
    () => catalog.registerProvider({
      id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
      models: [{ id: 'm', displayName: 'M' } as ModelDefinition],
      protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
    }),
    /speed/,
  );
});

test('registerProvider rejects non-positive, non-finite, and empty-evidence default speeds', () => {
  const catalog = new Catalog();
  const protocols = [{ protocol: 'openai_chat' as const, endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' as const }];
  const invalid: ModelSpeedMeta[] = [
    { tps: 0, source: 'bench', checkedAt: '2026-09-05' },
    { tps: -1, source: 'bench', checkedAt: '2026-09-05' },
    { tps: Number.NaN, source: 'bench', checkedAt: '2026-09-05' },
    { tps: Number.POSITIVE_INFINITY, source: 'bench', checkedAt: '2026-09-05' },
    { tps: 40, source: '', checkedAt: '2026-09-05' },
    { tps: 40, source: 'bench', checkedAt: '' },
    { tps: 40, source: '   ', checkedAt: '2026-09-05' },
    { tps: 40, source: 'bench', checkedAt: '   ' },
  ];
  for (const speed of invalid) {
    assert.throws(
      () => catalog.registerProvider({
        id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
        models: [{ id: 'm', displayName: 'M', speed }],
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
    credentialResolver: 'forge-managed' as const,
    models: [{
      id: 'route-model',
      displayName: `${displayName} route`,
      canonicalModel: { id: 'shared-model-v1', displayName: canonicalDisplayName },
      speed: speedFixture(),
    }],
    protocols: [{ protocol: 'openai_chat' as const, endpoint, authScheme: 'bearer' as const }],
  });

  catalog.registerProvider(provider('first', 'First', 'Shared Model V1'));
  catalog.registerProvider(provider('second', 'Second', 'Shared Model V1'));
  assert.throws(
    () => catalog.registerProvider(provider('conflict', 'Conflict', 'Different Model')),
    /conflicting display names/,
  );
  assert.equal(catalog.provider('conflict'), undefined, 'a conflicting provider is not partially registered');

  // Validation after canonical metadata must also be atomic: the invalid HTTP
  // endpoint must not retain a staged display name for a later valid provider.
  assert.throws(
    () => catalog.registerProvider({
      ...provider('invalid', 'Invalid', 'Shared Model V1', 'http://invalid.example/v1'),
      models: [{
        id: 'other-route',
        displayName: 'Other route',
        canonicalModel: { id: 'atomic-model-v1', displayName: 'Staged Bad Name' },
        speed: speedFixture(),
      }],
    }),
    /must use https/,
  );
  catalog.registerProvider({
    ...provider('valid', 'Valid', 'Shared Model V1'),
    models: [{
      id: 'other-route',
      displayName: 'Other route',
      canonicalModel: { id: 'atomic-model-v1', displayName: 'Committed Good Name' },
      speed: speedFixture(),
    }],
  });
  assert.ok(catalog.provider('valid'));
});

test('registerProvider validates modelSpeedOverrides evidence and exact canonical keys only', () => {
  const protocols = [{ protocol: 'openai_chat' as const, endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' as const }];
  const canonicalModel = { id: 'glm-5.3', displayName: 'GLM 5.3', speed: speedFixture(40) };
  const register = (extra: object) => new Catalog().registerProvider({
    id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
    models: [canonicalModel],
    protocols,
    ...extra,
  });

  // A valid override for the exact canonical model id is accepted.
  register({ modelSpeedOverrides: { 'glm-5.3': { tps: 90, source: 'override-bench', checkedAt: '2026-09-06' } } });

  // An alias key is not a canonical model id and is rejected.
  assert.throws(
    () => register({ modelAliases: { 'legacy-glm': 'glm-5.3' }, modelSpeedOverrides: { 'legacy-glm': { tps: 90, source: 'override-bench', checkedAt: '2026-09-06' } } }),
    /exact canonical model/,
  );
  // An unknown model key is rejected.
  assert.throws(
    () => register({ modelSpeedOverrides: { nope: { tps: 90, source: 'override-bench', checkedAt: '2026-09-06' } } }),
    /exact canonical model/,
  );
  // Override evidence must satisfy the same rules as a model default speed.
  assert.throws(
    () => register({ modelSpeedOverrides: { 'glm-5.3': { tps: 0, source: 'override-bench', checkedAt: '2026-09-06' } } }),
    /speed/,
  );
  assert.throws(
    () => register({ modelSpeedOverrides: { 'glm-5.3': { tps: 90, source: '', checkedAt: '2026-09-06' } } }),
    /speed/,
  );
});

test('per-profile local 31-day samples are accepted individually with sample count', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const fastCheckedAt = recentIso(5);
  const midCheckedAt = recentIso(6);
  const fastOnly: DispatchCandidate[] = [{ profileId: 'fast', client: 'c1', provider: 'p', model: 'mfast' }];
  const fastResult = resolveConstrainedDispatch(catalog, fastOnly, {}, [{ provider: 'p', model: 'mfast', tps: 99, sampleCount: 31, checkedAt: fastCheckedAt }]);
  assert.equal(fastResult.ok, true);
  assert.equal(fastResult.selected.speed.source, 'local_31d');
  assert.equal(fastResult.selected.speed.tps, 99);
  assert.equal(fastResult.selected.speed.provider, 'p');
  assert.equal(fastResult.selected.speed.model, 'mfast');
  assert.equal(fastResult.selected.speed.sampleCount, 31);
  assert.equal(fastResult.selected.speed.checkedAt, fastCheckedAt);

  const midOnly: DispatchCandidate[] = [{ profileId: 'mid', client: 'c1', provider: 'p', model: 'mmid' }];
  const midResult = resolveConstrainedDispatch(catalog, midOnly, {}, [{ provider: 'p', model: 'mmid', tps: 120, sampleCount: 20, checkedAt: midCheckedAt }]);
  assert.equal(midResult.ok, true);
  assert.equal(midResult.selected.speed.source, 'local_31d');
  assert.equal(midResult.selected.speed.tps, 120);
  assert.equal(midResult.selected.speed.provider, 'p');
  assert.equal(midResult.selected.speed.model, 'mmid');
  assert.equal(midResult.selected.speed.sampleCount, 20);
  assert.equal(midResult.selected.speed.checkedAt, midCheckedAt);
});

function buildSpeedTierCatalog(): { catalog: Catalog; overrideModel: DispatchCandidate; defaultModel: DispatchCandidate } {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
    models: [
      { id: 'm', displayName: 'M', intelligence: 'mid', speed: speedFixture(30) },
      { id: 'n', displayName: 'N', intelligence: 'mid', speed: speedFixture(20) },
    ],
    modelSpeedOverrides: { m: { tps: 60, source: 'override-bench', checkedAt: '2026-09-06' } },
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  return {
    catalog,
    overrideModel: { profileId: 'p/m:c1', client: 'c1', provider: 'p', model: 'm' },
    defaultModel: { profileId: 'p/n:c1', client: 'c1', provider: 'p', model: 'n' },
  };
}

test('exact speed precedence is local_31d over provider_override over catalog_default', () => {
  const { catalog, overrideModel, defaultModel } = buildSpeedTierCatalog();

  // No local sample and no override for n: the required model default is used.
  const catalogDefault = resolveConstrainedDispatch(catalog, [defaultModel], {});
  assert.equal(catalogDefault.ok, true);
  assert.equal(catalogDefault.selected.speed.source, 'catalog_default');
  assert.equal(catalogDefault.selected.speed.tps, 20);

  // No local sample: the exact canonical provider override wins over the default.
  const providerOverride = resolveConstrainedDispatch(catalog, [overrideModel], {});
  assert.equal(providerOverride.ok, true);
  assert.equal(providerOverride.selected.speed.source, 'provider_override');
  assert.equal(providerOverride.selected.speed.tps, 60);
  assert.equal(providerOverride.selected.speed.checkedAt, '2026-09-06');

  // A usable exact-profile local sample outranks the provider override.
  const localSample = resolveConstrainedDispatch(catalog, [overrideModel], {}, [
    { provider: 'p', model: 'm', tps: 90, sampleCount: 31, checkedAt: recentIso(3) },
  ]);
  assert.equal(localSample.ok, true);
  assert.equal(localSample.selected.speed.source, 'local_31d');
  assert.equal(localSample.selected.speed.tps, 90);
  assert.equal(localSample.selected.speed.provider, 'p');
  assert.equal(localSample.selected.speed.model, 'm');
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
    const viaOverride = resolveConstrainedDispatch(catalog, [overrideModel], {}, [{ provider: 'p', model: 'm', ...sample }]);
    assert.equal(viaOverride.ok, true);
    assert.equal(viaOverride.selected.speed.source, 'provider_override');
    assert.equal(viaOverride.selected.speed.tps, 60);

    // A model without an override falls through to its required default speed.
    const viaDefault = resolveConstrainedDispatch(catalog, [defaultModel], {}, [{ provider: 'p', model: 'n', ...sample }]);
    assert.equal(viaDefault.ok, true);
    assert.equal(viaDefault.selected.speed.source, 'catalog_default');
    assert.equal(viaDefault.selected.speed.tps, 20);
  }
});

test('exact provider/model local samples are isolated across models and stale samples fall through', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
    models: [
      { id: 'glm-5.3', displayName: 'GLM 5.3', intelligence: 'mid', speed: speedFixture(40) },
      { id: 'other', displayName: 'Other', intelligence: 'mid', speed: speedFixture(20) },
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const canonicalCandidate: DispatchCandidate = { profileId: 'glm-5.3:cc', client: 'c1', provider: 'p', model: 'glm-5.3' };
  const otherCandidate: DispatchCandidate = { profileId: 'other:cc', client: 'c1', provider: 'p', model: 'other' };
  const local = [
    { provider: 'p', model: 'glm-5.3', tps: 95, sampleCount: 10, checkedAt: recentIso(2) },
    { provider: 'p', model: 'other', tps: 0, sampleCount: 10, checkedAt: recentIso(2) },
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
  const fast80: DispatchCandidate[] = [{ profileId: 'f80', client: 'c1', provider: 'p', model: 'mfast' }];
  const fast81: DispatchCandidate[] = [{ profileId: 'f81', client: 'c1', provider: 'p', model: 'mmid' }];
  // Override speeds to exactly 80 and 81 for the boundary check.
  const local = [
    { provider: 'p', model: 'mfast', tps: 80, sampleCount: 5, checkedAt: recentIso(5) },
    { provider: 'p', model: 'mmid', tps: 81, sampleCount: 5, checkedAt: recentIso(5) },
  ];
  const result = resolveConstrainedDispatch(catalog, [...fast80, ...fast81], { minimumTps: 81 }, local);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mmid');
});

test('vision capability is a hard gate', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    requiredCapabilities: ['image'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mvision');
  assert.notEqual(result.selected.plan.model, 'mtextonly');
});

test('same-speed-group lower price wins deterministically', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const subset: DispatchCandidate[] = [
    { profileId: 'textonly', client: 'c1', provider: 'p', model: 'mtextonly' },
    { profileId: 'vision', client: 'c1', provider: 'p', model: 'mvision' },
  ];
  const result = resolveConstrainedDispatch(catalog, subset, {
    expectedTps: 40,
  });
  // mtextonly (out 2) and mvision (out 4) both meet expectedTps 40; lower price wins.
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mtextonly');
});

test('combined capability and price constraints admit only compliant candidates', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    requiredCapabilities: ['image'],
    maxOutputUsdPerMillion: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mvision');
  assert.ok(result.selected.model.capabilities?.includes('image'));
  assert.ok((result.selected.model.pricing?.outputUsdPerMillion ?? Infinity) <= 10);
});

test('canonical alias cannot bypass canonical model exclusion while GLM-5.3-Flash stays eligible', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
    modelAliases: { 'legacy-glm': 'glm-5.3' },
    models: [
      { id: 'glm-5.3', displayName: 'GLM 5.3', intelligence: 'mid', speed: { tps: 50, source: 'b', checkedAt: '2026-09-05' }, pricing: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 1, source: 'spec', checkedAt: '2026-09-05' } },
      { id: 'GLM-5.3-Flash', displayName: 'GLM 5.3 Flash', intelligence: 'mid', speed: { tps: 50, source: 'b', checkedAt: '2026-09-05' }, pricing: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 2, source: 'spec', checkedAt: '2026-09-05' } },
    ],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://p.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const candidates: DispatchCandidate[] = [
    { profileId: 'legacy', client: 'c1', provider: 'p', model: 'legacy-glm' },
    { profileId: 'flash', client: 'c1', provider: 'p', model: 'GLM-5.3-Flash' },
  ];
  const result = resolveConstrainedDispatch(catalog, candidates, { excludeModelIds: ['glm-5.3'] }, []);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'GLM-5.3-Flash');
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
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    nativeClients: ['claude'],
    models: [{
      id: 'm', displayName: 'M', intelligence: 'mid',
      speed: { tps: 30, source: 'bench', checkedAt: '2026-09-05' },
      pricing: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 2, source: 'spec', checkedAt: '2026-09-05' },
    }],
    protocols: [
      { protocol: 'anthropic_messages', endpoint: 'https://api.vendor.example/v1/messages', authScheme: 'x-api-key' },
      { protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' },
    ],
  });
  return {
    catalog,
    native: { profileId: 'vendor/m:cc', client: 'claude', provider: 'vendor', model: 'm' },
    codebuddyGateway: { profileId: 'vendor/m:cb', client: 'codebuddy', provider: 'vendor', model: 'm' },
    grokGateway: { profileId: 'vendor/m:gk', client: 'grok', provider: 'vendor', model: 'm' },
  };
}

test('automatic dispatch collapses the same provider/model to the Catalog-native client after hard gates', () => {
  const { catalog, native, codebuddyGateway, grokGateway } = buildDualRouteCatalog();
  // The gateway and grok candidates are declared first; collapse must still pick
  // the eligible native claude plan as the single representative of vendor/m.
  const result = resolveConstrainedDispatch(catalog, [grokGateway, codebuddyGateway, native], {});
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.client, 'claude');
  assert.equal(result.selected.plan.mode, 'native');
  assert.equal(result.selected.plan.provider, 'vendor');
  assert.equal(result.selected.plan.model, 'm');
});

test('hard gates run before client collapse: an unusable native path falls back to the grok gateway', () => {
  const { catalog, native, codebuddyGateway, grokGateway } = buildDualRouteCatalog();
  // The exact provider/model local sample is shared identically by every client
  // of vendor/m. With the shared sample above the floor, all clients pass the
  // speed gate and collapse picks the eligible native claude plan.
  const result = resolveConstrainedDispatch(catalog, [codebuddyGateway, grokGateway, native], { minimumTps: 60 }, [
    { provider: 'vendor', model: 'm', tps: 90, sampleCount: 5, checkedAt: recentIso(5) },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.client, 'claude');
  assert.equal(result.selected.plan.mode, 'native');
  assert.equal(result.selected.speed.source, 'local_31d');
  assert.equal(result.selected.speed.tps, 90);

  // When the shared sample is below the floor, the same speed gate filters every
  // client of the model; client collapse cannot rescue any route.
  const tooSlow = resolveConstrainedDispatch(catalog, [codebuddyGateway, grokGateway, native], { minimumTps: 60 }, [
    { provider: 'vendor', model: 'm', tps: 20, sampleCount: 5, checkedAt: recentIso(5) },
  ]);
  assert.equal(tooSlow.ok, false);
  assert.equal(tooSlow.reason, 'no-eligible-candidate');
});

test('with no native route the grok client beats claude for the same provider/model', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'claude', gatewayProtocols: ['anthropic_messages'] });
  catalog.registerClient({ id: 'grok', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    models: [{
      id: 'm', displayName: 'M', intelligence: 'mid',
      speed: { tps: 30, source: 'bench', checkedAt: '2026-09-05' },
      pricing: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 2, source: 'spec', checkedAt: '2026-09-05' },
    }],
    protocols: [
      { protocol: 'anthropic_messages', endpoint: 'https://api.vendor.example/v1/messages', authScheme: 'x-api-key' },
      { protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' },
    ],
  });
  const claudeGateway: DispatchCandidate = { profileId: 'vendor/m:cc', client: 'claude', provider: 'vendor', model: 'm' };
  const grokGateway: DispatchCandidate = { profileId: 'vendor/m:gk', client: 'grok', provider: 'vendor', model: 'm' };
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
  catalog.registerProvider({
    id: 'codex', displayName: 'Codex', credentialResolver: 'codex',
    models: [{ id: 'gpt-6-astra', displayName: 'GPT-6 Astra', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://codex.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  // Parseable identity is not proof of compatibility: resolution fails closed.
  assert.throws(() => resolveRunSyntax(catalog, 'codex/gpt-6-astra:cc'), /cannot serve client claude/);
});

test('a compatible target resolves exactly through Catalog.resolveRun with no fallback', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'claude', gatewayProtocols: ['anthropic_messages'] });
  catalog.registerProvider({
    id: 'anthropic', displayName: 'Anthropic', credentialResolver: 'claude',
    nativeClients: ['claude'],
    models: [{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4', speed: speedFixture() }],
    protocols: [{ protocol: 'anthropic_messages', endpoint: 'https://api.anthropic.example/v1/messages', authScheme: 'x-api-key' }],
  });
  const viaSyntax = resolveRunSyntax(catalog, 'anthropic/claude-sonnet-4:cc');
  assert.equal(viaSyntax.mode, 'native');
  assert.deepEqual(viaSyntax, catalog.resolveRun('claude', 'anthropic', 'claude-sonnet-4'));
});

function buildTaskCatalog(): Catalog {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'claude', gatewayProtocols: ['anthropic_messages'], taskCapable: true });
  catalog.registerClient({ id: 'codebuddy', gatewayProtocols: ['openai_chat'], taskCapable: true });
  catalog.registerClient({ id: 'codex', gatewayProtocols: ['openai_responses'], taskCapable: true });
  catalog.registerClient({ id: 'dsh', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'anthropic-api', displayName: 'Anthropic', credentialResolver: 'forge-managed',
    modelAliases: { 'sonnet-legacy': 'claude-sonnet-5' },
    models: [
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', speed: speedFixture() },
      { id: 'claude-task', displayName: 'Claude Task', taskOnly: true, speed: speedFixture() },
    ],
    protocols: [{ protocol: 'anthropic_messages', endpoint: 'https://api.anthropic.example/v1/messages', authScheme: 'x-api-key' }],
  });
  catalog.registerProvider({
    id: 'vendor-api', displayName: 'Vendor', credentialResolver: 'forge-managed',
    models: [{ id: 'm', displayName: 'M', speed: speedFixture() }],
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
    'anthropic-api/claude-sonnet-5:cc',
    'anthropic-api/claude-task:cc',
    'vendor-api/m:cb',
  ]);
  for (const candidate of first) {
    const plan = catalog.resolveRun(candidate.client, candidate.provider, candidate.model);
    assert.equal(formatRunSyntax(plan), candidate.profileId);
  }
});

test('task candidate enumeration includes compatible taskOnly models', () => {
  const catalog = buildTaskCatalog();
  const keys = catalog.enumerateTaskCandidates().map((candidate) => candidate.profileId);
  assert.ok(keys.includes('anthropic-api/claude-task:cc'));
  assert.ok(keys.includes('anthropic-api/claude-sonnet-5:cc'));
  // taskOnly hides the model from the public Gateway /models listing but not from Tasks.
  assert.ok(!catalog.listGatewayModels('anthropic_messages').some((entry) => entry.id === 'claude-task'));
});

test('task candidate enumeration excludes parseable but non-task-capable dsh', () => {
  const catalog = buildTaskCatalog();
  const candidates = catalog.enumerateTaskCandidates();
  assert.ok(!candidates.some((candidate) => candidate.client === 'dsh'));
  assert.ok(!candidates.some((candidate) => candidate.profileId.endsWith(':dsh')));
  // dsh stays a parseable public key and a compatible gateway route; capability is separate.
  assert.equal(catalog.resolveRun('dsh', 'vendor-api', 'm').mode, 'gateway');
  assert.deepEqual(parseRunSyntax('vendor-api/m:dsh'), { client: 'dsh', provider: 'vendor-api', model: 'm' });
});

test('task candidate enumeration excludes incompatible client/provider pairs', () => {
  const catalog = buildTaskCatalog();
  const keys = catalog.enumerateTaskCandidates().map((candidate) => candidate.profileId);
  assert.ok(!keys.includes('vendor-api/m:cc'));
  assert.ok(!keys.some((key) => key.endsWith(':codex')));
  assert.throws(() => catalog.resolveRun('claude', 'vendor-api', 'm'), /cannot serve client claude/);
  assert.throws(() => catalog.resolveRun('codex', 'vendor-api', 'm'), /cannot serve client codex/);
});

test('client gateway provider boundaries reject protocol-compatible but unexecutable pairs', () => {
  const catalog = new Catalog();
  catalog.registerClient({
    id: 'grok',
    gatewayProtocols: ['openai_chat'],
    unsupportedGatewayProviders: ['codebuddy'],
    taskCapable: true,
  });
  catalog.registerProvider({
    id: 'codebuddy', displayName: 'CodeBuddy', credentialResolver: 'codebuddy',
    models: [{ id: 'hy3', displayName: 'HY3', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://codebuddy.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.throws(() => catalog.resolveRun('grok', 'codebuddy', 'hy3'), /cannot serve client grok/);
  assert.ok(!catalog.enumerateTaskCandidates().some((candidate) => candidate.profileId === 'codebuddy/hy3:gk'));
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
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    nativeClients: ['nsearch', 'nplain'],
    models: [{ id: 'm', displayName: 'M', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  catalog.registerProvider({
    id: 'other', displayName: 'Other', credentialResolver: 'forge-managed',
    models: [{ id: 'm', displayName: 'M', speed: speedFixture() }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://other.example/v1/chat/completions', authScheme: 'bearer' }],
  });

  // Supported native pair: flag true AND provider === nativeProvider AND mode native.
  const supported = catalog.resolveRun('nsearch', 'vendor', 'm');
  assert.equal(supported.mode, 'native');
  assert.equal(supported.supportsWebSearch, true);

  // Unmarked native client: never marked supported.
  assert.equal(catalog.resolveRun('nplain', 'vendor', 'm').supportsWebSearch, undefined);

  // Gateway route from a flag-claiming client to a non-native provider: not supported.
  const gw = catalog.resolveRun('gwclaim', 'other', 'm');
  assert.equal(gw.mode, 'gateway');
  assert.equal(gw.supportsWebSearch, undefined);

  // The same model reached through a non-native gateway client must not be trusted.
  const nonNativeGw = catalog.resolveRun('gwclaim', 'vendor', 'm');
  assert.equal(nonNativeGw.supportsWebSearch, undefined);
});

test('requiresWebSearch filters unsupported combinations but keeps supported dispatch', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'nsearch', nativeProvider: 'vendor', gatewayProtocols: ['openai_chat'], supportsNativeWebSearch: true });
  catalog.registerClient({ id: 'gw', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    nativeClients: ['nsearch'],
    models: [{ id: 'm', displayName: 'M', intelligence: 'mid', speed: speedFixture(), pricing: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 1, source: 'spec', checkedAt: '2026-09-05' } }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://vendor.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  const nativeCand: DispatchCandidate = { profileId: 'vendor/m:nsearch', client: 'nsearch', provider: 'vendor', model: 'm' };
  const gwCand: DispatchCandidate = { profileId: 'vendor/m:gw', client: 'gw', provider: 'vendor', model: 'm' };

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
  assert.equal(normal.selected.plan.model, 'm');
});
