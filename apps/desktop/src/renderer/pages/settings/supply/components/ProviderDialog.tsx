import { useEffect, useMemo, useState } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
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
import {
  providerKeyPageUrl,
  type DisplayCurrency,
  type ProviderCatalogSnapshot,
  type QuotaProviderSnapshot,
  type QuotaSnapshot,
} from '@/shell-contract';
import { buildModelListRows } from '../model/models.js';
import { modelPriceSuffix } from '../model/describe.js';
import {
  DIALOG_CANCEL_LABEL,
  DIALOG_SAVE_LABEL,
  DIALOG_UPDATE_LABEL,
  KEY_PAGE_ERROR,
  KEY_REQUIRED_ERROR,
  KEY_SAVE_ERROR,
  KEY_SAVE_PENDING,
  KEY_SAVING_LABEL,
  OPEN_KEY_PAGE_LABEL,
  PROVIDER_DIALOG_EYEBROW,
  PROVIDER_KEY_LABEL,
  errorMessage,
  providerAuthGuidance,
  providerDialogTitle,
} from '../model/describe.js';
import { useConfigureProviderKey, useQuotaRefresh } from '../queries.js';

const WORKBUDDY_PROVIDER_IDS = new Set(['workbuddy', 'workbuddy-ai']);
const WORKBUDDY_SIGN_IN_LABEL = '登录';
const WORKBUDDY_SWITCH_ACCOUNT_LABEL = '切换账户';
const WORKBUDDY_SWITCH_BROWSER_LABEL = '浏览器重新登录';
const WORKBUDDY_SWITCH_DESKTOP_LABEL = '从桌面端导入';

/** Identity provider value that marks an enterprise single-sign-on login. */
const WORKBUDDY_IOA_IDP = 'ioa_auth';
/** Account types that mark an enterprise login when `idp` is not the
 * enterprise single-sign-on marker. */
const WORKBUDDY_ENTERPRISE_ACCOUNT_TYPES = new Set(['sso', 'enterprise', 'corporate']);
/** Account types that mark a personal login. */
const WORKBUDDY_PERSONAL_ACCOUNT_TYPES = new Set(['personal', 'individual']);

/**
 * Login identity the daemon reports on a provider quota observation. The Desktop
 * projection does not declare both fields yet, so they are read as optional
 * extras; an absent value renders as 身份未知 instead of a guess.
 */
interface WorkBuddyIdentityFields {
  accountType?: string;
  idp?: string;
}

/**
 * Chinese label of the bound WorkBuddy login, derived only from the provider's
 * own `accountType` / `idp`. It never renders a token, uid or enterprise id.
 */
function workBuddyIdentityLabel(quota: QuotaProviderSnapshot | undefined): string {
  const identity = quota as (QuotaProviderSnapshot & WorkBuddyIdentityFields) | undefined;
  const type = typeof identity?.accountType === 'string' ? identity.accountType.trim().toLowerCase() : '';
  const idp = typeof identity?.idp === 'string' ? identity.idp.trim().toLowerCase() : '';
  if (idp === WORKBUDDY_IOA_IDP) return '企业账号 · 按量计费';
  if (WORKBUDDY_ENTERPRISE_ACCOUNT_TYPES.has(type)) return '企业账号';
  if (WORKBUDDY_PERSONAL_ACCOUNT_TYPES.has(type)) return '个人账号';
  return '身份未知';
}

const DISCARD_TITLE = '放弃未保存的密钥？';
const DISCARD_KEEP_LABEL = '继续编辑';
const DISCARD_CONFIRM_LABEL = '放弃';

export interface ProviderDialogProps {
  /** Provider being configured, or null when the dialog is closed. */
  entry: ProviderCatalogSnapshot | null;
  snapshot: QuotaSnapshot | null;
  displayCurrency: DisplayCurrency;
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
export function ProviderDialog({ entry, snapshot, displayCurrency, onClose, onSaved }: ProviderDialogProps) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [openingPage, setOpeningPage] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const configure = useConfigureProviderKey();
  const quotaRefresh = useQuotaRefresh();

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

  const providerModels = useMemo(() => {
    if (snapshot === null || entry === null) return [];
    return buildModelListRows(snapshot, displayCurrency)
      .flatMap((row) =>
        row.providers
          .filter((provider) => provider.id === entry.id)
          .map((provider) => ({
            name: row.name,
            inputLabel: row.inputLabel,
            outputLabel: row.outputLabel,
            credits: provider.credits,
          })),
      );
  }, [snapshot, displayCurrency, entry?.id]);

  if (entry === null) {
    return <Dialog open={false} />;
  }

  const apiKeyMode = entry.authMode === 'api-key';
  const workBuddySignInMode = WORKBUDDY_PROVIDER_IDS.has(entry.id) && entry.authMode === 'native' && !entry.configured;
  const name = entry.label || entry.id;
  const keyPageAvailable = providerKeyPageUrl(entry.id) !== null;
  const pending = configure.isPending || openingPage;
  const isWorkBuddy = WORKBUDDY_PROVIDER_IDS.has(entry.id);
  const identityLabel = isWorkBuddy
    ? workBuddyIdentityLabel(entry.quota ?? snapshot?.providers.find((item) => item.id === entry.id))
    : '';

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

  const handleWorkBuddySignIn = (): void => {
    setError('');
    setOpeningPage(true);
    void (async () => {
      try {
        if (shell.signInProvider === undefined) throw new Error('登录不可用');
        const result = await shell.signInProvider(entry.id);
        if (!result.alreadySignedIn && result.authUrl.length > 0) {
          await shell.openExternal(result.authUrl);
        }
        void quotaRefresh.mutate();
      } catch (cause: unknown) {
        setError(errorMessage(cause) || KEY_PAGE_ERROR);
      } finally {
        setOpeningPage(false);
      }
    })();
  };

  /**
   * Deliberate account switch: the same `provider.signIn` IPC, but with
   * `switchAccount` so an existing login no longer short-circuits the request.
   * Browser re-authentication opens the returned auth URL; desktop re-import
   * re-reads the desktop client's login instead.
   */
  const handleSwitchAccount = (source: 'browser' | 'desktop'): void => {
    setError('');
    setOpeningPage(true);
    void (async () => {
      try {
        if (shell.signInProvider === undefined) throw new Error('登录不可用');
        const result = await shell.signInProvider(entry.id, { switchAccount: true, source });
        if (!result.alreadySignedIn && result.authUrl.length > 0) {
          await shell.openExternal(result.authUrl);
        }
        // One refresh covers the provider list and the quota snapshot: the
        // catalog and every quota row come from the same snapshot read.
        void quotaRefresh.mutate();
      } catch (cause: unknown) {
        setError(errorMessage(cause) || KEY_PAGE_ERROR);
      } finally {
        setOpeningPage(false);
      }
    })();
  };

  const requestClose = (): void => {
    // A live credential write owns the dialog until it settles: closing now
    // would hide an in-flight save (and its eventual result) behind the closed
    // dialog, and must skip the discard-confirmation path too.
    if (configure.isPending) return;
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
      <DialogContent
        className={cn(DIALOG_SIZES.md, DIALOG_CONTENT_CLASS)}
        showCloseButton={!configure.isPending}
      >
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

          {isWorkBuddy && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">当前登录</span>
              <span className="text-sm">{identityLabel}</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(
                    <Button type="button" variant="outline" size="sm" disabled={pending}>
                      {WORKBUDDY_SWITCH_ACCOUNT_LABEL}
                    </Button>
                  )}
                />
                <DropdownMenuContent align="start" className="min-w-44">
                  <DropdownMenuItem disabled={pending} onClick={() => handleSwitchAccount('browser')}>
                    {WORKBUDDY_SWITCH_BROWSER_LABEL}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={pending} onClick={() => handleSwitchAccount('desktop')}>
                    {WORKBUDDY_SWITCH_DESKTOP_LABEL}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

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

          {workBuddySignInMode && (
            <Button
              type="button"
              variant="link"
              className="self-start"
              disabled={pending}
              onClick={handleWorkBuddySignIn}
            >
              {WORKBUDDY_SIGN_IN_LABEL}
            </Button>
          )}

          {error !== '' && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {configure.isPending && (
            <p role="status" aria-live="polite" className="text-muted-foreground">
              {KEY_SAVE_PENDING}
            </p>
          )}

          <section className="flex flex-col gap-2 border-t pt-4">
            <h3 className="text-sm font-medium">模型</h3>
            {providerModels.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无模型</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {providerModels.map((model) => (
                  <li key={model.name} className="flex flex-col gap-1 px-3 py-2 text-sm">
                    <span className="font-medium">{model.name}</span>
                    <span className="text-muted-foreground">
                      {`输入 ${model.inputLabel}${modelPriceSuffix(displayCurrency)} · 输出 ${model.outputLabel}${modelPriceSuffix(displayCurrency)}`}
                    </span>
                    {model.credits !== undefined && model.credits.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {model.credits.map((credit) => (
                          credit.label === undefined ? credit.value : `${credit.label} ${credit.value}`
                        )).join(' · ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
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
                  {configure.isPending
                    ? KEY_SAVING_LABEL
                    : entry.configured ? DIALOG_UPDATE_LABEL : DIALOG_SAVE_LABEL}
                </Button>
              )}
              {workBuddySignInMode && (
                <Button type="button" disabled={pending} onClick={handleWorkBuddySignIn}>
                  {WORKBUDDY_SIGN_IN_LABEL}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
