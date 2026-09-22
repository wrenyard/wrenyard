import { Ticker } from 'pixi.js';
import type { FrameCallback, RenderTicker } from '../types';

export class PixiRenderTicker implements RenderTicker {
  private readonly callbacks = new Set<FrameCallback>();
  private readonly ticker: Ticker;
  private readonly destroyUnderlying: boolean;
  private running = false;
  private destroyed = false;
  private lastNowMs: number | null = null;

  constructor(ticker: Ticker, destroyUnderlying = false) {
    this.ticker = ticker;
    this.destroyUnderlying = destroyUnderlying;
  }

  add(callback: FrameCallback): () => void {
    if (this.destroyed) {
      throw new Error('render ticker has been destroyed');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function');
    }
    this.callbacks.add(callback);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      if (!this.destroyed) {
        this.callbacks.delete(callback);
      }
    };
  }

  start(): void {
    if (this.destroyed) {
      throw new Error('render ticker has been destroyed');
    }
    if (this.running) return;
    this.running = true;
    this.lastNowMs = null;
    this.ticker.add(this.onFrame);
    this.ticker.start();
  }

  stop(): void {
    if (this.destroyed || !this.running) return;
    this.running = false;
    this.lastNowMs = null;
    this.ticker.remove(this.onFrame);
    this.ticker.stop();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.callbacks.clear();
    this.destroyed = true;
    if (this.destroyUnderlying) {
      this.ticker.destroy();
    }
  }

  private onFrame = (): void => {
    const nowMs = performance.now();
    const deltaMs = this.lastNowMs === null ? 0 : Math.max(0, nowMs - this.lastNowMs);
    this.lastNowMs = nowMs;
    for (const callback of [...this.callbacks]) {
      callback(nowMs, deltaMs);
    }
  };
}
