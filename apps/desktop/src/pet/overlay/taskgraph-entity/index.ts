// ── Entity renderer entry ────────────────────────────────────────────
// Pixi-backed Blueprint Wren game entity for active TaskGraph instances.

import { createRenderSurface } from '../../render';
import { createWrenEntityPresenter } from '../../features/taskgraph-entity/presenter';
import { wrenFactSlipLabel, wrenStitchClasses } from '../../features/taskgraph-entity/fact-slip';
import { WREN_DISPLAY_W, WREN_DISPLAY_H } from '../../features/taskgraph-entity/scene';
import { bindWrenDrag, type WrenDragController } from '../../features/taskgraph-entity/interaction';

// ── Preload API contract ─────────────────────────────────────────────

interface EntityApi {
  openSelf: () => Promise<void>;
  entityDragStart: () => void;
  entityDragMove: () => void;
  entityDragEnd: () => void;
  setMousePassthrough: (passthrough: boolean) => Promise<void>;
  getState: () => Promise<{
    id: string;
    state: string;
    stale: boolean;
    exiting: boolean;
    terminal?: 'done' | 'cancelled';
    terminal_reason?: 'success' | 'node_failed' | 'cancelled';
    error_paused?: boolean;
    title?: string;
    nodeCounts?: { done: number; total: number };
    placement?: EntityPlacement;
  } | null>;
  onEntityState: (cb: (data: {
    id: string;
    state: string;
    stale: boolean;
    exiting: boolean;
    terminal?: 'done' | 'cancelled';
    terminal_reason?: 'success' | 'node_failed' | 'cancelled';
    error_paused?: boolean;
    title?: string;
    nodeCounts?: { done: number; total: number };
    placement?: EntityPlacement;
  }) => void) => () => void;
  onEntityPlacement: (cb: (placement: EntityPlacement) => void) => () => void;
}

interface EntityPlacement {
  bird_x: number;
  bird_y: number;
  tip_side: 'above' | 'below';
}

declare global {
  interface Window {
    entityApi: EntityApi;
  }
}

// ── State ────────────────────────────────────────────────────────────

interface FactSlipState {
  id: string;
  state: string;
  stale: boolean;
  exiting: boolean;
  terminal?: 'done' | 'cancelled';
  terminal_reason?: 'success' | 'node_failed' | 'cancelled';
  error_paused?: boolean;
  title?: string;
  nodeCounts?: { done: number; total: number };
  placement?: EntityPlacement;
}

let currentDto: FactSlipState | null = null;
let animationFrameId: number | null = null;
let isRunning = false;
let reduceMotion = false;
let presenter: ReturnType<typeof createWrenEntityPresenter> | null = null;
let canvas: HTMLCanvasElement | null = null;
let presenterInitialized = false;
let drag: WrenDragController | null = null;

// ── prefers-reduced-motion ───────────────────────────────────────────
function detectReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ── Animation loop ───────────────────────────────────────────────────

function startAnimation(): void {
  if (animationFrameId !== null || isRunning) return;
  isRunning = true;

  function frame(time: number): void {
    if (!isRunning) return;
    if (currentDto && presenter) {
      const hitRect = presenter.updatePose(
        currentDto.id,
        currentDto.state,
        currentDto.stale,
        currentDto.exiting,
        time,
        {
          terminal: currentDto.terminal,
          terminalReason: currentDto.terminal_reason,
          errorPaused: currentDto.error_paused,
          motion: reduceMotion ? 'reduced' : 'full',
        },
      );
      updateFactSlip(currentDto);
      updateMousePassthrough(hitRect);
    }
    animationFrameId = requestAnimationFrame(frame);
  }

  animationFrameId = requestAnimationFrame(frame);
}

function stopAnimation(): void {
  isRunning = false;
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

// ── Mouse passthrough ────────────────────────────────────────────────

let lastPassthrough = false;
let hideTimerId: ReturnType<typeof setTimeout> | null = null;

function updateMousePassthrough(_hitRect: { x: number; y: number; width: number; height: number }): void {
  const slip = document.querySelector<HTMLElement>('.fact-slip');
  const hitLayer = document.getElementById('entity-hit');
  const shouldPassthrough = !drag?.dragging && !(
    (hitLayer && hitLayer.matches(':hover')) ||
    (slip && slip.matches(':hover'))
  );
  if (shouldPassthrough !== lastPassthrough) {
    lastPassthrough = shouldPassthrough;
    window.entityApi.setMousePassthrough(shouldPassthrough);
  }
}

// ── Hide-grace timer ──────────────────────────────────────────────────

function cancelHideTimer(): void {
  if (hideTimerId !== null) {
    clearTimeout(hideTimerId);
    hideTimerId = null;
  }
}

function scheduleHideFactSlip(): void {
  cancelHideTimer(); // reset grace on each leave event
  hideTimerId = setTimeout(() => {
    hideTimerId = null;
    hideFactSlip();
  }, 120);
}

// ── Fact slip DOM ────────────────────────────────────────────────────

let factSlipEl: HTMLDivElement | null = null;

function ensureFactSlip(): HTMLDivElement {
  if (!factSlipEl) {
    factSlipEl = document.getElementById('fact-slip') as HTMLDivElement;
  }
  if (!factSlipEl) {
    factSlipEl = document.createElement('div');
    factSlipEl.className = 'fact-slip';
    factSlipEl.id = 'fact-slip';
    document.body.appendChild(factSlipEl);
  }
  return factSlipEl;
}

function updateFactSlip(dto: FactSlipState): void {
  const el = ensureFactSlip();
  const label = wrenFactSlipLabel({ title: dto.title, counts: dto.nodeCounts });
  // textContent only — hostile/malformed titles can never become markup.
  el.textContent = label;
  // Full untruncated label for the tooltip surface, never the ellipsized text.
  el.title = label;
  el.setAttribute('aria-label', label);
  el.setAttribute('role', 'tooltip');
  // Lifecycle state is carried by the stitch color/class alone (no prose).
  el.classList.remove('stitch-moss', 'stitch-slate', 'stitch-terracotta', 'stale');
  el.classList.add(...wrenStitchClasses({
    state: dto.state as 'created' | 'running' | 'paused',
    stale: dto.stale,
    exiting: dto.exiting,
    terminal: dto.terminal,
    terminal_reason: dto.terminal_reason,
    error_paused: dto.error_paused,
  }).split(' '));
}

function showFactSlip(): void {
  cancelHideTimer();
  const el = ensureFactSlip();
  el.classList.add('visible');
  updateMousePassthrough({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });
}

function hideFactSlip(): void {
  const el = ensureFactSlip();
  el.classList.remove('visible');
  updateMousePassthrough({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });
}

function isFactSlipVisible(): boolean {
  const el = ensureFactSlip();
  return el.classList.contains('visible');
}

// ── Forwarded-mouse event hit testing ─────────────────────────────────

function handlePointerMove(clientX: number, clientY: number): void {
  const hitLayer = document.getElementById('entity-hit');
  const rect = hitLayer ? hitLayer.getBoundingClientRect() : null;
  const birdHit = rect !== null &&
                  clientX >= rect.left && clientX <= rect.right &&
                  clientY >= rect.top && clientY <= rect.bottom;

  const slip = document.querySelector<HTMLElement>('.fact-slip');
  let slipHit = false;
  if (slip) {
    const slipRect = slip.getBoundingClientRect();
    slipHit = clientX >= slipRect.left && clientX <= slipRect.right &&
              clientY >= slipRect.top && clientY <= slipRect.bottom;
  }

  if (birdHit || slipHit) {
    cancelHideTimer();
    if (!isFactSlipVisible()) {
      showFactSlip();
    }
  } else {
    scheduleHideFactSlip();
  }
}

// ── Apply DTO ────────────────────────────────────────────────────────

function applyDto(data: {
  id: string;
  state: string;
  stale: boolean;
  exiting: boolean;
  terminal?: 'done' | 'cancelled';
  terminal_reason?: 'success' | 'node_failed' | 'cancelled';
  error_paused?: boolean;
  title?: string;
  nodeCounts?: { done: number; total: number };
  placement?: EntityPlacement;
}): void {
  currentDto = data;
  if (data.placement) applyPlacement(data.placement);

  if (!presenter) return;

  if (data.exiting || data.stale) {
    stopAnimation();
    presenter.updatePose(data.id, data.state, data.stale, data.exiting, performance.now(), {
      terminal: data.terminal,
      terminalReason: data.terminal_reason,
      errorPaused: data.error_paused,
      motion: reduceMotion ? 'reduced' : 'full',
    });
    updateFactSlip(currentDto!);
    updateMousePassthrough({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });
  } else if (data.state === 'running' && !reduceMotion) {
    presenter.updatePose(data.id, data.state, false, false, performance.now(), {
      terminal: data.terminal,
      terminalReason: data.terminal_reason,
      errorPaused: data.error_paused,
      motion: 'full',
    });
    updateFactSlip(currentDto!);
    updateMousePassthrough({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });
    startAnimation();
  } else {
    stopAnimation();
    presenter.updatePose(data.id, data.state, false, false, performance.now(), {
      terminal: data.terminal,
      terminalReason: data.terminal_reason,
      errorPaused: data.error_paused,
      motion: reduceMotion ? 'reduced' : 'full',
    });
    updateFactSlip(currentDto!);
    updateMousePassthrough({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });
  }
}

// ── Subscribe to entity state ────────────────────────────────────────

function subscribeToEntity(): void {
  window.entityApi.onEntityState((data) => {
    applyDto(data);
  });
  window.entityApi.onEntityPlacement(applyPlacement);
}

function applyPlacement(placement: EntityPlacement): void {
  if (!placement || !Number.isFinite(placement.bird_x) || !Number.isFinite(placement.bird_y)) return;
  if (placement.tip_side !== 'above' && placement.tip_side !== 'below') return;
  const root = document.documentElement;
  root.style.setProperty('--bird-x', `${placement.bird_x}px`);
  root.style.setProperty('--bird-y', `${placement.bird_y}px`);
  root.style.setProperty('--tip-y', placement.tip_side === 'above' ? '0px' : '66px');
}

// ── Init ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const c = document.getElementById('scene') as HTMLCanvasElement;
  if (!c) throw new Error('Missing #scene canvas');
  canvas = c;

  const surface = await createRenderSurface(c, { resolution: 1 });
  presenter = createWrenEntityPresenter(surface);
  presenterInitialized = true;
  reduceMotion = detectReducedMotion();

  const hitLayer = document.getElementById('entity-hit');
  if (!hitLayer) throw new Error('Missing #entity-hit layer');

  // Click / keyboard open-self (parameterless). A pointer drag emits a
  // synthetic click on mouseup; consume that one click instead of opening.
  hitLayer.addEventListener('click', () => {
    if (drag?.consumeOpenSuppression()) return;
    window.entityApi.openSelf();
  });

  hitLayer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      window.entityApi.openSelf();
    }
  });

  // Forwarded-mouse pointer tracking for hit testing
  document.addEventListener('mousemove', (e: MouseEvent) => {
    handlePointerMove(e.clientX, e.clientY);
  });

  // Toggle fact-slip visibility on bird/focus
  hitLayer.addEventListener('mouseenter', () => {
    cancelHideTimer();
    showFactSlip();
  });
  hitLayer.addEventListener('mouseleave', () => {
    if (!document.querySelector('.fact-slip:hover')) {
      scheduleHideFactSlip();
    }
  });
  hitLayer.addEventListener('focus', () => {
    cancelHideTimer();
    showFactSlip();
  });
  hitLayer.addEventListener('blur', () => {
    if (!document.querySelector('.fact-slip:hover')) {
      scheduleHideFactSlip();
    }
  });

  const slipEl = document.querySelector<HTMLElement>('.fact-slip');
  if (slipEl) {
    slipEl.addEventListener('mouseenter', () => {
      cancelHideTimer();
      showFactSlip();
    });
    slipEl.addEventListener('mouseleave', () => {
      const hitLayer = document.getElementById('entity-hit');
      if (!hitLayer || !hitLayer.matches(':hover')) {
        scheduleHideFactSlip();
      }
    });
  }

  drag = bindWrenDrag(window.entityApi, {
    win: window,
    doc: document,
    canStart: (event) => event.target instanceof Node && hitLayer.contains(event.target),
    onDraggingChange: (dragging) => {
      document.body.classList.toggle('entity-dragging', dragging);
      if (dragging) {
        cancelHideTimer();
        showFactSlip();
      }
      updateMousePassthrough({ x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H });
    },
  });

  subscribeToEntity();

  // Await initial state via sender-bound IPC (no renderer-supplied id)
  const initialState = await window.entityApi.getState();
  if (initialState) {
    applyDto(initialState);
  }

  // entityReady only when an owner-bound DTO exists (from getState or pushed during await)
  if (currentDto !== null) {
    document.documentElement.dataset.entityReady = '1';
  }
}

// ── Cleanup on unload ────────────────────────────────────────────────

function destroy(): void {
  cancelHideTimer();
  stopAnimation();
  drag?.dispose();
  drag = null;
  if (presenter) {
    presenter.destroy();
    presenter = null;
  }
  if (canvas && canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
  canvas = null;
  presenterInitialized = false;
  if (typeof document !== 'undefined' && document.documentElement) {
    delete document.documentElement.dataset.entityReady;
  }
}

window.addEventListener('unload', destroy);

if (typeof document !== 'undefined' && document.readyState !== 'loading') {
  init();
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
