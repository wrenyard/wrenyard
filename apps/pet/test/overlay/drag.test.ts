import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindHouseDrag } from '../../src/features/house/interaction';
import { bindWorkerDrag } from '../../src/features/worker/interaction';
import { bindWrenDrag } from '../../src/features/taskgraph-entity/interaction';

class FakeElement {
  constructor(private readonly excluded = false) {}
  closest(selector: string): FakeElement | null {
    const selectors = selector.split(',').map((s) => s.trim());
    return selectors.some((s) => s === '.sticky-hit') && this.excluded ? this : null;
  }
}

interface ListenerMap {
  [type: string]: Array<(event?: any) => void>;
}

function createEnv() {
  const listeners: ListenerMap = {};
  const rafs = new Map<number, FrameRequestCallback>();
  let nextRaf = 1;
  const win = {
    addEventListener(type: string, listener: (event?: any) => void) {
      listeners[type] ??= [];
      listeners[type].push(listener);
    },
    removeEventListener(type: string, listener: (event?: any) => void) {
      listeners[type] = (listeners[type] ?? []).filter((item) => item !== listener);
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = nextRaf++;
      rafs.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      rafs.delete(id);
    },
  } as unknown as Window;
  const doc = { body: { style: { cursor: '' } } } as unknown as Document;
  const dispatch = (type: string, event: any = {}) => {
    for (const listener of [...(listeners[type] ?? [])]) listener(event);
  };
  const flushRaf = () => {
    const callbacks = [...rafs.entries()];
    rafs.clear();
    for (const [, callback] of callbacks) callback(0);
  };
  const listenerCount = (type: string) => listeners[type]?.length ?? 0;
  return { win, doc, dispatch, flushRaf, listenerCount };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('overlay browser drag binding', () => {
  it('starts only on left-button worker body, captures current worker id, and throttles moves by RAF', () => {
    vi.stubGlobal('Element', FakeElement);
    const env = createEnv();
    const api = {
      workerDragStart: vi.fn(),
      workerDragMove: vi.fn(),
      workerDragEnd: vi.fn(),
    };
    let workerId = 'w-current';
    const states: boolean[] = [];
    const drag = bindWorkerDrag(api, {
      win: env.win,
      doc: env.doc,
      getId: () => workerId,
      canStart: (event) => event.clientX === 5,
      onDraggingChange: (dragging) => states.push(dragging),
    });

    env.dispatch('mousedown', { button: 1, clientX: 5, target: new FakeElement() });
    expect(api.workerDragStart).not.toHaveBeenCalled();

    env.dispatch('mousedown', { button: 0, clientX: 5, target: new FakeElement() });
    expect(drag.dragging).toBe(true);
    expect(api.workerDragStart).toHaveBeenCalledWith('w-current');
    expect(states).toEqual([true]);
    expect((env.doc.body as HTMLElement).style.cursor).toBe('grabbing');

    workerId = 'w-other';
    env.dispatch('mousemove');
    env.dispatch('mousemove');
    expect(api.workerDragMove).not.toHaveBeenCalled();
    env.flushRaf();
    expect(api.workerDragMove.mock.calls).toEqual([['w-current']]);

    env.dispatch('mouseup');
    expect(api.workerDragEnd).toHaveBeenCalledWith('w-current');
    expect(states).toEqual([true, false]);
    expect((env.doc.body as HTMLElement).style.cursor).toBe('grab');
    drag.dispose();
  });

  it('excludes house sticky hit targets, ends on blur, and dispose removes listeners safely', () => {
    vi.stubGlobal('Element', FakeElement);
    const env = createEnv();
    const api = {
      houseDragStart: vi.fn(),
      houseDragMove: vi.fn(),
      houseDragEnd: vi.fn(),
    };
    const drag = bindHouseDrag(api, {
      win: env.win,
      doc: env.doc,
      canStart: () => true,
      onDraggingChange: vi.fn(),
    });

    env.dispatch('mousedown', { button: 0, target: new FakeElement(true) });
    expect(api.houseDragStart).not.toHaveBeenCalled();

    env.dispatch('mousedown', { button: 0, target: new FakeElement(false) });
    expect(api.houseDragStart).toHaveBeenCalledTimes(1);
    env.dispatch('blur');
    expect(api.houseDragEnd).toHaveBeenCalledTimes(1);

    env.dispatch('mousedown', { button: 0, target: new FakeElement(false) });
    drag.dispose();
    expect(api.houseDragEnd).toHaveBeenCalledTimes(2);
    expect(env.listenerCount('mousedown')).toBe(0);
    env.dispatch('mousemove');
    env.flushRaf();
    expect(api.houseDragMove).not.toHaveBeenCalled();
  });

  it('keeps a Wren click actionable but suppresses the click synthesized after dragging', () => {
    vi.stubGlobal('Element', FakeElement);
    const env = createEnv();
    const api = {
      entityDragStart: vi.fn(),
      entityDragMove: vi.fn(),
      entityDragEnd: vi.fn(),
    };
    const drag = bindWrenDrag(api, {
      win: env.win,
      doc: env.doc,
      canStart: () => true,
    });

    env.dispatch('mousedown', { button: 0, target: new FakeElement() });
    env.dispatch('mouseup');
    expect(drag.consumeOpenSuppression()).toBe(false);

    env.dispatch('mousedown', { button: 0, target: new FakeElement() });
    env.dispatch('mousemove');
    env.flushRaf();
    env.dispatch('mouseup');
    expect(api.entityDragMove).toHaveBeenCalledTimes(1);
    expect(drag.consumeOpenSuppression()).toBe(true);
    expect(drag.consumeOpenSuppression()).toBe(false);
    drag.dispose();
  });
});
