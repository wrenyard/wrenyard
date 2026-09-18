import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

/**
 * Focused source/markup regression test for the 近期任务消耗 (recent
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
const iconSource = readRendererSource('agent-task-icon.ts');

/** Region from the status-icon helper through the ledger renderer body. */
function ledgerRegion(): string {
  const start = appSource.indexOf('function taskRunStatusCell');
  const end = appSource.indexOf('function emptyRow', start);
  assert.ok(start >= 0 && end > start, 'ledger helpers must precede emptyRow in app.ts');
  return appSource.slice(start, end);
}

test('recent-run ledger is a seven-column authoritative table without dense cells or fabricated telemetry', () => {
  const body = ledgerRegion();

  // Exact seven headers in exact order, 完成时间 last.
  assert.ok(
    body.includes("tableHeader(['状态', '中文任务名', '模型', '↑输入 / ↓输出', '速度', '耗时', '完成时间'])"),
    'seven exact headers in order (状态, 中文任务名, 模型, ↑输入 / ↓输出, 速度, 耗时, 完成时间)',
  );

  // Old dense 8-column ledger and estimate/prose columns are gone.
  for (const gone of ['选择速度', '参考费用', '尝试 / 完整', 'completenessLabel', 'costLabel', 'attemptCount', 'totalTokens']) {
    assert.ok(!body.includes(gone), `legacy dense-ledger artifact ${gone} must be removed`);
  }

  // Status is the shared compact icon; the ledger delegates rather than
  // re-implementing glyph/label markup, and it must not carry a bespoke helper.
  assert.ok(
    body.includes('return createAgentTaskStatusIcon(run.status);'),
    'status cell delegates to the shared agent-task status icon',
  );
  assert.ok(
    appSource.includes("import { createAgentTaskStatusIcon } from './agent-task-icon.js';"),
    'the shared agent-task status icon module is imported',
  );
  assert.ok(!appSource.includes('taskRunStatusGlyph'), 'the removed local glyph helper is not reintroduced');
  assert.ok(!appSource.includes('taskRunStatusLabel'), 'the removed local status-label helper is not reintroduced');
  assert.ok(body.includes('createAgentTaskStatusIcon'), 'the ledger names the delegated icon factory');

  // The delegated icon owns role/aria/title and one glyph per state.
  assert.ok(iconSource.includes("setAttribute('role', 'img')"), 'status icon exposes an img role');
  assert.ok(iconSource.includes("setAttribute('aria-label', label)"), 'status icon exposes an accessible name');
  assert.ok(iconSource.includes('icon.title = label'), 'status icon carries a title tooltip');
  for (const status of ['queued', 'running', 'done', 'interrupted', 'cancelled', 'failed']) {
    assert.ok(iconSource.includes(`'${status}'`), `status ${status} is handled by the shared icon`);
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
  const end = body.indexOf('function normalizeRunTimestamp', start);
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
  const refreshStart = appSource.indexOf('function refreshStats');
  const refreshEnd = appSource.indexOf('function refreshQuota', refreshStart);
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
});

/**
 * Runs the real taskDisplayLabel over a stubbed display-name map. The helper is
 * transpiled from the shipped source so inherited-identity and fallback
 * behaviour is executed, not merely pattern-matched.
 */
function buildTaskDisplayLabel(entries: Record<string, string>): (run: unknown) => string {
  const start = appSource.indexOf('function taskRunIdentityCandidates');
  const end = appSource.indexOf('function taskRunCell', start);
  assert.ok(start >= 0 && end > start, 'taskRunIdentityCandidates must precede taskRunCell in app.ts');
  const compiled = ts.transpileModule(appSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('taskDisplayNames',
    `${compiled}; return taskDisplayLabel;`)(new Map(Object.entries(entries)));
}

test('exact scoped task identity wins over every inherited or recorded fallback', () => {
  const label = buildTaskDisplayLabel({
    'project:gol/project:build': '精确构建',
    'project:gol:build': '继承构建',
    'builtin:build': '内置构建',
  });
  const run = {
    taskId: 'build', taskName: '构建', source: 'project', project: 'gol/project',
  };
  assert.equal(label(run), '精确构建', 'the exact project:<project>:<task> identity is authoritative');
});

test('a gol/project run inherits the gol definition, including Chinese visual/write/run labels', () => {
  const label = buildTaskDisplayLabel({
    'project:gol:visual': '可视化',
    'project:gol:write': '写作',
    'project:gol:run': '运行',
  });
  for (const [taskId, expected] of [['visual', '可视化'], ['write', '写作'], ['run', '运行']] as const) {
    const run = { taskId, taskName: taskId, source: 'project', project: 'gol/project' };
    assert.equal(label(run), expected, `gol/project:${taskId} inherits the gol definition`);
  }
  // Deeper nesting walks the whole chain, not just one level.
  const nested = buildTaskDisplayLabel({ 'project:gol:run': '运行' });
  assert.equal(
    nested({ taskId: 'run', taskName: 'run', source: 'project', project: 'gol/project/sub' }),
    '运行',
    'each final / segment is stripped until a definition is found',
  );
});

test('conflicting definitions in unrelated projects never leak into the run label', () => {
  const label = buildTaskDisplayLabel({
    'project:other:run': '其他运行',
    'project:golx:run': '前缀相近运行',
  });
  const run = { taskId: 'run', taskName: '记录的运行', source: 'project', project: 'gol' };
  assert.equal(label(run), '记录的运行', 'a sibling project definition is never a candidate');
  // A nested child project inherits from its own parent, never from a sibling
  // project that merely shares a prefix (`gol/sub` must not match `golx`).
  assert.equal(
    label({ taskId: 'run', taskName: '记录的运行', source: 'project', project: 'gol/sub' }),
    '记录的运行',
    'a sibling project sharing a prefix is not an inheritance parent',
  );
  // Stripping the final segment isolates whole project segments: the parent of
  // `gol/` is `gol`, never an empty scope that could match unrelated rows.
  assert.equal(
    label({ taskId: 'run', taskName: '记录的运行', source: 'project', project: 'gol/' }),
    '记录的运行',
    'a trailing separator does not widen the candidate chain',
  );
});

test('recorded taskName and raw taskId are ordered fallbacks that fix historical rows', () => {
  const label = buildTaskDisplayLabel({});
  // The historical regression: a row whose recorded taskName is the raw id must
  // still resolve through an inherited definition before falling back to it.
  const inherited = buildTaskDisplayLabel({ 'project:gol:run': '运行' });
  assert.equal(
    inherited({ taskId: 'run', taskName: 'run', source: 'project', project: 'gol/project' }),
    '运行',
    'an inherited definition beats a recorded name that equals the raw id',
  );

  assert.equal(
    label({ taskId: 'run', taskName: '  记录的运行  ', source: 'project', project: 'gol' }),
    '记录的运行',
    'the recorded taskName is trimmed and used on a map miss',
  );
  assert.equal(
    label({ taskId: 'run', taskName: '   ', source: 'project', project: 'gol' }),
    'run',
    'a blank recorded taskName falls through to the raw taskId',
  );
  assert.equal(
    label({ taskId: 'raw-id', source: 'project', project: 'gol' }),
    'raw-id',
    'an unknown raw id renders the exact identifier',
  );
  assert.equal(
    label({ taskId: 'build', taskName: '构建', source: 'builtin' }),
    '构建',
    'builtin rows never resolve through a project identity but keep their recorded name',
  );
  assert.equal(
    label({ taskId: 'build', taskName: 'build', source: 'builtin' }),
    'build',
    'a builtin row with no definition and no distinct name keeps the raw id',
  );
});

test('builtin identity stays distinct from project identities of the same task name', () => {
  const label = buildTaskDisplayLabel({
    'builtin:build': '内置构建',
    'project:core:build': '项目构建',
  });
  assert.equal(label({ taskId: 'build', source: 'builtin' }), '内置构建', 'builtins preserve builtin identity');
  assert.equal(
    label({ taskId: 'build', source: 'project', project: 'core' }),
    '项目构建',
    'a same-named project task keeps its own definition',
  );
  assert.equal(
    label({ taskId: 'build', source: 'unknown', project: 'core' }),
    'build',
    'an unknown source has no authoritative identity',
  );
});

test('recent-run ledger panel is plain markup with wrapping seven-column styles', () => {
  // index.html: the panel keeps only its title and simplified table; the
  // reference-cost disclaimer/legend is gone.
  assert.ok(htmlSource.includes('近期任务消耗'), 'panel title remains');
  assert.ok(htmlSource.includes('id="stats-task-runs-list"'), 'panel table remains');
  assert.ok(!htmlSource.includes('参考费用为估算，非账单'), 'reference-cost disclaimer legend is removed');

  // app.css: seven-column grid with the completion-time track last, a 2fr model
  // track that gets the remaining room, and compact fixed-ish telemetry tracks.
  const gridMatch = cssSource.match(/#stats-task-runs-list \.table-row \{ grid-template-columns: ([^;]+);/);
  assert.ok(gridMatch, 'seven-column grid for the ledger rows');
  const tracks = gridMatch[1].trim().split(/\s+(?![^(]*\))/);
  assert.equal(tracks.length, 7, 'the ledger grid declares exactly seven tracks');
  assert.equal(tracks[0], '34px', 'status icon column stays compact');
  assert.equal(tracks[2], 'minmax(0, 2fr)', 'the model column keeps the flexible 2fr track');
  // Only the model track may claim appreciable flexible room; every other
  // track is fixed or capped at a sub-unit fraction so the model keeps the rest.
  for (const [index, track] of tracks.entries()) {
    if (index === 2) continue;
    const fraction = track.match(/([\d.]+)fr/)?.[1];
    assert.ok(fraction === undefined || Number(fraction) <= 0.8, `track ${track} must not compete with the model column`);
  }
  assert.ok(
    tracks.slice(3).every((track) => /^\d+px$/.test(track) || /^minmax\(\d+px, \.?[0-8]fr\)$/.test(track)),
    'token, speed, duration and completion tracks stay compact',
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

test('ledger model cell keeps brand icons unshrunk and lets paired names wrap untruncated', () => {
  // Scoped overrides: the base model rules must not clip the ledger's paired names.
  for (const rule of [
    '#stats-task-runs-list .task-run-model-name { text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }',
    '#stats-task-runs-list .task-run-model-brand { flex: 0 1 auto; }',
  ]) {
    assert.ok(cssSource.includes(rule), `ledger override present: ${rule}`);
  }
  assert.ok(
    !cssSource.includes('#stats-task-runs-list .table-row > .task-run-model { overflow: hidden; white-space: nowrap; }'),
    'the old nowrap model override is gone',
  );
  // Brand icons stay aligned at the top of their wrapped label and keep size.
  assert.ok(
    cssSource.includes('.task-run-model-brand .model-brand-icon { display: block; width: 16px; height: 16px; flex: 0 0 16px; align-self: flex-start; }'),
    'brand icons keep their size and align to the first line of a wrapped label',
  );
  assert.ok(cssSource.includes('.task-run-model { display: inline-flex; align-items: center; flex-wrap: wrap;'),
    'brand groups wrap instead of being clipped');
});

test('routing toolbar picker keeps a practical trigger width and wraps option labels inside the viewport', () => {
  assert.ok(
    cssSource.includes('.routing-test-toolbar .single-select { flex: 0 1 320px; min-width: 180px; }'),
    'the toolbar picker keeps a practical width with shrink protection',
  );
  assert.ok(
    cssSource.includes('.routing-test-toolbar .single-select-popup { right: 0; left: auto; width: max-content; min-width: min(320px, calc(100vw - 48px)); max-width: min(520px, calc(100vw - 48px)); }'),
    'the picker popup is right anchored and viewport clamped',
  );
  assert.ok(
    cssSource.includes('.routing-test-toolbar .single-select-option-label { flex: 1 1 auto; white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; }'),
    'option labels wrap naturally instead of ellipsizing',
  );
  assert.ok(
    cssSource.includes('.routing-test-toolbar .single-select-option-secondary { flex: 1 1 100%; white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; }'),
    'option secondary text wraps onto its own line',
  );
  // Narrow behaviour stays usable: the picker takes its own full row.
  assert.ok(
    cssSource.includes('.routing-test-toolbar .single-select { flex: 1 1 100%; min-width: 0; }'),
    'narrow screens give the picker a full row instead of clipping it',
  );
});

test('recent-run ledger model cell renders paired Catalog display labels joined by a middle dot only', () => {
  const start = appSource.indexOf('function taskRunModelLabel');
  const end = appSource.indexOf('function taskRunCompletionTimeCell', start);
  assert.ok(start >= 0 && end > start, 'model label helper must precede taskRunModelCell in app.ts');
  const body = appSource.slice(start, end);

  assert.ok(
    body.includes('function taskRunModelLabel(run: TaskRunSnapshot): string | null {'),
    'paired display labels are resolved through a reusable helper',
  );
  // Only the two paired server-provided display-name fields feed the label.
  assert.ok(body.includes('run.resolvedProviderDisplayName'), 'provider display label is read from the run row');
  assert.ok(body.includes('run.resolvedModelDisplayName'), 'model display label is read from the run row');
  // Both labels are rendered as one label joined by a middle dot.
  assert.ok(body.includes(' · '), 'paired display names are joined by a middle dot');
  // A missing half or an alias-only history row renders the dash placeholder.
  assert.ok(body.includes('return null;'), 'incomplete display pair remains unknown');
  assert.ok(body.includes("taskRunCell(label ?? '-')"), 'model cell renders the dash placeholder');

  // The provider and model display names are the only resolved fields consumed
  // by the label helper; raw resolved ids/profiles/clients never feed it.
  const labelStart = body.indexOf('function taskRunModelLabel');
  const labelEnd = body.indexOf('function taskRunModelCell', labelStart);
  assert.ok(labelStart >= 0 && labelEnd > labelStart, 'the label helper body is delimited');
  const labelBody = body.slice(labelStart, labelEnd);
  const runReferences = labelBody.match(/run\.resolved[A-Za-z_$]*/g) ?? [];
  assert.ok(runReferences.length > 0, 'model cell reads the paired resolved display labels');
  for (const reference of runReferences) {
    assert.ok(
      reference === 'run.resolvedProviderDisplayName' || reference === 'run.resolvedModelDisplayName',
      `raw resolved identity reference ${reference} must not feed the model label`,
    );
  }

  // Brand cells: each half renders its own named brand span inside the cell.
  const cellStart = body.indexOf('function taskRunModelCell');
  const cellBody = body.slice(cellStart);
  assert.ok(cellBody.includes("cell.className = 'task-run-model';"), 'the cell carries the model cell class');
  assert.ok(cellBody.includes("part.className = 'task-run-model-brand';"), 'each paired label is its own brand span');
  assert.ok(cellBody.includes("text.className = 'task-run-model-name';"), 'each brand span holds a named model part');
  assert.ok(cellBody.includes("cell.append(document.createTextNode('·'));"), 'the two brand cells are separated by a middle dot');
  // Two call sites (provider, model) plus the one helper declaration.
  const appendBrandCalls = (cellBody.match(/appendBrand\((?!name: string)/g) ?? []).length;
  assert.equal(appendBrandCalls, 2, 'provider and model are both appended as brand cells');
  assert.ok(cellBody.includes('appendBrand(run.resolvedProviderDisplayName!'), 'the provider label is appended first');
  assert.ok(cellBody.includes('appendBrand(run.resolvedModelDisplayName!'), 'the model label is appended after the dot');
});

test('model statistics renders server-provided model display name with provider tooltip only', () => {
  assert.ok(htmlSource.includes('<h2 id="profile-title">模型统计</h2>'), 'card heading is 模型统计');
  const renderStart = appSource.indexOf('function renderProfiles');
  const renderEnd = appSource.indexOf('function renderTasks', renderStart);
  const renderBody = appSource.slice(renderStart, renderEnd);
  assert.ok(renderBody.includes("tableHeader(['模型', '运行', 'Token', 'TPS'])"), 'first column is 模型');
  assert.ok(renderBody.includes("emptyRow('暂无模型统计')"), 'empty state names model statistics');
  // First cell reads only the server-provided display name; no raw ids.
  assert.ok(renderBody.includes('modelDisplayName'), 'model statistics reads the server model display name');
  assert.ok(!renderBody.includes("row.name,"), 'raw profile/model identity never feeds the visible first cell');
  assert.ok(renderBody.includes("'-'"), 'absent display name renders a dash');
  // Provider display names appear only as a concise tooltip, never in main text.
  assert.ok(renderBody.includes('提供方：'), 'provider display names are exposed as a concise tooltip');
  // No fuzzy recent-ledger mapping remains.
  assert.ok(!renderBody.includes('recentTaskRuns'), 'model statistics no longer scans recentTaskRuns');
  assert.ok(!renderBody.includes('resolvedProfile'), 'model statistics never uses resolvedProfile prefix matching');
  assert.ok(!appSource.includes('function modelStatsLabel'), 'temporary modelStatsLabel helper is removed');

  // recent Task rows still render the paired Provider · Model display names, unchanged.
  const ledger = ledgerRegion();
  assert.ok(ledger.includes('function taskRunModelLabel(run: TaskRunSnapshot): string | null {'), 'paired display labels helper exists');
  assert.ok(ledger.includes(' · '), 'paired display names are joined by a middle dot');
});

test('ledger status, header and telemetry invariants hold together', () => {
  const body = ledgerRegion();
  // Seven headers, one status cell and six data cells per run: exactly seven
  // appends inside the single row builder.
  const renderStart = body.indexOf('function renderTaskRuns');
  const renderBody = body.slice(renderStart);
  const appendBlock = renderBody.slice(renderBody.indexOf('row.append('), renderBody.indexOf(');', renderBody.indexOf('row.append(')));
  for (const cell of [
    'taskRunStatusCell(run)',
    'taskRunCell(taskDisplayLabel(run))',
    'taskRunModelCell(run)',
    'taskRunCell(`${inputTokens} / ${outputTokens}`)',
    'taskRunCell(speedLabel)',
    'taskRunDurationCell(run)',
    'taskRunCompletionTimeCell(run)',
  ]) {
    assert.ok(appendBlock.includes(cell), `row builder appends ${cell}`);
  }
  // Speed is a terminal-only value; active rows keep the dash.
  assert.ok(renderBody.includes("? '-'") && renderBody.includes('run.usage.outputTps.toFixed(2)'),
    'speed renders only from a terminal outputTps measurement');
});

test('duration cells use total wall time and reject incomplete or reversed timestamps', () => {
  const start = appSource.indexOf('function formatRunDurationSeconds');
  const end = appSource.indexOf('function renderTaskRuns', start);
  const compiled = ts.transpileModule(appSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const now = Date.parse('2026-09-14T04:00:10Z');
  class FixedDate extends Date { static now() { return now; } }
  // The slice spans the compact formatter, the timestamp guard and the duration
  // cell, so the compiled region is evaluated whole and the cell returned.
  const cell = new Function('taskRunCell', 'Date',
    `${compiled}; return taskRunDurationCell;`)((value: string) => value, FixedDate);
  const run = { startedAt: '2026-09-14T04:00:00Z', finishedAt: '2026-09-14T04:00:05Z',
    usage: { generationMs: 1 } };
  for (const status of ['done', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(cell({ ...run, status }), '5s');
    assert.equal(cell({ ...run, status, finishedAt: undefined }), '-');
  }
  assert.equal(cell({ ...run, status: 'running' }), '10s');
  assert.equal(cell({ ...run, status: 'queued' }), '-');
  assert.equal(cell({ ...run }), '-');
  assert.equal(cell({ ...run, status: 'done', startedAt: 'invalid' }), '-');
  assert.equal(cell({ ...run, status: 'done', startedAt: run.finishedAt }), '0ms');
  assert.equal(cell({ ...run, status: 'done', finishedAt: '2026-09-14T03:00:00Z' }), '-');
  assert.equal(cell({ ...run, status: 'done', startedAt: '2026-09-14T03:59:00Z' }), '1m 5s');
});
