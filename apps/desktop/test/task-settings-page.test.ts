import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  isShellPage,
  type TaskSettingsEffective,
  type TaskSettingsEligibleChoice,
  type TaskSettingsSaveRequest,
  type TaskSettingsSnapshot,
  type WrenyardShellApi,
} from '../src/shell-contract.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function eligibleChoice(exactAgentRuntime: string, client: string, provider: string, model: string): TaskSettingsEligibleChoice {
  return {
    exactAgentRuntime,
    client,
    provider,
    model,
    model_id: `${provider}/${model}`,
    mode: 'native',
    intelligence: 'mid',
    speed: {
      effective_tps: 107,
      source: 'catalog_default',
      sample_count: 0,
      checked_at: '2026-09-05T00:00:00.000Z',
      expected_tps_met: true,
    },
    reference_pricing: {
      input_usd_per_million: 0.2,
      output_usd_per_million: 1.2,
      source: 'catalog',
      checked_at: '2026-09-05T00:00:00.000Z',
    },
  };
}

function automaticEffective(): TaskSettingsEffective['automatic'] {
  return {
    expected_tps: { value: null, source: 'builtin' },
    minimum_tps: { value: null, source: 'builtin' },
    intelligence_min: { value: null, source: 'builtin' },
    intelligence_max: { value: null, source: 'builtin' },
    max_output_usd_per_million: { value: null, source: 'builtin' },
    required_capabilities: { value: null, source: 'builtin' },
    exclude_model_ids: { value: null, source: 'builtin' },
    exclude_profile_ids: { value: null, source: 'builtin' },
    exclude_client_ids: { value: null, source: 'builtin' },
    exclude_provider_ids: { value: null, source: 'builtin' },
    preferred_runtime: { value: null, source: 'builtin' },
  };
}

function effectiveRow(): TaskSettingsEffective {
  return {
    mode: { value: 'automatic', source: 'user_global' },
    explicit_runtime: { value: null, source: 'builtin' },
    timeout_ms: { value: 120_000, source: 'user_global' },
    additional_instructions: { value: '全局附加指令', source: 'user_global' },
    automatic: automaticEffective(),
  };
}

function taskSnapshot(revision = 'rev-1'): TaskSettingsSnapshot {
  return {
    config_path: '/Users/me/.wrenyard/tasks/config.json',
    revision,
    user_global: { additional_instructions: '全局附加指令' },
    rows: [
      {
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
            { kind: 'text', source: 'shell', text: '开始工作。' },
            { kind: 'additional_instructions', source: 'shell' },
          ],
          declared_runtime: null,
          timeout_ms: 300_000,
          dispatch: {},
        },
        user_task: { additional_instructions: '只改 BUILD 目录。' },
        effective: effectiveRow(),
        runtime_choices: [eligibleChoice('forge/codex-luna', 'codex', 'codex', 'gpt-5.6-luna')],
        resolved_runtime: null,
        issues: [{ code: 'stale', message: '运行时已下线' }],
      },
      {
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
            { kind: 'additional_instructions', source: 'project' },
          ],
          declared_runtime: null,
          timeout_ms: null,
          dispatch: {},
        },
        user_task: { mode: 'explicit', explicit_runtime: { client: 'kimi', provider: 'kimi', model: 'kimi-k3' } },
        effective: {
          ...effectiveRow(),
          mode: { value: 'explicit', source: 'user_task' },
          explicit_runtime: { value: { client: 'kimi', provider: 'kimi', model: 'kimi-k3' }, source: 'user_task' },
          additional_instructions: { value: '发布前确认。', source: 'user_task' },
        },
        runtime_choices: [eligibleChoice('acme/kimi', 'kimi', 'kimi', 'kimi-k3')],
        resolved_runtime: eligibleChoice('acme/kimi', 'kimi', 'kimi', 'kimi-k3'),
        issues: [],
      },
    ],
  };
}

test('tasks is a registered, navigator-aware shell page with no legacy preference channels', () => {
  assert.equal(isShellPage('tasks'), true);
  assert.equal(SHELL_CHANNELS.taskSettingsSnapshot, 'wrenyard-shell:task-settings-snapshot');
  assert.equal(SHELL_CHANNELS.taskSettingsSave, 'wrenyard-shell:task-settings-save');
});

test('snapshot rows expose authoritative display labels, ordered template, and resolved runtime', () => {
  const snapshot = taskSnapshot();
  const builtinRow = snapshot.rows[0]!;
  const projectRow = snapshot.rows[1]!;
  assert.equal(builtinRow.identity, 'builtin:build');
  assert.equal(builtinRow.name, 'build');
  assert.equal(builtinRow.display_name, '构建任务');
  assert.equal(builtinRow.project, undefined);
  assert.equal('project_display_name' in builtinRow, false);
  assert.equal(projectRow.project, 'acme');
  assert.equal(projectRow.project_display_name, '产品组 Acme');
  assert.equal(projectRow.display_name, '发布上线');
  assert.deepEqual(
    Object.keys(builtinRow).sort(),
    ['builtin', 'display_name', 'effective', 'identity', 'issues', 'name', 'resolved_runtime', 'runtime_choices', 'user_task'],
  );
  assert.deepEqual(
    builtinRow.builtin.instruction_template.map((segment) => segment.kind),
    ['text', 'placeholder', 'text', 'additional_instructions'],
  );
  assert.equal(builtinRow.builtin.instruction_template.filter((segment) => segment.kind === 'placeholder')[0]?.label, '任务说明');
  assert.equal(builtinRow.resolved_runtime, null);
  assert.equal(projectRow.resolved_runtime?.exactAgentRuntime, 'acme/kimi');
  assert.equal(projectRow.effective.mode.value, 'explicit');
  assert.deepEqual(builtinRow.issues, [{ code: 'stale', message: '运行时已下线' }]);
});

test('WrenyardShellApi exposes the typed snapshot/save surface only', () => {
  const api: Pick<WrenyardShellApi, 'getTaskSettings' | 'saveTaskSettings'> = {
    getTaskSettings: async () => taskSnapshot('revision-1'),
    saveTaskSettings: async () => taskSnapshot('revision-2'),
  };
  assert.equal(typeof api.getTaskSettings, 'function');
  assert.equal(typeof api.saveTaskSettings, 'function');
});

test('save request carries a bounded task patch with exact identity, project scope, and CAS revision', () => {
  const taskSave: TaskSettingsSaveRequest = {
    scope: 'task',
    task_id: 'project:acme:deploy',
    project: 'acme',
    expected_revision: 'row-rev',
    patch: {
      mode: 'explicit',
      explicit_runtime: { client: 'kimi', provider: 'kimi', model: 'kimi-k3' },
    },
  };
  assert.equal(taskSave.scope, 'task');
  assert.equal(taskSave.task_id, 'project:acme:deploy');
  assert.equal(taskSave.project, 'acme');
  assert.equal(taskSave.expected_revision, 'row-rev');
  assert.deepEqual(Object.keys(taskSave.patch).sort(), ['explicit_runtime', 'mode']);
  // The explicit runtime is exactly the client/provider/model triple.
  assert.deepEqual(taskSave.patch.explicit_runtime, { client: 'kimi', provider: 'kimi', model: 'kimi-k3' });
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
  assert.doesNotMatch(main, /saveTaskPreference|agent_runtime:|requested_agent_runtime|bare_task_name|machine_global|任务偏好已被外部修改/);
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
  // Mode is the real wire enum automatic|explicit — never the invented 'auto'.
  assert.match(win, /mode !== 'automatic' && mode !== 'explicit'/);
  assert.doesNotMatch(win, /mode !== 'auto' && mode !== 'explicit'/);
  // Explicit runtime is exactly the client/provider/model triple, never agent_runtime.
  assert.match(win, /'client', 'provider', 'model'/);
  assert.doesNotMatch(win, /agent_runtime/);
  assert.doesNotMatch(win, /saveTaskPreference|requested_agent_runtime|agentRuntime|bare_task_name|machine_global/);
});

test('HTML exposes only the approved task surface with 内置/项目 tree and exact actions', async () => {
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="tasks-nav"[^>]+aria-label="任务" data-page="tasks"/);
  assert.match(html, /id="tasks-page"/);
  assert.match(html, /id="tasks-title">任务</);
  assert.match(html, /class="tasks-tree" id="tasks-list" role="tree" aria-label="任务目录"/);
  assert.match(html, /id="tasks-detail"/);
  assert.match(html, /id="tasks-detail-name"/);
  assert.match(html, /id="tasks-detail-identity"/);
  assert.match(html, /id="tasks-detail-runtime">未解析</);
  assert.match(html, /id="tasks-mode"><option value="">继承<\/option><option value="automatic">自动选择<\/option><option value="explicit">指定运行时<\/option>/);
  assert.match(html, /id="tasks-runtime-field" hidden/);
  assert.match(html, /id="tasks-model-select"/);
  assert.match(html, /id="tasks-timeout" type="number" min="1" step="1000" placeholder="继承"/);
  assert.match(html, /id="tasks-instructions"[^>]*maxlength="4000"/);
  assert.match(html, /id="tasks-preview-title">指令模板预览</);
  assert.match(html, /id="tasks-preview"/);
  assert.match(html, /id="tasks-reset"[^>]*>重置</);
  assert.match(html, /id="tasks-save"[^>]*>套用</);
  assert.match(html, /id="tasks-refresh"/);
  assert.doesNotMatch(html, /tasks-global-editor|tasks-global-mode|tasks-global-save|tasks-global-reset|tasks-meta|tasks-status|tasks-automatic-details|tasks-expected-tps|tasks-minimum-tps|tasks-intelligence-min|tasks-intelligence-max|tasks-max-output-price|tasks-detail-card|tasks-detail-project|tasks-detail-source|tasks-mode-source|tasks-runtime-source|tasks-timeout-source|tasks-instructions-source/);
  assert.doesNotMatch(html, /重置本层|保存全局默认|保存任务设置|系统 → 内置 → 全局默认|自动选择约束|继承来源与任务元数据/);
  // The stats ledger page is untouched by this task.
  assert.match(html, /id="stats-task-runs-list"/);
});

test('renderer reuses the safe rich-text renderer for the ordered template preview', async () => {
  const app = await rendererSource();
  const conversation = await readFile(join(desktopRoot, 'src', 'renderer', 'conversation.ts'), 'utf8');
  assert.match(conversation, /export function renderRichText\(text: string\): DocumentFragment/);
  assert.match(app, /import \{ ConversationView, renderRichText \} from '\.\/conversation\.js';/);
  assert.match(app, /for \(const segment of row\.builtin\.instruction_template\)/);
  assert.match(app, /renderRichText\(segment\.text\)/);
  assert.match(app, /renderRichText\(content\)/);
  // Placeholder segments become structural styled spans; nothing is executed or string-matched.
  assert.match(app, /segment\.kind === 'text'/);
  assert.match(app, /segment\.kind === 'placeholder'/);
  assert.match(app, /segment\.kind === 'additional_instructions'/);
  assert.match(app, /chip\.className = 'task-preview-placeholder'/);
  assert.match(app, /chip\.textContent = segment\.label;/);
  assert.doesNotMatch(app, /new Function\(|Function\.toString|eval\(/);
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
  assert.doesNotMatch(app, /tasks-source-pill|taskModeLabel\(row\.effective/);
});

test('detail header shows display name, stable exact id, and resolved runtime including null', async () => {
  const app = await rendererSource();
  assert.match(app, /tasksDetailName\.textContent = row\.display_name;/);
  assert.match(app, /tasksDetailIdentity\.textContent = row\.identity;/);
  assert.match(app, /tasksDetailRuntime\.textContent = row\.resolved_runtime\?\.exactAgentRuntime \?\? '未解析';/);
  assert.doesNotMatch(app, /tasksDetailProject|PROJECT \$\{row\.project\}/);
});

test('issue indicator is a focusable, accessible marker on tree leaves', async () => {
  const app = await rendererSource();
  assert.match(app, /indicator\.className = 'tasks-issue-indicator';/);
  assert.match(app, /indicator\.textContent = '!';/);
  assert.match(app, /indicator\.tabIndex = 0;/);
  assert.match(app, /indicator\.title = issues\.join\('\\n'\);/);
  assert.match(app, /indicator\.setAttribute\('aria-label', `需要处理：\$\{issues\.join\('；'\)\}`\);/);
});

test('explicit runtime selector is visible only when the task-level mode equals explicit', async () => {
  const app = await rendererSource();
  assert.match(app, /function updateTasksModeVisibility\(\): void \{\s*tasksRuntimeField\.hidden = tasksModeSelect\.value !== 'explicit';\s*\}/);
  assert.match(app, /tasksModeSelect\.addEventListener\('change', \(\) => updateTasksModeVisibility\(\)\);/);
  assert.match(app, /renderTasksChoiceOptions\(tasksModelSelect, row\.runtime_choices\)/);
  assert.match(app, /option\.value = choice\.exactAgentRuntime;/);
  assert.match(app, /\[choice\.client, choice\.provider, choice\.model\]/);
  assert.doesNotMatch(app, /tasksAutomaticDetails/);
});

test('apply omits automatic, reset clears the task layer, and CAS preserves the remaining draft', async () => {
  const app = await rendererSource();
  assert.match(app, /saveTaskSettings\(\{ scope: 'task', task_id: row\.identity/);
  assert.match(app, /project: row\.project/);
  assert.match(app, /function buildLayerPatch\(layer: TaskSettingsLayer, modeValue: string, runtimeSelect: HTMLSelectElement, choices: readonly TaskSettingsEligibleChoice\[\], timeoutValue: string, instructionsValue: string\)/);
  // Apply never writes automatic, preserving any hidden persisted automatic overrides.
  assert.doesNotMatch(app, /includeAutomatic|patch\.automatic/);
  assert.doesNotMatch(app, /saveTaskSettings\(\{ scope: 'global'/);
  // Reset still clears every task-layer field, including legacy automatic settings.
  assert.match(app, /reset \? resetPatch\(row\.user_task\)/);
  assert.match(app, /'mode', 'explicit_runtime', 'timeout_ms', 'additional_instructions', 'automatic'/);
  // CAS conflict reloads authoritative state and re-applies only remaining visible fields.
  assert.match(app, /reloadTasksAuthoritative\(\)/);
  assert.match(app, /applyTaskDraft\(draft\)/);
  assert.match(app, /草稿仍保留/);
  assert.match(app, /interface TaskFormDraft \{ mode: string; runtime: string; timeout: string; instructions: string \}/);
  assert.doesNotMatch(app, /expected:|intelligenceMin:|price:/);
});

test('template preview resolves additional-instruction content draft-aware with user_global fallback', async () => {
  const app = await rendererSource();
  assert.match(app, /function resolvedAdditionalInstructionsContent\(row: TaskSettingsTaskRow\): string \| null/);
  // trim is only the emptiness probe; the nonempty draft is returned verbatim,
  // preserving leading/trailing whitespace and line breaks.
  assert.match(app, /const draft = tasksInstructionsInput\.value;/);
  assert.match(app, /if \(draft\.trim\(\) !== ''\) return draft;/);
  assert.doesNotMatch(app, /const draft = tasksInstructionsInput\.value\.trim\(\);/);
  assert.match(app, /user_global\.additional_instructions/);
  assert.match(app, /row\.effective\.additional_instructions\.value/);
  assert.match(app, /'无附加指令'/);
  assert.match(app, /tasksInstructionsInput\.addEventListener\('input', \(\) => renderTasksPreview\(\)\);/);
});

test('global/metadata/source/automatic renderer functions and panels are gone', async () => {
  const app = await rendererSource();
  assert.doesNotMatch(app, /tasksGlobalMode|tasksGlobalSave|tasksGlobalRuntime|populateGlobalForm|saveGlobalLayer|setTasksStatus|taskSourceLabel|taskModeLabel|tasksReadonlyRow|taskContractValue|tasksDetailCard|setSourceText|tasksExpectedTps|tasksMinimumTps|tasksIntelligenceMin|tasksMaxOutputPrice/);
  assert.doesNotMatch(app, /保存任务设置|保存全局默认|重置本层/);
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
