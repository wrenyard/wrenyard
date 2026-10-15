import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Laptop, Pencil, Plus, RefreshCw, Server } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Separator } from '@/renderer/components/ui/separator';
import { Spinner } from '@/renderer/components/ui/spinner';
import { shell } from '@/renderer/lib/desktop';
import type { RemoteConnectionTestInput, RemoteHostView } from '@/shell-contract';
import { cn } from 'cn';

/**
 * Remote connection modal (WY Remote).
 *
 * It is normally hidden and only opens from Daemon > 远程连接 > 新增. Saved hosts
 * and the default "Add" option share one list, the local SSH hosts discovered
 * from the user's SSH configuration are listed separately with their honest
 * name/address/OS, and the add-new form builds an ephemeral SSH configuration
 * candidate with independent Test and Confirm actions plus debounced silent
 * validation. Only a validated, compatible, successful connection is remembered
 * by the daemon; a saved host can be connected to directly and renamed in place.
 * All product UI text is Chinese.
 */

export type { RemoteHostView };

const OS_LABEL: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

function osLabel(os: string | null | undefined): string {
  if (!os) return '系统未知';
  return OS_LABEL[os] ?? os;
}

function addressLabel(host: RemoteHostView): string {
  return host.address ? host.address : '地址未知';
}

/** Local, structural validation of the alias field (no command runs). */
function validateAlias(value: string): string | null {
  const alias = value.trim();
  if (!alias) return '请输入 SSH 别名';
  if (alias.startsWith('-') || /[\s*?!]/.test(alias)) return '别名不能包含通配符、感叹号或空白';
  if (alias.length > 255) return '别名过长';
  return null;
}

type AddMode = 'idle' | 'form';
type Feedback = { text: string; tone: 'ok' | 'error' | 'info' };

export interface RemoteConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RemoteConnectDialog({ open, onOpenChange }: RemoteConnectDialogProps) {
  const [savedHosts, setSavedHosts] = useState<RemoteHostView[]>([]);
  const [discovered, setDiscovered] = useState<RemoteHostView[]>([]);
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>('idle');
  const [alias, setAlias] = useState('');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState('');
  const [identityPath, setIdentityPath] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Every probe carries the form revision it was started under; a newer edit
  // bumps the revision so a stale async probe result is ignored.
  const revision = useRef(0);

  const refreshHosts = useCallback(async () => {
    setLoadingHosts(true);
    try {
      const [saved, found] = await Promise.all([
        shell.listRemoteHosts(),
        shell.listDiscoveredSshHosts(),
      ]);
      setSavedHosts(saved.hosts ?? []);
      setDiscovered(found.hosts ?? []);
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setLoadingHosts(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setAddMode('idle');
    setAlias('');
    setHost('');
    setUser('');
    setPort('');
    setIdentityPath('');
    setDisplayName('');
    setFeedback(null);
    revision.current += 1;
    void refreshHosts();
  }, [open, refreshHosts]);

  const aliasError = alias.trim() ? validateAlias(alias) : null;

  const buildInput = useCallback((): RemoteConnectionTestInput => {
    const trimmedPort = port.trim();
    return {
      alias: alias.trim(),
      ...(host.trim() ? { host: host.trim() } : {}),
      ...(user.trim() ? { user: user.trim() } : {}),
      ...(trimmedPort ? { port: Number(trimmedPort) } : {}),
      ...(identityPath.trim() ? { identityPath: identityPath.trim() } : {}),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
    };
  }, [alias, host, user, port, identityPath, displayName]);

  // Debounced silent validation: a structural check followed by a lightweight
  // non-installing remote probe. Results from an older revision are dropped, and
  // only failures are surfaced so typing stays quiet.
  useEffect(() => {
    if (addMode !== 'form') return;
    if (aliasError || !alias.trim()) return;
    const myRevision = revision.current;
    const timer = setTimeout(() => {
      void (async () => {
        if (myRevision !== revision.current) return;
        try {
          const result = await shell.testRemoteConnection(buildInput());
          if (myRevision !== revision.current) return;
          setFeedback(result.ok ? null : { text: result.message ?? '未通过校验', tone: 'error' });
        } catch (error) {
          if (myRevision !== revision.current) return;
          setFeedback({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
        }
      })();
    }, 600);
    return () => clearTimeout(timer);
  }, [addMode, alias, aliasError, buildInput]);

  const bumpRevision = (): void => { revision.current += 1; };

  const handleTest = async (): Promise<void> => {
    if (aliasError || !alias.trim()) {
      setFeedback({ text: aliasError ?? '请输入 SSH 别名', tone: 'error' });
      return;
    }
    const myRevision = revision.current;
    setTesting(true);
    setFeedback(null);
    try {
      const result = await shell.testRemoteConnection(buildInput());
      if (myRevision !== revision.current) return;
      setFeedback(result.ok
        ? { text: '校验通过', tone: 'ok' }
        : { text: result.message ?? '未通过校验', tone: 'error' });
    } catch (error) {
      if (myRevision !== revision.current) return;
      setFeedback({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setTesting(false);
    }
  };

  const handleConfirm = async (): Promise<void> => {
    if (aliasError || !alias.trim()) {
      setFeedback({ text: aliasError ?? '请输入 SSH 别名', tone: 'error' });
      return;
    }
    const myRevision = revision.current;
    setConfirming(true);
    setFeedback(null);
    try {
      const result = await shell.confirmRemoteConnection(buildInput());
      if (myRevision !== revision.current) return;
      if (result.ok) {
        setAddMode('idle');
        setAlias('');
        setHost('');
        setUser('');
        setPort('');
        setIdentityPath('');
        setDisplayName('');
        onOpenChange(false);
        return;
      }
      // Never a fake success: the reported reason (including "the remote
      // install implementation is not wired yet") stays visible.
      setFeedback({ text: result.message ?? '连接失败，未保存', tone: 'error' });
    } catch (error) {
      if (myRevision !== revision.current) return;
      setFeedback({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setConfirming(false);
    }
  };

  const handleConnectSaved = async (hostRow: RemoteHostView): Promise<void> => {
    try {
      const result = await shell.connectSavedRemoteHost(hostRow.alias);
      if (result.ok) { onOpenChange(false); return; }
      setFeedback({ text: result.message ?? '连接失败', tone: 'error' });
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  };

  const beginRename = (hostRow: RemoteHostView): void => {
    setRenaming(hostRow.alias);
    setRenameDraft(hostRow.displayName);
  };

  const commitRename = async (hostRow: RemoteHostView): Promise<void> => {
    const name = renameDraft.trim();
    if (!name) { setRenaming(null); return; }
    try {
      const result = await shell.renameRemoteHost(hostRow.alias, name);
      if (!result.ok) {
        setFeedback({ text: result.message ?? '重命名失败', tone: 'error' });
        return;
      }
      setSavedHosts((current) => current.map((entry) => (entry.alias === hostRow.alias ? { ...entry, displayName: name } : entry)));
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setRenaming(null);
    }
  };

  const openAddForm = (): void => {
    bumpRevision();
    setAddMode('form');
    setAlias('');
    setHost('');
    setUser('');
    setPort('');
    setIdentityPath('');
    setDisplayName('');
    setFeedback(null);
  };

  const feedbackClass = useMemo(() => {
    if (feedback?.tone === 'error') return 'text-destructive';
    if (feedback?.tone === 'ok') return 'text-success';
    return 'text-muted-foreground';
  }, [feedback]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-page="remote-connect">
        <DialogHeader>
          <DialogTitle>远程连接</DialogTitle>
          <DialogDescription>
            通过 SSH 连接到其他设备的 daemon。只有校验成功并确认后才会保存该主机。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">主机</span>
            <Button type="button" variant="ghost" size="icon-sm" title="刷新" onClick={() => void refreshHosts()}>
              {loadingHosts ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
            </Button>
          </div>
          {/* Saved hosts and the default Add option share one list. */}
          <ul className="flex flex-col gap-1" data-remote-saved-list>
            {savedHosts.map((hostRow) => (
              <li key={hostRow.alias} className="flex items-center gap-2 rounded-lg border border-border/60 px-2 py-1.5">
                <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  {renaming === hostRow.alias ? (
                    <Input
                      value={renameDraft}
                      autoFocus
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => void commitRename(hostRow)}
                      onKeyDown={(event) => { if (event.key === 'Enter') void commitRename(hostRow); }}
                    />
                  ) : (
                    <>
                      <div className="truncate">{hostRow.displayName}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {addressLabel(hostRow)} · {osLabel(hostRow.os)}
                      </div>
                    </>
                  )}
                </div>
                <Button type="button" variant="ghost" size="icon-sm" title="改显示名称" onClick={() => beginRename(hostRow)}>
                  <Pencil className="size-4" />
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => void handleConnectSaved(hostRow)}>
                  连接
                </Button>
              </li>
            ))}
            <li
              className={cn(
                'flex items-center gap-2 rounded-lg px-2 py-1.5',
                addMode === 'form' ? 'bg-accent' : 'hover:bg-accent',
              )}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left"
                onClick={openAddForm}
                data-remote-add
              >
                <Plus className="size-4 shrink-0" aria-hidden />
                <span>新增 SSH 配置</span>
              </button>
            </li>
          </ul>

          <Separator />

          <span className="text-xs font-medium text-muted-foreground">本机 SSH 主机</span>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto" data-remote-discovered-list>
            {discovered.map((hostRow) => (
              <li key={hostRow.alias}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    // A discovered alias already exists in the user's SSH config,
                    // so no new stanza is created; only the alias/display name
                    // prefill the form.
                    bumpRevision();
                    setAddMode('form');
                    setAlias(hostRow.alias);
                    setHost('');
                    setUser('');
                    setPort('');
                    setIdentityPath('');
                    setDisplayName(hostRow.displayName);
                    setFeedback(null);
                  }}
                >
                  <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{hostRow.displayName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {addressLabel(hostRow)} · {osLabel(hostRow.os)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {discovered.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">未发现本机 SSH 主机</li>
            ) : null}
          </ul>

          {addMode === 'form' ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">SSH 别名</span>
                <Input
                  value={alias}
                  autoFocus
                  placeholder="例如 myserver"
                  onChange={(event) => { bumpRevision(); setAlias(event.target.value); }}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">主机地址（可选）</span>
                  <Input
                    value={host}
                    placeholder="例如 192.0.2.10"
                    onChange={(event) => { bumpRevision(); setHost(event.target.value); }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">用户名（可选）</span>
                  <Input
                    value={user}
                    onChange={(event) => { bumpRevision(); setUser(event.target.value); }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">端口（可选）</span>
                  <Input
                    value={port}
                    inputMode="numeric"
                    onChange={(event) => { bumpRevision(); setPort(event.target.value); }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">身份文件（可选）</span>
                  <Input
                    value={identityPath}
                    placeholder="绝对路径"
                    onChange={(event) => { bumpRevision(); setIdentityPath(event.target.value); }}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">显示名称（可选）</span>
                <Input
                  value={displayName}
                  onChange={(event) => { bumpRevision(); setDisplayName(event.target.value); }}
                />
              </label>
              {aliasError ? <p className="text-xs text-destructive">{aliasError}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" disabled={testing} onClick={() => void handleTest()}>
                  {testing ? <Spinner className="size-4" /> : null}
                  测试
                </Button>
                <Button type="button" size="sm" disabled={confirming} onClick={() => void handleConfirm()}>
                  {confirming ? <Spinner className="size-4" /> : null}
                  确认
                </Button>
              </div>
            </div>
          ) : null}

          {feedback ? <p className={cn('text-xs', feedbackClass)} data-remote-feedback>{feedback.text}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
