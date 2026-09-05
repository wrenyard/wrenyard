import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const petRoot = join(desktopRoot, '..', 'pet');

test('Desktop owns the product tray, Pet runtime, conversations, statistics and settings bridge', async () => {
  const [main, tray, quotaMenuIcon, contract, renderer, rendererScript, rendererStyles, conversationRenderer, shellWindow, preload] = await Promise.all([
    readFile(join(desktopRoot, 'src', 'main.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'desktop-tray.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'quota-menu-icon.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'shell-contract.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'app.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'app.css'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'conversation.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'preload.ts'), 'utf8'),
  ]);

  assert.match(main, /createDesktopTray/);
  assert.match(main, /new DesktopPetController/);
  assert.match(main, /new DesktopPetRuntime/);
  assert.match(main, /app\.on\(['"]activate['"]/);
  assert.doesNotMatch(main, /app\.relaunch\(/);
  assert.match(tray, /new Tray\(/);
  assert.match(tray, /label: '打开'/);
  assert.match(tray, /tray\.on\(['"]click['"],?\s*\(?[^)]*\)?\s*=>\s*options\.openDesktop/);
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
  assert.match(contract, /conversationSnapshot/);
  assert.match(renderer, /id="stats-page"/);
  assert.match(renderer, /id="stats-heat-tooltip"/);
  assert.doesNotMatch(renderer, /最近一年；每列一周|具名 Profile 的调度|按累计耗时排序/);
  assert.match(renderer, /id="desktop-build-time"/);
  assert.doesNotMatch(renderer, /stats-day-label|SQLite 权威汇总/);
  assert.match(renderer, /id="quota-page"/);
  assert.match(renderer, /id="quota-nav"[^>]+aria-label="模型供应"/);
  assert.match(renderer, /id="quota-title">模型供应/);
  assert.match(renderer, /模型供应/);
  assert.match(renderer, /id="quota-provider-grid"/);
  assert.match(renderer, /Provider 次序同时用于模型供应与额度显示/);
  assert.doesNotMatch(renderer, /id="pet-provider-list"|settings-subtitle">额度来源/);
  assert.doesNotMatch(rendererScript, /function renderProviders|function moveProvider/);
  assert.match(rendererScript, /formatCompactTokenCount/);
  assert.doesNotMatch(rendererScript, /cell\.title = tooltipLines/);
  assert.match(rendererScript, /entry\.configured \? quotaProviderOrderButtons/);
  assert.match(rendererScript, /entry\.configured \? '更新 Key' : '激活 Provider'/);
  assert.match(rendererStyles, /grid-template-columns: minmax\(200px, \.9fr\) minmax\(0, 1\.6fr\) 176px/);
  assert.match(rendererStyles, /\.provider-directory-action \{ width: 176px;/);
  assert.match(rendererStyles, /grid-auto-flow: column/);
  assert.match(rendererStyles, /grid-template-rows: repeat\(7,/);
  assert.match(renderer, /id="provider-dialog"/);
  assert.doesNotMatch(renderer, /id="model-list"/);
  assert.doesNotMatch(renderer, /id="models"/);
  assert.match(renderer, /id="conversation-composer"/);
  assert.match(renderer, /id="conversation-workspace">工坊工作区/);
  assert.match(renderer, /id="conversation-model-trigger"[^>]+aria-label="当前会话模型"[^>]+aria-haspopup="listbox"/);
  assert.match(renderer, /id="conversation-model-list" role="listbox"/);
  assert.doesNotMatch(renderer, /id="conversation-model-select"|<select[^>]+当前会话模型/);
  assert.doesNotMatch(renderer, /<span>模型<\/span>/);
  assert.match(renderer, /id="conversation-daemon-status"[^>]+role="status"/);
  assert.match(renderer, /id="conversation-daemon-tooltip" role="tooltip"/);
  assert.doesNotMatch(renderer, /可以开始/);
  assert.match(conversationRenderer, /workspaceLabel\.textContent = '工坊工作区'/);
  assert.doesNotMatch(conversationRenderer, /conversation-state|可以开始|工坊工作中/);
  assert.doesNotMatch(conversationRenderer, /workspacePath\.split/);
  assert.match(conversationRenderer, /createElement\('table'\)/);
  assert.match(conversationRenderer, /createElement\('hr'\)/);
  assert.match(conversationRenderer, /expandedItemIds/);
  assert.match(conversationRenderer, /catalogProvider/);
  assert.match(conversationRenderer, /ArrowDown/);
  assert.match(conversationRenderer, /ArrowUp/);
  assert.match(conversationRenderer, /event\.key === 'Enter'/);
  assert.match(conversationRenderer, /event\.key === 'Escape'/);
  assert.match(conversationRenderer, /document\.addEventListener\('pointerdown'/);
  assert.match(conversationRenderer, /setQuotaSnapshot/);
  assert.match(conversationRenderer, /presentation\.status/);
  assert.doesNotMatch(conversationRenderer, /presentation\.indicators/);
  assert.match(conversationRenderer, /section\.append\(heading\)/);
  assert.match(conversationRenderer, /setAttribute\('aria-disabled'/);
  assert.match(conversationRenderer, /directory\.status === 'loading'/);
  assert.match(conversationRenderer, /getAttribute\('aria-disabled'\) === 'true'/);
  assert.match(conversationRenderer, /modelTrigger\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(conversationRenderer, /setInterval|listProviders|configureProvider/);
  assert.match(rendererStyles, /i\.is-green/);
  assert.match(rendererStyles, /i\.is-yellow/);
  assert.match(rendererStyles, /i\.is-red/);
  assert.doesNotMatch(rendererStyles, /i\.is-balance|i\.is-quota-plan|i\.is-pace-low|i\.is-quota-low|i\.is-quota-empty/);
  assert.doesNotMatch(conversationRenderer, /pinnedToBottom \|\| snapshot\.selectedRunning/);
  assert.match(rendererStyles, /::-webkit-scrollbar-thumb/);
  assert.match(rendererStyles, /data-platform="win32"/);
  assert.match(shellWindow, /platformWindowChrome/);
  assert.match(preload, /platform: process\.platform/);
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
