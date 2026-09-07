import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMacQuitConfirmationGate,
  trayPrimaryClickOpensDesktop,
} from '../src/desktop-interaction-policy.js';

test('trayPrimaryClickOpensDesktop is false on darwin and true on win32 and linux', () => {
  assert.equal(trayPrimaryClickOpensDesktop('darwin'), false);
  assert.equal(trayPrimaryClickOpensDesktop('win32'), true);
  assert.equal(trayPrimaryClickOpensDesktop('linux'), true);
});

test('Cmd+Q gate warns on the first accelerator request and quits on a second one inside the window', () => {
  const gate = createMacQuitConfirmationGate({ windowMs: 3000 });
  assert.equal(gate('accelerator', 1000), 'warn');
  assert.equal(gate('accelerator', 3999), 'quit');
});

test('Cmd+Q gate warns again once the previous accelerator request has expired', () => {
  const gate = createMacQuitConfirmationGate({ windowMs: 3000 });
  assert.equal(gate('accelerator', 1000), 'warn');
  assert.equal(gate('accelerator', 5000), 'warn');
});

test('Cmd+Q gate always quits on direct requests and re-arms so the next accelerator warns', () => {
  const gate = createMacQuitConfirmationGate({ windowMs: 3000 });
  assert.equal(gate('direct', 0), 'quit');
  assert.equal(gate('accelerator', 1000), 'warn');
  assert.equal(gate('direct', 1001), 'quit');
  assert.equal(gate('accelerator', 1002), 'warn');
});
