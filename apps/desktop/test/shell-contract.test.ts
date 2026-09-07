import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  acceleratorPage,
  isSettingsLaunchRequest,
  isShellPage,
  type QuotaSnapshot,
  type TaskSettingsLayer,
  type TaskSettingsSnapshot,
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

function emptyLayer(): TaskSettingsLayer {
  return {
    explicit_runtime: null,
    timeout_ms: null,
    additional_instructions: null,
    automatic: null,
  };
}

function settingsSnapshot(revision: string): TaskSettingsSnapshot {
  return {
    config_path: '/machine-global/config.json',
    revision,
    user_global: emptyLayer(),
    rows: [],
  };
}

test('task settings IPC channels and API methods are the only task settings surface', () => {
  assert.equal(SHELL_CHANNELS.taskSettingsSnapshot, 'wrenyard-shell:task-settings-snapshot');
  assert.equal(SHELL_CHANNELS.taskSettingsSave, 'wrenyard-shell:task-settings-save');
  // The withdrawn human docs bridge no longer exists anywhere in the contract.
  assert.equal('docsList' in SHELL_CHANNELS, false);
  assert.equal('docsRead' in SHELL_CHANNELS, false);
  assert.equal('docsSave' in SHELL_CHANNELS, false);
  assert.equal('docsDirty' in SHELL_CHANNELS, false);
  const api: Pick<WrenyardShellApi, 'getTaskSettings' | 'saveTaskSettings'> = {
    getTaskSettings: async () => settingsSnapshot('revision-1'),
    saveTaskSettings: async () => settingsSnapshot('revision-2'),
  };
  assert.equal(typeof api.getTaskSettings, 'function');
  assert.equal(typeof api.saveTaskSettings, 'function');
  // The task settings surface is exactly the snapshot/save pair.
  assert.equal('saveTaskPreference' in api, false);
  const snapshot = settingsSnapshot('revision-1');
  // The snapshot mirrors the daemon snapshot wire DTO: config_path/revision/user_global/rows.
  assert.equal('config_path' in snapshot, true);
  assert.equal(snapshot.revision, 'revision-1');
  assert.equal(Array.isArray(snapshot.rows), true);
  // The global layer is directly the writable settings fields — no wrapper.
  assert.equal('revision' in snapshot.user_global, false);
  assert.equal('layer' in snapshot.user_global, false);
  assert.equal('keyed_by' in snapshot, false);
  assert.equal('tasks' in snapshot, false);
});

test('TaskSettingsSnapshot rows and effective values mirror the daemon wire DTO', () => {
  const snapshot: TaskSettingsSnapshot = {
    config_path: '/Users/me/.wrenyard/tasks/config.json',
    revision: 'global-rev',
    user_global: {
      mode: 'automatic',
      timeout_ms: 120_000,
      additional_instructions: 'Only touch BUILD rules.',
      automatic: { expected_tps: 20, required_capabilities: ['text'] },
    },
    rows: [{
      identity: 'builtin:build',
      name: 'build',
      builtin: {
        identity: 'builtin:build',
        name: 'build',
        source: 'shell',
        description: 'Compile and check.',
        prompt_template: 'dynamic',
        declared_runtime: null,
        timeout_ms: 300_000,
        dispatch: { expected_tps: 20, required_capabilities: ['text'] },
      },
      user_task: {
        additional_instructions: 'Only target the BUILD directory.',
      },
      effective: {
        mode: { value: 'automatic', source: 'user_global' },
        explicit_runtime: { value: null, source: 'builtin' },
        timeout_ms: { value: 120_000, source: 'user_global' },
        additional_instructions: { value: 'Only target the BUILD directory.', source: 'user_task' },
        automatic: {
          expected_tps: { value: 20, source: 'user_global' },
          minimum_tps: { value: null, source: 'builtin' },
          intelligence_min: { value: 'mid', source: 'builtin' },
          intelligence_max: { value: null, source: 'builtin' },
          max_output_usd_per_million: { value: null, source: 'builtin' },
          required_capabilities: { value: ['text'], source: 'user_global' },
          exclude_model_ids: { value: null, source: 'builtin' },
          exclude_profile_ids: { value: null, source: 'builtin' },
          exclude_client_ids: { value: null, source: 'builtin' },
          exclude_provider_ids: { value: null, source: 'builtin' },
          preferred_runtime: { value: null, source: 'builtin' },
        },
      },
      issues: [],
    }],
  };
  const taskRow = snapshot.rows[0]!;
  assert.equal(snapshot.config_path, '/Users/me/.wrenyard/tasks/config.json');
  assert.equal(snapshot.revision, 'global-rev');
  assert.equal(taskRow.identity, 'builtin:build');
  assert.equal(taskRow.builtin.identity, 'builtin:build');
  assert.equal(taskRow.builtin.name, 'build');
  assert.equal(taskRow.builtin.prompt_template, 'dynamic');
  // Row top-level keys are exactly the stable wire fields; no invented wrappers.
  assert.deepEqual(
    Object.keys(taskRow).sort(),
    ['builtin', 'effective', 'identity', 'issues', 'name', 'user_task'],
  );
  assert.equal('task_id' in taskRow, false);
  assert.equal('revision' in taskRow, false);
  assert.equal('readiness' in taskRow, false);
  assert.equal('source' in taskRow, false);
  // Mode is 'automatic', never the invented 'auto', and the runtime triple is
  // client/provider/model — never agent_runtime.
  assert.equal(taskRow.effective.mode.value, 'automatic');
  assert.equal(taskRow.effective.mode.source, 'user_global');
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('"mode":"auto"'), false);
  assert.equal(serialized.includes('agent_runtime'), false);
  // Effective automatic is sourced per field.
  assert.deepEqual(taskRow.effective.automatic.required_capabilities, { value: ['text'], source: 'user_global' });
  assert.equal(taskRow.effective.automatic.expected_tps.value, 20);
  assert.deepEqual(taskRow.issues, []);
  // Global layer is the writable settings fields, no revision/layer envelope.
  const globalLayer = snapshot.user_global as unknown as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(globalLayer).sort(),
    ['additional_instructions', 'automatic', 'mode', 'timeout_ms'],
  );
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
