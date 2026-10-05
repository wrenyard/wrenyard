import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TaskDefinitionInheritanceLayer, TaskSettingsTaskRow } from '../src/shell-contract.js';
import { INHERITANCE_TITLE, inheritanceLayerLabel } from '../src/renderer/pages/tasks/model/describe.js';
import { WORKSPACE_TEMPLATE_FILES } from '../src/workspace-template.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('shell contract carries read-only inheritance metadata on task setting rows', () => {
  const metadata: Pick<TaskSettingsTaskRow, 'inheritanceChain'> = {
    inheritanceChain: [
      { source: 'builtin', path: '/tasks/shell/deploy.task.ts' },
      { source: 'project', project: 'acme', path: '/projects/acme/deploy.task.ts' },
    ],
  };
  assert.deepEqual(metadata.inheritanceChain?.map((layer) => layer.source), ['builtin', 'project']);
  assert.equal(metadata.inheritanceChain?.[1]?.project, 'acme');

  // Missing metadata stays valid and is distinguishable from an inherited row.
  const absent: Pick<TaskSettingsTaskRow, 'inheritanceChain'> = {};
  assert.equal(absent.inheritanceChain, undefined);
});

test('inheritance layer labels show 内置 or the exact project id', () => {
  const builtin: TaskDefinitionInheritanceLayer = { source: 'builtin', path: '/tasks/base.task.ts' };
  const project: TaskDefinitionInheritanceLayer = { source: 'project', project: 'acme', path: '/tasks/acme.task.ts' };
  const projectWithoutId: TaskDefinitionInheritanceLayer = { source: 'project', path: '/tasks/anon.task.ts' };

  assert.equal(INHERITANCE_TITLE, '定义继承链');
  assert.equal(inheritanceLayerLabel(builtin), '内置');
  assert.equal(inheritanceLayerLabel(project), 'acme');
  // Robust fallback when a project layer omits its id.
  assert.equal(inheritanceLayerLabel(projectWithoutId), '项目');
});

test('TaskDetail renders a read-only inheritance chain only when inherited', () => {
  const source = readFileSync(
    join(desktopRoot, 'src', 'renderer', 'pages', 'tasks', 'components', 'TaskDetail.tsx'),
    'utf8',
  );
  // The chain renders only from daemon metadata, with a missing-metadata fallback to nothing.
  assert.match(source, /row\.inheritanceChain \?\? \[\]/);
  assert.match(source, /inheritanceChain\.length > 0 \?/);
  assert.match(source, /copy\.INHERITANCE_TITLE/);
  assert.match(source, /copy\.inheritanceLayerLabel\(layer\)/);
  // Each layer shows the file path with a break-word style.
  assert.match(source, /break-words/);
  assert.match(source, /\{layer\.path\}/);

  // The inheritance section carries no editor or settings control.
  const start = source.indexOf('copy.INHERITANCE_TITLE');
  const end = source.indexOf('copy.PREVIEW_TITLE');
  assert.ok(start >= 0 && end > start, 'the inheritance card must precede the preview card');
  const section = source.slice(start, end);
  assert.doesNotMatch(section, /<Input|<Select|<Combobox|<Button|onChange|onCommit/);
});

test('workspace template guidance documents inheritance authoring', () => {
  const tasks = WORKSPACE_TEMPLATE_FILES['instructions/tasks.md'];
  assert.ok(tasks, 'instructions/tasks.md must be generated');
  // Guidance names a real base task id, not the abstract same-id literal.
  assert.match(tasks, /edit\.task\.ts/);
  assert.match(tasks, /extends: 'edit'/);
  assert.match(tasks, /promptAppend/);
  assert.match(tasks, /writeTargets/);
  assert.match(tasks, /intelligenceMin/);
  assert.match(tasks, /requiredCapabilities is the union/);
  assert.match(tasks, /complete replacement/);
});
