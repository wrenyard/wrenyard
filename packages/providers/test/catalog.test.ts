import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_PROVIDERS,
  createBuiltinCatalog,
  deriveTaskDispatchPlans,
  isBuiltinClientGatewayProviderSupported,
} from '../src/index.ts';

test('CodeBuddy keeps native routing and exposes every confirmed gateway model', () => {
  const catalog = createBuiltinCatalog();
  assert.equal(catalog.resolveRun('codebuddy', 'codebuddy', 'deepseek-v4-flash').mode, 'native');
  const modelIds = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'hy4-preview',
    'hy3',
    'minimax-m3',
    'kimi-k3',
    'glm-5.3',
    'glm-5.3-flash',
  ];
  assert.deepEqual(
    catalog.listGatewayModels('openai_chat').filter((entry) => entry.provider === 'codebuddy').map((entry) => entry.id),
    modelIds,
  );
  for (const modelId of modelIds) {
    assert.equal(catalog.resolveRun('dsh', 'codebuddy', modelId).protocol, 'openai_chat');
    assert.equal(catalog.resolveGatewayModel('openai_chat', `codebuddy/${modelId}`).upstreamModel, modelId);
  }
  const legacy = catalog.resolveGatewayModel('openai_chat', 'codebuddy/hy4-preview-ioa');
  assert.equal(legacy.model.id, 'hy4-preview');
  assert.equal(legacy.publicId, 'codebuddy/hy4-preview');
  assert.throws(
    () => catalog.resolveRun('grok', 'codebuddy', 'hy3'),
    /provider codebuddy cannot serve client grok/,
    'Grok strict-SSE incompatibility is an exact run-combination boundary, not a protocol capability',
  );
  assert.equal(isBuiltinClientGatewayProviderSupported('grok', 'codebuddy'), false);
  assert.equal(isBuiltinClientGatewayProviderSupported('grok', 'zhipu-coding'), true);
});

test('derived task plans key representative native and gateway combinations canonically', () => {
  const plans = deriveTaskDispatchPlans(createBuiltinCatalog());
  assert.deepEqual(plans['codex/gpt-5.6-sol:codex'], {
    client: 'codex', provider: 'codex', model: 'gpt-5.6-sol', mode: 'native', reasoningEffort: 'xhigh',
  });
  assert.deepEqual(plans['codex-spark/gpt-5.3-codex-spark:codex'], {
    client: 'codex', provider: 'codex-spark', model: 'gpt-5.3-codex-spark', mode: 'native', reasoningEffort: 'xhigh',
  });
  assert.deepEqual(plans['codebuddy/minimax-m3:cb'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'minimax-m3', mode: 'native',
  });
  assert.deepEqual(plans['codebuddy/hy4-preview:cb'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'hy4-preview', mode: 'native',
  });
  assert.deepEqual(plans['codebuddy/hy3:cb'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'hy3', mode: 'native',
  });
  assert.deepEqual(plans['codebuddy/kimi-k3:cb'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'kimi-k3', mode: 'native',
  });
  assert.deepEqual(plans['codebuddy/glm-5.3:cb'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'glm-5.3', mode: 'native',
  });
  assert.deepEqual(plans['codebuddy/glm-5.3-flash:cb'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'glm-5.3-flash', mode: 'native',
  });
  assert.deepEqual(plans['kimi-coding/k3:cc'], {
    client: 'claude', provider: 'kimi-coding', model: 'k3', mode: 'gateway', protocol: 'anthropic_messages',
  });
  assert.deepEqual(plans['zhipu-coding/glm-5.3-flash:cc'], {
    client: 'claude', provider: 'zhipu-coding', model: 'glm-5.3-flash', mode: 'gateway', protocol: 'anthropic_messages',
  });
  assert.deepEqual(plans['spacex-ai/grok-4.5:gk'], {
    client: 'grok', provider: 'spacex-ai', model: 'grok-4.5', mode: 'native',
  });
  assert.equal(plans['codebuddy/hy3:gk'], undefined);
  assert.equal(plans['codebuddy/deepseek-v4-flash:gk'], undefined);
});

test('derived task plans carry canonical keys only — no legacy profile, policy, or alias ids', () => {
  const catalog = createBuiltinCatalog();
  const plans = deriveTaskDispatchPlans(catalog);
  const keys = Object.keys(plans);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate canonical targets');
  assert.ok(!keys.includes('cc-kimi'));
  assert.ok(!keys.includes('codex-sol'));
  assert.ok(!keys.includes('cb-hy'));
  assert.ok(!keys.includes('codex-astra'));
  assert.ok(keys.every((key) => key.includes('/') && key.includes(':')));
  assert.ok(!keys.some((key) => key.includes('hy4-preview-ioa')), 'aliases never become model targets');
  assert.ok(!keys.some((key) => key.includes('hy3-ioa')), 'hy3 internal upstream suffix never becomes a model target');
  assert.ok(!keys.some((key) => key.includes('hy3-preview')), 'hy3-preview near id never becomes a model target');
  assert.ok(!keys.some((key) => key.includes('codex-astra')));
  assert.ok(!keys.some((key) => key.endsWith(':dsh')), 'dsh is not a direct Task adapter');
  assert.equal(plans['codex/gpt-6-astra:codex']?.model, 'gpt-6-astra');
  // taskOnly hides codex-spark from Gateway /models yet keeps it a Task target.
  assert.equal(plans['codex-spark/gpt-5.3-codex-spark:codex']?.mode, 'native');
  // dsh stays a parseable public key and a compatible gateway route.
  assert.equal(catalog.resolveRun('dsh', 'codebuddy', 'glm-5.3').mode, 'gateway');
});

test('dispatch plans contain no provider endpoint or credential metadata', () => {
  const encoded = JSON.stringify(createBuiltinCatalog().resolveRun('dsh', 'codebuddy', 'hy4-preview-ioa'));
  assert.doesNotMatch(encoded, /https:|endpoint|authScheme|credentialResolver/);
  assert.doesNotMatch(encoded, /-ioa/u);
  assert.match(encoded, /"model":"hy4-preview"/u);
  assert.match(encoded, /"mode":"gateway"/);
});

test('GPT-6 Astra carries exact truthful SSOT metadata and is the canonical premium profile target', () => {
  const catalog = createBuiltinCatalog();
  const provider = catalog.provider('codex');
  assert.ok(provider, 'codex provider must exist');
  const astra = provider!.models.find((entry) => entry.id === 'gpt-6-astra');
  assert.ok(astra, 'gpt-6-astra model must exist');
  assert.equal(astra!.contextWindow, 1_050_000);
  assert.equal(astra!.maxOutputTokens, 128_000);
  assert.equal(astra!.intelligence, 'premium');
  assert.equal(astra!.reasoningEffort, 'xhigh');
  assert.equal(astra!.pricing?.inputUsdPerMillion, 10);
  assert.equal(astra!.pricing?.cachedInputUsdPerMillion, 1);
  assert.equal(astra!.pricing?.outputUsdPerMillion, 50);
  assert.equal(astra!.pricing?.source, 'https://developers.openai.com');
  assert.deepEqual(astra!.capabilities, ['text', 'image']);
  const plans = deriveTaskDispatchPlans(catalog);
  assert.equal(plans['codex/gpt-6-astra:codex'].model, 'gpt-6-astra');
  assert.equal(plans['codex/gpt-6-astra:codex'].reasoningEffort, 'xhigh');
});

test('Codex/OpenAI GPT plans carry xhigh reasoning effort and never max/ultra', () => {
  const catalog = createBuiltinCatalog();
  const plans = deriveTaskDispatchPlans(catalog);
  // Representative Codex execution plans, including GPT-6 Astra as the cap.
  assert.equal(plans['codex/gpt-6-astra:codex'].reasoningEffort, 'xhigh');
  assert.equal(plans['codex/gpt-5.6-sol:codex'].reasoningEffort, 'xhigh');
  assert.equal(plans['codex/gpt-5.6-terra:codex'].reasoningEffort, 'xhigh');
  assert.equal(plans['codex/gpt-5.6-luna:codex'].reasoningEffort, 'xhigh');
  assert.equal(plans['codex-spark/gpt-5.3-codex-spark:codex'].reasoningEffort, 'xhigh');
  assert.equal(plans['openai/gpt-5.6-sol:codex'].reasoningEffort, 'xhigh');
  // max/ultra are not part of the product field, in metadata or in any plan.
  const serialized = JSON.stringify(plans);
  assert.doesNotMatch(serialized, /"reasoningEffort":"(max|ultra)"/u);
  for (const model of catalog.provider('codex')!.models) {
    if (model.reasoningEffort) assert.ok(['low', 'medium', 'high', 'xhigh'].includes(model.reasoningEffort));
  }
  // Levels are declared product metadata, never inferred: unrelated plans stay unset.
  assert.equal(plans['kimi-coding/k3:cc'].reasoningEffort, undefined);
  assert.equal(plans['codebuddy/deepseek-v4-flash:cb'].reasoningEffort, undefined);
});

test('reference metadata has real provenance and unknown fields stay absent', () => {
  const catalog = createBuiltinCatalog();
  const codebuddy = catalog.provider('codebuddy')!;
  const flash = codebuddy.models.find((entry) => entry.id === 'deepseek-v4-flash')!;
  assert.equal(flash.pricing?.inputUsdPerMillion, 0.44);
  assert.equal(flash.pricing?.cachedInputUsdPerMillion, 0.014);
  assert.equal(flash.pricing?.outputUsdPerMillion, 1.32);
  assert.equal(flash.pricing?.source, 'https://api-docs.deepseek.com/quick_start/pricing/');
  assert.deepEqual(flash.capabilities, ['text']);
  assert.equal(flash.pricing?.source.includes('catalog-default'), false);
  // External decode benchmark, distinct from any local agent_turn_v1 measurement.
  assert.equal(flash.speed?.tps, 125.7);
  assert.equal(flash.speed?.source, 'https://artificialanalysis.ai/models/deepseek-v4-flash/');
  assert.notEqual(flash.speed?.source.includes('local'), true);

  // GLM-5.3 carries the Z.ai official list price; no sale/invented default.
  const glm = codebuddy.models.find((entry) => entry.id === 'glm-5.3')!;
  assert.equal(glm.pricing?.inputUsdPerMillion, 1.4);
  assert.equal(glm.pricing?.cachedInputUsdPerMillion, 0.26);
  assert.equal(glm.pricing?.outputUsdPerMillion, 4.4);
  assert.equal(glm.pricing?.source, 'https://docs.z.ai/guides/overview/pricing');

  // GLM-5.3-Flash carries the Z.ai official list price and sourced speed.
  const glmf = codebuddy.models.find((entry) => entry.id === 'glm-5.3-flash')!;
  assert.equal(glmf.pricing?.inputUsdPerMillion, 0.15);
  assert.equal(glmf.pricing?.cachedInputUsdPerMillion, 0.03);
  assert.equal(glmf.pricing?.outputUsdPerMillion, 0.50);
  assert.equal(glmf.pricing?.source, 'https://docs.z.ai/guides/overview/pricing');
  assert.equal(glmf.intelligence, 'high');
  assert.deepEqual(glmf.capabilities, ['text']);
  assert.equal(glmf.speed?.tps, 73.1);
  assert.equal(glmf.speed?.source, 'https://artificialanalysis.ai/models/glm-5-3-flash/');

  // Kimi K3 / k3 share official pricing and fallback decode benchmark.
  const k3 = codebuddy.models.find((entry) => entry.id === 'kimi-k3')!;
  assert.ok(k3.capabilities?.includes('image'));
  assert.equal(k3.pricing?.inputUsdPerMillion, 3);
  assert.equal(k3.pricing?.cachedInputUsdPerMillion, 0.30);
  assert.equal(k3.pricing?.outputUsdPerMillion, 15);
  assert.equal(k3.pricing?.source, 'https://www.kimi.com/en/blog/kimi-k3');
  assert.equal(k3.speed?.tps, 39.7);
  assert.equal(k3.speed?.source, 'https://artificialanalysis.ai/models/kimi-k3/');
  const k3Coding = catalog.provider('kimi-coding')!.models.find((entry) => entry.id === 'k3')!;
  assert.equal(k3Coding.pricing?.inputUsdPerMillion, 3);
  assert.equal(k3Coding.pricing?.outputUsdPerMillion, 15);
  assert.equal(k3Coding.speed?.tps, 39.7);

  // Hy4 preview carries the Tencent reference price.
  const hy = codebuddy.models.find((entry) => entry.id === 'hy4-preview')!;
  assert.equal(hy.pricing?.outputUsdPerMillion, 2.501);
  assert.equal(hy.pricing?.source, 'https://intl.cloud.tencent.com/zh/document/product/1300/78937');

  // HY3 is canonical (no preview/suffix aliases), high/text, and carries
  // independent speed plus official Tencent TokenHub-derived price evidence.
  const hy3 = codebuddy.models.find((entry) => entry.id === 'hy3')!;
  assert.equal(hy3.intelligence, 'high');
  assert.deepEqual(hy3.capabilities, ['text']);
  assert.equal(hy3.speed.tps, 93.8);
  assert.match(hy3.speed.source, /^https:\/\//u);
  assert.equal(hy3.pricing?.inputUsdPerMillion, 0.139);
  assert.equal(hy3.pricing?.cachedInputUsdPerMillion, 0.035);
  assert.equal(hy3.pricing?.outputUsdPerMillion, 0.556);
  assert.equal(hy3.pricing?.source, 'https://cloud.tencent.com/document/product/1823/130055');
  assert.equal(hy3.pricing?.checkedAt, '2026-09-08');
});

test('every registered built-in model has a valid authoritative speed default', () => {
  const entries = BUILTIN_PROVIDERS.flatMap((provider) =>
    provider.models.map((model) => ({ provider: provider.id, model })),
  );
  const uniqueIds = new Set(entries.map(({ model }) => model.id));
  assert.equal(uniqueIds.size, 44, 'the complete exact registered model-id inventory is covered');

  for (const { provider, model } of entries) {
    assert.ok(Number.isFinite(model.speed.tps) && model.speed.tps > 0, `${provider}/${model.id} needs positive finite tps`);
    assert.ok(model.speed.source.trim(), `${provider}/${model.id} needs speed provenance`);
    assert.ok(model.speed.checkedAt.trim(), `${provider}/${model.id} needs speed checkedAt`);
    assert.ok(model.speed.basis?.trim(), `${provider}/${model.id} needs a reviewable speed basis`);
    if (provider === 'cursor' && model.id === 'composer-2.5') {
      assert.equal(model.speed.tps, 40);
      assert.equal(model.speed.source, 'user-specified');
      assert.match(model.speed.basis!, /exact standard cursor\/composer-2\.5/u);
      assert.doesNotMatch(model.speed.basis!, /external benchmark/u);
      assert.match(model.speed.basis!, /not composer-2\.5-fast/u);
    } else {
      assert.match(model.speed.source, /^https:\/\//u, `${provider}/${model.id} needs a public evidence URL`);
    }
  }

  // A repeated exact id must resolve to the same model default on every provider;
  // provider-specific differences belong in modelSpeedOverrides instead.
  for (const id of uniqueIds) {
    const speeds = entries.filter(({ model }) => model.id === id).map(({ model }) => model.speed);
    for (const candidate of speeds.slice(1)) assert.deepEqual(candidate, speeds[0], `${id} defaults diverged`);
  }

  const representative = new Map(entries.map(({ model }) => [model.id, model.speed.tps]));
  assert.equal(representative.get('gpt-5.3-codex-spark'), 1000);
  assert.equal(representative.get('gpt-5.6-terra'), 98.4);
  assert.equal(representative.get('deepseek-v4-pro-202606'), 76.9);
  assert.equal(representative.get('MiniMax-M2.7-highspeed'), 100);
  assert.equal(representative.get('qwen3.7-flash'), 111.12);
  assert.equal(representative.get('doubao-seed-2-0-lite-260215'), 35.1);
});

test('GLM-5.3, K3/Kimi, and Sol stay identifiable under canonical target keys', () => {
  const catalog = createBuiltinCatalog();
  const plans = deriveTaskDispatchPlans(catalog);
  assert.equal(plans['codebuddy/glm-5.3:cb'].model, 'glm-5.3');
  assert.equal(plans['kimi-coding/k3:cc'].model, 'k3');
  assert.equal(plans['codebuddy/kimi-k3:cb'].model, 'kimi-k3');
  assert.equal(plans['codex/gpt-5.6-sol:codex'].model, 'gpt-5.6-sol');
});

test('shared canonical model metadata is explicit, version-exact, and label-consistent', () => {
  const catalog = createBuiltinCatalog();
  const route = (provider: string, model: string) =>
    catalog.provider(provider)!.models.find((entry) => entry.id === model)!;

  // Kimi documents `k3` as Kimi K3 and separately exposes `kimi-k3` as the
  // same display-prefixed identity; every exact K3 route shares one model row.
  for (const [provider, model] of [
    ['codebuddy', 'kimi-k3'],
    ['cursor', 'kimi-k3'],
    ['kimi-coding', 'k3'],
  ] as const) {
    assert.deepEqual(route(provider, model).canonicalModel, { id: 'kimi-k3', displayName: 'Kimi K3' });
  }

  // MiniMax and Tencent's official model tables identify these exact versions
  // despite the provider-specific casing of their API ids.
  for (const [provider, model] of [
    ['codebuddy', 'minimax-m3'],
    ['minimax', 'MiniMax-M3'],
    ['minimax-coding', 'MiniMax-M3'],
  ] as const) {
    assert.deepEqual(route(provider, model).canonicalModel, { id: 'minimax-m3', displayName: 'MiniMax M3' });
  }
  for (const [provider, model] of [
    ['minimax', 'MiniMax-M2.7'],
    ['minimax-coding', 'MiniMax-M2.7'],
    ['tokenhub', 'minimax-m2.7'],
  ] as const) {
    assert.deepEqual(route(provider, model).canonicalModel, { id: 'minimax-m2.7', displayName: 'MiniMax M2.7' });
  }

  assert.deepEqual(route('codebuddy', 'hy4-preview').canonicalModel, {
    id: 'hunyuan-hy4-preview',
    displayName: 'Hunyuan HY4 Preview',
  });
  assert.deepEqual(route('tokenhub', 'hy4-preview').canonicalModel, route('codebuddy', 'hy4-preview').canonicalModel);

  // Dated DeepSeek routes are distinct versions. Current provider aliases and
  // matching marketing labels must never fold their historical usage into an
  // unversioned route.
  assert.equal(route('codebuddy', 'deepseek-v4-flash').canonicalModel, undefined);
  assert.equal(route('tokenhub', 'deepseek-v4-flash-202605').canonicalModel, undefined);
  assert.equal(route('codebuddy', 'deepseek-v4-pro').canonicalModel, undefined);
  assert.equal(route('tokenhub', 'deepseek-v4-pro-202606').canonicalModel, undefined);

  const groups = new Map<string, Set<string>>();
  for (const provider of BUILTIN_PROVIDERS) {
    for (const model of provider.models) {
      if (!model.canonicalModel) continue;
      const labels = groups.get(model.canonicalModel.id) ?? new Set<string>();
      labels.add(model.canonicalModel.displayName);
      groups.set(model.canonicalModel.id, labels);
    }
  }
  for (const [id, labels] of groups) {
    assert.equal(labels.size, 1, `${id} must have one canonical display-name source`);
  }
});
