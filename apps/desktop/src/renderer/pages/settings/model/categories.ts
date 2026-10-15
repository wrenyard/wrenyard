/**
 * Pure data model for the settings category directory: the ordered list the
 * secondary sidebar and the registry grouping both read. Icons stay in the
 * component layer (`SettingsToc`) so `model/` carries no React imports.
 */

export type SettingsCategoryId =
  | 'general'
  | 'appearance'
  | 'session'
  | 'providers'
  | 'catalog'
  | 'routingTest'
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
  { id: 'providers', label: '供应商', description: '激活、配置凭据、查看额度余额并调整派发优先顺序。' },
  { id: 'catalog', label: '模型', description: '已激活供应商提供的模型、价格与点数倍率。' },
  { id: 'routingTest', label: '派发测试', description: '按条件预览自动派发会选中的模型。' },
  { id: 'models', label: '模型与路由', description: '自动派发参考、路由权重与运行时别名。' },
  { id: 'shortcuts', label: '快捷键', description: '当前平台生效的全部快捷键；暂不支持自定义。' },
  { id: 'pet', label: '桌宠', description: '桌宠的显示内容与行为，由啾啾工坊直接管理生命周期。' },
  { id: 'runtime', label: '运行环境', description: '本地服务、日志与设置文件。' },
  { id: 'update', label: '更新', description: '检查并安装啾啾工坊套件的新版本。' },
  { id: 'about', label: '关于', description: '版本、当前主题与诊断信息。' },
];

/**
 * Category ids that no longer have their own entry but must keep resolving for
 * deep links and restored history. The standalone 用量 page was merged into
 * 供应商, so any `usage` selection resolves and highlights 供应商.
 */
const LEGACY_CATEGORY_ALIASES: Readonly<Record<string, SettingsCategoryId>> = {
  usage: 'providers',
};

export function isSettingsCategoryId(value: unknown): value is SettingsCategoryId {
  return typeof value === 'string' && SETTINGS_CATEGORIES.some((category) => category.id === value);
}

/** Resolve a category id, including the legacy `usage` alias, to a current category. */
export function normalizeSettingsCategoryId(value: unknown): SettingsCategoryId | null {
  if (typeof value !== 'string') return null;
  const canonical = LEGACY_CATEGORY_ALIASES[value] ?? value;
  return SETTINGS_CATEGORIES.some((category) => category.id === canonical)
    ? (canonical as SettingsCategoryId)
    : null;
}

export function settingsCategoryLabel(id: SettingsCategoryId): string {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.label ?? id;
}

export function settingsCategoryDescription(id: SettingsCategoryId): string {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.description ?? '';
}
