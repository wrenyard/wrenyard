export type RenderColor = number | string;

export type RenderPoint = { x: number; y: number };

export type ShapeCommand =
  | {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      fill: RenderColor;
      alpha?: number;
    }
  | {
      kind: 'roundedRect';
      x: number;
      y: number;
      width: number;
      height: number;
      radius: number;
      fill: RenderColor;
      alpha?: number;
    }
  | {
      kind: 'polygon';
      points: readonly RenderPoint[];
      fill: RenderColor;
      alpha?: number;
    };

export type PixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  color: RenderColor;
  alpha?: number;
};

export type PixelProgram = {
  width: number;
  height: number;
  rects: readonly PixelRect[];
};

export type RenderSurfaceOptions = { resolution: number };

export type RenderViewport = {
  width: number;
  height: number;
  resolution: number;
};

export type FrameCallback = (nowMs: number, deltaMs: number) => void;

export interface RenderNode {
  setPosition(x: number, y: number): void;
  setScale(x: number, y?: number): void;
  setAlpha(alpha: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

export interface RenderContainer extends RenderNode {
  add(...children: RenderNode[]): void;
  remove(child: RenderNode): void;
}

export interface RenderGraphics extends RenderNode {
  setCommands(commands: readonly ShapeCommand[]): void;
}

export interface RenderPixel extends RenderNode {
  setProgram(program: PixelProgram): void;
}

export interface RenderTicker {
  add(callback: FrameCallback): () => void;
  start(): void;
  stop(): void;
}

export interface RenderSurface {
  readonly root: RenderContainer;
  readonly ticker: RenderTicker;
  createContainer(): RenderContainer;
  createGraphics(commands?: readonly ShapeCommand[]): RenderGraphics;
  createPixel(program: PixelProgram): RenderPixel;
  resize(cssWidth: number, cssHeight: number, resolution: number): void;
  render(): void;
  destroy(): void;
}

export interface RenderScene<TVisualState> {
  update(state: TVisualState, nowMs: number): void;
  resize(viewport: RenderViewport): void;
  destroy(): void;
}
