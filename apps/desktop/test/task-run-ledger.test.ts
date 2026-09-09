import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Focused source/markup regression test for the 近期 Task 消耗 (recent
 * Task-run ledger) renderer in src/renderer/app.ts, its markup container in
 * index.html, and its grid/status styles in app.css. The renderer is a
 * document-building module, so the ledger contract is asserted over the exact
 * source it ships with. Deliberately isolated from the Task-page tests.
 */

function readRendererSource(fileName: string): string {
  return readFileSync(new URL(`../src/renderer/${fileName}`, import.meta.url), 'utf8');
}

const appSource = readRendererSource('app.ts');
const htmlSource = readRendererSource('index.html');
const cssSource = readRendererSource('app.css');

/** Region from the status-icon helper through the ledger renderer body. */
function ledgerRegion(): string {
  const start = appSource.indexOf('function taskRunStatusLabel');
  const end = appSource.indexOf('function emptyRow', start);
  assert.ok(start >= 0 && end > start, 'ledger helpers must precede emptyRow in app.ts');
  return appSource.slice(start, end);
}

test('recent-run ledger is a six-column authoritative table without dense cells or fabricated telemetry', () => {
  const body = ledgerRegion();

  // Exact six headers in exact order, 完成时间 last.
  assert.ok(
    body.includes("tableHeader(['状态', '中文任务名', '模型', '↑输入 / ↓输出', '速度', '完成时间'])"),
    'six exact headers in order (状态, 中文任务名, 模型, ↑输入 / ↓输出, 速度, 完成时间)',
  );

  // Old dense 8-column ledger and estimate/prose columns are gone.
  for (const gone of ['选择速度', '参考费用', '尝试 / 完整', 'completenessLabel', 'costLabel', 'attemptCount', 'totalTokens']) {
    assert.ok(!body.includes(gone), `legacy dense-ledger artifact ${gone} must be removed`);
  }

  // Status is a compact icon column with tooltip and accessible name.
  assert.ok(body.includes("setAttribute('role', 'img')"), 'status icon exposes an img role');
  assert.ok(body.includes("setAttribute('aria-label', label)"), 'status icon exposes an accessible name');
  assert.ok(body.includes('.title = label'), 'status icon carries a title tooltip');
  assert.ok(body.includes('taskRunStatusGlyph'), 'status icon has one compact glyph per state');
  for (const status of ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted', 'unknown']) {
    assert.ok(body.includes(`'${status}'`), `status ${status} is handled`);
  }

  // Queued/running rows always show '-' even when partial telemetry exists.
  assert.ok(body.includes("run.status === 'queued' || run.status === 'running'"), 'active rows use placeholder cells');
  assert.ok(body.includes("'-'"), 'placeholder cells render a dash');

  // Terminal rows read authoritative input/output/outputTps only.
  assert.ok(body.includes('run.usage.inputTokens'), 'input tokens come only from usage.inputTokens');
  assert.ok(body.includes('run.usage.outputTokens'), 'output tokens come only from usage.outputTokens');
  assert.ok(body.includes('run.usage.outputTps'), 'speed comes only from usage.outputTps');
  assert.ok(body.includes('↑') && body.includes('↓'), 'token arrows are preserved');

  // No compact-token formatter and no selection-speed evidence inside the renderer.
  assert.ok(!body.includes('formatCompactTokenCount'), 'no compact token formatter in the ledger renderer');
  assert.ok(!body.includes('.speed') && !body.includes('speed.'), 'no selection-speed evidence in the ledger renderer');
});

test('recent-run ledger completion-time column is terminal-only canonical finishedAt with no clock fallback', () => {
  const body = ledgerRegion();

  const start = body.indexOf('function taskRunCompletionTimeCell');
  const end = body.indexOf('function renderTaskRuns', start);
  assert.ok(start >= 0 && end > start, 'taskRunCompletionTimeCell must precede renderTaskRuns in app.ts');
  const cell = body.slice(start, end);

  // Only done/failed/cancelled/interrupted read the canonical finishedAt.
  assert.ok(cell.includes("run.status === 'done' || run.status === 'failed'"), 'done/failed are terminal');
  assert.ok(cell.includes("run.status === 'cancelled' || run.status === 'interrupted'"), 'cancelled/interrupted are terminal');
  for (const active of ['queued', 'running', 'unknown']) {
    assert.ok(!cell.includes(`'${active}'`), `active state ${active} is never a completion-time source`);
  }

  // Valid terminal values render compact text and a full localized tooltip.
  assert.ok(cell.includes('formatTaskCompletionTime('), 'compact completion text uses formatTaskCompletionTime');
  assert.ok(cell.includes('formatTaskCompletionTimeTooltip('), 'full localized tooltip uses formatTaskCompletionTimeTooltip');

  // The helper reads status and finishedAt only; no clock/timer fallback.
  const runReferences: string[] = cell.match(/run\.[A-Za-z_$]+/g) ?? [];
  assert.ok(runReferences.includes('run.status') && runReferences.includes('run.finishedAt'), 'cell reads status and finishedAt only');
  for (const reference of runReferences) {
    assert.ok(
      reference === 'run.status' || reference === 'run.finishedAt',
      `stray run reference ${reference} must not feed the completion-time cell`,
    );
  }
  for (const fallback of ['startedAt', 'updatedAt', 'Date.now', 'new Date']) {
    assert.ok(!cell.includes(fallback), `no ${fallback} fallback in the completion-time cell`);
  }

  // Exactly one completion-time cell per run, one rendered row per entry.
  assert.ok((body.match(/taskRunCompletionTimeCell\(run\)/g) ?? []).length === 1, 'each ledger run row appends exactly one completion-time cell');
  assert.ok((body.match(/return row;/g) ?? []).length === 1, 'ledger keeps exactly one rendered row per runs.map entry');
});

test('recent-run ledger resolves display names only through authoritative TaskSettings identities', () => {
  // Stats refresh must fetch and render the stats snapshot before it starts
  // the settings lookup: issuing getStats and getTaskSettings concurrently
  // pushes stats.summary past its 5s request timeout and regresses to
  // today-only compatibility data while task definitions cold-resolve.
  const refreshStart = appSource.indexOf('async function refreshStats');
  const refreshEnd = appSource.indexOf('async function refreshQuota', refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'refreshStats must precede refreshQuota in app.ts');
  const refreshBody = appSource.slice(refreshStart, refreshEnd);
  const statsAt = refreshBody.indexOf('window.wrenyardShell.getStats()');
  const settingsAt = refreshBody.indexOf('window.wrenyardShell.getTaskSettings()');
  const renderAt = refreshBody.indexOf('renderStats(snapshot)');
  assert.ok(statsAt >= 0 && settingsAt > statsAt, 'stats are fetched before getTaskSettings starts');
  assert.ok(renderAt >= 0 && settingsAt > renderAt, 'stats render before the settings lookup starts');
  assert.ok(!refreshBody.includes('Promise.all'), 'stats and settings are never fetched concurrently');
  assert.ok(refreshBody.includes('buildTaskDisplayNames(settings)'), 'settings result rebuilds the display-name map');
  assert.ok(
    refreshBody.indexOf('renderTaskRuns(snapshot)') > refreshBody.indexOf('buildTaskDisplayNames(settings)'),
    'only the ledger reruns from the same stats snapshot after display names are rebuilt',
  );
  assert.ok(appSource.includes('taskDisplayNames: ReadonlyMap<string, string>'), 'display map is read-only');
  assert.ok(appSource.includes('map.set(row.identity, row.display_name)'), 'display map is built from authoritative TaskSettings rows');

  const ledger = ledgerRegion();
  // Builtin identity is builtin:<task>; project identity is project:<project>:<task>.
  assert.ok(ledger.includes('`builtin:${run.taskId}`'), 'builtin rows resolve through builtin:<task>');
  assert.ok(ledger.includes('`project:${project}:${run.taskId}`'), 'project rows resolve through project:<project>:<task>');
  // A settings miss (or an unknowable historical identity) falls back to the
  // exact task identifier; history is never rewritten or guessed.
  assert.ok(ledger.includes('taskDisplayNames.get(identity) ?? run.taskId'), 'settings miss renders the exact task identifier');
});

test('recent-run ledger panel is plain markup with wrapping six-column styles', () => {
  // index.html: the panel keeps only its title and simplified table; the
  // reference-cost disclaimer/legend is gone.
  assert.ok(htmlSource.includes('近期 Task 消耗'), 'panel title remains');
  assert.ok(htmlSource.includes('id="stats-task-runs-list"'), 'panel table remains');
  assert.ok(!htmlSource.includes('参考费用为估算，非账单'), 'reference-cost disclaimer legend is removed');

  // app.css: six-column grid with the completion-time track last, readable
  // wrapping for long names/model ids, last three columns right aligned, no
  // orphaned 8-column selectors or forced min-width.
  assert.ok(
    cssSource.includes('#stats-task-runs-list .table-row { grid-template-columns: 34px minmax(0, 1.3fr) minmax(0, 1.05fr) minmax(112px, .9fr) 88px minmax(96px, .72fr);'),
    'six-column grid for the ledger rows',
  );
  assert.ok(
    cssSource.includes('#stats-task-runs-list .table-row > :nth-last-child(3), #stats-task-runs-list .table-row > :nth-last-child(2), #stats-task-runs-list .table-row > :last-child'),
    'last three ledger columns are right aligned',
  );
  assert.ok(cssSource.includes('white-space: normal'), 'long task names and model ids wrap naturally');
  assert.ok(cssSource.includes('overflow-wrap: anywhere'), 'unbounded content wraps without ellipsis truncation');
  assert.ok(!cssSource.includes('min-width: 760px'), 'no forced mobile min-width rule for the old 8-column table');
  assert.ok(!cssSource.includes('minmax(0, 1.1fr) 42px'), 'no orphaned 8-column grid selector');
});

test('recent-run ledger model cell renders paired Catalog display labels joined by a middle dot only', () => {
  const start = appSource.indexOf('function taskRunModelLabel');
  const end = appSource.indexOf('function modelStatsLabel', start);
  assert.ok(start >= 0 && end > start, 'model label helpers must precede modelStatsLabel in app.ts');
  const body = appSource.slice(start, end);

  assert.ok(
    body.includes('function taskRunModelLabel(run: TaskRunSnapshot): string | null {'),
    'paired display labels are resolved through a reusable helper',
  );
  // Only the two paired server-provided display-name fields feed the cell.
  assert.ok(body.includes('run.resolvedProviderDisplayName'), 'provider display label is read from the run row');
  assert.ok(body.includes('run.resolvedModelDisplayName'), 'model display label is read from the run row');
  // Both labels are rendered as one label joined by a middle dot.
  assert.ok(body.includes(' · '), 'paired display names are joined by a middle dot');
  // A missing half or an alias-only history row renders the dash placeholder.
  assert.ok(body.includes('return null;'), 'incomplete display pair remains unknown');
  assert.ok(body.includes("taskRunCell(taskRunModelLabel(run) ?? '-')"), 'model cell renders the dash placeholder');

  // The helper body touches only the display-name properties of the run: no raw
  // resolved model id/model/profile/client/provider value may feed the cell.
  const runReferences = body.match(/run\.resolved[A-Za-z_$]*/g) ?? [];
  assert.ok(runReferences.length > 0, 'model cell reads the paired resolved display labels');
  for (const reference of runReferences) {
    assert.ok(
      reference === 'run.resolvedProviderDisplayName' || reference === 'run.resolvedModelDisplayName',
      `raw resolved identity reference ${reference} must not feed the model cell`,
    );
  }
});

test('model statistics uses exact recent-run display labels without exposing profiles or guessing aliases', () => {
  assert.ok(htmlSource.includes('<h2 id="profile-title">模型统计</h2>'), 'card heading is 模型统计');
  const renderStart = appSource.indexOf('function renderProfiles');
  const renderEnd = appSource.indexOf('function renderTasks', renderStart);
  const renderBody = appSource.slice(renderStart, renderEnd);
  assert.ok(renderBody.includes("tableHeader(['模型', '运行', 'Token', '平均 TPS'])"), 'first column is 模型');
  assert.ok(renderBody.includes("emptyRow('暂无模型统计')"), 'empty state names model statistics');
  assert.ok(renderBody.includes('modelStatsLabel(snapshot, row.name)'), 'profile identity is projected through the bounded helper');
  assert.ok(!renderBody.includes("row.name,"), 'raw profile never feeds the visible first cell');

  const labelStart = appSource.indexOf('function modelStatsLabel');
  const labelEnd = appSource.indexOf('function taskRunCompletionTimeCell', labelStart);
  const labelBody = appSource.slice(labelStart, labelEnd);
  assert.ok(labelBody.includes('snapshot.recentTaskRuns'), 'mapping uses only the same stats snapshot');
  assert.ok(labelBody.includes('run.resolvedProfile'), 'mapping requires an exact resolved profile');
  assert.ok(labelBody.includes('run.resolvedProvider'), 'mapping requires the canonical provider');
  assert.ok(labelBody.includes('run.resolvedModel'), 'mapping requires the canonical model');
  assert.ok(labelBody.includes('startsWith(`${provider}/${model}:`)'), 'profile/provider/model must be internally consistent');
  assert.ok(labelBody.includes('ambiguous.add(resolvedProfile)'), 'conflicting labels become ambiguous');
  assert.ok(labelBody.includes("return labels.get(profile) ?? '-'"), 'unknown and alias-only buckets render a dash');
});
