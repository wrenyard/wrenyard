import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceleratorPage,
  isSettingsLaunchRequest,
  isShellPage,
} from '../src/shell-contract.js';

test('isShellPage accepts only product shell destinations', () => {
  assert.equal(isShellPage('workbench'), true);
  assert.equal(isShellPage('stats'), true);
  assert.equal(isShellPage('quota'), true);
  assert.equal(isShellPage('settings'), true);
  assert.equal(isShellPage('dsh-settings'), false);
  assert.equal(isShellPage('../settings'), false);
  assert.equal(isShellPage(null), false);
});

test('settings launch requests accept only the Desktop settings route', () => {
  assert.equal(isSettingsLaunchRequest('--settings'), true);
  assert.equal(isSettingsLaunchRequest('wrenyard://settings'), true);
  assert.equal(isSettingsLaunchRequest('wrenyard://settings/'), true);
  assert.equal(isSettingsLaunchRequest('wrenyard://settings?source=pet'), true);
  assert.equal(isSettingsLaunchRequest('wrenyard://workbench'), false);
  assert.equal(isSettingsLaunchRequest('wrenyard://settings/other'), false);
  assert.equal(isSettingsLaunchRequest('https://settings'), false);
  assert.equal(isSettingsLaunchRequest('not-a-url'), false);
});

test('acceleratorPage maps platform shortcuts to shell pages', () => {
  assert.equal(acceleratorPage({ key: ',', meta: true }, 'darwin'), 'settings');
  assert.equal(acceleratorPage({ key: '1', meta: true }, 'darwin'), 'workbench');
  assert.equal(acceleratorPage({ key: '2', meta: true }, 'darwin'), 'stats');
  assert.equal(acceleratorPage({ key: '3', meta: true }, 'darwin'), 'quota');
  assert.equal(acceleratorPage({ key: ',', control: true }, 'linux'), 'settings');
  assert.equal(acceleratorPage({ key: '1', control: true }, 'win32'), 'workbench');
  assert.equal(acceleratorPage({ key: ',', control: true }, 'darwin'), null);
  assert.equal(acceleratorPage({ key: '4', meta: true }, 'darwin'), null);
});
