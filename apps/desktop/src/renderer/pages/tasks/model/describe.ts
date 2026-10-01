import type { TaskSettingsMode } from '@/shell-contract';

/* Central product copy for the Task Settings page. All Chinese UI text lives
 * here so the components and pure model stay copy-free. */

export const PAGE_TITLE = '任务';
export const REFRESH_LABEL = '刷新';
export const REFRESH_BUSY_LABEL = '读取中…';
export const RETRY_LABEL = '重试';

export const DIRECTORY_LABEL = '任务目录';
export const CATEGORY_BUILTIN = '内置';
export const CATEGORY_PROJECT = '项目';
export const CATEGORY_UNKNOWN_SOURCE = '未知来源';

/** Collapsed-group identities persisted while the page stays mounted. */
export const BUILTIN_GROUP_KEY = 'builtin';
export const PROJECTS_GROUP_KEY = 'projects';
export const UNKNOWN_GROUP_KEY = 'load-errors:unknown';
export function projectGroupKey(project: string): string {
  return `project:${project}`;
}

export const DIRECTORY_EMPTY = '暂无任务设置';
export const DIRECTORY_LOAD_FAILED = '无法读取任务设置';
export const DIRECTORY_LOADING = '读取任务…';
export const DETAIL_EMPTY = '选择任务查看设置';
export const DETAIL_LOADING = '读取任务设置…';

export const MODE_LABEL = '选择方式';
export const MODE_AUTOMATIC_LABEL = '自动选择';
export const MODE_EXPLICIT_LABEL = '指定运行时';

export function taskModeLabel(mode: TaskSettingsMode): string {
  return mode === 'automatic' ? MODE_AUTOMATIC_LABEL : MODE_EXPLICIT_LABEL;
}

export const TIMEOUT_LABEL = '总执行时限';
export const TIMEOUT_UNIT = '秒';
export const TIMEOUT_PLACEHOLDER = '继承';
export const TIMEOUT_RESET_LABEL = '重置本行超时';
export const TIMEOUT_RESET_TITLE = '仅重置本行超时覆盖';
export const TIMEOUT_OVERRIDE_PREFIX = '本层覆盖';
export const TIMEOUT_INHERIT_PREFIX = '继承';
export const TIMEOUT_NOT_SET = '继承（未设置）';
export const TIMEOUT_SUFFIX = '秒';

export const RUNTIME_LABEL = '指定运行时';
export const RUNTIME_PLACEHOLDER = '别名，或 provider/model:client';
export const RUNTIME_HELP_LABEL = '运行时写法帮助';
export const RUNTIME_HELP = '填已保存别名，或直接写 provider/model:client（例如 anthropic/claude-sonnet-4:cc）。匹配已保存别名时按别名保存，否则按内联目标保存。';
export const RUNTIME_NO_ALIASES = '暂无已保存别名';

export const SAVE_LABEL = '套用';
export const RESET_LABEL = '重置';
export const DISMISS_LABEL = '关闭';
export const SUCCESS_NOTE = '已套用。';

export const PREVIEW_TITLE = '指令模板预览';
export const PREVIEW_EMPTY = '该任务没有可预览的指令模板。';
export const PREVIEW_TAB_PREVIEW = '预览';
export const PREVIEW_TAB_JSON = 'JSON';

export const ISSUE_UNRESOLVED_LABEL = '运行时解析失败，聚焦查看原因';
export const ISSUE_LOAD_FAILED_LABEL = '读取失败，聚焦查看原因';
export const ISSUE_BADGE = '!';

export const ERR_LOAD_PREFIX = '读取失败：';
export const ERR_SAVE_PREFIX = '保存失败：';
export const ERR_SAVE_CONFLICT = '保存冲突：配置已刷新，草稿仍保留';
export const ERR_NO_CHANGES = '没有需要保存的更改';
export const ERR_TIMEOUT_INVALID = '总执行时限必须是正数';
export const ERR_RUNTIME_REQUIRED = '请填写已保存别名或 provider/model:client 目标';
