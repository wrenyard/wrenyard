import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dismissBroadcastLocally } from '../../../src/pet/features/house/broadcast-dismiss';
import { readBrowserViewport } from '../../../src/pet/overlay/viewport';

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
    expect(read('src/pet/overlay/viewport.ts')).not.toContain('scaleFactor');
    expect(read('src/pet/overlay/house/index.ts')).toContain('readBrowserViewport(window)');
    expect(read('src/pet/overlay/worker/index.ts')).toContain('readBrowserViewport(window)');
  });

  it('builds production Pet renderer bundles inside the Desktop build graph', () => {
    const buildScript = read('tools/build.mjs');
    expect(buildScript).toContain("['overlay/house/index.ts', 'house.js']");
    expect(buildScript).toContain("['overlay/worker/index.ts', 'worker.js']");
    expect(buildScript).toContain("['overlay/taskgraph-entity/index.ts', 'entity.js']");
    expect(buildScript).toContain("['panels/transcript/index.ts', 'transcript.js']");
    expect(buildScript).toContain("['panels/observatory/index.ts', 'graph-slip.js']");
    expect(buildScript).toContain("join(dist, 'pet', 'renderer')");
    expect(buildScript).toContain("join(dist, 'pet', 'preloads')");
    // The Pet module is built from this checkout: no Pet-app dist is copied.
    expect(buildScript).not.toContain('petRoot');
    // Retired renderer assets are removed so an incremental build cannot keep them.
    expect(buildScript).toContain("['settings.html', 'settings.js', 'stats.html', 'stats.js', 'panel.css']");

    const tsconfig = read('tsconfig.json');
    expect(tsconfig).toContain('"src/**/*.ts"');
  });

  it('keeps the transparent Work Slip free of the shared panel outer border', () => {
    const transcriptHtml = read('src/pet/panels/transcript/index.html');
    const transparentWindowRule = transcriptHtml.match(/html, body\s*\{[^}]+\}/)?.[0] ?? '';

    expect(transcriptHtml).not.toContain('panel.css');
    expect(transparentWindowRule).toContain('background: transparent');
    expect(transparentWindowRule).toContain('border: 0');
    expect(transparentWindowRule).toContain('border-radius: 0');
    expect(transparentWindowRule).toContain('outline: 0');
  });

  it('keeps Wren placement defaults on the same root element updated at runtime', () => {
    const entityHtml = read('src/pet/overlay/taskgraph-entity/index.html');
    const entityRenderer = read('src/pet/overlay/taskgraph-entity/index.ts');

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
      'src/pet/overlay/house/index.ts',
      'onHouseUpdate',
      'latestHouseState',
      'HouseRendererState',
      'HousePresenter',
      'applyHouseState',
    );
    expectEarlyUpdateBufferContract(
      'src/pet/overlay/worker/index.ts',
      'onWorkerUpdate',
      'latestWorkerState',
      'WorkerRendererState',
      'WorkerPresenter',
      'applyWorkerState',
    );
  });

  it('keeps the house overlay free of settings and statistics actions', () => {
    const source = read('src/pet/overlay/house/index.ts');
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
    // The action-triggering pattern must not use the presenter hover-entry callback
    for (const rel of ['src/pet/overlay/house/index.ts', 'src/pet/features/house/presenter.ts']) {
      const source = read(rel);
      const sourceName = rel.split('/').pop() ?? rel;
      expect(source, `${sourceName} must not use setOnAction for action trigger`).not.toContain('setOnAction');
      expect(source, `${sourceName} must not use onAction callback for action trigger`).not.toContain('onAction');
    }
  });

  it('keeps static preview deterministic and returns before ticker startup', () => {
    for (const rel of ['src/pet/overlay/house/index.ts', 'src/pet/overlay/worker/index.ts']) {
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
