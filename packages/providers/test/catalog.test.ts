import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog, resolveBuiltinDispatchPlans } from '../src/index.ts';

test('CodeBuddy keeps native routing and exposes every confirmed gateway model', () => {
  const catalog = createBuiltinCatalog();
  assert.equal(catalog.resolveRun('codebuddy', 'codebuddy', 'deepseek-v4-flash').mode, 'native');
  const modelIds = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'hy4-preview',
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
});

test('daemon dispatch plans are resolved by the TypeScript catalog', () => {
  const plans = resolveBuiltinDispatchPlans(createBuiltinCatalog());
  assert.deepEqual(plans['cc-kimi'], {
    client: 'claude', provider: 'kimi-coding', model: 'k3', mode: 'gateway', protocol: 'anthropic_messages',
  });
  assert.deepEqual(plans['codex-sol'], {
    client: 'codex', provider: 'codex', model: 'gpt-5.6-sol', mode: 'native',
  });
  assert.deepEqual(plans['cb-minimax'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'minimax-m3', mode: 'native',
  });
  assert.deepEqual(plans['cb-hy'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'hy4-preview', mode: 'native',
  });
  assert.deepEqual(plans['cb-kimi'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'kimi-k3', mode: 'native',
  });
  assert.deepEqual(plans['cb-glm'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'glm-5.3', mode: 'native',
  });
  assert.deepEqual(plans['cb-glmf'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'glm-5.3-flash', mode: 'native',
  });
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
  assert.equal(astra!.pricing?.inputUsdPerMillion, 10);
  assert.equal(astra!.pricing?.cachedInputUsdPerMillion, 1);
  assert.equal(astra!.pricing?.outputUsdPerMillion, 50);
  assert.equal(astra!.pricing?.source, 'https://developers.openai.com');
  assert.deepEqual(astra!.capabilities, ['text', 'image']);
  const plans = resolveBuiltinDispatchPlans(catalog);
  assert.equal(plans['codex-astra'].model, 'gpt-6-astra');
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
  assert.equal(flash.speed?.tps, 140);
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
  assert.equal(glmf.speed?.tps, 47.4);
  assert.equal(glmf.speed?.source, 'https://artificialanalysis.ai/models/glm-5-3-flash/');

  // Kimi K3 / k3 share official pricing and fallback decode benchmark.
  const k3 = codebuddy.models.find((entry) => entry.id === 'kimi-k3')!;
  assert.ok(k3.capabilities?.includes('image'));
  assert.equal(k3.pricing?.inputUsdPerMillion, 3);
  assert.equal(k3.pricing?.cachedInputUsdPerMillion, 0.30);
  assert.equal(k3.pricing?.outputUsdPerMillion, 15);
  assert.equal(k3.pricing?.source, 'https://www.kimi.com/en/blog/kimi-k3');
  assert.equal(k3.speed?.tps, 39.2);
  assert.equal(k3.speed?.source, 'https://artificialanalysis.ai/models/kimi-k3/');
  const k3Coding = catalog.provider('kimi-coding')!.models.find((entry) => entry.id === 'k3')!;
  assert.equal(k3Coding.pricing?.inputUsdPerMillion, 3);
  assert.equal(k3Coding.pricing?.outputUsdPerMillion, 15);
  assert.equal(k3Coding.speed?.tps, 39.2);

  // Hy4 preview carries the Tencent reference price.
  const hy = codebuddy.models.find((entry) => entry.id === 'hy4-preview')!;
  assert.equal(hy.pricing?.outputUsdPerMillion, 2.501);
  assert.equal(hy.pricing?.source, 'https://intl.cloud.tencent.com/zh/document/product/1300/78937');
});

test('unverified conservative speeds stay absent and local evidence can later override', () => {
  const catalog = createBuiltinCatalog();
  const codebuddy = catalog.provider('codebuddy')!;
  const codex = catalog.provider('codex')!;
  // These had arbitrary SRC_CONSERVATIVE TPS removed; absence stays unknown.
  for (const id of ['hy4-preview']) {
    assert.equal(codebuddy.models.find((entry) => entry.id === id)!.speed, undefined, `${id} speed must be absent`);
  }
  // Terra and Astra still carry no sourced speed; only Luna/Sol gained sourced fallbacks.
  for (const id of ['gpt-6-astra', 'gpt-5.6-terra']) {
    assert.equal(codex.models.find((entry) => entry.id === id)!.speed, undefined, `${id} speed must be absent`);
  }
  // External benchmark speeds are source-tagged so a local agent_turn_v1
  // measurement (SpeedSource local_31d) could later supersede them at the Catalog layer.
  const flash = codebuddy.models.find((entry) => entry.id === 'deepseek-v4-flash')!;
  assert.ok(flash.speed?.source.startsWith('https://'));
  assert.notEqual(flash.speed?.source.includes('local'), true);

  // GPT-5.6 Sol: sourced external decode default (Artificial Analysis) — no local measurement fabricated.
  const sol = codex.models.find((entry) => entry.id === 'gpt-5.6-sol')!;
  assert.equal(sol.speed?.tps, 74.4);
  assert.equal(sol.speed?.source, 'https://artificialanalysis.ai/models/gpt-5-6-sol/');
  assert.notEqual(sol.speed?.source.includes('local'), true);

  // GPT-5.6 Luna: sourced external decode default (Artificial Analysis, minimum of current listed effort speeds).
  const luna = codex.models.find((entry) => entry.id === 'gpt-5.6-luna')!;
  assert.equal(luna.speed?.tps, 107);
  assert.equal(luna.speed?.source, 'https://artificialanalysis.ai/models/releases/gpt-5-6-luna');
  assert.notEqual(luna.speed?.source.includes('local'), true);
});

test('GLM-5.3, K3/Kimi, and Sol remain identifiable for hard exclusions', () => {
  const catalog = createBuiltinCatalog();
  const plans = resolveBuiltinDispatchPlans(catalog);
  assert.equal(plans['cb-glm'].model, 'glm-5.3');
  assert.equal(plans['cc-kimi'].model, 'k3');
  assert.equal(plans['cb-kimi'].model, 'kimi-k3');
  assert.equal(plans['codex-sol'].model, 'gpt-5.6-sol');
});
