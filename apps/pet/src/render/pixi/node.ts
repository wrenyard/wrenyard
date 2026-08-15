import { Container } from 'pixi.js';
import { assertFiniteNumber, clampAlpha } from '../validation';
import type { RenderNode } from '../types';
import type { PixiRenderContainer } from './container';

export class PixiRenderNode implements RenderNode {
  public readonly container: Container;
  protected _destroyed = false;
  private owner: PixiRenderContainer | null = null;

  constructor(container: Container) {
    this.container = container;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  setPosition(x: number, y: number): void {
    this.assertAlive();
    this.container.position.set(
      assertFiniteNumber(x, 'position x'),
      assertFiniteNumber(y, 'position y'),
    );
  }

  setScale(x: number, y?: number): void {
    this.assertAlive();
    const scaleX = assertFiniteNumber(x, 'scale x');
    const scaleY = y === undefined ? scaleX : assertFiniteNumber(y, 'scale y');
    this.container.scale.set(scaleX, scaleY);
  }

  setAlpha(alpha: number): void {
    this.assertAlive();
    this.container.alpha = clampAlpha(alpha, 'alpha');
  }

  setVisible(visible: boolean): void {
    this.assertAlive();
    if (typeof visible !== 'boolean') {
      throw new TypeError('visible must be a boolean');
    }
    this.container.visible = visible;
  }

  destroy(): void {
    if (this._destroyed) return;
    this.detachFromOwner();
    this._destroyed = true;
    this.container.destroy(false);
  }

  attachToOwner(owner: PixiRenderContainer): void {
    this.owner = owner;
  }

  clearOwner(owner: PixiRenderContainer): void {
    if (this.owner === owner) {
      this.owner = null;
    }
  }

  detachFromOwner(): void {
    this.owner?.detachOwnedChild(this);
  }

  protected assertAlive(): void {
    if (this._destroyed) {
      throw new Error('render node has been destroyed');
    }
  }
}
