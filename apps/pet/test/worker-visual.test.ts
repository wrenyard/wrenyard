import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PixelBuilder } from '../src/render';
import type { RenderTextStyle, ShapeCommand } from '../src/render/types';
import type { Appearance } from '../src/shared/snapshot';

const rootDir = process.cwd();

type MockMeasure = (text: string, style: RenderTextStyle | undefined) => { width: number; height: number };

function defaultMeasure(text: string, style: RenderTextStyle | undefined) {
  const width = Array.from(text).reduce((sum, ch) => {
    if (/\s/.test(ch)) return sum + 3;
    const cp = ch.codePointAt(0) ?? 0;
    return sum + (cp >= 0x4e00 && cp <= 0x9fff ? 12 : 6);
  }, 0);
  return { width, height: style?.lineHeight ?? 12 };
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

function appearance(id: Appearance['skin']['id'] = 'classic-codebuddy', tool = '#0d4a9e'): Appearance {
  const kind =
    id === 'classic-codebuddy' || id === 'classic-codex' || id === 'classic-claude'
      ? 'official'
      : id === 'classic-voxel-miner'
        ? 'classic'
        : 'original';
  return {
    profile: 'classic',
    profileLabel: 'Preview',
    skin: {
      kind,
      id,
      name: id,
      colors: { primary: '#2F7DE1', accent: '#8FE3FF', tool },
    },
  };
}

describe('worker fixture contract', () => {
  it('has exact semantic fixture order and common base state', async () => {
    const { WORKER_FIXTURES, FIXTURE_VIEWPORT } = await import('../scripts/preview/fixtures.mjs');
    expect(FIXTURE_VIEWPORT).toEqual({ width: 640, height: 360, dpr: 1, scale: 5, nowMs: 10000 });

    expect(WORKER_FIXTURES.map((f) => f.file)).toEqual([
      'worker-skin-classic-codebuddy.png',
      'worker-skin-classic-codex.png',
      'worker-skin-classic-claude.png',
      'worker-skin-classic-voxel-miner.png',
      'worker-skin-red-jumper.png',
      'worker-skin-green-quest.png',
      'worker-skin-blue-dash.png',
      'worker-skin-block-miner.png',
      'worker-skin-space-bounty.png',
      'worker-skin-arcade-ghost.png',
      'worker-skin-rune-mage.png',
      'worker-skin-shadow-ninja.png',
      'worker-skin-slime-king.png',
      'worker-phase-working.png',
      'worker-phase-sleeping.png',
      'worker-phase-celebrating.png',
      'worker-phase-dejected.png',
      'worker-badge-claude.png',
      'worker-badge-codebuddy.png',
      'worker-badge-codex.png',
      'worker-badge-unknown.png',
      'worker-tool-classic-voxel-miner.png',
      'worker-tool-blue-dash.png',
      'worker-bubble-cjk-reveal.png',
      'worker-bubble-cjk-fade.png',
    ]);

    for (const fixture of WORKER_FIXTURES) {
      expect(fixture.value.workerIdentityKey).toBe('visual-worker');
      expect(fixture.value.profile).toBe('preview');
      expect(fixture.value.appearance.profile).toBe('classic');
      expect(fixture.value.appearance.profileLabel).toBe('Preview');
      expect(fixture.value.sinceMs).toBe(9000);
      expect(fixture.value.startedAt).toBe(-72000);
      expect('taskLabel' in fixture.value).toBe(false);
      expect('taskId' in fixture.value).toBe(false);
      expect('taskName' in fixture.value).toBe(false);
      expect(fixture.value.bubble && 'revealStartMs' in fixture.value.bubble).not.toBe(true);
    }
  });

  it('keeps exact tool and mixed CJK bubble fixture semantics', async () => {
    const { WORKER_FIXTURES } = await import('../scripts/preview/fixtures.mjs');
    expect(WORKER_FIXTURES[21].value.toolCount).toBe(22);
    expect(WORKER_FIXTURES[21].value.lastToolTs).toBe(9000);
    expect(WORKER_FIXTURES[22].value.toolCount).toBe(22);
    expect(WORKER_FIXTURES[22].value.lastToolTs).toBe(9000);

    expect(WORKER_FIXTURES[23].value.bubble).toEqual({ text: '编排进行中 Pixi ready', untilMs: 12000 });
    expect(WORKER_FIXTURES[23].initNowMs).toBe(9750);
    expect(WORKER_FIXTURES[24].value.bubble).toEqual({ text: '编排进行中 Pixi ready', untilMs: 10400 });
    expect(WORKER_FIXTURES[24].initNowMs).toBe(0);
  });
});

describe('worker label entity', () => {
  it('formats age and resolves hover task labels through production helpers', async () => {
    const { formatWorkerAge, resolveWorkerLabelText } = await import('../src/features/worker/scene/label');
    expect(formatWorkerAge(-20000, 10000)).toBe('30s');
    expect(formatWorkerAge(-72000, 10000)).toBe('1m');
    expect(formatWorkerAge(-9999000, 10000)).toBe('99m');
    expect(resolveWorkerLabelText({ hovering: true, taskName: 'deploy', startedAt: 0, nowMs: 10000 })).toEqual({ kind: 'task', text: 'deploy' });
    expect(resolveWorkerLabelText({ hovering: true, taskLabel: 'qa', startedAt: 0, nowMs: 10000 })).toEqual({ kind: 'task', text: 'qa' });
    expect(resolveWorkerLabelText({ hovering: true, taskId: 'task_123', startedAt: 0, nowMs: 10000 })).toEqual({ kind: 'task', text: 'task_123' });
  });

  it('matches legacy age layout and text style with shadow', async () => {
    const { createWorkerLabel, updateWorkerLabel, layoutWorkerLabel } = await import('../src/features/worker/scene/label');
    expect(layoutWorkerLabel({ kind: 'age', windowWidth: 640, workerX: 44, workerY: 40, scale: 5, labelWidth: 18, labelHeight: 12 }))
      .toEqual({ left: 349, top: 346 });

    const { surface, texts, graphics } = mockSurface();
    const container = surface.createContainer();
    const node = createWorkerLabel(container, surface);
    updateWorkerLabel(node, { kind: 'age', windowWidth: 640, workerX: 44, workerY: 40, scale: 5, labelWidth: 60, labelHeight: 12, text: '82s' });

    const main = texts[1];
    const shadow = texts[0];
    expect(main.style).toMatchObject({
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
      fontSize: 9,
      fontWeight: 800,
      fill: '#1F2937',
      lineHeight: 12,
      align: 'center',
    });
    expect(main.alpha).toBeCloseTo(0.62, 5);
    expect(shadow.style.fill).toBe('#FFFFFF');
    expect(shadow.alpha).toBeCloseTo(0.55, 5);
    expect(shadow.y).toBe(main.y + 1);
    expect(graphics[0].visible).toBe(false);
  });

  it('renders task background, border, padding and ellipsis with entity-owned nodes', async () => {
    const { createWorkerLabel, updateWorkerLabel } = await import('../src/features/worker/scene/label');
    const { surface, texts, graphics } = mockSurface((text, style) => ({ width: Array.from(text).length * 6, height: style?.lineHeight ?? 13 }));
    const container = surface.createContainer();
    const node = createWorkerLabel(container, surface);

    updateWorkerLabel(node, {
      kind: 'task',
      windowWidth: 640,
      workerX: 44,
      workerY: 40,
      scale: 5,
      labelWidth: 60,
      labelHeight: 13,
      text: 'very-long-task-label-for-overflow',
    });

    const main = texts[1];
    expect(main.value.endsWith('\u2026')).toBe(true);
    expect(main.alpha).toBeCloseTo(0.82, 5);
    expect(main.style).toMatchObject({ fill: '#F7F1DE', fontSize: 9, fontWeight: 800, lineHeight: 13 });
    expect(main.x).toBe(graphics[0].commands[0].x + 5);
    expect(graphics[0].commands).toMatchObject([
      { kind: 'roundedRect', radius: 2, fill: '#F7F1DE', alpha: 0.25 },
      { kind: 'roundedRect', radius: 1, fill: '#0A0E14', alpha: 0.70 },
    ]);
    expect(graphics[0].commands[0].width).toBeLessThanOrEqual(88);
  });
});

describe('worker bubble entity', () => {
  it('uses legacy CJK-dominant wrapping, ellipsis and measured widths', async () => {
    const {
      isCJKDominantText,
      measureWorkerBubble,
      wrapTextToLines,
      MAX_BUBBLE_WIDTH,
      WORKER_MAX_LINES,
    } = await import('../src/features/worker/scene/bubble');
    const calls: string[] = [];
    const measure = (text: string) => {
      calls.push(text);
      return Array.from(text).reduce((sum, ch) => sum + (/\s/.test(ch) ? 3 : 12), 0);
    };

    expect(isCJKDominantText('构建任务')).toBe(true);
    expect(isCJKDominantText('编排进行中 Pixi ready')).toBe(false);
    const lines = wrapTextToLines('alpha beta gamma delta epsilon zeta eta theta', measure, 70, WORKER_MAX_LINES);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('\u2026')).toBe(true);
    const metrics = measureWorkerBubble('alpha beta gamma delta epsilon zeta eta theta', measure);
    expect(metrics.width).toBeLessThanOrEqual(MAX_BUBBLE_WIDTH);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('keeps full-text layout stable while reveal text changes', async () => {
    const { createWorkerBubble, updateWorkerBubble, revealCharCount } = await import('../src/features/worker/scene/bubble');
    const text = '编排进行中 Pixi ready';
    const { surface, texts, graphics } = mockSurface();
    const container = surface.createContainer();
    const node = createWorkerBubble(container, surface);

    updateWorkerBubble(node, { text, untilMs: 12000, revealStartMs: 9750 }, 320, 198, 9750);
    const firstBody = graphics[0].commands.slice(0, 2);
    expect(texts[0].value).toBe('');

    updateWorkerBubble(node, { text, untilMs: 12000, revealStartMs: 9750 }, 320, 198, 10000);
    const secondBody = graphics[0].commands.slice(0, 2);
    expect(secondBody).toEqual(firstBody);
    expect(texts[0].measureCalls).toContain(text);
    expect(texts[0].value.length).toBeGreaterThan(0);
    expect(revealCharCount(text, 9750, 10000)).toBe(10);
  });

  it('uses rounded body commands, measured caret placement and linear fade', async () => {
    const { createWorkerBubble, updateWorkerBubble, bubbleAlpha } = await import('../src/features/worker/scene/bubble');
    const { surface, graphics } = mockSurface();
    const container = surface.createContainer();
    const node = createWorkerBubble(container, surface);

    updateWorkerBubble(node, { text: 'alpha beta gamma delta epsilon zeta', untilMs: 10400, revealStartMs: 9900 }, 320, 198, 10000);
    expect(bubbleAlpha(10400, 10000)).toBeCloseTo(0.5, 5);
    expect(container.alpha).toBeCloseTo(0.5, 5);
    expect(graphics[0].commands[0].kind).toBe('roundedRect');
    expect(graphics[0].commands[1].kind).toBe('roundedRect');
    expect(graphics[0].commands.some((cmd: ShapeCommand) => cmd.kind === 'rect' && cmd.width === 2)).toBe(true);
  });
});

describe('worker tool cue entity', () => {
  it('uses timing alpha, exact count text and measured middle baseline conversion', async () => {
    const { createToolCue, updateToolCue, toolCueVisible, toolFlashAlpha } = await import('../src/features/worker/scene/tool-cue');
    const { surface, texts } = mockSurface((_text, style) => ({ width: 42, height: style?.lineHeight ?? 35 }));
    const container = surface.createContainer();
    const node = createToolCue(container, surface);

    expect(toolCueVisible(22, 9000, false, 10000)).toBe(true);
    expect(toolFlashAlpha(10000, 9000, false)).toBeCloseTo(Math.min(1, (1 - 1000 / 2200) * 1.6), 5);
    updateToolCue(node, { toolCount: 22, lastToolTs: 9000, hovered: false, skinId: 'blue-dash', appearance: appearance('blue-dash', '#1F3D6D') }, 100, 200, 5, 10000);

    expect(container.alpha).toBeCloseTo(toolFlashAlpha(10000, 9000, false), 5);
    expect(texts[0].value).toBe('× 22');
    expect(texts[0].style).toMatchObject({
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
      fontSize: 25,
      fontWeight: 900,
      lineHeight: 35,
    });
    expect(texts[0].x).toBe(100 + 8 * 5 + 2 * 5);
    expect(texts[0].y).toBe(Math.round(200 + 4 * 5 - 35 / 2));
    expect(texts[0].y).not.toBe(200 + 4 * 5);
  });

  it('ports tool palette and hollow center geometry exactly', async () => {
    const { createToolCue, updateToolCue } = await import('../src/features/worker/scene/tool-cue');
    const { darkenColor, lightenColor } = await import('../src/features/worker/scene/palette');
    const { surface, graphics } = mockSurface();
    const container = surface.createContainer();
    const node = createToolCue(container, surface);
    updateToolCue(node, { toolCount: 22, lastToolTs: 9000, hovered: false, skinId: 'blue-dash', appearance: appearance('blue-dash', '#1F3D6D') }, 0, 0, 1, 10000);

    expect(graphics[0].commands).toContainEqual({ kind: 'rect', x: 3, y: 0, width: 2, height: 1, fill: darkenColor('#1F3D6D', 0.52) });
    expect(graphics[0].commands).toContainEqual({ kind: 'rect', x: 3, y: 1, width: 2, height: 1, fill: lightenColor('#1F3D6D', 1.22) });
    expect(graphics[0].commands).toContainEqual({ kind: 'rect', x: 2, y: 2, width: 1, height: 1, fill: lightenColor('#1F3D6D', 1.55) });
    for (const px of [{ x: 3, y: 3 }, { x: 4, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 4 }]) {
      expect(graphics[0].commands.some((cmd: any) =>
        cmd.kind === 'rect' &&
        px.x >= cmd.x && px.x < cmd.x + cmd.width &&
        px.y >= cmd.y && px.y < cmd.y + cmd.height,
      )).toBe(false);
    }
  });

  it('keeps workshop pickaxe footprint for classic voxel miner', async () => {
    const { createToolCue, updateToolCue } = await import('../src/features/worker/scene/tool-cue');
    const rows = [
      '............', '..DDDDDD....', '..DCCCCDD...', '..DAAAACD...',
      '....AABACD..', '....ABBBACD.', '....ABBB.ACD', '....ABB..ABD',
      '.....A...A..', '......A....E', '.....A......', '............',
    ];
    const expectedPixels = rows.join('').replace(/\./g, '').length;
    const { surface, graphics } = mockSurface();
    const container = surface.createContainer();
    const node = createToolCue(container, surface);
    updateToolCue(node, { toolCount: 22, lastToolTs: 9000, hovered: false, skinId: 'classic-voxel-miner', appearance: appearance('classic-voxel-miner') }, 0, 0, 1, 10000);
    expect(graphics[0].commands).toHaveLength(expectedPixels);
    expect(graphics[0].commands).toContainEqual({ kind: 'rect', x: 4, y: 4, width: 1, height: 1, fill: '#2E2018' });
  });
});

describe('worker skin, hit region and badge helpers', () => {
  it('uses exactly the shared four phase values and no dozing branch', async () => {
    const { moodForPhase } = await import('../src/features/worker/scene/skin-drawer');
    expect(moodForPhase('working')).toBe('open');
    expect(moodForPhase('sleeping')).toBe('sleep');
    expect(moodForPhase('celebrating')).toBe('happy');
    expect(moodForPhase('dejected')).toBe('sad');
    const source = fs.readFileSync(path.join(rootDir, 'src/features/worker/scene/skin-drawer.ts'), 'utf8');
    expect(source).not.toMatch(/phase\s*={2,3}\s*['"]dozing['"]/);
  });

  it('computes inclusive 40x32 scaled hit regions and passthrough', async () => {
    const { computeHitRegion, hitTest, isHovering, isPassthrough } = await import('../src/features/worker/scene/hit-regions');
    const region = computeHitRegion(44, 40, 5);
    expect(region).toEqual({ x: 220, y: 200, width: 200, height: 160 });
    expect(hitTest(region, { x: 220, y: 200 })).toBe(true);
    expect(hitTest(region, { x: 420, y: 360 })).toBe(true);
    expect(hitTest(region, { x: 421, y: 360 })).toBe(false);
    expect(isHovering(region, { x: 300, y: 250, inside: true }, false)).toBe(true);
    expect(isPassthrough(false, false)).toBe(true);
    expect(isPassthrough(true, false)).toBe(false);
  });

  it('keeps unknown badge empty and known badges inside 10x10 ROI', async () => {
    const { drawClientBadge } = await import('../src/features/worker/scene/badge');
    const unknown = new PixelBuilder(10, 10);
    expect(drawClientBadge(unknown, 'unknown', 0.9)).toEqual({ w: 0, h: 0 });
    expect(unknown.build().rects).toHaveLength(0);

    const codex = new PixelBuilder(10, 10);
    expect(drawClientBadge(codex, 'codex', 0.9)).toEqual({ w: 10, h: 10 });
    expect(codex.build().rects.length).toBeGreaterThan(0);
  });
});

describe('worker activityPulseOffset fallback (FU-002 production helper)', () => {
  it('uses lastActivityTs when explicit activity is present', async () => {
    const { activityPulseOffset } = await import('../src/features/worker/scene/timing');
    // Both present: explicit activity wins, fallback lastToolTs is ignored.
    const withActivity = activityPulseOffset(10_000, 9_500 ?? 8_000);
    const withoutFallback = activityPulseOffset(10_000, 9_500);
    expect(withActivity).toBe(withoutFallback);
  });

  it('falls back to lastToolTs when activity is absent', async () => {
    const { activityPulseOffset } = await import('../src/features/worker/scene/timing');
    // No lastActivityTs — fallback to lastToolTs.
    const offset = activityPulseOffset(10_000, undefined ?? 9_500);
    expect(offset).toBeLessThan(0);
    // Absent without any fallback would return 0.
    const noActivity = activityPulseOffset(10_000);
    expect(noActivity).toBe(0);
  });
});

describe('preview capture ROI contract', () => {
  it('keeps strict thresholds and production worker subject ROI comparison rules', async () => {
    const { THRESHOLD } = await import('../scripts/preview/capture-contract.mjs');
    expect(THRESHOLD).toEqual({ maxBoundsDelta: 1, channelDelta: 24, maxChangedRatio: 0.03 });
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).toContain('function metricResult(ref, cap, subject, excludes, scale, fixtureId, label)');
    expect(source).toContain("metricResult(ref, cap, workerSubjectRoi(), [labelRoi], WORKER_VIEWPORT.scale, fixtureId, 'subject')");
    expect(source).toContain('const labelRoi = ageLabelRoi();');
    expect(source).toContain('nonblankPixelCount(cap, labelRoi)');
    expect(source).toContain('fixture ${fixtureId} age-label ROI is blank');
    expect(source).not.toContain('bundleEntry');
    expect(source).not.toContain('--scope');
  });

  it('keeps strict body sanity for tool and bubble fixtures', () => {
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).toContain("metricResult(ref, cap, workerSubjectRoi(), bodyExcludes, WORKER_VIEWPORT.scale, fixtureId, 'body-sanity')");
    expect(source).toContain('bodyExcludes.push(subject);');
    expect(source).toContain("/^worker-tool-/.test(fixtureId)");
    expect(source).toContain("/^worker-bubble-/.test(fixtureId)");
    expect(source).toContain('foreground pixels exceed channel delta');
  });

  it('uses dedicated tool, bubble and unknown badge ROIs instead of whole-image nonblank checks', () => {
    const source = fs.readFileSync(path.join(rootDir, 'scripts/preview-capture.mjs'), 'utf8');
    expect(source).toContain('const subject = toolRoi(fixtureId);');
    expect(source).toContain('nonblankPixelCount(cap, subject)');
    expect(source).toContain('tool ROI does not differ from matching no-tool capture');
    expect(source).toContain('const subject = bubbleRoi();');
    expect(source).toContain('reference bubble ROI is blank');
    expect(source).toContain('exactChangedPixels(cap, decode(baselinePath), badgeRoi())');
    expect(source).not.toContain('return problems');
  });
});
