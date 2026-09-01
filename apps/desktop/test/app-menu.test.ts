import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopMenuTemplate } from '../src/app-menu.js';

test('application Help menu exposes one native check-for-updates command', () => {
  let invoked = 0;
  const template = desktopMenuTemplate('darwin', () => { invoked += 1; });
  const help = template.find((item) => item.role === 'help');
  assert.ok(help && Array.isArray(help.submenu));
  assert.equal(help.submenu.length, 1);
  const update = help.submenu[0];
  assert.equal('label' in update ? update.label : undefined, '检查更新…');
  if ('click' in update && typeof update.click === 'function') update.click({} as never, {} as never, {} as never);
  assert.equal(invoked, 1);
});

test('macOS keeps the native app menu while Windows keeps the native file menu', () => {
  assert.equal(desktopMenuTemplate('darwin', () => undefined)[0]?.role, 'appMenu');
  assert.equal(desktopMenuTemplate('win32', () => undefined)[0]?.role, 'fileMenu');
});
