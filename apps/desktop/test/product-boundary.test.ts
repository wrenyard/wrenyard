import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const petRoot = join(desktopRoot, '..', 'pet');

test('Desktop owns the product tray, Pet runtime, conversations, statistics and settings bridge', async () => {
  const [main, tray, quotaMenuIcon, contract, renderer, rendererStyles, conversationRenderer, shellWindow] = await Promise.all([
    readFile(join(desktopRoot, 'src', 'main.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'desktop-tray.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'quota-menu-icon.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'shell-contract.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'app.css'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'conversation.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8'),
  ]);

  assert.match(main, /createDesktopTray/);
  assert.match(main, /new DesktopPetController/);
  assert.match(main, /new DesktopPetRuntime/);
  assert.match(main, /app\.on\(['"]activate['"]/);
  assert.doesNotMatch(main, /app\.relaunch\(/);
  assert.match(tray, /new Tray\(/);
  assert.match(tray, /label: '打开'/);
  assert.doesNotMatch(tray, /tray\.on\(['"]click['"]/);
  assert.match(tray, /桌宠/);
  assert.match(tray, /label: '额度'/);
  assert.match(tray, /label: '退出'/);
  assert.match(quotaMenuIcon, /nativeImage\.createFromBuffer/);
  assert.match(quotaMenuIcon, /setTemplateImage\(true\)/);
  assert.doesNotMatch(quotaMenuIcon, /createFromDataURL|<svg/);
  assert.doesNotMatch(tray, /啾啾工坊设置/);
  assert.doesNotMatch(tray, /退出啾啾工坊/);
  assert.match(contract, /savePetSettings/);
  assert.match(contract, /statsSnapshot/);
  assert.match(contract, /quotaSnapshot/);
  assert.match(contract, /saveProviderOrder/);
  assert.match(contract, /conversationSnapshot/);
  assert.match(renderer, /id="stats-page"/);
  assert.doesNotMatch(renderer, /stats-day-label|SQLite 权威汇总/);
  assert.match(renderer, /id="quota-page"/);
  assert.match(renderer, /id="quota-nav"[^>]+aria-label="模型供应"/);
  assert.match(renderer, /id="quota-title">模型供应/);
  assert.match(renderer, /模型供应/);
  assert.match(renderer, /id="quota-provider-grid"/);
  assert.match(renderer, /共享同一排序/);
  assert.match(rendererStyles, /grid-template-columns: minmax\(200px, \.9fr\) minmax\(0, 1\.6fr\) 176px/);
  assert.match(rendererStyles, /\.provider-directory-action \{ width: 176px;/);
  assert.match(renderer, /id="provider-dialog"/);
  assert.doesNotMatch(renderer, /id="model-list"/);
  assert.doesNotMatch(renderer, /id="models"/);
  assert.match(renderer, /id="conversation-composer"/);
  assert.match(renderer, /id="conversation-workspace">工坊工作区/);
  assert.match(renderer, /id="conversation-model-select" aria-label="当前会话模型"/);
  assert.doesNotMatch(renderer, /<span>模型<\/span>/);
  assert.match(renderer, /id="conversation-daemon-status"[^>]+role="status"/);
  assert.match(renderer, /id="conversation-daemon-tooltip" role="tooltip"/);
  assert.doesNotMatch(renderer, /可以开始/);
  assert.match(conversationRenderer, /workspaceLabel\.textContent = '工坊工作区'/);
  assert.doesNotMatch(conversationRenderer, /conversation-state|可以开始|工坊工作中/);
  assert.doesNotMatch(conversationRenderer, /workspacePath\.split/);
  assert.match(renderer, /id="workspace-gate"/);
  assert.match(renderer, /class="activity-brand" role="img" aria-label="啾啾工坊标识"/);
  assert.match(renderer, /id="workbench-nav"[^>]+aria-label="会话"/);
  assert.doesNotMatch(renderer, /<button class="activity-brand"/);
  assert.doesNotMatch(shellWindow, /WebContentsView/);
});

test('Pet entrypoint remains a headless companion without product UI ownership', async () => {
  const [main, preload, packageJson] = await Promise.all([
    readFile(join(petRoot, 'src', 'main', 'index.ts'), 'utf8'),
    readFile(join(petRoot, 'src', 'main', 'preload.ts'), 'utf8'),
    readFile(join(petRoot, 'package.json'), 'utf8'),
  ]);

  assert.doesNotMatch(main, /\bTray\b|createTray/);
  assert.doesNotMatch(main, /openSettings\(/);
  assert.doesNotMatch(main, /PanelOwner|stats:load|house:open-stats/);
  assert.doesNotMatch(main, /new QuotaService|quotaRefreshTimer/);
  assert.doesNotMatch(preload, /settingsPanelApi/);
  assert.doesNotMatch(preload, /statsPanelApi|openStats|openSettings/);
  assert.doesNotMatch(packageJson, /settings\.html|settings\.js|stats\.html|stats\.js/);
});
