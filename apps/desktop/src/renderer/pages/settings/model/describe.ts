import type { StatusTone } from '@/renderer/components/status-badge';
import type {
  ColorMode,
  DaemonProcessState,
  PetCompanionSnapshot,
  StorageUsageSnapshot,
  WorkspaceConfigurationSnapshot,
} from '@/shell-contract';
import { isWorkspaceReadOnly } from './settings.js';

/* Central product copy and status mappings for the Settings page. */

export const PAGE_TITLE = '设置';
export const PAGE_DESCRIPTION = '管理本地工作环境、更新与桌宠体验';
export const REFRESH_LABEL = '刷新状态';

/* ------------------------------------------------------------------ */
/* Settings editor chrome                                              */
/* ------------------------------------------------------------------ */

export const SEARCH_PLACEHOLDER = '搜索设置';
export const SEARCH_RESULT_SUFFIX = ' 项';
export const SEARCH_EMPTY_TITLE = '没有匹配的设置';
export const SEARCH_EMPTY_DESCRIPTION = '试试更短的关键词，或清除筛选条件。';
export const SEARCH_FILTER_MODIFIED = '@modified';
export const SEARCH_FILTER_ID_PREFIX = '@id:';
export const SEARCH_FILTER_MODIFIED_LABEL = '只看已修改';
export const SEARCH_FILTER_ID_LABEL = '按设置 ID 定位';
export const GEAR_RESET_LABEL = '重置此设置';
export const GEAR_COPY_ID_LABEL = '复制设置 ID';
export const GEAR_COPY_JSON_LABEL = '复制为 JSON';
export const OPEN_SETTINGS_FILE_LABEL = '打开设置文件';

/* ------------------------------------------------------------------ */
/* Category and group labels                                           */
/* ------------------------------------------------------------------ */

export const GENERAL_TITLE = '通用';
export const NOTIFICATIONS_TITLE = '通知';
export const SHORTCUTS_TITLE = '快捷键';
export const SHORTCUTS_DESCRIPTION = '当前平台生效的全部快捷键；暂不支持自定义。';
export const SHORTCUTS_SEARCH_PLACEHOLDER = '搜索命令或按键';
export const SHORTCUTS_COMMAND_LABEL = '命令';
export const SHORTCUTS_KEYS_LABEL = '快捷键';
export const SHORTCUTS_SCOPE_LABEL = '生效范围';
export const SHORTCUTS_EMPTY = '没有匹配的快捷键';

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
  unresponsive: '暂未响应',
  stopped: '已停止',
  failed: '启动失败',
  unavailable: '不可用',
};

export const DAEMON_START_LABEL = '启动';
export const DAEMON_RESTART_LABEL = '重启';
export const DAEMON_STARTING_LABEL = '启动中…';

export const SERVICE_CONNECTED_LABEL = '已连接';
export const SERVICE_UNRESPONSIVE_LABEL = '暂未响应';
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

export function workspaceSaveLabel(workspace: WorkspaceConfigurationSnapshot, saving: boolean): string {
  if (saving) return '正在保存…';
  return isWorkspaceReadOnly(workspace) ? '环境变量管理' : '保存并应用';
}

export const CONFLICT_MESSAGE = '保存冲突：已刷新到最新配置，你填写的值仍保留，请核对后重新保存。';
export const CONFLICT_REFRESHED_REVISION_MESSAGE = '保存冲突：列表已刷新，请重新提交。';

/* ------------------------------------------------------------------ */
/* Migrated category additions                                         */
/* ------------------------------------------------------------------ */

export const SESSION_AUXILIARY_MODEL_TITLE = '辅助模型';
export const SESSION_AUXILIARY_MODEL_DESCRIPTION =
  '用于上下文选择、action 解析、派发编译、写文档、回复撰写和标题等便宜调用。';
export const SESSION_WORKSPACE_TITLE = '工作区';
export const SESSION_WORKSPACE_DESCRIPTION = '会话固定绑定此目录，不在聊天界面提供临时切换。';
export const SESSION_WORKSPACE_REVEAL_LABEL = '在访达中显示';
export const SESSION_WORKSPACE_UNAVAILABLE = '尚未配置工作区。';

export const PROVIDER_SUMMARY_TITLE = '供应商';
export const PROVIDER_SUMMARY_DESCRIPTION = '凭据与排序在模型供应页管理，设置页不重复。';
export const PROVIDER_MANAGE_LABEL = '在模型供应页管理';
export const PROVIDER_COUNT_SUFFIX = ' 个已配置';

export const RUNTIME_LOGS_TITLE = '日志';
export const RUNTIME_LOGS_DESCRIPTION = 'Daemon 与 Desktop 的运行日志目录。';
export const RUNTIME_LOGS_OPEN_LABEL = '打开日志目录';
export const RUNTIME_SETTINGS_FILE_TITLE = '设置文件';
export const RUNTIME_SETTINGS_FILE_DESCRIPTION = 'Desktop 偏好设置文件，可直接用系统编辑器打开。';
export const RUNTIME_SETTINGS_FILE_OPEN_LABEL = '打开';
export const RUNTIME_ENDPOINT_COPY_LABEL = '复制 Endpoint';

export const UPDATE_AUTO_CHECK_TITLE = '自动检查更新';
export const UPDATE_AUTO_CHECK_DESCRIPTION = '关闭后只在手动检查时检查。';

export const ABOUT_DIAGNOSTIC_TITLE = '诊断信息';
export const ABOUT_DIAGNOSTIC_DESCRIPTION = '把版本、平台与 Daemon 状态复制为一段文本，便于反馈问题。';
export const ABOUT_DIAGNOSTIC_COPY_LABEL = '复制诊断信息';
export const ABOUT_COPY_LABEL = '复制';

export const PET_BASIC_TITLE = '基本';
export const PET_APPLY_BAR_NOTE = '桌宠设置有未应用的修改';
export const PET_APPLY_LABEL = '应用';
export const PET_DISCARD_LABEL = '放弃';
export const PET_APPLYING_LABEL = '正在应用…';

export const SETTING_SAVE_FAILED_PREFIX = '保存失败：';
export const SETTING_SAVED_LABEL = '已保存';
export const SETTING_INVALID_NUMBER = '请输入有效数值';
export const SETTING_NUMBER_RANGE = '数值超出允许范围';

/* ------------------------------------------------------------------ */
/* Storage (存储)                                                      */
/* ------------------------------------------------------------------ */

/** One category id from the daemon usage snapshot; kept in sync by structure. */
export type StorageCategoryId = NonNullable<StorageUsageSnapshot['result']>['categories'][number]['id'];

export const STORAGE_DEVICE_PREFIX = '统计设备：';
export const STORAGE_DEVICE_NOTE = '由当前连接的 daemon 在其所在设备上统计。';
export const STORAGE_TOTAL_PREFIX = '啾啾工坊占用';
export const STORAGE_REFRESH_LABEL = '刷新';
export const STORAGE_SCANNING_LABEL = '扫描中…';
export const STORAGE_SCAN_STATUS = '正在扫描…';
export const STORAGE_SCANNED_AT_PREFIX = '统计于 ';
export const STORAGE_FAILED_PREFIX = '扫描失败：';
export const STORAGE_REFRESH_FAILED_PREFIX = '刷新失败：';
export const STORAGE_UNAVAILABLE_TITLE = '存储占用不可用';
export const STORAGE_UNREADABLE_NOTE_PREFIX = '有 ';
export const STORAGE_UNREADABLE_NOTE_SUFFIX = ' 项因权限或读取错误未计入，总量仅为可读部分。';
export const STORAGE_CATEGORY_UNREADABLE_SUFFIX = ' 项无法读取';
export const STORAGE_ROOT_STATE_LABEL = '状态目录';
export const STORAGE_ROOT_CONFIG_LABEL = '配置目录';
export const STORAGE_SCOPE_NOTE =
  '统计范围：状态目录与配置目录内的文件大小合计。不跟随符号链接或目录联接，硬链接只计一次；不包含工作区文档与项目仓库。';

export const STORAGE_CATEGORY_LABELS: Record<StorageCategoryId, string> = {
  sessions: '会话记录',
  records: '任务与执行记录',
  files: '附件与产物',
  worktrees: '工作树',
  logs: '日志',
  clients: '客户端状态与缓存',
  other: '其他（配置等）',
};

export const STORAGE_CATEGORY_DOT_CLASS: Record<StorageCategoryId, string> = {
  sessions: 'bg-blue-600',
  records: 'bg-violet-500',
  files: 'bg-cyan-400',
  worktrees: 'bg-emerald-500',
  logs: 'bg-rose-500',
  clients: 'bg-amber-400',
  other: 'bg-zinc-400',
};

/** Readable platform name for the device line; unknown platforms pass through. */
export function storagePlatformLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}
