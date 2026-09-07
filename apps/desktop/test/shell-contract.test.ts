import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  acceleratorPage,
  isSettingsLaunchRequest,
  isShellPage,
  type QuotaSnapshot,
  type UpdateSnapshot,
  type WrenyardShellApi,
} from '../src/shell-contract.js';

test('isShellPage accepts only product shell destinations', () => {
  assert.equal(isShellPage('workbench'), true);
  assert.equal(isShellPage('stats'), true);
  assert.equal(isShellPage('quota'), true);
  assert.equal(isShellPage('clients'), true);
  assert.equal(isShellPage('settings'), true);
  assert.equal(isShellPage('tasks'), true);
  assert.equal(isShellPage('docs'), false);
  assert.equal(isShellPage('dsh-settings'), false);
  assert.equal(isShellPage('../settings'), false);
  assert.equal(isShellPage(null), false);
});

test('task settings IPC channels and API methods are the only task preference surface', () => {
  assert.equal(SHELL_CHANNELS.taskSettingsSnapshot, 'wrenyard-shell:task-settings-snapshot');
  assert.equal(SHELL_CHANNELS.taskSettingsSave, 'wrenyard-shell:task-settings-save');
  // The withdrawn human docs bridge no longer exists anywhere in the contract.
  assert.equal('docsList' in SHELL_CHANNELS, false);
  assert.equal('docsRead' in SHELL_CHANNELS, false);
  assert.equal('docsSave' in SHELL_CHANNELS, false);
  assert.equal('docsDirty' in SHELL_CHANNELS, false);
  const api: Pick<WrenyardShellApi, 'getTaskSettings' | 'saveTaskPreference'> = {
    getTaskSettings: async () => ({ config_path: '', revision: 'revision-1', scope: 'machine_global', keyed_by: 'bare_task_name', tasks: [] }),
    saveTaskPreference: async () => ({ config_path: '', revision: 'revision-2', scope: 'machine_global', keyed_by: 'bare_task_name', tasks: [] }),
  };
  assert.equal(typeof api.getTaskSettings, 'function');
  assert.equal(typeof api.saveTaskPreference, 'function');
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
  assert.equal(acceleratorPage({ key: '4', meta: true }, 'darwin'), 'clients');
  assert.equal(acceleratorPage({ key: ',', control: true }, 'linux'), 'settings');
  assert.equal(acceleratorPage({ key: '1', control: true }, 'win32'), 'workbench');
  assert.equal(acceleratorPage({ key: ',', control: true }, 'darwin'), null);
  assert.equal(acceleratorPage({ key: '5', meta: true }, 'darwin'), null);
});

test('configure-provider-key IPC channel and API method exist', () => {
  assert.equal(SHELL_CHANNELS.configureProviderKey, 'wrenyard-shell:configure-provider-key');
  const api: Pick<WrenyardShellApi, 'configureProviderKey'> = {
    configureProviderKey: async () => ({ status: 'available', providers: [], catalog: [], providerOrder: [] }),
  };
  assert.equal(typeof api.configureProviderKey, 'function');
});

test('update IPC channels expose bounded Desktop update operations', () => {
  assert.equal(SHELL_CHANNELS.updateSnapshot, 'wrenyard-shell:update-snapshot');
  assert.equal(SHELL_CHANNELS.checkUpdate, 'wrenyard-shell:check-update');
  assert.equal(SHELL_CHANNELS.setUpdateChannel, 'wrenyard-shell:set-update-channel');
  assert.equal(SHELL_CHANNELS.requestInstall, 'wrenyard-shell:request-install');
  assert.equal(SHELL_CHANNELS.cancelPendingInstall, 'wrenyard-shell:cancel-pending-install');
  assert.equal(SHELL_CHANNELS.updateChanged, 'wrenyard-shell:update-changed');
  // The old two-click prepare/restart channels no longer exist.
  assert.equal('prepareUpdate' in SHELL_CHANNELS, false);
  assert.equal('restartUpdate' in SHELL_CHANNELS, false);
  const api: Pick<WrenyardShellApi, 'requestInstall' | 'cancelPendingInstall'> = {
    requestInstall: async () => null as unknown as UpdateSnapshot,
    cancelPendingInstall: async () => null as unknown as UpdateSnapshot,
  };
  assert.equal(typeof api.requestInstall, 'function');
  assert.equal(typeof api.cancelPendingInstall, 'function');
});

test('QuotaSnapshot carries a provider catalog without secrets', () => {
  const snapshot: QuotaSnapshot = {
    status: 'available',
    providers: [],
    providerOrder: [{ id: 'kimi-coding', enabled: true }],
    catalog: [{
      id: 'kimi-coding',
      label: 'Kimi Coding',
      description: 'Moonshot Kimi K3 编程模型与订阅额度。',
      configured: false,
      authMode: 'api-key',
      setupHint: '输入 Kimi Coding API Key；Key 仅写入本机 Wrenyard runtime。',
    }],
  };
  assert.ok(Array.isArray(snapshot.catalog));
  assert.equal(snapshot.catalog[0].authMode, 'api-key');
  assert.equal('key' in snapshot.catalog[0], false);
  assert.equal('apiKey' in snapshot.catalog[0], false);
});
