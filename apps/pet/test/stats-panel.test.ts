import { describe, expect, it } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { formatCount, formatDuration, buildLedgerViewModel, PERIODS } from '../src/panels/stats/index';

describe('formatCount', () => {
  it('returns "0" for zero', () => {
    expect(formatCount(0)).toBe('0');
  });

  it('returns plain number below 1k', () => {
    expect(formatCount(999)).toBe('999');
  });

  it('formats thousands', () => {
    expect(formatCount(1500)).toBe('1.5K');
    expect(formatCount(1000)).toBe('1.0K');
    expect(formatCount(999_999)).toBe('999.9K');
  });

  it('formats millions', () => {
    expect(formatCount(1_000_000)).toBe('1.0M');
    expect(formatCount(50_000_000)).toBe('50.0M');
  });

  it('handles non-finite values', () => {
    expect(formatCount(Infinity)).toBe('0');
    expect(formatCount(NaN)).toBe('0');
  });

  it('handles negative values as zero', () => {
    expect(formatCount(-5)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('shows <1m for sub-minute durations', () => {
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(59_999)).toBe('<1m');
  });

  it('formats minute-only durations', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(42 * 60_000)).toBe('42m');
  });

  it('formats hour and minute durations', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h');
    expect(formatDuration(74 * 60_000)).toBe('1h 14m');
  });

  it('keeps day-scale totals in hours-only units (never days)', () => {
    expect(formatDuration(91_800_000)).toBe('25h 30m');
  });

  it('handles non-finite and negative values as zero minutes', () => {
    expect(formatDuration(NaN)).toBe('0m');
    expect(formatDuration(Infinity)).toBe('0m');
    expect(formatDuration(-1)).toBe('0m');
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

const todayEntry = {
  dayKey: '2026-07-10',
  startAt: '2026-07-09T16:00:00.000Z',
  endAt: '2026-07-10T16:00:00.000Z',
  dispatchCount: 12,
  inputTokens: 1234,
  outputTokens: 5678,
  totalTokens: 6912,
  source: 'sqlite',
  outcomes: { done: 10, failed: 2, cancelled: 1 },
};

function buildWindows() {
  return [
    {
      period: '24h',
      startAt: '2026-07-09T16:00:00.000Z',
      endAt: '2026-07-10T16:00:00.000Z',
      dispatchCount: 12,
      totalTokens: 6912,
      byProfile: [
        { profile: 'coder', runCount: 8, totalTokens: 5000, averageTps: 41.5 },
        { profile: 'writer', runCount: 4, totalTokens: 1912 },
      ],
      taskStats: {
        totalDurationMs: 10_000_000,
        byTask: [
          { taskId: 'refactor', source: 'builtin', runCount: 5, durationMs: 5_000_000 },
          { taskId: 'review', source: 'project', runCount: 2, durationMs: 2_000_000 },
          { taskId: 'legacy-run', source: 'unknown', runCount: 1, durationMs: 5_000 },
        ],
        builtinTotalDurationMs: 5_000_000,
        byBuiltinTask: [{ taskId: 'refactor', runCount: 5, durationMs: 5_000_000 }],
      },
    },
    {
      period: '7d',
      startAt: '2026-07-03T16:00:00.000Z',
      endAt: '2026-07-10T16:00:00.000Z',
      dispatchCount: 100,
      totalTokens: 60000,
      byProfile: [
        { profile: 'coder', runCount: 60, totalTokens: 40000, averageTps: 40.5 },
        { profile: 'writer', runCount: 40, totalTokens: 20000, averageTps: 11.75 },
      ],
      taskStats: {
        totalDurationMs: 50_000_000,
        byTask: [{ taskId: 'refactor', source: 'builtin', runCount: 30, durationMs: 40_000_000 }],
        builtinTotalDurationMs: 40_000_000,
        byBuiltinTask: [{ taskId: 'refactor', runCount: 30, durationMs: 40_000_000 }],
      },
    },
    {
      period: '1mo',
      startAt: '2026-06-10T16:00:00.000Z',
      endAt: '2026-07-10T16:00:00.000Z',
      dispatchCount: 400,
      totalTokens: 300000,
      byProfile: [],
      taskStats: {
        totalDurationMs: 0,
        byTask: [],
        builtinTotalDurationMs: 0,
        byBuiltinTask: [],
      },
    },
  ];
}

function basePayload(): any {
  return {
    summary: {
      daily: [{ ...todayEntry }],
      today: { ...todayEntry },
      windows: buildWindows(),
    },
  };
}

describe('buildLedgerViewModel', () => {
  it('returns null for null data', () => {
    expect(buildLedgerViewModel(null)).toBeNull();
  });

  it('returns null when neither dailyStats nor summary.daily exists', () => {
    expect(buildLedgerViewModel({} as any)).toBeNull();
  });

  it('computes today hero and a two-decimal completion rate excluding cancelled', () => {
    const vm = buildLedgerViewModel(basePayload());
    expect(vm).not.toBeNull();
    expect(vm!.hasToday).toBe(true);
    expect(vm!.today!.dispatchCount).toBe(12);
    expect(vm!.today!.totalTokens).toBe(6912);
    // done/(done+failed) = 10/12 = 83.33%, cancelled excluded
    expect(vm!.today!.doneRate).toBe('83.33%');
    // total task time from the 24h window taskStats
    expect(vm!.today!.totalTaskTime).toBe('2h 46m');
  });

  it('shows a dash for completion rate when there are no done/failed outcomes', () => {
    const payload = basePayload();
    payload.summary.today = { ...todayEntry, outcomes: { done: 0, failed: 0, cancelled: 5 } };
    const vm = buildLedgerViewModel(payload);
    expect(vm!.today!.doneRate).toBe('—');
  });

  it('uses the dailyStats fallback entry when summary.today is absent', () => {
    const payload = {
      summary: { daily: [{ ...todayEntry }], windows: buildWindows() },
    };
    const vm = buildLedgerViewModel(payload as any);
    expect(vm!.today!.dispatchCount).toBe(12);
  });

  it('period totals row holds 24h/7d/1mo dispatch and formatted token values', () => {
    const vm = buildLedgerViewModel(basePayload());
    expect(vm!.periodTotals.map((t) => t.label)).toEqual(['24h', '7d', '1mo']);
    expect(vm!.periodTotals[0]).toEqual({ label: '24h', dispatchCount: 12, totalTokens: '6.9K' });
    // single-day history: 7d/1mo totals collapse to the same day
    expect(vm!.periodTotals[1]).toEqual({ label: '7d', dispatchCount: 12, totalTokens: '6.9K' });
    expect(vm!.periodTotals[2]).toEqual({ label: '1mo', dispatchCount: 12, totalTokens: '6.9K' });
  });

  it('31-day strip is ordered oldest to newest with four intensity levels', () => {
    const daily = [
      { dayKey: '2026-07-10', startAt: '', endAt: '', dispatchCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, source: 'sqlite' },
      { dayKey: '2026-07-09', startAt: '', endAt: '', dispatchCount: 10, inputTokens: 100, outputTokens: 200, totalTokens: 300, source: 'sqlite' },
      { dayKey: '2026-07-08', startAt: '', endAt: '', dispatchCount: 50, inputTokens: 100, outputTokens: 200, totalTokens: 300, source: 'sqlite' },
      { dayKey: '2026-07-07', startAt: '', endAt: '', dispatchCount: 200, inputTokens: 100, outputTokens: 200, totalTokens: 300, source: 'sqlite' },
    ];
    const vm = buildLedgerViewModel({ summary: { daily, today: daily[0] } } as any);
    expect(vm!.strip[0].dayKey).toBe('2026-07-07');
    expect(vm!.strip[3].dayKey).toBe('2026-07-10');
    expect(vm!.strip[0].level).toBe(3);
    expect(vm!.strip[1].level).toBe(2);
    expect(vm!.strip[2].level).toBe(1);
    expect(vm!.strip[3].level).toBe(0);
  });
});

describe('buildLedgerViewModel — profiles (window byProfile, period tabs)', () => {
  it('defaults to the 24h window with resolved profile names, runs, TOKEN, and two-decimal TPS', () => {
    const vm = buildLedgerViewModel(basePayload());
    expect(vm!.windowsAvailable).toBe(true);
    expect(vm!.profiles.period).toBe('24h');
    expect(vm!.profiles.rows).toEqual([
      { name: 'coder', runs: 8, tokens: '5.0K', tps: '41.50' },
      { name: 'writer', runs: 4, tokens: '1.9K', tps: '—' },
    ]);
  });

  it('switches to the 7d window rows when profilePeriod is 7d', () => {
    const vm = buildLedgerViewModel(basePayload(), { profilePeriod: '7d' });
    expect(vm!.profiles.period).toBe('7d');
    expect(vm!.profiles.rows.map((r) => r.name)).toEqual(['coder', 'writer']);
    expect(vm!.profiles.rows[0].tps).toBe('40.50');
    expect(vm!.profiles.rows[1].tps).toBe('11.75');
  });

  it('yields empty rows for a window with no profiles', () => {
    const vm = buildLedgerViewModel(basePayload(), { profilePeriod: '1mo' });
    expect(vm!.profiles.period).toBe('1mo');
    expect(vm!.profiles.rows).toEqual([]);
  });

  it('never resolves profile names outside the active window byProfile', () => {
    const payload = basePayload();
    payload.summary.windows[0].byProfile = [];
    const vm = buildLedgerViewModel(payload);
    expect(vm!.profiles.rows).toEqual([]);
  });
});

describe('buildLedgerViewModel — tasks (window taskStats, builtin filter)', () => {
  it('defaults to all-source task rows against the total duration denominator', () => {
    const vm = buildLedgerViewModel(basePayload());
    expect(vm!.tasks.period).toBe('24h');
    expect(vm!.tasks.builtinOnly).toBe(false);
    expect(vm!.tasks.rows).toEqual([
      { taskId: 'refactor', runs: 5, avgDuration: '16m', share: '50%' },
      { taskId: 'review', runs: 2, avgDuration: '16m', share: '20%' },
      // unknown legacy rows are visible in the all-tasks view
      { taskId: 'legacy-run', runs: 1, avgDuration: '<1m', share: '<1%' },
    ]);
  });

  it('builtin switch selects server byBuiltinTask rows and the builtin duration denominator', () => {
    const vm = buildLedgerViewModel(basePayload(), { builtinOnly: true });
    expect(vm!.tasks.builtinOnly).toBe(true);
    expect(vm!.tasks.rows).toEqual([
      // 5_000_000 / 5_000_000 = 100%
      { taskId: 'refactor', runs: 5, avgDuration: '16m', share: '100%' },
    ]);
  });

  it('never infers the builtin filter from task ids or sources', () => {
    const payload = basePayload();
    // byTask contains a project row the client could wrongly filter on
    payload.summary.windows[0].taskStats.byTask = [
      { taskId: 'refactor', source: 'builtin', runCount: 5, durationMs: 5_000_000 },
      { taskId: 'review', source: 'project', runCount: 2, durationMs: 2_000_000 },
    ];
    payload.summary.windows[0].taskStats.byBuiltinTask = [];
    payload.summary.windows[0].taskStats.builtinTotalDurationMs = 0;
    const vm = buildLedgerViewModel(payload, { builtinOnly: true });
    expect(vm!.tasks.rows).toEqual([]);
  });

  it('switches task period rows independently of the profile period', () => {
    const vm = buildLedgerViewModel(basePayload(), { taskPeriod: '7d', profilePeriod: '24h' });
    expect(vm!.tasks.period).toBe('7d');
    expect(vm!.profiles.period).toBe('24h');
    expect(vm!.tasks.rows).toEqual([
      // 40_000_000 / 50_000_000 = 80%
      { taskId: 'refactor', runs: 30, avgDuration: '22m', share: '80%' },
    ]);
  });
});

describe('buildLedgerViewModel — legacy windows absence', () => {
  it('preserves today/daily/strip and shows empty tables with an honest newer-Foreman signal', () => {
    const payload = {
      summary: { daily: [{ ...todayEntry }], today: { ...todayEntry } },
    };
    const vm = buildLedgerViewModel(payload as any);
    expect(vm!.windowsAvailable).toBe(false);
    expect(vm!.today!.dispatchCount).toBe(12);
    expect(vm!.today!.doneRate).toBe('83.33%');
    expect(vm!.today!.totalTaskTime).toBe('—');
    expect(vm!.strip).toHaveLength(1);
    expect(vm!.periodTotals).toHaveLength(3);
    expect(vm!.profiles.rows).toEqual([]);
    expect(vm!.tasks.rows).toEqual([]);
    expect(vm!.isOldDaemon).toBe(false);
  });

  it('dailyStats-only fallback is an old daemon', () => {
    const vm = buildLedgerViewModel({ dailyStats: { ...todayEntry } } as any);
    expect(vm!.isOldDaemon).toBe(true);
    expect(vm!.windowsAvailable).toBe(false);
    expect(vm!.today!.dispatchCount).toBe(12);
  });
});

describe('StatsPanel — source contract (Chinese sections, tabs, switch, no removed sections)', () => {
  const tsPath = fileURLToPath(new URL('../src/panels/stats/index.ts', import.meta.url));
  const cssPath = fileURLToPath(new URL('../src/panels/panel.css', import.meta.url));
  const htmlPath = fileURLToPath(new URL('../src/panels/stats/index.html', import.meta.url));
  const src = fs.readFileSync(tsPath, 'utf-8');
  const css = fs.readFileSync(cssPath, 'utf-8');
  const html = fs.readFileSync(htmlPath, 'utf-8');

  it('renders sections in exact order 摘要, 运行统计, 任务统计', () => {
    const summary = src.indexOf("textContent = '摘要'");
    const profiles = src.indexOf("textContent = '运行统计'");
    const tasks = src.indexOf("textContent = '任务统计'");
    expect(summary).toBeGreaterThan(-1);
    expect(profiles).toBeGreaterThan(summary);
    expect(tasks).toBeGreaterThan(profiles);
  });

  it('removes MILESTONES, TOKEN LEDGER, TOP TASKS and TASK TIME sections', () => {
    expect(src).not.toContain('MILESTONES');
    expect(src).not.toContain('TOKEN LEDGER');
    expect(src).not.toContain('TOP TASKS');
    expect(src).not.toContain('TASK TIME');
    expect(src).not.toContain('tokenMilestoneCount');
  });

  it('uses Chinese section headings and keeps technical labels TOKEN, TPS, Task ID, periods', () => {
    expect(src).toContain("'TOKEN'");
    expect(src).toContain("'TPS'");
    expect(src).toContain("'Task ID'");
    for (const p of PERIODS) expect(src).toContain(`'${p}'`);
    expect(src).toContain("'调度次数'");
    expect(src).toContain("'总 TOKEN'");
  });

  it('computes completion rate as done/(done+failed) with exactly two decimals', () => {
    expect(src).toMatch(/doneRate = totalOutcome > 0 \? `\$\{\(\(outcomes\.done \/ totalOutcome\) \* 100\)\.toFixed\(2\)\}%` : '—'/);
  });

  it('formats average TPS to exactly two decimals or a dash', () => {
    expect(src).toContain('p.averageTps.toFixed(2)');
    expect(src).toContain(": '—'");
  });

  it('renders accessible tablist/tab with aria-selected and roving tabindex, plus arrow-key navigation', () => {
    expect(src).toContain("setAttribute('role', 'tablist')");
    expect(src).toContain("setAttribute('role', 'tab')");
    expect(src).toContain("setAttribute('aria-selected'");
    expect(src).toContain("tab.tabIndex = selected ? 0 : -1");
    expect(src).toContain("event.key === 'ArrowRight'");
    expect(src).toContain("event.key === 'ArrowLeft'");
    expect(src).toContain("event.key === 'Home'");
    expect(src).toContain("event.key === 'End'");
  });

  it('renders the builtin filter as a switch with aria-checked', () => {
    expect(src).toContain("setAttribute('role', 'switch')");
    expect(src).toContain("setAttribute('aria-checked'");
  });

  it('never uses a native title attribute or non-empty innerHTML for content', () => {
    expect(src).not.toMatch(/\.title\s*=/);
    const innerHTMLAssignLines = src.split('\n').filter((l) => l.includes('.innerHTML ='));
    const nonEmptyInnerHTML = innerHTMLAssignLines.filter((l) => !l.includes("''") && !l.includes('""'));
    expect(nonEmptyInnerHTML).toHaveLength(0);
  });

  it('keeps the strip tooltip contract: aria-label cells, focus/blur and pointer handlers', () => {
    expect(src).toContain("setAttribute('aria-label'");
    expect(src).toContain('tabIndex = 0');
    expect(src).toContain('pointerenter');
    expect(src).toContain('pointerleave');
    expect(src).toContain(".addEventListener('focus'");
    expect(src).toContain(".addEventListener('blur'");
    expect(src).toContain('formatCount(cell.totalTokens)');
    expect(src).toContain('showTooltipForCell(cell,');
  });

  it('calls hideTooltip before null-data and null-view-model early returns', () => {
    const fnStart = src.indexOf('export function renderStats(');
    const bodyStart = src.indexOf('{', fnStart);
    const body = src.slice(bodyStart);
    const hidePos = body.indexOf('hideTooltip()');
    const nullDataReturn = body.indexOf('if (!el || !data)');
    const nullVmReturn = body.indexOf('if (!vm)');
    expect(hidePos).toBeGreaterThan(0);
    expect(hidePos).toBeLessThan(nullDataReturn);
    expect(hidePos).toBeLessThan(nullVmReturn);
  });

  it('html title is 工房台账 and the page is zh-CN', () => {
    expect(html).toContain('<title>工房台账</title>');
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('<span class="title">工房台账</span>');
  });

  it('panel.css declares the GitHub-density strip: 10px rows, 10px auto columns, 3px gap, start alignment', () => {
    expect(css).toContain('grid-template-rows: repeat(7, 10px)');
    expect(css).toContain('grid-auto-flow: column');
    expect(css).toContain('grid-auto-columns: 10px');
    expect(css).toContain('gap: 3px');
    expect(css).toContain('justify-content: start');
  });

  it('panel.css exposes the custom stats-strip-tooltip', () => {
    expect(css).toContain('position: fixed');
    expect(css).toContain('pointer-events: none');
    expect(css).toContain('display: none');
    expect(css).toContain('.stats-strip-tooltip');
    expect(css).toContain('.stats-strip-tooltip-value');
    expect(css).toContain('.stats-strip-tooltip-meta');
  });

  it('panel.css styles tabs, switch and flat ledger rows, keeping one paper surface with no cards/gradients/blur', () => {
    expect(css).toContain('.stats-tabs');
    expect(css).toContain('.stats-tab');
    expect(css).toContain('.stats-switch');
    expect(css).toContain('.stats-table-head');
    expect(css).toContain('.stats-data-row');
    expect(css).toContain('.stats-period-totals');
    expect(css).toContain('.stats-detail-line');
    expect(css).not.toContain('box-shadow');
    expect(css).not.toContain('gradient');
    expect(css).not.toContain('backdrop-filter');
  });

  it('panel.css adds a CJK font fallback for readable Chinese', () => {
    expect(css).toContain('"Microsoft YaHei"');
  });

  it('keeps fixed-width right columns so tables fit at 400px without horizontal overflow', () => {
    const tabsBlock = css.slice(css.indexOf('.stats-data-row'), css.indexOf('.stats-tab-empty'));
    expect(tabsBlock).toContain('flex-shrink: 0');
    expect(tabsBlock).toContain('min-width: 0');
    expect(css).toContain('.stats-data-name');
    expect(css).toContain('.stats-data-token');
    expect(css).toContain('.stats-data-tps');
    expect(css).toContain('.stats-data-duration');
    expect(css).toContain('.stats-data-share');
  });
});
