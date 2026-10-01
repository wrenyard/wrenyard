import assert from 'node:assert/strict';
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
import {
  ALIAS_NAME_PATTERN,
  ALIAS_TARGET_MAX_LENGTH,
  validateAlias,
} from '../src/renderer/pages/settings/model/settings.js';

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

test('runtime alias validation is bounded to the documented slug and target limits', () => {
  assert.equal(ALIAS_TARGET_MAX_LENGTH, 512);
  assert.equal(validateAlias('cc-fast', 'anthropic/claude-sonnet-4:cc'), null);
  assert.equal(validateAlias('bad name', 'target'), 'invalid-name');
  assert.equal(validateAlias('', 'target'), 'invalid-name');
  assert.equal(validateAlias('cc', ''), 'empty-target');
  assert.equal(validateAlias('cc', 'x'.repeat(ALIAS_TARGET_MAX_LENGTH + 1)), 'long-target');
  assert.equal(ALIAS_NAME_PATTERN.test('a'.repeat(64)), true);
  assert.equal(ALIAS_NAME_PATTERN.test('a'.repeat(65)), false);
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

function preloadSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'preload.ts'), 'utf8');
}

function mainSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'main.ts'), 'utf8');
}

function shellWindowSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8');
}
