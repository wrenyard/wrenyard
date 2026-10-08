import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PREFERENCE_IDS,
  SHELL_CHANNELS,
  acceleratorPage,
  isSettingsLaunchRequest,
  isShellPage,
  type RuntimeAliasSnapshot,
  type TaskSettingsLayer,
  type TaskSettingsSnapshot,
  type UpdateSnapshot,
  type WrenyardShellApi,
} from '../src/shell-contract.js';

test('isShellPage accepts only product shell destinations', () => {
  assert.equal(isShellPage('session'), true);
  assert.equal(isShellPage('stats'), true);
  assert.equal(isShellPage('quota'), true);
  assert.equal(isShellPage('settings'), true);
  assert.equal(isShellPage('tasks'), true);
  assert.equal(isShellPage('workbench'), false);
  assert.equal(isShellPage('docs'), false);
  assert.equal(isShellPage('dsh-settings'), false);
  assert.equal(isShellPage('../settings'), false);
  assert.equal(isShellPage(null), false);
});

function emptyLayer(): TaskSettingsLayer {
  return {
    explicit_runtime: null,
    timeout_ms: null,
    automatic: null,
  };
}

function settingsSnapshot(revision: string): TaskSettingsSnapshot {
  return {
    config_path: '/machine-global/config.json',
    revision,
    user_global: emptyLayer(),
    rows: [],
    aliases: [],
  };
}

function aliasSnapshot(revision: string): RuntimeAliasSnapshot {
  return {
    revision,
    aliases: [
      { name: 'cc-fast', target: 'anthropic/claude-sonnet-4:cc' },
    ],
  };
}

test('task settings and runtime alias IPC channels are the only task surface', () => {
  assert.equal(SHELL_CHANNELS.taskSettingsSnapshot, 'wrenyard-shell:task-settings-snapshot');
  assert.equal(SHELL_CHANNELS.taskSettingsSave, 'wrenyard-shell:task-settings-save');
  assert.equal(SHELL_CHANNELS.runtimeAliasSnapshot, 'wrenyard-shell:runtime-alias-snapshot');
  assert.equal(SHELL_CHANNELS.runtimeAliasPut, 'wrenyard-shell:runtime-alias-put');
  assert.equal(SHELL_CHANNELS.runtimeAliasRemove, 'wrenyard-shell:runtime-alias-remove');
  // The withdrawn human docs bridge no longer exists anywhere in the contract.
  assert.equal('docsList' in SHELL_CHANNELS, false);
  assert.equal('docsRead' in SHELL_CHANNELS, false);
  assert.equal('docsSave' in SHELL_CHANNELS, false);
  assert.equal('docsDirty' in SHELL_CHANNELS, false);
  const api: Pick<WrenyardShellApi, 'getTaskSettings' | 'saveTaskSettings' | 'runtimeAliasSnapshot' | 'runtimeAliasPut' | 'runtimeAliasRemove'> = {
    getTaskSettings: async () => settingsSnapshot('revision-1'),
    saveTaskSettings: async () => settingsSnapshot('revision-2'),
    runtimeAliasSnapshot: async () => aliasSnapshot('alias-rev-1'),
    runtimeAliasPut: async () => aliasSnapshot('alias-rev-2'),
    runtimeAliasRemove: async () => aliasSnapshot('alias-rev-3'),
  };
  assert.equal(typeof api.getTaskSettings, 'function');
  assert.equal(typeof api.saveTaskSettings, 'function');
  assert.equal(typeof api.runtimeAliasSnapshot, 'function');
  assert.equal(typeof api.runtimeAliasPut, 'function');
  assert.equal(typeof api.runtimeAliasRemove, 'function');
  assert.equal('saveTaskPreference' in api, false);
  const snapshot = settingsSnapshot('revision-1');
  // The snapshot mirrors the daemon snapshot wire DTO: config_path/revision/user_global/rows/aliases.
  assert.equal('config_path' in snapshot, true);
  assert.equal(snapshot.revision, 'revision-1');
  assert.equal(Array.isArray(snapshot.rows), true);
  assert.deepEqual(snapshot.aliases, []);
  // The global layer is directly the writable settings fields — no wrapper.
  assert.equal('revision' in snapshot.user_global, false);
  assert.equal('layer' in snapshot.user_global, false);
  assert.equal('keyed_by' in snapshot, false);
  assert.equal('tasks' in snapshot, false);
});

test('session preferences expose only the send key after retiring model defaults', () => {
  const ids = PREFERENCE_IDS as readonly string[];
  assert.deepEqual([...ids].filter((id) => id.startsWith('session.')), ['session.sendKey']);
  assert.equal(ids.includes('session.lastSentModel'), false);
  assert.equal(ids.includes('session.lastSentEffort'), false);
  assert.equal(ids.includes('session.defaultModel'), false);
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
  assert.equal(acceleratorPage({ key: '1', meta: true }, 'darwin'), 'session');
  assert.equal(acceleratorPage({ key: '2', meta: true }, 'darwin'), 'stats');
  assert.equal(acceleratorPage({ key: '3', meta: true }, 'darwin'), 'quota');
  assert.equal(acceleratorPage({ key: '4', meta: true }, 'darwin'), 'tasks');
  assert.equal(acceleratorPage({ key: ',', control: true }, 'linux'), 'settings');
  assert.equal(acceleratorPage({ key: '1', control: true }, 'win32'), 'session');
  assert.equal(acceleratorPage({ key: ',', control: true }, 'darwin'), null);
  assert.equal(acceleratorPage({ key: '5', meta: true }, 'darwin'), null);
});

test('update IPC channels expose the check-and-install surface only', () => {
  assert.equal(SHELL_CHANNELS.updateSnapshot, 'wrenyard-shell:update-snapshot');
  assert.equal(SHELL_CHANNELS.checkUpdate, 'wrenyard-shell:check-update');
  assert.equal(SHELL_CHANNELS.requestInstall, 'wrenyard-shell:request-install');
  assert.equal(SHELL_CHANNELS.updateChanged, 'wrenyard-shell:update-changed');
  // Channel switching and install cancellation were removed with the helper.
  assert.equal('setUpdateChannel' in SHELL_CHANNELS, false);
  assert.equal('cancelPendingInstall' in SHELL_CHANNELS, false);
  assert.equal('prepareUpdate' in SHELL_CHANNELS, false);
  assert.equal('restartUpdate' in SHELL_CHANNELS, false);
  const api: Pick<WrenyardShellApi, 'requestInstall' | 'checkUpdate'> = {
    requestInstall: async () => null as unknown as UpdateSnapshot,
    checkUpdate: async () => null as unknown as UpdateSnapshot,
  };
  assert.equal(typeof api.requestInstall, 'function');
  assert.equal(typeof api.checkUpdate, 'function');
});
