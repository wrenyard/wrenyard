import { describe, expect, it, vi } from 'vitest';
import {
  createStatsCard,
  updateStatsCard,
  STATS_RADIUS,
  STATS_LINE_HEIGHT,
  BAR_MARKER_RADIUS,
  BAR_TRACK_HEIGHT,
  INTER_PROVIDER_EXTRA_GAP,
  SAME_PROVIDER_ROW_STEP,
  STATS_MAX_WIDTH,
  STATS_MARGIN,
  STATS_PADDING_X,
  PROVIDER_LABEL_WIDTH,
  WINDOW_LABEL_WIDTH,
  BAR_PCT_WIDTH,
  buildSummaryLines,
  formatCount,
} from '../src/features/house/scene/stats-card';
import type { RenderSurface, RenderContainer, RenderGraphics, RenderText } from '../src/render';

describe('HouseStatsCard — hover tip background alpha', () => {
  it('buildSummaryLines produces the Chinese activity line plus token line', () => {
    const lines = buildSummaryLines({
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStats: { dispatchCount: 12, totalTokens: 6912, inputTokens: 1234, outputTokens: 5678, source: 'sqlite' },
      dailyStatsUnavailable: false,
    });
    expect(lines).toEqual([
      '1 个任务运行中',
      'in 1 ktok · out 6 ktok · total 7 ktok',
    ]);
  });

  it('buildSummaryLines includes queued count and graph count when present', () => {
    const lines = buildSummaryLines({
      runningWorkerCount: 2,
      queuedCount: 3,
      taskgraphCount: 4,
      dailyStats: { dispatchCount: 12, totalTokens: 6912, inputTokens: 1234, outputTokens: 5678, source: 'sqlite' },
      dailyStatsUnavailable: false,
    });
    expect(lines[0]).toBe('2 个任务运行中 · 3 个排队 · 4 张图纸');
  });

  it('buildSummaryLines keeps counts and appends 信号暂失 when activityStale', () => {
    const lines = buildSummaryLines({
      runningWorkerCount: 2,
      queuedCount: 1,
      taskgraphCount: 3,
      activityStale: true,
      dailyStats: { dispatchCount: 12, totalTokens: 6912, inputTokens: 1234, outputTokens: 5678, source: 'sqlite' },
      dailyStatsUnavailable: false,
    });
    expect(lines[0]).toBe('2 个任务运行中 · 1 个排队 · 3 张图纸');
    expect(lines[1]).toBe('信号暂失');
  });

  it('buildSummaryLines shows stats unavailable when dailyStatsUnavailable is true', () => {
    const lines = buildSummaryLines({
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: true,
    });
    expect(lines[0]).toBe('1 个任务运行中');
    expect(lines[1]).toBe('stats unavailable');
  });

  it('formatCount returns <1 ktok for positive sub-thousand values and 0 ktok for zero', () => {
    // Positive sub-thousand
    expect(formatCount(999)).toBe('<1 ktok');
    expect(formatCount(500)).toBe('<1 ktok');
    expect(formatCount(1)).toBe('<1 ktok');
    // Exact zero
    expect(formatCount(0)).toBe('0 ktok');
    // Non-positive values
    expect(formatCount(-1)).toBe('0 ktok');
  });

  it('buildSummaryLines renders <1 ktok for positive sub-thousand components', () => {
    const lines = buildSummaryLines({
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStats: { dispatchCount: 1, totalTokens: 999, inputTokens: 500, outputTokens: 499, source: 'sqlite' },
      dailyStatsUnavailable: false,
    });
    expect(lines[1]).toBe('in <1 ktok · out <1 ktok · total <1 ktok');
  });

  it('buildSummaryLines renders 0 ktok for exact zero components', () => {
    const lines = buildSummaryLines({
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStats: { dispatchCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, source: 'sqlite' },
      dailyStatsUnavailable: false,
    });
    expect(lines[1]).toBe('in 0 ktok · out 0 ktok · total 0 ktok');
  });
  function mockSurface(): RenderSurface {
    return {
      createGraphics: vi.fn(() => ({
        setCommands: vi.fn(),
        setPosition: vi.fn(),
        setScale: vi.fn(),
        setAlpha: vi.fn(),
        setVisible: vi.fn(),
        destroy: vi.fn(),
        add: vi.fn(),
        remove: vi.fn(),
      })),
      createText: vi.fn(() => {
        let currentText = '';
        return {
          setStyle: vi.fn(),
          setText: vi.fn((text: string) => { currentText = text; }),
          setPosition: vi.fn(),
          setAlpha: vi.fn(),
          setVisible: vi.fn(),
          setScale: vi.fn(),
          measure: vi.fn(() => ({ width: Array.from(currentText).length * 6, height: 10 })),
          destroy: vi.fn(),
          add: vi.fn(),
          remove: vi.fn(),
        };
      }),
      createContainer: vi.fn(() => mockContainer()),
      root: mockContainer(),
      ticker: { add: vi.fn(() => vi.fn()), start: vi.fn(), stop: vi.fn() },
    } as unknown as RenderSurface;
  }

  function mockContainer(): RenderContainer {
    return {
      add: vi.fn(),
      remove: vi.fn(),
      setVisible: vi.fn(),
      setAlpha: vi.fn(),
      setPosition: vi.fn(),
      setScale: vi.fn(),
      destroy: vi.fn(),
    } as unknown as RenderContainer;
  }

  it('uses lighter background alpha of 0.95 for hover tips', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Check the background commands include a roundedRect with the expected alpha
    const setCommandsMock = (node.background as any).setCommands;
    expect(setCommandsMock).toHaveBeenCalled();
    const commands = setCommandsMock.mock.calls[0][0];
    const rectCmd = commands.find((c: any) => c.kind === 'roundedRect');
    expect(rectCmd).toBeDefined();
    // The hover tips background should use alpha 0.95 (paper)
    expect(rectCmd.alpha).toBe(0.95);
  });

  it('renders graphical lane bars with fill representing remaining pct and expected marker', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Codex: 60%',
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
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();
    expect(result!.lines.length).toBeGreaterThanOrEqual(2);

    // Check barsGfx has been called with shape commands
    const barsGfxMock = (node.barsGfx as any).setCommands;
    expect(barsGfxMock).toHaveBeenCalled();

    const barCommands = barsGfxMock.mock.calls[0][0];
    // Should contain track background commands (roundedRect with #2E2018)
    const tracks = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018');
    expect(tracks.length).toBeGreaterThanOrEqual(2); // At least 2 windows

    // Should contain bar fills (#7BA05B)
    const fills = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#7BA05B');
    expect(fills.length).toBeGreaterThanOrEqual(2);

    // Should contain expected remaining markers (#2E2018 thin tick)
    const markers = barCommands.filter((c: any) => c.kind === 'rect' && c.fill === '#2E2018');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0].width).toBe(1);
  });

  it('renders first window (5h) above second window (7d) in bar order', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Codex: 60%',
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
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    const barsGfxMock = (node.barsGfx as any).setCommands;
    const barCommands = barsGfxMock.mock.calls[0][0];
    // 5h track should have higher y (rendered first) than 7d (rendered second)
    const tracks = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018');
    expect(tracks[0].y).toBeLessThanOrEqual(tracks[1].y);
  });

  it('renders provider-level bars as a single synthetic quota lane', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Codex: month 55%',
        bars: [{
          provider: {
            remainingPct: 55,
            expectedRemainingPct: 30,
            windows: [
              { name: 'quota', usedPct: 45, remainingPct: 55, expectedRemainingPct: 30 },
            ],
          },
          label: 'Codex',
          error: null,
          status: 'ok',
          stale: false,
        }],
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();
    expect(result!.lines).toEqual(
      expect.arrayContaining([expect.stringMatching(/Codex/)])
    );

    const barsGfxMock = (node.barsGfx as any).setCommands;
    expect(barsGfxMock).toHaveBeenCalled();
  });

  it('shows error provider as structured error row with message at track column', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'OpenAI error — rate limited',
        bars: [{
          provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
          label: 'OpenAI',
          error: 'rate limited',
          status: 'error',
          stale: false,
        }],
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();
    // Line should contain the error message (derived from bar data, no colon)
    expect(result!.lines.some((line) => line.includes('error — rate limited'))).toBe(true);
  });

  it('groups same-provider window bars closer than different-provider rows', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
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
              windows: [
                { name: '5h', usedPct: 20, remainingPct: 80, expectedRemainingPct: 50 },
              ],
            },
            label: 'OpenAI',
            error: null,
            status: 'ok',
            stale: false,
          }],
        },
      ],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    const barsGfxMock = (node.barsGfx as any).setCommands;
    expect(barsGfxMock).toHaveBeenCalled();
    const barCommands = barsGfxMock.mock.calls[0][0];
    const tracks = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018');
    // 3 tracks: Codex 5h, Codex 7d, OpenAI 5h
    expect(tracks.length).toBe(3);

    // Gap between same-provider rows (Codex 5h → Codex 7d)
    const sameGap = tracks[1].y - tracks[0].y;
    // Gap between different-provider rows (Codex 7d → OpenAI 5h)
    const diffGap = tracks[2].y - tracks[1].y;

    // All rows currently use equal STATS_LINE_HEIGHT (12.5px) spacing.
    // After rounding, gaps land at 12–13px. The +2 threshold cleanly
    // separates truly compressed gaps (~6px) from full-height spacing.
    expect(sameGap + 2).toBeLessThan(diffGap);
  });

  it('renders Kimi three-pool quota with correct lines, tracks, and column positions', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Kimi: 60%, 90%, 27.5%',
        bars: [{
          provider: {
            remainingPct: 27.5,
            expectedRemainingPct: null,
            windows: [
              { name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 },
              { name: '7d', usedPct: 10, remainingPct: 90, expectedRemainingPct: 50 },
              { name: '1mo', usedPct: 72.5, remainingPct: 27.5, expectedRemainingPct: null },
            ],
          },
          label: 'Kimi',
          error: null,
          status: 'ok',
          stale: false,
        }],
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Result lines contain all three Kimi pools.
    expect(result!.lines).toEqual(expect.arrayContaining(['Kimi 5h', 'Kimi 7d', 'Kimi 1mo']));

    // Three track commands (one per window: 5h, 7d, 1mo)
    const barsGfxMock = (node.barsGfx as any).setCommands;
    expect(barsGfxMock).toHaveBeenCalled();
    const barCommands = barsGfxMock.mock.calls[0][0];
    const tracks = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018');
    expect(tracks.length).toBe(3);

    // Provider label visible only on the first Kimi row (groupStart)
    expect(node.providerNodes[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(node.providerNodes[1].setVisible).toHaveBeenLastCalledWith(false);
    expect(node.providerNodes[2].setVisible).toHaveBeenLastCalledWith(false);

    // Geometry: provider and window text are left of the track
    const tileX = 30; // result.x = clamp(round(50+100-120), 2, 1678) = 30
    const providerLabelX = tileX + 6; // x + STATS_PADDING_X
    const windowLabelX = providerLabelX + 78; // + PROVIDER_LABEL_WIDTH
    const trackX = windowLabelX + 30; // + WINDOW_LABEL_WIDTH

    const provPos0 = node.providerNodes[0].setPosition.mock.calls.slice(-1)[0];
    expect(provPos0[0]).toBe(providerLabelX);
    expect(provPos0[0]).toBeLessThan(trackX);

    const winPos0 = node.windowNodes[0].setPosition.mock.calls.slice(-1)[0];
    expect(winPos0[0]).toBe(windowLabelX);
    expect(winPos0[0]).toBeLessThan(trackX);

    // Percentage text is positioned to the right of the track
    const pctPos0 = node.pctNodes[0].setPosition.mock.calls.slice(-1)[0];
    expect(pctPos0[0]).toBeGreaterThan(trackX);
  });

  it('renders full width without ellipsis when bars are present', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Codex: 60%',
        bars: [{
          provider: {
            remainingPct: 60,
            expectedRemainingPct: 35,
            windows: [
              { name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 },
            ],
          },
          label: 'Codex',
          error: null,
          status: 'ok',
          stale: false,
        }],
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();
    // No ellipsis in any bar line
    for (const line of result!.lines) {
      expect(line).not.toContain('\u2026');
    }
  });

  it('normalizes and fits successful bar-window provider label and window name with hard line separators and over-width content', () => {
    function measureWidth(text: string): number {
      return Array.from(text).length * 7;
    }

    function mockSurfaceWithFittedMeasure(): RenderSurface {
      return {
        createGraphics: vi.fn(() => ({
          setCommands: vi.fn(),
          setPosition: vi.fn(),
          setScale: vi.fn(),
          setAlpha: vi.fn(),
          setVisible: vi.fn(),
          destroy: vi.fn(),
          add: vi.fn(),
          remove: vi.fn(),
        })),
        createText: vi.fn(() => {
          let currentText = '';
          return {
            setStyle: vi.fn(),
            setText: vi.fn((text: string) => { currentText = text; }),
            setPosition: vi.fn(),
            setAlpha: vi.fn(),
            setVisible: vi.fn(),
            setScale: vi.fn(),
            measure: vi.fn(() => ({ width: measureWidth(currentText), height: 10 })),
            destroy: vi.fn(),
            add: vi.fn(),
            remove: vi.fn(),
          };
        }),
        createContainer: vi.fn(() => mockContainer()),
        root: mockContainer(),
        ticker: { add: vi.fn(() => vi.fn()), start: vi.fn(), stop: vi.fn() },
      } as unknown as RenderSurface;
    }

    const surface = mockSurfaceWithFittedMeasure();
    const container = mockContainer();
    const node = createStatsCard(container, surface);

    // Provider label with hard separators exceeding PROVIDER_LABEL_WIDTH (72px / 7 = ~10 chars)
    const labelWithSeparators = 'Super\r\nLong\u2028ProviderNameThatTruncates';
    // Window name exceeding WINDOW_LABEL_WIDTH (30px / 7 = ~4 chars)
    const longWindowName = 'veeery\nlooong\u2029window';

    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Test: 60%',
        bars: [{
          provider: {
            remainingPct: 60,
            expectedRemainingPct: 35,
            windows: [{ name: longWindowName, usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 }],
          },
          label: labelWithSeparators,
          error: null,
          status: 'ok',
          stale: false,
        }],
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Result lines contain no hard separators
    for (const line of result!.lines) {
      expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    }

    // Provider text node contains no hard separators
    const providerNode = node.providerNodes[0];
    expect(providerNode.setVisible).toHaveBeenCalledWith(true);
    const providerText = (providerNode.setText as any).mock.calls.slice(-1)[0][0];
    expect(providerText).not.toMatch(/[\r\n\u2028\u2029]/);

    // Window text node contains no hard separators
    const windowNode = node.windowNodes[0];
    expect(windowNode.setVisible).toHaveBeenCalledWith(true);
    const windowText = (windowNode.setText as any).mock.calls.slice(-1)[0][0];
    expect(windowText).not.toMatch(/[\r\n\u2028\u2029]/);

    // Measured widths stay within column bounds
    expect(measureWidth(providerText)).toBeLessThanOrEqual(PROVIDER_LABEL_WIDTH);
    expect(measureWidth(windowText)).toBeLessThanOrEqual(WINDOW_LABEL_WIDTH);

    // Both displayed values end with ellipsis since they exceed their columns
    expect(providerText.endsWith('\u2026')).toBe(true);
    expect(windowText.endsWith('\u2026')).toBe(true);

    // Bar track still renders
    const barsGfxMock = (node.barsGfx as any).setCommands;
    expect(barsGfxMock).toHaveBeenCalled();
    const barCommands = barsGfxMock.mock.calls[0][0];
    const tracks = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018');
    expect(tracks.length).toBe(1);

    // Percentage still renders
    const pctNode = node.pctNodes[0];
    expect(pctNode.setVisible).toHaveBeenCalledWith(true);
  });

  it('adds inter-provider gap before structured error row after multi-window successful provider', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
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
          text: 'OpenAI error — rate limited',
          bars: [{
            provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
            label: 'OpenAI',
            error: 'rate limited',
            status: 'error',
            stale: false,
          }],
        },
      ],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Assert error-row appears in output lines (label + message, no colon)
    expect(result!.lines.some((line) => line.includes('rate limited'))).toBe(true);
    expect(result!.lines.some((line) => line.includes('OpenAI'))).toBe(true);

    const barsGfxMock = (node.barsGfx as any).setCommands;
    expect(barsGfxMock).toHaveBeenCalled();
    const barCommands = barsGfxMock.mock.calls[0][0];
    const tracks = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018');
    // 2 tracks (Codex 5h, Codex 7d), no track for error row
    expect(tracks.length).toBe(2);

    // Error row text Y from providerNodes[2] (index 2: Codex 5h=0, Codex 7d=1, OpenAI error=2)
    const errorTextY = (node.providerNodes[2].setPosition as any).mock.calls.slice(-1)[0][1];

    // Last successful window row Y from windowNodes[1] (Codex 7d, index 1)
    const lastWindowY = (node.windowNodes[1].setPosition as any).mock.calls.slice(-1)[0][1];

    // The gap from the last window row origin to the error text row origin must be
    // SAME_PROVIDER_ROW_STEP (normal row advance) + INTER_PROVIDER_EXTRA_GAP (inter-provider gap).
    // Using the window Y directly avoids rounding artifacts from half-pixel row origins.
    expect(errorTextY - lastWindowY).toBe(SAME_PROVIDER_ROW_STEP + INTER_PROVIDER_EXTRA_GAP);

    // errorTextY should be greater than tracks[1].y by at least the extra gap + track offset
    expect(errorTextY).toBeGreaterThan(tracks[1].y);

    // Background height should enclose the error text row
    const bgCommands = (node.background as any).setCommands.mock.calls[0][0];
    const bgCmd = bgCommands.find((c: any) => c.kind === 'roundedRect');
    expect(bgCmd).toBeDefined();
    // Error text at errorTextY, with line height STATS_LINE_HEIGHT, should fit in background
    expect(errorTextY).toBeGreaterThanOrEqual(bgCmd.y);
    expect(errorTextY + STATS_LINE_HEIGHT).toBeLessThanOrEqual(bgCmd.y + bgCmd.height);
  });

  it('truncates long structured error text row to fit within card width using measurement-based ellipsis', () => {
    function measureWidth(text: string): number {
      return Array.from(text).length * 10;
    }

    function mockSurfaceWithLongText(): RenderSurface {
      return {
        createGraphics: vi.fn(() => ({
          setCommands: vi.fn(),
          setPosition: vi.fn(),
          setScale: vi.fn(),
          setAlpha: vi.fn(),
          setVisible: vi.fn(),
          destroy: vi.fn(),
          add: vi.fn(),
          remove: vi.fn(),
        })),
        createText: vi.fn(() => {
          let currentText = '';
          return {
            setStyle: vi.fn(),
            setText: vi.fn((text: string) => { currentText = text; }),
            setPosition: vi.fn(),
            setAlpha: vi.fn(),
            setVisible: vi.fn(),
            setScale: vi.fn(),
            measure: vi.fn(() => ({ width: measureWidth(currentText), height: 10 })),
            destroy: vi.fn(),
            add: vi.fn(),
            remove: vi.fn(),
          };
        }),
        createContainer: vi.fn(() => mockContainer()),
        root: mockContainer(),
        ticker: { add: vi.fn(() => vi.fn()), start: vi.fn(), stop: vi.fn() },
      } as unknown as RenderSurface;
    }

    const surface = mockSurfaceWithLongText();
    const container = mockContainer();
    const node = createStatsCard(container, surface);

    const longError = 'OpenAI: unexpected server error — upstream quota system returned 503';
    const fittingError = 'Sign-in is in progress. Approve the request if prompted.';

    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
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
          text: fittingError,
          errorRow: { label: 'codex-spark', message: 'Sign-in is in progress. Approve the request if prompted.' },
          bars: [{
            provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
            label: 'codex-spark',
            error: 'Sign-in is in progress. Approve the request if prompted.',
            status: 'pending',
            stale: false,
          }],
        },
        {
          text: 'OpenAI error — upstream server error with a very long message that should be truncated',
          errorRow: { label: 'OpenAI', message: 'upstream\r\nserver\nerror\u2028with a very long message that should be truncated' },
          bars: [{
            provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
            label: 'OpenAI',
            error: 'upstream error',
            status: 'error',
            stale: false,
          }],
        },
        {
          text: 'Other:\r\nfail\u2028now',
          bars: [{
            provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
            label: 'Other',
            error: 'x\r\ny\u2028z',
            status: 'error',
            stale: false,
          }],
        },
      ],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Error message for long OpenAI errorRow ends with ellipsis
    const openaiLine = result!.lines.find((line) => line.startsWith('OpenAI'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine!.endsWith('\u2026')).toBe(true);

    // The fitted text width fits within track-plus-percent width
    const contentMaxWidth = result!.width - STATS_PADDING_X * 2;
    const fittedWidth = measureWidth(openaiLine!);
    expect(fittedWidth).toBeLessThanOrEqual(contentMaxWidth);

    // The fitted text appears in result.lines
    expect(result!.lines).toContain(openaiLine);

    // Rendered message node (windowNodes[3] = OpenAI) uses same fitted text as diagnostics
    const openaiMsgNodeText = (node.windowNodes[3].setText as any).mock.calls.slice(-1)[0][0];
    const openaiLineAfterLabel = openaiLine!.slice('OpenAI '.length);
    expect(openaiMsgNodeText).toBe(openaiLineAfterLabel);

    // OpenAI message node contains no hard separators (normalized by fitLineToWidth)
    expect(openaiMsgNodeText).not.toMatch(/[\r\n\u2028\u2029]/);

    // codex-spark pending row uses explicit errorRow label and message.
    // Both the diagnostics line and the rendered provider label fit the provider
    // id into the 78px PROVIDER_LABEL_WIDTH column, sharing the same fixed-width
    // fit contract, so both render the fitted label 'codex-…'.
    const fittedPendingLabel = 'codex-\u2026 ';
    const pendingLine = result!.lines.find((line) => line.startsWith(fittedPendingLabel));
    expect(pendingLine).toBeDefined();
    expect(pendingLine).not.toContain(':');
    // Rendered provider node shares the same fixed-width fit contract as the
    // diagnostics line, so it renders the fitted 'codex-…' label as well.
    const pendingProviderText = (node.providerNodes[2].setText as any).mock.calls.slice(-1)[0][0];
    expect(pendingProviderText).toBe('codex-\u2026');
    // Rendered message node equals the fitted diagnostics suffix
    const pendingMsgNodeText = (node.windowNodes[2].setText as any).mock.calls.slice(-1)[0][0];
    const pendingLineAfterLabel = pendingLine!.slice(fittedPendingLabel.length);
    expect(pendingMsgNodeText).toBe(pendingLineAfterLabel);

    // Provider-to-error Y delta: from Codex 7d (last window) to pending row (first error text)
    const lastWindowY = (node.windowNodes[1].setPosition as any).mock.calls.slice(-1)[0][1];
    const firstErrorTextY = (node.providerNodes[2].setPosition as any).mock.calls.slice(-1)[0][1];
    expect(firstErrorTextY - lastWindowY).toBe(SAME_PROVIDER_ROW_STEP + INTER_PROVIDER_EXTRA_GAP);

    // Error message from compatibility bar data, no hard separators — short label, short raw error
    const otherLine = result!.lines.find((line) => line.includes('Other'));
    expect(otherLine).toBeDefined();
    expect(otherLine).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(otherLine).toMatch(/^Other error — x y/);
    expect(otherLine!.endsWith('\u2026')).toBe(false);

    // No hard line separators in any result line
    for (const line of result!.lines) {
      expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    }

    // Displayed provider node text also has no hard line separators
    const otherNode = node.providerNodes[4];
    expect(otherNode.setVisible).toHaveBeenCalledWith(true);
    const otherNodeText = (otherNode.setText as any).mock.calls.slice(-1)[0][0];
    expect(otherNodeText).not.toMatch(/[\r\n\u2028\u2029]/);

    // Fitted text width within card content width
    const otherWidth = measureWidth(otherLine!);
    expect(otherWidth).toBeLessThanOrEqual(contentMaxWidth);
  });

  it('renders errorRow-only tip with label at provider column and message at track column (no bars)', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'OpenAI error — rate limited',
        errorRow: { label: 'OpenAI', message: 'error — rate limited' },
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Tile x = clamp(round(50+100-120), 2, 1678) = 30
    const tileX = 30;
    const expectedProviderLabelX = tileX + STATS_PADDING_X;
    const expectedTrackX = expectedProviderLabelX + PROVIDER_LABEL_WIDTH + WINDOW_LABEL_WIDTH;

    // Provider label text must NOT contain colon or error details
    const providerText = (node.providerNodes[0].setText as any).mock.calls.slice(-1)[0][0];
    expect(providerText).not.toContain(':');
    expect(providerText).toBe('OpenAI');

    // Provider label at providerLabelX
    const provPos = (node.providerNodes[0].setPosition as any).mock.calls.slice(-1)[0];
    expect(provPos[0]).toBe(expectedProviderLabelX);

    // Message rendered at windowLabelX, using full window-plus-track-plus-percentage width
    expect(node.windowNodes[0].setVisible).toHaveBeenCalledWith(true);
    const errorText = (node.windowNodes[0].setText as any).mock.calls.slice(-1)[0][0];
    expect(errorText).toBe('error — rate limited');
    const windowLabelX = expectedProviderLabelX + PROVIDER_LABEL_WIDTH;
    const windowPos = (node.windowNodes[0].setPosition as any).mock.calls.slice(-1)[0];
    expect(windowPos[0]).toBe(windowLabelX);

    // No bar tracks, markers, or percentage
    expect(node.pctNodes[0].setVisible).toHaveBeenCalledWith(false);
    const barsGfxMock = (node.barsGfx as any).setCommands;
    expect(barsGfxMock).toHaveBeenCalled();
    const barCommands = barsGfxMock.mock.calls[0][0];
    const tracks = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018');
    expect(tracks.length).toBe(0);
  });

  it('renders error-row message column at windowLabelX using full window-plus-track-plus-percentage width (structured and compatibility)', () => {
    function measureWidth(text: string): number {
      return Array.from(text).length * 6;
    }

    function mockSurfaceControlled(): RenderSurface {
      return {
        createGraphics: vi.fn(() => ({
          setCommands: vi.fn(),
          setPosition: vi.fn(),
          setScale: vi.fn(),
          setAlpha: vi.fn(),
          setVisible: vi.fn(),
          destroy: vi.fn(),
          add: vi.fn(),
          remove: vi.fn(),
        })),
        createText: vi.fn(() => {
          let currentText = '';
          return {
            setStyle: vi.fn(),
            setText: vi.fn((text: string) => { currentText = text; }),
            setPosition: vi.fn(),
            setAlpha: vi.fn(),
            setVisible: vi.fn(),
            setScale: vi.fn(),
            measure: vi.fn(() => ({ width: measureWidth(currentText), height: 10 })),
            destroy: vi.fn(),
            add: vi.fn(),
            remove: vi.fn(),
          };
        }),
        createContainer: vi.fn(() => mockContainer()),
        root: mockContainer(),
        ticker: { add: vi.fn(() => vi.fn()), start: vi.fn(), stop: vi.fn() },
      } as unknown as RenderSurface;
    }

    const surface = mockSurfaceControlled();
    const container = mockContainer();
    const node = createStatsCard(container, surface);

    const errorMessage = 'rate limited — upstream 503';

    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 7, totalTokens: 1540, inputTokens: 1200, outputTokens: 340, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'OpenAI error — rate limited',
        errorRow: { label: 'OpenAI', message: errorMessage },
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Tile x = clamp(round(50+100-120), 2, 1678) = 30
    const tileX = 30;
    const providerLabelX = tileX + STATS_PADDING_X;
    const expectedWindowLabelX = providerLabelX + PROVIDER_LABEL_WIDTH;
    const trackX = expectedWindowLabelX + WINDOW_LABEL_WIDTH;
    const contentMaxWidth = STATS_MAX_WIDTH - STATS_PADDING_X * 2;
    const trackW = Math.max(30, contentMaxWidth - PROVIDER_LABEL_WIDTH - WINDOW_LABEL_WIDTH - BAR_PCT_WIDTH);

    // Provider label at providerLabelX (unchanged behaviour)
    const provPos = (node.providerNodes[0].setPosition as any).mock.calls.slice(-1)[0];
    expect(provPos[0]).toBe(providerLabelX);

    // Error message node x must equal windowLabelX, NOT trackX
    const msgPos = (node.windowNodes[0].setPosition as any).mock.calls.slice(-1)[0];
    expect(msgPos[0]).toBe(expectedWindowLabelX);
    expect(msgPos[0]).not.toBe(trackX);

    // Fitted message uses WINDOW_LABEL_WIDTH + trackW + BAR_PCT_WIDTH (156)
    const fittedText = (node.windowNodes[0].setText as any).mock.calls.slice(-1)[0][0];
    const fittedWidth = measureWidth(fittedText);
    expect(fittedWidth).toBeLessThanOrEqual(WINDOW_LABEL_WIDTH + trackW + BAR_PCT_WIDTH);

    // No bar tracks or percentage
    expect(node.pctNodes[0].setVisible).toHaveBeenCalledWith(false);
    const barsGfxMock = (node.barsGfx as any).setCommands;
    expect(barsGfxMock).toHaveBeenCalled();
    const barCommands = barsGfxMock.mock.calls[0][0];
    const tracks = barCommands.filter((c: any) => c.kind === 'roundedRect' && c.fill === '#2E2018');
    expect(tracks.length).toBe(0);
  });

  it('expands bars-card width to contain long mtok summary line without truncation on normal viewport', () => {
    const surface = mockSurface();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 314, totalTokens: 193000000, inputTokens: 191000000, outputTokens: 2000000, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Codex: 60%',
        bars: [{
          provider: {
            remainingPct: 60,
            expectedRemainingPct: 35,
            windows: [{ name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 }],
          },
          label: 'Codex',
          error: null,
          status: 'ok',
          stale: false,
        }],
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 1920,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Second summary line is the full mtok line, not truncated
    expect(result!.lines[1]).toBe('in 191 mtok · out 2 mtok · total 193 mtok');

    // Card width expands beyond STATS_MAX_WIDTH to accommodate the long summary
    expect(result!.width).toBeGreaterThan(STATS_MAX_WIDTH);

    // Second-line measured width fits inside card content area
    const expectedSecondWidth = Array.from('in 191 mtok · out 2 mtok · total 193 mtok').length * 6;
    expect(expectedSecondWidth).toBeLessThanOrEqual(result!.width - STATS_PADDING_X * 2);

    // Layout stays within viewport margins
    expect(result!.x).toBeGreaterThanOrEqual(STATS_MARGIN);
    expect(result!.x + result!.width + STATS_MARGIN).toBeLessThanOrEqual(1920);
  });

  it('truncates long mtok summary with ellipsis on narrow viewport', () => {
    function narrowMeasureWidth(text: string): number {
      return Array.from(text).length * 6;
    }

    function mockSurfaceNarrow(): RenderSurface {
      return {
        createGraphics: vi.fn(() => ({
          setCommands: vi.fn(),
          setPosition: vi.fn(),
          setScale: vi.fn(),
          setAlpha: vi.fn(),
          setVisible: vi.fn(),
          destroy: vi.fn(),
          add: vi.fn(),
          remove: vi.fn(),
        })),
        createText: vi.fn(() => {
          let currentText = '';
          return {
            setStyle: vi.fn(),
            setText: vi.fn((text: string) => { currentText = text; }),
            setPosition: vi.fn(),
            setAlpha: vi.fn(),
            setVisible: vi.fn(),
            setScale: vi.fn(),
            measure: vi.fn(() => ({ width: narrowMeasureWidth(currentText), height: 10 })),
            destroy: vi.fn(),
            add: vi.fn(),
            remove: vi.fn(),
          };
        }),
        createContainer: vi.fn(() => mockContainer()),
        root: mockContainer(),
        ticker: { add: vi.fn(() => vi.fn()), start: vi.fn(), stop: vi.fn() },
      } as unknown as RenderSurface;
    }

    const surface = mockSurfaceNarrow();
    const container = mockContainer();

    const node = createStatsCard(container, surface);
    const result = updateStatsCard(node, {
      dailyStats: { dispatchCount: 314, totalTokens: 193000000, inputTokens: 191000000, outputTokens: 2000000, source: 'sqlite' },
      runningWorkerCount: 1,
      queuedCount: 0,
      dailyStatsUnavailable: false,
      quotaTips: [{
        text: 'Codex: 60%',
        bars: [{
          provider: {
            remainingPct: 60,
            expectedRemainingPct: 35,
            windows: [{ name: '5h', usedPct: 40, remainingPct: 60, expectedRemainingPct: 45 }],
          },
          label: 'Codex',
          error: null,
          status: 'ok',
          stale: false,
        }],
      }],
      pointer: { x: 100, y: 100, inside: true },
      dragging: false,
      houseRect: { x: 50, y: 50, width: 200, height: 150 },
      viewportWidth: 250,
      viewportHeight: 1080,
    });

    expect(result).toBeDefined();

    // Second summary line ends with ellipsis due to viewport cap
    expect(result!.lines[1].endsWith('\u2026')).toBe(true);

    // Fitted second-line measured width stays within the card content area
    const fittedWidth = narrowMeasureWidth(result!.lines[1]);
    expect(fittedWidth).toBeLessThanOrEqual(result!.width - STATS_PADDING_X * 2);

    // Layout stays within the narrow viewport margins
    expect(result!.x).toBeGreaterThanOrEqual(STATS_MARGIN);
    expect(result!.x + result!.width + STATS_MARGIN).toBeLessThanOrEqual(250);
  });
});
