import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog, createBuiltinProviderRuntime, upstreamAuthHeaders } from '../src/index.ts';

const provider = createBuiltinCatalog().provider('codebuddy')!;
function fixture(initial: Record<string, unknown>) {
  let state = initial;
  let reads = 0;
  const runtime = createBuiltinProviderRuntime({
    home: '/synthetic-home', codeBuddyProductPath: '/product.json',
    readFile: async (path) => {
      if (path === '/product.json') return JSON.stringify({ authentication: { attributes: { iOADomain: ['ioa.test'] } } });
      reads++;
      return JSON.stringify(state);
    },
  });
  return { runtime, reads: () => reads, replace: (next: Record<string, unknown>) => { state = next; } };
}
const login = (suffix: string) => ({ auth: { accessToken: `token-${suffix}`, domain: 'ioa.test' }, account: { uid: `uid-${suffix}`, enterpriseId: `enterprise-${suffix}` } });

test('CodeBuddy native headers stay bound to one credential without public account fields', async () => {
  const f = fixture(login('a'));
  const credential = (await f.runtime.credential(provider))!;
  f.replace(login('b'));
  const headers = upstreamAuthHeaders(provider, credential, 'openai_chat');
  assert.equal(headers.get('authorization'), 'Bearer token-a');
  assert.equal(headers.get('x-user-id'), 'uid-a');
  assert.equal(headers.get('x-enterprise-id'), 'enterprise-a');
  assert.equal(headers.get('x-tenant-id'), 'enterprise-a');
  assert.equal(headers.get('x-domain'), 'ioa.test');
  assert.equal(f.reads(), 1);
  assert.deepEqual(credential, { value: 'token-a' });
  const fresh = (await f.runtime.credential(provider))!;
  assert.equal(upstreamAuthHeaders(provider, fresh, 'openai_chat').get('x-user-id'), 'uid-b');
  assert.equal(headers.get('x-user-id'), 'uid-a');
});

test('active snapshots bind native headers to the same read and never serialize account identity', async () => {
  const f = fixture(login('snapshot'));
  const snapshot = (await f.runtime.codeBuddySnapshot!(provider))!;
  f.replace(login('changed'));
  assert.equal(upstreamAuthHeaders(provider, snapshot.credential, 'openai_chat').get('x-tenant-id'), 'enterprise-snapshot');
  assert.equal(f.reads(), 1);
  assert.equal(snapshot.resolveUpstreamModel('deepseek-v4.1-flash'), 'deepseek-v4.1-flash-ioa');
  assert.equal(snapshot.freeSupply('deepseek-v4.1-flash'), undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /uid-snapshot|enterprise-snapshot|ioa\.test/);
});

test('private CodeBuddy headers never cross into another provider or a copied credential', async () => {
  const f = fixture(login('private'));
  const credential = (await f.runtime.credential(provider))!;
  const other = createBuiltinCatalog().provider('openai')!;
  assert.equal(upstreamAuthHeaders(other, credential, 'openai_chat').get('x-user-id'), null);
  assert.equal(upstreamAuthHeaders(provider, { ...credential }, 'openai_chat').get('x-user-id'), null);
});

test('legacy native fields are supported while CRLF values are not emitted', async () => {
  const f = fixture({ 'auth.accessToken': 'flat-token', 'auth.domain': 'ioa.test', 'auth.uid': 'flat-user', 'auth.enterpriseId': 'bad\r\nInjected: value' });
  const credential = (await f.runtime.credential(provider))!;
  const headers = upstreamAuthHeaders(provider, credential, 'openai_chat');
  assert.equal(headers.get('x-user-id'), 'flat-user');
  assert.equal(headers.get('x-domain'), 'ioa.test');
  assert.equal(headers.get('x-enterprise-id'), null);
  assert.equal(headers.get('x-tenant-id'), null);
});
