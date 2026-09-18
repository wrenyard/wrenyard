import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_KEY_PAGE_URLS, providerKeyPageUrl } from '../src/shell-contract.js';

test('provider key page allowlist resolves only the two fixed official URLs', () => {
  assert.equal(providerKeyPageUrl('opencode-zen'), 'https://opencode.ai/auth');
  assert.equal(providerKeyPageUrl('openrouter'), 'https://openrouter.ai/settings/keys');
  assert.deepEqual(Object.keys(PROVIDER_KEY_PAGE_URLS), ['opencode-zen', 'openrouter']);
  assert.equal(PROVIDER_KEY_PAGE_URLS['opencode-zen'], 'https://opencode.ai/auth');
  assert.equal(PROVIDER_KEY_PAGE_URLS.openrouter, 'https://openrouter.ai/settings/keys');
});

test('provider key page allowlist rejects every other id and non-id input', () => {
  for (const id of [
    'opencode', 'zen', 'OpenRouter', 'OPENROUTER', 'openrouter ', ' openrouter',
    'openrouter.ai', 'https://openrouter.ai/settings/keys', 'https://evil.example/keys',
    'opencode-zen/../../evil', 'opencode-zen\u0000', 'anthropic', '', ' ', 'a'.repeat(512),
    '__proto__', 'constructor', 'toString',
  ]) {
    assert.equal(providerKeyPageUrl(id), null, `expected rejection for ${JSON.stringify(id)}`);
  }
  assert.equal(providerKeyPageUrl(undefined), null);
  assert.equal(providerKeyPageUrl(null), null);
  assert.equal(providerKeyPageUrl(123), null);
  assert.equal(providerKeyPageUrl({ id: 'openrouter' }), null);
  assert.equal(providerKeyPageUrl(['openrouter']), null);
});
