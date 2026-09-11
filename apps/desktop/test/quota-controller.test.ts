import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuotaProviderState } from '@wrenyard/pet/runtime';
import type { ProviderAuthStatus } from '../src/shell-contract.js';
import { DesktopQuotaController, projectQuotaSnapshot } from '../src/quota-controller.js';

const providers: QuotaProviderState[] = [
  {
    id: 'chatgpt',
    label: 'Codex',
    status: 'ok',
    stale: false,
    displayLine: 'codex 7d 75% remain',
    error: null,
    bars: {
      remainingPct: null,
      expectedRemainingPct: null,
      windows: [{ name: '7d', usedPct: 25, remainingPct: 75.8, expectedRemainingPct: 64.2 }],
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    status: 'ok',
    stale: false,
    displayLine: 'deepseek bal. ¥12.50',
    error: null,
    balances: [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }],
  },
];

test('quota projection follows provider order, ignores legacy enablement, and shows only active quota sources', () => {
  const snapshot = projectQuotaSnapshot(providers, [
    { id: 'deepseek', enabled: true },
    { id: 'cursor', enabled: false },
    { id: 'chatgpt', enabled: false },
  ], 123, undefined, [
    { id: 'deepseek', configured: true, authMode: 'environment' },
    { id: 'cursor', configured: false, authMode: 'native' },
    { id: 'chatgpt', configured: true, authMode: 'native' },
  ]);

  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.refreshedAt, 123);
  assert.deepEqual(snapshot.providers.map((provider) => provider.id), ['deepseek', 'chatgpt']);
  assert.deepEqual(snapshot.providers[0].balances, [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }]);
  assert.deepEqual(snapshot.providers[1].windows, [{ name: '7d', remainingPct: 75.8, expectedRemainingPct: 64.2 }]);
});

test('quota projection omits configured providers when the runtime has no quota source', () => {
  const snapshot = projectQuotaSnapshot([], [{ id: 'cursor', enabled: true }], 456, 'runtime unavailable', [
    { id: 'cursor', configured: true, authMode: 'native' },
  ]);

  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.message, 'runtime unavailable');
  assert.deepEqual(snapshot.providers, []);
  assert.equal(snapshot.catalog[0].configured, true);
  assert.equal(snapshot.catalog[0].quota, undefined);
});

test('quota projection clamps malformed percentages at the renderer boundary', () => {
  const malformed: QuotaProviderState = {
    ...providers[0],
    bars: {
      remainingPct: null,
      expectedRemainingPct: null,
      windows: [{ name: '7d', usedPct: 0, remainingPct: 130, expectedRemainingPct: -20 }],
    },
  };
  const snapshot = projectQuotaSnapshot([malformed], [{ id: 'chatgpt', enabled: true }]);

  assert.equal(snapshot.providers[0].windows[0].remainingPct, 100);
  assert.equal(snapshot.providers[0].windows[0].expectedRemainingPct, 0);
});

test('catalog keeps inactive providers visible while quota surfaces show only active sources with data', () => {
  const discovered: ProviderAuthStatus[] = [
    { id: 'kimi-coding', displayName: 'Kimi Coding', configured: false, authMode: 'api-key' },
    { id: 'deepseek', displayName: 'DeepSeek', configured: true, authMode: 'environment' },
    { id: 'cursor', displayName: 'Cursor', configured: false, authMode: 'native' },
  ];
  const snapshot = projectQuotaSnapshot(providers, [
    { id: 'deepseek', enabled: true },
    { id: 'cursor', enabled: false },
    { id: 'kimi-coding', enabled: true },
  ], 123, undefined, discovered);

  assert.deepEqual(snapshot.providers.map((p) => p.id), ['deepseek', 'chatgpt']);
  assert.deepEqual(snapshot.catalog.map((c) => c.id), ['deepseek', 'chatgpt', 'cursor', 'kimi-coding']);
  assert.deepEqual(snapshot.providerOrder, [
    { id: 'deepseek', enabled: true },
    { id: 'cursor', enabled: true },
    { id: 'kimi-coding', enabled: true },
  ]);
  const cursor = snapshot.catalog.find((c) => c.id === 'cursor')!;
  assert.equal(cursor.configured, false);
  assert.equal(cursor.authMode, 'native');
  assert.ok(cursor.description.length > 0);
});

test('catalog projects discovered auth status and attaches quota by id', () => {
  const discovered: ProviderAuthStatus[] = [
    { id: 'deepseek', displayName: 'DeepSeek', configured: true, authMode: 'environment' },
    { id: 'kimi-coding', displayName: 'Kimi Coding', configured: false, authMode: 'api-key' },
  ];
  const snapshot = projectQuotaSnapshot(providers, [{ id: 'deepseek', enabled: true }], 1, undefined, discovered);

  const deepseek = snapshot.catalog.find((c) => c.id === 'deepseek')!;
  assert.equal(deepseek.configured, true);
  assert.equal(deepseek.authMode, 'environment');
  assert.equal(deepseek.label, 'DeepSeek');
  assert.ok(deepseek.setupHint.length > 0);
  assert.deepEqual(deepseek.quota?.balances, [{ currency: 'CNY', amount: '12.50', display: '¥12.50' }]);

  const kimi = snapshot.catalog.find((c) => c.id === 'kimi-coding')!;
  assert.equal(kimi.configured, false);
  assert.equal(kimi.authMode, 'api-key');
  assert.equal(kimi.quota, undefined);
});

test('catalog projects discovered model id/displayName choices without extra fields', () => {
  const discovered: ProviderAuthStatus[] = [
    {
      id: 'deepseek',
      displayName: 'DeepSeek',
      configured: true,
      authMode: 'environment',
      models: [
        { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
      ],
    },
    {
      id: 'kimi-coding',
      displayName: 'Kimi Coding',
      configured: false,
      authMode: 'api-key',
      models: [{ id: 'kimi-k2.5', displayName: 'Kimi K2.5', endpoint: 'must-not-leak' } as { id: string; displayName: string }],
    },
    { id: 'cursor', displayName: 'Cursor', configured: false, authMode: 'native' },
  ];
  const snapshot = projectQuotaSnapshot(providers, [{ id: 'deepseek', enabled: true }], 1, undefined, discovered);
  const deepseek = snapshot.catalog.find((entry) => entry.id === 'deepseek')!;
  assert.deepEqual(deepseek.models, [
    { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
  ]);
  const kimi = snapshot.catalog.find((entry) => entry.id === 'kimi-coding')!;
  assert.deepEqual(kimi.models, [{ id: 'kimi-k2.5', displayName: 'Kimi K2.5' }]);
  assert.equal(JSON.stringify(kimi.models).includes('endpoint'), false);
  assert.equal(JSON.stringify(kimi.models).includes('must-not-leak'), false);
  const cursor = snapshot.catalog.find((entry) => entry.id === 'cursor')!;
  assert.deepEqual(cursor.models, []);
});

test('successful runtime quota overrides a false native discovery result', () => {
  const cursor: QuotaProviderState = {
    ...providers[0],
    id: 'cursor',
    label: 'Cursor',
    displayLine: 'Cursor 95% remain · Other 72% remain',
    bars: {
      remainingPct: null,
      expectedRemainingPct: null,
      windows: [
        { name: 'Cursor', usedPct: 5, remainingPct: 95, expectedRemainingPct: null },
        { name: 'Other', usedPct: 28, remainingPct: 72, expectedRemainingPct: null },
      ],
    },
  };
  const authRequired: QuotaProviderState = {
    id: 'super-grok',
    label: 'SuperGrok',
    status: 'unavailable',
    stale: false,
    displayLine: null,
    error: 'runtime detail must not surface',
    code: 'authentication_required',
  };
  const snapshot = projectQuotaSnapshot(
    [providers[0], cursor, authRequired],
    [
      { id: 'chatgpt', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'super-grok', enabled: true },
    ],
    1,
    undefined,
    [
      { id: 'chatgpt', displayName: 'ChatGPT', configured: false, authMode: 'native' },
      { id: 'cursor', displayName: 'Cursor', configured: false, authMode: 'native' },
      { id: 'super-grok', displayName: 'SuperGrok', configured: true, authMode: 'native' },
    ],
  );

  assert.deepEqual(snapshot.providers.map((provider) => provider.id), ['chatgpt', 'cursor']);
  assert.equal(snapshot.catalog.find((entry) => entry.id === 'chatgpt')?.configured, true);
  assert.equal(snapshot.catalog.find((entry) => entry.id === 'cursor')?.configured, true);
  assert.equal(snapshot.catalog.find((entry) => entry.id === 'super-grok')?.configured, false);
});

test('catalog migrates legacy xai state and presents the SpaceXAI provider name', () => {
  const snapshot = projectQuotaSnapshot([], [{ id: 'xai', enabled: true }], 1, undefined, [
    { id: 'xai', displayName: 'SpaceXAI', configured: true, authMode: 'native' },
    { id: 'spacex-ai', displayName: 'SpaceXAI', configured: false, authMode: 'native' },
  ]);

  assert.deepEqual(snapshot.providerOrder, [{ id: 'spacex-ai', enabled: true }]);
  assert.deepEqual(snapshot.providers, []);
  const row = snapshot.catalog.find((entry) => entry.id === 'spacex-ai')!;
  assert.equal(row.label, 'SpaceXAI');
  assert.equal(row.configured, true);
  assert.equal(snapshot.catalog.some((entry) => entry.id === 'xai'), false);
});

test('catalog keeps unknown/custom providers visible with generic copy', () => {
  const snapshot = projectQuotaSnapshot([], [{ id: 'my-custom-pool', enabled: true }], undefined, undefined, [
    { id: 'my-custom-pool', configured: true, authMode: 'none' },
  ]);
  const row = snapshot.catalog.find((c) => c.id === 'my-custom-pool')!;
  assert.equal(row.label, 'my-custom-pool');
  assert.equal(row.authMode, 'none');
  assert.equal(row.configured, true);
  assert.ok(row.description.length > 0);
});

test('catalog mutes an undiscovered custom provider without quota evidence', () => {
  const snapshot = projectQuotaSnapshot([], [{ id: 'my-custom-pool', enabled: true }]);
  const row = snapshot.catalog.find((c) => c.id === 'my-custom-pool')!;
  assert.equal(row.authMode, 'none');
  assert.equal(row.configured, false);
});

test('catalog configuration modes follow product rules for kimi/glm/deepseek/native', () => {
  const discovered: ProviderAuthStatus[] = [
    { id: 'kimi-coding', configured: false, authMode: 'api-key' },
    { id: 'zhipu-coding', configured: true, authMode: 'api-key' },
    { id: 'deepseek', configured: true, authMode: 'environment' },
    { id: 'chatgpt', configured: false, authMode: 'native' },
    { id: 'super-grok', configured: false, authMode: 'native' },
  ];
  const snapshot = projectQuotaSnapshot(providers, [], undefined, undefined, discovered);
  const byId = new Map(snapshot.catalog.map((c) => [c.id, c]));
  assert.equal(byId.get('kimi-coding')!.authMode, 'api-key');
  assert.equal(byId.get('zhipu-coding')!.authMode, 'api-key');
  assert.equal(byId.get('deepseek')!.authMode, 'environment');
  assert.equal(byId.get('chatgpt')!.authMode, 'native');
  assert.equal(byId.get('super-grok')!.authMode, 'native');
});

test('quota projection never exposes raw provider failures to product surfaces', () => {
  const failedProviders: QuotaProviderState[] = [
    {
      id: 'anthropic',
      label: 'Anthropic',
      status: 'error',
      stale: false,
      displayLine: 'all claude sources exhausted (empty cache)',
      error: 'all claude sources exhausted (empty cache; keychain auto-acquire will fire on next attempt)',
    },
    {
      id: 'super-grok',
      label: 'SuperGrok',
      status: 'unavailable',
      stale: false,
      displayLine: null,
      error: 'Grok 登录已失效，请重新登录。',
      code: 'authentication_required',
    },
  ];
  const discovered: ProviderAuthStatus[] = [
    { id: 'anthropic', configured: false, authMode: 'native' },
    { id: 'super-grok', configured: true, authMode: 'native' },
  ];

  const snapshot = projectQuotaSnapshot(failedProviders, [
    { id: 'anthropic', enabled: true },
    { id: 'super-grok', enabled: true },
  ], 1, undefined, discovered);

  assert.equal(JSON.stringify(snapshot).includes('all claude sources exhausted'), false);
  assert.equal(JSON.stringify(snapshot).includes('Grok 登录已失效'), false);
  assert.deepEqual(snapshot.providers, []);

  const anthropic = snapshot.catalog.find((entry) => entry.id === 'anthropic')!;
  assert.equal(anthropic.configured, false);
  assert.equal(anthropic.quota?.message, '尚未登录，请完成登录后刷新。');

  const superGrok = snapshot.catalog.find((entry) => entry.id === 'super-grok')!;
  assert.equal(superGrok.configured, false);
  assert.equal(superGrok.authMode, 'native');
  assert.equal(superGrok.quota?.code, 'authentication_required');
  assert.equal(superGrok.quota?.message, '登录已失效，请重新登录后刷新。');
});

test('SuperGrok distinguishes missing configuration from expired login and query failure', () => {
  const makeProvider = (code: string): QuotaProviderState => ({
    id: 'super-grok',
    label: 'SuperGrok',
    status: code === 'quota_query_failed' ? 'error' : 'unavailable',
    stale: false,
    displayLine: null,
    error: 'runtime detail must not surface',
    code,
  });
  const discovered: ProviderAuthStatus[] = [
    { id: 'super-grok', displayName: 'SuperGrok', configured: true, authMode: 'native' },
  ];

  const missing = projectQuotaSnapshot([makeProvider('configuration_missing')], [{ id: 'super-grok', enabled: true }], undefined, undefined, discovered);
  assert.deepEqual(missing.providers, []);
  assert.equal(missing.catalog[0].configured, false);
  assert.equal(missing.catalog[0].authMode, 'native');
  assert.equal(missing.catalog[0].quota?.message, '尚未配置，请先完成 Grok 登录。');

  const expired = projectQuotaSnapshot([makeProvider('authentication_required')], [{ id: 'super-grok', enabled: true }], undefined, undefined, discovered);
  assert.deepEqual(expired.providers, []);
  assert.equal(expired.catalog[0].configured, false);
  assert.equal(expired.catalog[0].quota?.message, '登录已失效，请重新登录后刷新。');

  const failed = projectQuotaSnapshot([makeProvider('quota_query_failed')], [{ id: 'super-grok', enabled: true }], undefined, undefined, discovered);
  assert.deepEqual(failed.providers.map((provider) => provider.id), ['super-grok']);
  assert.equal(failed.catalog[0].configured, true);
  assert.equal(failed.catalog[0].quota?.message, '额度查询失败，请稍后刷新。');
  assert.equal(JSON.stringify(failed).includes('runtime detail'), false);
});

test('observed CodeBuddy exhaustion projects friendly message and a 0% bar', () => {
  const observed: QuotaProviderState = {
    id: 'codebuddy',
    label: 'CodeBuddy',
    status: 'ok',
    stale: false,
    displayLine: 'CodeBuddy 1mo 0% remain · 16d 14h reset',
    error: 'CodeBuddy 本月计费周期额度已耗尽，将于 2026-09-01 00:00 重置，请下月再试。',
    bars: {
      remainingPct: null,
      expectedRemainingPct: null,
      windows: [{ name: '1mo', usedPct: 100, remainingPct: 0, expectedRemainingPct: null }],
    },
  };
  const snapshot = projectQuotaSnapshot([observed], [{ id: 'codebuddy', enabled: true }], 1);
  assert.equal(snapshot.providers.length, 1);
  const row = snapshot.providers[0];
  assert.equal(row.id, 'codebuddy');
  assert.equal(row.status, 'ok');
  assert.ok(row.message?.includes('本月计费周期额度已耗尽'));
  assert.ok(row.displayLine?.includes('0% remain'));
  assert.deepEqual(row.windows, [{ name: '1mo', remainingPct: 0, expectedRemainingPct: null }]);
});

test('legacy codebuddy-* ids collapse into one canonical provider with no IOA text', () => {
  const discovered: ProviderAuthStatus[] = [
    { id: 'codebuddy-ioa', displayName: 'CodeBuddy', configured: true, authMode: 'native' },
    { id: 'codebuddy-local', displayName: 'CodeBuddy', configured: false, authMode: 'native' },
  ];
  const snapshot = projectQuotaSnapshot(
    [{
      id: 'codebuddy-ioa',
      label: 'CodeBuddy',
      status: 'ok',
      stale: false,
      displayLine: 'CodeBuddy 1mo 0% remain · reset',
      error: null,
    }],
    [
      { id: 'codebuddy', enabled: true },
      { id: 'codebuddy-ioa', enabled: true },
    ],
    1,
    undefined,
    discovered,
  );

  assert.deepEqual(snapshot.providers.map((p) => p.id), ['codebuddy']);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('codebuddy-'), false);
  assert.equal(serialized.toLowerCase().includes('ioa'), false);

  const catalog = snapshot.catalog.find((c) => c.id === 'codebuddy')!;
  assert.equal(catalog.configured, true);
  assert.equal(catalog.authMode, 'native');
  assert.equal(catalog.label, 'CodeBuddy');
  assert.equal(snapshot.catalog.filter((c) => c.id === 'codebuddy').length, 1);
});

test('duplicate codebuddy discovery merges with configured=true winning', () => {
  const discovered: ProviderAuthStatus[] = [
    { id: 'codebuddy', configured: false, authMode: 'native' },
    { id: 'codebuddy-ioa', configured: true, authMode: 'native' },
  ];
  const snapshot = projectQuotaSnapshot([], [], 1, undefined, discovered);
  const rows = snapshot.catalog.filter((c) => c.id === 'codebuddy');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].configured, true);
  assert.equal(rows[0].authMode, 'native');
});

test('connected CodeBuddy with no observation says quota lookup is unavailable', () => {
  const discovered: ProviderAuthStatus[] = [{ id: 'codebuddy', configured: true, authMode: 'native' }];
  const snapshot = projectQuotaSnapshot([], [{ id: 'codebuddy', enabled: true }], 1, undefined, discovered);
  assert.deepEqual(snapshot.providers, []);
  assert.equal(snapshot.catalog[0].configured, true);
  assert.equal(snapshot.catalog[0].quota, undefined);
});

test('controller sends Pet only the active quota subset in provider order', async (t) => {
  const missingSuperGrok: QuotaProviderState = {
    id: 'super-grok',
    label: 'SuperGrok',
    status: 'unavailable',
    stale: false,
    displayLine: null,
    error: 'not configured',
    code: 'configuration_missing',
  };
  let projected: QuotaProviderState[] = [];
  const controller = new DesktopQuotaController({
    source: { listProviders: async () => [providers[0], missingSuperGrok, providers[1]] },
    providerSource: {
      listProviders: async () => [
        { id: 'chatgpt', configured: true, authMode: 'native' },
        { id: 'super-grok', configured: false, authMode: 'native' },
        { id: 'deepseek', configured: true, authMode: 'environment' },
      ],
    },
    getProviderOrder: () => [
      { id: 'deepseek', enabled: false },
      { id: 'super-grok', enabled: true },
      { id: 'chatgpt', enabled: true },
    ],
    onChanged: (_snapshot, next) => { projected = next; },
    refreshIntervalMs: 60_000,
  });
  t.after(() => controller.stop());

  const snapshot = await controller.start();

  assert.deepEqual(snapshot.providers.map((provider) => provider.id), ['deepseek', 'chatgpt']);
  assert.deepEqual(projected.map((provider) => provider.id), ['deepseek', 'chatgpt']);
});
