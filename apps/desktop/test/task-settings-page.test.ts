import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
      intelligence_max: { value: null, source: 'builtin' as const },
      max_output_usd_per_million: { value: null, source: 'builtin' as const },
      required_capabilities: { value: null, source: 'builtin' as const },
      exclude_model_ids: { value: null, source: 'builtin' as const },
      exclude_profile_ids: { value: null, source: 'builtin' as const },
      exclude_client_ids: { value: null, source: 'builtin' as const },
      exclude_provider_ids: { value: null, source: 'builtin' as const },
      preferred_runtime: { value: null, source: 'builtin' as const },
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
    config_path: '/Users/me/.wrenyard/tasks/config.json',
    revision,
    user_global: { automatic: null },
    rows: [automaticRow(), explicitRow()],
    aliases: aliases(),
  };
}

test('tasks is a registered, navigator-aware shell page with no legacy preference channels', () => {
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
  assert.doesNotMatch(main, /additional_instructions|saveTaskPreference|agent_runtime:|requested_agent_runtime|bare_task_name|machine_global/);
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
  assert.doesNotMatch(win, /TASK_SETTINGS_EXPLICIT_FIELDS|'client', 'provider', 'model'|additional_instructions/);
  assert.doesNotMatch(win, /saveTaskPreference|requested_agent_runtime|agentRuntime|bare_task_name|machine_global/);
});

test('HTML exposes exactly three compact rows with seconds timeout and template preview, no additional-instruction UI', async () => {
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="tasks-nav"[^>]+aria-label="任务" data-page="tasks"/);
  assert.match(html, /id="tasks-page"/);
  assert.match(html, /id="tasks-title">任务</);
  assert.match(html, /class="tasks-tree" id="tasks-list" role="tree" aria-label="任务目录"/);
  assert.match(html, /id="tasks-detail"/);
  assert.match(html, /id="tasks-detail-name"/);
  assert.match(html, /id="tasks-detail-identity"/);
  // Row one: two-mode selection (automatic/explicit only). Row two: seconds timeout
  // with visible 秒 unit and ※ reset. Row three (explicit only): combobox + help.
  assert.match(html, /<select id="tasks-mode">\s*<option value="automatic">自动选择<\/option>\s*<option value="explicit">指定运行时<\/option>\s*<\/select>/u);
  assert.doesNotMatch(html, /<option value="">继承<\/option>/u);
  assert.match(html, /id="tasks-timeout" type="number" min="1" step="1" placeholder="继承"/);
  assert.doesNotMatch(html, /id="tasks-timeout"[^>]*step="1000"/u);
  assert.match(html, /id="tasks-timeout-unit"[^>]*>秒</);
  assert.match(html, /id="tasks-timeout-reset"/);
  assert.match(html, /id="tasks-timeout-effective">—</);
  assert.match(html, /class="tasks-setting-row tasks-explicit-row" id="tasks-explicit-row" hidden/);
  assert.match(html, /<input id="tasks-runtime" type="text"[^>]*list="tasks-runtime-suggestions"/);
  assert.match(html, /<datalist id="tasks-runtime-suggestions"><\/datalist>/);
  assert.match(html, /id="tasks-runtime-help"/);
  assert.match(html, /id="tasks-runtime-help-tooltip"/);
  assert.match(html, /id="tasks-reset"[^>]*>重置</);
  assert.match(html, /id="tasks-save"[^>]*>套用</);
  assert.match(html, /id="tasks-refresh"/);
  // Restored read-only static template preview below the title band.
  assert.match(html, /id="tasks-preview-title">指令模板预览<\/h3>/);
  assert.match(html, /id="tasks-preview"/);
  assert.match(html, /id="tasks-detail-runtime"/);
  assert.doesNotMatch(html, /id="tasks-detail-runtime">未解析<\/p>/u);
  // Removed surface: multi-row form, additional-instructions editor, and catalog picks.
  assert.doesNotMatch(html, /tasks-instructions|tasks-model-select|tasks-runtime-field|附加指令/);
  assert.doesNotMatch(html, /tasks-global-editor|tasks-global-mode|tasks-global-save|tasks-global-reset|tasks-automatic-details|tasks-expected-tps|tasks-minimum-tps|tasks-intelligence-min|tasks-intelligence-max|tasks-max-output-price/);
  // The stats ledger page is untouched by this task.
  assert.match(html, /id="stats-task-runs-list"/);
  // The Task page still has exactly three compact editable rows and never hosts the auto cap.
  assert.equal((html.match(/<div class="tasks-setting-row/g) ?? []).length, 3);
  const tasksStart = html.indexOf('product-page tasks-page');
  const tasksEnd = html.indexOf('provider-dialog-backdrop');
  assert.ok(tasksStart > 0 && tasksEnd > tasksStart);
  assert.doesNotMatch(html.slice(tasksStart, tasksEnd), /auto-cap-input|auto-cap-save|max_auto_output_usd_per_million/);
});

test('renderer edits only alias-or-inline references and never enumerates catalog candidates', async () => {
  const app = await rendererSource();
  assert.match(app, /function referenceFromRuntimeInput\(value: string\): TaskSettingsExplicitReference/);
  assert.match(app, /const alias = runtimeAliasEntryForInput\(trimmed\);/);
  assert.match(app, /return alias \? \{ kind: 'alias', name: alias\.name \} : \{ kind: 'target', target: trimmed \};/);
  assert.match(app, /taskSettings\.aliases\.find\(\(entry\) => entry\.name === trimmed\)/);
  // Suggestions come from the read-only alias projection, never the model catalog.
  assert.match(app, /function populateRuntimeSuggestions\(\): void/);
  assert.match(app, /for \(const entry of taskSettings\?\.aliases \?\? \[\]\)/);
  assert.match(app, /option\.value = entry\.name;/);
  // Compact rows: mode, timeout (※ only timeout), conditional explicit combobox.
  assert.match(app, /function updateTasksRowVisibility\(\): void \{\s*tasksExplicitRow\.hidden = tasksModeSelect\.value !== 'explicit';\s*\}/);
  assert.match(app, /function renderTimeoutEffective\(row: TaskSettingsTaskRow\): void/);
  assert.match(app, /tasksTimeoutEffective\.classList\.add\('is-dim'\)/);
  assert.match(app, /function buildLayerPatch\(row: TaskSettingsTaskRow, modeValue: string, runtimeValue: string, timeoutValue: string\): TaskSettingsPatch/);
  assert.match(app, /if \(mode === 'explicit'\) \{\s*const runtime = referenceFromRuntimeInput\(runtimeValue\);/);
  assert.match(app, /async function saveTaskTimeoutReset\(\): Promise<void>/);
  assert.match(app, /commitTaskSave\(\{ timeout_ms: null \}\)/);
  assert.match(app, /'mode', 'explicit_runtime', 'timeout_ms', 'automatic'/);
  // No additional-instructions editor or catalog candidate synthesis surfaces exist.
  assert.doesNotMatch(app, /tasksInstructionsInput|tasksModelSelect|renderTasksChoiceOptions|tasksChoiceLabel|resolvedAdditionalInstructionsContent/);
  assert.doesNotMatch(app, /exactAgentRuntime|runtime_choices|resolved_runtime|additional_instructions|patch\.automatic|includeAutomatic/);
  // CAS conflict reloads authoritative state and re-applies only remaining visible fields.
  assert.match(app, /reloadTasksAuthoritative\(\)/);
  assert.match(app, /applyTaskDraft\(draft\)/);
  assert.match(app, /草稿仍保留/);
  assert.match(app, /interface TaskFormDraft \{ mode: string; runtime: string; timeout: string \}/);
});

test('renderer builds 内置/项目 hierarchy with authoritative labels and stable identity leaves', async () => {
  const app = await rendererSource();
  assert.match(app, /tasksList\.replaceChildren\(\)/);
  assert.match(app, /tasksCategoryHeader\('内置'/);
  assert.match(app, /tasksCategoryHeader\('项目'/);
  assert.match(app, /leaf\.setAttribute\('role', 'treeitem'\)/);
  assert.match(app, /label\.textContent = row\.display_name;/);
  assert.match(app, /projects\.get\(row\.project\)/);
  assert.match(app, /tasksCategoryHeader\(lead\?\.project_display_name \?\? project/);
  assert.match(app, /void selectTasksFile\(row\.identity\)/);
});

test('detail header shows display name, stable exact id, and resolved provider/model labels in the title band', async () => {
  const app = await rendererSource();
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(app, /tasksDetailName\.textContent = row\.display_name;/);
  assert.match(app, /tasksDetailIdentity\.textContent = row\.identity;/);
  // The title band resolves Provider · Model labels from the daemon dispatch and
  // surfaces a concrete issue/reason otherwise — never a permanent fallback pin.
  assert.match(app, /resolved\.provider_display_name \?\? resolved\.provider/);
  assert.match(app, /resolved\.model_display_name \?\? resolved\.model/);
  assert.match(app, /row\.automatic_selection\?\.reason/);
  assert.doesNotMatch(app, /'未解析'/u);
  assert.doesNotMatch(app, /exactAgentRuntime/);
  assert.doesNotMatch(app, /tasksPreviewTitle/);
  // Additive only: the Task page still has exactly three editable setting rows
  // and no new automatic-selection row or editable control.
  assert.equal((html.match(/<div class="tasks-setting-row/g) ?? []).length, 3);
  assert.doesNotMatch(html, /automatic-selection-row|tasks-auto-selection|id="tasks-automatic"/);
});

test('issue indicator is a focusable, accessible marker on tree leaves', async () => {
  const app = await rendererSource();
  assert.match(app, /indicator\.className = 'tasks-issue-indicator';/);
  assert.match(app, /indicator\.textContent = '!';/);
  assert.match(app, /indicator\.tabIndex = 0;/);
  assert.match(app, /indicator\.title = issues\.join\('\\n'\);/);
  assert.match(app, /indicator\.setAttribute\('aria-label', `需要处理：\$\{issues\.join\('；'\)\}`\);/);
});

test('tasks page is full-height with independently scrollable tree and detail panes', async () => {
  const css = await readFile(join(desktopRoot, 'src', 'renderer', 'app.css'), 'utf8');
  assert.match(css, /\.tasks-page \{[^}]*height: 100%;[^}]*display: flex;[^}]*flex-direction: column;[^}]*overflow: hidden;/);
  assert.match(css, /\.tasks-layout \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/);
  assert.match(css, /\.tasks-list-pane \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.tasks-detail \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.tasks-reset-flag \{[^}]*/);
  assert.match(css, /\.tasks-help-tooltip \{[^}]*/);
  assert.match(css, /\.tasks-effective-hint\.is-dim/);
});

test('Model Supply exposes exactly one global auto cap control with unit and tightening copy', async () => {
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.equal((html.match(/id="auto-cap-input"/g) ?? []).length, 1);
  assert.equal((html.match(/id="auto-cap-save"/g) ?? []).length, 1);
  assert.match(html, /<input id="auto-cap-input" type="number" min="0" step="0\.5"/);
  assert.match(html, /USD \/ 百万输出 Token/);
  assert.match(html, /只收紧/);
  assert.match(html, /placeholder="沿用各 Task 默认"/);
  // The panel lives on the Model Supply (quota) page, immediately before the alias panel.
  const quotaStart = html.indexOf('class="product-page quota-page"');
  const aliasTitle = html.indexOf('id="alias-title"');
  assert.ok(quotaStart > 0 && aliasTitle > quotaStart);
  const quotaMarkup = html.slice(quotaStart, aliasTitle);
  assert.match(quotaMarkup, /id="auto-cap-title"/);
  assert.match(quotaMarkup, /id="auto-cap-input"/);
  assert.match(quotaMarkup, /id="auto-cap-save"/);
  assert.match(quotaMarkup, /role="status"/);
});

test('renderer wires the Model Supply auto cap with global-scope CAS, zero/null handling, and conflict draft retention', async () => {
  const app = await rendererSource();
  assert.match(app, /const autoCapInput = requireElement<HTMLInputElement>\('auto-cap-input'\);/);
  assert.match(app, /const autoCapSaveButton = requireElement<HTMLButtonElement>\('auto-cap-save'\);/);
  assert.match(app, /async function loadAutoCapState\(preserveDraft = false\): Promise<void>/);
  assert.match(app, /autoCapInput\.value = autoCapDisplayValue\(autoCapSettings\.user_global\.max_auto_output_usd_per_million\);/);
  assert.match(app, /async function saveAutoCapState\(\): Promise<void>/);
  assert.match(app, /scope: 'global',/);
  assert.match(app, /expected_revision: snapshot\.revision,/);
  assert.match(app, /patch: \{ max_auto_output_usd_per_million: draftValue \},/);
  // Zero is preserved; an empty input clears via null.
  assert.match(app, /const draftValue = raw === '' \? null : Number\(raw\);/);
  assert.match(app, /parsed < 0/);
  // Conflict reload refreshes the authoritative snapshot but keeps the typed draft.
  assert.match(app, /autoCapSettings = await window\.wrenyardShell\.getTaskSettings\(\)\.catch\(\(\) => autoCapSettings\);/);
  assert.match(app, /保存冲突：已刷新到最新配置，你填写的值仍保留，请核对后重新保存。/);
  // Only this control is disabled while saving.
  assert.match(app, /autoCapSaveButton\.disabled = true;\s*autoCapInput\.disabled = true;/);
  // Quota navigation loads the authoritative snapshot.
  assert.match(app, /if \(page === 'quota'\) \{\s*await refreshQuota\(false\);\s*await loadRuntimeAliases\(\);\s*await loadAutoCapState\(\);\s*\}/);
});

test('task settings acceptance locks the post-fix surface: two-mode select with automatic default, seconds timeout round-trip and ※ reset, static template preview, and resolved provider/model labels', async () => {
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  const app = await rendererSource();
  const css = await readFile(join(desktopRoot, 'src', 'renderer', 'app.css'), 'utf8');
  const contract = readFileSync(join(desktopRoot, 'src', 'shell-contract.ts'), 'utf8');
  const resolvedDispatch = contract.slice(
    contract.indexOf('export interface TaskResolvedDispatch'),
    contract.indexOf('TaskSettingsInstructionSegment'),
  );

  // Mode selection is exactly automatic/explicit: the rejected third empty 继承 option is gone,
  // and an unset/legacy user layer renders as automatic instead of an empty inherit pin.
  assert.match(
    html,
    /<select id="tasks-mode">\s*<option value="automatic">自动选择<\/option>\s*<option value="explicit">指定运行时<\/option>\s*<\/select>/u,
  );
  assert.doesNotMatch(html, /<option value="">继承<\/option>/u);
  assert.match(app, /tasksModeSelect\.value = row\.user_task\.mode \?\? 'automatic';/u);
  assert.doesNotMatch(app, /row\.user_task\.mode \?\? ''/u);

  // Timeout is rendered and edited in seconds at the UI boundary only; 900000 ms shows as 900 秒,
  // the save path converts back to ms, and the ※ button clears just this layer's timeout override.
  assert.doesNotMatch(html, /id="tasks-timeout"[^>]*step="1000"/u);
  assert.doesNotMatch(app, /毫秒/u);
  assert.match(app, /1000/u);
  assert.match(app, /commitTaskSave\(\{ timeout_ms: null \}\)/u);

  // The read-only builtin instruction-template preview is restored below the title, with text and
  // replaceable placeholders rendered as distinct segments (styled placeholder visuals in CSS).
  assert.match(html, /id="tasks-preview-title">指令模板预览<\/h3>/u);
  assert.match(html, /id="tasks-preview"/u);
  assert.match(app, /row\.builtin\.instruction_template/u);
  assert.match(app, /kind === 'placeholder'/u);
  assert.match(css, /tasks-preview/u);

  // The settings DTO exposes authoritative provider/model display labels on the daemon-resolved
  // dispatch so the title-left state is never just a permanent 未解析 raw fallback.
  assert.match(resolvedDispatch, /provider_display_name/u);
  assert.match(resolvedDispatch, /model_display_name/u);
  assert.match(app, /provider_display_name/u);
  assert.doesNotMatch(html, /id="tasks-detail-runtime">未解析<\/p>/u);
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

function rendererSource(): Promise<string> {
  return readFile(join(desktopRoot, 'src', 'renderer', 'app.ts'), 'utf8');
}
