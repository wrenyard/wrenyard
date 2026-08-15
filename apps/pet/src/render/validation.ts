import type {
  PixelProgram,
  PixelRect,
  RenderColor,
  RenderPoint,
  RenderTextStyle,
  ShapeCommand,
} from './types';

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function assertFiniteNumber(value: unknown, label: string): number {
  if (!isFiniteNumber(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  return value;
}

export function assertPositiveFinite(value: unknown, label: string): number {
  const numberValue = assertFiniteNumber(value, label);
  if (numberValue <= 0) {
    throw new RangeError(`${label} must be greater than 0`);
  }
  return numberValue;
}

export function assertPositiveInteger(value: unknown, label: string): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive integer`);
  }
  return value;
}

export function assertInteger(value: unknown, label: string): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    throw new RangeError(`${label} must be a finite integer`);
  }
  return value;
}

export function validateColor(value: unknown, label = 'color'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label} must be finite`);
    }
    if (!Number.isInteger(value) || value < 0x000000 || value > 0xffffff) {
      throw new TypeError(`${label} must be an integer in 0x000000..0xffffff`);
    }
    return;
  }

  if (typeof value === 'string') {
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) return;
    throw new TypeError(`${label} must be #rgb or #rrggbb`);
  }

  throw new TypeError(`${label} must be a number or #rgb/#rrggbb string`);
}

export function normalizeColor(value: RenderColor, label = 'color'): number {
  validateColor(value, label);
  if (typeof value === 'number') return value;

  const hex = value.slice(1);
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return (r << 16) | (g << 8) | b;
  }
  return parseInt(hex, 16);
}

export function clampAlpha(value: unknown, label = 'alpha'): number {
  if (value === undefined) return 1;
  const alpha = assertFiniteNumber(value, label);
  if (alpha < 0) return 0;
  if (alpha > 1) return 1;
  return alpha;
}

export function assertFinitePoint(point: RenderPoint, label: string): void {
  if (typeof point !== 'object' || point === null) {
    throw new TypeError(`${label} must be an object`);
  }
  assertFiniteNumber(point.x, `${label}.x`);
  assertFiniteNumber(point.y, `${label}.y`);
}

export function cloneCommands(commands: readonly ShapeCommand[]): ShapeCommand[] {
  if (!Array.isArray(commands)) {
    throw new TypeError('commands must be an array');
  }

  const cloned: ShapeCommand[] = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index] as ShapeCommand | undefined;
    if (typeof command !== 'object' || command === null) {
      throw new TypeError(`commands[${index}] must be an object`);
    }

    switch (command.kind) {
      case 'rect': {
        assertExactKeys(command, ['kind', 'x', 'y', 'width', 'height', 'fill', 'alpha'], `commands[${index}]`);
        const x = assertFiniteNumber(command.x, `commands[${index}].x`);
        const y = assertFiniteNumber(command.y, `commands[${index}].y`);
        const width = assertFiniteNumber(command.width, `commands[${index}].width`);
        const height = assertFiniteNumber(command.height, `commands[${index}].height`);
        validateColor(command.fill, `commands[${index}].fill`);
        const alpha = clampAlpha(command.alpha, `commands[${index}].alpha`);
        if (width <= 0 || height <= 0) continue;
        cloned.push({ kind: 'rect', x, y, width, height, fill: command.fill, alpha });
        break;
      }
      case 'roundedRect': {
        assertExactKeys(
          command,
          ['kind', 'x', 'y', 'width', 'height', 'radius', 'fill', 'alpha'],
          `commands[${index}]`,
        );
        const x = assertFiniteNumber(command.x, `commands[${index}].x`);
        const y = assertFiniteNumber(command.y, `commands[${index}].y`);
        const width = assertFiniteNumber(command.width, `commands[${index}].width`);
        const height = assertFiniteNumber(command.height, `commands[${index}].height`);
        const radius = assertFiniteNumber(command.radius, `commands[${index}].radius`);
        validateColor(command.fill, `commands[${index}].fill`);
        const alpha = clampAlpha(command.alpha, `commands[${index}].alpha`);
        if (width <= 0 || height <= 0) continue;
        cloned.push({
          kind: 'roundedRect',
          x,
          y,
          width,
          height,
          radius: Math.max(0, Math.min(radius, Math.min(width, height) / 2)),
          fill: command.fill,
          alpha,
        });
        break;
      }
      case 'polygon': {
        assertExactKeys(command, ['kind', 'points', 'fill', 'alpha'], `commands[${index}]`);
        if (!Array.isArray(command.points)) {
          throw new TypeError(`commands[${index}].points must be an array`);
        }
        const points = command.points.map((point, pointIndex) => {
          assertFinitePoint(point, `commands[${index}].points[${pointIndex}]`);
          return { x: point.x, y: point.y };
        });
        validateColor(command.fill, `commands[${index}].fill`);
        const alpha = clampAlpha(command.alpha, `commands[${index}].alpha`);
        if (points.length < 3) continue;
        cloned.push({ kind: 'polygon', points, fill: command.fill, alpha });
        break;
      }
      default:
        throw new TypeError(`commands[${index}].kind must be rect, roundedRect, or polygon`);
    }
  }
  return cloned;
}

const TEXT_STYLE_KEYS = ['fontFamily', 'fontSize', 'fill', 'align', 'lineHeight', 'fontWeight'] as const;
const FONT_WEIGHTS = new Set<RenderTextStyle['fontWeight']>([
  'normal',
  'bold',
  100,
  200,
  300,
  400,
  500,
  600,
  700,
  800,
  900,
]);

export function cloneTextStyle(style: RenderTextStyle): RenderTextStyle {
  if (typeof style !== 'object' || style === null) {
    throw new TypeError('text style must be an object');
  }
  assertExactKeys(style, TEXT_STYLE_KEYS, 'text style');

  if (typeof style.fontFamily !== 'string') {
    throw new TypeError('fontFamily must be a string');
  }
  const fontSize = assertPositiveFinite(style.fontSize, 'fontSize');
  validateColor(style.fill, 'fill');
  if (style.align !== 'left' && style.align !== 'center' && style.align !== 'right') {
    throw new TypeError('align must be left, center, or right');
  }
  const lineHeight = assertPositiveFinite(style.lineHeight, 'lineHeight');
  if (!FONT_WEIGHTS.has(style.fontWeight)) {
    throw new TypeError('fontWeight must be normal, bold, or 100..900');
  }

  return {
    fontFamily: style.fontFamily,
    fontSize,
    fill: style.fill,
    align: style.align,
    lineHeight,
    fontWeight: style.fontWeight,
  };
}

export function clonePixelProgram(program: PixelProgram): PixelProgram {
  if (typeof program !== 'object' || program === null) {
    throw new TypeError('pixel program must be an object');
  }

  const width = assertPositiveInteger(program.width, 'pixel program width');
  const height = assertPositiveInteger(program.height, 'pixel program height');
  if (!Array.isArray(program.rects)) {
    throw new TypeError('pixel program rects must be an array');
  }

  const rects: PixelRect[] = program.rects.map((rect, index) => {
    if (typeof rect !== 'object' || rect === null) {
      throw new TypeError(`pixel program rects[${index}] must be an object`);
    }
    assertExactKeys(rect, ['x', 'y', 'width', 'height', 'color', 'alpha'], `pixel program rects[${index}]`);
    const x = assertInteger(rect.x, `pixel program rects[${index}].x`);
    const y = assertInteger(rect.y, `pixel program rects[${index}].y`);
    const rectWidth = assertInteger(rect.width, `pixel program rects[${index}].width`);
    const rectHeight = assertInteger(rect.height, `pixel program rects[${index}].height`);
    validateColor(rect.color, `pixel program rects[${index}].color`);
    return {
      x,
      y,
      width: rectWidth,
      height: rectHeight,
      color: rect.color,
      alpha: clampAlpha(rect.alpha, `pixel program rects[${index}].alpha`),
    };
  });

  return { width, height, rects };
}

export function freezePixelProgram(program: PixelProgram): PixelProgram {
  for (const rect of program.rects) {
    Object.freeze(rect);
  }
  Object.freeze(program.rects);
  return Object.freeze(program);
}

function assertExactKeys(
  value: object,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} has unknown key ${key}`);
    }
  }
}
