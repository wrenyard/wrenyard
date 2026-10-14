/**
 * Pure data model for the settings category directory: the ordered list the
 * secondary sidebar and the registry grouping both read. Icons stay in the
 * component layer (`SettingsToc`) so `model/` carries no React imports.
 */

export type SettingsCategoryId =
  | 'general'
  | 'appearance'
  | 'session'
  | 'models'
  | 'shortcuts'
  | 'pet'
  | 'runtime'
  | 'update'
  | 'about';

export interface SettingsCategoryDefinition {
  id: SettingsCategoryId;
  label: string;
  /** One-line Chinese description shown under the page heading. */
  description: string;
}

/** Display order of the secondary sidebar; the registry groups follow it. */
export const SETTINGS_CATEGORIES: readonly SettingsCategoryDefinition[] = [
  { id: 'general', label: '通用', description: '启动、通知与菜单栏等基础偏好。' },
  { id: 'appearance', label: '外观', description: '主题、明暗模式、界面缩放与动效。' },
  { id: 'session', label: '会话', description: '消息发送方式与会话绑定的工作区。' },
  { id: 'models', label: '模型与路由', description: '供应商、自动派发参考与运行时别名。' },
  { id: 'shortcuts', label: '快捷键', description: '当前平台生效的全部快捷键；暂不支持自定义。' },
  { id: 'pet', label: '桌宠', description: '桌宠的显示内容与行为，由啾啾工坊直接管理生命周期。' },
  { id: 'runtime', label: '运行环境', description: '本地服务、日志与设置文件。' },
  { id: 'update', label: '更新', description: '检查并安装啾啾工坊套件的新版本。' },
  { id: 'about', label: '关于', description: '版本、当前主题与诊断信息。' },
];

export function isSettingsCategoryId(value: unknown): value is SettingsCategoryId {
  return typeof value === 'string' && SETTINGS_CATEGORIES.some((category) => category.id === value);
}

export function settingsCategoryLabel(id: SettingsCategoryId): string {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.label ?? id;
}

export function settingsCategoryDescription(id: SettingsCategoryId): string {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.description ?? '';
}
