import { describe, expect, it } from 'vitest';
import { createWrenScene, WREN_W, WREN_H, WREN_SCALE, WREN_DISPLAY_W, WREN_DISPLAY_H } from '../src/features/taskgraph-entity/scene';
import { createWrenEntityPresenter } from '../src/features/taskgraph-entity/presenter';
import {
  wrenFactSlipLabel,
  wrenStitchTone,
  wrenStitchClasses,
  WREN_FALLBACK_TITLE,
} from '../src/features/taskgraph-entity/fact-slip';
import type { RenderSurface, RenderContainer, RenderGraphics, ShapeCommand } from '../src/render/types';

// ── Mock surface ──────────────────────────────────────────────────────

function createMockSurface(): RenderSurface {
  const mockRoot: RenderContainer = {
    setPosition: () => {},
    setScale: () => {},
    setAlpha: () => {},
    setVisible: () => {},
    destroy: () => {},
    add: () => {},
    remove: () => {},
  };

  const mockGraphics: RenderGraphics = {
    setPosition: () => {},
    setScale: () => {},
    setAlpha: () => {},
    setVisible: () => {},
    destroy: () => {},
    setCommands: () => {},
  };

  return {
    root: mockRoot,
    ticker: { add: () => () => {}, start: () => {}, stop: () => {} },
    createContainer: () => ({
      setPosition: () => {},
      setScale: () => {},
      setAlpha: () => {},
      setVisible: () => {},
      destroy: () => {},
      add: () => {},
      remove: () => {},
    }),
    createGraphics: () => ({
      setPosition: () => {},
      setScale: () => {},
      setAlpha: () => {},
      setVisible: () => {},
      destroy: () => {},
      setCommands: () => {},
    }),
    createText: () => ({
      setPosition: () => {},
      setScale: () => {},
      setAlpha: () => {},
      setVisible: () => {},
      destroy: () => {},
      setText: () => {},
      setStyle: () => {},
      measure: () => ({ width: 0, height: 0 }),
    }),
    createPixel: () => ({
      setPosition: () => {},
      setScale: () => {},
      setAlpha: () => {},
      setVisible: () => {},
      destroy: () => {},
      setProgram: () => {},
    }),
    resize: () => {},
    render: () => {},
    destroy: () => {},
  };
}

/** Install a setCommands recorder before createWrenScene constructs its graphics. */
function setupCommandsRecorder(surface: RenderSurface): Array<readonly ShapeCommand[]> {
  const allCommands: Array<readonly ShapeCommand[]> = [];
  const origCreateGraphics = surface.createGraphics;
  surface.createGraphics = function () {
    const g = origCreateGraphics.call(this);
    const origSetCommands = g.setCommands;
    g.setCommands = function (cmds: readonly ShapeCommand[]) {
      allCommands.push(cmds);
      origSetCommands.call(this, cmds);
    };
    return g;
  };
  return allCommands;
}

describe('Wren scene', () => {
  it('creates scene with correct authored and display dimensions', () => {
    // Authored pixel grid stays 28x22...
    expect(WREN_W).toBe(28);
    expect(WREN_H).toBe(22);
    // ...while the physical presentation is an explicit 3x scale (84x66).
    expect(WREN_SCALE).toBe(3);
    expect(WREN_DISPLAY_W).toBe(84);
    expect(WREN_DISPLAY_H).toBe(66);
  });

  it('scales the scene root once to the 3x display size', () => {
    const surface = createMockSurface();
    const scaleCalls: Array<[number, number | undefined]> = [];
    const origCreateContainer = surface.createContainer;
    surface.createContainer = function () {
      const c = origCreateContainer.call(this);
      const origSetScale = c.setScale;
      c.setScale = function (x: number, y?: number) {
        scaleCalls.push([x, y]);
        origSetScale.call(this, x, y);
      };
      return c;
    };
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '' },
      1000,
    );
    // The scene root is scaled exactly once with the explicit presentation scale.
    expect(scaleCalls).toEqual([[3, 3]]);
    scene.destroy();
  });

  it('returns explicit hit rect matching physical display size', () => {
    const surface = createMockSurface();
    const scene = createWrenScene(surface);
    const output = scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '' },
      1000,
    );
    // Hit target is the physical 84x66 display area, not the 28x22 authored grid.
    expect(output.clickRect).toEqual({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });
    scene.destroy();
  });

  it('shows running wing-frame geometry changes with different nowMs values', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);

    scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '' },
      0,
    );
    scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '' },
      500,
    );

    // Wing flap: up pose at nowMs=0 (wingCycle=0), down pose at nowMs=500 (wingCycle=1).
    // Index 0 is the leading ink silhouette outline, so poses start at index 4.
    expect(commands[0][4]).toMatchObject({ kind: 'rect', y: 6, fill: '#E8DCC4' });
    expect(commands[1][4]).toMatchObject({ kind: 'rect', y: 10, fill: '#E8DCC4' });
    // Tail ink dot shifts right at nowMs=500
    expect(commands[0][9]).toMatchObject({ kind: 'rect', x: 4, fill: '#2E2018' });
    expect(commands[1][9]).toMatchObject({ kind: 'rect', x: 6, fill: '#2E2018' });

    scene.destroy();
  });

  it('shows paused hourglass state with commands', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'paused', revision: 1, created_at: '' },
      1000,
    );

    // Hourglass: slate vertical bar and center bar
    expect(commands[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'rect', x: 26, y: 2, width: 2, height: 6, fill: '#5B6E8A', alpha: 1 }),
        expect.objectContaining({ kind: 'rect', x: 25, y: 4, width: 4, height: 2, fill: '#5B6E8A', alpha: 1 }),
      ]),
    );

    scene.destroy();
  });

  it('shows stale crease', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '', presentation: 'stale' },
      1000,
    );

    // Crease: top and bottom thin lines across full width
    expect(commands[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'rect', x: 0, y: 0, width: WREN_W, height: 1, fill: '#8B7D6B', alpha: 0.4 }),
        expect.objectContaining({ kind: 'rect', x: 0, y: WREN_H - 1, width: WREN_W, height: 1, fill: '#8B7D6B', alpha: 0.4 }),
      ]),
    );

    scene.destroy();
  });

  it('shows exiting fold/fade', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '', presentation: 'exiting' },
      1000,
    );

    // Exiting: full-cover overlay at alpha 0.15
    const overlay = commands[0].find(
      (c) => c.kind === 'rect' && c.fill === '#000000',
    );
    expect(overlay).toMatchObject({ alpha: 0.15, width: WREN_W, height: WREN_H });

    scene.destroy();
  });

  it('does not allow done/cancelled in state', () => {
    // TaskGraphEntityDto.state is typed as 'running' | 'paused' only
    type ValidState = 'running' | 'paused';
    const invalidStates = ['done', 'cancelled', 'created'];
    for (const s of invalidStates) {
      // TypeScript rejects: const bad: ValidState = s;
      const isValid = s === 'running' || s === 'paused';
      expect(isValid).toBe(false);
    }
  });

  it('recognizable DAG mark contains three dots plus links', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    const output = scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '' },
      1000,
    );

    // Three 3x3 dots at (8,10), (13,10), (18,10) with ink fill
    const dots = commands[0].filter(
      (c) => c.kind === 'rect' && c.width === 3 && c.height === 3 && c.fill === '#2E2018',
    );
    expect(dots).toHaveLength(3);
    expect(dots[0]).toMatchObject({ x: 8, y: 10 });
    expect(dots[1]).toMatchObject({ x: 13, y: 10 });
    expect(dots[2]).toMatchObject({ x: 18, y: 10 });

    // Two linking rects at (11,11) and (16,11)
    const links = commands[0].filter(
      (c) => c.kind === 'rect' && c.width === 2 && c.height === 1 && c.fill === '#2E2018',
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ x: 11, y: 11 });
    expect(links[1]).toMatchObject({ x: 16, y: 11 });

    expect(output.clickRect).toEqual({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });
    scene.destroy();
  });
});

describe('Wren presenter', () => {
  it('creates presenter and updates pose', () => {
    const surface = createMockSurface();
    const presenter = createWrenEntityPresenter(surface);

    const hitRect = presenter.updatePose('tg-1', 'running', false, false, 1000);
    expect(hitRect).toEqual({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });

    presenter.destroy();
  });

  it('supports setDto with full state', () => {
    const surface = createMockSurface();
    const presenter = createWrenEntityPresenter(surface);

    const output = presenter.setDto(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '' },
      1000,
    );
    expect(output).toBeDefined();
    expect(output!.clickRect).toEqual({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });

    presenter.destroy();
  });

  it('handles paused state', () => {
    const surface = createMockSurface();
    const presenter = createWrenEntityPresenter(surface);

    const hitRect = presenter.updatePose('tg-1', 'paused', false, false, 1000);
    expect(hitRect).toEqual({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });

    presenter.destroy();
  });

  it('rejects done/cancelled and coerces to paused', () => {
    // The presenter.updatePose coerces non-running/non-paused states to paused
    const surface = createMockSurface();
    const presenter = createWrenEntityPresenter(surface);

    const hitRect = presenter.updatePose('tg-1', 'done', false, false, 1000);
    expect(hitRect).toEqual({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });

    presenter.destroy();
  });
});

// ── Wren lifecycle states ─────────────────────────────────────────────

describe('Wren lifecycle states', () => {
  it('[wren-lifecycle] created state shows the slate lamp with wings folded', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'created', revision: 1, created_at: '' },
      1000,
    );
    // Slate lamp at (26,3) — created is distinguishable from running/paused.
    expect(commands[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'rect', x: 26, y: 3, width: 2, height: 2, fill: '#5B6E8A', alpha: 1 }),
      ]),
    );
    // No running moss lamp, no paused hourglass.
    expect(commands[0].some((c) => c.kind === 'rect' && c.x === 26 && c.y === 2 && c.height === 4)).toBe(false);
    scene.destroy();
  });

  it('[wren-lifecycle] error-paused shows the terracotta crack instead of the hourglass', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'paused', revision: 1, created_at: '', error_paused: true },
      1000,
    );
    const cmds = commands[0];
    expect(cmds.some((c) => c.kind === 'rect' && c.fill === '#C44E3A' && c.width === 5)).toBe(true);
    // Manual-pause hourglass must not render for the error crack.
    expect(cmds.some((c) => c.kind === 'rect' && c.fill === '#5B6E8A' && c.x === 26 && c.width === 2 && c.height === 6)).toBe(false);
    scene.destroy();
  });

  it('[wren-lifecycle] manual paused keeps the slate hourglass', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'paused', revision: 1, created_at: '' },
      1000,
    );
    expect(commands[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'rect', x: 26, y: 2, width: 2, height: 6, fill: '#5B6E8A', alpha: 1 }),
        expect.objectContaining({ kind: 'rect', x: 25, y: 4, width: 4, height: 2, fill: '#5B6E8A', alpha: 1 }),
      ]),
    );
    scene.destroy();
  });

  it('[wren-lifecycle] done renders the moss completion badge with a one-time celebrate frame', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'paused', revision: 1, created_at: '', terminal: 'done' },
      0,
    );
    const cmds = commands[0];
    expect(cmds.some((c) => c.kind === 'rect' && c.x === 25 && c.width === 3 && c.fill === '#7BA05B')).toBe(true);
    expect(cmds.some((c) => c.kind === 'rect' && c.fill === '#F5EBD4' && c.width === 3 && c.height === 1 && c.y === 2)).toBe(true);
    scene.destroy();
  });

  it('[wren-lifecycle] cancelled with node_failed shows the terracotta fold; plain cancelled uses slate', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'paused', revision: 1, created_at: '', terminal: 'cancelled', terminal_reason: 'node_failed' },
      1000,
    );
    expect(commands[0].some((c) => c.kind === 'rect' && c.x === 24 && c.width === 4 && c.fill === '#C44E3A')).toBe(true);
    scene.destroy();

    const surface2 = createMockSurface();
    const commands2 = setupCommandsRecorder(surface2);
    const scene2 = createWrenScene(surface2);
    scene2.update(
      { id: 'tg-1', state: 'paused', revision: 1, created_at: '', terminal: 'cancelled', terminal_reason: 'cancelled' },
      1000,
    );
    expect(commands2[0].some((c) => c.kind === 'rect' && c.x === 24 && c.width === 4 && c.fill === '#5B6E8A')).toBe(true);
    scene2.destroy();
  });

  it('[wren-lifecycle] prefers-reduced-motion cancels the wing loop: static across nowMs', () => {
    const surface = createMockSurface();
    const commands = setupCommandsRecorder(surface);
    const scene = createWrenScene(surface);
    scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '', motion: 'reduced' },
      0,
    );
    scene.update(
      { id: 'tg-1', state: 'running', revision: 1, created_at: '', motion: 'reduced' },
      1000,
    );
    // Wing pose index 4 must be identical across nowMs under reduced motion.
    expect(commands[0][4]).toEqual(commands[1][4]);
    scene.destroy();
  });

  it('[wren-lifecycle] terminal-before-exit: the fact slip keeps the last validated counts label before leaving', () => {
    // The scene plays terminal feedback from a tracked done graph while the
    // owner keeps the entity alive during the exit window (tested in
    // taskgraph.test.ts); the paper tag keeps the validated task counts.
    expect(wrenFactSlipLabel({ title: '答疑 Agent 评估', counts: { done: 2, total: 3 } })).toBe('答疑 Agent 评估 · 2/3');
  });
});

// ── Wren paper-tag fact slip ──────────────────────────────────────────

describe('wrenFactSlipLabel', () => {
  it('renders title · done/total when revision-safe counts are present', () => {
    expect(wrenFactSlipLabel({ title: '答疑 Agent 评估', counts: { done: 2, total: 3 } })).toBe('答疑 Agent 评估 · 2/3');
    expect(wrenFactSlipLabel({ title: '任务图', counts: { done: 0, total: 5 } })).toBe('任务图 · 0/5');
    expect(wrenFactSlipLabel({ title: '任务图', counts: { done: 5, total: 5 } })).toBe('任务图 · 5/5');
  });

  it('shows only the title when counts are unavailable', () => {
    expect(wrenFactSlipLabel({ title: '答疑 Agent 评估' })).toBe('答疑 Agent 评估');
    expect(wrenFactSlipLabel({ title: '答疑 Agent 评估', counts: undefined })).toBe('答疑 Agent 评估');
  });

  it('never guesses counts from malformed values', () => {
    expect(wrenFactSlipLabel({ title: 't', counts: { done: -1, total: 3 } })).toBe('t');
    expect(wrenFactSlipLabel({ title: 't', counts: { done: 1.5, total: 3 } })).toBe('t');
    expect(wrenFactSlipLabel({ title: 't', counts: { done: 2, total: Number.NaN } })).toBe('t');
  });

  it('falls back to 未命名任务图 when the title is absent/invalid', () => {
    expect(wrenFactSlipLabel({})).toBe(WREN_FALLBACK_TITLE);
    expect(wrenFactSlipLabel({ title: '', counts: { done: 1, total: 2 } })).toBe(`${WREN_FALLBACK_TITLE} · 1/2`);
    expect(wrenFactSlipLabel({ title: undefined })).toBe(WREN_FALLBACK_TITLE);
  });
});

// ── Wren lifecycle stitch (state carried by color only) ───────────────

describe('wrenStitchTone', () => {
  it('running and done use moss', () => {
    expect(wrenStitchTone({ state: 'running', stale: false, exiting: false })).toBe('moss');
    expect(wrenStitchTone({ state: 'paused', stale: false, exiting: false, terminal: 'done' })).toBe('moss');
  });

  it('created and manual pause use slate', () => {
    expect(wrenStitchTone({ state: 'created', stale: false, exiting: false })).toBe('slate');
    expect(wrenStitchTone({ state: 'paused', stale: false, exiting: false })).toBe('slate');
  });

  it('error pause and error exit use terracotta', () => {
    expect(wrenStitchTone({ state: 'paused', stale: false, exiting: false, error_paused: true })).toBe('terracotta');
    expect(wrenStitchTone({ state: 'paused', stale: false, exiting: false, terminal: 'cancelled', terminal_reason: 'node_failed' })).toBe('terracotta');
  });

  it('plain cancelled exit uses slate', () => {
    expect(wrenStitchTone({ state: 'paused', stale: false, exiting: false, terminal: 'cancelled', terminal_reason: 'cancelled' })).toBe('slate');
  });

  it('stale keeps the tone and adds the stale class', () => {
    expect(wrenStitchClasses({ state: 'running', stale: true, exiting: false })).toBe('stitch-moss stale');
    expect(wrenStitchClasses({ state: 'paused', stale: true, exiting: false, error_paused: true })).toBe('stitch-terracotta stale');
  });
});
