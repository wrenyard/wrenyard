// ── Worker overlay (React) ───────────────────────────────────────────
// The worker window is a transparent React root: the Pixi mascot sprite
// underneath DOM chrome. The speech bubble uses the shared Bubble/BubbleContent
// and the age/task label and tool/client cues reuse `Badge` plus lucide icons
// and theme tokens.

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Bot, Gem, Sparkles, Terminal, Wrench } from 'lucide-react';
import { Badge } from '@/renderer/components/ui/badge';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import type { PetApi } from '../api/pet-api';
import { createRenderSurface } from '../../render';
import type { WorkerRendererState } from '../../shared/entities';
import type { WorkerClient } from '../../shared/snapshot';
import {
  WorkerPresenter,
  resolveWorkerLabelText,
} from '../../features/worker/presenter';
import { toolFlashAlpha } from '../../features/worker/scene/timing';
import { bindWorkerDrag } from '../../features/worker/interaction';
import type { BrowserDragController } from '../runtime/drag';
import { installStaticPreviewMode, type StaticPreviewMode } from '../static-preview';
import { readBrowserViewport } from '../viewport';
import { OverlayRoot, type CanvasHitTest, type PetAppearanceBridge } from '../OverlayRoot';
import { useNow } from '../OverlayUi';
import { useTypewriter } from '../use-typewriter';

export interface WorkerOverlayProps {
  appearance?: PetAppearanceBridge;
  api?: PetApi;
}

interface PointerState {
  x: number;
  y: number;
  inside: boolean;
}

const WORKER_BOX_W = 40;

export function WorkerOverlay({ appearance, api }: WorkerOverlayProps): ReactElement {
  const petApi = api ?? (typeof window !== 'undefined' ? window.petApi : undefined);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const presenterRef = useRef<WorkerPresenter | null>(null);
  const dragRef = useRef<BrowserDragController | undefined>(undefined);
  const pointerRef = useRef<PointerState>({ x: -1, y: -1, inside: false });
  const pointerPassthroughRef = useRef(true);
  const lastEmittedRef = useRef<boolean | undefined>(undefined);

  const [worker, setWorker] = useState<WorkerRendererState | undefined>(undefined);
  const [pointer, setPointer] = useState<PointerState>(pointerRef.current);
  const [dragging, setDragging] = useState(false);
  const [staticPreview, setStaticPreview] = useState<StaticPreviewMode | undefined>(undefined);
  const [windowSize, setWindowSize] = useState(() => ({ width: 1, height: 1 }));
  const reduceMotion = appearance?.getSnapshot().reduceMotion ?? false;
  const clockNow = useNow(250);
  const now = staticPreview ? staticPreview.nowMs : clockNow;

  const emitPassthrough = useCallback((passthrough: boolean): void => {
    if (lastEmittedRef.current === passthrough) return;
    lastEmittedRef.current = passthrough;
    const workerId = presenterRef.current?.getWorkerId();
    if (!workerId) return;
    petApi?.setWorkerMousePassthrough(workerId, passthrough);
  }, [petApi]);

  const isCanvasOpaqueAt = useCallback<CanvasHitTest>(
    (x, y) => presenterRef.current?.hitTest(x, y) ?? false,
    [],
  );

  const onPassthroughChange = useCallback((passthrough: boolean): void => {
    pointerPassthroughRef.current = passthrough;
    if (dragRef.current?.dragging) {
      emitPassthrough(false);
      return;
    }
    emitPassthrough(passthrough);
  }, [emitPassthrough]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !petApi) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let resizeListener: (() => void) | undefined;
    let moveListener: ((event: MouseEvent) => void) | undefined;
    let leaveListener: (() => void) | undefined;
    let applyState: ((state: WorkerRendererState, nowMs?: number) => void) | undefined;
    let latestState: WorkerRendererState | undefined;
    let surface: Awaited<ReturnType<typeof createRenderSurface>> | undefined;

    unsubscribe = petApi.onWorkerUpdate((state) => {
      latestState = state;
      applyState?.(state);
    });

    void (async () => {
      try {
        const viewport = readBrowserViewport(window);
        setWindowSize({ width: viewport.cssWidth, height: viewport.cssHeight });
        surface = await createRenderSurface(canvas, { resolution: viewport.dpr });
        if (disposed) {
          surface.destroy();
          return;
        }
        const presenter = new WorkerPresenter(surface);
        presenterRef.current = presenter;

        const paint = (state: WorkerRendererState, nowMs?: number): void => {
          setWorker(state);
          presenter.setState(state, nowMs);
        };
        applyState = paint;

        const resize = (nowMs?: number): void => {
          const next = readBrowserViewport(window);
          setWindowSize({ width: next.cssWidth, height: next.cssHeight });
          presenter.resize(next.cssWidth, next.cssHeight, next.dpr, nowMs);
        };

        resize();
        if (latestState) paint(latestState);

        try {
          await petApi.getConfig();
        } catch {
          // Missing config should not break renderer recovery or previews.
        }

        const mode = installStaticPreviewMode(window.location.search, canvas, document);
        if (mode) {
          setStaticPreview(mode);
          const initPointer = mode.pointer ?? { x: -1, y: -1, inside: false };
          pointerRef.current = initPointer;
          setPointer(initPointer);
          setDragging(mode.dragging ?? false);
          presenter.renderFrame(mode.initNowMs);
          presenter.renderFrame(mode.nowMs);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (disposed) return;
              mode.markReady(presenter.getOutput() ?? null);
            });
          });
          return;
        }

        resizeListener = () => resize();
        window.addEventListener('resize', resizeListener);

        moveListener = (event: MouseEvent): void => {
          const next = { x: event.clientX, y: event.clientY, inside: true };
          pointerRef.current = next;
          setPointer(next);
        };
        leaveListener = (): void => {
          if (dragRef.current?.dragging) return;
          const next = { x: -1, y: -1, inside: false };
          pointerRef.current = next;
          setPointer(next);
        };
        window.addEventListener('mousemove', moveListener);
        window.addEventListener('mouseleave', leaveListener);

        dragRef.current = bindWorkerDrag(petApi, {
          win: window,
          doc: document,
          getId: () => presenter.getWorkerId(),
          canStart: (event) => presenter.hitTest(event.clientX, event.clientY),
          onDraggingChange: (nextDragging) => {
            setDragging(nextDragging);
            if (nextDragging) {
              emitPassthrough(false);
            } else {
              emitPassthrough(pointerPassthroughRef.current);
            }
          },
        });

        presenter.start();
      } catch (error) {
        if (!disposed) throw error;
      }
    })();

    return () => {
      disposed = true;
      unsubscribe?.();
      dragRef.current?.dispose();
      dragRef.current = undefined;
      if (resizeListener) window.removeEventListener('resize', resizeListener);
      if (moveListener) window.removeEventListener('mousemove', moveListener);
      if (leaveListener) window.removeEventListener('mouseleave', leaveListener);
      presenterRef.current?.destroy();
      presenterRef.current = null;
      surface?.destroy();
    };
  }, [petApi, emitPassthrough]);

  const workerView = worker?.worker;
  const scale = worker?.scale ?? 3;
  const hovering = pointer.inside && (presenterRef.current?.hitTest(pointer.x, pointer.y) ?? false) && !dragging;

  const bubble = workerView?.bubble;
  const [revealStart, setRevealStart] = useState(0);
  const lastBubbleTextRef = useRef('');
  useEffect(() => {
    if (!bubble?.text) {
      lastBubbleTextRef.current = '';
      return;
    }
    if (staticPreview || bubble.text !== lastBubbleTextRef.current) {
      lastBubbleTextRef.current = bubble.text;
      setRevealStart(staticPreview ? staticPreview.initNowMs : Date.now());
    }
  }, [bubble?.text, staticPreview]);

  const typewriter = useTypewriter({
    text: bubble?.text ?? '',
    startMs: revealStart,
    untilMs: bubble?.untilMs ?? 0,
    reduceMotion,
    nowMs: staticPreview?.nowMs,
  });
  const bubbleVisible = Boolean(bubble?.text) && typewriter.alpha > 0;

  const label = workerView
    ? resolveWorkerLabelText({
      hovering,
      taskName: workerView.taskName,
      taskLabel: workerView.taskLabel,
      taskId: workerView.taskId,
      startedAt: workerView.startedAt,
      nowMs: now,
    })
    : undefined;

  const toolCount = workerView?.toolCount ?? 0;
  const lastToolTs = workerView?.lastToolTs;
  const toolVisible = toolCount > 0 && (hovering || toolFlashAlpha(now, lastToolTs) > 0);
  const toolAlpha = hovering ? 1 : toolFlashAlpha(now, lastToolTs);

  const workerLeft = Math.max(0, Math.floor((windowSize.width / scale - WORKER_BOX_W) / 2));
  const anchorX = (workerLeft + WORKER_BOX_W / 2) * scale;
  const footlineY = 32 * scale;

  return (
    <OverlayRoot
      appearance={appearance}
      canvasRef={canvasRef}
      isCanvasOpaqueAt={isCanvasOpaqueAt}
      onPassthroughChange={onPassthroughChange}
    >
      {bubbleVisible ? (
        <div
          className="pointer-events-none absolute"
          style={{ left: anchorX, bottom: footlineY + 26, transform: 'translateX(-50%)', opacity: typewriter.alpha }}
        >
          <Bubble
            data-hit
            variant="outline"
            className="pointer-events-auto max-w-[280px]"
          >
            <BubbleContent className="px-2 py-1 text-xs">
              <span className="whitespace-pre-wrap break-words">{typewriter.text}</span>
            </BubbleContent>
          </Bubble>
        </div>
      ) : null}

      {toolVisible ? (
        <div
          className="pointer-events-none absolute"
          style={{ left: anchorX + 11 * scale, bottom: footlineY + 4, opacity: toolAlpha }}
        >
          <Badge variant="secondary" data-hit className="pointer-events-auto gap-0.5">
            <ToolIcon skinId={workerView?.appearance.skin.id} />
            <span className="tabular-nums">× {Math.floor(toolCount)}</span>
          </Badge>
        </div>
      ) : null}

      {workerView ? (
        <div
          className="pointer-events-none absolute flex flex-col items-center gap-1"
          style={{ left: anchorX, bottom: Math.max(0, footlineY - 14), transform: 'translateX(-50%)' }}
        >
          {workerView.client !== 'unknown' ? (
            <Badge variant="outline" data-hit className="pointer-events-auto gap-1">
              <ClientIcon client={workerView.client} />
            </Badge>
          ) : null}
          {label ? (
            <Badge variant={label.kind === 'task' ? 'secondary' : 'outline'} data-hit className="pointer-events-auto">
              {label.text}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </OverlayRoot>
  );
}

function ToolIcon({ skinId }: { skinId: string | undefined }): ReactNode {
  if (skinId === 'classic-voxel-miner') return <Gem aria-hidden="true" />;
  return <Wrench aria-hidden="true" />;
}

function ClientIcon({ client }: { client: WorkerClient }): ReactNode {
  if (client === 'claude') return <Sparkles aria-hidden="true" />;
  if (client === 'codex') return <Terminal aria-hidden="true" />;
  if (client === 'codebuddy') return <Bot aria-hidden="true" />;
  return null;
}
