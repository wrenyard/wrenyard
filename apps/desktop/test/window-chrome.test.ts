import assert from 'node:assert/strict';
import { test } from 'node:test';
import { platformWindowChrome } from '../src/window-chrome.js';

test('Windows uses a themed hidden title bar overlay while other platforms keep native chrome', () => {
  assert.deepEqual(platformWindowChrome('win32'), {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#eee3ca',
      symbolColor: '#34291f',
      height: 32,
    },
  });
  assert.deepEqual(platformWindowChrome('darwin'), {});
  assert.deepEqual(platformWindowChrome('linux'), {});
});
