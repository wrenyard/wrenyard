import type { TaskDefinitionInheritanceLayer } from '@/shell-contract';

/* Central product copy for the Task Settings page. All Chinese UI text lives
 * here so the components and pure model stay copy-free. */

export const PAGE_TITLE = '智能体任务';
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

export const TIMEOUT_LABEL = '总执行时限';
export const TIMEOUT_UNIT = '秒';
export const TIMEOUT_PLACEHOLDER = '继承';
export const TIMEOUT_RESET_LABEL = '重置本行超时';
export const TIMEOUT_RESET_TITLE = '仅重置本行超时覆盖';
export const TIMEOUT_OVERRIDE_PREFIX = '本层覆盖';
export const TIMEOUT_INHERIT_PREFIX = '继承';
export const TIMEOUT_NOT_SET = '继承（未设置）';
export const TIMEOUT_SUFFIX = '秒';

export const SAVE_LABEL = '套用';
export const RESET_LABEL = '重置';
export const DISMISS_LABEL = '关闭';
export const SUCCESS_NOTE = '已套用。';

export const PREVIEW_TITLE = '指令模板预览';
export const PREVIEW_EMPTY = '该任务没有可预览的指令模板。';
export const PREVIEW_TAB_PREVIEW = '预览';
export const PREVIEW_TAB_JSON = 'JSON';
export const PREVIEW_EXPAND_LABEL = '展开查看';

export const ISSUE_UNRESOLVED_LABEL = '运行时解析失败，聚焦查看原因';
export const ISSUE_LOAD_FAILED_LABEL = '读取失败，聚焦查看原因';
export const ISSUE_BADGE = '!';

export const ERR_LOAD_PREFIX = '读取失败：';
export const ERR_SAVE_PREFIX = '保存失败：';
export const ERR_SAVE_CONFLICT = '保存冲突：配置已刷新，草稿仍保留';
export const ERR_NO_CHANGES = '没有需要保存的更改';
export const ERR_TIMEOUT_INVALID = '总执行时限必须是正数';

/* Read-only Task definition inheritance chain. Desktop never edits these
 * layers; the daemon row carries the ordered base→effective chain. */
export const INHERITANCE_TITLE = '定义继承链';

/** Layer label: 内置 for builtin layers, else the exact project id. */
export function inheritanceLayerLabel(layer: TaskDefinitionInheritanceLayer): string {
  if (layer.source !== 'project') return CATEGORY_BUILTIN;
  return typeof layer.project === 'string' && layer.project !== '' ? layer.project : CATEGORY_PROJECT;
}
