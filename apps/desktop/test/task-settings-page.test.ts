import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  isShellPage,
  type TaskSettingsExplicitReference,
  type TaskSettingsMode,
  type TaskSettingsSaveRequest,
  type TaskSettingsSnapshot,
  type TaskSettingsTaskRow,
  type WrenyardShellApi,
} from '../src/shell-contract.js';
import {
  buildLayerPatch,
  buildTaskTree,
  explicitReferenceText,
  referenceFromRuntimeInput,
  resetPatch,
  resolvedTaskLabel,
  taskIdentityLabel,
  taskResolutionFailureMessage,
  taskRuntimeLine,
} from '../src/renderer/pages/tasks/model/settings.js';
import { shellIpcSource } from './support/shell-ipc-source.ts';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function aliases() {
  return [
    { name: 'cc-fast', target: 'anthropic/claude-sonnet-4:cc' },
    { name: 'kimi-k3', target: 'moonshot/kimi-k3:kimi' },
  ];
}

function automaticEffective(mode: TaskSettingsMode = 'automatic', reference: TaskSettingsExplicitReference | null = null) {
  return {
    mode: { value: mode, source: 'user_task' as const },
    explicit_runtime: { value: reference, source: 'user_task' as const },
    timeout_ms: { value: 120_000, source: 'user_global' as const },
    max_auto_output_usd_per_million: { value: null, source: 'builtin' as const },
    automatic: {
      expected_tps: { value: null, source: 'builtin' as const },
      minimum_tps: { value: null, source: 'builtin' as const },
      intelligence_min: { value: null, source: 'builtin' as const },
      max_output_usd_per_million: { value: null, source: 'builtin' as const },
      required_capabilities: { value: null, source: 'builtin' as const },
      exclude_model_ids: { value: null, source: 'builtin' as const },
      exclude_profile_ids: { value: null, source: 'builtin' as const },
      exclude_client_ids: { value: null, source: 'builtin' as const },
      exclude_provider_ids: { value: null, source: 'builtin' as const },
    },
  };
}

function automaticRow(): TaskSettingsTaskRow {
  return {
    identity: 'builtin:build',
    name: 'build',
    display_name: '构建任务',
    builtin: {
      identity: 'builtin:build',
      name: 'build',
      source: 'shell',
      description: '编译并检查。',
      prompt_template: 'dynamic',
      instruction_template: [
        { kind: 'text', source: 'shell', text: '你是构建工。' },
        { kind: 'placeholder', source: 'shell', label: '任务说明' },
      ],
      timeout_ms: 300_000,
      dispatch: {},
    },
    user_task: {},
    effective: automaticEffective(),
    issues: [{ code: 'stale', message: '运行时已下线' }],
  };
}

function explicitRow(): TaskSettingsTaskRow {
  const reference: TaskSettingsExplicitReference = { kind: 'alias', name: 'kimi-k3' };
  return {
    identity: 'project:acme:deploy',
    name: 'deploy',
    display_name: '发布上线',
    project: 'acme',
    project_display_name: '产品组 Acme',
    builtin: {
      identity: 'project:acme:deploy',
      name: 'deploy',
      source: 'project',
      description: '发布到生产。',
      prompt_template: 'fixed',
      instruction_template: [
        { kind: 'text', source: 'project', text: '发布流程如下。' },
      ],
      timeout_ms: null,
      dispatch: {},
    },
    user_task: {
      mode: 'explicit',
      explicit_runtime: reference,
      timeout_ms: 240_000,
    },
    effective: automaticEffective('explicit', reference),
    explicit: {
      resolved: {
        runtime: 'moonshot/kimi-k3:kimi',
        client: 'kimi',
        provider: 'moonshot',
        model: 'kimi-k3',
        model_id: 'moonshot/kimi-k3',
      },
    },
    issues: [],
  };
}

function taskSnapshot(revision = 'rev-1'): TaskSettingsSnapshot {
  return {
    config_path: '/var/tmp/example-user/.wrenyard/tasks/config.json',
    revision,
    user_global: { automatic: null },
    rows: [automaticRow(), explicitRow()],
    aliases: aliases(),
  };
}

test('tasks is a registered, navigator-aware shell page', () => {
  assert.equal(isShellPage('tasks'), true);
  assert.equal(SHELL_CHANNELS.taskSettingsSnapshot, 'wrenyard-shell:task-settings-snapshot');
  assert.equal(SHELL_CHANNELS.taskSettingsSave, 'wrenyard-shell:task-settings-save');
});

test('snapshot rows expose authoritative labels, alias-or-target references, and daemon resolution', () => {
  const snapshot = taskSnapshot();
  const builtinRow = snapshot.rows[0]!;
  const projectRow = snapshot.rows[1]!;
  assert.equal(builtinRow.identity, 'builtin:build');
  assert.equal(builtinRow.display_name, '构建任务');
  assert.equal(projectRow.project, 'acme');
  assert.equal(projectRow.project_display_name, '产品组 Acme');
  // Snapshot mirrors the alias projection for editable explicit suggestions.
  assert.deepEqual(snapshot.aliases.map((entry) => entry.name), ['cc-fast', 'kimi-k3']);
  assert.deepEqual(
    Object.keys(builtinRow).sort(),
    ['builtin', 'display_name', 'effective', 'identity', 'issues', 'name', 'user_task'],
  );
  assert.deepEqual(builtinRow.builtin.instruction_template, [
    { kind: 'text', source: 'shell', text: '你是构建工。' },
    { kind: 'placeholder', source: 'shell', label: '任务说明' },
  ]);
  assert.equal('additional_instructions' in builtinRow.builtin.instruction_template[0]!, false);
  assert.equal(projectRow.effective.mode.value, 'explicit');
  assert.deepEqual(projectRow.user_task.explicit_runtime, { kind: 'alias', name: 'kimi-k3' });
  assert.equal(projectRow.explicit?.resolved?.runtime, 'moonshot/kimi-k3:kimi');
  // Removed choice/preview surfaces never appear in the wire shape.
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('runtime_choices'), false);
  assert.equal(serialized.includes('resolved_runtime'), false);
  assert.equal(serialized.includes('declared_runtime'), false);
  assert.equal(serialized.includes('additional_instructions'), false);
  assert.equal(serialized.includes('exactAgentRuntime'), false);
});

test('WrenyardShellApi exposes the typed snapshot/save surface only', () => {
  const api: Pick<WrenyardShellApi, 'getTaskSettings' | 'saveTaskSettings'> = {
    getTaskSettings: async () => taskSnapshot('revision-1'),
    saveTaskSettings: async () => taskSnapshot('revision-2'),
  };
  assert.equal(typeof api.getTaskSettings, 'function');
  assert.equal(typeof api.saveTaskSettings, 'function');
});

test('save request carries an alias-or-inline reference, task identity, and CAS revision', () => {
  const taskSave: TaskSettingsSaveRequest = {
    scope: 'task',
    task_id: 'project:acme:deploy',
    project: 'acme',
    expected_revision: 'row-rev',
    patch: {
      mode: 'explicit',
      explicit_runtime: { kind: 'target', target: 'anthropic/claude-sonnet-4:cc' },
    },
  };
  assert.equal(taskSave.scope, 'task');
  assert.equal(taskSave.task_id, 'project:acme:deploy');
  assert.equal(taskSave.project, 'acme');
  assert.equal(taskSave.expected_revision, 'row-rev');
  assert.deepEqual(Object.keys(taskSave.patch).sort(), ['explicit_runtime', 'mode']);
  // The explicit runtime reference is alias-or-target; never a client/provider/model triple.
  assert.deepEqual(taskSave.patch.explicit_runtime, { kind: 'target', target: 'anthropic/claude-sonnet-4:cc' });
  assert.equal('client' in taskSave.patch.explicit_runtime!, false);
  assert.equal('agent_runtime' in taskSave.patch.explicit_runtime!, false);
});

test('runtime input maps a stored alias to an alias reference and anything else to an inline target', () => {
  const available = aliases();
  assert.deepEqual(referenceFromRuntimeInput('  kimi-k3  ', available), { kind: 'alias', name: 'kimi-k3' });
  assert.deepEqual(
    referenceFromRuntimeInput('anthropic/claude-sonnet-4:cc', available),
    { kind: 'target', target: 'anthropic/claude-sonnet-4:cc' },
  );
  assert.throws(() => referenceFromRuntimeInput('   ', available));
  // The edit surface renders the stored reference back to plain text.
  assert.equal(explicitReferenceText({ kind: 'alias', name: 'cc-fast' }), 'cc-fast');
  assert.equal(explicitReferenceText({ kind: 'target', target: 'moonshot/kimi-k3:kimi' }), 'moonshot/kimi-k3:kimi');
  assert.equal(explicitReferenceText(undefined), '');
});

test('buildLayerPatch writes only changed fields against the daemon-owned effective baseline', () => {
  const row = automaticRow();
  // An unchanged automatic row with no timeout text produces no incidental pins.
  assert.deepEqual(buildLayerPatch(row, 'automatic', '', '', aliases()), {});
  // Switching to explicit writes the mode and the new alias reference only.
  assert.deepEqual(buildLayerPatch(row, 'explicit', 'cc-fast', '', aliases()), {
    mode: 'explicit',
    explicit_runtime: { kind: 'alias', name: 'cc-fast' },
  });
  // A seconds timeout override converts back to the ms wire value.
  assert.deepEqual(buildLayerPatch(row, 'automatic', '', '90', aliases()), { timeout_ms: 90_000 });
});

test('resetPatch clears only the writable fields present on the per-task layer', () => {
  assert.deepEqual(
    resetPatch({ mode: 'explicit', explicit_runtime: { kind: 'alias', name: 'cc-fast' }, timeout_ms: 1_000 }),
    { mode: null, explicit_runtime: null, timeout_ms: null },
  );
  assert.deepEqual(resetPatch({}), {});
});

test('identity, runtime line, and failure tooltip derive only from authoritative display data', () => {
  assert.equal(taskIdentityLabel('builtin:build'), 'build');
  assert.equal(taskIdentityLabel('project:acme:deploy'), 'project:acme:deploy');

  assert.equal(resolvedTaskLabel({ provider_display_name: 'Moonshot', model_display_name: 'Kimi K3' }), 'Moonshot · Kimi K3');
  assert.equal(resolvedTaskLabel({ provider_display_name: 'Moonshot' }), null);
  assert.equal(resolvedTaskLabel(null), null);
  // No resolved dispatch means no runtime line; raw provider/model ids are never promoted.
  assert.equal(taskRuntimeLine(automaticRow()), '');

  const failureRow: TaskSettingsTaskRow = {
    ...automaticRow(),
    issues: [{ code: 'no_available_provider', message: '不可用', resolutionFailure: { code: 'no_available_provider', message: '继承的别名当前不可用' } }],
  };
  assert.equal(taskResolutionFailureMessage(failureRow), '继承的别名当前不可用');
  assert.equal(taskResolutionFailureMessage(automaticRow()), null);
});

test('buildTaskTree groups builtin and project rows and preserves backend order', () => {
  const tree = buildTaskTree(taskSnapshot());
  assert.deepEqual(tree.builtin.map((row) => row.identity), ['builtin:build']);
  assert.equal(tree.projects.length, 1);
  assert.equal(tree.projects[0]!.key, 'project:acme');
  assert.equal(tree.projects[0]!.label, '产品组 Acme');
  assert.deepEqual(tree.projects[0]!.rows.map((row) => row.identity), ['project:acme:deploy']);
  assert.equal(tree.projectCategoryCount, 1);
});

test('preload exposes the typed snapshot/save API', () => {
  const preload = preloadSource();
  assert.match(
    preload,
    /getTaskSettings\(project\?: string, taskId\?: string\): Promise<TaskSettingsSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskSettingsSnapshot, project, taskId\)/u,
  );
  assert.match(
    preload,
    /saveTaskSettings\(request: TaskSettingsSaveRequest\): Promise<TaskSettingsSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskSettingsSave, request\)/u,
  );
});

test('main delegates snapshot and save with layered params and typed CAS error mapping', () => {
  const main = mainSource();
  assert.match(main, /requestForeman\(\s*'task\.settings\.snapshot'/);
  assert.match(main, /requestForeman\(\s*'task\.settings\.save'/);
  assert.match(main, /scope: request\.scope/);
  assert.match(main, /expected_revision: request\.expected_revision/);
  assert.match(main, /patch: request\.patch/);
  assert.match(main, /if \(request\.task_id !== undefined\) params\.task_id = request\.task_id;/);
  assert.match(main, /if \(request\.project !== undefined\) params\.project = request\.project;/);
  assert.match(main, /code in TASK_SETTINGS_SAVE_ERROR_MESSAGES/);
  assert.match(main, /content_conflict: '任务设置已被外部修改，保存冲突'/);
  assert.match(main, /invalid_settings: '任务设置内容无效'/);
  assert.match(main, /runtime_unavailable: '所选 Agent 运行时不可用'/);
  assert.match(main, /task_not_found: '任务不存在或已被移除'/);
});

test('shell-window validates the bounded task settings DTO at the IPC boundary', () => {
  const win = shellWindowSource();
  assert.match(win, /options\.getTaskSettings\(/);
  assert.match(win, /options\.saveTaskSettings\(validateTaskSettingsSaveRequest\(request\)\)/);
  assert.match(win, /scope !== 'global' && scope !== 'task'/);
  assert.match(win, /任务设置版本基线无效/);
  assert.match(win, /任务作用域必须携带 task_id/);
  assert.match(win, /任务设置内容无效/);
  assert.match(win, /TASK_SETTINGS_PATCH_KEYS/);
  assert.match(win, /isBoundedPlainObject/);
  assert.match(win, /mode !== 'automatic' && mode !== 'explicit'/);
  // Explicit reference validation is alias-or-target; no client/provider/model triple.
  assert.match(win, /function validateExplicitReferenceValue\(explicitReference: unknown\): void/);
  assert.match(win, /kind === 'alias'/);
  assert.match(win, /kind === 'target'/);
});

function preloadSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'preload.ts'), 'utf8');
}

function mainSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'main.ts'), 'utf8');
}

function shellWindowSource(): string {
  return shellIpcSource(desktopRoot);
}
