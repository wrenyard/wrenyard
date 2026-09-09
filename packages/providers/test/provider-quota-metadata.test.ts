import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_QUOTA_BINDINGS,
  findProviderQuotaBinding,
  type ProviderQuotaBinding,
} from '../src/provider-quota-metadata.ts';

// Test-local coverage helper: which required windows are absent from an
// observed windowId set. Purely a test assertion aid, not policy logic.
function uncoveredWindows(binding: ProviderQuotaBinding, observedWindowIds: readonly string[]) {
  return (binding.windows?.map((window) => window.windowId) ?? []).filter((id) => !observedWindowIds.includes(id));
}

test('Cursor Grok maps only to the cursor-models pool with a single raw Cursor/full_cycle window', () => {
  const binding = findProviderQuotaBinding('cursor', 'cursor-grok-4.6-high');
  assert.ok(binding);
  const windows = binding.windows;
  assert.ok(windows);
  assert.equal(binding.quotaProviderId, 'cursor');
  assert.equal(binding.quotaPoolId, 'cursor-models');
  assert.equal(windows.length, 1);
  const window = windows[0];
  assert.equal(window.windowId, 'Cursor');
  assert.equal(window.required, true);
  assert.equal(window.resetKind, 'full_cycle');
  assert.equal(window.evidence, 'official_docs');
  assert.equal(window.evidenceRef, 'https://cursor.com/docs/models-and-pricing');
  assert.equal(window.checkedAt, '2026-09-08');
});

test('Kimi k3 requires exactly the two raw windows 5h rolling_partial and 7d full_cycle, never 1mo', () => {
  const binding = findProviderQuotaBinding('kimi-coding', 'k3');
  assert.ok(binding);
  const windows = binding.windows;
  assert.ok(windows);
  assert.equal(binding.quotaProviderId, 'kimi-coding');
  assert.equal(binding.quotaPoolId, 'kimi-membership-coding');
  assert.deepEqual(windows.map((window) => window.windowId), ['5h', '7d']);
  assert.deepEqual(
    windows.map((window) => window.resetKind),
    ['rolling_partial', 'full_cycle'],
  );
  for (const window of windows) {
    assert.equal(window.required, true);
    assert.equal(window.evidence, 'official_docs');
    assert.equal(window.evidenceRef, 'https://www.kimi.com/code/docs/en/kimi-code/membership.html');
    assert.equal(window.checkedAt, '2026-09-08');
  }
});

test('k3 needs no monthly window: observed 5h/7d is complete and a raw monthly stays inert', () => {
  const binding = findProviderQuotaBinding('kimi-coding', 'k3');
  assert.ok(binding);
  // 5h + 7d alone fully covers the retained k3 windows; 1mo is not required.
  assert.deepEqual(uncoveredWindows(binding, ['5h', '7d']), []);
  assert.equal(uncoveredWindows(binding, ['5h', '7d']).length, 0);
  assert.deepEqual(uncoveredWindows(binding, ['5h', '7d', '1mo']), []);
  assert.equal(uncoveredWindows(binding, ['5h', '7d', '1mo']).length, 0);
  // Dropping either retained window still leaves coverage incomplete.
  assert.deepEqual(uncoveredWindows(binding, ['5h']), ['7d']);
  assert.equal(uncoveredWindows(binding, ['5h']).length, 1);
  assert.deepEqual(uncoveredWindows(binding, ['7d']), ['5h']);
  assert.equal(uncoveredWindows(binding, ['7d']).length, 1);
});

test('both zhipu-coding models share the zhipu-coding-tokens pool with evidence-backed 5h rolling and 7d full-cycle windows', () => {
  for (const modelId of ['glm-5.3', 'glm-5.3-flash']) {
    const binding = findProviderQuotaBinding('zhipu-coding', modelId);
    assert.ok(binding, `missing binding for ${modelId}`);
    const windows = binding.windows;
    assert.ok(windows);
    assert.equal(binding.quotaProviderId, 'zhipu-coding');
    assert.equal(binding.quotaPoolId, 'zhipu-coding-tokens');
    assert.deepEqual(windows.map((window) => window.windowId), ['5h', '7d']);
    assert.deepEqual(
      windows.map((window) => window.resetKind),
      ['rolling_partial', 'full_cycle'],
    );
    for (const window of windows) {
      assert.equal(window.required, true);
      assert.equal(window.evidence, 'official_docs');
      assert.equal(window.evidenceRef, 'https://docs.bigmodel.cn/cn/coding-plan/overview');
      assert.equal(window.checkedAt, '2026-09-09');
    }
  }
});

test('every current codex model maps to the codex row with the required weekly window', () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['codex', 'gpt-5.6-sol'],
    ['codex', 'gpt-5.6-terra'],
    ['codex', 'gpt-5.6-luna'],
    ['codex', 'gpt-5.3-codex-spark'],
    ['codex', 'gpt-6-astra'],
    ['codex', 'gpt-5.5'],
    ['codex', 'gpt-5.4'],
    ['codex', 'gpt-5.4-mini'],
  ];
  for (const [providerId, modelId] of expected) {
    const binding = findProviderQuotaBinding(providerId, modelId);
    assert.ok(binding, `missing binding for ${providerId}/${modelId}`);
    assert.equal(binding.providerId, providerId);
    assert.equal(binding.modelId, modelId);
    assert.equal(binding.quotaProviderId, 'codex');
    assert.equal(binding.quotaPoolId, 'codex-models');
    const windows = binding.windows;
    assert.ok(windows);
    assert.deepEqual(windows.map((window) => window.windowId), ['7d']);
    for (const window of windows) {
      assert.equal(window.required, true);
      assert.equal(window.resetKind, 'full_cycle');
      assert.equal(window.evidence, 'provider_parser');
      assert.equal(window.evidenceRef, 'runtime/forge/internal/usage/quota/codex.go');
      assert.equal(window.checkedAt, '2026-09-09');
    }
    assert.equal(binding.pools, undefined);
  }
  // No codex-family bindings beyond the current model sets.
  const codexFamily = PROVIDER_QUOTA_BINDINGS.filter(
    (binding) => binding.providerId === 'codex',
  );
  assert.deepEqual(
    codexFamily.map((binding) => [binding.providerId, binding.modelId]).sort(),
    expected.map(([providerId, modelId]) => [providerId, modelId]).sort(),
  );
});

test('codex metadata keeps weekly-only baseline complete and leaves conditional 5h to snapshot evidence', () => {
  const binding = findProviderQuotaBinding('codex', 'gpt-5.6-sol');
  assert.ok(binding);
  assert.deepEqual(uncoveredWindows(binding, ['7d']), []);
  assert.deepEqual(uncoveredWindows(binding, ['5h', '7d']), []);
  assert.deepEqual(uncoveredWindows(binding, ['5h']), ['7d']);
});

test('codex-spark stays on its separate raw pool with both 5h and 7d required', () => {
  const binding = findProviderQuotaBinding('codex-spark', 'gpt-5.3-codex-spark');
  assert.ok(binding);
  assert.equal(binding.quotaProviderId, 'codex-spark');
  assert.equal(binding.quotaPoolId, 'codex-spark-models');
  assert.deepEqual(binding.windows?.map((window) => window.windowId), ['5h', '7d']);
  assert.deepEqual(binding.windows?.map((window) => window.resetKind), ['full_cycle', 'full_cycle']);
  assert.deepEqual(uncoveredWindows(binding, ['5h', '7d']), []);
  assert.deepEqual(uncoveredWindows(binding, ['7d']), ['5h']);
});

test('unsupported providers, models, and near variants return undefined', () => {
  assert.equal(findProviderQuotaBinding('cursor', 'grok-4.6'), undefined);
  assert.equal(findProviderQuotaBinding('cursor', 'cursor-grok-4.6'), undefined);
  assert.equal(findProviderQuotaBinding('cursor', 'cursor grok-4.6-high'), undefined);
  assert.equal(findProviderQuotaBinding('kimi-coding', 'k3[1m]'), undefined);
  assert.equal(findProviderQuotaBinding('kimi-coding', 'k3.5'), undefined);
  assert.equal(findProviderQuotaBinding('zhipu-coding', 'glm-4.6'), undefined);
  assert.equal(findProviderQuotaBinding('anthropic', 'claude-sonnet-4.5'), undefined);
});

test('the public quota metadata graph is recursively frozen at runtime', () => {
  assert.equal(Object.isFrozen(PROVIDER_QUOTA_BINDINGS), true);
  assert.ok(PROVIDER_QUOTA_BINDINGS.length > 0);
  for (const binding of PROVIDER_QUOTA_BINDINGS) {
    assert.equal(Object.isFrozen(binding), true);
    const windows = binding.windows;
    if (windows) {
      assert.equal(Object.isFrozen(windows), true);
      for (const window of windows) {
        assert.equal(Object.isFrozen(window), true);
      }
    }
    const pools = binding.pools;
    if (pools) {
      assert.equal(Object.isFrozen(pools), true);
      for (const pool of pools) {
        assert.equal(Object.isFrozen(pool), true);
        assert.equal(Object.isFrozen(pool.windows), true);
        for (const window of pool.windows) {
          assert.equal(Object.isFrozen(window), true);
        }
      }
    }
  }
});

test('lookup is exact per (providerId, modelId) pair', () => {
  const kimi = findProviderQuotaBinding('kimi-coding', 'k3');
  const zhipu = findProviderQuotaBinding('zhipu-coding', 'glm-5.3');
  assert.ok(kimi);
  assert.ok(zhipu);
  assert.notEqual(kimi, zhipu);
  assert.notEqual(kimi.quotaPoolId, zhipu.quotaPoolId);
});

test('codebuddy/hy3 jointly requires the HY family and account monthly pools', () => {
  const binding = findProviderQuotaBinding('codebuddy', 'hy3');
  assert.ok(binding);
  assert.equal(binding.providerId, 'codebuddy');
  assert.equal(binding.modelId, 'hy3');
  assert.equal(binding.quotaProviderId, 'codebuddy');
  // Joint applicability is expressed through pools, never a single top-level pool.
  assert.equal(binding.quotaPoolId, undefined);
  assert.equal(binding.windows, undefined);
  const pools = binding.pools;
  assert.ok(pools);
  assert.deepEqual(pools.map((pool) => pool.quotaPoolId), ['codebuddy-hy-family', 'codebuddy-monthly']);
  // No raw window evidence is invented: every pool keeps an empty frozen set.
  for (const pool of pools) {
    assert.equal(Object.isFrozen(pool), true);
    assert.equal(Object.isFrozen(pool.windows), true);
    assert.equal(pool.windows.length, 0);
    assert.deepEqual(pool.windows, []);
  }
});

test('codebuddy/hy3 near ids and unrelated models stay unmatched', () => {
  assert.equal(findProviderQuotaBinding('codebuddy', 'hy3-ioa'), undefined);
  assert.equal(findProviderQuotaBinding('codebuddy', 'hy3-preview'), undefined);
  assert.equal(findProviderQuotaBinding('codebuddy', 'hy3 '), undefined);
  assert.equal(findProviderQuotaBinding('codebuddy', 'hy4-preview'), undefined);
  assert.equal(findProviderQuotaBinding('codebuddy', 'deepseek-v4-flash'), undefined);
  assert.equal(findProviderQuotaBinding('codebuddy-hy-family', 'hy3'), undefined);
});

test('existing single-pool bindings keep exact top-level pool fields', () => {
  for (const [providerId, modelId, quotaPoolId, expectedWindows] of [
    ['cursor', 'cursor-grok-4.6-high', 'cursor-models', ['Cursor']],
    ['kimi-coding', 'k3', 'kimi-membership-coding', ['5h', '7d']],
    ['zhipu-coding', 'glm-5.3', 'zhipu-coding-tokens', ['5h', '7d']],
    ['zhipu-coding', 'glm-5.3-flash', 'zhipu-coding-tokens', ['5h', '7d']],
  ] as const) {
    const binding = findProviderQuotaBinding(providerId, modelId);
    assert.ok(binding);
    const windows = binding.windows;
    assert.ok(windows);
    assert.equal(binding.quotaPoolId, quotaPoolId);
    assert.deepEqual(windows.map((window) => window.windowId), [...expectedWindows]);
    assert.equal(binding.pools, undefined);
  }
});
