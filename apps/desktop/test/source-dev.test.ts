import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import {
  applySourceDevelopmentIdentity,
  CAPTURE_UI_SCRIPT,
  isSourceDevelopment,
  isSupervised,
  resolveSourceDesktopUserData,
  restoreUiScript,
} from '../src/source-dev.js';

test('source-development identity uses the installed product userData path', () => {
  assert.equal(isSourceDevelopment({}), false);
  assert.equal(isSourceDevelopment({ WRENYARD_SOURCE_DEV: '1' }), true);
  assert.equal(isSupervised({ WRENYARD_DEV_SUPERVISED: '1' }), true);
  const paths: string[] = [];
  const names: string[] = [];
  applySourceDevelopmentIdentity({
    setName(name) { names.push(name); },
    setPath(name, path) { paths.push(`${name}:${path}`); },
    getPath() { return 'C:\\Users\\me\\AppData\\Roaming'; },
  }, { WRENYARD_SOURCE_DEV: '1' }, 'win32');
  assert.deepEqual(names, ['啾啾工坊']);
  assert.equal(paths.some((entry) => entry.includes('啾啾工坊') && entry.startsWith('userData:')), true);
  const override = resolve('custom-user-data');
  assert.equal(
    resolveSourceDesktopUserData({ WRENYARD_DESKTOP_USER_DATA: override }, 'linux', '/home/me'),
    override,
  );
});

test('applySourceDevelopmentIdentity is a no-op without the source-dev flag', () => {
  let named = false;
  applySourceDevelopmentIdentity({
    setName() { named = true; },
    setPath() { named = true; },
    getPath() { return '/tmp'; },
  }, {}, 'darwin');
  assert.equal(named, false);
});

test('UI capture/restore never sends a message or reruns a task', () => {
  assert.match(CAPTURE_UI_SCRIPT, /conversation-input/);
  assert.doesNotMatch(CAPTURE_UI_SCRIPT, /sendConversation|createConversation|task\.run/);
  const script = restoreUiScript({ draft: 'hello', page: 'workbench', selectedSessionId: 's1' });
  assert.match(script, /hello/);
  assert.doesNotMatch(script, /sendConversation|click\(\)|task\.run/);
});
