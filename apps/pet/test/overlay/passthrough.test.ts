import { describe, expect, it, vi } from 'vitest';
import {
  computePassthrough,
  pointInRect,
} from '../../src/overlay/runtime/passthrough';
import {
  createHousePassthroughController,
} from '../../src/features/house/interaction';
import {
  createWorkerPassthroughController,
} from '../../src/features/worker/interaction';

const rect = { x: 10, y: 20, width: 30, height: 40 };
const outside = { x: 0, y: 0, inside: true };
const inside = { x: 12, y: 24, inside: true };
const missing = { x: -1, y: -1, inside: false };

describe('overlay passthrough input', () => {
  it('computes inclusive hit tests and forces blocking while dragging', () => {
    expect(pointInRect({ x: 10, y: 20, inside: true }, rect)).toBe(true);
    expect(pointInRect({ x: 40, y: 60, inside: true }, rect)).toBe(true);
    expect(pointInRect({ x: 41, y: 60, inside: true }, rect)).toBe(false);

    expect(computePassthrough({ pointer: missing, hitRects: [rect], dragging: false })).toBe(true);
    expect(computePassthrough({ pointer: outside, hitRects: [rect], dragging: false })).toBe(true);
    expect(computePassthrough({ pointer: inside, hitRects: [rect], dragging: false })).toBe(false);
    expect(computePassthrough({ pointer: missing, hitRects: [], dragging: true })).toBe(false);
  });

  it('memoizes house passthrough and supports reset/dispose', () => {
    const send = vi.fn();
    const controller = createHousePassthroughController({ setHouseMousePassthrough: send });

    controller.update({ pointer: outside, hitRects: [rect], dragging: false });
    controller.update({ pointer: outside, hitRects: [rect], dragging: false });
    controller.update({ pointer: inside, hitRects: [rect], dragging: false });
    controller.forceBlocking();
    expect(send.mock.calls).toEqual([[true], [false]]);

    controller.reset();
    controller.set(false);
    expect(send.mock.calls).toEqual([[true], [false], [false]]);

    controller.dispose();
    controller.set(true);
    expect(send.mock.calls).toEqual([[true], [false], [false]]);
    expect(controller.value).toBeUndefined();
  });

  it('sends worker passthrough with id and rememoizes when the id changes', () => {
    const send = vi.fn();
    let workerId: string | undefined = 'w1';
    const controller = createWorkerPassthroughController(
      { setWorkerMousePassthrough: send },
      () => workerId,
    );

    controller.set(true);
    controller.set(true);
    workerId = 'w2';
    controller.set(true);
    workerId = undefined;
    controller.set(false);
    workerId = 'w2';
    controller.set(false);

    expect(send.mock.calls).toEqual([
      ['w1', true],
      ['w2', true],
      ['w2', false],
    ]);
  });

  it('house passthrough transition is sent only on change (memoized)', () => {
    const send = vi.fn();
    const controller = createHousePassthroughController({ setHouseMousePassthrough: send });

    // First call: true (pending)
    controller.update({ pointer: outside, hitRects: [rect], dragging: false });
    expect(send).toHaveBeenCalledOnce();

    // Same value: no call (memoized)
    controller.update({ pointer: outside, hitRects: [rect], dragging: false });
    expect(send).toHaveBeenCalledOnce();

    // Change to false
    controller.update({ pointer: inside, hitRects: [rect], dragging: false });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual([false]);

    // Same false: no call
    controller.update({ pointer: inside, hitRects: [rect], dragging: false });
    expect(send).toHaveBeenCalledTimes(2);

    // Back to true
    controller.update({ pointer: outside, hitRects: [rect], dragging: false });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]).toEqual([true]);
  });
});
