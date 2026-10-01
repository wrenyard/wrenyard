import type { StatusTone } from '@/renderer/components/status-badge';
import type {
  ColorMode,
  DaemonProcessState,
  PetCompanionSnapshot,
  WorkspaceConfigurationSnapshot,
} from '@/shell-contract';
import type { AliasValidationReason, AutoCapParseResult } from './settings.js';
import { isWorkspaceReadOnly } from './settings.js';

/* Central product copy and status mappings for the Settings page. */

export const PAGE_TITLE = '啾啾工坊设置';
export const PAGE_DESCRIPTION = '管理本地工作环境、更新与桌宠体验';
export const REFRESH_LABEL = '刷新状态';

export const APPEARANCE_TITLE = '外观';
export const APPEARANCE_DESCRIPTION = '选择界面主题与明暗模式，立即生效。';
export const APPEARANCE_THEME_LABEL = '主题';
export const APPEARANCE_COLOR_MODE_LABEL = '明暗模式';
export const APPEARANCE_COLOR_MODE_OPTIONS: ReadonlyArray<{ value: ColorMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

export const RUNTIME_TITLE = '运行环境';
export const RUNTIME_DESCRIPTION = 'Desktop 通过公开协议读取 Wrenyard 控制面。';
export const SERVICE_LABEL = '本地服务';
export const DAEMON_LABEL = '本地 Daemon';
export const WORKSPACE_LABEL = 'Workspace';
export const WORKSPACE_DESCRIPTION = '会话固定绑定此目录，不在聊天界面提供临时切换。';
export const WORKSPACE_MODE_LABEL = '方式';
export const ENDPOINT_LABEL = 'IPC Endpoint';
export const ENDPOINT_DESCRIPTION = 'Desktop、DSH 与观测模块共享的只读数据通路。';

export const ROUTING_TITLE = '路由权重';
export const ROUTING_DESCRIPTION = '调整自动派发时四项因子的相对比重，四项之和须为 100。';
export const ROUTING_SAVE_LABEL = '保存';
export const ROUTING_SAVING_LABEL = '保存中…';
export const ROUTING_RESET_LABEL = '恢复默认';
export const ROUTING_TOTAL_PREFIX = '当前合计';
export const ROUTING_SAVED_LABEL = '已保存';
export const ROUTING_RESET_DONE_LABEL = '已恢复默认';

export const SUMMARY_TITLE = '会话摘要';
export const SUMMARY_DESCRIPTION = '用于生成工作完成后的最终回复。';
export const SUMMARY_PLACEHOLDER = '选择摘要模型';
export const SUMMARY_EMPTY = '没有匹配的模型';
export const SUMMARY_UNRESOLVED = '所选模型当前没有可用供应商。';
export const SUMMARY_SAVING_LABEL = '正在保存…';
export const SUMMARY_SAVED_LABEL = '已保存';

export const PROVIDER_TITLE = '提供方';
export const AUTO_CAP_TITLE = '自动派发参考输出单价上限';
export const AUTO_CAP_DESCRIPTION = '收紧自动选择的候选范围；留空表示沿用各 Task 默认值。';
export const AUTO_CAP_FIELD_LABEL = '参考单价上限';
export const AUTO_CAP_PLACEHOLDER = '沿用各 Task 默认';
export const AUTO_CAP_UNIT = 'USD / 百万输出 Token';
export const AUTO_CAP_SAVE_LABEL = '保存';
export const AUTO_CAP_RESET_LABEL = '恢复默认';
export const AUTO_CAP_LOADING = '正在读取当前全局上限…';
export const AUTO_CAP_UNAVAILABLE = '无法读取全局设置，请稍后刷新。';

export const ALIAS_TITLE = '运行时别名';
export const ALIAS_DESCRIPTION = '保存供任务引用的运行时短别名。';
export const ALIAS_NAME_LABEL = '别名';
export const ALIAS_NAME_PLACEHOLDER = '例如 cc-fast';
export const ALIAS_TARGET_LABEL = '目标';
export const ALIAS_TARGET_PLACEHOLDER = 'provider/model:client，例如 anthropic/claude-sonnet-4:cc';
export const ALIAS_NAME_RULE = '小写字母开头，仅限 a-z 0-9 . _ -，最长 64 位。';
export const ALIAS_SUBMIT_LABEL = '保存别名';
export const ALIAS_REFRESH_LABEL = '刷新别名';
export const ALIAS_EMPTY = '暂无运行时别名；先在上方保存一个。';
export const ALIAS_UNAVAILABLE = '运行时别名不可用';
export const ALIAS_DELETE_LABEL = '删除';

export const PET_TITLE = '桌宠';
export const PET_DESCRIPTION = '由啾啾工坊直接管理生命周期；退出 App 后桌宠同步退出。';
export const PET_ENABLED_LABEL = '启用桌宠';
export const PET_ENABLED_HINT = '关闭后保留设置，但不创建任何悬浮窗口';
export const PET_DISPLAY_LABEL = '显示器';
export const PET_DISPLAY_HINT = '切换后会重置房屋拖动位置';
export const PET_HOUSE_SKIN_LABEL = '房屋外观';
export const PET_HOUSE_SKIN_HINT = '沿用桌宠现有像素主题';
export const PET_SCALE_LABEL = '渲染缩放';
export const PET_SCALE_HINT = '范围 1–6';
export const PET_DISPLAY_CONTENT_TITLE = '显示内容';
export const PET_SHOW_HOUSE_LABEL = '房屋';
export const PET_SHOW_HOUSE_HINT = '额度提示与今日观测';
export const PET_SHOW_WORKERS_LABEL = '工人';
export const PET_SHOW_WORKERS_HINT = '运行任务的桌面角色';
export const PET_SHOW_TASKGRAPHS_LABEL = '图纸燕';
export const PET_SHOW_TASKGRAPHS_HINT = '活跃 TaskGraph 与图纸详情';
export const PET_BEHAVIOR_TITLE = '行为';
export const PET_BOTTOM_OFFSET_LABEL = '底部偏移';
export const PET_BOTTOM_OFFSET_HINT = '与屏幕底边的距离，范围 0–512';
export const PET_BUBBLE_SECONDS_LABEL = '气泡时长';
export const PET_BUBBLE_SECONDS_HINT = '消息显示秒数，范围 1–60';
export const PET_SAVE_LABEL = '保存并应用';
export const PET_SAVING_LABEL = '正在应用…';
export const PET_CLEAN_NOTE = '位置仍可直接拖动房屋保存。';
export const PET_DIRTY_NOTE = '修改尚未保存；保存后立即重新载入桌宠。';
export const PET_SAVE_FAILED_NOTE = '应用失败，请检查桌宠资源与本地权限。';

export const UPDATE_TITLE = '更新';
export const UPDATE_DESCRIPTION = '自动检查啾啾工坊套件的新版本，由你决定何时安装。';

export const ABOUT_TITLE = '关于';
export const ABOUT_DESCRIPTION = '啾啾工坊是 Wrenyard 套件的 Desktop 主界面。';
export const ABOUT_WRENYARD_LABEL = 'Wrenyard';
export const ABOUT_DESKTOP_LABEL = 'Desktop';
export const ABOUT_BUILD_TIME_LABEL = '构建时间';
export const ABOUT_THEME_LABEL = '当前主题';

/** Calm state labels for the local Daemon lifecycle pill. */
export const DAEMON_STATE_LABEL: Record<DaemonProcessState, string> = {
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  failed: '启动失败',
  unavailable: '不可用',
};

export const DAEMON_START_LABEL = '启动';
export const DAEMON_RESTART_LABEL = '重启';
export const DAEMON_STARTING_LABEL = '启动中…';

export const SERVICE_CONNECTED_LABEL = '已连接';
export const SERVICE_UNAVAILABLE_LABEL = '不可用';

/** Pet lifecycle label for the section status pill. */
export function petStatusLabel(status: PetCompanionSnapshot['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'starting') return '启动中';
  if (status === 'stopping') return '停止中';
  if (status === 'failed') return '启动失败';
  return '已停止';
}

export function petStatusTone(status: PetCompanionSnapshot['status']): StatusTone {
  if (status === 'running') return 'success';
  if (status === 'failed') return 'danger';
  return 'muted';
}

/* ------------------------------------------------------------------ */
/* Validation copy                                                     */
/* ------------------------------------------------------------------ */

export const ALIAS_ERRORS: Record<AliasValidationReason, string> = {
  'invalid-name': '别名需以小写字母开头，仅限 a-z 0-9 . _ -，最长 64 位。',
  'empty-target': '目标不能为空；写法为 provider/model:client。',
  'long-target': '目标最长 512 位；写法为 provider/model:client。',
};

export function autoCapErrorMessage(result: AutoCapParseResult): string {
  if (result.ok) return '';
  return result.reason === 'negative'
    ? '上限需为 ≥ 0 的数值；留空表示清除全局上限并沿用各 Task 默认。'
    : '请输入有效数值；留空表示清除全局上限并沿用各 Task 默认。';
}

export function autoCapEffectiveText(value: number | null | undefined): string {
  if (value === undefined || value === null) {
    return '当前未设全局上限：自动选择沿用各 Task 自身的默认参考单价。';
  }
  return `当前全局上限为 ${value} USD / 百万输出 Token：只收紧“自动选择”的候选模型。`;
}

export function workspaceSaveLabel(workspace: WorkspaceConfigurationSnapshot, saving: boolean): string {
  if (saving) return '正在保存…';
  return isWorkspaceReadOnly(workspace) ? '环境变量管理' : '保存并应用';
}

export const CONFLICT_MESSAGE = '保存冲突：已刷新到最新配置，你填写的值仍保留，请核对后重新保存。';
export const CONFLICT_REFRESHED_REVISION_MESSAGE = '保存冲突：列表已刷新，请重新提交。';
