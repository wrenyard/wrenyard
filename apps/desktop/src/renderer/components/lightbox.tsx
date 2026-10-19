/**
 * Full-window image lightbox over the images registered in `lightbox-store`:
 * ← and → move through the images of one turn as they are shown. The image
 * loads at original resolution when a session file backs it, with the
 * thumbnail's preview shown until then.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen, X } from 'lucide-react';
import { cn } from 'cn';
import { ImageViewer } from '@/renderer/components/image-viewer';
import { Button } from '@/renderer/components/ui/button';
import { Spinner } from '@/renderer/components/ui/spinner';
import { toast } from '@/renderer/lib/notify';
import { getSessionBridge } from '@/renderer/lib/session';
import { lightboxState, setLightboxState, subscribeLightbox, type LightboxItem, type LightboxState } from './lightbox-store';

const REVEAL_LABEL = navigator.userAgent.includes('Mac') ? '在访达中显示' : '在文件管理器中显示';

/** The original image of a session file; the preview until it loads. */
function useOriginal(item: LightboxItem): { src: string; loading: boolean } {
  const [original, setOriginal] = useState<{ key: string; src?: string }>({ key: '' });
  const key = item.media === undefined ? '' : `${item.media.sessionId}\u0000${item.media.path}`;
  useEffect(() => {
    if (item.media === undefined) return;
    let cancelled = false;
    void getSessionBridge().readOriginalMedia(item.media).then(
      (src) => { if (!cancelled) setOriginal({ key, ...(src === undefined ? {} : { src }) }); },
      () => { if (!cancelled) setOriginal({ key }); },
    );
    return () => { cancelled = true; };
  }, [key]);
  if (item.media === undefined) return { src: item.src, loading: false };
  if (original.key !== key) return { src: item.src, loading: true };
  return { src: original.src ?? item.src, loading: false };
}

function LightboxView({ current }: { current: LightboxState }) {
  const item = current.items[current.index]!;
  const { src, loading } = useOriginal(item);
  const count = current.items.length;
  const close = useCallback((): void => {
    setLightboxState(null);
    current.trigger.focus();
  }, [current.trigger]);
  const go = useCallback((delta: number): void => {
    const index = current.index + delta;
    if (index < 0 || index >= count) return;
    setLightboxState({ ...current, index });
  }, [current, count]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
      else return;
      // The lightbox owns these keys while open.
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close, go]);

  const media = item.media;
  const run = (action: (request: { sessionId: string; path: string }) => Promise<void>, done?: string): void => {
    if (media === undefined) return;
    void action(media).then(
      () => { if (done !== undefined) toast(done); },
      (error: unknown) => toast(error instanceof Error ? error.message : String(error), { level: 'error' }),
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      data-open=""
      className="group/lightbox fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
    >
      <div className="flex shrink-0 items-center gap-3 px-4 py-2">
        <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
        {count > 1 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{current.index + 1} / {count}</span>}
        {loading && <Spinner className="size-3.5 text-muted-foreground" />}
        <span className="flex-1" />
        {media !== undefined && (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="复制图片" title="复制图片"
              onClick={() => run((request) => getSessionBridge().copyMedia(request), '已复制图片')}>
              <Copy />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={REVEAL_LABEL} title={REVEAL_LABEL}
              onClick={() => run((request) => getSessionBridge().revealMedia(request))}>
              <FolderOpen />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="用默认应用打开" title="用默认应用打开"
              onClick={() => run((request) => getSessionBridge().openMedia(request))}>
              <ExternalLink />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="关闭" title="关闭" onClick={close}>
          <X />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 p-6 pt-0">
        <ImageViewer key={`${current.index}`} src={src} alt={item.name} onBackdropClick={close} />
        {[-1, 1].map((delta) => {
          const target = current.index + delta;
          if (target < 0 || target >= count) return null;
          const Icon = delta < 0 ? ChevronLeft : ChevronRight;
          return (
            <Button
              key={delta}
              variant="secondary"
              size="icon"
              aria-label={delta < 0 ? '上一张' : '下一张'}
              title={delta < 0 ? '上一张' : '下一张'}
              className={cn(
                'absolute top-1/2 -translate-y-1/2 rounded-full opacity-0 shadow-sm transition-opacity group-hover/lightbox:opacity-100',
                delta < 0 ? 'left-4' : 'right-4',
              )}
              onClick={() => go(delta)}
            >
              <Icon />
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** Mounted once per window; renders the open lightbox. */
export function LightboxHost() {
  const current = useSyncExternalStore(subscribeLightbox, lightboxState);
  return current === null ? null : <LightboxView current={current} />;
}
