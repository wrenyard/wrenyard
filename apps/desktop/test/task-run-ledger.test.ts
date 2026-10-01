import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskRunSnapshot, TaskSettingsSnapshot } from '../src/shell-contract.js';
import {
  buildTaskNameTables,
  HISTORICAL_TASK_NAMES,
  taskDisplayLabel,
  taskInvestmentLabel,
  taskRunIdentityCandidates,
  type TaskNameTables,
} from '../src/renderer/pages/stats/model/task-names.js';

/**
 * Model tests for the 近期任务消耗 display-name rules. The ledger renderer is a
 * React page now; the authoritative identity/inheritance/fallback behaviour
 * lives in the pure `model/task-names.ts` module and is exercised here.
 */

type Run = Pick<TaskRunSnapshot, 'taskId'> & Partial<Pick<TaskRunSnapshot, 'taskName' | 'source' | 'project'>>;
type Row = Pick<TaskSettingsSnapshot['rows'][number], 'identity' | 'name' | 'display_name'>;

function tables(rows: Row[]): TaskNameTables {
  return buildTaskNameTables({ rows } as unknown as TaskSettingsSnapshot);
}

test('exact scoped task identity wins over every inherited or recorded fallback', () => {
  const names = tables([
    { identity: 'project:gol/project:build', name: 'build', display_name: '精确构建' },
    { identity: 'project:gol:build', name: 'build', display_name: '继承构建' },
    { identity: 'builtin:build', name: 'build', display_name: '内置构建' },
  ]);
  const run: Run = { taskId: 'build', taskName: '构建', source: 'project', project: 'gol/project' };
  assert.equal(taskDisplayLabel(run, names), '精确构建', 'the exact project:<project>:<task> identity is authoritative');
});

test('a nested project run inherits every ancestor definition, walking the whole chain', () => {
  const names = tables([
    { identity: 'project:gol:visual', name: 'visual', display_name: '可视化' },
    { identity: 'project:gol:write', name: 'write', display_name: '写作' },
    { identity: 'project:gol:run', name: 'run', display_name: '运行' },
  ]);
  for (const [taskId, expected] of [['visual', '可视化'], ['write', '写作'], ['run', '运行']] as const) {
    const run: Run = { taskId, taskName: taskId, source: 'project', project: 'gol/project' };
    assert.equal(taskDisplayLabel(run, names), expected, `gol/project:${taskId} inherits the gol definition`);
  }
  const nested: Run = { taskId: 'run', taskName: 'run', source: 'project', project: 'gol/project/sub' };
  assert.equal(taskDisplayLabel(nested, names), '运行', 'each final / segment is stripped until a definition is found');
});

test('definitions in unrelated projects never leak into a run label', () => {
  const names = tables([
    { identity: 'project:other:run', name: 'run', display_name: '其他运行' },
    { identity: 'project:golx:run', name: 'run', display_name: '前缀相近运行' },
  ]);
  const sibling: Run = { taskId: 'run', taskName: '记录的运行', source: 'project', project: 'gol' };
  assert.equal(taskDisplayLabel(sibling, names), '记录的运行', 'a sibling project definition is never a candidate');
  const prefix: Run = { taskId: 'run', taskName: '记录的运行', source: 'project', project: 'gol/sub' };
  assert.equal(taskDisplayLabel(prefix, names), '记录的运行', 'a sibling sharing a prefix is not a parent');
  const trailing: Run = { taskId: 'run', taskName: '记录的运行', source: 'project', project: 'gol/' };
  assert.equal(taskDisplayLabel(trailing, names), '记录的运行', 'a trailing separator does not widen the chain');
});

test('recorded taskName and raw taskId are ordered fallbacks that fix historical rows', () => {
  const names = tables([]);
  const inherited = tables([{ identity: 'project:gol:run', name: 'run', display_name: '运行' }]);
  const historical: Run = { taskId: 'run', taskName: 'run', source: 'project', project: 'gol/project' };
  assert.equal(taskDisplayLabel(historical, inherited), '运行', 'an inherited definition beats a recorded name equal to the id');
  assert.equal(
    taskDisplayLabel({ taskId: 'run', taskName: '  记录的运行  ', source: 'project', project: 'gol' }, names),
    '记录的运行',
    'the recorded taskName is trimmed and used on a map miss',
  );
  assert.equal(
    taskDisplayLabel({ taskId: 'run', taskName: '   ', source: 'project', project: 'gol' }, names),
    'run',
    'a blank recorded taskName falls through to the raw taskId',
  );
  assert.equal(
    taskDisplayLabel({ taskId: 'raw-id', source: 'project', project: 'gol' }, names),
    'raw-id',
    'an unknown raw id renders the exact identifier',
  );
});

test('builtin identity stays distinct from project identities of the same task name', () => {
  const names = tables([
    { identity: 'builtin:build', name: 'build', display_name: '内置构建' },
    { identity: 'project:core:build', name: 'build', display_name: '项目构建' },
  ]);
  assert.equal(taskDisplayLabel({ taskId: 'build', source: 'builtin' }, names), '内置构建', 'builtins preserve builtin identity');
  assert.equal(
    taskDisplayLabel({ taskId: 'build', source: 'project', project: 'core' }, names),
    '项目构建',
    'a same-named project task keeps its own definition',
  );
  assert.equal(
    taskDisplayLabel({ taskId: 'build', source: 'unknown', project: 'core' }, names),
    'build',
    'an unknown source has no authoritative identity',
  );
});

test('identity candidates walk the project inheritance chain from the most specific scope', () => {
  assert.deepEqual(
    taskRunIdentityCandidates({ taskId: 'run', source: 'project', project: 'gol/project/sub' }),
    ['project:gol/project/sub:run', 'project:gol/project:run', 'project:gol:run'],
  );
  assert.deepEqual(taskRunIdentityCandidates({ taskId: 'build', source: 'builtin' }), ['builtin:build']);
  assert.deepEqual(taskRunIdentityCandidates({ taskId: 'build', source: 'unknown' }), []);
  assert.deepEqual(taskRunIdentityCandidates({ taskId: 'build', source: 'project' }), []);
});

test('investment labels aggregate by source and task name and drop disagreements', () => {
  const names = tables([
    { identity: 'project:a:run', name: 'run', display_name: '运行' },
    { identity: 'project:b:run', name: 'run', display_name: '另一运行' },
    { identity: 'project:a:build', name: 'build', display_name: '构建' },
  ]);
  assert.equal(names.investment.get('project:run'), undefined, 'identically named definitions that disagree are dropped');
  assert.equal(names.investment.get('project:build'), '构建', 'an unambiguous aggregate keeps the shared label');
  assert.equal(taskInvestmentLabel('project', 'build', names), '构建');
  assert.equal(taskInvestmentLabel('project', 'run', names), 'run', 'an ambiguous aggregate falls back to the raw name');
});

test('historical task names back the investment fallback', () => {
  assert.equal(HISTORICAL_TASK_NAMES['builtin:explore-code'], '代码探索');
  assert.equal(HISTORICAL_TASK_NAMES['project:retire-builtin-files'], '清理旧内置任务');
  const names = tables([]);
  assert.equal(taskInvestmentLabel('builtin', 'explore-code', names), '代码探索');
});
