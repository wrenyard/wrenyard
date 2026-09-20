import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerKeyPageUrl } from '../src/shell-contract.js';

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
