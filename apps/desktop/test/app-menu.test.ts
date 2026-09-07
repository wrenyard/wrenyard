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

test('macOS menu binds a native Close Window command to Cmd+W', () => {
  const template = desktopMenuTemplate('darwin', () => undefined);
  const closeItems = template
    .flatMap((item) => (Array.isArray(item.submenu) ? item.submenu : []))
    .filter((item) => item.role === 'close');
  assert.equal(closeItems.length, 1);
  assert.equal(closeItems[0].label, '关闭窗口');
  assert.equal(closeItems[0].accelerator, 'CmdOrCtrl+W');
});

test('Cmd+W close binding is macOS-only and existing menus stay intact', () => {
  const mac = desktopMenuTemplate('darwin', () => undefined);
  const win = desktopMenuTemplate('win32', () => undefined);

  assert.equal(mac[0]?.role, 'appMenu');
  assert.equal(win[0]?.role, 'fileMenu');
  assert.deepEqual(
    mac.slice(2).map((item) => item.role),
    ['editMenu', 'viewMenu', 'windowMenu', 'help'],
  );
  assert.ok(!win.some((item) => item.role === 'close'), 'Windows must not get the macOS-only close binding');

  const help = mac.find((item) => item.role === 'help');
  assert.ok(help && Array.isArray(help.submenu));
  assert.equal(help.submenu.length, 1);
  assert.equal(help.submenu[0].accelerator, 'CmdOrCtrl+Shift+U');
});

test('macOS Quit command reports accelerator-vs-direct origin through requestQuit', () => {
  const origins: string[] = [];
  const requestQuit = (origin: 'accelerator' | 'direct') => { origins.push(origin); };
  const quitTemplate = desktopMenuTemplate as unknown as (
    platform: string,
    onInvoke: () => void,
    requestQuit: (origin: 'accelerator' | 'direct') => void,
  ) => ReturnType<typeof desktopMenuTemplate>;
  const template = quitTemplate('darwin', () => undefined, requestQuit);

  const quitItems = template
    .flatMap((item) => (Array.isArray(item.submenu) ? item.submenu : []))
    .filter((item) => item.accelerator === 'CmdOrCtrl+Q');
  assert.equal(quitItems.length, 1, 'macOS app menu must wire exactly one Quit item through requestQuit');

  const quit = quitItems[0];
  assert.ok(quit, 'Quit item must be present in the macOS app menu');
  assert.equal(quit?.role, undefined, 'a native quit role would bypass the custom Cmd+Q gate');
  assert.equal(quit?.label, '退出啾啾工坊');
  if (quit && 'click' in quit && typeof quit.click === 'function') {
    quit.click({} as never, {} as never, { triggeredByAccelerator: true } as never);
    quit.click({} as never, {} as never, { triggeredByAccelerator: false } as never);
  }
  assert.deepEqual(origins, ['accelerator', 'direct'], 'Cmd+Q accelerators report accelerator; menu/mouse Quit reports direct');

  const closeItems = template
    .flatMap((item) => (Array.isArray(item.submenu) ? item.submenu : []))
    .filter((item) => item.role === 'close');
  assert.equal(closeItems.length, 1, 'Cmd+W close binding must stay intact alongside the quit wiring');
  assert.equal(closeItems[0].accelerator, 'CmdOrCtrl+W');
});
