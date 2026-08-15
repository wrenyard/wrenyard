// ── 工房台账 (Workshop Ledger) — Chinese three-section page ─────────────
// Sections, in exact order:
//   1. 摘要 — today hero, compact details, 31-day strip, inline period totals
//   2. 运行统计 — period tabs over stats.summary.windows byProfile
//   3. 任务统计 — period tabs + builtin switch over window taskStats
// Legacy (no windows) keeps today/daily/strip and shows honest newer-Foreman
// messages for the two tables.

interface DailyEntry {
  dayKey: string;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: string;
  outcomes?: { done: number; failed: number; cancelled: number };
}

interface StatsWindowProfileRow {
  profile: string;
  runCount: number;
  totalTokens: number;
  averageTps?: number | null;
}

interface StatsWindowTaskRow {
  taskId: string;
  source: 'builtin' | 'project' | 'unknown';
  runCount: number;
  durationMs: number;
}

interface StatsWindowTaskStats {
  totalDurationMs: number;
  byTask: StatsWindowTaskRow[];
  builtinTotalDurationMs: number;
  byBuiltinTask: Array<{ taskId: string; runCount: number; durationMs: number }>;
}

interface StatsWindow {
  period: Period;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  totalTokens: number;
  byProfile: StatsWindowProfileRow[];
  taskStats: StatsWindowTaskStats;
}

interface StatsPayload {
  summary?: {
    daily: DailyEntry[];
    source?: string;
    today?: DailyEntry;
    windows?: StatsWindow[];
  };
  dailyStats?: DailyEntry;
}

export type Period = '24h' | '7d' | '1mo';
export const PERIODS: Period[] = ['24h', '7d', '1mo'];

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const safe = Math.max(0, Math.floor(n));
  // Explicit uppercase K/M so token millions can never be mistaken for
  // minute/hour durations rendered elsewhere in the ledger.
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
  if (safe >= 1_000) return `${(Math.floor(safe / 100) / 10).toFixed(1)}K`;
  return String(safe);
}

/** Format an elapsed-time duration in minutes/hours only. Day-scale totals
 *  stay in hours (e.g. 25h 30m) so durations are never confused with token
 *  units. Never derives durations from tokens or dispatch counts. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes === 0) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

// ── Pure helpers exported for testing ────────────────────────────────

export interface ProfileRow {
  name: string;
  runs: number;
  tokens: string;
  /** Average TPS formatted to exactly two decimals, or dash when absent. */
  tps: string;
}

export interface TaskRow {
  taskId: string;
  runs: number;
  avgDuration: string;
  /** Time share: integer percent, or <1% when positive but sub-percent. */
  share: string;
}

export interface LedgerPeriodTotal {
  label: Period;
  dispatchCount: number;
  totalTokens: string;
}

export interface LedgerViewModel {
  hasToday: boolean;
  today: {
    dispatchCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    done: number;
    failed: number;
    cancelled: number;
    doneRate: string;
    totalTaskTime: string;
  } | null;
  strip: Array<{ dayKey: string; level: 0 | 1 | 2 | 3; dispatchCount: number; totalTokens: number }>;
  stripStart: string;
  stripEnd: string;
  periodTotals: LedgerPeriodTotal[];
  windowsAvailable: boolean;
  profiles: { period: Period; rows: ProfileRow[] };
  tasks: { period: Period; builtinOnly: boolean; rows: TaskRow[] };
  isOldDaemon: boolean;
}

export interface LedgerViewOptions {
  profilePeriod?: Period;
  taskPeriod?: Period;
  builtinOnly?: boolean;
}

export function buildLedgerViewModel(data: StatsPayload | null, opts?: LedgerViewOptions): LedgerViewModel | null {
  if (!data) return null;

  const summary = data.summary;
  const daily = data.dailyStats ?? summary?.daily?.at(-1);
  if (!daily) return null;

  const isOldDaemon = !summary;
  const todaySummary = summary?.today ?? daily;
  const outcomes = todaySummary.outcomes ?? { done: 0, failed: 0, cancelled: 0 };

  // Completion rate is done/(done+failed), cancelled excluded, two decimals.
  const totalOutcome = outcomes.done + outcomes.failed;
  const doneRate = totalOutcome > 0 ? `${((outcomes.done / totalOutcome) * 100).toFixed(2)}%` : '—';

  const windows = summary?.windows;
  const windowsAvailable = Array.isArray(windows) && windows.length === 3;
  const totalTaskTime = windowsAvailable ? formatDuration(windows![0].taskStats.totalDurationMs) : '—';

  // Sort daily defensively by dayKey ascending (oldest first)
  const sortedDaily = summary?.daily
    ? [...summary.daily].sort((a, b) => a.dayKey.localeCompare(b.dayKey))
    : null;
  const newestDays = sortedDaily ?? [daily];
  const last7Days = newestDays.slice(-7);
  const last31Days = newestDays.slice(-31);

  // 31-day strip (oldest to newest) with relative three-cluster intensity
  const stripDays = last31Days;
  const nonzeroCounts = stripDays.map((d) => d.dispatchCount).filter((c) => c > 0).sort((a, b) => a - b);
  const lowerTercile = nonzeroCounts.length > 0 ? nonzeroCounts[Math.floor(nonzeroCounts.length / 3)] : 0;
  const upperTercile = nonzeroCounts.length > 0 ? nonzeroCounts[Math.floor(nonzeroCounts.length * 2 / 3)] : 0;
  const strip = stripDays.map((d) => ({
    dayKey: d.dayKey,
    level: (d.dispatchCount === 0 ? 0 : d.dispatchCount < lowerTercile ? 1 : d.dispatchCount < upperTercile ? 2 : 3) as 0 | 1 | 2 | 3,
    dispatchCount: d.dispatchCount,
    totalTokens: d.totalTokens,
  }));
  const stripStart = stripDays.length > 0 ? stripDays[0].dayKey : daily.dayKey;
  const stripEnd = stripDays.length > 0 ? stripDays[stripDays.length - 1].dayKey : daily.dayKey;

  // Inline 24h/7d/1mo dispatch + total-token totals
  const last7Dispatch = last7Days.reduce((s, d) => s + d.dispatchCount, 0);
  const last7Tokens = last7Days.reduce((s, d) => s + d.totalTokens, 0);
  const allDispatch = last31Days.reduce((s, d) => s + d.dispatchCount, 0);
  const allTokens = last31Days.reduce((s, d) => s + d.totalTokens, 0);
  const periodTotals: LedgerPeriodTotal[] = [
    { label: '24h', dispatchCount: todaySummary.dispatchCount, totalTokens: formatCount(todaySummary.totalTokens) },
    { label: '7d', dispatchCount: last7Dispatch, totalTokens: formatCount(last7Tokens) },
    { label: '1mo', dispatchCount: allDispatch, totalTokens: formatCount(allTokens) },
  ];

  const profilePeriod = opts?.profilePeriod ?? '24h';
  const taskPeriod = opts?.taskPeriod ?? '24h';
  const builtinOnly = opts?.builtinOnly ?? false;

  // Profiles come only from the resolved byProfile names of the active window.
  const profileRows: ProfileRow[] = windowsAvailable
    ? (windows!.find((w) => w.period === profilePeriod)?.byProfile ?? []).map((p) => ({
        name: p.profile,
        runs: p.runCount,
        tokens: formatCount(p.totalTokens),
        tps: typeof p.averageTps === 'number' && Number.isFinite(p.averageTps) ? p.averageTps.toFixed(2) : '—',
      }))
    : [];

  // Tasks come only from window taskStats; the builtin switch selects the
  // server-filtered byBuiltinTask/builtinTotalDurationMs pair, never client
  // heuristics on task ids or projects.
  const taskWindow = windowsAvailable ? windows!.find((w) => w.period === taskPeriod) : undefined;
  const taskRows: TaskRow[] = [];
  if (taskWindow) {
    const ts = taskWindow.taskStats;
    const denominator = builtinOnly ? ts.builtinTotalDurationMs : ts.totalDurationMs;
    const sourceRows = builtinOnly ? ts.byBuiltinTask : ts.byTask;
    for (const r of sourceRows) {
      const avgMs = r.runCount > 0 ? r.durationMs / r.runCount : 0;
      const rawPct = denominator > 0 ? (r.durationMs / denominator) * 100 : 0;
      const pct = Math.min(100, Math.max(0, Math.round(rawPct)));
      const share = rawPct > 0 && pct === 0 ? '<1%' : `${pct}%`;
      taskRows.push({ taskId: r.taskId, runs: r.runCount, avgDuration: formatDuration(avgMs), share });
    }
  }

  return {
    hasToday: true,
    today: {
      dispatchCount: todaySummary.dispatchCount,
      inputTokens: todaySummary.inputTokens,
      outputTokens: todaySummary.outputTokens,
      totalTokens: todaySummary.totalTokens,
      done: outcomes.done,
      failed: outcomes.failed,
      cancelled: outcomes.cancelled,
      doneRate,
      totalTaskTime,
    },
    strip,
    stripStart,
    stripEnd,
    periodTotals,
    windowsAvailable,
    profiles: { period: profilePeriod, rows: profileRows },
    tasks: { period: taskPeriod, builtinOnly, rows: taskRows },
    isOldDaemon,
  };
}

// ── HTML rendering (DOM-based) ───────────────────────────────────────

// Independent module-level period state. Defaults to 24h, persists across
// the five-second data refresh, and resets when the panel window closes.
let profilePeriod: Period = '24h';
let taskPeriod: Period = '24h';
let builtinOnly = false;
let currentData: StatsPayload | null = null;
let rootEl: HTMLElement | null = null;

// Reusable custom tooltip for the strip heatmap
let tooltipEl: HTMLDivElement | null = null;

function getOrCreateTooltip(): HTMLDivElement {
  if (tooltipEl) return tooltipEl;
  const el = document.createElement('div');
  el.className = 'stats-strip-tooltip';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  tooltipEl = el;
  return el;
}

function hideTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

function showTooltipForCell(cell: { dayKey: string; dispatchCount: number; totalTokens: number }, clientX: number, clientY: number): void {
  const tip = getOrCreateTooltip();
  tip.textContent = '';
  tip.style.display = 'block';

  const valueLine = document.createElement('div');
  valueLine.className = 'stats-strip-tooltip-value';
  valueLine.textContent = `${formatCount(cell.totalTokens)} tok`;
  tip.appendChild(valueLine);

  const metaLine = document.createElement('div');
  metaLine.className = 'stats-strip-tooltip-meta';
  metaLine.textContent = `${cell.dayKey} · ${cell.dispatchCount} 次调度`;
  tip.appendChild(metaLine);

  const rect = tip.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(clientY + 12, window.innerHeight - rect.height - 8);
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}

function createEmptyNote(text: string): HTMLElement {
  const note = document.createElement('div');
  note.className = 'stats-tab-empty';
  note.textContent = text;
  return note;
}

/** Rebuild the panel after a period/switch change and move focus to the
 *  matching control so keyboard and screen-reader users stay in place. */
function setPeriod(group: 'profiles' | 'tasks', period: Period): void {
  if (group === 'profiles') profilePeriod = period;
  else taskPeriod = period;
  if (rootEl === null || currentData === null) return;
  renderStats(currentData, rootEl);
  const tablist = rootEl.querySelector<HTMLElement>(`.stats-tabs[data-group="${group}"]`);
  const tab = tablist?.querySelector<HTMLButtonElement>(`.stats-tab[data-period="${period}"]`);
  tab?.focus();
}

function toggleBuiltinFilter(): void {
  builtinOnly = !builtinOnly;
  if (rootEl === null || currentData === null) return;
  renderStats(currentData, rootEl);
  rootEl.querySelector<HTMLElement>('.stats-switch')?.focus();
}

function createTablist(group: 'profiles' | 'tasks', activePeriod: Period): HTMLElement {
  const tablist = document.createElement('div');
  tablist.className = 'stats-tabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', group === 'profiles' ? '运行统计周期' : '任务统计周期');
  tablist.dataset.group = group;

  for (const period of PERIODS) {
    const tab = document.createElement('button');
    tab.className = 'stats-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('data-period', period);
    tab.textContent = period;
    const selected = period === activePeriod;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
    if (selected) tab.classList.add('stats-tab-active');
    tab.addEventListener('click', () => setPeriod(group, period));
    tablist.appendChild(tab);
  }

  // Roving-tabindex arrow navigation: Left/Right cycle, Home/End jump.
  tablist.addEventListener('keydown', (event) => {
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('.stats-tab'));
    const currentIndex = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    let next = -1;
    if (event.key === 'ArrowRight') next = currentIndex + 1;
    else if (event.key === 'ArrowLeft') next = currentIndex - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next >= 0 && next < tabs.length) {
      event.preventDefault();
      const period = (tabs[next].dataset.period ?? '24h') as Period;
      setPeriod(group, period);
    }
  });

  return tablist;
}

function renderSummarySection(vm: LedgerViewModel): HTMLElement {
  const section = document.createElement('div');
  section.className = 'stats-section';
  section.dataset.section = 'summary';

  const heading = document.createElement('div');
  heading.className = 'stats-header';
  heading.textContent = '摘要';
  section.appendChild(heading);

  if (vm.today) {
    // Today hero: dispatch count + total tokens
    const hero = document.createElement('div');
    hero.className = 'stats-hero';

    const dispatchGroup = document.createElement('div');
    dispatchGroup.className = 'stats-hero-metric';
    const dispatchHero = document.createElement('div');
    dispatchHero.className = 'stats-hero-value';
    dispatchHero.textContent = String(vm.today.dispatchCount);
    dispatchGroup.appendChild(dispatchHero);
    const dispatchLabel = document.createElement('div');
    dispatchLabel.className = 'stats-hero-label';
    dispatchLabel.textContent = '调度次数';
    dispatchGroup.appendChild(dispatchLabel);
    hero.appendChild(dispatchGroup);

    const tokenGroup = document.createElement('div');
    tokenGroup.className = 'stats-hero-metric';
    const tokenHero = document.createElement('div');
    tokenHero.className = 'stats-hero-value';
    tokenHero.textContent = formatCount(vm.today.totalTokens);
    tokenGroup.appendChild(tokenHero);
    const tokenLabel = document.createElement('div');
    tokenLabel.className = 'stats-hero-label';
    tokenLabel.textContent = '总 TOKEN';
    tokenGroup.appendChild(tokenLabel);
    hero.appendChild(tokenGroup);

    section.appendChild(hero);

    // Compact input/output/completion-rate/total-task-time line
    const details = document.createElement('div');
    details.className = 'stats-detail-line';
    details.textContent = `输入 ${formatCount(vm.today.inputTokens)} · 输出 ${formatCount(vm.today.outputTokens)} · 完成率 ${vm.today.doneRate} · 任务时长 ${vm.today.totalTaskTime}`;
    section.appendChild(details);
  }

  // 31-day heatmap strip
  if (vm.strip.length > 0) {
    const stripContainer = document.createElement('div');
    stripContainer.className = 'stats-strip';

    for (const cell of vm.strip) {
      const c = document.createElement('div');
      c.className = `stats-strip-cell stats-strip-level-${cell.level}`;
      c.setAttribute('aria-label', `${cell.dayKey} · ${cell.dispatchCount} 次调度 · ${formatCount(cell.totalTokens)} tok`);
      c.tabIndex = 0;
      c.addEventListener('pointerenter', (e) => {
        showTooltipForCell(cell, e.clientX, e.clientY);
      });
      c.addEventListener('pointerleave', hideTooltip);
      c.addEventListener('focus', () => {
        const rect = c.getBoundingClientRect();
        showTooltipForCell(cell, rect.left + rect.width / 2, rect.top - 4);
      });
      c.addEventListener('blur', hideTooltip);
      stripContainer.appendChild(c);
    }

    section.appendChild(stripContainer);

    const endpoints = document.createElement('div');
    endpoints.className = 'stats-strip-endpoints';
    const startEl = document.createElement('span');
    startEl.className = 'stats-strip-start';
    startEl.textContent = vm.stripStart;
    const endEl = document.createElement('span');
    endEl.className = 'stats-strip-end';
    endEl.textContent = vm.stripEnd;
    endpoints.appendChild(startEl);
    endpoints.appendChild(endEl);
    section.appendChild(endpoints);
  }

  // Inline 24h/7d/1mo dispatch + total-token row
  const totals = document.createElement('div');
  totals.className = 'stats-period-totals';
  for (const t of vm.periodTotals) {
    const cell = document.createElement('div');
    cell.className = 'stats-period-total';
    const label = document.createElement('span');
    label.className = 'stats-period-total-label';
    label.textContent = t.label;
    const value = document.createElement('span');
    value.className = 'stats-period-total-value';
    value.textContent = `${t.dispatchCount} · ${t.totalTokens} tok`;
    cell.appendChild(label);
    cell.appendChild(value);
    totals.appendChild(cell);
  }
  section.appendChild(totals);

  return section;
}

function renderProfileSection(vm: LedgerViewModel): HTMLElement {
  const section = document.createElement('div');
  section.className = 'stats-section';
  section.dataset.section = 'profiles';

  const heading = document.createElement('div');
  heading.className = 'stats-header';
  heading.textContent = '运行统计';
  section.appendChild(heading);

  section.appendChild(createTablist('profiles', vm.profiles.period));

  const head = document.createElement('div');
  head.className = 'stats-table-head';
  [
    { cls: 'stats-data-name', text: '名称' },
    { cls: 'stats-data-num', text: '次数' },
    { cls: 'stats-data-token', text: 'TOKEN' },
    { cls: 'stats-data-tps', text: 'TPS' },
  ].forEach((col) => {
    const cell = document.createElement('span');
    cell.className = col.cls;
    cell.textContent = col.text;
    head.appendChild(cell);
  });
  section.appendChild(head);

  if (!vm.windowsAvailable) {
    section.appendChild(createEmptyNote('需要新版 Foreman 才能显示运行统计'));
  } else if (vm.profiles.rows.length === 0) {
    section.appendChild(createEmptyNote('该周期暂无运行数据'));
  } else {
    for (const r of vm.profiles.rows) {
      const row = document.createElement('div');
      row.className = 'stats-data-row';
      const name = document.createElement('span');
      name.className = 'stats-data-name';
      name.textContent = r.name;
      const runs = document.createElement('span');
      runs.className = 'stats-data-num';
      runs.textContent = String(r.runs);
      const tokens = document.createElement('span');
      tokens.className = 'stats-data-token';
      tokens.textContent = `${r.tokens} tok`;
      const tps = document.createElement('span');
      tps.className = 'stats-data-tps';
      tps.textContent = r.tps;
      row.appendChild(name);
      row.appendChild(runs);
      row.appendChild(tokens);
      row.appendChild(tps);
      section.appendChild(row);
    }
  }

  return section;
}

function renderTaskSection(vm: LedgerViewModel): HTMLElement {
  const section = document.createElement('div');
  section.className = 'stats-section';
  section.dataset.section = 'tasks';

  const heading = document.createElement('div');
  heading.className = 'stats-header';
  heading.textContent = '任务统计';
  section.appendChild(heading);

  const controls = document.createElement('div');
  controls.className = 'stats-tasks-controls';
  controls.appendChild(createTablist('tasks', vm.tasks.period));

  const switchBtn = document.createElement('button');
  switchBtn.className = 'stats-switch';
  switchBtn.setAttribute('role', 'switch');
  switchBtn.setAttribute('aria-checked', vm.tasks.builtinOnly ? 'true' : 'false');
  switchBtn.textContent = '内置任务';
  switchBtn.addEventListener('click', toggleBuiltinFilter);
  controls.appendChild(switchBtn);
  section.appendChild(controls);

  const head = document.createElement('div');
  head.className = 'stats-table-head';
  [
    { cls: 'stats-data-name', text: 'Task ID' },
    { cls: 'stats-data-num', text: '次数' },
    { cls: 'stats-data-duration', text: '平均时长' },
    { cls: 'stats-data-share', text: '时间占比' },
  ].forEach((col) => {
    const cell = document.createElement('span');
    cell.className = col.cls;
    cell.textContent = col.text;
    head.appendChild(cell);
  });
  section.appendChild(head);

  if (!vm.windowsAvailable) {
    section.appendChild(createEmptyNote('需要新版 Foreman 才能显示任务统计'));
  } else if (vm.tasks.rows.length === 0) {
    section.appendChild(createEmptyNote('该周期暂无任务数据'));
  } else {
    for (const r of vm.tasks.rows) {
      const row = document.createElement('div');
      row.className = 'stats-data-row';
      const taskId = document.createElement('span');
      taskId.className = 'stats-data-name';
      taskId.textContent = r.taskId;
      const runs = document.createElement('span');
      runs.className = 'stats-data-num';
      runs.textContent = String(r.runs);
      const duration = document.createElement('span');
      duration.className = 'stats-data-duration';
      duration.textContent = r.avgDuration;
      const share = document.createElement('span');
      share.className = 'stats-data-share';
      share.textContent = r.share;
      row.appendChild(taskId);
      row.appendChild(runs);
      row.appendChild(duration);
      row.appendChild(share);
      section.appendChild(row);
    }
  }

  return section;
}

export function renderStats(data: StatsPayload | null, root?: HTMLElement): string {
  if (typeof document === 'undefined') {
    if (root) root.textContent = '工房台账暂无数据。';
    return '';
  }

  hideTooltip();
  const el = root ?? document.createElement('div');

  if (!el || !data) {
    if (root) root.textContent = '工房台账暂无数据。';
    return '';
  }

  const vm = buildLedgerViewModel(data, { profilePeriod, taskPeriod, builtinOnly });
  if (!vm) {
    if (root) root.textContent = '工房台账暂无数据。';
    return '';
  }

  currentData = data;
  rootEl = el;
  el.innerHTML = '';

  el.appendChild(renderSummarySection(vm));
  el.appendChild(renderProfileSection(vm));
  el.appendChild(renderTaskSection(vm));

  if (root) return '';
  return el.innerHTML;
}

async function init(): Promise<void> {
  const closeBtn = document.getElementById('close-btn');
  closeBtn?.addEventListener('click', () => {
    const api = (window as any).statsPanelApi;
    if (api?.close) api.close();
  });

  // Load initial data
  const api = (window as any).statsPanelApi;
  if (api?.load) {
    const data = await api.load();
    renderStats(data as StatsPayload | null, document.getElementById('stats-content')!);
  }

  // Listen for updates
  if (api?.onData) {
    api.onData((data: unknown) => {
      renderStats(data as StatsPayload | null, document.getElementById('stats-content')!);
    });
  }
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', init);
}
