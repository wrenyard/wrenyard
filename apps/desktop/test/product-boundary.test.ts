import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
test('Desktop owns the product tray, Pet runtime, sessions, statistics and settings bridge', async () => {
  const [main, tray, quotaMenuIcon, contract, shellWindow, preload] = await Promise.all([
    readFile(join(desktopRoot, 'src', 'main.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'desktop-tray.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'quota-menu-icon.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'shell-contract.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'preload.ts'), 'utf8'),
  ]);

  assert.match(main, /createDesktopTray/);
  assert.match(main, /new DesktopPetController/);
  assert.match(main, /new DesktopPetRuntime/);
  assert.match(main, /app\.on\(['"]activate['"]/);
  assert.doesNotMatch(main, /app\.relaunch\(/);
  assert.match(main, /createMacQuitConfirmationGate\(\{ windowMs: 3_000 \}\)/);
  assert.match(main, /macQuitGate\(['"]accelerator['"]\)/);
  assert.match(main, /createDesktopTray\(\{[\s\S]*\},\s*process\.platform\)/);
  assert.match(tray, /new Tray\(/);
  assert.match(tray, /label: '打开'/);
  assert.match(tray, /if\s*\(\s*trayPrimaryClickOpensDesktop\(platform\)\s*\)\s*\{\s*tray\.on\(['"]click['"]/);
  assert.match(tray, /桌宠/);
  assert.match(tray, /label: '额度'/);
  assert.match(tray, /暂无可展示额度/);
  assert.doesNotMatch(tray, /未启用额度来源/);
  assert.match(tray, /label: '退出'/);
  assert.match(tray, /app\.quit\(\)/);
  assert.match(quotaMenuIcon, /nativeImage\.createFromBuffer/);
  assert.match(quotaMenuIcon, /setTemplateImage\(true\)/);
  assert.doesNotMatch(quotaMenuIcon, /createFromDataURL|<svg/);
  assert.doesNotMatch(tray, /啾啾工坊设置/);
  assert.doesNotMatch(tray, /退出啾啾工坊/);
  assert.match(contract, /savePetSettings/);
  assert.match(contract, /statsSnapshot/);
  assert.match(contract, /quotaSnapshot/);
  assert.match(contract, /saveProviderOrder/);
  // The retired DSH conversation bridge no longer exists in the contract.
  assert.doesNotMatch(contract, /conversationSnapshot|conversationChanged|dshVersion/);
  assert.match(shellWindow, /platformWindowChrome/);
  assert.match(preload, /platform: process\.platform/);
  assert.doesNotMatch(shellWindow, /WebContentsView/);
  assert.doesNotMatch(preload, /listDocs|readDoc|saveDoc|setDocsDirty|WorkspaceDoc/);
  assert.doesNotMatch(shellWindow, /docsList|docsRead|docsSave|docsDirty|WorkspaceDoc/);
  // The old DSH conversation bridge is neither exposed nor handled.
  assert.doesNotMatch(preload, /getConversation|selectConversation|sendConversation|conversationSnapshot/);
  assert.doesNotMatch(shellWindow, /options\.getConversation|options\.sendConversation|conversationSnapshot/);
});
