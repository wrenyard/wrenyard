import { useState } from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Progress } from '@/renderer/components/ui/progress';
import { Separator } from '@/renderer/components/ui/separator';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge, type StatusTone } from '@/renderer/components/status-badge';
import { useConfirm, type ConfirmOptions } from '@/renderer/hooks/use-confirm';
import { shell } from '@/renderer/lib/desktop';
import { formatDateTime } from '@/renderer/lib/format';
import { errorMessage } from '../model/settings.js';
import type {
  OperationComponentAction,
  OperationComponentHint,
  OperationComponentId,
  OperationComponentProgress,
  OperationComponentSnapshot,
  OperationComponentState,
} from '@/shell-contract';

/* Product copy for the 操作组件 settings category (Settings › 操作组件). */

const PAGE_NOTE = '组件安装与授权状态只对这台电脑有效，不会同步到其他设备或工作区。';
const EMPTY_LABEL = '暂时没有可显示的操作组件。';
const MUTATION_FALLBACK_ERROR = '操作组件操作失败，请稍后重试。';
const CHECKED_AT_PREFIX = '检查时间：';
const CHECKED_AT_EMPTY = '尚未检查';
const SOURCE_MANAGED = '由 Wrenyard 管理';
const SOURCE_EXTERNAL = '外部安装';
const SOURCE_UNKNOWN = '来源未知';
const LOCAL_MACHINE_PREFIX = '本机：';

/** The two components the daemon reports, in display order. */
const COMPONENT_TITLE: Readonly<Record<OperationComponentId, string>> = {
  browser: '浏览器操作',
  desktop: '桌面操作',
};

const STATE_LABEL: Readonly<Record<OperationComponentState, string>> = {
  'not-installed': '未安装',
  installing: '安装中',
  'needs-authorization': '待授权',
  ready: '可用',
  failed: '失败',
  unsupported: '不支持',
  disabled: '已停用',
};

const STATE_TONE: Readonly<Record<OperationComponentState, StatusTone>> = {
  'not-installed': 'muted',
  installing: 'running',
  'needs-authorization': 'warning',
  ready: 'success',
  failed: 'danger',
  unsupported: 'muted',
  disabled: 'muted',
};

const ACTION_LABEL: Readonly<Record<OperationComponentAction, string>> = {
  refresh: '刷新',
  install: '安装',
  update: '更新',
  repair: '修复',
  authorize: '授权',
  uninstall: '卸载',
  enable: '启用',
  disable: '停用',
};

const SOURCE_LABEL: Readonly<Record<'managed' | 'external' | 'unknown', string>> = {
  managed: SOURCE_MANAGED,
  external: SOURCE_EXTERNAL,
  unknown: SOURCE_UNKNOWN,
};

const HINT_TEXT: Readonly<Record<OperationComponentHint, string>> = {
  'legacy-browser-mcp':
    '检测到旧的 WRENYARD_BROWSER_USE_MCP 配置：浏览器操作已改用 agent-browser CLI，该变量不再生效，可安全移除。',
  'shared-browser-runtime':
    '浏览器运行时（Chrome for Testing）与上游 agent-browser 共用 ~/.agent-browser/browsers 目录，Wrenyard 不会删除它。',
  'external-mcp': '使用外部 MCP 地址：由你自行管理，Wrenyard 只做连接与校验，无法在此修复或更新。',
  'existing-installation': '检测到既有的外部安装：Wrenyard 不会覆盖、升级或删除它，仅做版本校验。',
  'missing-accessibility': '需要在「系统设置 › 隐私与安全性 › 辅助功能」中为 CuaDriver 授权。',
  'missing-screen-recording': '需要在「系统设置 › 隐私与安全性 › 屏幕录制」中为 CuaDriver 授权。',
};

/** Staged progress phase → Chinese label; unknown phases pass through raw. */
const PHASE_LABEL: Readonly<Record<string, string>> = {
  downloading: '下载中',
  verifying: '校验中',
  installing: '安装中',
  'installing-browser-runtime': '安装浏览器运行时',
  'downloading-installer': '下载安装器',
  'running-installer': '运行安装器',
  authorizing: '授权中',
};

const BYTES_PER_MB = 1024 * 1024;
const OPERATION_COMPONENTS_QUERY_KEY = ['operationComponents'] as const;
const OPERATION_COMPONENTS_POLL_MS = 1_000;

/**
 * Operation-component snapshots are machine-local and daemon-owned. The list is
 * polled every second only while an install is in flight; otherwise it is read
 * on demand. The mutation seeds this key with the snapshot the daemon returns.
 */
const operationComponentsQuery = queryOptions({
  queryKey: OPERATION_COMPONENTS_QUERY_KEY,
  queryFn: () => shell.getOperationComponents(),
  staleTime: OPERATION_COMPONENTS_POLL_MS,
  refetchInterval: (query) => (
    query.state.data?.some((component) => component.state === 'installing')
      ? OPERATION_COMPONENTS_POLL_MS
      : false
  ),
});

function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase;
}

function progressPercent(progress: OperationComponentProgress): number | null {
  if (progress.receivedBytes === undefined || progress.totalBytes === undefined || progress.totalBytes <= 0) {
    return null;
  }
  return Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100));
}

/** `下载中 12.3 / 45.6 MB` when the size is known, otherwise just the phase. */
function progressText(progress: OperationComponentProgress): string {
  const phase = phaseLabel(progress.phase);
  if (progress.receivedBytes === undefined || progress.totalBytes === undefined) return phase;
  const received = (progress.receivedBytes / BYTES_PER_MB).toFixed(1);
  const total = (progress.totalBytes / BYTES_PER_MB).toFixed(1);
  return `${phase} ${received} / ${total} MB`;
}

function versionText(component: OperationComponentSnapshot): string {
  if (component.version === undefined || component.version === '') {
    return `未安装 · 固定版本 v${component.pinnedVersion}`;
  }
  return `版本 v${component.version} · 固定版本 v${component.pinnedVersion}`;
}

function checkedAtText(component: OperationComponentSnapshot): string {
  if (component.checkedAt === undefined || component.checkedAt === '') return CHECKED_AT_EMPTY;
  return `${CHECKED_AT_PREFIX}${formatDateTime(component.checkedAt)}`;
}

function actionVariant(action: OperationComponentAction): 'default' | 'outline' | 'destructive' {
  if (action === 'uninstall') return 'destructive';
  if (action === 'install' || action === 'repair') return 'default';
  return 'outline';
}

/**
 * User confirmation for actions that install, replace, authorize or remove a
 * component. `refresh`, `enable` and `disable` are cheap and reversible, so they
 * run without a prompt; every other action is confirmed first.
 */
function actionConfirmation(
  component: OperationComponentSnapshot,
  action: OperationComponentAction,
): Omit<ConfirmOptions, 'cancelLabel'> | null {
  const title = COMPONENT_TITLE[component.id];
  switch (action) {
    case 'install':
      return component.id === 'browser'
        ? {
          title: `安装${title}组件？`,
          description: '将从官方 GitHub Release 下载固定版本的 agent-browser 二进制并校验 SHA-256，随后下载浏览器运行时到 ~/.agent-browser/browsers。安装只在你确认后进行，不影响其他软件。',
          confirmLabel: '安装',
        }
        : {
          title: `安装${title}组件？`,
          description: '将从官方 Release 下载固定版本的 Cua Driver 安装器并运行（不修改 PATH）。系统辅助功能与屏幕录制权限需要你在系统设置中单独授权。',
          confirmLabel: '安装',
        };
    case 'update':
      return {
        title: `更新${title}组件？`,
        description: '将下载并校验固定版本，验证通过后才切换；当前版本会保留用于回退。',
        confirmLabel: '更新',
      };
    case 'repair':
      return {
        title: `修复${title}组件？`,
        description: '将重新下载并校验固定版本，验证通过后才生效；失败不会破坏当前安装。',
        confirmLabel: '修复',
      };
    case 'authorize':
      return {
        title: '授权桌面操作？',
        description: '将启动 CuaDriver 并请求辅助功能与屏幕录制权限。授权由你在系统设置中确认，Wrenyard 不会代替你授权。',
        confirmLabel: '授权',
      };
    case 'uninstall':
      return {
        title: `卸载${title}组件？`,
        description: '只会删除 Wrenyard 管理的 agent-browser 二进制及其版本目录，不会删除 ~/.agent-browser/browsers 中的浏览器运行时，也不会影响其他软件。',
        confirmLabel: '卸载',
        destructive: true,
      };
    default:
      return null;
  }
}

interface ComponentCardProps {
  component: OperationComponentSnapshot;
  busy: boolean;
  onAction(component: OperationComponentSnapshot, action: OperationComponentAction): void;
}

function ComponentCard({ component, busy, onAction }: ComponentCardProps) {
  const percent = component.progress === undefined ? null : progressPercent(component.progress);
  return (
    <Card className="gap-3">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <CardTitle>{`${COMPONENT_TITLE[component.id]} · ${component.name}`}</CardTitle>
            <span className="text-xs text-muted-foreground">{versionText(component)}</span>
          </div>
          <StatusBadge tone={STATE_TONE[component.state]} label={STATE_LABEL[component.state]} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{SOURCE_LABEL[component.source ?? 'unknown']}</span>
          <span>{`${LOCAL_MACHINE_PREFIX}${component.host} · ${component.platform}/${component.arch}`}</span>
          <span>{checkedAtText(component)}</span>
        </div>

        {component.path !== undefined && component.path !== '' && (
          <code className="select-all break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
            {component.path}
          </code>
        )}

        {component.state === 'installing' && component.progress !== undefined && (
          <div className="flex flex-col gap-1">
            <Progress
              className="w-full"
              value={percent}
              aria-label={phaseLabel(component.progress.phase)}
            />
            <span className="text-xs text-muted-foreground">{progressText(component.progress)}</span>
          </div>
        )}

        {component.error !== undefined && component.error !== '' && (
          <Alert variant="destructive">
            <AlertDescription>{component.error}</AlertDescription>
          </Alert>
        )}

        {component.hints.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
            {component.hints.map((hint) => (
              <li key={hint}>{HINT_TEXT[hint]}</li>
            ))}
          </ul>
        )}

        <Separator />

        {component.actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {component.actions.map((action) => (
              <Button
                key={action}
                variant={actionVariant(action)}
                size="sm"
                disabled={busy}
                onClick={() => onAction(component, action)}
              >
                {ACTION_LABEL[action]}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Settings control for the 操作组件 category: one card per machine-local
 * operation component (browser / desktop). It reads the daemon-owned snapshot
 * through the shell bridge, polls while an install is running, and runs only
 * the actions each snapshot offers — every install/update/repair/authorize/
 * uninstall is confirmed first.
 */
export function OperationComponentsControl() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const components = useQuery(operationComponentsQuery);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (input: { id: OperationComponentId; action: OperationComponentAction }) =>
      shell.runOperationComponentAction(input.id, input.action),
    onMutate: () => setError(''),
    onSuccess: (component) => {
      queryClient.setQueryData<OperationComponentSnapshot[]>(
        OPERATION_COMPONENTS_QUERY_KEY,
        (current) => current === undefined
          ? [component]
          : current.map((entry) => (entry.id === component.id ? component : entry)),
      );
    },
    onError: (cause) => setError(errorMessage(cause) || MUTATION_FALLBACK_ERROR),
  });

  const runAction = (component: OperationComponentSnapshot, action: OperationComponentAction): void => {
    const confirmation = actionConfirmation(component, action);
    if (confirmation === null) {
      mutation.mutate({ id: component.id, action });
      return;
    }
    void confirm(confirmation).then((confirmed) => {
      if (confirmed) mutation.mutate({ id: component.id, action });
    });
  };

  if (components.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  if (components.isError) {
    return <QueryError query={components} title="暂时无法读取操作组件状态" />;
  }

  const list = components.data ?? [];
  if (list.length === 0) {
    return <p className="text-sm text-muted-foreground">{EMPTY_LABEL}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{PAGE_NOTE}</p>
      {error !== '' && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {list.map((component) => (
        <ComponentCard
          key={component.id}
          component={component}
          busy={mutation.isPending || component.state === 'installing'}
          onAction={runAction}
        />
      ))}
    </div>
  );
}
