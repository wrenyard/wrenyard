import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  isShellPage,
  type TaskSettingsSaveRequest,
  type TaskSettingsSnapshot,
  type WrenyardShellApi,
} from '../src/shell-contract.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dshShellRoot = join(desktopRoot, '..', '..', 'packages', 'dsh-shell');

function snapshotFixture(revision: string): TaskSettingsSnapshot {
  return {
    config_path: '/Users/me/.wrenyard/tasks/config.json',
    revision,
    user_global: {},
    rows: [],
  };
}

test('tasks replaces docs as a registered, navigator-aware shell page', () => {
  assert.equal(isShellPage('tasks'), true);
  assert.equal(isShellPage('docs'), false);
  assert.equal(SHELL_CHANNELS.taskSettingsSnapshot, 'wrenyard-shell:task-settings-snapshot');
  assert.equal(SHELL_CHANNELS.taskSettingsSave, 'wrenyard-shell:task-settings-save');
  // The withdrawn human docs bridge has no channels left in the contract.
  assert.equal('docsList' in SHELL_CHANNELS, false);
  assert.equal('docsRead' in SHELL_CHANNELS, false);
  assert.equal('docsSave' in SHELL_CHANNELS, false);
  assert.equal('docsDirty' in SHELL_CHANNELS, false);
});

test('WrenyardShellApi exposes the layered snapshot and save surface only', () => {
  const api: Pick<WrenyardShellApi, 'getTaskSettings' | 'saveTaskSettings'> = {
    getTaskSettings: async () => snapshotFixture('revision-1'),
    saveTaskSettings: async () => snapshotFixture('revision-2'),
  };
  assert.equal(typeof api.getTaskSettings, 'function');
  assert.equal(typeof api.saveTaskSettings, 'function');
  const getter: Pick<WrenyardShellApi, 'getTaskSettings'> = {
    getTaskSettings: () => Promise.resolve(snapshotFixture('global-rev')),
  };
  assert.equal(typeof getter.getTaskSettings, 'function');
  assert.equal('saveTaskPreference' in api, false);
});

test('snapshot models the global layer, stable rows, and sourced effective values', () => {
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
  // The row is exactly the stable identity/name/builtin/user_task/effective/issues fields.
  assert.equal(taskRow.identity, 'builtin:build');
  assert.equal(taskRow.name, 'build');
  assert.equal(taskRow.builtin.name, 'build');
  assert.deepEqual(
    Object.keys(taskRow).sort(),
    ['builtin', 'effective', 'identity', 'issues', 'name', 'user_task'],
  );
  // No invented per-row wrapper fields exist.
  assert.equal('task_id' in taskRow, false);
  assert.equal('revision' in taskRow, false);
  assert.equal('readiness' in taskRow, false);
  assert.equal('source' in taskRow, false);
  // The user-global layer is the writable settings fields directly — no revision/layer wrapper.
  const globalLayer = snapshot.user_global as unknown as Record<string, unknown>;
  assert.equal('revision' in globalLayer, false);
  assert.equal('layer' in globalLayer, false);
  assert.deepEqual(
    Object.keys(globalLayer).sort(),
    ['additional_instructions', 'automatic', 'mode', 'timeout_ms'],
  );
  // Mode is 'automatic' (never the invented 'auto'); runtime is client/provider/model.
  assert.equal(taskRow.effective.mode.value, 'automatic');
  assert.equal(taskRow.effective.mode.source, 'user_global');
  assert.equal(taskRow.effective.automatic.expected_tps.value, 20);
  assert.equal(taskRow.effective.automatic.intelligence_min.value, 'mid');
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('"mode":"auto"'), false);
  assert.equal(serialized.includes('agent_runtime'), false);
  assert.deepEqual(taskRow.issues, []);
});

test('save request carries a bounded global/task patch with CAS revision', () => {
  const globalSave: TaskSettingsSaveRequest = {
    scope: 'global',
    expected_revision: 'global-rev',
    patch: { timeout_ms: 300_000 },
  };
  const taskSave: TaskSettingsSaveRequest = {
    scope: 'task',
    task_id: 'builtin:build',
    project: 'acme',
    expected_revision: 'row-rev',
    patch: {
      mode: 'explicit',
      explicit_runtime: { client: 'kimi-coding', provider: 'kimi', model: 'kimi-k3' },
      automatic: { intelligence_min: 'mid', required_capabilities: ['text', 'image'] },
    },
  };
  assert.equal(globalSave.scope, 'global');
  assert.equal(taskSave.scope, 'task');
  assert.equal(taskSave.task_id, 'builtin:build');
  assert.equal(taskSave.project, 'acme');
  assert.equal(taskSave.expected_revision, 'row-rev');
  assert.deepEqual(Object.keys(taskSave.patch).sort(), ['automatic', 'explicit_runtime', 'mode']);
  assert.equal(taskSave.patch.mode, 'explicit');
  // The explicit runtime is exactly the client/provider/model triple.
  const explicitRuntime = taskSave.patch.explicit_runtime as unknown as Record<string, unknown>;
  assert.deepEqual(explicitRuntime, { client: 'kimi-coding', provider: 'kimi', model: 'kimi-k3' });
  assert.equal('agent_runtime' in explicitRuntime, false);
});

test('preload exposes the typed snapshot/save API with no legacy preference call', () => {
  const preload = preloadSource();
  assert.match(
    preload,
    /getTaskSettings\(project\?: string, taskId\?: string\): Promise<TaskSettingsSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskSettingsSnapshot, project, taskId\)/u,
  );
  assert.match(
    preload,
    /saveTaskSettings\(request: TaskSettingsSaveRequest\): Promise<TaskSettingsSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskSettingsSave, request\)/u,
  );
  assert.doesNotMatch(preload, /saveTaskPreference|agentRuntime|requested_agent_runtime|bare_task_name|machine_global/);
  assert.doesNotMatch(preload, /listDocs|readDoc|saveDoc|setDocsDirty/);
  assert.doesNotMatch(preload, /WorkspaceDoc/);
});

test('main delegates snapshot and save with layered params and typed error mapping', () => {
  const main = mainSource();
  assert.match(main, /requestForeman\(\s*'task\.settings\.snapshot'/);
  assert.match(main, /requestForeman\(\s*'task\.settings\.save'/);
  assert.match(main, /TASK_SETTINGS_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(main, /requestTimeoutMs: TASK_SETTINGS_REQUEST_TIMEOUT_MS/);
  // Snapshot forwards the optional project and task_id.
  assert.match(main, /if \(project !== undefined\) params\.project = project;/);
  assert.match(main, /if \(taskId !== undefined\) params\.task_id = taskId;/);
  // Save forwards the bounded request fields verbatim; no daemon-side merging here.
  assert.match(main, /scope: request\.scope/);
  assert.match(main, /expected_revision: request\.expected_revision/);
  assert.match(main, /patch: request\.patch/);
  assert.match(main, /if \(request\.task_id !== undefined\) params\.task_id = request\.task_id;/);
  assert.match(main, /if \(request\.project !== undefined\) params\.project = request\.project;/);
  // Daemon CAS and preflight errors map to typed local errors for the renderer.
  assert.match(main, /code in TASK_SETTINGS_SAVE_ERROR_MESSAGES/);
  assert.match(main, /content_conflict: '任务设置已被外部修改，保存冲突'/);
  assert.match(main, /invalid_settings: '任务设置内容无效'/);
  assert.match(main, /runtime_unavailable: '所选 Agent 运行时不可用'/);
  assert.match(main, /task_not_found: '任务不存在或已被移除'/);
  assert.doesNotMatch(main, /saveTaskPreference|agent_runtime:|requested_agent_runtime|bare_task_name|machine_global|任务偏好已被外部修改/);
  assert.doesNotMatch(main, /workspace\.doc\.(list|read|update|create)/);
  assert.doesNotMatch(main, /docsDirty/);
});

test('shell-window validates the bounded task settings DTO at the IPC boundary', () => {
  const win = shellWindowSource();
  assert.match(win, /options\.getTaskSettings\(/);
  assert.match(win, /options\.saveTaskSettings\(validateTaskSettingsSaveRequest\(request\)\)/);
  assert.match(win, /taskSettingsSnapshot, async \(event, project: unknown, taskId: unknown\)/);
  assert.match(win, /taskSettingsSave, async \(event, request: unknown\)/);
  // Scope, CAS, and task_id rules.
  assert.match(win, /scope !== 'global' && scope !== 'task'/);
  assert.match(win, /任务设置版本基线无效/);
  assert.match(win, /任务作用域必须携带 task_id/);
  assert.match(win, /任务设置内容无效/);
  // Patch allowlist and per-field bounds (plain objects only, no prototypes/arrays).
  assert.match(win, /TASK_SETTINGS_PATCH_KEYS/);
  assert.match(win, /isBoundedPlainObject/);
  // Mode is the real wire enum automatic|explicit — never the invented 'auto'.
  assert.match(win, /mode !== 'automatic' && mode !== 'explicit'/);
  assert.doesNotMatch(win, /mode !== 'auto' && mode !== 'explicit'/);
  // Explicit runtime is exactly the client/provider/model triple, never agent_runtime.
  assert.match(win, /'client', 'provider', 'model'/);
  assert.match(win, /field !== 'client' && field !== 'provider' && field !== 'model'/);
  assert.doesNotMatch(win, /agent_runtime/);
  assert.match(win, /Number\.isSafeInteger/);
  assert.match(win, /additionalInstructions\.length > 4_000/);
  assert.match(win, /\[\\u0000-\\u001F\\u007F\]/);
  // Automatic nested dispatch is bounded field-by-field: known keys, positive
  // finite numbers, intelligence/capability enums, bounded string arrays, and
  // the preferred_runtime client/provider/model triple.
  assert.match(win, /TASK_SETTINGS_AUTOMATIC_KEYS/);
  assert.match(win, /TASK_SETTINGS_INTELLIGENCE_VALUES/);
  assert.match(win, /TASK_SETTINGS_CAPABILITY_VALUES/);
  assert.match(win, /TASK_SETTINGS_STRING_ARRAY_MAX/);
  assert.match(win, /Number\.isFinite/);
  assert.match(win, /preferred_runtime/);
  // No merging or legacy preference semantics are implemented on the boundary.
  assert.doesNotMatch(win, /saveTaskPreference|requested_agent_runtime|agentRuntime|bare_task_name|machine_global/);
  assert.doesNotMatch(win, /permission|input_schema|output_schema/);
});

test('HTML offers the Tasks list/detail/Automatic save flow with no docs editor', async () => {
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="tasks-nav"[^>]+aria-label="任务" data-page="tasks"/);
  assert.match(html, /id="tasks-page"/);
  assert.match(html, /id="tasks-list"/);
  assert.match(html, /id="tasks-detail"/);
  assert.match(html, /id="tasks-refresh"/);
  assert.match(html, /id="tasks-model-select"/);
  assert.match(html, /<option value="">自动选择<\/option>/);
  assert.match(html, /id="tasks-save"[^>]*>保存偏好</);
  assert.match(html, /id="tasks-status"/);
  assert.match(html, /id="tasks-error"/);
  assert.match(html, /本机全局/);
  assert.match(html, /bare task name/);
  assert.match(html, /同名 Task 共享/);
  assert.doesNotMatch(html, /id="docs-nav"|id="docs-page"|id="docs-editor"|id="docs-file-list"|id="docs-save-button"|id="docs-unsaved-save"/);
});

test('renderer builds options only from row.eligible, renders contract read-only, and reloads on conflict', async () => {
  const [app, main, update] = await Promise.all([
    readFile(join(desktopRoot, 'src', 'renderer', 'app.ts'), 'utf8'),
    Promise.resolve(mainSource()),
    readFile(join(desktopRoot, 'src', 'update-controller.ts'), 'utf8'),
  ]);
  // The model select is populated exclusively from the authoritative eligible list.
  assert.match(app, /for \(const choice of row\.eligible\)/);
  assert.match(app, /option\.value = choice\.exactAgentRuntime/);
  // Option labels surface the actual client/provider/model and any evidence.
  assert.match(app, /\[choice\.client, choice\.provider, choice\.model\]/);
  assert.match(app, /choice\.speed\.effective_tps/);
  assert.match(app, /choice\.intelligence/);
  assert.match(app, /choice\.reference_pricing\.output_usd_per_million/);
  // No legacy forge/fast/general/ultra policy strategy names appear as options.
  assert.doesNotMatch(app, /forge|fast|general|ultra/);
  // Contract details are read-only display, never editable controls.
  assert.match(app, /tasksReadonlyRow\('权限（Permission）'/);
  assert.match(app, /tasksReadonlyRow\('调度（Dispatch）'/);
  assert.match(app, /tasksReadonlyRow\('输入 Schema'/);
  assert.match(app, /tasksReadonlyRow\('输出 Schema'/);
  assert.doesNotMatch(app, /contentEditable|docsEditor/);
  // Save is an explicit CAS with conflict reload; stale revisions are never overwritten.
  assert.match(app, /saveTaskPreference\(/);
  assert.match(app, /expectedRevision/);
  assert.match(app, /reloadTasksAuthoritative\(\)/);
  assert.doesNotMatch(app, /mustGuardDocsLeave|showDocsUnsaved|docsDirty/);
  // Update UX and update-controller carry no removed docs-draft wording.
  assert.doesNotMatch(update, /docsDirty|保存文档/);
  assert.doesNotMatch(main, /docsDirty/);
});

test('canonical workspace-doc aliases remain agent-side in the DSH package', () => {
  const source = readFileSync(join(dshShellRoot, 'src', 'foreman-tools.mjs'), 'utf8');
  assert.match(source, /DOC_ALIAS_TO_IPC = \{/);
  assert.match(source, /list_workspace_docs: 'workspace\.doc\.list'/);
  assert.match(source, /read_workspace_doc: 'workspace\.doc\.read'/);
  assert.match(source, /create_workspace_doc: 'workspace\.doc\.create'/);
  assert.match(source, /update_workspace_doc: 'workspace\.doc\.update'/);
});

function preloadSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'preload.ts'), 'utf8');
}

function mainSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'main.ts'), 'utf8');
}

function shellWindowSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8');
}
