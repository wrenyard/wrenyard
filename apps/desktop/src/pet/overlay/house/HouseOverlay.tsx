// ── House overlay (React) ────────────────────────────────────────────
// The house window is a transparent React root: a Pixi pixel sprite canvas
// underneath purely presentational DOM chrome. The quota tips reuse the shell
// `QuotaTips` component; the broadcast banner and its close control reuse
// `Card`/`Button`/`Badge` plus theme tokens.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { QuotaTips } from '@/renderer/components/usage/QuotaTips';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import type { QuotaProviderSnapshot } from '@/shell-contract';
import type { PetApi } from '../api/pet-api';
import { createRenderSurface } from '../../render';
import type { HouseRendererState, QuotaTipLine } from '../../shared/entities';
import {
  buildSummaryLines,
  HousePresenter,
  type HousePresenterOutput,
} from '../../features/house/presenter';
import { bindHouseDrag } from '../../features/house/interaction';
import type { BrowserDragController } from '../runtime/drag';
import { dismissBroadcastLocally } from '../../features/house/broadcast-dismiss';
import { broadcastAlpha } from '../../features/house/scene/broadcast-expiry';
import { installStaticPreviewMode, type StaticPreviewMode } from '../static-preview';
import { readBrowserViewport } from '../viewport';
import { OverlayRoot, type CanvasHitTest, type PetAppearanceBridge } from '../OverlayRoot';
import { useNow } from '../OverlayUi';

export interface HouseOverlayProps {
  appearance?: PetAppearanceBridge;
  api?: PetApi;
}

const HOVER_AUDIT_MS = 100;

interface PointerState {
  x: number;
  y: number;
  inside: boolean;
}

export function HouseOverlay({ appearance, api }: HouseOverlayProps): ReactElement {
  const petApi = api ?? (typeof window !== 'undefined' ? window.petApi : undefined);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const presenterRef = useRef<HousePresenter | null>(null);
  const dragRef = useRef<BrowserDragController | undefined>(undefined);
  const pointerRef = useRef<PointerState>({ x: -1, y: -1, inside: false });
  const pointerPassthroughRef = useRef(true);
  const lastEmittedRef = useRef<boolean | undefined>(undefined);

  const [house, setHouse] = useState<HouseRendererState | undefined>(undefined);
  const [art, setArt] = useState<HousePresenterOutput | undefined>(undefined);
  const [pointer, setPointer] = useState<PointerState>(pointerRef.current);
  const [dragging, setDragging] = useState(false);
  const [windowSize, setWindowSize] = useState(() => ({ width: 1, height: 1 }));
  const clockNow = useNow(500);
  const [staticPreview, setStaticPreview] = useState<StaticPreviewMode | undefined>(undefined);
  const now = staticPreview ? staticPreview.nowMs : clockNow;

  const emitPassthrough = useCallback((passthrough: boolean): void => {
    if (lastEmittedRef.current === passthrough) return;
    lastEmittedRef.current = passthrough;
    petApi?.setHouseMousePassthrough(passthrough);
  }, [petApi]);

  // Canvas hit test is read through the ref so OverlayRoot keeps one stable
  // listener for the lifetime of the root.
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

  // Renderer lifecycle: subscribe first (buffering early pushes), then build
  // the Pixi surface, replay the latest state and finally start the ticker.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !petApi) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let resizeListener: (() => void) | undefined;
    let moveListener: ((event: MouseEvent) => void) | undefined;
    let leaveListener: (() => void) | undefined;
    let auditTimer: number | undefined;
    let applyState: ((state: HouseRendererState, nowMs?: number) => void) | undefined;
    let latestState: HouseRendererState | undefined;
    let surface: Awaited<ReturnType<typeof createRenderSurface>> | undefined;

    unsubscribe = petApi.onHouseUpdate((state) => {
      latestState = state;
      applyState?.(state);
    });

    void (async () => {
      try {
        const viewport = readBrowserViewport(window);
        surface = await createRenderSurface(canvas, { resolution: viewport.dpr });
        if (disposed) {
          surface.destroy();
          return;
        }
        const presenter = new HousePresenter(surface);
        presenterRef.current = presenter;

        const paint = (state: HouseRendererState, nowMs?: number): void => {
          setHouse(state);
          setArt(presenter.setState(state, nowMs));
        };
        applyState = paint;

        const resize = (nowMs?: number): void => {
          const next = readBrowserViewport(window);
          setWindowSize({ width: next.cssWidth, height: next.cssHeight });
          setArt(presenter.resize(next.cssWidth, next.cssHeight, next.dpr, nowMs));
        };

        resize();
        if (latestState) paint(latestState);

        let scale = 3;
        try {
          const config = await petApi.getConfig();
          if (typeof config.scale === 'number') scale = config.scale;
        } catch {
          // Keep default scale when recovery/previews do not provide config.
        }
        if (!latestState) {
          paint({ scale, houseSkin: 'classic', workers: [], queuedCount: 0 });
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
              mode.markReady(buildHouseDiagnostics(presenter));
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

        // Reconcile lost forwarded mouseleave while the hover chrome is
        // visible, using the main process' authoritative cursor.
        let auditInFlight = false;
        auditTimer = window.setInterval(() => {
          if (auditInFlight || dragRef.current?.dragging) return;
          const rect = presenter.getOutput()?.houseRect;
          if (!rect) return;
          auditInFlight = true;
          void petApi.getHouseCursorPoint()
            .then((point) => {
              if (!point || dragRef.current?.dragging) return;
              pointerRef.current = point;
              setPointer(point);
            })
            .catch(() => {
              // Renderer recovery can briefly race the IPC owner; the next
              // audit converges without keeping hover chrome alive artificially.
            })
            .finally(() => {
              auditInFlight = false;
            });
        }, HOVER_AUDIT_MS);

        dragRef.current = bindHouseDrag(petApi, {
          win: window,
          doc: document,
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
      if (auditTimer !== undefined) window.clearInterval(auditTimer);
      presenterRef.current?.destroy();
      presenterRef.current = null;
      surface?.destroy();
    };
  }, [petApi, emitPassthrough]);

  const onCloseBroadcast = useCallback((): void => {
    const presenter = presenterRef.current;
    const state = presenter?.getState();
    if (!presenter || !state) return;
    const dismissed = dismissBroadcastLocally(state);
    presenter.setState(dismissed.state);
    setHouse(dismissed.state);
    petApi?.dismissBroadcast(dismissed.id);
  }, [petApi]);

  const broadcast = house?.broadcast;
  const broadcastVisible = broadcast !== undefined && broadcastAlpha(broadcast, now) > 0;

  const overHouse = pointer.inside && (presenterRef.current?.hitTest(pointer.x, pointer.y) ?? false);
  const tipsAvailable = (house?.quotaTips?.length ?? 0) > 0;
  const statsAvailable = house?.dailyStats?.source === 'sqlite' && !tipsAvailable;
  const tipsVisible = overHouse && !dragging && (tipsAvailable || statsAvailable);

  const summaryLines = useMemo(() => (house ? buildSummaryLines({
    runningWorkerCount: house.workers.filter((worker) => worker.phase === 'working').length,
    queuedCount: house.queuedCount,
    taskgraphCount: house.taskgraphCount,
    activityStale: house.activityStale,
    dailyStats: house.dailyStats,
    dailyStatsUnavailable: house.dailyStatsUnavailable,
  }) : []), [house]);

  const quotaProviders = useMemo(
    () => adaptQuotaTips(house?.quotaTips),
    [house?.quotaTips],
  );

  const houseRect = art?.houseRect;
  const anchorLeft = houseRect ? houseRect.x + houseRect.width / 2 : windowSize.width / 2;
  const anchorBottom = houseRect ? windowSize.height - houseRect.y + 4 : 4;
  const chromeVisible = broadcastVisible || tipsVisible;

  return (
    <OverlayRoot
      appearance={appearance}
      canvasRef={canvasRef}
      isCanvasOpaqueAt={isCanvasOpaqueAt}
      onPassthroughChange={onPassthroughChange}
    >
      {chromeVisible ? (
        <div
          className="pointer-events-none absolute flex flex-col items-center gap-1 overflow-y-auto"
          style={{ left: anchorLeft, bottom: anchorBottom, maxHeight: Math.max(80, windowSize.height - anchorBottom - 8), transform: 'translateX(-50%)' }}
        >
          {broadcastVisible && broadcast ? (
            <Card
              data-hit
              data-preview="house-broadcast"
              style={{ opacity: broadcastAlpha(broadcast, now) }}
              className="pointer-events-auto gap-1 rounded-lg border-border bg-popover/95 p-2 text-xs text-popover-foreground shadow"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 whitespace-normal break-words">{broadcast.text}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-hit
                  data-preview="house-broadcast-close"
                  aria-label="关闭通知"
                  className="sticky-hit"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseBroadcast();
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            </Card>
          ) : null}

          {tipsVisible ? (
            <Card
              data-hit
              data-preview="house-tips"
              className="pointer-events-auto w-80 rounded-lg border-border bg-popover/95 p-2 text-xs text-popover-foreground shadow"
            >
              {summaryLines.length > 0 ? (
                <div className="flex flex-col gap-0.5 text-muted-foreground">
                  {summaryLines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
              ) : null}
              {tipsAvailable ? <QuotaTips providers={quotaProviders} now={now} /> : null}
            </Card>
          ) : null}
        </div>
      ) : null}
    </OverlayRoot>
  );
}

/** Map the Pet quota tip DTOs onto the shared `QuotaTips` provider snapshots. */
export function adaptQuotaTips(tips: readonly QuotaTipLine[] | undefined): QuotaProviderSnapshot[] {
  if (!tips || tips.length === 0) return [];
  const providers: QuotaProviderSnapshot[] = [];
  for (const tip of tips) {
    if (tip.errorRow) {
      providers.push({
        id: tip.errorRow.label,
        label: tip.errorRow.label,
        status: 'error',
        stale: false,
        windows: [],
        balances: [],
        message: tip.errorRow.message,
      });
      continue;
    }
    if (tip.balances && tip.balances.length > 0) {
      const id = tip.balanceLabel ?? tip.text;
      providers.push({
        id,
        label: id,
        status: 'ok',
        stale: false,
        windows: [],
        balances: tip.balances.map((balance) => ({
          currency: balance.currency,
          amount: balance.amount,
          display: balance.display,
        })),
      });
      continue;
    }
    if (tip.bars && tip.bars.length > 0) {
      for (const bar of tip.bars) {
        providers.push({
          id: bar.label,
          label: bar.label,
          status: bar.status,
          stale: bar.stale,
          windows: bar.provider.windows.map((window) => ({
            name: window.name,
            remainingPct: window.remainingPct,
            expectedRemainingPct: window.expectedRemainingPct,
            ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
            ...(window.windowMinutes !== undefined ? { windowMinutes: window.windowMinutes } : {}),
          })),
          balances: [],
          ...(bar.error ? { message: bar.error } : {}),
        });
      }
      continue;
    }
    providers.push({
      id: tip.text,
      label: tip.text,
      status: 'unavailable',
      stale: false,
      windows: [],
      balances: [],
      message: tip.text,
    });
  }
  return providers;
}

interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HousePreviewDiagnostics {
  houseRect: PreviewRect;
  hitRects: Array<PreviewRect & { target: 'house' | 'broadcast-close' }>;
  broadcast?: PreviewRect & { text: string };
  closeRect?: PreviewRect;
  stats?: PreviewRect & { text: string; lines: string[] };
}

function rectOf(selector: string): PreviewRect | undefined {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function buildHouseDiagnostics(
  presenter: HousePresenter,
): HousePreviewDiagnostics {
  const output: HousePresenterOutput | undefined = presenter.getOutput();
  const state = presenter.getState();
  const houseRect = output?.houseRect ?? { x: 0, y: 0, width: 0, height: 0 };
  const broadcastEl = rectOf('[data-preview="house-broadcast"]');
  const closeRect = rectOf('[data-preview="house-broadcast-close"]');
  const tipsRect = rectOf('[data-preview="house-tips"]');
  const lines = state ? buildSummaryLines({
    runningWorkerCount: state.workers.filter((worker) => worker.phase === 'working').length,
    queuedCount: state.queuedCount,
    taskgraphCount: state.taskgraphCount,
    activityStale: state.activityStale,
    dailyStats: state.dailyStats,
    dailyStatsUnavailable: state.dailyStatsUnavailable,
  }) : [];
  const hitRects: HousePreviewDiagnostics['hitRects'] = [{ ...houseRect, target: 'house' }];
  if (closeRect) hitRects.push({ ...closeRect, target: 'broadcast-close' });

  const diagnostics: HousePreviewDiagnostics = { houseRect, hitRects };
  if (broadcastEl && state?.broadcast) {
    diagnostics.broadcast = { ...broadcastEl, text: state.broadcast.text };
  }
  if (closeRect) diagnostics.closeRect = closeRect;
  if (tipsRect) {
    diagnostics.stats = { ...tipsRect, text: lines.join('\n'), lines };
  }
  return diagnostics;
}
