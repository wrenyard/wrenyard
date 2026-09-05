import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Catalog,
  resolveConstrainedDispatch,
  isDynamicFast,
  type DispatchCandidate,
  type ModelCapability,
  type TaskDispatchRequirements,
} from '../src/index.ts';

test('native routing wins over a shared gateway protocol', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'native', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    nativeClients: ['native'], models: [{ id: 'm', displayName: 'M' }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://example.com/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.equal(catalog.resolveRun('native', 'vendor', 'm').mode, 'native');
});

test('gateway models use provider/model ids and resolve to an exact dispatch plan', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'client', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    models: [{ id: 'm', displayName: 'M' }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://secret.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.equal(catalog.listGatewayModels('openai_chat')[0]?.publicId, 'vendor/m');
  assert.deepEqual(catalog.resolveRun('client', 'vendor', 'm'), {
    client: 'client', provider: 'vendor', model: 'm', mode: 'gateway', protocol: 'openai_chat',
  });
});

function buildDispatchCatalog(): { catalog: Catalog; candidates: DispatchCandidate[] } {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'c1', gatewayProtocols: ['openai_chat'] });
  const mk = (
    id: string,
    intelligence: undefined | 'low' | 'mid' | 'high' | 'frontier' | 'premium',
    tps: number,
    outUsd: number | undefined,
    capabilities: readonly ModelCapability[] = ['text'] as readonly ModelCapability[],
    withSpeed = true,
  ) => ({
    id, displayName: id, intelligence, capabilities,
    ...(withSpeed ? { speed: { tps, source: `benchmark-${id}`, checkedAt: '2026-09-05' } } : {}),
    ...(outUsd !== undefined
      ? { pricing: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: outUsd, source: 'spec', checkedAt: '2026-09-05' } }
      : {}),
  });
  catalog.registerProvider({
    id: 'p', displayName: 'P', credentialResolver: 'forge-managed',
    models: [
      mk('mfast', 'mid', 50, 2),
      mk('mpremium', 'premium', 20, 50, ['text'], true),
      mk('mmid', 'high', 30, 5),
      mk('mslow', 'mid', 5, 1),
      mk('mlow', 'low', 40, 3),
      mk('mnoprice', 'mid', 50, undefined),
      mk('mnointel', undefined, 50, 2),
      mk('mtextonly', 'mid', 50, 2, ['text']),
      mk('mvision', 'mid', 50, 4, ['text', 'image']),
      mk('mnospeed', 'mid', 0, 2, ['text'], false),
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
    { profileId: 'nospeed', client: 'c1', provider: 'p', model: 'mnospeed' },
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

test('intelligence range excludes below-min and above-max tiers', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { intelligenceMin: 'mid', intelligenceMax: 'high' });
  assert.equal(result.ok, true);
  assert.notEqual(result.selected.plan.model, 'mpremium');
  assert.notEqual(result.selected.plan.model, 'mlow');
  const intel = result.selected.model.intelligence;
  assert.ok(intel === 'mid' || intel === 'high');
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

test('preferred runtime cannot bypass a hard constraint', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    maxOutputUsdPerMillion: 4,
    preferredRuntime: { client: 'c1', provider: 'p', model: 'mpremium' },
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.selected.plan.model, 'mpremium');
  assert.ok((result.selected.model.pricing?.outputUsdPerMillion ?? Infinity) <= 4);
});

test('local 31-day agent_turn_v1 speed overrides catalog default truthfully', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { expectedTps: 60 }, [{ profileId: 'fast', tps: 99, sampleCount: 31, checkedAt: '2026-09-05' }]);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mfast');
  assert.equal(result.selected.speed.source, 'local_31d');
  assert.equal(result.selected.speed.tps, 99);
  assert.equal(result.selected.speed.profileId, 'fast');
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
  const result = resolveConstrainedDispatch(catalog, tied, { expectedTps: 40 }, [{ profileId: 'alt', tps: 50, sampleCount: 10, checkedAt: '2026-09-05' }]);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mfast');
});

test('no eligible candidate returns a structured failure for a genuinely impossible intelligence band', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, { intelligenceMin: 'frontier', intelligenceMax: 'frontier' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-eligible-candidate');
  assert.equal(result.considered, candidates.length);
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

test('missing speed metadata fails closed under a minimum-TPS requirement', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const onlyNoSpeed: DispatchCandidate[] = [{ profileId: 'nospeed', client: 'c1', provider: 'p', model: 'mnospeed' }];
  const result = resolveConstrainedDispatch(catalog, onlyNoSpeed, { minimumTps: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-eligible-candidate');
  void catalog;
  void candidates;
});

test('per-profile local 31-day samples are accepted individually with sample count', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const fastOnly: DispatchCandidate[] = [{ profileId: 'fast', client: 'c1', provider: 'p', model: 'mfast' }];
  const fastResult = resolveConstrainedDispatch(catalog, fastOnly, {}, [{ profileId: 'fast', tps: 99, sampleCount: 31, checkedAt: '2026-09-05' }]);
  assert.equal(fastResult.ok, true);
  assert.equal(fastResult.selected.speed.source, 'local_31d');
  assert.equal(fastResult.selected.speed.tps, 99);
  assert.equal(fastResult.selected.speed.profileId, 'fast');
  assert.equal(fastResult.selected.speed.sampleCount, 31);
  assert.equal(fastResult.selected.speed.checkedAt, '2026-09-05');

  const midOnly: DispatchCandidate[] = [{ profileId: 'mid', client: 'c1', provider: 'p', model: 'mmid' }];
  const midResult = resolveConstrainedDispatch(catalog, midOnly, {}, [{ profileId: 'mid', tps: 120, sampleCount: 20, checkedAt: '2026-09-04' }]);
  assert.equal(midResult.ok, true);
  assert.equal(midResult.selected.speed.source, 'local_31d');
  assert.equal(midResult.selected.speed.tps, 120);
  assert.equal(midResult.selected.speed.profileId, 'mid');
  assert.equal(midResult.selected.speed.sampleCount, 20);
  assert.equal(midResult.selected.speed.checkedAt, '2026-09-04');
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
    { profileId: 'f80', tps: 80, sampleCount: 5, checkedAt: '2026-09-05' },
    { profileId: 'f81', tps: 81, sampleCount: 5, checkedAt: '2026-09-05' },
  ];
  const result = resolveConstrainedDispatch(catalog, [...fast80, ...fast81], { minimumTps: 81 }, local);
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mmid');
});

test('vision capability is a hard gate that a preferred text-only candidate cannot bypass', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    requiredCapabilities: ['image'],
    preferredRuntime: { client: 'c1', provider: 'p', model: 'mtextonly' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mvision');
  assert.notEqual(result.selected.plan.model, 'mtextonly');
});

test('same-speed-group lower price wins before declared preference', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const subset: DispatchCandidate[] = [
    { profileId: 'textonly', client: 'c1', provider: 'p', model: 'mtextonly' },
    { profileId: 'vision', client: 'c1', provider: 'p', model: 'mvision' },
  ];
  const result = resolveConstrainedDispatch(catalog, subset, {
    expectedTps: 40,
    preferredRuntime: { client: 'c1', provider: 'p', model: 'mvision' },
  });
  // mtextonly (out 2) and mvision (out 4) both meet expectedTps 40; lower price wins.
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'mtextonly');
});

test('all fallbacks obey constraints when the preferred candidate is hard-filtered', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    requiredCapabilities: ['image'],
    maxOutputUsdPerMillion: 10,
    preferredRuntime: { client: 'c1', provider: 'p', model: 'mtextonly' },
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
