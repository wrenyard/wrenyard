import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import {
  DIALOG_BODY_CLASS,
  DIALOG_CONTENT_CLASS,
  DIALOG_SIZES,
} from '@/renderer/components/dialog-size';
import { Field, FieldLabel } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { shell } from '@/renderer/lib/desktop';
import { providerKeyPageUrl, type ProviderCatalogSnapshot, type QuotaSnapshot } from '@/shell-contract';
import {
  DIALOG_CANCEL_LABEL,
  DIALOG_SAVE_LABEL,
  DIALOG_UPDATE_LABEL,
  KEY_PAGE_ERROR,
  KEY_REQUIRED_ERROR,
  KEY_SAVE_ERROR,
  OPEN_KEY_PAGE_LABEL,
  PROVIDER_DIALOG_EYEBROW,
  PROVIDER_KEY_LABEL,
  errorMessage,
  providerAuthGuidance,
  providerDialogTitle,
} from '../model/describe.js';
import { useConfigureProviderKey } from '../queries.js';

const DISCARD_TITLE = '放弃未保存的密钥？';
const DISCARD_KEEP_LABEL = '继续编辑';
const DISCARD_CONFIRM_LABEL = '放弃';

export interface ProviderDialogProps {
  /** Provider being configured, or null when the dialog is closed. */
  entry: ProviderCatalogSnapshot | null;
  onClose: () => void;
  /** Called with the refreshed snapshot after a successful key save. */
  onSaved: (snapshot: QuotaSnapshot) => void;
}

/**
 * Provider key configuration surface built on the official Dialog primitive. The
 * provider key is written through the shell bridge only, never logged or echoed,
 * and the input is cleared when the dialog closes or a save succeeds. Closing
 * with a typed but unsaved key asks for confirmation inside the same dialog
 * (spec section 4.1, rule 6), never with a second stacked modal.
 */
export function ProviderDialog({ entry, onClose, onSaved }: ProviderDialogProps) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [openingPage, setOpeningPage] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const configure = useConfigureProviderKey();

  const open = entry !== null;

  // Clear the credential and any error whenever the target provider changes or closes.
  useEffect(() => {
    setKey('');
    setError('');
    setOpeningPage(false);
    setConfirmDiscard(false);
    configure.reset();
    // `configure.reset` is stable for the mutation's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, open]);

  if (entry === null) {
    return <Dialog open={false} />;
  }

  const apiKeyMode = entry.authMode === 'api-key';
  const name = entry.label || entry.id;
  const keyPageAvailable = providerKeyPageUrl(entry.id) !== null;
  const pending = configure.isPending || openingPage;

  const handleSave = (): void => {
    const value = key.trim();
    if (value.length === 0) {
      setError(KEY_REQUIRED_ERROR);
      return;
    }
    setError('');
    configure.mutate(
      { providerId: entry.id, key: value },
      {
        onSuccess: (snapshot) => {
          setKey('');
          onSaved(snapshot);
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause) || KEY_SAVE_ERROR),
      },
    );
  };

  const handleOpenKeyPage = (): void => {
    setError('');
    setOpeningPage(true);
    void shell.openProviderKeyPage(entry.id)
      .catch((cause: unknown) => setError(errorMessage(cause) || KEY_PAGE_ERROR))
      .finally(() => setOpeningPage(false));
  };

  const requestClose = (): void => {
    if (confirmDiscard) {
      setConfirmDiscard(false);
      return;
    }
    if (key.trim() !== '') {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose();
      }}
      disablePointerDismissal
    >
      <DialogContent className={cn(DIALOG_SIZES.md, DIALOG_CONTENT_CLASS)}>
        <DialogHeader>
          <p className="text-muted-foreground">{PROVIDER_DIALOG_EYEBROW}</p>
          <DialogTitle>{providerDialogTitle(entry.authMode, entry.configured)}</DialogTitle>
          <DialogDescription>{entry.setupHint || providerAuthGuidance(entry.authMode)}</DialogDescription>
        </DialogHeader>

        <div className={cn(DIALOG_BODY_CLASS, 'flex flex-col gap-6')}>
          <div className="flex items-baseline gap-2">
            <strong>{name}</strong>
            <code className="text-muted-foreground">{entry.id}</code>
          </div>

          {apiKeyMode && (
            <Field>
              <FieldLabel htmlFor="provider-key-input">{PROVIDER_KEY_LABEL}</FieldLabel>
              <Input
                id="provider-key-input"
                type="password"
                spellCheck={false}
                autoComplete="off"
                value={key}
                disabled={configure.isPending}
                onChange={(event) => setKey(event.target.value)}
              />
            </Field>
          )}

          {apiKeyMode && keyPageAvailable && (
            <Button
              type="button"
              variant="link"
              className="self-start"
              disabled={pending}
              onClick={handleOpenKeyPage}
            >
              {OPEN_KEY_PAGE_LABEL}
            </Button>
          )}

          {error !== '' && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          {confirmDiscard ? (
            <>
              <p className="mr-auto self-center text-muted-foreground">{DISCARD_TITLE}</p>
              <Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>
                {DISCARD_KEEP_LABEL}
              </Button>
              <Button type="button" variant="destructive" onClick={onClose}>
                {DISCARD_CONFIRM_LABEL}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={requestClose}>{DIALOG_CANCEL_LABEL}</Button>
              {apiKeyMode && (
                <Button type="button" disabled={pending} onClick={handleSave}>
                  {entry.configured ? DIALOG_UPDATE_LABEL : DIALOG_SAVE_LABEL}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
