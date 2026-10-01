import { useSyncExternalStore } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog';
import { DIALOG_CONFIRM_CLASS } from '@/renderer/components/dialog-size';

/** Default cancel copy. Product strings are Chinese, code stays English. */
const CONFIRM_CANCEL_LABEL = '取消';

export interface ConfirmOptions {
  /** Required short question, e.g. "删除别名 cc-fast？". */
  title: string;
  /** Consequence text, shown when the action needs explaining. */
  description?: string;
  /** Specific action label, e.g. "删除别名"; never a generic "确定". */
  confirmLabel: string;
  /** Overrides the default "取消". */
  cancelLabel?: string;
  /** Renders the confirm button with the destructive variant. */
  destructive?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  /** Active request driving visibility, or null when closed. */
  pending: ConfirmRequest | null;
  /** Most recent request, retained so the close animation keeps its content. */
  current: ConfirmRequest | null;
}

let state: ConfirmState = { pending: null, current: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ConfirmState {
  return state;
}

/**
 * Promise-based confirmation backed by the single `ConfirmHost`. Use for
 * irreversible or risky actions only (delete, clear, overwrite, restart); an
 * ordinary action is not confirmed. Any still-pending confirmation resolves
 * false when a new one arrives, so no second dialog is ever stacked.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  state.pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
    const request: ConfirmRequest = { ...options, resolve };
    state = { pending: request, current: request };
    emit();
  });
}

function settle(confirmed: boolean): void {
  const request = state.pending;
  if (request === null) return;
  state = { pending: null, current: state.current };
  emit();
  request.resolve(confirmed);
}

/**
 * Renders the app's one `AlertDialog` confirmation. Mounted once in `App`.
 * The cancel button is first in the DOM, so it receives the initial focus; the
 * footer keeps cancel on the left and the action on the right.
 */
export function ConfirmHost() {
  const { pending, current } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const view = pending ?? current;
  const confirmLabel = view?.confirmLabel ?? '';

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open, event) => {
        if (open) return;
        // An AlertDialog closes only through its buttons, never Escape.
        if (event.reason === 'escape-key') return;
        settle(false);
      }}
    >
      <AlertDialogContent size="sm" className={DIALOG_CONFIRM_CLASS}>
        <AlertDialogHeader>
          <AlertDialogTitle>{view?.title ?? ''}</AlertDialogTitle>
          {view?.description !== undefined ? (
            <AlertDialogDescription>{view.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {view?.cancelLabel ?? CONFIRM_CANCEL_LABEL}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={view?.destructive === true ? 'destructive' : 'default'}
            disabled={view === null}
            onClick={() => settle(true)}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
