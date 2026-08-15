import { describe, expect, it, vi } from 'vitest';
import {
  STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET,
  STATIC_PREVIEW_CONTEXT_LOST_DATASET,
  STATIC_PREVIEW_OUTPUT_KEY,
  STATIC_PREVIEW_READY_DATASET,
  installStaticPreviewMode,
  parseStaticPreviewParams,
} from '../../src/overlay/static-preview';

function fakeCanvas() {
  const listeners = new Map<string, EventListener>();
  const canvas = {
    dataset: {} as Record<string, string>,
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type: string, event: Event) {
      listeners.get(type)?.(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
  return canvas;
}

function fakeDocument() {
  return {
    documentElement: { dataset: {} as Record<string, string> },
    defaultView: {} as Record<string, unknown>,
  };
}

describe('overlay static preview helper', () => {
  it('returns no mode for normal app URLs', () => {
    expect(parseStaticPreviewParams(new URLSearchParams('nowMs=10000&initNowMs=0'))).toBeUndefined();
  });

  it('parses finite epochs and optional pointer/dragging inputs only in static mode', () => {
    const parsed = parseStaticPreviewParams(new URLSearchParams(
      'previewStatic=1&nowMs=10000&initNowMs=9750&pointerX=180&pointerY=360&pointerInside=1&dragging=false',
    ));
    expect(parsed).toEqual({
      nowMs: 10000,
      initNowMs: 9750,
      pointer: { x: 180, y: 360, inside: true },
      dragging: false,
    });

    expect(() => parseStaticPreviewParams(new URLSearchParams('previewStatic=1&nowMs=NaN&initNowMs=0')))
      .toThrow(/nowMs must be finite/);
    expect(() => parseStaticPreviewParams(new URLSearchParams('previewStatic=1&nowMs=1&initNowMs=0&dragging=yes')))
      .toThrow(/dragging must be boolean/);
  });

  it('installs ready and context-loss markers, then removes them during dispose', () => {
    const canvas = fakeCanvas();
    const doc = fakeDocument();
    const mode = installStaticPreviewMode(
      'previewStatic=1&nowMs=10000&initNowMs=0',
      canvas as unknown as HTMLCanvasElement,
      doc as unknown as Document,
    );
    expect(mode?.nowMs).toBe(10000);
    expect(doc.documentElement.dataset[STATIC_PREVIEW_READY_DATASET]).toBe('0');
    expect(canvas.dataset[STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET]).toBe('1');

    const output = { root: { destroy() {} }, houseRect: { x: 1 } };
    mode?.markReady(output);
    expect(doc.documentElement.dataset[STATIC_PREVIEW_READY_DATASET]).toBe('1');
    expect(doc.defaultView[STATIC_PREVIEW_OUTPUT_KEY]).toEqual({ houseRect: { x: 1 } });

    const preventDefault = vi.fn();
    canvas.dispatch('webglcontextlost', { preventDefault } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(doc.documentElement.dataset[STATIC_PREVIEW_CONTEXT_LOST_DATASET]).toBe('1');
    expect(canvas.dataset[STATIC_PREVIEW_CONTEXT_LOST_DATASET]).toBe('1');

    mode?.dispose();
    expect(canvas.listenerCount()).toBe(0);
    expect(canvas.dataset[STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET]).toBeUndefined();
    expect(doc.documentElement.dataset[STATIC_PREVIEW_READY_DATASET]).toBeUndefined();
    expect(doc.defaultView[STATIC_PREVIEW_OUTPUT_KEY]).toBeUndefined();
  });
});
