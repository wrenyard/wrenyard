import { describe, expect, it } from 'vitest';
import fs from 'fs';

describe('Stats E2E capture harness contract', () => {
  const capture = fs.readFileSync(
    new URL('../scripts/stats-e2e-capture.mjs', import.meta.url),
    'utf-8',
  );

  it('loads the built production stats.html with the production preload and security options', () => {
    expect(capture).toContain("path.join(htmlDir, 'stats.html')");
    expect(capture).toContain("path.join(preloadDir, 'preload.js')");
    expect(capture).toContain('contextIsolation: true');
    expect(capture).toContain('nodeIntegration: false');
    expect(capture).toContain('sandbox: true');
  });

  it('fakes only the sender-bound stats IPC boundary', () => {
    expect(capture).toContain("ipcMain.handle('stats:load'");
    expect(capture).toContain('sender !== currentWin');
    expect(capture).toContain('stats:load rejected');
  });

  it('returns the production { summary, dailyStats } envelope, not a bare summary', () => {
    expect(capture).toContain('summary: summary');
    expect(capture).toContain('dailyStats: summary.today');
    expect(capture).not.toContain('return currentFixture');
  });

  it('registers the stats:load handler once for the whole run instead of per window', () => {
    expect(capture).toContain('statsHandlerRegistered');
    expect(capture).toMatch(/if \(statsHandlerRegistered\) return;/);
    expect(capture).toMatch(/statsHandlerRegistered\s*=\s*true/);
    expect((capture.match(/ipcMain\.handle\('stats:load'/g) || []).length).toBe(1);
  });

  it('always captures hidden pages via capturePage(undefined, { stayHidden: true })', () => {
    expect(capture).toContain('capturePage(undefined, { stayHidden: true })');
    expect(capture).not.toContain('captureInteractiveWindow');
  });

  it('denies renderer-created child windows', () => {
    expect(capture).toContain("setWindowOpenHandler(function () { return { action: 'deny' }; })");
    expect(capture).toContain('did-create-window');
  });

  it('declares all four size/state cases including the 400x480 narrow resize', () => {
    expect(capture).toContain("'stats-summary-normal'");
    expect(capture).toContain("'stats-legacy-no-windows'");
    expect(capture).toContain("'stats-empty-windows'");
    expect(capture).toContain("'stats-summary-narrow'");
    // normal/legacy/empty use the default 440x640; narrow uses the 400x480 minimums
    expect(capture).toContain('STATS_WIDTH, STATS_HEIGHT');
    expect(capture).toContain('STATS_MIN_WIDTH, STATS_MIN_HEIGHT');
  });

  it('accumulates per-case failures and continues every declared case before reporting', () => {
    expect(capture).toContain('failures.push(message)');
    expect(capture).toContain('var failuresBefore = failures.length');
    expect(capture).toContain('failures.length > failuresBefore');
    expect(capture).toContain('for (var j = 0; j < CASES.length; j++)');
    expect(capture).toContain('if (failures.length > 0) app.exit(1)');
    expect(capture).toContain('failure(s):');
  });

  it('writes PNGs plus a JSON manifest under artifacts/stats-e2e', () => {
    expect(capture).toContain("path.join(rootDir, 'artifacts', 'stats-e2e')");
    expect(capture).toContain("'stats-e2e-manifest.json'");
    expect(capture).toContain('sha256: sha256');
    expect(capture).toContain('md5: h');
    expect(capture).toContain('width: pngW');
    expect(capture).toContain('height: pngH');
  });

  it('hard-asserts the exact Chinese section order 摘要/运行统计/任务统计', () => {
    expect(capture).toContain('Section header order mismatch');
    expect(capture).toContain('document.querySelectorAll(".stats-header")');
    expect(capture).toContain("'摘要'");
    expect(capture).toContain("'运行统计'");
    expect(capture).toContain("'任务统计'");
  });

  it('asserts the summary section: hero, two-decimal completion rate, task time, strip and period totals', () => {
    expect(capture).toContain('完成率 86.21%');
    expect(capture).toContain('任务时长 2h 14m');
    expect(capture).toContain('Expected 31 strip cells');
    expect(capture).toContain('Expected 3 period totals');
    expect(capture).toContain('First period total is not 24h');
  });

  it('asserts accessible tablist/tab with aria-selected, roving tabindex and switch semantics', () => {
    expect(capture).toContain('Expected 2 tablists');
    expect(capture).toContain('t.getAttribute("role")');
    expect(capture).toContain('t.getAttribute("aria-selected")');
    expect(capture).toContain('Expected exactly 2 aria-selected tabs');
    expect(capture).toContain('Expected 2 tabs at tabindex 0 (roving)');
    expect(capture).toContain('sw.getAttribute("role")');
    expect(capture).toContain('sw.getAttribute("aria-checked")');
    expect(capture).toContain('Switch default aria-checked must be false');
  });

  it('asserts window-backed profile rows with two-decimal TPS and period tab switching', () => {
    expect(capture).toContain('assertRows(\'Profiles\'');
    expect(capture).toContain("'41.50'");
    expect(capture).toContain("'38.30'");
    expect(capture).toContain("t.click()");
  });

  it('asserts task rows, the builtin switch, and refresh-preserved control state', () => {
    expect(capture).toContain('assertRows(\'Tasks\'');
    expect(capture).toContain("'legacy-run'");
    expect(capture).toContain('Profile 7d selection lost after data refresh');
    expect(capture).toContain('Builtin switch state lost after data refresh');
    expect(capture).toContain('webContents.send(\'stats:data\'');
  });

  it('normal fixture task stats sum exactly to their declared denominators', () => {
    // 24h byTask durations sum to totalDurationMs 8040000
    const allTasks = capture.match(/byTask: \[([\s\S]*?)\]/);
    expect(allTasks).toBeTruthy();
    const durations = Array.from(allTasks?.[1]?.matchAll(/durationMs: (\d+)/g) ?? [], (m) => Number(m[1]));
    expect(durations).toHaveLength(5);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(8040000);
    // 24h byBuiltinTask durations sum to builtinTotalDurationMs 7110000
    const builtinTasks = capture.match(/byBuiltinTask: \[([\s\S]*?)\]/);
    expect(builtinTasks).toBeTruthy();
    const bDurations = Array.from(builtinTasks?.[1]?.matchAll(/durationMs: (\d+)/g) ?? [], (m) => Number(m[1]));
    expect(bDurations).toHaveLength(3);
    expect(bDurations.reduce((a, b) => a + b, 0)).toBe(7110000);
    expect(capture).toContain('totalDurationMs: 8040000');
    expect(capture).toContain('builtinTotalDurationMs: 7110000');
  });

  it('fixtures include an unknown-source task row and legacy/empty window modes', () => {
    expect(capture).toContain("{ taskId: 'legacy-run', source: 'unknown', runCount: 2, durationMs: 30000 }");
    expect(capture).toContain('需要新版 Foreman 才能显示运行统计');
    expect(capture).toContain('需要新版 Foreman 才能显示任务统计');
    expect(capture).toContain('该周期暂无运行数据');
    expect(capture).toContain('该周期暂无任务数据');
  });

  it('asserts vertical-scroll-only layout with zero horizontal overflow', () => {
    expect(capture).toContain('c.scrollHeight');
    expect(capture).toContain('c.scrollWidth');
    expect(capture).toContain('Content is not vertically scrollable');
    expect(capture).toContain('Vertical content clipped');
    expect(capture).toContain('Horizontal overflow in content');
    expect(capture).toContain('Horizontal overflow in document');
  });

  it('asserts the removed MILESTONES/TOKEN LEDGER/TOP TASKS/TASK TIME sections never leak', () => {
    expect(capture).toContain('Removed MILESTONES section still present');
    expect(capture).toContain('Removed TOKEN LEDGER section still present');
    expect(capture).toContain('Removed TOP TASKS section still present');
    expect(capture).toContain('Removed TASK TIME section still present');
    expect(capture).toContain('English legacy title still present');
  });
});

describe('stats:capture npm script contract', () => {
  it('builds production assets and runs the deterministic Stats capture harness', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(pkg.scripts['stats:capture']).toContain('npm run build');
    expect(pkg.scripts['stats:capture']).toContain('electron');
    expect(pkg.scripts['stats:capture']).toContain('--force-device-scale-factor=1');
    expect(pkg.scripts['stats:capture']).toContain('scripts/stats-e2e-capture.mjs');
  });
});
