import { Container } from 'pixi.js';
import type { RenderContainer, RenderNode } from '../types';
import { PixiRenderNode } from './node';

function toPixiNode(node: RenderNode): PixiRenderNode {
  if (!(node instanceof PixiRenderNode)) {
    throw new TypeError('child must be created by this render library');
  }
  return node;
}

export class PixiRenderContainer extends PixiRenderNode implements RenderContainer {
  private readonly children: PixiRenderNode[] = [];

  constructor(container: Container) {
    super(container);
  }

  add(...children: RenderNode[]): void {
    this.assertAlive();
    const pixiChildren = children.map((child) => toPixiNode(child));

    for (const child of pixiChildren) {
      if (child === this) {
        throw new Error('cannot add a container to itself');
      }
      if (child.destroyed) {
        throw new Error('cannot add a destroyed child');
      }
      if (child instanceof PixiRenderContainer && child.containsNode(this)) {
        throw new Error('cannot create a container ownership cycle');
      }
    }

    for (const child of pixiChildren) {
      if (this.children.includes(child)) continue;

      child.detachFromOwner();
      if (child.container.parent) {
        child.container.parent.removeChild(child.container);
      }

      this.container.addChild(child.container);
      this.children.push(child);
      child.attachToOwner(this);
    }
  }

  remove(child: RenderNode): void {
    this.assertAlive();
    const pixiChild = toPixiNode(child);
    if (pixiChild.destroyed) return;
    if (!this.children.includes(pixiChild)) return;
    this.detachOwnedChild(pixiChild);
  }

  destroy(): void {
    if (this._destroyed) return;
    for (const child of [...this.children]) {
      child.destroy();
    }
    this.children.length = 0;
    super.destroy();
  }

  detachOwnedChild(child: PixiRenderNode): void {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
    if (child.container.parent === this.container) {
      this.container.removeChild(child.container);
    }
    child.clearOwner(this);
  }

  private containsNode(target: PixiRenderNode): boolean {
    for (const child of this.children) {
      if (child === target) return true;
      if (child instanceof PixiRenderContainer && child.containsNode(target)) {
        return true;
      }
    }
    return false;
  }
}
