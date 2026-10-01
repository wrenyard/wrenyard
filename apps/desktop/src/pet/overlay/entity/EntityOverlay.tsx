import '../api/entity-api';
// ── Blueprint Wren entity overlay (React) ────────────────────────────
// The entity window is a transparent React root: the Pixi origami-bird sprite
// underneath the DOM paper-tag fact slip (`Card` + theme tokens).

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Card } from '@/renderer/components/ui/card';
import { createRenderSurface } from '../../render';
import {
  createWrenEntityPresenter,
  wrenFactSlipLabel,
  wrenStitchClasses,
  wrenStitchTokenClass,
  type WrenEntityPresenter,
} from '../../features/taskgraph-entity/presenter';
import { WREN_DISPLAY_W, WREN_DISPLAY_H } from '../../features/taskgraph-entity/scene';
import { bindWrenDrag, type WrenDragController } from '../../features/taskgraph-entity/interaction';
import { OverlayRoot, type CanvasHitTest, type PetAppearanceBridge } from '../OverlayRoot';

export interface EntityOverlayProps {
  appearance?: PetAppearanceBridge;
}

interface EntityPlacement {
  bird_x: number;
  bird_y: number;
  tip_side: 'above' | 'below';
}

interface EntityDto {
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

const HIDE_GRACE_MS = 120;

export function EntityOverlay({ appearance }: EntityOverlayProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const presenterRef = useRef<WrenEntityPresenter | null>(null);
  const dragRef = useRef<WrenDragController | null>(null);
  const placementRef = useRef({ x: 0, y: 0 });
  const slipRef = useRef<HTMLDivElement | null>(null);
  const dtoRef = useRef<EntityDto | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPassthroughRef = useRef<boolean | undefined>(undefined);

  const [dto, setDto] = useState<EntityDto | null>(null);
  const [slipVisible, setSlipVisible] = useState(false);
  const reduceMotionRef = useRef(false);

  const emitPassthrough = useCallback((passthrough: boolean): void => {
    if (lastPassthroughRef.current === passthrough) return;
    lastPassthroughRef.current = passthrough;
    void window.entityApi.setMousePassthrough(passthrough);
  }, []);

  const isCanvasOpaqueAt = useCallback<CanvasHitTest>((x, y) => {
    const { x: bx, y: by } = placementRef.current;
    return x >= bx && x <= bx + WREN_DISPLAY_W && y >= by && y <= by + WREN_DISPLAY_H;
  }, []);

  const cancelHide = useCallback((): void => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const showSlip = useCallback((): void => {
    cancelHide();
    setSlipVisible(true);
  }, [cancelHide]);

  const scheduleHide = useCallback((): void => {
    cancelHide();
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setSlipVisible(false);
    }, HIDE_GRACE_MS);
  }, [cancelHide]);

  // Renderer lifecycle: Pixi sprite canvas, subscribe to pushed entity state,
  // and drive the wing animation while the graph is running.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let surface: Awaited<ReturnType<typeof createRenderSurface>> | undefined;
    let rafId: number | null = null;
    let running = false;
    let cleanup: (() => void) | undefined;

    const prefersReduced = (): boolean => {
      try {
        return typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
    };

    const pose = (nowMs: number): void => {
      const current = dtoRef.current;
      const presenter = presenterRef.current;
      if (!current || !presenter) return;
      const hitRect = presenter.updatePose(
        current.id,
        current.state,
        current.stale,
        current.exiting,
        nowMs,
        {
          terminal: current.terminal,
          terminalReason: current.terminal_reason,
          errorPaused: current.error_paused,
          motion: reduceMotionRef.current ? 'reduced' : 'full',
        },
      );
      void hitRect;
    };

    const frame = (time: number): void => {
      if (!running) return;
      pose(time);
      rafId = requestAnimationFrame(frame);
    };

    const startAnimation = (): void => {
      if (rafId !== null || running) return;
      running = true;
      rafId = requestAnimationFrame(frame);
    };

    const stopAnimation = (): void => {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const applyPlacement = (placement: EntityPlacement): void => {
      if (!placement || !Number.isFinite(placement.bird_x) || !Number.isFinite(placement.bird_y)) return;
      if (placement.tip_side !== 'above' && placement.tip_side !== 'below') return;
      placementRef.current = { x: placement.bird_x, y: placement.bird_y };
      presenterRef.current?.setPosition(placement.bird_x, placement.bird_y);
      const root = document.documentElement;
      root.style.setProperty('--bird-x', `${placement.bird_x}px`);
      root.style.setProperty('--bird-y', `${placement.bird_y}px`);
      root.style.setProperty('--tip-y', placement.tip_side === 'above' ? '0px' : `${WREN_DISPLAY_H}px`);
    };

    const applyDto = (data: EntityDto): void => {
      dtoRef.current = data;
      setDto(data);
      if (data.placement) applyPlacement(data.placement);
      const presenter = presenterRef.current;
      if (!presenter) return;

      if (data.exiting || data.stale) {
        stopAnimation();
        pose(performance.now());
      } else if (data.state === 'running' && !reduceMotionRef.current) {
        pose(performance.now());
        startAnimation();
      } else {
        stopAnimation();
        pose(performance.now());
      }
    };

    void (async () => {
      try {
        surface = await createRenderSurface(canvas, { resolution: 1 });
        if (disposed) {
          surface.destroy();
          return;
        }
        presenterRef.current = createWrenEntityPresenter(surface);
        surface.resize(window.innerWidth, window.innerHeight, 1);
        presenterRef.current.setPosition(placementRef.current.x, placementRef.current.y);
        reduceMotionRef.current = prefersReduced();

        const disposeState = window.entityApi.onEntityState((data) => applyDto(data));
        const disposePlacement = window.entityApi.onEntityPlacement(applyPlacement);

        dragRef.current = bindWrenDrag(window.entityApi, {
          win: window,
          doc: document,
          canStart: (event) => isCanvasOpaqueAt(event.clientX, event.clientY),
          onDraggingChange: (dragging) => {
            document.body.classList.toggle('entity-dragging', dragging);
            if (dragging) showSlip();
          },
        });

        const initialState = await window.entityApi.getState();
        if (initialState && !disposed) applyDto(initialState as EntityDto);

        if (dtoRef.current !== null) {
          document.documentElement.dataset.entityReady = '1';
        }

        cleanup = () => {
          disposeState();
          disposePlacement();
        };
      } catch (error) {
        if (!disposed) throw error;
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
      stopAnimation();
      dragRef.current?.dispose();
      dragRef.current = null;
      presenterRef.current?.destroy();
      presenterRef.current = null;
      surface?.destroy();
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
      delete document.documentElement.dataset.entityReady;
    };
  }, [isCanvasOpaqueAt, showSlip]);

  // Pointer tracking for the fact-slip hover grace and passthrough updates.
  useEffect(() => {
    const overBird = (x: number, y: number): boolean => {
      const { x: bx, y: by } = placementRef.current;
      return x >= bx && x <= bx + WREN_DISPLAY_W && y >= by && y <= by + WREN_DISPLAY_H;
    };
    const overSlip = (x: number, y: number): boolean => {
      const slip = slipRef.current;
      if (!slip || slip.classList.contains('hidden')) return false;
      const rect = slip.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    const onMove = (event: MouseEvent): void => {
      if (dragRef.current?.dragging) {
        showSlip();
        emitPassthrough(false);
        return;
      }
      const hit = overBird(event.clientX, event.clientY) || overSlip(event.clientX, event.clientY);
      if (hit) {
        showSlip();
      } else {
        scheduleHide();
      }
      emitPassthrough(!hit);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [emitPassthrough, scheduleHide, showSlip]);

  // Click / keyboard open-self. A pointer drag emits a synthetic click on
  // mouseup; consume that one click instead of opening.
  useEffect(() => {
    const onPointerOverBird = (x: number, y: number): boolean => {
      const { x: bx, y: by } = placementRef.current;
      return x >= bx && x <= bx + WREN_DISPLAY_W && y >= by && y <= by + WREN_DISPLAY_H;
    };
    const onClick = (event: MouseEvent): void => {
      if (dragRef.current?.consumeOpenSuppression()) return;
      if (onPointerOverBird(event.clientX, event.clientY)) void window.entityApi.openSelf();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void window.entityApi.openSelf();
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const label = dto
    ? wrenFactSlipLabel({ title: dto.title, counts: dto.nodeCounts })
    : '';
  const stitchInput = dto
    ? {
      state: (dto.state === 'running' || dto.state === 'paused' ? dto.state : 'created') as 'created' | 'running' | 'paused',
      stale: dto.stale,
      exiting: dto.exiting,
      terminal: dto.terminal,
      terminal_reason: dto.terminal_reason,
      error_paused: dto.error_paused,
    }
    : undefined;

  return (
    <OverlayRoot
      appearance={appearance}
      canvasRef={canvasRef}
      isCanvasOpaqueAt={isCanvasOpaqueAt}
      onPassthroughChange={emitPassthrough}
    >
      {label ? (
        <Card
          ref={slipRef}
          id="fact-slip"
          data-hit
          size="sm"
          role="tooltip"
          aria-label={label}
          title={label}
          className={[
            'absolute left-1 w-[148px] border border-border px-2 text-xs text-foreground',
            wrenStitchClasses(stitchInput!),
            stitchInput && dto?.stale ? 'border-dashed opacity-65' : '',
            slipVisible ? 'visible block' : 'hidden',
          ].join(' ')}
          style={{ top: 'var(--tip-y, 66px)' }}
        >
          <span className="truncate">{label}</span>
          <span
            aria-hidden="true"
            className={`absolute inset-x-1 bottom-0.5 h-0.5 bg-current ${stitchInput ? wrenStitchTokenClass(stitchInput) : ''}`}
          />
        </Card>
      ) : null}
    </OverlayRoot>
  );
}
