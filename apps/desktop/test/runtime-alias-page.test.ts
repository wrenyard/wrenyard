import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  type RuntimeAliasPutRequest,
  type RuntimeAliasRemoveRequest,
  type RuntimeAliasSnapshot,
  type WrenyardShellApi,
} from '../src/shell-contract.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('runtime alias CRUD is a typed preload surface with exact channels', () => {
  assert.equal(SHELL_CHANNELS.runtimeAliasSnapshot, 'wrenyard-shell:runtime-alias-snapshot');
  assert.equal(SHELL_CHANNELS.runtimeAliasPut, 'wrenyard-shell:runtime-alias-put');
  assert.equal(SHELL_CHANNELS.runtimeAliasRemove, 'wrenyard-shell:runtime-alias-remove');
  const aliasApi: Pick<WrenyardShellApi, 'runtimeAliasSnapshot' | 'runtimeAliasPut' | 'runtimeAliasRemove'> = {
    runtimeAliasSnapshot: async () => ({ revision: 'rev', aliases: [] }),
    runtimeAliasPut: async () => ({ revision: 'rev', aliases: [{ name: 'cc', target: 'anthropic/claude-sonnet-4:cc' }] }),
    runtimeAliasRemove: async () => ({ revision: 'rev', aliases: [] }),
  };
  assert.equal(typeof aliasApi.runtimeAliasSnapshot, 'function');
  assert.equal(typeof aliasApi.runtimeAliasPut, 'function');
  assert.equal(typeof aliasApi.runtimeAliasRemove, 'function');
  const putRequest: RuntimeAliasPutRequest = { expected_revision: 'rev-1', name: 'cc-fast', target: 'anthropic/claude-sonnet-4:cc' };
  const removeRequest: RuntimeAliasRemoveRequest = { expected_revision: 'rev-1', name: 'cc-fast' };
  assert.deepEqual(putRequest, { expected_revision: 'rev-1', name: 'cc-fast', target: 'anthropic/claude-sonnet-4:cc' });
  assert.deepEqual(removeRequest, { expected_revision: 'rev-1', name: 'cc-fast' });
  const snapshot: RuntimeAliasSnapshot = { revision: 'rev-2', aliases: [{ name: 'cc-fast', target: 'anthropic/claude-sonnet-4:cc' }] };
  assert.equal(snapshot.aliases[0]!.name, 'cc-fast');
  assert.equal(snapshot.aliases[0]!.target, 'anthropic/claude-sonnet-4:cc');
});

test('preload forwards the three runtime alias calls without raw IPC', () => {
  const preload = preloadSource();
  assert.match(preload, /runtimeAliasSnapshot\(\): Promise<RuntimeAliasSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.runtimeAliasSnapshot\)/);
  assert.match(preload, /runtimeAliasPut\(request: RuntimeAliasPutRequest\): Promise<RuntimeAliasSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.runtimeAliasPut, request\)/);
  assert.match(preload, /runtimeAliasRemove\(request: RuntimeAliasRemoveRequest\): Promise<RuntimeAliasSnapshot> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.runtimeAliasRemove, request\)/);
});

test('model supply page hosts a compact runtime alias CRUD section', async () => {
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="quota-page"/);
  assert.match(html, /<h1 id="quota-title">模型供应<\/h1>/);
  assert.match(html, /id="alias-title">运行时别名</);
  assert.match(html, /provider\/model:client/);
  assert.match(html, /id="alias-name-input"/);
  assert.match(html, /id="alias-target-input"[^>]*placeholder="provider\/model:client，例如 anthropic\/claude-sonnet-4:cc"/);
  assert.match(html, /id="alias-submit"[^>]*>保存别名</);
  assert.match(html, /id="alias-refresh"/);
  assert.match(html, /id="alias-refresh-label">刷新别名</);
  assert.match(html, /id="alias-error"/);
  assert.match(html, /id="alias-list"/);
  // The inline alias-name rule text is present but input is always editable.
  assert.match(html, /小写字母开头，仅限 a-z 0-9 \. _ -，最长 64 位/);
  assert.match(html, /同名保存为更新/);
});

test('renderer implements alias CRUD via typed methods, CAS revision, and visible errors', async () => {
  const app = await rendererSource();
  // Strict bounded name validation with the documented alias slug syntax.
  assert.match(app, /const RUNTIME_ALIAS_NAME_PATTERN = \/\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$\/;/);
  assert.match(app, /function validateAliasName\(name: string\): string \| null/);
  assert.match(app, /RUNTIME_ALIAS_NAME_PATTERN\.test\(name\)/);
  // Load, put, and remove all go through the typed preload methods.
  assert.match(app, /runtimeAliases = await window\.wrenyardShell\.runtimeAliasSnapshot\(\);/);
  assert.match(app, /runtimeAliases = await window\.wrenyardShell\.runtimeAliasPut\(\{/);
  assert.match(app, /expected_revision: runtimeAliases\?\.revision \?\? '',/);
  assert.match(app, /runtimeAliases = await window\.wrenyardShell\.runtimeAliasRemove\(\{/);
  assert.match(app, /expected_revision: runtimeAliases\.revision,/);
  // Canonical target editing stays bounded: non-empty, <= 512, plain text.
  assert.match(app, /if \(!target \|\| target\.length > 512\) \{/);
  assert.match(app, /provider\/model:client/);
  // Writes refresh the alias list from the returned snapshot and show errors inline.
  assert.match(app, /function renderAliasList\(\): void/);
  assert.match(app, /function loadRuntimeAliases\(\): Promise<void>/);
  assert.match(app, /function saveAliasEntry\(\): Promise<void>/);
  assert.match(app, /async function removeAlias\(name: string\): Promise<void>/);
  assert.match(app, /aliasError\.textContent = `保存失败：\$\{aliasErrorMessage\(error\)\}`;/);
  assert.match(app, /aliasError\.textContent = `删除失败：\$\{aliasErrorMessage\(error\)\}`;/);
  assert.match(app, /保存冲突：别名列表已刷新/);
  assert.match(app, /删除冲突：别名列表已刷新/);
  assert.doesNotMatch(app, /ipcRenderer|contextBridge/);
});

test('shell-window adds bounded alias handlers beside the task settings handlers', () => {
  const win = shellWindowSource();
  assert.match(win, /options\.runtimeAliasSnapshot\(\)/);
  assert.match(win, /options\.runtimeAliasPut\(validateRuntimeAliasPutRequest\(request\)\)/);
  assert.match(win, /options\.runtimeAliasRemove\(validateRuntimeAliasRemoveRequest\(request\)\)/);
  assert.match(win, /function validateRuntimeAliasPutRequest\(value: unknown\): RuntimeAliasPutRequest/);
  assert.match(win, /function validateRuntimeAliasRemoveRequest\(value: unknown\): RuntimeAliasRemoveRequest/);
  assert.match(win, /const RUNTIME_ALIAS_NAME = \/\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$\/;/);
  assert.match(win, /运行时别名格式无效/);
  assert.match(win, /RUNTIME_ALIAS_TARGET_MAX/);
  assert.match(win, /运行时别名版本基线无效/);
  assert.match(win, /SHELL_CHANNELS\.runtimeAliasSnapshot,/);
  assert.match(win, /SHELL_CHANNELS\.runtimeAliasPut,/);
  assert.match(win, /SHELL_CHANNELS\.runtimeAliasRemove,/);
});

test('main bridges alias snapshot/put/remove with exact public methods and CAS fields', () => {
  const main = mainSource();
  assert.match(main, /requestForeman\(\s*'runtime\.alias\.snapshot'/);
  assert.match(main, /requestForeman\(\s*'runtime\.alias\.put'/);
  assert.match(main, /expected_revision: request\.expected_revision,/);
  assert.match(main, /name: request\.name,/);
  assert.match(main, /target: request\.target,/);
  assert.match(main, /requestForeman\(\s*'runtime\.alias\.remove'/);
  assert.match(main, /name: request\.name,/);
  assert.match(main, /const RUNTIME_ALIAS_ERROR_MESSAGES/);
  assert.match(main, /content_conflict: '运行时别名已被外部修改，保存冲突'/);
  assert.match(main, /invalid_name: '运行时别名格式无效'/);
  assert.match(main, /invalid_target: '运行时目标无效'/);
  assert.match(main, /runtimeAliasSnapshot: \(\) => getRuntimeAliasSnapshot\(\)/);
  assert.match(main, /runtimeAliasPut: \(request: RuntimeAliasPutRequest\) => putRuntimeAlias\(request\)/);
  assert.match(main, /runtimeAliasRemove: \(request: RuntimeAliasRemoveRequest\) => removeRuntimeAlias\(request\)/);
});

test('alias CRUD is styled in the existing warm workshop language on the quota page', async () => {
  const css = await readFile(join(desktopRoot, 'src', 'renderer', 'app.css'), 'utf8');
  assert.match(css, /\.alias-panel \{/);
  assert.match(css, /\.alias-panel-head h2 \{/);
  assert.match(css, /\.alias-form input \{/);
  assert.match(css, /\.alias-name-rule \{/);
  assert.match(css, /\.alias-error \{/);
  assert.match(css, /\.alias-list \{/);
  assert.match(css, /\.alias-row \{[^}]*grid-template-columns: 130px minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.alias-row code \{/);
  assert.match(css, /@media \(max-width: 820px\)/);
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
