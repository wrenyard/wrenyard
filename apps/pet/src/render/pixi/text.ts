import { Text, TextStyle, type TextStyleOptions } from 'pixi.js';
import type { RenderText, RenderTextStyle } from '../types';
import { cloneTextStyle, normalizeColor } from '../validation';
import { PixiRenderNode } from './node';

export class PixiRenderText extends PixiRenderNode implements RenderText {
  private readonly textObject: Text;

  constructor(text: Text) {
    super(text);
    this.textObject = text;
  }

  setText(text: string): void {
    this.assertAlive();
    if (typeof text !== 'string') {
      throw new TypeError('text must be a string');
    }
    this.textObject.text = text;
  }

  setStyle(style: RenderTextStyle): void {
    this.assertAlive();
    this.textObject.style = new TextStyle(toPixiTextStyle(cloneTextStyle(style)));
  }

  measure(): { width: number; height: number } {
    this.assertAlive();
    const bounds = this.textObject.getLocalBounds();
    return {
      width: finiteNonNegative(bounds.width),
      height: finiteNonNegative(bounds.height),
    };
  }
}

function toPixiTextStyle(style: RenderTextStyle): TextStyleOptions {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fill: normalizeColor(style.fill),
    align: style.align,
    lineHeight: style.lineHeight,
    fontWeight: (typeof style.fontWeight === 'number'
      ? String(style.fontWeight)
      : style.fontWeight) as TextStyleOptions['fontWeight'],
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
