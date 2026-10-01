import type { StatusTone } from '@/renderer/components/status-badge';
import type { UpdateInstallReason, UpdateSnapshot } from '@/shell-contract';

/* Single update presentation source shared by the update dialog and Settings. */

export const UPDATE_CURRENT_VERSION_LABEL = '当前版本';
export const UPDATE_CURRENT_VERSION_HINT = 'Desktop 与本地 Wrenyard 服务使用同一套件版本。';
export const UPDATE_AUTO_LABEL = '自动更新';
export const UPDATE_FOOTNOTE = '安装前会确认当前没有运行中的任务，更新由已安装的 Wrenyard 引擎完成。';

export interface UpdateView {
  label: string;
  tone: StatusTone;
  description: string;
  action: string;
  primary: boolean;
  disabled: boolean;
}

export function formatUpdateCheckTime(checkedAt: number | undefined): string {
  if (checkedAt === undefined) return '启动后会在后台自动检查';
  return `上次检查 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(checkedAt)}`;
}

/**
 * Why in-app installation is unavailable, phrased for the user. The reason
 * code comes from the updater's own re-probe so every surface agrees.
 */
function installationReason(reason: UpdateInstallReason | undefined): string {
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

/**
 * Projects one update snapshot (or no snapshot yet) into the pill tone,
 * description and the single action button's label/primacy/disabled state.
 * A missing or idle snapshot reads as the calm "not checked yet" state.
 */
export function updateView(snapshot: UpdateSnapshot | undefined, busy: boolean): UpdateView {
  if (snapshot === undefined || snapshot.state === 'idle') {
    return {
      label: '尚未检查',
      tone: 'muted',
      description: snapshot?.message ?? '尚未检查更新。',
      action: '检查更新',
      primary: false,
      disabled: busy,
    };
  }
  switch (snapshot.state) {
    case 'checking':
      return {
        label: '检查中',
        tone: 'running',
        description: '正在检查更新…',
        action: '正在检查…',
        primary: false,
        disabled: true,
      };
    case 'up-to-date':
      return {
        label: '已是最新',
        tone: 'success',
        description: snapshot.message ?? '当前已是最新版本。',
        action: '检查更新',
        primary: false,
        disabled: busy,
      };
    case 'available':
      if (snapshot.installSupported) {
        return {
          label: '有新版本',
          tone: 'warning',
          description: `发现新版本 v${snapshot.availableVersion ?? '—'}（当前 v${snapshot.currentVersion}），将一次升级整个啾啾工坊套件。`,
          action: `安装更新 v${snapshot.availableVersion ?? ''}`,
          primary: true,
          disabled: busy,
        };
      }
      // Keep the entry actionable: explain the exact dependency and offer a re-probe.
      return {
        label: '有新版本',
        tone: 'danger',
        description: installationReason(snapshot.installReason),
        action: '重新检测',
        primary: false,
        disabled: busy,
      };
    case 'waiting':
      return {
        label: '等待空闲安装',
        tone: 'warning',
        description: snapshot.message ?? '有任务运行中，完成后自动更新。',
        action: '立即重试',
        primary: true,
        disabled: busy,
      };
    case 'installing':
      return {
        label: '正在安装',
        tone: 'running',
        description: snapshot.message ?? '正在安装更新，完成后会自动重启。',
        action: '正在安装…',
        primary: false,
        disabled: true,
      };
    case 'error':
      return {
        label: '更新未完成',
        tone: 'danger',
        description: snapshot.message ?? '更新未完成，当前版本未受影响。',
        action: '重试',
        primary: false,
        disabled: busy,
      };
  }
}
