import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type {
  PixelProgram,
  RenderContainer,
  RenderGraphics,
  RenderPixel,
  RenderSurface,
  RenderSurfaceOptions,
  RenderText,
  RenderTextStyle,
  ShapeCommand,
} from '../types';
import { assertPositiveFinite } from '../validation';
import { PixiRenderContainer } from './container';
import { PixiRenderGraphics } from './graphics';
import { PixiRenderPixel } from './pixel';
import { PixiRenderText } from './text';
import { PixiRenderTicker } from './ticker';

export class PixiRenderSurface implements RenderSurface {
  readonly root: PixiRenderContainer;
  readonly ticker: PixiRenderTicker;
  private readonly app: Application;
  private destroyed = false;

  constructor(app: Application, root: PixiRenderContainer, ticker: PixiRenderTicker) {
    this.app = app;
    this.root = root;
    this.ticker = ticker;
  }

  createContainer(): RenderContainer {
    this.assertAlive();
    return new PixiRenderContainer(new Container());
  }

  createGraphics(commands: readonly ShapeCommand[] = []): RenderGraphics {
    this.assertAlive();
    const graphics = new PixiRenderGraphics(new Graphics());
    graphics.setCommands(commands);
    return graphics;
  }

  createText(text: string, style: RenderTextStyle): RenderText {
    this.assertAlive();
    const renderText = new PixiRenderText(new Text({ text: '' }));
    renderText.setText(text);
    renderText.setStyle(style);
    return renderText;
  }

  createPixel(program: PixelProgram): RenderPixel {
    this.assertAlive();
    const pixel = new PixiRenderPixel(new Sprite(Texture.EMPTY));
    pixel.setProgram(program);
    return pixel;
  }

  resize(cssWidth: number, cssHeight: number, resolution: number): void {
    this.assertAlive();
    const validResolution = assertPositiveFinite(resolution, 'resolution');
    const validWidth = assertPositiveFinite(cssWidth, 'cssWidth');
    const validHeight = assertPositiveFinite(cssHeight, 'cssHeight');
    this.app.renderer.resolution = validResolution;
    this.app.renderer.resize(validWidth, validHeight);
  }

  render(): void {
    this.assertAlive();
    this.app.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ticker.destroy();
    this.root.destroy();
    this.app.stage.removeChildren();
    this.app.destroy(false, {
      children: true,
      texture: true,
      textureSource: true,
      context: true,
    });
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('render surface has been destroyed');
    }
  }
}

export async function createPixiRenderSurface(
  canvas: HTMLCanvasElement,
  options: RenderSurfaceOptions,
): Promise<RenderSurface> {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError('canvas must be an HTMLCanvasElement');
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('options must be an object');
  }

  const extraKeys = Object.keys(options).filter((key) => key !== 'resolution');
  if (extraKeys.length > 0) {
    throw new TypeError(`unknown render surface option: ${extraKeys[0]}`);
  }
  const resolution = assertPositiveFinite(options.resolution, 'resolution');

  const app = new Application();
  await app.init({
    canvas,
    preference: 'webgl',
    backgroundAlpha: 0,
    antialias: false,
    autoDensity: true,
    resolution,
  });
  app.ticker.stop();

  const rootContainer = new Container();
  app.stage.addChild(rootContainer);
  const root = new PixiRenderContainer(rootContainer);
  const ticker = new PixiRenderTicker(app.ticker, false);

  return new PixiRenderSurface(app, root, ticker);
}
