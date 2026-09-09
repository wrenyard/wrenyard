import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  acceleratorPage,
  isSettingsLaunchRequest,
  isShellPage,
  type QuotaSnapshot,
  type RuntimeAliasEntry,
  type RuntimeAliasPutRequest,
  type RuntimeAliasRemoveRequest,
  type RuntimeAliasSnapshot,
  type TaskResolvedDispatch,
  type TaskRunSnapshot,
  type TaskSettingsExplicitReference,
  type TaskSettingsLayer,
  type TaskSettingsSnapshot,
  type TaskSettingsTaskRow,
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

function automaticSelectionRow(): TaskSettingsTaskRow {
  return {
    identity: 'builtin:code',
    name: 'code',
    display_name: '编码助手',
    builtin: {
      identity: 'builtin:code',
      name: 'code',
      source: 'shell',
      description: 'Automatic model dispatch.',
      prompt_template: 'dynamic',
      instruction_template: [
        { kind: 'placeholder', source: 'task.prompt', label: '运行时填入任务输入' },
      ],
      timeout_ms: null,
      dispatch: { intelligence_min: 'mid' },
    },
    user_task: {
      mode: 'automatic',
      automatic: { intelligence_min: 'mid' },
    },
    effective: {
      mode: { value: 'automatic', source: 'user_task' },
      explicit_runtime: { value: null, source: 'builtin' },
      timeout_ms: { value: 120_000, source: 'user_global' },
      max_auto_output_usd_per_million: { value: null, source: 'builtin' },
      automatic: {
        expected_tps: { value: null, source: 'builtin' },
        minimum_tps: { value: null, source: 'builtin' },
        intelligence_min: { value: 'mid', source: 'user_task' },
        intelligence_max: { value: null, source: 'builtin' },
        max_output_usd_per_million: { value: null, source: 'builtin' },
        required_capabilities: { value: null, source: 'builtin' },
        exclude_model_ids: { value: null, source: 'builtin' },
        exclude_profile_ids: { value: null, source: 'builtin' },
        exclude_client_ids: { value: null, source: 'builtin' },
        exclude_provider_ids: { value: null, source: 'builtin' },
      },
    },
    automatic_selection: {
      exact_runtime: 'moonshot/kimi-k3',
      resolved: {
        runtime: 'moonshot/kimi-k3:kimi',
        client: 'kimi',
        provider: 'moonshot',
        model: 'kimi-k3',
        model_id: 'moonshot/kimi-k3',
      },
      reason: 'Catalog default covers the task intelligence requirement.',
    },
    issues: [],
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

test('TaskSettingsSnapshot rows mirror the current daemon wire DTO', () => {
  const resolved: TaskResolvedDispatch = {
    runtime: 'codex/gpt-5.6-luna:cc',
    client: 'cc',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    model_id: 'codex/gpt-5.6-luna',
  };
  const alias: TaskSettingsExplicitReference = { kind: 'alias', name: 'cc-fast' };
  const row: TaskSettingsTaskRow = {
    identity: 'builtin:build',
    name: 'build',
    display_name: 'Build project',
    builtin: {
      identity: 'builtin:build',
      name: 'build',
      source: 'shell',
      description: 'Compile and check.',
      prompt_template: 'dynamic',
      instruction_template: [
        { kind: 'text', source: 'task.instructions[0]', text: 'Run the full build.' },
        { kind: 'placeholder', source: 'task.prompt', label: '运行时填入任务输入' },
      ],
      timeout_ms: 300_000,
      dispatch: { expected_tps: 20, required_capabilities: ['text'] },
    },
    user_task: {
      mode: 'explicit',
      explicit_runtime: alias,
    },
    effective: {
      mode: { value: 'explicit', source: 'user_task' },
      explicit_runtime: { value: alias, source: 'user_task' },
      timeout_ms: { value: 120_000, source: 'user_global' },
      max_auto_output_usd_per_million: { value: 0, source: 'user_global' },
      automatic: {
        expected_tps: { value: 20, source: 'user_global' },
        minimum_tps: { value: null, source: 'builtin' },
        intelligence_min: { value: 'mid', source: 'builtin' },
        intelligence_max: { value: null, source: 'builtin' },
        max_output_usd_per_million: { value: 5, source: 'builtin' },
        required_capabilities: { value: ['text'], source: 'user_global' },
        exclude_model_ids: { value: null, source: 'builtin' },
        exclude_profile_ids: { value: null, source: 'builtin' },
        exclude_client_ids: { value: null, source: 'builtin' },
        exclude_provider_ids: { value: null, source: 'builtin' },
      },
    },
    explicit: { resolved },
    issues: [],
  };
  const snapshot: TaskSettingsSnapshot = {
    config_path: '/var/tmp/example-user/.wrenyard/tasks/config.json',
    revision: 'global-rev',
    user_global: {
      mode: 'automatic',
      timeout_ms: 120_000,
      max_auto_output_usd_per_million: 0,
      automatic: { expected_tps: 20, required_capabilities: ['text'] },
    },
    rows: [row],
    aliases: [{ name: 'cc-fast', target: 'anthropic/claude-sonnet-4:cc' }],
  };
  assert.equal(snapshot.config_path, '/var/tmp/example-user/.wrenyard/tasks/config.json');
  assert.equal(snapshot.revision, 'global-rev');
  assert.equal(snapshot.aliases[0]?.name, 'cc-fast');
  assert.equal(snapshot.aliases[0]?.target, 'anthropic/claude-sonnet-4:cc');
  assert.equal(snapshot.rows[0]!.identity, 'builtin:build');
  assert.equal(snapshot.rows[0]!.builtin.prompt_template, 'dynamic');
  // instruction_template has no additional_instructions slot and no edit surface.
  assert.deepEqual(snapshot.rows[0]!.builtin.instruction_template, [
    { kind: 'text', source: 'task.instructions[0]', text: 'Run the full build.' },
    { kind: 'placeholder', source: 'task.prompt', label: '运行时填入任务输入' },
  ]);
  // Row top-level keys are exactly the stable wire fields; no runtime choice pools.
  assert.deepEqual(
    Object.keys(row).sort(),
    ['builtin', 'display_name', 'effective', 'explicit', 'identity', 'issues', 'name', 'user_task'],
  );
  assert.equal('task_id' in row, false);
  assert.equal('revision' in row, false);
  assert.equal('runtime_choices' in row, false);
  assert.equal('resolved_runtime' in row, false);
  assert.equal('declared_runtime' in row.builtin, false);
  assert.equal('additional_instructions' in row.user_task, false);
  assert.equal('additional_instructions' in row.effective, false);
  // Explicit reference is alias-or-target, never a client/provider/model triple.
  const explicitReference = row.user_task.explicit_runtime!;
  assert.deepEqual(explicitReference, { kind: 'alias', name: 'cc-fast' });
  assert.equal('client' in explicitReference, false);
  assert.equal('provider' in explicitReference, false);
  assert.equal('model' in explicitReference, false);
  assert.equal(row.effective.mode.value, 'explicit');
  // Explicit resolved dispatch shape (daemon-owned projection only).
  assert.equal(row.explicit?.resolved?.runtime, 'codex/gpt-5.6-luna:cc');
  // Global-only top-level auto cap is sourced and distinct from nested automatic max_output.
  assert.equal(row.effective.max_auto_output_usd_per_million.value, 0);
  assert.equal(row.effective.max_auto_output_usd_per_million.source, 'user_global');
  assert.equal(row.effective.automatic.max_output_usd_per_million.value, 5);
  assert.equal('max_output_usd_per_million' in row.effective, false);
  assert.equal(snapshot.user_global.max_auto_output_usd_per_million, 0);
  assert.deepEqual(row.issues, []);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('"mode":"auto"'), false);
  assert.equal(serialized.includes('agent_runtime'), false);
  assert.equal(serialized.includes('runtime_choices'), false);
  assert.equal(serialized.includes('additional_instructions'), false);
  assert.equal(serialized.includes('declared_runtime'), false);
});

test('automatic rows may carry optional automatic_selection with exact runtime, resolved dispatch, and reason', () => {
  const row = automaticSelectionRow();
  const snapshot: TaskSettingsSnapshot = { ...settingsSnapshot('auto-rev'), rows: [row] };
  assert.equal(row.effective.mode.value, 'automatic');
  assert.equal(row.automatic_selection?.exact_runtime, 'moonshot/kimi-k3');
  assert.equal(row.automatic_selection?.resolved?.runtime, 'moonshot/kimi-k3:kimi');
  assert.equal(row.automatic_selection?.resolved?.model, 'kimi-k3');
  assert.equal(row.automatic_selection?.reason, 'Catalog default covers the task intelligence requirement.');
  // automatic_selection is an additive optional; when present it serializes in
  // the daemon snake_case wire shape. Explicit/alias rows keep their shape.
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('automatic_selection'), true);
  assert.equal(serialized.includes('exact_runtime'), true);
  assert.equal(serialized.includes('declared_runtime'), false);
});

test('TaskRunSnapshot optionally carries paired Catalog display-name labels alongside legacy raw identity', () => {
  const paired: TaskRunSnapshot = {
    taskRunId: 'run-a',
    taskId: 'edit',
    resolvedProviderDisplayName: 'Kimi Coding',
    resolvedModelDisplayName: 'Kimi K2',
    usage: { completeness: 'complete', attemptCount: 1, usageEventCount: 1, referenceCostComplete: true },
  };
  assert.equal(paired.resolvedProviderDisplayName, 'Kimi Coding');
  assert.equal(paired.resolvedModelDisplayName, 'Kimi K2');
  // Legacy raw identity payloads remain representable and are never projected
  // into the paired Catalog display labels.
  const legacy: TaskRunSnapshot = {
    taskRunId: 'run-b',
    taskId: 'build',
    resolvedClient: 'kimi',
    resolvedProvider: 'moonshot',
    resolvedProfile: 'moonshot',
    resolvedModel: 'kimi-k3',
    resolvedModelId: 'moonshot/kimi-k3',
    usage: { completeness: 'complete', attemptCount: 1, usageEventCount: 1, referenceCostComplete: true },
  };
  assert.equal(legacy.resolvedClient, 'kimi');
  assert.equal(legacy.resolvedProvider, 'moonshot');
  assert.equal(legacy.resolvedModelId, 'moonshot/kimi-k3');
  assert.equal(legacy.resolvedProviderDisplayName, undefined);
  assert.equal(legacy.resolvedModelDisplayName, undefined);
  assert.equal('resolvedModelId' in legacy, true);
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

test('runtime alias entries and CAS requests use snake_case wire fields', () => {
  const entry: RuntimeAliasEntry = {
    name: 'cc-fast',
    target: 'anthropic/claude-sonnet-4:cc',
  };
  const putRequest: RuntimeAliasPutRequest = {
    expected_revision: 'alias-rev',
    name: 'cc-fast',
    target: 'anthropic/claude-sonnet-4:cc',
  };
  const removeRequest: RuntimeAliasRemoveRequest = {
    expected_revision: 'alias-rev',
    name: 'cc-fast',
  };
  assert.deepEqual(entry, { name: 'cc-fast', target: 'anthropic/claude-sonnet-4:cc' });
  assert.deepEqual(putRequest, { expected_revision: 'alias-rev', name: 'cc-fast', target: 'anthropic/claude-sonnet-4:cc' });
  assert.deepEqual(removeRequest, { expected_revision: 'alias-rev', name: 'cc-fast' });
  const snapshot = aliasSnapshot('alias-rev-4');
  assert.equal('expected_revision' in putRequest, true);
  assert.equal('expected_revision' in removeRequest, true);
  assert.equal('revision' in snapshot, true);
  assert.equal(snapshot.aliases.length, 1);
  // No secrets or resolved triples live on the alias store projection.
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('client'), false);
  assert.equal(serialized.includes('provider'), false);
  assert.equal(serialized.includes('apiKey'), false);
});
