export interface StaticPreviewPointer {
  x: number;
  y: number;
  inside: boolean;
}

export interface StaticPreviewMode {
  nowMs: number;
  initNowMs: number;
  pointer?: StaticPreviewPointer;
  dragging?: boolean;
  markReady(output: unknown): void;
  dispose(): void;
}

export const STATIC_PREVIEW_READY_DATASET = 'previewReady';
export const STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET = 'previewWebglContextLossMarker';
export const STATIC_PREVIEW_CONTEXT_LOST_DATASET = 'previewWebglContextLost';
export const STATIC_PREVIEW_OUTPUT_KEY = '__foremanPreviewOutput';

interface StaticPreviewParams {
  nowMs: number;
  initNowMs: number;
  pointer?: StaticPreviewPointer;
  dragging?: boolean;
}

export function parseStaticPreviewParams(params: URLSearchParams): StaticPreviewParams | undefined {
  if (params.get('previewStatic') !== '1') return undefined;

  const nowMs = parseFiniteParam(params, 'nowMs');
  const initNowMs = parseFiniteParam(params, 'initNowMs');
  const pointer = parsePointer(params);
  const dragging = parseOptionalBoolean(params, 'dragging');

  return {
    nowMs,
    initNowMs,
    ...(pointer ? { pointer } : {}),
    ...(dragging === undefined ? {} : { dragging }),
  };
}

export function installStaticPreviewMode(
  search: string | URLSearchParams,
  canvas: HTMLCanvasElement,
  doc: Document = document,
): StaticPreviewMode | undefined {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const parsed = parseStaticPreviewParams(params);
  if (!parsed) return undefined;

  const root = doc.documentElement;
  const win = doc.defaultView as (Window & Record<string, unknown>) | null;
  root.dataset.previewStatic = '1';
  root.dataset[STATIC_PREVIEW_READY_DATASET] = '0';
  root.dataset[STATIC_PREVIEW_CONTEXT_LOST_DATASET] = '0';
  canvas.dataset[STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET] = '1';

  const onContextLost = (event: Event): void => {
    if ('preventDefault' in event) event.preventDefault();
    canvas.dataset[STATIC_PREVIEW_CONTEXT_LOST_DATASET] = '1';
    root.dataset[STATIC_PREVIEW_CONTEXT_LOST_DATASET] = '1';
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  let disposed = false;
  return {
    ...parsed,
    markReady(output: unknown): void {
      if (disposed) return;
      if (win) win[STATIC_PREVIEW_OUTPUT_KEY] = cloneStaticPreviewOutput(output);
      root.dataset[STATIC_PREVIEW_READY_DATASET] = '1';
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      delete canvas.dataset[STATIC_PREVIEW_CONTEXT_LOSS_MARKER_DATASET];
      delete canvas.dataset[STATIC_PREVIEW_CONTEXT_LOST_DATASET];
      delete root.dataset.previewStatic;
      delete root.dataset[STATIC_PREVIEW_READY_DATASET];
      delete root.dataset[STATIC_PREVIEW_CONTEXT_LOST_DATASET];
      if (win) delete win[STATIC_PREVIEW_OUTPUT_KEY];
    },
  };
}

export function cloneStaticPreviewOutput(output: unknown): unknown {
  return clonePreviewValue(output, new WeakSet<object>()) ?? null;
}

function parseFiniteParam(params: URLSearchParams, name: string): number {
  const value = params.get(name);
  if (value === null || value.trim() === '') {
    throw new Error(`static preview missing ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`static preview ${name} must be finite`);
  }
  return parsed;
}

function parsePointer(params: URLSearchParams): StaticPreviewPointer | undefined {
  const hasPointer =
    params.has('pointerX') ||
    params.has('pointerY') ||
    params.has('pointerInside');
  if (!hasPointer) return undefined;

  return {
    x: parseFiniteParam(params, 'pointerX'),
    y: parseFiniteParam(params, 'pointerY'),
    inside: parseBooleanParam(params, 'pointerInside'),
  };
}

function parseOptionalBoolean(params: URLSearchParams, name: string): boolean | undefined {
  if (!params.has(name)) return undefined;
  return parseBooleanParam(params, name);
}

function parseBooleanParam(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`static preview ${name} must be boolean`);
}

function clonePreviewValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clonePreviewValue(item, seen));
  }
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'root') continue;
    const cloned = clonePreviewValue(child, seen);
    if (cloned !== undefined) result[key] = cloned;
  }
  return result;
}
