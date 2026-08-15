// ── Stats E2E capture harness ─────────────────────────────────────────
// Loads the built production dist/renderer/stats.html with the production
// preload and security options (contextIsolation, sandbox, no node, child
// windows denied). Fakes only the sender-bound stats IPC boundary
// (stats:load) so every other renderer path runs production code.
// Captures the Chinese three-section ledger (摘要 / 运行统计 / 任务统计)
// backed by stats.summary.windows:
//   - normal: full three-window payload at 440x640
//   - legacy: no windows at all (today/daily/strip preserved)
//   - empty:  windows present but zero profiles/tasks
//   - narrow: normal payload at the 400x480 minimums
// Always captured with capturePage(undefined, { stayHidden: true }).

import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captureBase = path.join(rootDir, 'artifacts', 'stats-e2e');
const htmlDir = path.join(rootDir, 'dist', 'renderer');
const preloadDir = path.join(rootDir, 'dist', 'main', 'main');
const electronDataDir = path.join(captureBase, 'electron-user-data');

const POLL_MS = 25;
const CASE_TIMEOUT_MS = 15000;
const STATS_WIDTH = 440;
const STATS_HEIGHT = 640;
const STATS_MIN_WIDTH = 400;
const STATS_MIN_HEIGHT = 480;

fs.mkdirSync(electronDataDir, { recursive: true });
fs.mkdirSync(captureBase, { recursive: true });
app.setPath('userData', electronDataDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// ── Fixtures ───────────────────────────────────────────────────────────

function buildDailyBuckets() {
  var days = [];
  for (var i = 0; i < 31; i++) {
    days.push({
      dayKey: '2026-06-' + String(i + 1).padStart(2, '0'),
      startAt: '2026-05-31T16:00:00.000Z',
      endAt: '2026-06-30T16:00:00.000Z',
      dispatchCount: 1 + i,
      inputTokens: 100 + i * 100,
      outputTokens: 200 + i * 200,
      totalTokens: 300 + i * 300,
      source: 'sqlite',
    });
  }
  return days;
}

function buildWindows(mode) {
  var all = [
    {
      period: '24h',
      startAt: '2026-06-29T16:00:00.000Z',
      endAt: '2026-06-30T16:00:00.000Z',
      dispatchCount: 31,
      totalTokens: 93000,
      byProfile: [
        { profile: 'architect', runCount: 14, totalTokens: 1500000, averageTps: 41.5 },
        { profile: 'scribe', runCount: 10, totalTokens: 240000, averageTps: 12 },
        { profile: 'taskmaster', runCount: 7, totalTokens: 90000, averageTps: 9.25 },
      ],
      taskStats: {
        totalDurationMs: 8040000,
        byTask: [
          { taskId: 'refactor', source: 'builtin', runCount: 9, durationMs: 4440000 },
          { taskId: 'review', source: 'builtin', runCount: 8, durationMs: 2040000 },
          { taskId: 'docs', source: 'project', runCount: 6, durationMs: 900000 },
          { taskId: 'tests', source: 'builtin', runCount: 8, durationMs: 630000 },
          { taskId: 'legacy-run', source: 'unknown', runCount: 2, durationMs: 30000 },
        ],
        builtinTotalDurationMs: 7110000,
        byBuiltinTask: [
          { taskId: 'refactor', runCount: 9, durationMs: 4440000 },
          { taskId: 'review', runCount: 8, durationMs: 2040000 },
          { taskId: 'tests', runCount: 8, durationMs: 630000 },
        ],
      },
    },
    {
      period: '7d',
      startAt: '2026-06-23T16:00:00.000Z',
      endAt: '2026-06-30T16:00:00.000Z',
      dispatchCount: 120,
      totalTokens: 400000,
      byProfile: [
        { profile: 'architect', runCount: 50, totalTokens: 5000000, averageTps: 38.3 },
        { profile: 'scribe', runCount: 40, totalTokens: 2000000, averageTps: 10.05 },
        { profile: 'taskmaster', runCount: 30, totalTokens: 1000000, averageTps: 8 },
      ],
      taskStats: {
        totalDurationMs: 30000000,
        byTask: [
          { taskId: 'refactor', source: 'builtin', runCount: 30, durationMs: 20000000 },
          { taskId: 'review', source: 'project', runCount: 20, durationMs: 8000000 },
          { taskId: 'legacy-run', source: 'unknown', runCount: 5, durationMs: 50000 },
        ],
        builtinTotalDurationMs: 20000000,
        byBuiltinTask: [{ taskId: 'refactor', runCount: 30, durationMs: 20000000 }],
      },
    },
    {
      period: '1mo',
      startAt: '2026-05-31T16:00:00.000Z',
      endAt: '2026-06-30T16:00:00.000Z',
      dispatchCount: 450,
      totalTokens: 1500000,
      byProfile: [
        { profile: 'architect', runCount: 150, totalTokens: 15000000, averageTps: 35.2 },
        { profile: 'scribe', runCount: 130, totalTokens: 6000000, averageTps: 9.5 },
        { profile: 'taskmaster', runCount: 90, totalTokens: 3000000, averageTps: 7.75 },
        { profile: 'misc', runCount: 80, totalTokens: 500000 },
      ],
      taskStats: {
        totalDurationMs: 90000000,
        byTask: [
          { taskId: 'refactor', source: 'builtin', runCount: 100, durationMs: 60000000 },
          { taskId: 'review', source: 'project', runCount: 80, durationMs: 25000000 },
          { taskId: 'docs', source: 'project', runCount: 20, durationMs: 2000000 },
          { taskId: 'legacy-run', source: 'unknown', runCount: 10, durationMs: 300000 },
        ],
        builtinTotalDurationMs: 60000000,
        byBuiltinTask: [{ taskId: 'refactor', runCount: 100, durationMs: 60000000 }],
      },
    },
  ];

  if (mode === 'empty') {
    // Windows capability present but nothing measured yet
    return all.map(function (w) {
      return {
        period: w.period,
        startAt: w.startAt,
        endAt: w.endAt,
        dispatchCount: 0,
        totalTokens: 0,
        byProfile: [],
        taskStats: {
          totalDurationMs: 0,
          byTask: [],
          builtinTotalDurationMs: 0,
          byBuiltinTask: [],
        },
      };
    });
  }
  return all;
}

function buildSummary(mode) {
  var summary = {
    source: 'sqlite',
    daily: buildDailyBuckets(),
    today: {
      dayKey: '2026-06-30',
      startAt: '2026-06-29T16:00:00.000Z',
      endAt: '2026-06-30T16:00:00.000Z',
      dispatchCount: 31,
      inputTokens: 31000,
      outputTokens: 62000,
      totalTokens: 93000,
      source: 'sqlite',
      outcomes: { done: 25, failed: 4, cancelled: 2 },
    },
  };
  if (mode !== 'legacy') {
    summary.windows = buildWindows(mode);
  }
  return summary;
}

// ── Window / IPC fake (sender-bound stats boundary only) ──────────────

var currentWin = null;
var currentFixture = null;
var statsHandlerRegistered = false;

function destroyWindow() {
  if (currentWin && !currentWin.isDestroyed()) {
    try { currentWin.destroy(); } catch (_) {}
  }
  currentWin = null;
  var allWins = BrowserWindow.getAllWindows();
  for (var i = 0; i < allWins.length; i++) {
    var w = allWins[i];
    if (!w.isDestroyed()) { try { w.destroy(); } catch (_) {} }
  }
}

// Register exactly one sender-bound stats:load handler for the whole run.
// It reads the current case payload and validates the sender against the
// current stats window, so handler registrations (which throw when repeated)
// can never accumulate across the four capture cases.
function ensureStatsHandler() {
  if (statsHandlerRegistered) return;
  statsHandlerRegistered = true;
  ipcMain.handle('stats:load', function (event) {
    var sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender || sender !== currentWin || sender.isDestroyed()) {
      throw new Error('stats:load rejected: sender does not match the stats window');
    }
    if (!currentFixture) return null;
    var summary = JSON.parse(JSON.stringify(currentFixture));
    // Match the production PanelOwner/renderer envelope, not a bare summary
    return { summary: summary, dailyStats: summary.today };
  });
}

function createStatsWindow(fixture, width, height) {
  destroyWindow();
  currentFixture = fixture;
  var win = new BrowserWindow({
    width: width || STATS_WIDTH,
    height: height || STATS_HEIGHT,
    useContentSize: true,
    transparent: true,
    frame: false,
    thickFrame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(preloadDir, 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  // Production security posture: deny renderer-created child windows
  win.webContents.setWindowOpenHandler(function () { return { action: 'deny' }; });
  win.webContents.on('did-create-window', function (childWin) {
    fail('stats capture detected unexpected child window; destroying');
    if (!childWin.isDestroyed()) childWin.destroy();
  });
  ensureStatsHandler();
  win.loadFile(path.join(htmlDir, 'stats.html'));
  currentWin = win;
  return win;
}

// ── Utilities ──────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

var failures = [];
var manifestEntries = [];

function fail(message) {
  failures.push(message);
  console.error('[capture] FAIL:', message);
}

function hashImage(filePath) {
  if (!fs.existsSync(filePath)) return '';
  var buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex');
}

async function waitForText(win, expected, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || CASE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    var text = await win.webContents.executeJavaScript('document.body.innerText').catch(function () { return ''; });
    if (text.indexOf(expected) >= 0) return;
    await delay(POLL_MS);
  }
  throw new Error('Timeout waiting for text: "' + expected + '"');
}

async function js(win, body) {
  return win.webContents.executeJavaScript(body).catch(function () { return null; });
}

async function captureHidden(win, outFile) {
  var image = await win.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error('capturePage returned empty image');
  fs.writeFileSync(outFile, image.toPNG());
  return outFile;
}

// ── Semantic and layout assertions ─────────────────────────────────────

var EXPECTED_HEADERS = [
  '摘要',
  '运行统计',
  '任务统计',
];

async function assertSectionOrder(win) {
  var headers = await js(
    win,
    '(function() { return Array.prototype.map.call(document.querySelectorAll(".stats-header"), function (el) { return el.textContent; }); })()',
  );
  if (JSON.stringify(headers) !== JSON.stringify(EXPECTED_HEADERS)) {
    fail('Section header order mismatch: expected ' + JSON.stringify(EXPECTED_HEADERS) + ' got ' + JSON.stringify(headers));
  }
}

async function assertSummary(win, mode) {
  var s = await js(
    win,
    '(function() { var sec = document.querySelector("[data-section=\\"summary\\"]"); if (!sec) return null; return { hero: Array.prototype.map.call(sec.querySelectorAll(".stats-hero-value"), function (e) { return e.textContent; }), detail: sec.querySelector(".stats-detail-line") ? sec.querySelector(".stats-detail-line").textContent : null, strip: sec.querySelectorAll(".stats-strip-cell").length, totals: Array.prototype.map.call(sec.querySelectorAll(".stats-period-total"), function (e) { return e.textContent; }) }; })()',
  );
  if (!s) {
    fail('Summary section metrics unavailable');
    return;
  }
  if (s.hero.indexOf('31') < 0) fail('Summary hero missing dispatch count: ' + JSON.stringify(s.hero));
  if (s.hero.indexOf('93.0K') < 0) fail('Summary hero missing token total: ' + JSON.stringify(s.hero));
  if (!s.detail || s.detail.indexOf('完成率 86.21%') < 0) fail('Detail line missing completion rate: "' + s.detail + '"');
  var expectedTaskTime = mode === 'legacy' ? '任务时长 —' : mode === 'empty' ? '任务时长 <1m' : '任务时长 2h 14m';
  if (!s.detail || s.detail.indexOf(expectedTaskTime) < 0) {
    fail('Detail line missing task time ("' + expectedTaskTime + '"): "' + s.detail + '"');
  }
  if (s.strip !== 31) fail('Expected 31 strip cells, got ' + s.strip);
  if (s.totals.length !== 3) fail('Expected 3 period totals, got ' + s.totals.length);
  if (s.totals[0].indexOf('24h') < 0) fail('First period total is not 24h: "' + s.totals[0] + '"');
}

async function assertA11y(win) {
  var a = await js(
    win,
    '(function() { var tasksSec = document.querySelector("[data-section=\\"tasks\\"]"); var sw = tasksSec ? tasksSec.querySelector(".stats-switch") : null; return { tablists: document.querySelectorAll(".stats-tabs").length, tabs: Array.prototype.map.call(document.querySelectorAll(".stats-tab"), function (t) { return { role: t.getAttribute("role"), sel: t.getAttribute("aria-selected"), tabindex: t.tabIndex }; }), switchRole: sw ? sw.getAttribute("role") : null, switchChecked: sw ? sw.getAttribute("aria-checked") : null }; })()',
  );
  if (!a) {
    fail('A11y metrics unavailable');
    return;
  }
  if (a.tablists !== 2) fail('Expected 2 tablists, got ' + a.tablists);
  if (a.tabs.length !== 6) fail('Expected 6 tabs total, got ' + a.tabs.length);
  var badRole = a.tabs.filter(function (t) { return t.role !== 'tab'; });
  if (badRole.length > 0) fail('Non-tab role found: ' + JSON.stringify(badRole));
  var selected = a.tabs.filter(function (t) { return t.sel === 'true'; });
  if (selected.length !== 2) fail('Expected exactly 2 aria-selected tabs, got ' + selected.length);
  var roving = a.tabs.filter(function (t) { return t.tabindex === 0; });
  if (roving.length !== 2) fail('Expected 2 tabs at tabindex 0 (roving), got ' + roving.length);
  if (a.switchRole !== 'switch') fail('Builtin filter missing role=switch: ' + a.switchRole);
  if (a.switchChecked !== 'false') fail('Switch default aria-checked must be false, got ' + a.switchChecked);
}

async function readRows(win, section) {
  return js(
    win,
    '(function() { return Array.prototype.map.call(document.querySelectorAll("[data-section=\\"' + section + '\\"] .stats-data-row"), function (r) { return Array.prototype.map.call(r.children, function (c) { return c.textContent; }); }); })()',
  );
}

function assertRows(label, actual, expected) {
  if (!actual) {
    fail(label + ': rows unavailable');
    return;
  }
  if (actual.length !== expected.length) {
    fail(label + ': expected ' + expected.length + ' rows, got ' + actual.length + ' -> ' + JSON.stringify(actual));
    return;
  }
  for (var i = 0; i < expected.length; i++) {
    if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) {
      fail(label + ' row ' + i + ' mismatch: expected ' + JSON.stringify(expected[i]) + ' got ' + JSON.stringify(actual[i]));
    }
  }
}

async function clickProfileTab(win, period) {
  await js(
    win,
    '(function() { var t = document.querySelector("[data-section=\\"profiles\\"] .stats-tab[data-period=\\"' + period + '\\"]"); if (t) t.click(); })()',
  );
  await delay(50);
}

async function toggleSwitch(win) {
  await js(
    win,
    '(function() { var sw = document.querySelector("[data-section=\\"tasks\\"] .stats-switch"); if (sw) sw.click(); })()',
  );
  await delay(50);
}

async function refreshData(win, fixture) {
  win.webContents.send('stats:data', { summary: fixture, dailyStats: fixture.today });
  await delay(100);
}

async function assertProfiles(win, expected) {
  assertRows('Profiles', await readRows(win, 'profiles'), expected);
}

async function assertTasks(win, expected) {
  assertRows('Tasks', await readRows(win, 'tasks'), expected);
}

async function assertInteractivePreservation(win) {
  // Profiles: switch to 7d, then survive a data refresh with the selection
  await clickProfileTab(win, '7d');
  await assertProfiles(win, [
    ['architect', '50', '5.0M tok', '38.30'],
    ['scribe', '40', '2.0M tok', '10.05'],
    ['taskmaster', '30', '1.0M tok', '8.00'],
  ]);
  await refreshData(win, buildSummary('normal'));
  var selected7d = await js(
    win,
    '(function() { var tab = document.querySelector("[data-section=\\"profiles\\"] .stats-tab[data-period=\\"7d\\"]"); return tab ? tab.getAttribute("aria-selected") : null; })()',
  );
  if (selected7d !== 'true') fail('Profile 7d selection lost after data refresh: ' + selected7d);

  // Tasks: enable builtin filter, then survive a data refresh
  await toggleSwitch(win);
  await assertTasks(win, [
    ['refactor', '9', '8m', '62%'],
    ['review', '8', '4m', '29%'],
    ['tests', '8', '1m', '9%'],
  ]);
  await refreshData(win, buildSummary('normal'));
  var switchChecked = await js(
    win,
    '(function() { var sw = document.querySelector("[data-section=\\"tasks\\"] .stats-switch"); return sw ? sw.getAttribute("aria-checked") : null; })()',
  );
  if (switchChecked !== 'true') fail('Builtin switch state lost after data refresh: ' + switchChecked);
  await assertTasks(win, [
    ['refactor', '9', '8m', '62%'],
    ['review', '8', '4m', '29%'],
    ['tests', '8', '1m', '9%'],
  ]);
}

async function assertSemanticAndLayout(win, opts) {
  await assertSectionOrder(win);
  await assertSummary(win, opts.mode);
  await assertA11y(win);

  if (opts.mode === 'normal') {
    await assertProfiles(win, [
      ['architect', '14', '1.5M tok', '41.50'],
      ['scribe', '10', '240.0K tok', '12.00'],
      ['taskmaster', '7', '90.0K tok', '9.25'],
    ]);
    await assertTasks(win, [
      ['refactor', '9', '8m', '55%'],
      ['review', '8', '4m', '25%'],
      ['docs', '6', '2m', '11%'],
      ['tests', '8', '1m', '8%'],
      ['legacy-run', '2', '<1m', '<1%'],
    ]);
    await assertInteractivePreservation(win);
  } else if (opts.mode === 'legacy') {
    var legacyProfile = await js(win, '(function() { var n = document.querySelector("[data-section=\\"profiles\\"] .stats-tab-empty"); return n ? n.textContent : null; })()');
    if (legacyProfile !== '需要新版 Foreman 才能显示运行统计') fail('Legacy profiles message mismatch: "' + legacyProfile + '"');
    var legacyTasks = await js(win, '(function() { var n = document.querySelector("[data-section=\\"tasks\\"] .stats-tab-empty"); return n ? n.textContent : null; })()');
    if (legacyTasks !== '需要新版 Foreman 才能显示任务统计') fail('Legacy tasks message mismatch: "' + legacyTasks + '"');
    var legacyRows = await readRows(win, 'profiles');
    if (legacyRows && legacyRows.length !== 0) fail('Legacy case rendered profile rows: ' + legacyRows.length);
  } else if (opts.mode === 'empty') {
    var emptyProfile = await js(win, '(function() { var n = document.querySelector("[data-section=\\"profiles\\"] .stats-tab-empty"); return n ? n.textContent : null; })()');
    if (emptyProfile !== '该周期暂无运行数据') fail('Empty profiles message mismatch: "' + emptyProfile + '"');
    var emptyTasks = await js(win, '(function() { var n = document.querySelector("[data-section=\\"tasks\\"] .stats-tab-empty"); return n ? n.textContent : null; })()');
    if (emptyTasks !== '该周期暂无任务数据') fail('Empty tasks message mismatch: "' + emptyTasks + '"');
  }

  // No removed legacy sections may leak through
  var bodyText = await js(win, 'document.body.innerText');
  if (!bodyText) fail('Body text unavailable');
  else {
    if (bodyText.indexOf('MILESTONES') >= 0) fail('Removed MILESTONES section still present');
    if (bodyText.indexOf('TOKEN LEDGER') >= 0) fail('Removed TOKEN LEDGER section still present');
    if (bodyText.indexOf('TOP TASKS') >= 0) fail('Removed TOP TASKS section still present');
    if (bodyText.indexOf('TASK TIME') >= 0) fail('Removed TASK TIME section still present');
    if (bodyText.indexOf('Workshop Ledger') >= 0) fail('English legacy title still present');
  }

  // Vertical scroll only: content scrolls vertically, never horizontally
  var layout = await js(
    win,
    '(function() { var c = document.querySelector(".content"); var st = getComputedStyle(c); return { sh: c.scrollHeight, ch: c.clientHeight, cs: c.scrollWidth, cc: c.clientWidth, ds: document.documentElement.scrollWidth, dc: document.documentElement.clientWidth, overflowY: st.overflowY }; })()',
  );
  if (!layout) {
    fail('Layout metrics unavailable');
  } else {
    if (layout.overflowY !== 'auto' && layout.overflowY !== 'scroll') {
      fail('Content is not vertically scrollable (overflowY=' + layout.overflowY + ')');
    }
    if (layout.sh < layout.ch) fail('Vertical content clipped (scrollHeight ' + layout.sh + ' < clientHeight ' + layout.ch + ')');
    if (layout.cs > layout.cc) fail('Horizontal overflow in content (' + layout.cs + ' > ' + layout.cc + ')');
    if (layout.ds > layout.dc) fail('Horizontal overflow in document (' + layout.ds + ' > ' + layout.dc + ')');
  }

  // No child windows beyond the single stats window
  var winCount = BrowserWindow.getAllWindows().filter(function (w) { return !w.isDestroyed(); }).length;
  if (winCount !== 1) fail('Expected exactly 1 window (no child windows), got ' + winCount);
}

// ── Capture cases ──────────────────────────────────────────────────────

var capturedHashes = {};

async function captureCase(caseId, label, fn) {
  destroyWindow();
  await delay(200);
  var outFile = path.join(captureBase, caseId + '.png');
  console.log('[capture] ' + caseId + ' (' + label + ')');
  var failuresBefore = failures.length;
  try {
    await fn(outFile);
    if (failures.length > failuresBefore) {
      return;
    }
    var h = hashImage(outFile);
    var imgBuf = fs.readFileSync(outFile);
    var sha256 = crypto.createHash('sha256').update(imgBuf).digest('hex');
    var pngW = 0, pngH = 0;
    if (imgBuf.length >= 24 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50) {
      pngW = imgBuf.readUInt32BE(16);
      pngH = imgBuf.readUInt32BE(20);
    }
    manifestEntries.push({
      id: caseId,
      file: caseId + '.png',
      sha256: sha256,
      md5: h,
      width: pngW,
      height: pngH,
    });
    if (capturedHashes[h] && capturedHashes[h] !== caseId) {
      throw new Error(caseId + ': screenshot identical to ' + capturedHashes[h] + ' (possible false-green)');
    }
    capturedHashes[h] = caseId;
    console.log('[capture] OK ' + caseId);
  } catch (e) {
    fail(caseId + ': ' + (e ? e.message || String(e) : 'unknown error'));
  }
}

async function captureSummaryNormal(outFile) {
  var win = createStatsWindow(buildSummary('normal'), STATS_WIDTH, STATS_HEIGHT);
  await waitForText(win, '完成率 86.21%');
  await waitForText(win, '任务统计');
  await assertSemanticAndLayout(win, { mode: 'normal' });
  await captureHidden(win, outFile);
}

async function captureLegacyNoWindows(outFile) {
  var win = createStatsWindow(buildSummary('legacy'), STATS_WIDTH, STATS_HEIGHT);
  await waitForText(win, '需要新版 Foreman 才能显示运行统计');
  await waitForText(win, '需要新版 Foreman 才能显示任务统计');
  await assertSemanticAndLayout(win, { mode: 'legacy' });
  await captureHidden(win, outFile);
}

async function captureEmptyWindows(outFile) {
  var win = createStatsWindow(buildSummary('empty'), STATS_WIDTH, STATS_HEIGHT);
  await waitForText(win, '该周期暂无运行数据');
  await waitForText(win, '该周期暂无任务数据');
  await assertSemanticAndLayout(win, { mode: 'empty' });
  await captureHidden(win, outFile);
}

async function captureSummaryNarrow(outFile) {
  var win = createStatsWindow(buildSummary('normal'), STATS_MIN_WIDTH, STATS_MIN_HEIGHT);
  await waitForText(win, '完成率 86.21%');
  await waitForText(win, '任务统计');
  await assertSemanticAndLayout(win, { mode: 'normal' });
  await captureHidden(win, outFile);
}

// ── Declared artifacts ─────────────────────────────────────────────────

var DECLARED_FILES = [
  'stats-summary-normal.png',
  'stats-legacy-no-windows.png',
  'stats-empty-windows.png',
  'stats-summary-narrow.png',
];
var MANIFEST_FILE = 'stats-e2e-manifest.json';

var CASES = [
  { id: 'stats-summary-normal',     label: 'normal three-window', fn: captureSummaryNormal },
  { id: 'stats-legacy-no-windows',  label: 'legacy no windows',   fn: captureLegacyNoWindows },
  { id: 'stats-empty-windows',      label: 'empty windows',       fn: captureEmptyWindows },
  { id: 'stats-summary-narrow',     label: 'normal at 400x480',   fn: captureSummaryNarrow },
];

// ── Run ────────────────────────────────────────────────────────────────

async function run() {
  for (var i = 0; i < DECLARED_FILES.length; i++) {
    try { fs.unlinkSync(path.join(captureBase, DECLARED_FILES[i])); } catch (_) {}
  }
  try { fs.unlinkSync(path.join(captureBase, MANIFEST_FILE)); } catch (_) {}

  // Every case runs even after earlier failures — full diagnostics
  for (var j = 0; j < CASES.length; j++) {
    var c = CASES[j];
    await captureCase(c.id, c.label, c.fn);
  }

  destroyWindow();

  console.log('');
  if (failures.length === 0) {
    var manifestPath = path.join(captureBase, MANIFEST_FILE);
    fs.writeFileSync(manifestPath, JSON.stringify(manifestEntries, null, 2) + '\n');
    console.log('[capture] all ' + CASES.length + ' stats E2E captures passed');
    console.log('Manifest: ' + manifestPath);
    console.log('Artifacts in: ' + captureBase);
  } else {
    console.log('[capture] ' + failures.length + ' failure(s):');
    for (var k = 0; k < failures.length; k++) {
      console.log('  FAIL: ' + failures[k]);
    }
    console.log('Partial artifacts in: ' + captureBase);
  }
}

app.whenReady().then(function () {
  run()
    .then(function () {
      if (failures.length > 0) app.exit(1);
      else app.quit();
    })
    .catch(function (error) {
      console.error('[capture] harness error:', error ? (error.message || error) : 'unknown');
      app.exit(1);
    });
});

app.on('window-all-closed', function () {
  // No-op: the run() promise owns app termination
});
