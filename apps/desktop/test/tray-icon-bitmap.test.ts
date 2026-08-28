import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TRAY_ICON_SCALE,
  TRAY_ICON_SIZE,
  renderTrayIconBitmap,
} from '../src/tray-icon-bitmap.js';

test('Desktop owns a non-empty 18pt three-wren template tray bitmap', () => {
  const rendered = renderTrayIconBitmap();
  assert.equal(rendered.pixelWidth, TRAY_ICON_SIZE * TRAY_ICON_SCALE);
  assert.equal(rendered.pixelHeight, TRAY_ICON_SIZE * TRAY_ICON_SCALE);
  assert.equal(rendered.buffer.length, rendered.pixelWidth * rendered.pixelHeight * 4);
  assert.ok(rendered.buffer.some((value, index) => index % 4 === 3 && value === 255));
  const alphaAt = (x: number, y: number) => rendered.buffer[(y * rendered.pixelWidth + x) * 4 + 3];
  assert.ok(alphaAt(7, 14) > 0, 'left beak is present');
  assert.ok(alphaAt(27, 10) > 0, 'middle beak is present');
  assert.ok(alphaAt(34, 14) > 0, 'right beak is present');
  assert.ok(alphaAt(18, 28) > 0, 'shared branch is present');
});
