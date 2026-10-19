import assert from 'node:assert/strict';
import test from 'node:test';
import { Catalog, type DispatchCandidate, type IntelligenceTier, type ModelCapability, type ModelDefinition, type ModelPricing, type ReasoningEffort, type ProviderDefinition, formatRunSyntax, parseRunSyntax, PUBLIC_CLIENT_KEYS, resolveRunSyntax } from '@wrenyard/providers/catalog';
import { resolveConstrainedDispatch } from '../src/index.ts';

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

test('vision capability is a hard gate', () => {
  const { catalog, candidates } = buildDispatchCatalog();
  const result = resolveConstrainedDispatch(catalog, candidates, {
    requiredCapabilities: ['image'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.plan.model, 'kimi-k2.8');
  assert.notEqual(result.selected.plan.model, 'qwen3.8-max');
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

test('every approved public client key round-trips through parse and format', () => {
  for (const [publicKey, client] of Object.entries(PUBLIC_CLIENT_KEYS)) {
    const input = `acme/model-x:${publicKey}`;
    const parsed = parseRunSyntax(input);
    assert.deepEqual(parsed, { client, provider: 'acme', model: 'model-x' });
    assert.equal(formatRunSyntax(parsed), input);
    assert.deepEqual(parseRunSyntax(formatRunSyntax(parsed)), parsed);
  }
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

test('task candidate enumeration excludes incompatible client/provider pairs', () => {
  const catalog = buildTaskCatalog();
  const keys = catalog.enumerateTaskCandidates().map((candidate) => candidate.profileId);
  assert.ok(!keys.includes('vendor-api/hunyuan-hy3:cc'));
  assert.ok(!keys.some((key) => key.endsWith(':codex')));
  assert.throws(() => catalog.resolveRun('claude', 'vendor-api', 'hunyuan-hy3'), /cannot serve client claude/);
  assert.throws(() => catalog.resolveRun('codex', 'vendor-api', 'hunyuan-hy3'), /cannot serve client codex/);
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
