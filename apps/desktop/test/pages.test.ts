import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { createPageLoader, preloadPath } from '../src/pages.js';

function fakeWindow(calls: unknown[][]): BrowserWindow {
  return {
    loadFile(path: string, options?: { query?: Record<string, string> }) {
      calls.push(['file', path, options]);
      return Promise.resolve();
    },
    loadURL(url: string) {
      calls.push(['url', url]);
      return Promise.resolve();
    },
  } as unknown as BrowserWindow;
}

test('a packaged build ignores ELECTRON_RENDERER_URL and loads the built page', async () => {
  const calls: unknown[][] = [];
  const win = fakeWindow(calls);
  const loader = createPageLoader({
    appPath: '/app',
    packaged: true,
    env: { ELECTRON_RENDERER_URL: 'http://127.0.0.1:5199' },
  });

  await loader.load(win, 'shell');

  const indexPath = join('/app', 'dist', 'web', 'renderer', 'index.html');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'file');
  assert.equal(calls[0][1], indexPath);
  assert.deepEqual(calls[0][2], { query: undefined });
  assert.equal(loader.url('shell'), pathToFileURL(indexPath).href);
});

test('an unpackaged dev server serves overlay pages with query strings', async () => {
  const calls: unknown[][] = [];
  const win = fakeWindow(calls);
  const loader = createPageLoader({
    appPath: '/app',
    packaged: false,
    env: { ELECTRON_RENDERER_URL: 'http://127.0.0.1:5199/' },
  });

  await loader.load(win, 'house');
  assert.deepEqual(calls[0], ['url', 'http://127.0.0.1:5199/pet/overlay/house/index.html']);

  calls.length = 0;
  await loader.load(win, 'entity', { taskgraph: 'g1' });
  assert.deepEqual(calls[0], [
    'url',
    'http://127.0.0.1:5199/pet/overlay/taskgraph-entity/index.html?taskgraph=g1',
  ]);

  assert.equal(loader.url('shell'), 'http://127.0.0.1:5199/renderer/index.html');
});

test('a non-loopback renderer URL is ignored', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const calls: unknown[][] = [];
    const win = fakeWindow(calls);
    const loader = createPageLoader({
      appPath: '/app',
      packaged: false,
      env: { ELECTRON_RENDERER_URL: 'http://example.com:5199' },
    });

    await loader.load(win, 'shell');

    assert.equal(calls[0][0], 'file');
    assert.equal(calls[0][1], join('/app', 'dist', 'web', 'renderer', 'index.html'));
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('without a dev server, files load and the query passes through unchanged', async () => {
  const calls: unknown[][] = [];
  const win = fakeWindow(calls);
  const loader = createPageLoader({ appPath: '/app', packaged: false, env: {} });

  await loader.load(win, 'transcript', { task: 't1' });

  assert.deepEqual(calls[0], [
    'file',
    join('/app', 'dist', 'web', 'pet/panels/transcript/index.html'),
    { query: { task: 't1' } },
  ]);
});

test('preloadPath resolves the built preload bundle', () => {
  assert.equal(preloadPath('/app', 'transcript'), join('/app', 'dist', 'preload', 'transcript.cjs'));
});
