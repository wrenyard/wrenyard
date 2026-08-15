import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dismissBroadcastLocally } from '../../src/features/house/broadcast-dismiss';
import { readBrowserViewport } from '../../src/overlay/viewport';

const rootDir = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(rootDir, rel), 'utf8');
}

function indexOfRequired(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, needle).toBeGreaterThanOrEqual(0);
  return index;
}

function expectEarlyUpdateBufferContract(
  rel: string,
  subscription: 'onHouseUpdate' | 'onWorkerUpdate',
  buffer: 'latestHouseState' | 'latestWorkerState',
  stateType: 'HouseRendererState' | 'WorkerRendererState',
  presenter: 'HousePresenter' | 'WorkerPresenter',
  apply: 'applyHouseState' | 'applyWorkerState',
): void {
  const source = read(rel);
  const subscriptionIndex = indexOfRequired(source, `window.petApi.${subscription}((state) => {`);
  const firstCreateSurfaceAwaitIndex = indexOfRequired(source, 'await createRenderSurface');
  const presenterIndex = indexOfRequired(source, `new ${presenter}(surface)`);
  const applyAssignmentIndex = indexOfRequired(source, `${apply} = (state, nowMs = Date.now()): void => {`);
  const replayIndex = indexOfRequired(source, `if (${buffer}) {`);

  expect(subscriptionIndex).toBeLessThan(firstCreateSurfaceAwaitIndex);
  expect(source).toContain(`let ${buffer}: ${stateType} | undefined;`);
  expect(source).toContain(`${buffer} = state;`);
  expect(source).toContain(`${apply}?.(state);`);
  expect(applyAssignmentIndex).toBeGreaterThan(presenterIndex);
  expect(replayIndex).toBeGreaterThan(presenterIndex);
  expect(source.slice(replayIndex, replayIndex + 140)).toContain(`${apply}(${buffer}, staticPreview?.initNowMs);`);
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
    expect(read('src/overlay/viewport.ts')).not.toContain('scaleFactor');
    expect(read('src/overlay/house/index.ts')).toContain('readBrowserViewport(window)');
    expect(read('src/overlay/worker/index.ts')).toContain('readBrowserViewport(window)');
  });

  it('builds production renderer bundles from overlay entries and copies overlay HTML via dedicated copy script', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['build:renderer']).toContain('src/overlay/house/index.ts');
    expect(pkg.scripts['build:renderer']).toContain('src/overlay/worker/index.ts');
    expect(pkg.scripts['build:renderer']).toContain('dist/renderer/house.js');
    expect(pkg.scripts['build:renderer']).toContain('dist/renderer/worker.js');
    expect(pkg.scripts['build:renderer']).toContain('node tools/copy-renderer-assets.mjs');

    const copyScript = read('tools/copy-renderer-assets.mjs');
    expect(copyScript).toContain('house.html');
    expect(copyScript).toContain('worker.html');
    expect(copyScript).toContain('stats.html');
    expect(copyScript).toContain('settings.html');
    expect(copyScript).toContain('panel.css');

    const rendererConfig = read('tsconfig.renderer.json');
    expect(rendererConfig).toContain('"src/overlay/**/*"');
    expect(rendererConfig).toContain('"src/features/**/*"');
  });

  it('references same-directory panel CSS and JS in production HTML and defines drag/no-drag regions in panel.css', () => {
    const settingsHtml = read('dist/renderer/settings.html');
    const statsHtml = read('dist/renderer/stats.html');
    const panelCss = read('dist/renderer/panel.css');

    expect(settingsHtml).toContain('./panel.css');
    expect(settingsHtml).toContain('./settings.js');
    expect(settingsHtml).not.toMatch(/\.\.\//);

    expect(statsHtml).toContain('./panel.css');
    expect(statsHtml).toContain('./stats.js');
    expect(statsHtml).not.toMatch(/\.\.\//);

    expect(panelCss).toContain('-webkit-app-region: drag');
    expect(panelCss).toContain('-webkit-app-region: no-drag');
  });

  it('keeps the transparent Work Slip free of the shared panel outer border', () => {
    const transcriptHtml = read('src/panels/transcript/index.html');
    const transparentWindowRule = transcriptHtml.match(/html, body\s*\{[^}]+\}/)?.[0] ?? '';

    expect(transcriptHtml).toContain('panel.css');
    expect(transparentWindowRule).toContain('background: transparent');
    expect(transparentWindowRule).toContain('border: 0');
    expect(transparentWindowRule).toContain('border-radius: 0');
    expect(transparentWindowRule).toContain('outline: 0');
  });

  it('keeps Wren placement defaults on the same root element updated at runtime', () => {
    const entityHtml = read('src/overlay/taskgraph-entity/index.html');
    const entityRenderer = read('src/overlay/taskgraph-entity/index.ts');

    expect(entityHtml).toContain(':root{--bird-x:0px;--bird-y:0px;--tip-y:66px}');
    expect(entityHtml).not.toMatch(/html,body\{[^}]*--bird-x/);
    expect(entityRenderer).toContain("document.documentElement");
    expect(entityRenderer).toContain("setProperty('--bird-x'");
  });

  it('keeps broadcast close dismissal local and preserves the dismissed id', () => {
    const state = {
      scale: 5,
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

  it('registers initial overlay update subscriptions before awaiting renderer setup', () => {
    expectEarlyUpdateBufferContract(
      'src/overlay/house/index.ts',
      'onHouseUpdate',
      'latestHouseState',
      'HouseRendererState',
      'HousePresenter',
      'applyHouseState',
    );
    expectEarlyUpdateBufferContract(
      'src/overlay/worker/index.ts',
      'onWorkerUpdate',
      'latestWorkerState',
      'WorkerRendererState',
      'WorkerPresenter',
      'applyWorkerState',
    );
  });

  it('requires settings and stats DOM buttons as distinct hit targets aligned to scene output', () => {
    const source = read('src/overlay/house/index.ts');
    const html = read('src/overlay/house/index.html');
    // Both buttons must exist in the overlay entry
    expect(source).toContain("document.getElementById('settings-btn')");
    expect(source).toContain("document.getElementById('stats-btn')");
    // Buttons must have data-action values for delegation
    expect(html).toMatch(/data-action=["']settings["']/);
    expect(html).toMatch(/data-action=["']stats["']/);
    // Buttons must be pointer-event enabled (.action-btn class)
    expect(html).toMatch(/class=["']action-btn["']/);
    // Buttons must be positioned from scene output (houseRect-based positions)
    expect(source).toMatch(/output\??\.settingsBtn\b/);
    expect(source).toMatch(/output\??\.statsBtn\b/);
  });

  it('requires bindActionButtons to be called exactly once and disposed on cleanup', () => {
    const source = read('src/overlay/house/index.ts');
    // Must import bindActionButtons
    expect(source).toContain("bindActionButtons");
    // Must be called exactly once in the main function
    const matches = source.match(/bindActionButtons\(/g);
    const callCount = matches ? matches.length : 0;
    expect(callCount, 'bindActionButtons must be called exactly once').toBe(1);
    // The dispose return value must be registered
    expect(source).toContain('disposables.push(disposeActionButtons)');
    // Must be disposed before presenter/surface destroy
    const disposeIndex = source.indexOf('disposables.push(disposeActionButtons)');
    const presenterDestroyIndex = source.indexOf('presenter.destroy()');
    expect(disposeIndex).toBeLessThan(presenterDestroyIndex);
  });

  it('forwards button clicks to PetApi openSettings and openStats', () => {
    const source = read('src/features/house/interaction.ts');
    // The click handler delegate must call the PetApi methods
    expect(source).toContain('api.openSettings()');
    expect(source).toContain('api.openStats()');
  });

  it('forbids hover-target setOnAction/onAction as action trigger mechanism', () => {
    // The action-triggering pattern must not use the presenter hover-entry callback
    for (const rel of ['src/overlay/house/index.ts', 'src/features/house/presenter.ts']) {
      const source = read(rel);
      const sourceName = rel.split('/').pop() ?? rel;
      expect(source, `${sourceName} must not use setOnAction for action trigger`).not.toContain('setOnAction');
      expect(source, `${sourceName} must not use onAction callback for action trigger`).not.toContain('onAction');
    }
  });

  it('exposes provider-agnostic quota rows with enable/reorder controls and no per-provider Login auth', () => {
    const source = read('src/panels/settings/index.ts');
    // Provider rows are provider-agnostic enabled/order controls only
    expect(source).toContain('quota-providers');
    expect(source).toContain('quota-toggle');
    expect(source).toContain('quota-btn');
    // Settings still support save/restart through the panel API
    expect(source).toContain('api?.save');
    expect(source).toContain('api?.saveAndRestart');
    // No login control, login state machine, or provider-id-specific auth branch remains
    expect(source).not.toContain('Login');
    expect(source).not.toContain('login');
    expect(source).not.toMatch(/provider\.id\s*===/);
  });

  it('keeps static preview deterministic and returns before ticker startup', () => {
    for (const rel of ['src/overlay/house/index.ts', 'src/overlay/worker/index.ts']) {
      const source = read(rel);
      expect(source).toContain('installStaticPreviewMode(window.location.search, canvas, document)');
      expect(source).toContain('resize(staticPreview?.initNowMs)');
      expect(source).toContain('renderAndSync(staticPreview.initNowMs)');
      expect(source).toContain('const output = renderAndSync(staticPreview.nowMs)');
      expect(source).toContain('staticPreview.markReady(output)');

      const staticBranch = indexOfRequired(source, 'const initPointer = staticPreview.pointer');
      const tickerStart = indexOfRequired(source, 'presenter.start(');
      expect(staticBranch).toBeLessThan(tickerStart);
      expect(source.slice(staticBranch, tickerStart)).toContain('return;');
    }
  });
});
