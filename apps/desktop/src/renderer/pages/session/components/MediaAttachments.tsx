/**
 * Reusable attachment strip for user messages and task-result cards.
 *
 * Each image is lazily resolved through the session bridge (`mediaRead`) and
 * shown as a thumbnail; clicking it opens the full-window lightbox. Files show
 * their name and size and reveal in the OS file manager. Draft (optimistic)
 * attachments may carry an inline `preview`, so no IPC round-trip is needed
 * before the send. Nothing here ever persists bytes to the ledger.
 */
import { useEffect, useState } from 'react';
import { FileText, ImageOff, X } from 'lucide-react';
import { cn } from 'cn';
import { openLightbox, useLightboxItem } from '@/renderer/components/lightbox-store';
import { Button } from '@/renderer/components/ui/button';
import { getSessionBridge } from '@/renderer/lib/session';
import type { DraftAttachment, SessionFile } from '../model/types.js';

/** View-model item shared by ledger session files and draft attachments. */
export interface MediaAttachmentItem {
  /** React key: `path:hash` for session files, the local draft id for drafts. */
  key: string;
  path: string;
  name: string;
  kind: 'image' | 'file';
  mime?: string;
  bytes?: number;
  /** Inline preview; when present the item needs no IPC read. */
  preview?: string;
}

/** Identity is `path` + `hash`; a session file carries no ledger id. */
export function fromSessionFile(file: SessionFile): MediaAttachmentItem {
  return {
    key: `${file.path}:${file.hash}`,
    path: file.path,
    name: file.name,
    kind: file.kind,
    mime: file.mime,
    bytes: file.bytes,
  };
}

export function fromDraftAttachment(draft: DraftAttachment): MediaAttachmentItem {
  const kind = draft.preview !== undefined || (draft.mime?.startsWith('image/') ?? false) ? 'image' : 'file';
  return {
    key: draft.id,
    path: draft.path ?? '',
    name: draft.name,
    kind,
    ...(draft.mime === undefined ? {} : { mime: draft.mime }),
    ...(draft.bytes === undefined ? {} : { bytes: draft.bytes }),
    ...(draft.preview === undefined ? {} : { preview: draft.preview }),
  };
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

/** Resolves the display source for one image item, lazily and once per path. */
function useThumbnail(item: MediaAttachmentItem, sessionId: string | undefined): { src?: string; error?: string } {
  const [state, setState] = useState<{ src?: string; error?: string }>(
    item.preview === undefined ? {} : { src: item.preview },
  );
  useEffect(() => {
    if (item.preview !== undefined) {
      setState({ src: item.preview });
      return;
    }
    if (item.kind !== 'image' || item.path === '' || sessionId === undefined || sessionId === '') {
      setState({});
      return;
    }
    let cancelled = false;
    setState({});
    getSessionBridge().mediaRead({ sessionId, path: item.path }).then((result) => {
      if (cancelled) return;
      if (result.dataUrl !== undefined && result.dataUrl !== '') setState({ src: result.dataUrl });
      else setState({ error: '缩略图不可用' });
    }).catch(() => {
      if (!cancelled) setState({ error: '缩略图加载失败' });
    });
    return () => { cancelled = true; };
  }, [item.preview, item.kind, item.path, sessionId]);
  return state;
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon-xs"
      aria-label="移除附件"
      title="移除附件"
      className="absolute -top-1.5 -right-1.5 size-5 rounded-full shadow-sm"
      onClick={onRemove}
    >
      <X />
    </Button>
  );
}

function ImageAttachment({ item, sessionId, single, onRemove }: {
  item: MediaAttachmentItem;
  sessionId?: string;
  /** The only image of its strip: shown uncropped at its natural aspect ratio. */
  single: boolean;
  onRemove?: () => void;
}) {
  const { src, error } = useThumbnail(item, sessionId);
  const register = useLightboxItem(src === undefined ? undefined : {
    name: item.name,
    src,
    ...(sessionId === undefined || sessionId === '' || item.path === '' ? {} : { media: { sessionId, path: item.path } }),
  });
  const uncropped = single && src !== undefined;
  return (
    <span className="relative inline-flex max-w-full">
      <button
        ref={register}
        type="button"
        className={cn(
          'overflow-hidden rounded-xl border bg-muted ring-1 ring-foreground/5 disabled:cursor-default',
          uncropped ? 'max-w-full cursor-zoom-in' : 'size-20',
        )}
        title={item.name}
        disabled={src === undefined}
        onClick={(event) => openLightbox(event.currentTarget)}
      >
        {src !== undefined ? (
          <img src={src} alt={item.name} className={uncropped ? 'block max-h-48 max-w-full object-contain' : 'size-full object-cover'} />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1 p-1 text-center text-[10px] text-muted-foreground">
            <ImageOff className="size-4" />
            {error ?? '加载中…'}
          </span>
        )}
      </button>
      {onRemove !== undefined && <RemoveButton onRemove={onRemove} />}
    </span>
  );
}

function FileAttachment({ item, sessionId, onRemove }: {
  item: MediaAttachmentItem;
  sessionId?: string;
  onRemove?: () => void;
}) {
  const [error, setError] = useState('');
  const revealable = sessionId !== undefined && sessionId !== '' && item.path !== '';
  const reveal = (): void => {
    if (!revealable) return;
    setError('');
    void getSessionBridge().revealMedia({ sessionId, path: item.path })
      .catch(() => setError('无法在文件管理器中显示'));
  };
  return (
    <span className="relative inline-flex max-w-52">
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-xl border bg-muted/60 px-2 py-1.5 text-left ring-1 ring-foreground/5 disabled:cursor-default"
        title={revealable ? '在文件管理器中显示' : item.name}
        disabled={!revealable}
        onClick={reveal}
      >
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium">{item.name}</span>
          <span className="text-[10px] text-muted-foreground">
            {error !== '' ? <span className="text-destructive">{error}</span> : formatBytes(item.bytes)}
          </span>
        </span>
      </button>
      {onRemove !== undefined && <RemoveButton onRemove={onRemove} />}
    </span>
  );
}

export interface MediaAttachmentsProps {
  items: readonly MediaAttachmentItem[];
  /** Ledger session id; required for images without an inline preview and for reveal. */
  sessionId?: string;
  /** When set, each item shows a remove control keyed by {@link MediaAttachmentItem.key}. */
  onRemove?: (key: string) => void;
  /** Which edge the strip aligns to. */
  align?: 'start' | 'end';
  className?: string;
}

/** Attachment thumbnail/file strip for one message or task-result card. */
export function MediaAttachments({ items, sessionId, onRemove, align = 'start', className }: MediaAttachmentsProps) {
  if (items.length === 0) return null;
  // A lone image in a sent message shows whole; draft strips keep square tiles.
  const singleImage = onRemove === undefined && items.filter((item) => item.kind === 'image').length === 1;
  return (
    <>
      <div className={cn('flex flex-wrap gap-2', align === 'end' ? 'justify-end' : 'justify-start', className)}>
        {items.map((item) => (item.kind === 'image' ? (
          <ImageAttachment
            key={item.key}
            item={item}
            {...(sessionId === undefined ? {} : { sessionId })}
            single={singleImage}
            {...(onRemove === undefined ? {} : { onRemove: () => onRemove(item.key) })}
          />
        ) : (
          <FileAttachment
            key={item.key}
            item={item}
            {...(sessionId === undefined ? {} : { sessionId })}
            {...(onRemove === undefined ? {} : { onRemove: () => onRemove(item.key) })}
          />
        )))}
      </div>
    </>
  );
}
