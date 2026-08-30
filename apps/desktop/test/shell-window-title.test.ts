import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatShellWindowTitle } from '../src/shell-window-title.js';

const VERSION = '1.2.3-dev.4';

test('window titles keep the Desktop version visible on every page', () => {
  assert.equal(formatShellWindowTitle('workbench', VERSION), '啾啾工坊 v1.2.3-dev.4');
  assert.equal(formatShellWindowTitle('stats', VERSION), '工房台账 — 啾啾工坊 v1.2.3-dev.4');
  assert.equal(formatShellWindowTitle('quota', VERSION), '模型供应 — 啾啾工坊 v1.2.3-dev.4');
  assert.equal(formatShellWindowTitle('settings', VERSION), '设置 — 啾啾工坊 v1.2.3-dev.4');
});
