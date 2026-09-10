import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltinCatalog,
  createBuiltinProviderRuntime,
  deriveTaskDispatchPlans,
  resolveRuntimeTaskPlans,
  upstreamAuthHeaders,
} from '../src/index.ts';

const codeBuddyAttributes = {
  internalDomain: ['internal.test', '*.shared.test'],
  iOADomain: ['ioa.test', 'tenant.*.test', 'team.shared.test'],
  cloudHostedDomain: ['*.cloud.test'],
  externalDomain: ['external.test'],
};

function codeBuddyRuntime(domain?: string, attributes: unknown = codeBuddyAttributes) {
  return createBuiltinProviderRuntime({
    home: '/native-home',
    codeBuddyProductPath: '/client/product.json',
    readFile: async (path) => {
      if (path === '/client/product.json') {
        return JSON.stringify({ authentication: { attributes } });
      }
      return JSON.stringify({ auth: { accessToken: 'native-codebuddy-token', ...(domain ? { domain } : {}) } });
    },
  });
}

const codeBuddyAuthFilePattern = /CodeBuddyExtension.*Tencent-Cloud\.coding-copilot\.info/u;

function codeBuddyAuthReadCount(requestedPaths: readonly string[]): number {
  return requestedPaths.reduce((count, path) => (codeBuddyAuthFilePattern.test(path) ? count + 1 : count), 0);
}

function codeBuddySnapshotAuth(overrides: Record<string, unknown> = {}) {
  const { account: accountOverride, ...authOverrides } = overrides;
  const account = Object.prototype.hasOwnProperty.call(overrides, 'account')
    ? accountOverride
    : {
        uid: 'u-1024',
        enterpriseId: 'e-2048',
        accountType: 'tenant',
        idp: 'ioa-idp',
      };
  return {
    auth: {
      accessToken: 'native-codebuddy-token',
      refreshToken: 'native-codebuddy-refresh',
      expiresAt: 1_705_000_000,
      domain: 'ioa.test',
      ...authOverrides,
    },
    ...(account === undefined ? {} : { account }),
  };
}

function codeBuddySnapshotRuntime(authState: Record<string, unknown>, attributes: unknown = codeBuddyAttributes) {
  const requestedPaths: string[] = [];
  const runtime = createBuiltinProviderRuntime({
    home: '/native-home',
    codeBuddyProductPath: '/client/product.json',
    readFile: async (path: string) => {
      requestedPaths.push(path);
      if (path === '/client/product.json') {
        return JSON.stringify({ authentication: { attributes } });
      }
      return JSON.stringify(authState);
    },
  });
  return { runtime, requestedPaths };
}

async function loadCodeBuddySnapshot(auth: Record<string, unknown>, attributes: unknown = codeBuddyAttributes) {
  const { runtime, requestedPaths } = codeBuddySnapshotRuntime(auth, attributes);
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const snapshot = await runtime.codeBuddySnapshot?.(provider);
  assert.ok(snapshot, 'expected a CodeBuddy snapshot');
  return { runtime, snapshot: snapshot!, requestedPaths };
}

test('forge-managed credentials are read without being projected into catalog data', async () => {
  const runtime = createBuiltinProviderRuntime({
    env: { XDG_DATA_HOME: '/data' }, home: '/home',
    readFile: async () => JSON.stringify({ openai: { key: 'secret' } }),
  });
  const provider = createBuiltinCatalog().provider('openai')!;
  const credential = await runtime.credential(provider);
  assert.equal(credential?.value, 'secret');
  assert.equal(upstreamAuthHeaders(provider, credential!, 'openai_chat').get('authorization'), 'Bearer secret');
});

test('CodeBuddy reuses the native nested access token without a managed credential store', async () => {
  const requestedPaths: string[] = [];
  const runtime = createBuiltinProviderRuntime({
    home: '/native-home',
    readFile: async (path) => {
      requestedPaths.push(path);
      return JSON.stringify({ auth: { accessToken: 'native-codebuddy-token' } });
    },
  });
  const provider = createBuiltinCatalog().provider('codebuddy')!;

  assert.deepEqual(await runtime.credential(provider), { value: 'native-codebuddy-token' });
  assert.ok(requestedPaths.some((path) => /CodeBuddyExtension.*Tencent-Cloud\.coding-copilot\.info/u.test(path)));
  assert.equal(
    upstreamAuthHeaders(provider, { value: 'native-codebuddy-token' }, 'openai_chat').get('authorization'),
    'Bearer native-codebuddy-token',
  );
  await assert.rejects(() => runtime.configureApiKey(provider, 'replacement'), /does not accept a managed API key/u);
});

test('CodeBuddy keeps the legacy flat native token shape as a read-only fallback', async () => {
  const runtime = createBuiltinProviderRuntime({
    home: '/native-home',
    readFile: async () => JSON.stringify({ 'auth.accessToken': 'flat-codebuddy-token' }),
  });
  const provider = createBuiltinCatalog().provider('codebuddy')!;

  assert.deepEqual(await runtime.credential(provider), { value: 'flat-codebuddy-token' });
});

test('CodeBuddy iOA routing uses the bundled domain matcher and only the four confirmed upstream ids', async () => {
  const runtime = codeBuddyRuntime('tenant.alpha.test');
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const credential = await runtime.credential(provider);
  assert.ok(credential);

  assert.deepEqual(Object.fromEntries([
    'deepseek-v4.1-flash',
    'hy4-preview',
    'hy3',
    'minimax-m3',
  ].map((model) => [model, runtime.resolveUpstreamModel(provider, model, credential)])), {
    'deepseek-v4.1-flash': 'deepseek-v4.1-flash-ioa',
    'hy4-preview': 'hy4-preview-ioa',
    'hy3': 'hy3-ioa',
    'minimax-m3': 'minimax-m3-ioa',
  });
  for (const model of ['kimi-k3', 'glm-5.3', 'glm-5.3-flash']) {
    assert.equal(runtime.resolveUpstreamModel(provider, model, credential), model);
  }
  assert.equal(
    runtime.publicResponseModel(provider, 'hy4-preview-ioa', 'hy4-preview-ioa', 'codebuddy/hy4-preview'),
    'codebuddy/hy4-preview',
  );
  assert.equal(
    runtime.publicResponseModel(provider, 'hy4-preview', 'hy4-preview-ioa', 'codebuddy/hy4-preview'),
    'codebuddy/hy4-preview',
  );
  assert.equal(
    runtime.publicResponseModel(provider, 'hy3', 'hy3-ioa', 'codebuddy/hy3'),
    'codebuddy/hy3',
  );
  assert.equal(
    runtime.publicResponseModel(provider, 'provider-changed-model', 'hy4-preview-ioa', 'codebuddy/hy4-preview'),
    'provider-changed-model',
  );
});

test('CodeBuddy non-iOA, unknown, missing configuration, and official priority keep logical ids', async () => {
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  for (const runtime of [
    codeBuddyRuntime('external.test'),
    codeBuddyRuntime('unknown.test'),
    codeBuddyRuntime(),
    codeBuddyRuntime('team.shared.test'),
    codeBuddyRuntime('ioa.test', null),
  ]) {
    const credential = await runtime.credential(provider);
    assert.ok(credential);
    assert.equal(runtime.resolveUpstreamModel(provider, 'hy4-preview', credential), 'hy4-preview');
    assert.equal(runtime.resolveUpstreamModel(provider, 'hy3', credential), 'hy3');
  }
});

test('runtime task plans compile canonical targets and keep CodeBuddy iOA remap runtime-owned', async () => {
  const catalog = createBuiltinCatalog();
  const runtime = codeBuddyRuntime('ioa.test');
  // Logical plan identity stays canonical (public names) before any runtime remap.
  const logical = deriveTaskDispatchPlans(catalog);
  assert.equal(logical['codebuddy/hy4-preview:cb']?.model, 'hy4-preview');
  assert.equal(logical['codebuddy/hy3:cb']?.model, 'hy3');
  assert.equal(logical['codebuddy/deepseek-v4.1-flash:cb']?.model, 'deepseek-v4.1-flash');
  assert.equal(logical['codebuddy/deepseek-v4-pro:cb'], undefined);
  assert.equal(logical['codebuddy/deepseek-v4-flash:cb'], undefined);
  assert.equal(logical['codebuddy/minimax-m3:cb']?.model, 'minimax-m3');
  assert.equal(logical['codebuddy/kimi-k3:cb']?.model, 'kimi-k3');
  assert.equal(logical['codebuddy/glm-5.3:cb']?.model, 'glm-5.3');
  assert.equal(logical['codebuddy/glm-5.3-flash:cb']?.model, 'glm-5.3-flash');

  const plans = await resolveRuntimeTaskPlans(catalog, runtime);
  assert.equal(plans['codebuddy/hy4-preview:cb']?.model, 'hy4-preview-ioa');
  assert.equal(plans['codebuddy/hy3:cb']?.model, 'hy3-ioa');
  assert.equal(plans['codebuddy/deepseek-v4.1-flash:cb']?.model, 'deepseek-v4.1-flash-ioa');
  assert.equal(plans['codebuddy/deepseek-v4-pro:cb'], undefined);
  assert.equal(plans['codebuddy/deepseek-v4-flash:cb'], undefined);
  assert.equal(plans['codebuddy/minimax-m3:cb']?.model, 'minimax-m3-ioa');
  assert.equal(plans['codebuddy/kimi-k3:cb']?.model, 'kimi-k3');
  assert.equal(plans['codebuddy/glm-5.3:cb']?.model, 'glm-5.3');
  assert.equal(plans['codebuddy/glm-5.3-flash:cb']?.model, 'glm-5.3-flash');
  // Canonical target keys are preserved through the runtime remap.
  assert.deepEqual(Object.keys(plans), Object.keys(logical));
  // The private iOA suffix never leaks into public plan keys.
  assert.ok(!Object.keys(logical).some((key) => key.includes('hy3-ioa')));
  assert.ok(!Object.keys(plans).some((key) => key.includes('hy3-ioa')));
});

test('CodeBuddy iOA credentials confirm free only for the exact verified HY3/HY4 canonical and wire models', async () => {
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const eligibleModels = ['hy3', 'hy4-preview', 'hy3-ioa', 'hy4-preview-ioa'];
  for (const domain of ['ioa.test', 'tenant.alpha.test']) {
    const runtime = codeBuddyRuntime(domain);
    const credential = await runtime.credential(provider);
    assert.ok(credential, `expected a credential for ${domain}`);
    for (const model of eligibleModels) {
      const fact: ReturnType<NonNullable<typeof runtime.freeSupply>> = runtime.freeSupply?.(provider, model, credential!);
      assert.ok(fact, `expected a confirmed-free fact for ${domain} / ${model}`);
      assert.equal(fact!.confirmedFree, true);
      assert.equal(fact!.source, 'codebuddy.credential_environment');
      assert.equal(fact!.ruleId, 'codebuddy.verified_hy_model_confirmed_free');
      // Canonical ids and their already-mapped wire ids share the exact same
      // eligibility because both flow through the same upstream mapping helper.
      if (model === 'hy3' || model === 'hy4-preview') {
        assert.equal(runtime.resolveUpstreamModel(provider, model, credential!), `${model}-ioa`);
      }
      // Privacy-safe: no token, no account/environment domain, no wire suffix.
      const serialized = JSON.stringify(fact);
      assert.ok(!serialized.includes('native-codebuddy-token'), 'fact must not expose the token');
      assert.ok(!serialized.includes(domain.replace('*', '')), 'fact must not expose the domain');
      assert.ok(!serialized.includes('-ioa'), 'fact must not expose the wire suffix');
    }
  }
});

test('CodeBuddy paid, unrecognized, and empty models are never free even under an iOA credential', async () => {
  const runtime = codeBuddyRuntime('ioa.test');
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const credential = await runtime.credential(provider);
  assert.ok(credential);
  for (const model of [
    'deepseek-v4-flash',
    'deepseek-v4-flash-ioa',
    'deepseek-v4-pro',
    'deepseek-v4-pro-ioa',
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-ioa',
    'glm-5.3',
    'glm-5.3-flash',
    'kimi-k3',
    'minimax-m3',
    'minimax-m3-ioa',
    '',
    'hy3-preview',
    'hy5-preview',
  ]) {
    assert.equal(runtime.freeSupply?.(provider, model, credential!), undefined, JSON.stringify(model));
  }
});

test('CodeBuddy HY3/HY4 are never free for non-iOA environments, foreign credentials, or other providers', async () => {
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const models = ['hy3', 'hy4-preview', 'hy3-ioa', 'hy4-preview-ioa'];
  const scenarios: Array<[string, ReturnType<typeof codeBuddyRuntime>]> = [
    ['internal', codeBuddyRuntime('internal.test')],
    ['internal wildcard', codeBuddyRuntime('api.shared.test')],
    ['team internal', codeBuddyRuntime('team.shared.test')],
    ['cloudhosted', codeBuddyRuntime('prod.cloud.test')],
    ['external', codeBuddyRuntime('external.test')],
    ['unknown domain', codeBuddyRuntime('unknown.test')],
    ['missing attributes', codeBuddyRuntime('ioa.test', null)],
    ['missing domain', codeBuddyRuntime()],
  ];
  for (const [name, runtime] of scenarios) {
    const credential = await runtime.credential(provider);
    assert.ok(credential, name);
    for (const model of models) {
      assert.equal(runtime.freeSupply?.(provider, model, credential!), undefined, `${name} / ${model}`);
    }
  }

  // The classification is tied to the loaded credential object: an iOA-loaded
  // credential is not free on a runtime whose credential loaded as external,
  // and vice versa.
  const ioaRuntime = codeBuddyRuntime('ioa.test');
  const ioaCredential = await ioaRuntime.credential(provider);
  assert.ok(ioaCredential);
  const externalRuntime = codeBuddyRuntime('external.test');
  const externalCredential = await externalRuntime.credential(provider);
  assert.ok(externalCredential);
  for (const model of models) {
    assert.equal(ioaRuntime.freeSupply?.(provider, model, externalCredential!), undefined, model);
    assert.equal(externalRuntime.freeSupply?.(provider, model, ioaCredential!), undefined, model);
  }

  // Missing credential: no registered classification -> undefined.
  for (const model of models) {
    assert.equal(ioaRuntime.freeSupply?.(provider, model, { value: 'never-loaded-token' }), undefined, model);
  }

  // Every other provider returns undefined regardless of credential/model.
  const openaiProvider = createBuiltinCatalog().provider('openai')!;
  for (const model of models) {
    assert.equal(ioaRuntime.freeSupply?.(openaiProvider, model, ioaCredential!), undefined, model);
  }
});

test('CodeBuddy snapshot reads the auth file exactly once and binds coherent read-free decisions', async () => {
  const { runtime, snapshot, requestedPaths } = await loadCodeBuddySnapshot(codeBuddySnapshotAuth());
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  assert.equal(await runtime.codeBuddySnapshot?.({ ...provider, id: 'foreign-codebuddy-resolver' }), undefined);
  assert.equal(snapshot.environment, 'ioa');
  assert.equal(codeBuddyAuthReadCount(requestedPaths), 1);
  assert.equal(snapshot.resolveUpstreamModel('hy3'), 'hy3-ioa');
  assert.equal(snapshot.resolveUpstreamModel('hy4-preview'), 'hy4-preview-ioa');
  for (let i = 0; i < 20; i += 1) {
    snapshot.resolveUpstreamModel('hy3');
    snapshot.resolveUpstreamModel('kimi-k3');
    snapshot.freeSupply('hy3');
    snapshot.freeSupply('hy4-preview-ioa');
    snapshot.freeSupply('deepseek-v4-flash');
  }
  assert.equal(codeBuddyAuthReadCount(requestedPaths), 1);
  // Snapshot decisions never diverge from the runtime surface for the same credential.
  assert.equal(snapshot.resolveUpstreamModel('hy3'), runtime.resolveUpstreamModel(provider, 'hy3', snapshot.credential));
  assert.equal(
    snapshot.freeSupply('hy4-preview')?.ruleId,
    runtime.freeSupply?.(provider, 'hy4-preview', snapshot.credential)?.ruleId,
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.credential), true);
});

test('CodeBuddy snapshot maps the exact IOA table and is free only for HY3/HY4 canonical and wire ids', async () => {
  const { snapshot } = await loadCodeBuddySnapshot(codeBuddySnapshotAuth());
  assert.deepEqual(Object.fromEntries([
    'deepseek-v4.1-flash',
    'hy4-preview',
    'hy3',
    'minimax-m3',
  ].map((model) => [model, snapshot.resolveUpstreamModel(model)])), {
    'deepseek-v4.1-flash': 'deepseek-v4.1-flash-ioa',
    'hy4-preview': 'hy4-preview-ioa',
    'hy3': 'hy3-ioa',
    'minimax-m3': 'minimax-m3-ioa',
  });
  for (const model of [
    'deepseek-v4.1-flash-ioa',
    'hy4-preview-ioa',
    'hy3-ioa',
    'minimax-m3-ioa',
  ]) {
    assert.equal(snapshot.resolveUpstreamModel(model), model);
  }
  for (const model of ['hy3', 'hy4-preview', 'hy3-ioa', 'hy4-preview-ioa']) {
    const fact = snapshot.freeSupply(model);
    assert.ok(fact, model);
    assert.equal(fact!.confirmedFree, true);
    assert.equal(fact!.source, 'codebuddy.credential_environment');
    assert.equal(fact!.ruleId, 'codebuddy.verified_hy_model_confirmed_free');
  }
  for (const model of [
    'deepseek-v4-flash',
    'deepseek-v4-flash-ioa',
    'deepseek-v4-pro',
    'deepseek-v4-pro-ioa',
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-ioa',
    'glm-5.3',
    'glm-5.3-flash',
    'kimi-k3',
    'minimax-m3',
    'minimax-m3-ioa',
    '',
    'hy3-preview',
    'hy5-preview',
  ]) {
    assert.equal(snapshot.freeSupply(model), undefined, JSON.stringify(model));
  }
});

test('CodeBuddy snapshot never maps or frees for internal, cloudhosted, external, or unknown environments', async () => {
  const scenarios: Array<[string, string, string]> = [
    ['internal', 'internal.test', 'internal'],
    ['cloudhosted', 'prod.cloud.test', 'cloudhosted'],
    ['external', 'external.test', 'external'],
    ['unknown domain', 'unknown.test', 'unknown'],
  ];
  for (const [name, domain, environment] of scenarios) {
    const { snapshot } = await loadCodeBuddySnapshot(codeBuddySnapshotAuth({ domain }));
    assert.equal(snapshot.environment, environment, name);
    assert.equal(snapshot.resolveUpstreamModel('hy4-preview'), 'hy4-preview', name);
    assert.equal(snapshot.resolveUpstreamModel('hy3'), 'hy3', name);
    for (const model of ['hy3', 'hy4-preview', 'hy3-ioa', 'hy4-preview-ioa']) {
      assert.equal(snapshot.freeSupply(model), undefined, `${name} / ${model}`);
    }
  }
  // Same account/domain with attributes unavailable classify as unknown.
  const { snapshot: noAttributes } = await loadCodeBuddySnapshot(codeBuddySnapshotAuth(), null);
  assert.equal(noAttributes.environment, 'unknown');
  assert.equal(noAttributes.resolveUpstreamModel('hy4-preview'), 'hy4-preview');
  assert.equal(noAttributes.freeSupply('hy3'), undefined);
});

test('CodeBuddy snapshot scope is stable across token refresh and expiry while credentials rotate', async () => {
  const original = await loadCodeBuddySnapshot(codeBuddySnapshotAuth());
  const refreshed = await loadCodeBuddySnapshot(codeBuddySnapshotAuth({
    accessToken: 'rotated-access-token',
    refreshToken: 'rotated-refresh-token',
    expiresAt: 2_099_999_999,
  }));
  assert.notEqual(refreshed.snapshot.credential.value, original.snapshot.credential.value);
  assert.equal(refreshed.snapshot.environment, original.snapshot.environment);
  assert.ok(original.snapshot.stableScope);
  assert.equal(refreshed.snapshot.stableScope, original.snapshot.stableScope);
});

test('CodeBuddy snapshot scope changes when stable account id, domain, or environment changes', async () => {
  const base = (await loadCodeBuddySnapshot(codeBuddySnapshotAuth())).snapshot.stableScope!;
  const changedId = (await loadCodeBuddySnapshot(codeBuddySnapshotAuth({
    account: { uid: 'u-7777', enterpriseId: 'e-2048', accountType: 'tenant', idp: 'ioa-idp' },
  }))).snapshot.stableScope!;
  assert.notEqual(changedId, base);
  const changedDomain = (await loadCodeBuddySnapshot(codeBuddySnapshotAuth({
    domain: 'tenant.alpha.test',
  }))).snapshot.stableScope!;
  assert.notEqual(changedDomain, base);
  const changedEnvironment = (await loadCodeBuddySnapshot(codeBuddySnapshotAuth(), null)).snapshot.stableScope!;
  assert.notEqual(changedEnvironment, base);
});

test('CodeBuddy snapshot without a stable account id yields undefined scope yet keeps the credential usable', async () => {
  const { runtime, snapshot } = await loadCodeBuddySnapshot(codeBuddySnapshotAuth({ account: undefined }));
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  assert.equal(snapshot.credential.value, 'native-codebuddy-token');
  assert.equal(snapshot.environment, 'ioa');
  assert.equal(snapshot.stableScope, undefined);
  assert.equal(snapshot.resolveUpstreamModel('hy3'), 'hy3-ioa');
  assert.ok(snapshot.freeSupply('hy3'));
  assert.ok(runtime.freeSupply?.(provider, 'hy4-preview', snapshot.credential));
});

test('CodeBuddy snapshot scope is an opaque versioned digest free of raw account/domain text', async () => {
  const { snapshot } = await loadCodeBuddySnapshot(codeBuddySnapshotAuth());
  assert.ok(snapshot.stableScope);
  assert.match(snapshot.stableScope!, /^cbv1:[0-9a-f]{64}$/u);
  for (const raw of ['ioa.test', 'u-1024', 'e-2048', 'tenant', 'ioa-idp']) {
    assert.ok(!JSON.stringify(snapshot.stableScope).includes(raw), `scope must not include ${raw}`);
    assert.ok(!JSON.stringify(snapshot).includes(raw), `snapshot must not include ${raw}`);
  }
});
