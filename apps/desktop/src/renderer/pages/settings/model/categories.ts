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
}

/** Display order of the secondary sidebar; the registry groups follow it. */
export const SETTINGS_CATEGORIES: readonly SettingsCategoryDefinition[] = [
  { id: 'general', label: '通用' },
  { id: 'appearance', label: '外观' },
  { id: 'session', label: '会话' },
  { id: 'models', label: '模型与路由' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'pet', label: '桌宠' },
  { id: 'runtime', label: '运行环境' },
  { id: 'update', label: '更新' },
  { id: 'about', label: '关于' },
];

export function isSettingsCategoryId(value: unknown): value is SettingsCategoryId {
  return typeof value === 'string' && SETTINGS_CATEGORIES.some((category) => category.id === value);
}

export function settingsCategoryLabel(id: SettingsCategoryId): string {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.label ?? id;
}
