import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dismissBroadcastLocally } from '../../../src/pet/features/house/broadcast-dismiss';
import { readBrowserViewport } from '../../../src/pet/overlay/viewport';

const rootDir = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(rootDir, rel), 'utf8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(rootDir, rel));
}

function indexOfRequired(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, needle).toBeGreaterThanOrEqual(0);
  return index;
}

function expectEarlyUpdateBufferContract(
  rel: string,
  subscription: 'onHouseUpdate' | 'onWorkerUpdate',
  buffer: 'latestState',
  apply: 'applyState',
): void {
  const source = read(rel);
  const subscriptionIndex = indexOfRequired(source, `petApi.${subscription}((state) => {`);
  const firstCreateSurfaceAwaitIndex = indexOfRequired(source, 'await createRenderSurface');
  const bufferIndex = indexOfRequired(source, `let ${buffer}:`);
  const applyAssignmentIndex = indexOfRequired(source, `let ${apply}:`);
  const replayIndex = indexOfRequired(source, `if (${buffer}) `);

  expect(subscriptionIndex).toBeLessThan(firstCreateSurfaceAwaitIndex);
  expect(source).toContain(`${buffer} = state;`);
  expect(source).toContain(`${apply}?.(state);`);
  expect(applyAssignmentIndex).toBeGreaterThan(bufferIndex);
  expect(replayIndex).toBeGreaterThan(firstCreateSurfaceAwaitIndex);
}

describe('overlay entry contracts', () => {
  it('uses browser CSS size and devicePixelRatio only for renderer viewport', () => {
    const viewport = readBrowserViewport({
      innerWidth: 360,
      innerHeight: 460,
      devicePixelRatio: 0,
      scaleFactor: 9,
    } as any);
    expect(viewport).toEqual({ cssWidth: 360, cssHeight: 460, dpr: 1 });
    expect(read('src/pet/overlay/viewport.ts')).not.toContain('scaleFactor');
    expect(read('src/pet/overlay/house/HouseOverlay.tsx')).toContain('readBrowserViewport(window)');
    expect(read('src/pet/overlay/worker/WorkerOverlay.tsx')).toContain('readBrowserViewport(window)');
  });

  it('builds production Pet renderer bundles inside the Desktop build graph', () => {
    const config = read('electron.vite.config.ts');
    expect(config).toContain('fromSrc(DESKTOP_PRELOADS)');
    expect(config).toContain('fromSrc(DESKTOP_PAGES)');
    const pages = read('src/pet/entries.ts');
    for (const preload of [
      'pet/main/preload/index.ts', 'pet/main/preload/entity.ts',
      'pet/main/preload/graph-slip.ts', 'pet/main/preload/transcript.ts',
    ]) expect(pages).toContain(preload);
    for (const page of [
      'src/pet/overlay/house/index.html', 'src/pet/overlay/worker/index.html',
      'src/pet/overlay/entity/index.html',
    ]) expect(exists(page)).toBe(true);
    const tsconfig = JSON.parse(read('tsconfig.json'));
    expect(tsconfig.references).toEqual([{ path: './tsconfig.node.json' }, { path: './tsconfig.web.json' }]);
  });

  it('keeps the transparent Work Slip free of the shared panel outer border', () => {
    const transcriptHtml = read('src/pet/panels/transcript/index.html');
    const transparentWindowRule = transcriptHtml.match(/html, body\s*\{[^}]+\}/)?.[0] ?? '';

    expect(transcriptHtml).not.toContain('panel.css');
    expect(transparentWindowRule).toContain('border: 0');
    expect(transparentWindowRule).toContain('border-radius: 0');
    expect(transparentWindowRule).toContain('outline: 0');
  });

  it('keeps Wren placement defaults on the same root element updated at runtime', () => {
    const entityHtml = read('src/pet/overlay/entity/index.html');
    const entityOverlay = read('src/pet/overlay/entity/EntityOverlay.tsx');

    // The page only defines the transparent root; the overlay owns every Wren
    // placement variable and writes it on documentElement at runtime.
    expect(entityHtml).toContain('html,body{background:transparent}');
    expect(entityHtml).not.toMatch(/html,body\{[^}]*--bird-x/);
    expect(entityOverlay).toContain('document.documentElement');
    expect(entityOverlay).toContain("setProperty('--bird-x'");
    expect(entityOverlay).toContain("setProperty('--bird-y'");
    expect(entityOverlay).toContain("setProperty('--tip-y'");
  });

  it('keeps broadcast close dismissal local and preserves the dismissed id', () => {
    const state = {
      scale: 5,
      houseSkin: 'classic' as const,
      workers: [],
      queuedCount: 0,
      broadcast: { id: 'b1', text: 'hello', intensity: 'sticky' as const },
      dailyStats: {
        dayKey: '2026-07-10',
        startAt: '2026-07-10T00:00:00.000Z',
        endAt: '2026-07-10T23:59:59.999Z',
        dispatchCount: 1,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        source: 'sqlite' as const,
      },
    };
    const result = dismissBroadcastLocally(state);
    expect(result.id).toBe('b1');
    expect(result.state.broadcast).toBeUndefined();
    expect(result.state.dailyStats).toBe(state.dailyStats);
  });

  it('buffers initial overlay updates until the Pixi surface is ready', () => {
    expectEarlyUpdateBufferContract('src/pet/overlay/house/HouseOverlay.tsx', 'onHouseUpdate', 'latestState', 'applyState');
    expectEarlyUpdateBufferContract('src/pet/overlay/worker/WorkerOverlay.tsx', 'onWorkerUpdate', 'latestState', 'applyState');
  });

  it('mounts overlay pages through their .tsx React roots', () => {
    for (const root of [
      'src/pet/overlay/house/index.tsx',
      'src/pet/overlay/worker/index.tsx',
      'src/pet/overlay/entity/index.tsx',
    ]) {
      const source = read(root);
      expect(source).toContain('createRoot(container).render');
      expect(source).toContain('await initializePetAppearance()');
      expect(source).toContain('petAppearanceBridge');
      expect(source).toContain("from '@/renderer/globals.css'");
    }
  });

  it('keeps the house overlay free of settings and statistics actions', () => {
    const source = read('src/pet/overlay/house/HouseOverlay.tsx');
    const html = read('src/pet/overlay/house/index.html');
    expect(source).not.toContain('bindActionButtons');
    expect(source).not.toContain('settingsButton');
    expect(source).not.toContain('statsButton');
    expect(html).not.toContain('action-btn');
    expect(html).not.toContain('data-action');
    expect(html).not.toContain('settings-btn');
    expect(html).not.toContain('stats-btn');
  });

  it('forbids hover-target setOnAction/onAction as action trigger mechanism', () => {
    for (const rel of ['src/pet/overlay/house/HouseOverlay.tsx', 'src/pet/features/house/presenter.ts']) {
      const source = read(rel);
      const sourceName = rel.split('/').pop() ?? rel;
      expect(source, `${sourceName} must not use setOnAction for action trigger`).not.toContain('setOnAction');
      expect(source, `${sourceName} must not use onAction callback for action trigger`).not.toContain('onAction');
    }
  });

  it('keeps static preview deterministic and returns before ticker startup', () => {
    for (const rel of ['src/pet/overlay/house/HouseOverlay.tsx', 'src/pet/overlay/worker/WorkerOverlay.tsx']) {
      const source = read(rel);
      expect(source).toContain('installStaticPreviewMode(window.location.search, canvas, document)');
      expect(source).toContain('renderFrame(mode.initNowMs)');
      expect(source).toContain('renderFrame(mode.nowMs)');
      expect(source).toContain('mode.markReady(');

      const staticBranch = indexOfRequired(source, 'if (mode) {');
      const tickerStart = indexOfRequired(source, 'presenter.start(');
      expect(staticBranch).toBeLessThan(tickerStart);
      expect(source.slice(staticBranch, tickerStart)).toContain('return;');
    }
  });
});
