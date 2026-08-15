import { Graphics } from 'pixi.js';
import type { RenderGraphics, ShapeCommand } from '../types';
import { cloneCommands, normalizeColor } from '../validation';
import { PixiRenderNode } from './node';

export class PixiRenderGraphics extends PixiRenderNode implements RenderGraphics {
  private readonly graphics: Graphics;
  private commands: ShapeCommand[] = [];

  constructor(graphics: Graphics) {
    super(graphics);
    this.graphics = graphics;
  }

  setCommands(commands: readonly ShapeCommand[]): void {
    this.assertAlive();
    this.commands = cloneCommands(commands);
    this.repaint();
  }

  private repaint(): void {
    this.graphics.clear();
    for (const command of this.commands) {
      const alpha = command.alpha ?? 1;
      switch (command.kind) {
        case 'rect':
          this.graphics
            .rect(command.x, command.y, command.width, command.height)
            .fill({ color: normalizeColor(command.fill), alpha });
          break;
        case 'roundedRect':
          this.graphics
            .roundRect(command.x, command.y, command.width, command.height, command.radius)
            .fill({ color: normalizeColor(command.fill), alpha });
          break;
        case 'polygon':
          this.graphics
            .poly(command.points.flatMap((point) => [point.x, point.y]))
            .fill({ color: normalizeColor(command.fill), alpha });
          break;
      }
    }
  }
}
