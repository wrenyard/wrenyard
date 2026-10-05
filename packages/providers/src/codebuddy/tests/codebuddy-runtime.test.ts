import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog, createBuiltinProviderRuntime, upstreamAuthHeaders } from '../../index.ts';
import { createCodeBuddy, type CodeBuddyEnvironment } from '../index.ts';

/** A CodeBuddy provider wired from an injected install, as the daemon does. */
function fixture(environment: CodeBuddyEnvironment = 'ioa') {
  const codeBuddy = createCodeBuddy({
    product: {
      status: 'ready',
      environment,
      entries: [{ id: 'hy3-ioa', credits: 'x0 credits' }, { id: 'deepseek-v4.1-flash', credits: 'x0.5 credits' }],
      account: {
        accessToken: 'token-a',
        domain: 'ioa.test',
        stableScope: 'scope-a',
        headers: { 'X-User-Id': 'uid-a', 'X-Enterprise-Id': 'enterprise-a', 'X-Tenant-Id': 'enterprise-a', 'X-Domain': 'ioa.test' },
      },
    },
  });
  const catalog = createBuiltinCatalog([codeBuddy]);
  return {
    catalog,
    provider: catalog.provider('codebuddy')!,
    runtime: createBuiltinProviderRuntime({ providers: [codeBuddy] }),
  };
}

test('the injected login supplies the credential and its account headers', async () => {
  const { provider, runtime } = fixture();
  const credential = (await runtime.credential(provider))!;
  assert.deepEqual(credential, { value: 'token-a' });
  const headers = upstreamAuthHeaders(provider, credential, 'openai_chat');
  assert.equal(headers.get('authorization'), 'Bearer token-a');
  assert.equal(headers.get('x-user-id'), 'uid-a');
  assert.equal(headers.get('x-enterprise-id'), 'enterprise-a');
  assert.equal(headers.get('x-tenant-id'), 'enterprise-a');
  assert.equal(headers.get('x-domain'), 'ioa.test');
});

test('account headers never reach a copied credential or another provider', async () => {
  const { catalog, provider, runtime } = fixture();
  const credential = (await runtime.credential(provider))!;
  assert.equal(upstreamAuthHeaders(provider, { ...credential }, 'openai_chat').get('x-user-id'), null);
  const other = catalog.provider('deepseek')!;
  assert.equal(upstreamAuthHeaders(other, credential, 'openai_chat').get('x-user-id'), null);
});

test('the active snapshot maps offerings to their product wire ids without exposing the account', async () => {
  const { provider, runtime } = fixture();
  const snapshot = (await runtime.codeBuddySnapshot!(provider))!;
  assert.equal(snapshot.environment, 'ioa');
  assert.equal(snapshot.stableScope, 'scope-a');
  assert.equal(snapshot.resolveUpstreamModel('hunyuan-hy3'), 'hy3-ioa');
  assert.equal(snapshot.resolveUpstreamModel('deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.doesNotMatch(JSON.stringify(snapshot), /uid-a|enterprise-a|ioa\.test/);
});

test('a zero-credit product row is confirmed free only under the iOA environment', async () => {
  const ioa = fixture('ioa');
  const ioaSnapshot = (await ioa.runtime.codeBuddySnapshot!(ioa.provider))!;
  assert.equal(ioaSnapshot.freeSupply('hunyuan-hy3')?.confirmedFree, true);
  assert.equal(ioaSnapshot.freeSupply('deepseek-v4.1-flash'), undefined);

  const external = fixture('external');
  const externalSnapshot = (await external.runtime.codeBuddySnapshot!(external.provider))!;
  assert.equal(externalSnapshot.freeSupply('hunyuan-hy3'), undefined);
});
