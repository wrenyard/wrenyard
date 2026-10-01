import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { checkUpdate, requestInstall } from '@/renderer/lib/desktop';
import { updateQuery } from '@/renderer/lib/queries';
import { UPDATE_VISIBLE_STATES } from '@/renderer/app/nav';
import type { UpdateInstallReason, UpdateSnapshot } from '@/shell-contract';

/** Whether the footer entry and dialog stay reachable for this snapshot. */
export function isUpdateVisible(snapshot: UpdateSnapshot | undefined): boolean {
  return snapshot !== undefined && (UPDATE_VISIBLE_STATES as readonly string[]).includes(snapshot.state);
}

interface UpdatePresentation {
  status: string;
  description: string;
  action: string;
  primary: boolean;
  disabled: boolean;
}

/** Why in-app installation is unavailable, phrased for the user. */
function installReasonText(reason: UpdateInstallReason | undefined): string {
  switch (reason) {
    case 'missing-cli':
      return '未找到 Wrenyard CLI：请先安装或修复啾啾工坊套件，然后点“重新检测”。';
    case 'missing-runtime':
      return '未找到与当前 CLI 配套的 Node 运行时：请修复套件安装，然后点“重新检测”。';
    case 'unsupported-platform':
      return '当前平台暂不支持应用内更新，请从发布页下载安装包。';
    case 'source-development':
      return '当前为源码开发模式，不会检查或安装发行版更新。停止 `pnpm dev` 后可再使用已安装的啾啾工坊。';
    default:
      return '当前无法应用内更新，请检查本机安装后点“重新检测”。';
  }
}

function presentation(snapshot: UpdateSnapshot | undefined, busy: boolean): UpdatePresentation {
  if (snapshot === undefined || snapshot.state === 'idle') {
    return {
      status: '尚未检查',
      description: snapshot?.message ?? '尚未检查更新。',
      action: '检查更新',
      primary: false,
      disabled: busy,
    };
  }
  switch (snapshot.state) {
    case 'checking':
      return { status: '检查中', description: '正在检查更新…', action: '正在检查…', primary: false, disabled: true };
    case 'up-to-date':
      return {
        status: '已是最新',
        description: snapshot.message ?? '当前已是最新版本。',
        action: '检查更新',
        primary: false,
        disabled: busy,
      };
    case 'available':
      if (snapshot.installSupported) {
        return {
          status: '有新版本',
          description: `发现新版本 v${snapshot.availableVersion ?? '—'}（当前 v${snapshot.currentVersion}），将一次升级整个啾啾工坊套件。`,
          action: `安装更新 v${snapshot.availableVersion ?? ''}`,
          primary: true,
          disabled: busy,
        };
      }
      // Keep the entry actionable: explain the exact dependency and offer a re-probe.
      return {
        status: '有新版本',
        description: installReasonText(snapshot.installReason),
        action: '重新检测',
        primary: false,
        disabled: busy,
      };
    case 'waiting':
      return {
        status: '等待空闲安装',
        description: snapshot.message ?? '有任务运行中，完成后自动更新。',
        action: '立即重试',
        primary: true,
        disabled: busy,
      };
    case 'installing':
      return {
        status: '正在安装',
        description: snapshot.message ?? '正在安装更新，完成后会自动重启。',
        action: '正在安装…',
        primary: false,
        disabled: true,
      };
    case 'error':
      return {
        status: '更新未完成',
        description: snapshot.message ?? '更新未完成，当前版本未受影响。',
        action: '重试',
        primary: false,
        disabled: busy,
      };
  }
}

export interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The app's single update surface. It reads the update snapshot through the
 * bridge query and one-click installs when a new version is known, otherwise
 * re-checks. Installation progress, waiting and failure states come straight
 * from the snapshot.
 */
export function UpdateDialog({ open, onOpenChange }: UpdateDialogProps) {
  const queryClient = useQueryClient();
  const update = useQuery(updateQuery);

  const check = useMutation({
    mutationFn: () => checkUpdate(),
    onSuccess: (snapshot) => queryClient.setQueryData(updateQuery.queryKey, snapshot),
  });
  const install = useMutation({
    mutationFn: () => requestInstall(),
    onSuccess: (snapshot) => queryClient.setQueryData(updateQuery.queryKey, snapshot),
  });

  const snapshot = update.data;
  const busy = check.isPending || install.isPending;
  const view = presentation(snapshot, busy);
  const failed = check.isError || install.isError;
  const installable = snapshot !== undefined
    && snapshot.installSupported
    && (snapshot.state === 'available' || snapshot.state === 'waiting');

  const runAction = (): void => {
    if (installable) install.mutate();
    else check.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>软件更新</DialogTitle>
          <DialogDescription>{view.description}</DialogDescription>
        </DialogHeader>

        <dl className="flex flex-col gap-1">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">当前版本</dt>
            <dd>v{snapshot?.currentVersion ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">状态</dt>
            <dd>{view.status}</dd>
          </div>
        </dl>

        {failed && (
          <p role="alert" className="text-destructive">
            暂时无法启动更新，请重试。
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost">关闭</Button>} />
          <Button
            variant={view.primary ? 'default' : 'outline'}
            disabled={view.disabled}
            onClick={runAction}
          >
            {view.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
