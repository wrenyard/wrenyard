import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RenderTextStyle, ShapeCommand } from '../src/render';

const rootDir = process.cwd();

type MockMeasure = (text: string, style: RenderTextStyle | undefined) => { width: number; height: number };

function defaultMeasure(text: string, style: RenderTextStyle | undefined) {
  const lineWidths = text.split('\n').map((line) => Array.from(line).reduce((sum, ch) => {
    if (/\s/.test(ch)) return sum + 3;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x1f300) return sum + 12;
    return sum + (cp >= 0x4e00 && cp <= 0x9fff ? 12 : 6);
  }, 0));
  return {
    width: Math.max(0, ...lineWidths),
    height: Math.max(1, text.split('\n').length) * (style?.lineHeight ?? 12),
  };
}

function mockSurface(measure: MockMeasure = defaultMeasure) {
  const texts: any[] = [];
  const graphics: any[] = [];
  const pixels: any[] = [];
  const containers: any[] = [];

  const baseNode = () => ({
    x: 0,
    y: 0,
    scale: [] as unknown[],
    alpha: 1,
    visible: true,
    setPosition(x: number, y: number) { this.x = x; this.y = y; },
    setScale(x: number, y?: number) { this.scale.push([x, y]); },
    setAlpha(alpha: number) { this.alpha = alpha; },
    setVisible(visible: boolean) { this.visible = visible; },
    destroy() {},
  });

  const surface: any = {
    root: { ...baseNode(), children: [] as unknown[], add(...children: unknown[]) { this.children.push(...children); }, remove() {} },
    ticker: { add() { return () => {}; }, start() {}, stop() {} },
    createContainer() {
      const node = { ...baseNode(), children: [] as unknown[], add(...children: unknown[]) { this.children.push(...children); }, remove() {} };
      containers.push(node);
      return node;
    },
    createGraphics() {
      const node = { ...baseNode(), commands: [] as readonly ShapeCommand[], setCommands(commands: readonly ShapeCommand[]) { this.commands = commands; } };
      graphics.push(node);
      return node;
    },
    createPixel(program?: unknown) {
      const node = { ...baseNode(), program, setProgram(next: unknown) { this.program = next; } };
      pixels.push(node);
      return node;
    },
    createText(text = '', style?: RenderTextStyle) {
      const node = {
        ...baseNode(),
        value: text,
        style,
        measureCalls: [] as string[],
        setText(next: string) { this.value = next; },
        setStyle(next: RenderTextStyle) { this.style = next; },
        measure() {
          this.measureCalls.push(this.value);
          return measure(this.value, this.style);
        },
      };
      texts.push(node);
      return node;
    },
    resize() {},
    render() {},
    destroy() {},
  };

  return { surface, texts, graphics, pixels, containers };
}

const houseRect = { x: 60, y: 260, width: 240, height: 200 };
const pointerOutside = { x: -1, y: -1, inside: false };
const pointerInside = { x: 180, y: 360, inside: true };

describe('house fixture contract', () => {
  it('keeps worker order and appends all nine house fixtures', async () => {
    const { WORKER_FIXTURES, HOUSE_FIXTURES, HOUSE_FIXTURE_VIEWPORT } = await import('../scripts/preview/fixtures.mjs');
    expect(WORKER_FIXTURES).toHaveLength(25);
    expect(HOUSE_FIXTURE_VIEWPORT).toEqual({ width: 360, height: 460, dpr: 1, scale: 5, nowMs: 10000 });
    expect(HOUSE_FIXTURES.map((fixture) => fixture.file)).toEqual([
      'house-base.png',
      'house-status-queued.png',
      'house-broadcast-sticky.png',
      'house-stats-hover.png',
      'house-active-queued.png',
      'house-high-tier.png',
      'house-mushroom-base.png',
      'house-mushroom-active-queued.png',
      'house-mushroom-high-tier.png',
    ]);
    expect(HOUSE_FIXTURES[1].value.workers.map((worker: any) => worker.phase)).toEqual(['working', 'sleeping']);
    expect(HOUSE_FIXTURES[1].value.queuedCount).toBe(3);
    expect(HOUSE_FIXTURES[2].value.broadcast).toEqual({
      id: 'visual-broadcast',
      text: 'Pixi migration ready',
      intensity: 'sticky',
    });
    expect(HOUSE_FIXTURES[3].value.dailyStats).toMatchObject({
      dayKey: '2026-07-10',
      dispatchCount: 314,
      inputTokens: 191000000,
      outputTokens: 2000000,
      totalTokens: 193000000,
      source: 'sqlite',
    });
    expect(HOUSE_FIXTURES[3].value.workers.map((worker: any) => worker.phase)).toEqual(['working']);
    expect(HOUSE_FIXTURES[3].value.dailyStats.startAt).toBe('2026-07-09T16:00:00.000Z');
    expect(HOUSE_FIXTURES[3].value.dailyStats.endAt).toBe('2026-07-10T16:00:00.000Z');
    expect(HOUSE_FIXTURES[3].pointer).toEqual({ x: 180, y: 360, inside: true });

    const tips = HOUSE_FIXTURES[3].value.quotaTips;
    expect(Array.isArray(tips)).toBe(true);
    expect(tips.length).toBeGreaterThanOrEqual(3);

    // codex-spark: 7d-only
    const codex = tips.find((t: any) => t.text.includes('codex-spark'));
    expect(codex).toBeDefined();
    expect(codex.bars).toHaveLength(1);
    expect(codex.bars[0].provider.windows[0].name).toBe('7d');

    // kimi-coding: all three pools stay ordered and grouped
    const kimi = tips.find((t: any) => t.text.includes('kimi-coding'));
    expect(kimi).toBeDefined();
    expect(kimi.bars).toHaveLength(1);
    expect(kimi.bars[0].provider.windows[0].name).toBe('5h');
    expect(kimi.bars[0].provider.windows[1].name).toBe('7d');
    expect(kimi.bars[0].provider.windows[2].name).toBe('1mo');

    // super-grok: error shape
    const superGrok = tips.find((t: any) => t.text.includes('super-grok'));
    expect(superGrok).toBeDefined();
    expect(superGrok.bars[0].status).toBe('error');
    expect(superGrok.bars[0].error).toBe('rate limit hit');
  });
});

describe('house sprite entity', () => {
  it('ports the exact 48x40 live house program and detail pixels', async () => {
    const { buildHousePixelProgram, HOUSE_PX_W, HOUSE_PX_H } = await import('../src/features/house/scene/house-sprite');
    const program = buildHousePixelProgram('classic');
    expect(program.width).toBe(HOUSE_PX_W);
    expect(program.height).toBe(HOUSE_PX_H);
    // Classic roof: pointed silhouette with terracotta ridge, dark eave, plaster walls
    expect(program.rects).toContainEqual({ x: 22, y: 4, width: 1, height: 1, color: '#9E3A2C', alpha: 1 });
    expect(program.rects).toContainEqual({ x: 23, y: 4, width: 1, height: 1, color: '#C44E3A', alpha: 1 });
    expect(program.rects).toContainEqual({ x: 9, y: 10, width: 1, height: 1, color: '#9E3A2C', alpha: 1 });
    expect(program.rects).toContainEqual({ x: 13, y: 11, width: 1, height: 1, color: '#F5EBD4', alpha: 1 });
    expect(program.rects).toContainEqual({ x: 9, y: 39, width: 30, height: 1, color: '#5B3218', alpha: 1 });
  });

  it('creates an attached scene root and computes bottom-centered scaled bounds', async () => {
    const { createHouseScene } = await import('../src/features/house/scene');
    const { surface, pixels } = mockSurface();
    const scene = createHouseScene(
      surface,
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    const node = scene.update(
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    expect(surface.root.children).toEqual([scene.root]);
    expect(node.houseRect).toEqual(houseRect);
    expect(node.hitRects[0]).toMatchObject({ ...houseRect, target: 'house' });
    expect(node.passthrough).toBe(true);
    expect(pixels[0].x).toBe(60);
    expect(pixels[0].y).toBe(260);
    expect(pixels[0].scale).toContainEqual([5, undefined]);
  });

  it('exposes exactly one passthrough truth (isPassthrough) and no passthroughDirect', async () => {
    const { createHouseScene } = await import('../src/features/house/scene');
    const { surface } = mockSurface();
    const scene = createHouseScene(
      surface,
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    const node = scene.update(
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    expect(node).not.toHaveProperty('passthroughDirect');
    expect(node.passthrough).toBe(true);

    // pointerInside + dragging=false => pointer over house-body hit rect => passthrough false
    const inside = { x: 180, y: 360, inside: true };
    const updated = scene.update(
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      inside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    expect(updated).not.toHaveProperty('passthroughDirect');
    expect(updated.passthrough).toBe(false);

    // dragging=true forces passthrough false regardless of pointer position
    const dragging = scene.update(
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      true,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    expect(dragging).not.toHaveProperty('passthroughDirect');
    expect(dragging.passthrough).toBe(false);
  });

  it('bodyTargeted reflects interactive hitRects (false while dragging, true only when hitTargetAt slot is house)', async () => {
    const { createHouseScene } = await import('../src/features/house/scene');
    const { surface } = mockSurface();

    // pointer outside => target undefined => bodyTargeted false
    const scene = createHouseScene(
      surface,
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    const node = scene.update(
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    expect(node.bodyTargeted).toBe(false);

    // pointer inside house body, not dragging => target is 'house'
    const inside = { x: 180, y: 360, inside: true };
    const updated = scene.update(
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      inside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    expect(updated.bodyTargeted).toBe(true);
    expect(updated.target).toBe('house');

    // dragging=true removes house-body from hitRects => target cannot be 'house'
    const dragging = scene.update(
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      inside,
      true,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    expect(dragging.bodyTargeted).toBe(false);
  });
});

describe('house status and tips visibility', () => {
  it('flips Tips below a house at the top edge and keeps them above at the bottom edge', async () => {
    const { resolveStatsCardY } = await import('../src/features/house/scene/stats-card');

    expect(resolveStatsCardY({ x: 0, y: 0, width: 144, height: 120 }, 200, 460)).toBe(122);
    expect(resolveStatsCardY({ x: 216, y: 340, width: 144, height: 120 }, 200, 460)).toBe(138);
  });

  it('renders no status text when pointer is outside', async () => {
    const { createStatusLabel, updateStatusLabel } = await import('../src/features/house/scene/status-label');
    const { surface } = mockSurface();
    const node = createStatusLabel(surface.createContainer(), surface);
    const result = updateStatusLabel(node, {
      workers: [{ phase: 'working' } as any, { phase: 'sleeping' } as any],
      queuedCount: 3,
      pointer: pointerOutside,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });
    expect(result).toBeUndefined();
  });

  it('renders no tips card when pointer is outside', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 12, totalTokens: 1500, inputTokens: 1200, outputTokens: 300, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{ text: 'Codex: 500/1000 used', bars: [{ provider: { remainingPct: 50, expectedRemainingPct: null, windows: [{ name: '7d', usedPct: 50, remainingPct: 50, expectedRemainingPct: null }] }, label: 'Codex', error: null, status: 'ok', stale: false }] }],
      pointer: pointerOutside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });
    expect(result).toBeUndefined();
  });

  it('renders the tips card when pointer is inside', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);
    const layout = updateStatsCard(node, {
      dailyStats: { dispatchCount: 12, totalTokens: 1500, inputTokens: 1200, outputTokens: 300, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{ text: 'Codex: 500/1000 used', bars: [{ provider: { remainingPct: 50, expectedRemainingPct: null, windows: [{ name: '7d', usedPct: 50, remainingPct: 50, expectedRemainingPct: null }] }, label: 'Codex', error: null, status: 'ok', stale: false }] }],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });
    expect(layout).toBeDefined();
  });
});

describe('house broadcast entity', () => {
  it('implements exact transient alpha semantics', async () => {
    const { broadcastAlpha, shouldRenderBroadcast } = await import('../src/features/house/scene/broadcast-expiry');
    expect(broadcastAlpha(undefined, 10000)).toBe(0);
    expect(broadcastAlpha({ text: 'x', intensity: 'sticky' }, 10000)).toBe(1);
    expect(broadcastAlpha({ text: 'x', intensity: 'critical', untilMs: 9000 }, 10000)).toBe(1);
    expect(broadcastAlpha({ text: 'x', intensity: 'transient' }, 10000)).toBe(1);
    expect(broadcastAlpha({ text: 'x', intensity: 'transient', untilMs: 10000 }, 10000)).toBe(0);
    expect(broadcastAlpha({ text: 'x', intensity: 'transient', untilMs: 10400 }, 10000)).toBeCloseTo(0.5, 5);
    expect(shouldRenderBroadcast({ text: 'x', intensity: 'transient', untilMs: 9999 }, 10000)).toBe(false);
  });

  it('uses prefix, fixed four-line height, close rect, visual close icon and hit layout', async () => {
    const { createBroadcastCard, updateBroadcastCard, BROADCAST_LINE_HEIGHT } = await import('../src/features/house/scene/broadcast-card');
    const { surface, texts, graphics } = mockSurface((text, style) => ({ width: Array.from(text).length * 7, height: style?.lineHeight ?? 16 }));
    const node = createBroadcastCard(surface.createContainer(), surface);
    const layout = updateBroadcastCard(node, {
      broadcast: { id: 'visual-broadcast', text: 'Pixi migration ready', intensity: 'sticky' },
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
      nowMs: 10000,
    });

    expect(layout?.text).toBe('» Pixi migration ready');
    expect(layout?.width).toBeGreaterThanOrEqual(240);
    expect(layout?.width).toBeLessThanOrEqual(320);
    expect(layout?.height).toBe(4 * BROADCAST_LINE_HEIGHT + 14);
    expect(layout?.closeRect).toEqual({
      x: layout!.x + layout!.width - 10 - 24,
      y: layout!.y + 7 - 2,
      width: 24,
      height: 24,
    });
    expect(texts[0].value.startsWith('» ')).toBe(true);
    expect(texts[0].alpha).toBeCloseTo(0.85, 5);
    expect(graphics[0].commands).toContainEqual(expect.objectContaining({ kind: 'roundedRect', fill: '#F7EFD8', alpha: 0.95 }));
    expect(graphics[1].commands.some((cmd: ShapeCommand) => cmd.kind === 'polygon')).toBe(true);
  });

  it('wraps to at most four lines with ellipsis under measured width', async () => {
    const { measureBroadcastCard } = await import('../src/features/house/scene/broadcast-card');
    const metrics = measureBroadcastCard(
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau',
      (text) => Array.from(text).length * 11,
      120,
    );
    expect(metrics.lines.length).toBeLessThanOrEqual(4);
    expect(metrics.lines[metrics.lines.length - 1].endsWith('\u2026')).toBe(true);
  });
});

describe('house totals formatting', () => {
  it('formats totals as rounded integer mtok at >=1,000,000', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, texts } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);
    const layout = updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 2000000, inputTokens: 1000000, outputTokens: 1000000, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{ text: 'test', bars: [{ provider: { remainingPct: 50, expectedRemainingPct: null, windows: [{ name: '7d', usedPct: 50, remainingPct: 50, expectedRemainingPct: null }] }, label: 'Test', error: null, status: 'ok', stale: false }] }],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });
    expect(layout).toBeDefined();
    expect(layout!.lines[1]).toMatch(/2\s*mtok/);
    expect(texts[0].value).toMatch(/2\s*mtok/);
  });

  it('formats totals as rounded integer ktok below 1,000,000', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, texts } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);
    const layout = updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 500000, inputTokens: 250000, outputTokens: 250000, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{ text: 'test', bars: [{ provider: { remainingPct: 50, expectedRemainingPct: null, windows: [{ name: '7d', usedPct: 50, remainingPct: 50, expectedRemainingPct: null }] }, label: 'Test', error: null, status: 'ok', stale: false }] }],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });
    expect(layout).toBeDefined();
    expect(layout!.lines[1]).toMatch(/500\s*ktok/);
    expect(texts[0].value).toMatch(/500\s*ktok/);
  });

  it('formats zero total as 0 ktok', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, texts } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);
    const layout = updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 0, inputTokens: 0, outputTokens: 0, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{ text: 'test', bars: [{ provider: { remainingPct: 50, expectedRemainingPct: null, windows: [{ name: '7d', usedPct: 50, remainingPct: 50, expectedRemainingPct: null }] }, label: 'Test', error: null, status: 'ok', stale: false }] }],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });
    expect(layout).toBeDefined();
    expect(layout!.lines[1]).toMatch(/0\s*ktok/);
    expect(texts[0].value).toMatch(/0\s*ktok/);
  });

  it('formats sub-thousand total as <1 ktok (999 → <1 ktok), never as 0 ktok for positive values', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, texts } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);
    const layout = updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 999, inputTokens: 500, outputTokens: 499, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{ text: 'test', bars: [{ provider: { remainingPct: 50, expectedRemainingPct: null, windows: [{ name: '7d', usedPct: 50, remainingPct: 50, expectedRemainingPct: null }] }, label: 'Test', error: null, status: 'ok', stale: false }] }],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });
    expect(layout).toBeDefined();
    expect(layout!.lines[1]).toMatch(/<1\s*ktok/);
    expect(texts[0].value).toMatch(/<1\s*ktok/);
    // A different positive value below 1,000 must not render as 0 ktok
    expect(layout!.lines[1]).not.toMatch(/\b0\s*ktok\b/);
  });

  it('hides tips during drag', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);
    expect(updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1500, inputTokens: 1200, outputTokens: 300, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{ text: 'test' }],
      pointer: pointerInside,
      dragging: true,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    })).toBeUndefined();
  });
});

describe('stats card graphical containment', () => {
  it('keeps bar tracks, fills, and markers inside the card background for short label', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, graphics } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);

    updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 500, inputTokens: 250, outputTokens: 250, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'A: 80%',
        bars: [{
          provider: {
            remainingPct: 20,
            expectedRemainingPct: null,
            windows: [{ name: '7d', usedPct: 80, remainingPct: 20, expectedRemainingPct: null }],
          },
          label: 'A',
          error: null,
          status: 'ok',
          stale: false,
        }],
      }],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });

    // Find the background roundedRect command
    const bgGfx = graphics.find((g: any) =>
      g.commands.some((c: ShapeCommand) => c.kind === 'roundedRect' && c.fill === '#F7EFD8'),
    );
    expect(bgGfx).toBeDefined();
    const bgCmd = bgGfx.commands.find(
      (c: ShapeCommand) => c.kind === 'roundedRect' && c.fill === '#F7EFD8',
    ) as { x: number; y: number; width: number; height: number };

    // Find the bars graphics node and check each track/fill rect
    const barGfx = graphics.find((g: any) =>
      g.commands.some((c: ShapeCommand) => c.kind === 'roundedRect' && (c.fill === '#2E2018' || c.fill === '#7BA05B')),
    );
    expect(barGfx).toBeDefined();

    for (const cmd of barGfx.commands) {
      if (cmd.kind === 'roundedRect' && (cmd.fill === '#2E2018' || cmd.fill === '#7BA05B')) {
        expect(cmd.x + cmd.width).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);
      }
    }
  });

  it('multi-window provider group is not split by visible limit', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, graphics } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);

    updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 500, inputTokens: 250, outputTokens: 250, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [
        {
          text: 'Codex: 60%, 25%',
          bars: [{
            provider: {
              remainingPct: 60,
              expectedRemainingPct: 35,
              windows: [
                { name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 },
                { name: '7d', usedPct: 75, remainingPct: 25, expectedRemainingPct: 20 },
              ],
            },
            label: 'Codex',
            error: null,
            status: 'ok',
            stale: false,
          }],
        },
        {
          text: 'OpenAI: 80%',
          bars: [{
            provider: {
              remainingPct: 80,
              expectedRemainingPct: 50,
              windows: [{ name: '5h', usedPct: 20, remainingPct: 80, expectedRemainingPct: 50 }],
            },
            label: 'OpenAI',
            error: null,
            status: 'ok',
            stale: false,
          }],
        },
      ],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });

    // Verify all tracks are inside the background
    const bgGfx = graphics.find((g: any) =>
      g.commands.some((c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8'),
    );
    expect(bgGfx).toBeDefined();
    const bgCmd = bgGfx.commands.find(
      (c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8',
    );

    const barGfx = graphics.find((g: any) =>
      g.commands.some((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018'),
    );
    expect(barGfx).toBeDefined();

    for (const cmd of barGfx.commands) {
      if (cmd.kind === 'roundedRect' && (cmd.fill === '#2E2018' || cmd.fill === '#7BA05B')) {
        expect(cmd.x + cmd.width).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);
      }
    }
  });

  it('multi-bar provider (Kimi 5h + 7d) not split and all row nodes inside background', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, graphics, texts } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);

    updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 500, inputTokens: 250, outputTokens: 250, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Kimi: 60%, 90%',
        bars: [
          {
            provider: {
              remainingPct: 60,
              expectedRemainingPct: 35,
              windows: [{ name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 }],
            },
            label: 'Kimi',
            error: null,
            status: 'ok',
            stale: false,
          },
          {
            provider: {
              remainingPct: 90,
              expectedRemainingPct: 50,
              windows: [{ name: '7d', usedPct: 10, remainingPct: 90, expectedRemainingPct: 50 }],
            },
            label: 'Kimi',
            error: null,
            status: 'ok',
            stale: false,
          },
        ],
      }],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });

    // Find the background roundedRect command
    const bgGfx = graphics.find((g: any) =>
      g.commands.some((c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8'),
    );
    expect(bgGfx).toBeDefined();
    const bgCmd = bgGfx.commands.find(
      (c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8',
    );
    expect(bgCmd).toBeDefined();

    // Verify all bar commands are inside the background
    const barGfx = graphics.find((g: any) =>
      g.commands.some((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018'),
    );
    expect(barGfx).toBeDefined();
    for (const cmd of barGfx.commands) {
      if (cmd.kind === 'roundedRect' && (cmd.fill === '#2E2018' || cmd.fill === '#7BA05B')) {
        expect(cmd.x + cmd.width).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);
      }
    }

    // Verify every row text node position is within the background
    const allTextNodes = [...node.providerNodes, ...node.windowNodes, ...node.pctNodes];
    for (const tn of allTextNodes) {
      if (tn.visible) {
        expect(tn.x).toBeGreaterThanOrEqual(bgCmd.x);
        expect(tn.y).toBeGreaterThanOrEqual(bgCmd.y);
        expect(tn.x).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);
        expect(tn.y).toBeLessThanOrEqual(bgCmd.y + bgCmd.height);
      }
    }
  });

  it('error row after multi-window provider remains inside background after inter-provider gap', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, graphics } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);

    updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 500, inputTokens: 250, outputTokens: 250, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [
        {
          text: 'Codex: 60%, 25%',
          bars: [{
            provider: {
              remainingPct: 60,
              expectedRemainingPct: 35,
              windows: [
                { name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 },
                { name: '7d', usedPct: 75, remainingPct: 25, expectedRemainingPct: 20 },
              ],
            },
            label: 'Codex',
            error: null,
            status: 'ok',
            stale: false,
          }],
        },
        {
          text: 'OpenAI: error — rate limited',
          bars: [{
            provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
            label: 'OpenAI',
            error: 'rate limited',
            status: 'error',
            stale: false,
          }],
        },
      ],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });

    // Find the background roundedRect command
    const bgGfx = graphics.find((g: any) =>
      g.commands.some((c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8'),
    );
    expect(bgGfx).toBeDefined();
    const bgCmd = bgGfx.commands.find(
      (c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8',
    );
    expect(bgCmd).toBeDefined();

    // Verify all visible row text nodes are inside the background
    const allTextNodes = [...node.providerNodes, ...node.windowNodes, ...node.pctNodes];
    for (const tn of allTextNodes) {
      if (tn.visible) {
        expect(tn.x).toBeGreaterThanOrEqual(bgCmd.x);
        expect(tn.y).toBeGreaterThanOrEqual(bgCmd.y);
        expect(tn.x).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);
        expect(tn.y).toBeLessThanOrEqual(bgCmd.y + bgCmd.height);
      }
    }

    // Specifically verify the error text row (third row, index 2) is inside the background
    const errorNode = node.providerNodes[2];
    expect(errorNode.visible).toBe(true);
    expect(errorNode.x).toBeGreaterThanOrEqual(bgCmd.x);
    expect(errorNode.y).toBeGreaterThanOrEqual(bgCmd.y);
    expect(errorNode.x).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);
    expect(errorNode.y).toBeLessThanOrEqual(bgCmd.y + bgCmd.height);
  });

  it('long error text row horizontal bounds remain inside background after truncation', async () => {
    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface, graphics } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);

    const longError = 'OpenAI: unexpected server error\nupstream quota system returned 503 after retry';

    updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 500, inputTokens: 250, outputTokens: 250, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [
        {
          text: 'Codex: 60%, 25%',
          bars: [{
            provider: {
              remainingPct: 60,
              expectedRemainingPct: 35,
              windows: [
                { name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 },
                { name: '7d', usedPct: 75, remainingPct: 25, expectedRemainingPct: 20 },
              ],
            },
            label: 'Codex',
            error: null,
            status: 'ok',
            stale: false,
          }],
        },
        {
          text: longError,
          bars: [{
            provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
            label: 'OpenAI',
            error: 'upstream error',
            status: 'error',
            stale: false,
          }],
        },
      ],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });

    // Find the background roundedRect command
    const bgGfx = graphics.find((g: any) =>
      g.commands.some((c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8'),
    );
    expect(bgGfx).toBeDefined();
    const bgCmd = bgGfx.commands.find(
      (c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8',
    );
    expect(bgCmd).toBeDefined();

    // Find the error text node (third provider node, index 2)
    const errorNode = node.providerNodes[2];
    expect(errorNode.visible).toBe(true);

    // Horizontal containment: text x + measured width inside background
    const { width: textWidth } = errorNode.measure();
    expect(errorNode.x).toBeGreaterThanOrEqual(bgCmd.x);
    expect(errorNode.x + textWidth).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);

    // Hard line separators in raw error text are normalized into a single measured line
    const errorText = errorNode.value;
    expect(errorText).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it('over-width newline-containing successful provider label and window name remain inside their allocated columns and background', async () => {
    const { createStatsCard, updateStatsCard, PROVIDER_LABEL_WIDTH, WINDOW_LABEL_WIDTH, STATS_PADDING_X } = await import('../src/features/house/scene/stats-card');
    const { surface, graphics } = mockSurface();
    const node = createStatsCard(surface.createContainer(), surface);

    updateStatsCard(node, {
      dailyStats: { dispatchCount: 1, totalTokens: 500, inputTokens: 250, outputTokens: 250, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Test: 60%',
        bars: [{
          provider: {
            remainingPct: 60,
            expectedRemainingPct: 35,
            windows: [{ name: 'exceeds\ncolumn', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 }],
          },
          label: 'ThisProviderLabelExceedsTheAllocatedColumnWidthAndHas\nLineBreaks',
          error: null,
          status: 'ok',
          stale: false,
        }],
      }],
      pointer: pointerInside,
      dragging: false,
      houseRect,
      viewportWidth: 360,
      viewportHeight: 460,
    });

    // Find background command
    const bgGfx = graphics.find((g: any) =>
      g.commands.some((c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8'),
    );
    expect(bgGfx).toBeDefined();
    const bgCmd = bgGfx.commands.find(
      (c: any) => c.kind === 'roundedRect' && c.fill === '#F7EFD8',
    );
    expect(bgCmd).toBeDefined();

    // Provider text node: inside provider column AND inside background
    const providerNode = node.providerNodes[0];
    expect(providerNode.visible).toBe(true);
    const provColumnX = bgCmd.x + STATS_PADDING_X;
    const provColumnRight = provColumnX + PROVIDER_LABEL_WIDTH;
    const { width: provWidth } = providerNode.measure();
    expect(providerNode.x).toBeGreaterThanOrEqual(bgCmd.x);
    expect(providerNode.x).toBeGreaterThanOrEqual(provColumnX);
    expect(providerNode.x + provWidth).toBeLessThanOrEqual(provColumnRight);
    expect(providerNode.x + provWidth).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);

    // Window text node: inside window column AND inside background
    const windowNode = node.windowNodes[0];
    expect(windowNode.visible).toBe(true);
    const winColumnX = provColumnX + PROVIDER_LABEL_WIDTH;
    const winColumnRight = winColumnX + WINDOW_LABEL_WIDTH;
    const { width: winWidth } = windowNode.measure();
    expect(windowNode.x).toBeGreaterThanOrEqual(bgCmd.x);
    expect(windowNode.x).toBeGreaterThanOrEqual(winColumnX);
    expect(windowNode.x + winWidth).toBeLessThanOrEqual(winColumnRight);
    expect(windowNode.x + winWidth).toBeLessThanOrEqual(bgCmd.x + bgCmd.width);

    // No hard separators in visible text values
    expect(providerNode.value).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(windowNode.value).not.toMatch(/[\r\n\u2028\u2029]/);
  });
});

describe('house viewport bounds', () => {
  it('keeps tips card within viewport bounds when house is near edge', async () => {
    const MARGIN = 2;
    const viewportWidth = 360;
    const viewportHeight = 460;
    const edgeHouseRect = { x: 0, y: 0, width: 240, height: 200 };
    const edgePointerInside = { x: 120, y: 100, inside: true };

    const { createStatsCard, updateStatsCard } = await import('../src/features/house/scene/stats-card');
    const { surface } = mockSurface();
    const statsNode = createStatsCard(surface.createContainer(), surface);
    const statsLayout = updateStatsCard(statsNode, {
      dailyStats: { dispatchCount: 7, totalTokens: 1500, inputTokens: 1200, outputTokens: 300, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [
        { text: 'Codex: 500/1000 used' },
        { text: 'Codex: 200/500 used' },
        { text: 'GPT-4: 100/300 used' },
      ],
      pointer: edgePointerInside,
      dragging: false,
      houseRect: edgeHouseRect,
      viewportWidth,
      viewportHeight,
    });
    expect(statsLayout).toBeDefined();
    expect(statsLayout!.x).toBeGreaterThanOrEqual(MARGIN);
    expect(statsLayout!.y).toBeGreaterThanOrEqual(MARGIN);
    expect(statsLayout!.x + statsLayout!.width).toBeLessThanOrEqual(viewportWidth - MARGIN);
    expect(statsLayout!.y + statsLayout!.height).toBeLessThanOrEqual(viewportHeight - MARGIN);
  });
});

describe('house crate slot contract', () => {
  function crateColors(): string[] {
    return ['#B17D3E', '#8A5A2E', '#5B3218'];
  }

  it('crate count is floor(totalTokens/50,000,000) capped at 10', async () => {
    const { updateHouseSprite, buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');

    // Baseline: totalTokens=0
    const baselineSprite = surface.createPixel(program);
    updateHouseSprite(baselineSprite, 0, 0, 5, false, 0, 0, 0, 'classic');
    const baselineRects = baselineSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const baselineSet = new Set(baselineRects.map((r) => JSON.stringify([r.x, r.y, r.width, r.height, r.color, r.alpha])));

    const crateColorsArr = crateColors();

    // 0 tokens → 0 crates
    const zeroSprite = surface.createPixel(program);
    updateHouseSprite(zeroSprite, 0, 0, 5, false, 0, 0, 0, 'classic');
    const zeroRects = zeroSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const zeroAdded = zeroRects.filter((r) => !baselineSet.has(JSON.stringify([r.x, r.y, r.width, r.height, r.color, r.alpha])));
    const zeroCrateRects = zeroAdded.filter((r) => crateColorsArr.includes(r.color));
    expect(zeroCrateRects.length).toBe(0);

    // 50,000,000 tokens → floor(50M/50M) = 1 crate → 3 rows of 4px each
    const oneSprite = surface.createPixel(program);
    updateHouseSprite(oneSprite, 0, 0, 5, false, 0, 50000000, 0, 'classic');
    const oneRects = oneSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const oneAdded = oneRects.filter((r) => !baselineSet.has(JSON.stringify([r.x, r.y, r.width, r.height, r.color, r.alpha])));
    const oneCrateRects = oneAdded.filter((r) => crateColorsArr.includes(r.color));
    // One crate = 3 rows (woodLight top, wood middle, woodDark bottom)
    expect(oneCrateRects.length).toBe(3);

    // 500,000,000 tokens → floor(500M/50M) = 10 crates (capped) → 30 rows
    const fullSprite = surface.createPixel(program);
    updateHouseSprite(fullSprite, 0, 0, 5, false, 0, 500000000, 0, 'classic');
    const fullRects = fullSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const fullAdded = fullRects.filter((r) => !baselineSet.has(JSON.stringify([r.x, r.y, r.width, r.height, r.color, r.alpha])));
    const fullCrateRects = fullAdded.filter((r) => crateColorsArr.includes(r.color));
    expect(fullCrateRects.length).toBe(30);
  });

  it('renders exactly 10 fixed 4x3 slots in two rows at the correct positions', async () => {
    const { updateHouseSprite, buildHousePixelProgram, CRATES_MAX, TOKENS_PER_CRATE } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');

    const baselineSprite = surface.createPixel(program);
    updateHouseSprite(baselineSprite, 0, 0, 5, false, 0, 0, 0, 'classic');
    const baselineRects = baselineSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const baselineSet = new Set(baselineRects.map((r) => JSON.stringify([r.x, r.y, r.width, r.height, r.color, r.alpha])));

    const sprite = surface.createPixel(program);
    updateHouseSprite(sprite, 0, 0, 5, false, 0, 500000000, 0, 'classic');
    const allRects = sprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const addedRects = allRects.filter((r) => !baselineSet.has(JSON.stringify([r.x, r.y, r.width, r.height, r.color, r.alpha])));

    const crateColorsArr = crateColors();
    const crateRects = addedRects.filter((r) => crateColorsArr.includes(r.color));

    const expectedXs = [12, 17, 22, 27, 32];

    // Each crate occupies 4x3 at each slot position
    // Row structure: woodLight top (y=18/15), wood middle (y=19/16), woodDark bottom (y=20/17)
    // Lower row (y=18): 5 slots
    const lowerTopRows = crateRects.filter((r) => r.y === 18 && r.width === 4 && r.height === 1 && r.color === '#B17D3E');
    expect(lowerTopRows.length).toBe(5);
    const lowerMidRows = crateRects.filter((r) => r.y === 19 && r.width === 4 && r.height === 1 && r.color === '#8A5A2E');
    expect(lowerMidRows.length).toBe(5);
    const lowerBotRows = crateRects.filter((r) => r.y === 20 && r.width === 4 && r.height === 1 && r.color === '#5B3218');
    expect(lowerBotRows.length).toBe(5);

    // Upper row (y=15): 5 slots
    const upperTopRows = crateRects.filter((r) => r.y === 15 && r.width === 4 && r.height === 1 && r.color === '#B17D3E');
    expect(upperTopRows.length).toBe(5);
    const upperMidRows = crateRects.filter((r) => r.y === 16 && r.width === 4 && r.height === 1 && r.color === '#8A5A2E');
    expect(upperMidRows.length).toBe(5);
    const upperBotRows = crateRects.filter((r) => r.y === 17 && r.width === 4 && r.height === 1 && r.color === '#5B3218');
    expect(upperBotRows.length).toBe(5);

    // Each slot at expected x positions for all three rows
    for (const expectedX of expectedXs) {
      expect(addedRects).toContainEqual({ x: expectedX, y: 18, width: 4, height: 1, color: '#B17D3E', alpha: 1 });
      expect(addedRects).toContainEqual({ x: expectedX, y: 19, width: 4, height: 1, color: '#8A5A2E', alpha: 1 });
      expect(addedRects).toContainEqual({ x: expectedX, y: 20, width: 4, height: 1, color: '#5B3218', alpha: 1 });
      expect(addedRects).toContainEqual({ x: expectedX, y: 15, width: 4, height: 1, color: '#B17D3E', alpha: 1 });
      expect(addedRects).toContainEqual({ x: expectedX, y: 16, width: 4, height: 1, color: '#8A5A2E', alpha: 1 });
      expect(addedRects).toContainEqual({ x: expectedX, y: 17, width: 4, height: 1, color: '#5B3218', alpha: 1 });
    }
  });

  it('has a single platform at y=21', async () => {
    const { buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const program = buildHousePixelProgram('classic');
    // Platform at y=21 (plasterShade #D9CBA8, 26-wide rect — not 1×1 wall shade cells)
    const platforms = program.rects.filter((r) => r.color === '#D9CBA8' && r.y === 21 && r.width === 26);
    expect(platforms.length).toBe(1);
    expect(platforms[0].x).toBe(11);
    expect(platforms[0].height).toBe(1);
  });
});

describe('house raster and draw order contract', () => {
  function rasterizeRects(
    rects: ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>,
    w: number,
    h: number,
  ): string[][] {
    const grid: string[][] = Array.from({ length: h }, () => Array(w).fill(null));
    for (const r of rects) {
      for (let dy = 0; dy < (r.height ?? 1); dy++) {
        for (let dx = 0; dx < (r.width ?? 1); dx++) {
          const px = r.x + dx;
          const py = r.y + dy;
          if (px >= 0 && px < w && py >= 0 && py < h) {
            grid[py][px] = r.color;
          }
        }
      }
    }
    return grid;
  }

  it('roof pixels render in front of overlapping chimney lower portion (rasterized)', async () => {
    const { buildHousePixelProgram, updateHouseSprite } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');
    const sprite = surface.createPixel(program);
    updateHouseSprite(sprite, 0, 0, 5, false, 0, 0, 0, 'classic');
    const rects = sprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const grid = rasterizeRects(rects, program.width, program.height);

    // Collect every pixel coordinate covered by roof-colored rects from base geometry
    const baseProgram = buildHousePixelProgram('classic');
    const roofPixels = new Set<string>();
    for (const r of baseProgram.rects) {
      if (r.color === '#C44E3A' || r.color === '#9E3A2C') {
        for (let dy = 0; dy < (r.height ?? 1); dy++) {
          for (let dx = 0; dx < (r.width ?? 1); dx++) {
            roofPixels.add(`${r.x + dx},${r.y + dy}`);
          }
        }
      }
    }

    // Collect every pixel coordinate covered by chimney-colored rects (brown wood tones)
    const chimneyPixels = new Set<string>();
    for (const r of rects) {
      if (r.color === '#5B3218' || r.color === '#8A5A2E' || r.color === '#B17D3E') {
        for (let dy = 0; dy < (r.height ?? 1); dy++) {
          for (let dx = 0; dx < (r.width ?? 1); dx++) {
            chimneyPixels.add(`${r.x + dx},${r.y + dy}`);
          }
        }
      }
    }

    // Intersection of chimney pixels with roof pixels, constrained to y=5..10 (roof overlap band)
    const overlapPixels: string[] = [];
    for (const key of chimneyPixels) {
      const [, pyStr] = key.split(',');
      const py = Number(pyStr);
      if (py >= 5 && py <= 10 && roofPixels.has(key)) {
        overlapPixels.push(key);
      }
    }

    expect(overlapPixels.length, 'chimney and roof must overlap in y=5..10').toBeGreaterThan(0);

    for (const key of overlapPixels) {
      const [pxStr, pyStr] = key.split(',');
      const px = Number(pxStr);
      const py = Number(pyStr);
      const finalColor = grid[py][px];
      const chimneyColors = ['#5B3218', '#8A5A2E', '#B17D3E'];
      expect(chimneyColors.includes(finalColor), `final rasterized pixel at (${px},${py}) must be roof color, not chimney brown`).toBe(false);
      expect(['#C44E3A', '#9E3A2C'], `final rasterized pixel at (${px},${py}) must be roof color, got ${finalColor}`).toContain(finalColor);
    }
  });

  it('smoke pixels stay above the chimney', async () => {
    const { updateHouseSprite, buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');
    const sprite = surface.createPixel(program);
    updateHouseSprite(sprite, 0, 0, 5, true, 1, 0, 0, 'classic');
    const rects = sprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const smokeRects = rects.filter((r) => r.color === '#AAAAAA' || r.color === '#BBBBBB');
    for (const smoke of smokeRects) {
      expect(smoke.y).toBeLessThanOrEqual(1);
    }
    const roofSmoke = smokeRects.filter((r) => r.y >= 5);
    expect(roofSmoke.length, 'no smoke may remain on roof rows').toBe(0);
  });

  it('dispatchCount does not affect house sprite output; no flag face or pole colors appear', async () => {
    const { updateHouseSprite, buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');

    // dispatchCount=0 — no flag colors or geometry
    const zeroDispatchSprite = surface.createPixel(program);
    updateHouseSprite(zeroDispatchSprite, 0, 0, 5, false, 0, 0, 0, 'classic');
    const zeroRects = zeroDispatchSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const zeroFlagColors = zeroRects.filter((r) => r.color === '#666666' || r.color === '#FFFFFF');
    expect(zeroFlagColors.length, 'no flag pole (#666666) or face (#FFFFFF) colors for dispatchCount=0').toBe(0);

    // dispatchCount=500 — no flag colors or geometry
    const highDispatchSprite = surface.createPixel(program);
    updateHouseSprite(highDispatchSprite, 0, 0, 5, false, 0, 500000000, 500, 'classic');
    const highRects = highDispatchSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const highFlagColors = highRects.filter((r) => r.color === '#666666' || r.color === '#FFFFFF');
    expect(highFlagColors.length, 'no flag pole (#666666) or face (#FFFFFF) colors for dispatchCount=500').toBe(0);

    // Identical output for dispatchCount=0 and dispatchCount=500 at same totalTokens=0
    const zeroDispatchZeroTokensSprite = surface.createPixel(program);
    updateHouseSprite(zeroDispatchZeroTokensSprite, 0, 0, 5, false, 0, 0, 0, 'classic');
    const zeroZeroRects = zeroDispatchZeroTokensSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;

    const highDispatchZeroTokensSprite = surface.createPixel(program);
    updateHouseSprite(highDispatchZeroTokensSprite, 0, 0, 5, false, 0, 0, 500, 'classic');
    const highZeroRects = highDispatchZeroTokensSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;

    expect(highZeroRects).toEqual(zeroZeroRects);
  });
});
describe('house window contract', () => {
  it('exactly two 1F windows have 6px height and sit farther outward at x=13..16 and x=31..34', async () => {
    const { buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const program = buildHousePixelProgram('classic');
    // Detail window wood frames (#5B3218)
    const windowRects = program.rects.filter((r) => r.color === '#5B3218' && r.x >= 13 && r.x <= 34);
    // Each window has a 4x6 frame (woodDark) plus pane rects — find the frame bodies
    const windowFrames = windowRects.filter((r) => r.width === 4 && r.height === 6);
    expect(windowFrames.length).toBe(2);

    // Left window at x=13..16 (farther outward)
    const leftWin = windowFrames.find((r) => r.x >= 13 && r.x <= 16);
    expect(leftWin, 'left window must be at x=13..16').toBeDefined();
    expect(leftWin!.height, 'left window must be 6px tall').toBe(6);

    // Right window at x=31..34 (farther outward)
    const rightWin = windowFrames.find((r) => r.x >= 31 && r.x <= 34);
    expect(rightWin, 'right window must be at x=31..34').toBeDefined();
    expect(rightWin!.height, 'right window must be 6px tall').toBe(6);
  });

  it('1F windows may share the door vertical band', async () => {
    const { buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const program = buildHousePixelProgram('classic');
    // 1F window frames (#5B3218) — exact 4x6 geometry at outward positions, none above y=21
    const windowBodies = program.rects.filter((r) => r.color === '#5B3218' && r.width === 4 && r.height === 6);
    expect(windowBodies.length).toBe(2);
    expect(windowBodies).toContainEqual({ x: 13, y: 26, width: 4, height: 6, color: '#5B3218', alpha: 1 });
    expect(windowBodies).toContainEqual({ x: 31, y: 26, width: 4, height: 6, color: '#5B3218', alpha: 1 });
    // No window frames above y=21 (1F/2F platform split)
    const upperWindowBodies = windowBodies.filter((r) => r.y < 21);
    expect(upperWindowBodies.length).toBe(0);
  });
});

describe('house door contract', () => {
  it('both open and closed doors occupy the same outer bounds x=21..25, y=30..38', async () => {
    const { buildHousePixelProgram, updateHouseSprite } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');

    // Closed door (non-running)
    const closedSprite = surface.createPixel(program);
    updateHouseSprite(closedSprite, 0, 0, 5, false, 0, 0, 0, 'classic');
    const closedRects = closedSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const closedDoor = closedRects.find((r) => r.color === '#5B3218' && r.x === 21 && r.y === 30 && r.width === 5);
    expect(closedDoor, 'closed door must occupy x=21..25, y=30..38').toBeDefined();
    expect(closedDoor!.y + closedDoor!.height, 'closed door must reach y=38 bottom').toBe(39);

    // Open door (running) — same outer bounds
    const openSprite = surface.createPixel(program);
    updateHouseSprite(openSprite, 0, 0, 5, true, 1, 0, 0, 'classic');
    const openRects = openSprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const openLintel = openRects.find((r) => r.color === '#5B3218' && r.x === 21 && r.y === 30 && r.width === 5);
    expect(openLintel, 'open door lintel must occupy x=21..25 at y=30').toBeDefined();
    // Open door posts at x=21 and x=25, both y=31..38
    const leftPost = openRects.find((r) => r.color === '#5B3218' && r.x === 21 && r.y === 31 && r.width === 1);
    expect(leftPost, 'open door left post at x=21 must be present').toBeDefined();
    expect(leftPost!.y + leftPost!.height, 'open door left post must reach ground').toBe(39);
    const rightPost = openRects.find((r) => r.color === '#5B3218' && r.x === 25 && r.y === 31 && r.width === 1);
    expect(rightPost, 'open door right post at x=25 must be present').toBeDefined();
    expect(rightPost!.y + rightPost!.height, 'open door right post must reach ground').toBe(39);
  });

  it('open door center is transparent with no black fill', async () => {
    const { updateHouseSprite, buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');
    const sprite = surface.createPixel(program);
    updateHouseSprite(sprite, 0, 0, 5, true, 1, 0, 0, 'classic');
    const rects = sprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    // No solid #1A1A1A fill
    const solidFill = rects.filter((r) => r.color === '#1A1A1A');
    expect(solidFill.length, 'no solid #1A1A1A fill in open door').toBe(0);
    // Center region (x=22..24, y=31..38) has no brown door frame color
    const centerRects = rects.filter((r) => r.color === '#5B3218' && r.x >= 22 && r.x <= 24 && r.y >= 31 && r.y <= 38);
    expect(centerRects.length, 'center of open door must be transparent').toBe(0);
  });
});

describe('house action buttons in hit regions', () => {
  it('collectHitRects includes settings and stats buttons', async () => {
    const { collectHitRects, rightEdgeButtonRects } = await import('../src/features/house/scene/hit-regions');
    const houseRect = { x: 60, y: 260, width: 240, height: 200 };
    const buttons = rightEdgeButtonRects(houseRect, 500);
    const rects = collectHitRects({
      houseRect,
      dragging: false,
      buttonsVisible: true,
      settingsBtn: buttons.settings,
      statsBtn: buttons.stats,
    });
    expect(rects.some((r) => r.target === 'settings-btn')).toBe(true);
    expect(rects.some((r) => r.target === 'stats-btn')).toBe(true);
  });

  it('buttons are hidden during drag', async () => {
    const { collectHitRects, rightEdgeButtonRects } = await import('../src/features/house/scene/hit-regions');
    const houseRect = { x: 60, y: 260, width: 240, height: 200 };
    const buttons = rightEdgeButtonRects(houseRect, 500);
    const rects = collectHitRects({
      houseRect,
      dragging: true,
      buttonsVisible: true,
      settingsBtn: buttons.settings,
      statsBtn: buttons.stats,
    });
    expect(rects.some((r) => r.target === 'settings-btn')).toBe(false);
    expect(rects.some((r) => r.target === 'stats-btn')).toBe(false);
  });

  it('rightEdgeButtonRects flips buttons when approaching right viewport edge', async () => {
    const { rightEdgeButtonRects } = await import('../src/features/house/scene/hit-regions');
    const houseRect = { x: 480, y: 260, width: 240, height: 200 };
    const buttons = rightEdgeButtonRects(houseRect, 500);
    expect(buttons.settings.x).toBeLessThan(houseRect.x);
  });

  it('renders distinct settings and stats icon rect patterns contained within #F7EFD8 rounded background', async () => {
    const { createHouseScene } = await import('../src/features/house/scene');
    const { surface, graphics } = mockSurface();
    const scene = createHouseScene(
      surface,
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
    );
    const node = scene.update(
      { scale: 5, houseSkin: 'classic', workers: [], queuedCount: 0 },
      pointerOutside,
      false,
      { width: 72, height: 92, scale: 5 },
      10000,
      true,
    );

    // Identify exactly two button graphics by the #F7EFD8 roundedRect background
    const buttonGraphics = graphics.filter((g: any) =>
      g.commands.some(
        (c: ShapeCommand) => c.kind === 'roundedRect' && c.fill === '#F7EFD8',
      ),
    );
    expect(buttonGraphics).toHaveLength(2);

    // Collect the rect-kind icon commands beyond background and border for each button
    const iconRectsList = buttonGraphics.map((g: any) => {
      const bg = g.commands.find(
        (c: ShapeCommand) => c.kind === 'roundedRect' && c.fill === '#F7EFD8',
      ) as { x: number; y: number; width: number; height: number };
      const rects = g.commands.filter(
        (c: ShapeCommand): c is { kind: 'rect'; x: number; y: number; width: number; height: number; fill: string; alpha?: number } =>
          c.kind === 'rect',
      );
      return { bg, rects };
    });

    // Assert both collections are non-empty
    expect(iconRectsList[0].rects.length).toBeGreaterThan(0);
    expect(iconRectsList[1].rects.length).toBeGreaterThan(0);

    // Normalize coordinates relative to each button background
    const normalized0 = iconRectsList[0].rects.map((r) => ({
      x: r.x - iconRectsList[0].bg.x,
      y: r.y - iconRectsList[0].bg.y,
      width: r.width,
      height: r.height,
    }));
    const normalized1 = iconRectsList[1].rects.map((r) => ({
      x: r.x - iconRectsList[1].bg.x,
      y: r.y - iconRectsList[1].bg.y,
      width: r.width,
      height: r.height,
    }));

    // Assert the settings and stats patterns are distinct
    expect(normalized0).not.toEqual(normalized1);

    // Assert every icon rect is contained within its own rounded background rectangle
    for (const entry of iconRectsList) {
      for (const r of entry.rects) {
        expect(r.x).toBeGreaterThanOrEqual(entry.bg.x);
        expect(r.y).toBeGreaterThanOrEqual(entry.bg.y);
        expect(r.x + r.width).toBeLessThanOrEqual(entry.bg.x + entry.bg.width);
        expect(r.y + r.height).toBeLessThanOrEqual(entry.bg.y + entry.bg.height);
      }
    }
  });
});

describe('house hit regions', () => {
  it('keeps inclusive house and close target rectangles with passthrough outside all', async () => {
    const { collectHitRects, computePassthrough, hitTargetAt, isOverHouseBody, isPassthrough, pointInRect } = await import('../src/features/house/scene/hit-regions');
    const closeRect = { x: 250, y: 185, width: 24, height: 24 };
    expect(pointInRect(60, 260, houseRect)).toBe(true);
    expect(pointInRect(300, 460, houseRect)).toBe(true);
    expect(pointInRect(301, 460, houseRect)).toBe(false);
    const rects = collectHitRects({ houseRect, closeRect, dragging: false });
    expect(rects.map((rect) => rect.target)).toEqual(['house', 'broadcast-close']);
    expect(hitTargetAt(rects, { x: 262, y: 197, inside: true })).toBe('broadcast-close');
    expect(isPassthrough({ hitRects: rects, pointer: pointerOutside, dragging: false })).toBe(true);
    expect(isPassthrough({ hitRects: rects, pointer: pointerInside, dragging: false })).toBe(false);
    expect(isPassthrough({ hitRects: [], pointer: pointerOutside, dragging: true })).toBe(false);
    expect(collectHitRects({ houseRect, closeRect, dragging: true }).map((rect) => rect.target)).toEqual(['broadcast-close']);

    // Approved pure helpers
    expect(computePassthrough(pointerOutside, rects)).toBe(true);
    expect(computePassthrough(pointerInside, rects)).toBe(false);
    expect(computePassthrough({ x: 300, y: 200, inside: true }, rects)).toBe(true);
    expect(typeof computePassthrough).toBe('function');
    expect(typeof isOverHouseBody).toBe('function');
    expect(isOverHouseBody(pointerInside, houseRect)).toBe(true);
    expect(isOverHouseBody(pointerOutside, houseRect)).toBe(false);
    expect(isOverHouseBody({ x: houseRect.x + 1, y: houseRect.y + 1, inside: true }, houseRect)).toBe(true);
    expect(isOverHouseBody({ x: houseRect.x + houseRect.width, y: houseRect.y + houseRect.height, inside: true }, houseRect)).toBe(true);
    expect(isOverHouseBody({ x: houseRect.x - 1, y: houseRect.y, inside: true }, houseRect)).toBe(false);
  });
});

describe('house capture and boundary contracts', () => {
  it('keeps strict thresholds and house-specific ROI gates in preview capture', async () => {
    const { THRESHOLD } = await import('../scripts/preview/capture-contract.mjs');
    expect(THRESHOLD).toEqual({ maxBoundsDelta: 1, channelDelta: 24, maxChangedRatio: 0.03 });
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).toContain('function houseSubjectRoi()');
    expect(source).toContain("metricResult(ref, cap, houseSubjectRoi(), [], HOUSE_VIEWPORT.scale, fixtureId, 'house-body')");
    // Retired: status is hover-only, assertSemanticRoi for status is absent
    expect(source).not.toContain("assertSemanticRoi(ref, cap, diagnostics.status, fixtureId, 'status')");
    // Non-hover guard: diagnostics.status is checked to be absent/blank
    expect(source).toContain('diagnostics?.status');
    expect(source).toContain('status should be hidden');
    expect(source).toContain("assertSemanticRoi(ref, cap, diagnostics.broadcast, fixtureId, 'broadcast')");
    expect(source).toContain("assertSemanticRoi(ref, cap, diagnostics.closeRect, fixtureId, 'close')");
    expect(source).toContain("assertSemanticRoi(ref, cap, diagnostics.stats, fixtureId, 'stats')");
    expect(source).toContain('reference ${label} ROI is blank');
    expect(source).toContain('broadcast-close hit rect mismatch');
    expect(source).toContain('const exactChanged = exactChangedPixels(ref, cap, houseSubjectRoi())');
    expect(source).toContain('house-body exact pixel identity differs');
  });

  it('keeps artifacts ignore entry in .gitignore', () => {
    const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('artifacts/');
  });

  it('keeps scene imports inside render/shared/sibling boundaries', () => {
    const dir = path.join(rootDir, 'src', 'features', 'house', 'scene');
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(source).not.toMatch(/from ['"]pixi\.js['"]/);
      expect(source).not.toMatch(/from ['"].*(electron|overlay|renderer|main|pet-api)/);
      expect(source).not.toMatch(/\b(document|window)\s*\./);
      expect(source).not.toMatch(/\b(petApi|dismissBroadcast)\b/);
      for (const specifier of [...source.matchAll(/from ['"][^'"]+['"]/g)].map((match) => match[0])) {
        expect(specifier).toMatch(/from ['"](\.\.?\/|.*\.\.?\/|..\/..\/render|..\/..\/shared)/);
      }
    }
  });
});

describe('house skin dispatch', () => {
  it('classic contains crates at milestone slots', async () => {
    const { updateHouseSprite, buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');
    const sprite = surface.createPixel(program);
    updateHouseSprite(sprite, 0, 0, 5, false, 0, 500000000, 0, 'classic');
    const rects = sprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    // Classic crate colors: woodLight (#B17D3E), wood (#8A5A2E), woodDark (#5B3218)
    const classicCrateColors = ['#B17D3E', '#8A5A2E', '#5B3218'];
    const crateRects = rects.filter((r) => classicCrateColors.includes(r.color));
    // 10 crates × 3 rows each = 30 crate rects
    expect(crateRects.length).toBeGreaterThanOrEqual(30);
    // No mushroom colors
    const mushroomCrateColors = ['#F2A52A', '#A87C4E', '#F2C14E', '#E9A13B'];
    const mushRects = rects.filter((r) => mushroomCrateColors.includes(r.color));
    expect(mushRects.length).toBe(0);
  });

  it('mushroom contains mini mushrooms at milestone slots', async () => {
    const { updateHouseSprite, buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('mushroom');
    const sprite = surface.createPixel(program);
    updateHouseSprite(sprite, 0, 0, 5, false, 0, 500000000, 0, 'mushroom');
    const rects = sprite.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    // Mushroom mini milestone colors: cap (#E9A13B), capLight (#F2C14E), ink (#2E2018), woodLight (#B17D3E)
    const milestoneColors = ['#E9A13B', '#F2C14E', '#2E2018', '#B17D3E'];
    const milestoneRects = rects.filter((r) => milestoneColors.includes(r.color));
    expect(milestoneRects.length).toBeGreaterThan(0);
    // No classic crate-only colors (wood #8A5A2E is shared, check woodDark #5B3218 which is exclusive to classic crates)
    const crateExclusiveColor = '#8A5A2E';
    const crateExclusiveRects = rects.filter((r) => r.color === crateExclusiveColor && (r.y === 15 || r.y === 18) && r.width === 4);
    expect(crateExclusiveRects.length).toBe(0);
  });

  it('no crow or trail pixels in either skin', async () => {
    const { buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    for (const skin of ['classic', 'mushroom'] as const) {
      const program = buildHousePixelProgram(skin);
      // Crow/trail would use dark gray or white — neither classic nor mushroom palette has these
      const suspiciousColors = ['#555555', '#AAAAAA', '#CCCCCC', '#333333', '#444444'];
      const badRects = program.rects.filter((r) => suspiciousColors.includes(r.color));
      expect(badRects.length, `no crow/trail colors in ${skin}`).toBe(0);
    }
  });

  it('classic->mushroom->classic roundtrip rebuilds identical classic program', async () => {
    const { buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const firstClassic = buildHousePixelProgram('classic');
    buildHousePixelProgram('mushroom');
    const secondClassic = buildHousePixelProgram('classic');
    expect(secondClassic.rects).toEqual(firstClassic.rects);
  });

  it('classic program with dispatchCount accepted but visually irrelevant', async () => {
    const { updateHouseSprite, buildHousePixelProgram } = await import('../src/features/house/scene/house-sprite');
    const { surface } = mockSurface();
    const program = buildHousePixelProgram('classic');

    // Same totalTokens, different dispatchCount
    const sprite0 = surface.createPixel(program);
    updateHouseSprite(sprite0, 0, 0, 5, false, 0, 50000000, 0, 'classic');
    const sprite500 = surface.createPixel(program);
    updateHouseSprite(sprite500, 0, 0, 5, false, 0, 50000000, 500, 'classic');

    const rects0 = sprite0.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    const rects500 = sprite500.program.rects as ReadonlyArray<{ x: number; y: number; width: number; height: number; color: string; alpha: number }>;
    expect(rects500).toEqual(rects0);
  });
});
