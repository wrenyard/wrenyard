import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  isShellPage,
  type TaskSettingsSnapshot,
  type WrenyardShellApi,
} from '../src/shell-contract.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dshShellRoot = join(desktopRoot, '..', '..', 'packages', 'dsh-shell');

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

test('WrenyardShellApi exposes exactly the bounded task preference operations', () => {
  const api: Pick<WrenyardShellApi, 'getTaskSettings' | 'saveTaskPreference'> = {
    getTaskSettings: async () => ({
      config_path: 'settings.json',
      revision: 'revision-1',
      scope: 'machine_global',
      keyed_by: 'bare_task_name',
      tasks: [],
    }),
    saveTaskPreference: async () => ({
      config_path: 'settings.json',
      revision: 'revision-2',
      scope: 'machine_global',
      keyed_by: 'bare_task_name',
      tasks: [],
    }),
  };
  assert.equal(typeof api.getTaskSettings, 'function');
  assert.equal(typeof api.saveTaskPreference, 'function');
  const snapshot: Pick<WrenyardShellApi, 'getTaskSettings'> = {
    getTaskSettings: (project?: string) => (project === undefined
      ? Promise.resolve({ config_path: '', revision: 'sha256', scope: 'machine_global', keyed_by: 'bare_task_name', tasks: [] })
      : Promise.resolve({ config_path: '', revision: 'sha256', scope: 'machine_global', keyed_by: 'bare_task_name', tasks: [] })),
  };
  assert.equal(typeof snapshot.getTaskSettings, 'function');
});

test('preload exposes typed snapshot/save only and no canonical-doc editor API', () => {
  const preload = preloadSource();
  assert.match(preload, /getTaskSettings\(project\?: string\): Promise<TaskSettingsSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskSettingsSnapshot, project\)/u);
  assert.match(preload, /saveTaskPreference\(taskId: string, agentRuntime: string \| null, expectedRevision: string, project\?: string\): Promise<TaskSettingsSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskSettingsSave, taskId, agentRuntime, expectedRevision, project\)/u);
  assert.doesNotMatch(preload, /listDocs|readDoc|saveDoc|setDocsDirty/);
  assert.doesNotMatch(preload, /WorkspaceDoc/);
});

test('main forwards task.settings.snapshot/save with CAS data and maps conflict; no docsDirty gate', () => {
  const main = mainSource();
  assert.match(main, /requestForeman\(\s*'task\.settings\.snapshot'/);
  assert.match(main, /requestForeman\(\s*'task\.settings\.save'/);
  assert.match(main, /TASK_SETTINGS_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(main, /requestTimeoutMs: TASK_SETTINGS_REQUEST_TIMEOUT_MS/);
  assert.match(main, /task_id:/);
  assert.match(main, /agent_runtime:/);
  assert.match(main, /expected_revision:/);
  assert.match(main, /params\.project\s*=|params\[['"]project['"]\]/);
  assert.match(main, /code === 'content_conflict'/);
  assert.match(main, /\.code = 'content_conflict'/);
  assert.doesNotMatch(main, /workspace\.doc\.(list|read|update|create)/);
  assert.doesNotMatch(main, /docsDirty/);
  assert.doesNotMatch(main, /isDocsAllowedPath/);
  // update busy gating no longer folds in a human docs draft
  assert.doesNotMatch(main, /conversationBusy \|\| docsDirty/);
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
