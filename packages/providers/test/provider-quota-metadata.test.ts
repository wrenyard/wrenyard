import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_QUOTA_BINDINGS,
  findProviderQuotaBinding,
  type ProviderQuotaBinding,
} from '../src/provider-quota-metadata.ts';
import { BUILTIN_PROVIDERS } from '../src/catalog.ts';

/** All raw window ids declared by a binding's quota pools. */
function bindingWindowIds(binding: ProviderQuotaBinding): string[] {
  return binding.pools.flatMap((pool) => pool.windows.map((window) => window.windowId));
}

/** Every pool id declared by a binding. */
function bindingPoolIds(binding: ProviderQuotaBinding): string[] {
  return binding.pools.map((pool) => pool.quotaPoolId);
}

function expectBinding(providerId: string, modelId: string): ProviderQuotaBinding {
  const binding = findProviderQuotaBinding(providerId, modelId);
  assert.ok(binding, `missing binding for ${providerId}/${modelId}`);
  return binding;
}

test('every builtin catalog model resolves to a non-empty own-provider binding', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    for (const modelDefinition of provider.models) {
      const binding = findProviderQuotaBinding(provider.id, modelDefinition.id);
      assert.ok(binding, `missing binding for ${provider.id}/${modelDefinition.id}`);
      assert.equal(binding!.providerId, provider.id);
      assert.equal(binding!.modelId, modelDefinition.id);
      assert.ok(binding!.pools.length >= 1, `${provider.id}/${modelDefinition.id} must bind at least one pool`);
      for (const pool of binding!.pools) {
        assert.ok(pool.quotaPoolId.startsWith(`${provider.id}/`), `pool ${pool.quotaPoolId} must be provider-scoped to ${provider.id}`);
        assert.ok(['quota', 'balance'].includes(pool.kind));
      }
    }
  }
});

test('a discovered model falls back to its own provider-default binding', () => {
  const discovered = findProviderQuotaBinding('cursor', 'cursor-brand-new-model');
  assert.ok(discovered);
  assert.equal(discovered!.providerId, 'cursor');
  assert.ok(discovered!.pools.length >= 1);
  assert.equal(discovered!.pools[0]!.quotaPoolId, 'cursor/usage');
  // Unknown providers still resolve to undefined.
  assert.equal(findProviderQuotaBinding('not-a-provider', 'anything'), undefined);
});

test('ChatGPT standard and Spark models bind distinct, non-overlapping pools', () => {
  const standard = expectBinding('chatgpt', 'gpt-5.6-sol');
  assert.deepEqual(bindingWindowIds(standard), ['5h', '7d']);
  assert.deepEqual(bindingPoolIds(standard), ['chatgpt/5h', 'chatgpt/7d']);

  const spark = expectBinding('chatgpt', 'gpt-5.3-codex-spark');
  assert.deepEqual(bindingWindowIds(spark), ['spark-5h', 'spark-7d']);
  assert.deepEqual(bindingPoolIds(spark), ['chatgpt/spark-5h', 'chatgpt/spark-7d']);
  // Spark never consumes the standard ChatGPT pools.
  for (const poolId of bindingPoolIds(spark)) {
    assert.ok(!bindingPoolIds(standard).includes(poolId));
  }
  // The standard 5h/7d windows never appear on the Spark binding.
  assert.ok(!bindingWindowIds(spark).includes('5h'));
  assert.ok(!bindingWindowIds(spark).includes('7d'));
});

test('there is exactly one ChatGPT provider and no codex-spark provider remains', () => {
  const chatgpt = BUILTIN_PROVIDERS.filter((provider) => provider.id === 'chatgpt');
  assert.equal(chatgpt.length, 1);
  assert.equal(chatgpt[0]!.displayName, 'ChatGPT');
  assert.ok(!BUILTIN_PROVIDERS.some((provider) => provider.id === 'codex'));
  assert.ok(!BUILTIN_PROVIDERS.some((provider) => provider.id === 'codex-spark'));
  // The Spark model exists exactly once, under chatgpt.
  const sparkOwners = BUILTIN_PROVIDERS.filter((provider) =>
    provider.models.some((modelDefinition) => modelDefinition.id === 'gpt-5.3-codex-spark'),
  );
  assert.deepEqual(sparkOwners.map((provider) => provider.id), ['chatgpt']);
});

test('Cursor binds Grok and Composer to the Cursor pool and third-party models to Other', () => {
  const grok = expectBinding('cursor', 'grok-4.6');
  assert.deepEqual(bindingWindowIds(grok), ['Cursor']);
  assert.deepEqual(bindingPoolIds(grok), ['cursor/cursor']);

  const composer = expectBinding('cursor', 'composer-2.5');
  assert.deepEqual(bindingPoolIds(composer), ['cursor/cursor']);

  const otherModelIds = [
    'kimi-k3',
    'claude-opus-5',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.6-sol',
    'claude-sonnet-5',
    'muse-spark-1.3',
    'gemini-3.8-flash',
    'claude-fable-5',
    'claude-fable-5-1',
  ];
  for (const modelId of otherModelIds) {
    const other = expectBinding('cursor', modelId);
    assert.deepEqual(bindingWindowIds(other), ['Other']);
    assert.deepEqual(bindingPoolIds(other), ['cursor/other']);
  }
  assert.notDeepEqual(bindingPoolIds(expectBinding('cursor', 'kimi-k3')), bindingPoolIds(grok));

  const cursor = BUILTIN_PROVIDERS.find((provider) => provider.id === 'cursor')!;
  assert.equal(cursor.models.length, 12);
  for (const model of cursor.models) {
    const bound = expectBinding('cursor', model.id);
    assert.equal(bound.modelId, model.id);
    assert.equal(bound.pools.length, 1);
  }
  assert.ok(!PROVIDER_QUOTA_BINDINGS.some((binding) =>
    binding.pools.some((pool) => pool.quotaPoolId === 'cursor/claude'),
  ));
});

test('kimi-coding k3 binds independent 5h rolling and 7d full-cycle pools', () => {
  const binding = expectBinding('kimi-coding', 'k3');
  assert.deepEqual(bindingPoolIds(binding), ['kimi-coding/5h', 'kimi-coding/7d']);
  assert.deepEqual(binding.pools.map((pool) => pool.windows.map((window) => window.windowId)), [['5h'], ['7d']]);
  assert.deepEqual(binding.pools.map((pool) => pool.windows[0]!.resetKind), ['rolling_partial', 'full_cycle']);
  for (const pool of binding.pools) {
    assert.equal(Object.isFrozen(pool), true);
    assert.equal(pool.windows[0]!.evidenceRef, 'https://www.kimi.com/code/docs/en/kimi-code/membership.html');
  }
});

test('zhipu-coding preserves the proven 5h rolling / 7d full-cycle resets', () => {
  for (const modelId of ['glm-5.3', 'glm-5.3-flash']) {
    const binding = expectBinding('zhipu-coding', modelId);
    assert.deepEqual(bindingPoolIds(binding), ['zhipu-coding/5h', 'zhipu-coding/7d']);
    assert.deepEqual(binding.pools.map((pool) => pool.windows[0]!.resetKind), ['rolling_partial', 'full_cycle']);
    assert.equal(binding.pools[0]!.windows[0]!.evidenceRef, 'https://docs.bigmodel.cn/cn/coding-plan/overview');
  }
});

test('CodeBuddy HY models keep HY + monthly unknown resources; others monthly only', () => {
  for (const modelId of ['hy3', 'hy4-preview']) {
    const binding = expectBinding('codebuddy', modelId);
    assert.deepEqual(bindingPoolIds(binding), ['codebuddy/hy-family', 'codebuddy/monthly']);
    for (const pool of binding.pools) {
      assert.equal(pool.kind, 'quota');
      assert.deepEqual(pool.windows, []);
    }
  }
  const other = expectBinding('codebuddy', 'deepseek-v4.1-flash');
  assert.deepEqual(bindingPoolIds(other), ['codebuddy/monthly']);
  assert.deepEqual(other.pools[0]!.windows, []);
});

test('API-billed providers bind their own balance resource only where proven', () => {
  const deepseek = expectBinding('deepseek', 'deepseek-flash');
  assert.equal(deepseek.pools.length, 1);
  assert.equal(deepseek.pools[0]!.kind, 'balance');
  assert.equal(deepseek.pools[0]!.quotaPoolId, 'deepseek/balance');
  assert.deepEqual(deepseek.pools[0]!.windows, []);
  // No cross-provider balance inheritance.
  assert.equal(findProviderQuotaBinding('codebuddy', 'deepseek-flash')!.pools[0]!.kind, 'quota');
  assert.equal(findProviderQuotaBinding('tokenhub', 'deepseek-flash')!.pools[0]!.quotaPoolId, 'tokenhub/balance');
});

test('free providers get their own free-usage pool, never a mandatory paid balance', () => {
  for (const [providerId, modelId] of [
    ['opencode-zen', 'mimo-v2.5-free'],
    ['openrouter', 'nex-agi/nex-n2.5-mini:free'],
  ] as const) {
    const binding = expectBinding(providerId, modelId);
    assert.equal(binding.pools.length, 1);
    assert.equal(binding.pools[0]!.kind, 'quota');
    assert.ok(binding.pools[0]!.quotaPoolId.startsWith(`${providerId}/`));
  }
});

test('provider-scoped pool ids are unique across the whole graph', () => {
  const seen = new Set<string>();
  for (const binding of PROVIDER_QUOTA_BINDINGS) {
    for (const pool of binding.pools) {
      const key = `${binding.providerId}\u0000${pool.quotaPoolId}`;
      assert.ok(!seen.has(`${binding.providerId}\u0000${pool.quotaPoolId}\u0000${binding.modelId}`));
      seen.add(`${binding.providerId}\u0000${pool.quotaPoolId}\u0000${binding.modelId}`);
      assert.ok(pool.quotaPoolId.startsWith(`${binding.providerId}/`), `${pool.quotaPoolId} must be scoped to ${binding.providerId} (${key})`);
    }
  }
});

test('unsupported providers, models, and near variants resolve by provider fallback only', () => {
  // Unknown provider -> no binding at all.
  assert.equal(findProviderQuotaBinding('unknown-provider', 'claude-sonnet-4.5'), undefined);
  // Registered provider + unknown model -> provider-default binding, never exact catalog resources.
  const variant = findProviderQuotaBinding('cursor', 'cursor-grok-4.6-high');
  assert.ok(variant);
  assert.deepEqual(bindingWindowIds(variant!), []);
});

test('the public quota metadata graph is recursively frozen at runtime', () => {
  assert.equal(Object.isFrozen(PROVIDER_QUOTA_BINDINGS), true);
  assert.ok(PROVIDER_QUOTA_BINDINGS.length > 0);
  for (const binding of PROVIDER_QUOTA_BINDINGS) {
    assert.equal(Object.isFrozen(binding), true);
    assert.ok(binding.pools.length >= 1);
    assert.equal(Object.isFrozen(binding.pools), true);
    for (const pool of binding.pools) {
      assert.equal(Object.isFrozen(pool), true);
      assert.equal(Object.isFrozen(pool.windows), true);
      assert.ok(pool.windows.length <= 1, 'one quota resource per pool');
      for (const window of pool.windows) {
        assert.equal(Object.isFrozen(window), true);
      }
    }
  }
});

test('lookup is exact per (providerId, modelId) pair', () => {
  const kimi = expectBinding('kimi-coding', 'k3');
  const zhipu = expectBinding('zhipu-coding', 'glm-5.3');
  assert.notEqual(kimi, zhipu);
  assert.notDeepEqual(bindingPoolIds(kimi), bindingPoolIds(zhipu));
});
