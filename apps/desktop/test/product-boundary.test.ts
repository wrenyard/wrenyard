import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const petRoot = join(desktopRoot, '..', 'pet');

test('Desktop owns the product tray, Pet runtime, conversations, statistics and settings bridge', async () => {
  const [main, tray, quotaMenuIcon, contract, renderer, shellWindow] = await Promise.all([
    readFile(join(desktopRoot, 'src', 'main.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'desktop-tray.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'quota-menu-icon.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'shell-contract.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8'),
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
  assert.match(contract, /conversationSnapshot/);
  assert.match(renderer, /id="stats-page"/);
  assert.match(renderer, /id="quota-page"/);
  assert.match(renderer, /id="quota-nav"[^>]+aria-label="额度"/);
  assert.match(renderer, /id="conversation-composer"/);
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
