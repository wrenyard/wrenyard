import { DEFAULT_THEME_ID } from '@wrenyard/themes';
import {
  APPEARANCE_ZOOM_OPTIONS,
  SESSION_SEND_KEY_OPTIONS,
  STARTUP_PAGE_OPTIONS,
  type PreferenceId,
} from '@/shell-contract';
import type { SettingsCategoryId } from './categories.js';

/**
 * Stable string keys for the custom (upper-layer) setting controls. The registry
 * stays pure data; `components/custom-controls.ts` maps these keys to the actual
 * React components.
 */
export type CustomControlKey =
  | 'aboutBuildTime'
  | 'aboutDesktopVersion'
  | 'aboutDiagnostics'
  | 'aboutTheme'
  | 'aboutWrenyardVersion'
  | 'autoPriceCap'
  | 'daemon'
  | 'endpoint'
  | 'logs'
  | 'notificationEvents'
  | 'petBottomOffset'
  | 'petBubbleSeconds'
  | 'petDisplay'
  | 'petEnabled'
  | 'petHouseSkin'
  | 'petScale'
  | 'petShowHouse'
  | 'petShowTaskgraphs'
  | 'petShowWorkers'
  | 'providerSummary'
  | 'routingWeights'
  | 'runtimeAliases'
  | 'service'
  | 'settingsFile'
  | 'statusBarItems'
  | 'themeCards'
  | 'updateStatus'
  | 'workspace';

export type SettingControl =
  | { kind: 'boolean' }
  | { kind: 'enum'; options: ReadonlyArray<{ value: string; label: string }>; presentation?: 'select' | 'toggle' }
  | { kind: 'number'; min?: number; max?: number; step?: number }
  | { kind: 'string'; placeholder?: string }
  | { kind: 'custom'; render: CustomControlKey };

/**
 * How a setting reads and writes. `preference` rows use the generic Desktop
 * preference bridge; `daemon` rows use the daemon-owned queries/mutations;
 * `custom` rows (Pet, local runtime) own their own store; `readonly` rows are
 * display-only. A row with `default` and a writable source shows the modified
 * marker and the reset action.
 */
export type SettingSource =
  | { kind: 'preference'; preference: PreferenceId }
  | { kind: 'daemon' }
  | { kind: 'custom' }
  | { kind: 'readonly' };

export interface SettingDefinition<T = unknown> {
  id: string;
  category: SettingsCategoryId;
  /** Sub-group key, e.g. the Pet category's basic/content/behavior groups. */
  group?: string;
  title: string;
  description?: string;
  keywords?: string[];
  platform?: NodeJS.Platform[];
  control: SettingControl;
  default?: T;
  readonly?: boolean;
  source: SettingSource;
}

export interface SettingGroupDefinition {
  key: string;
  label: string;
}

/** Sub-group labels per category; the registry `group` keys point here. */
export const SETTINGS_GROUP_LABELS: Partial<Readonly<Record<SettingsCategoryId, readonly SettingGroupDefinition[]>>> = {
  pet: [
    { key: 'basic', label: '基本' },
    { key: 'content', label: '显示内容' },
    { key: 'behavior', label: '行为' },
  ],
};

const custom = (render: CustomControlKey): SettingControl => ({ kind: 'custom', render });

const GENERAL_CATEGORY: SettingDefinition[] = [
  {
    id: 'general.openAtLogin',
    category: 'general',
    title: '登录时启动',
    description: '登录系统后自动启动啾啾工坊。',
    keywords: ['登录时启动', '开机', '自启', 'login', 'startup'],
    platform: ['darwin', 'win32'],
    control: { kind: 'boolean' },
    default: false,
    source: { kind: 'preference', preference: 'general.openAtLogin' },
  },
  {
    id: 'general.startupPage',
    category: 'general',
    title: '启动时打开',
    description: '选择每次启动时进入的页面。',
    keywords: ['启动页', 'startup', '打开', '页面'],
    control: { kind: 'enum', options: STARTUP_PAGE_OPTIONS.map((option) => ({ ...option })) },
    default: 'last',
    source: { kind: 'preference', preference: 'general.startupPage' },
  },
  {
    id: 'general.confirmQuit',
    category: 'general',
    title: '退出前确认',
    description: '按两次 Cmd/Ctrl+Q 才退出。',
    keywords: ['退出', '确认', 'quit', 'confirm'],
    control: { kind: 'boolean' },
    default: true,
    source: { kind: 'preference', preference: 'general.confirmQuit' },
  },
  {
    id: 'general.menuBarQuota',
    category: 'general',
    title: '在菜单栏显示额度',
    description: '在菜单栏图标中显示额度。',
    keywords: ['菜单栏', '额度', 'tray', 'menubar', 'quota'],
    platform: ['darwin'],
    control: { kind: 'boolean' },
    default: true,
    source: { kind: 'preference', preference: 'general.menuBarQuota' },
  },
];

const APPEARANCE_CATEGORY: SettingDefinition[] = [
  {
    id: 'appearance.theme',
    category: 'appearance',
    title: '主题',
    description: '界面的配色与字体风格。',
    keywords: ['主题', 'theme', '配色', '颜色', '纸本', '简约'],
    control: custom('themeCards'),
    default: DEFAULT_THEME_ID,
    source: { kind: 'preference', preference: 'appearance.theme' },
  },
  {
    id: 'appearance.colorMode',
    category: 'appearance',
    title: '颜色模式',
    description: '选择浅色、深色，或跟随系统设置。',
    keywords: ['颜色模式', 'color', 'dark', '深色', '浅色', 'light', 'system', '跟随系统'],
    control: {
      kind: 'enum',
      presentation: 'toggle',
      options: [
        { value: 'system', label: '跟随系统' },
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' },
      ],
    },
    default: 'system',
    source: { kind: 'preference', preference: 'appearance.colorMode' },
  },
  {
    id: 'appearance.zoom',
    category: 'appearance',
    title: '界面缩放',
    description: '缩放整个界面；与「视图」菜单同步，下次启动时恢复。',
    keywords: ['缩放', 'zoom', '界面', '大小'],
    control: {
      kind: 'enum',
      options: APPEARANCE_ZOOM_OPTIONS.map((option) => ({ value: String(option.value), label: option.label })),
    },
    default: 100,
    source: { kind: 'preference', preference: 'appearance.zoom' },
  },
  {
    id: 'appearance.motion',
    category: 'appearance',
    title: '动效',
    description: '选择跟随系统或减少动效。',
    keywords: ['动效', 'motion', '动画', '减少'],
    control: {
      kind: 'enum',
      presentation: 'toggle',
      options: [
        { value: 'system', label: '跟随系统' },
        { value: 'reduce', label: '减少' },
      ],
    },
    default: 'system',
    source: { kind: 'preference', preference: 'appearance.motion' },
  },
  {
    id: 'appearance.statusBar',
    category: 'appearance',
    title: '状态栏',
    description: '选择状态栏中显示的状态项。',
    keywords: ['状态栏', 'statusbar', '显示', '隐藏'],
    control: custom('statusBarItems'),
    source: { kind: 'preference', preference: 'statusBar.hidden' },
  },
];

const SESSION_CATEGORY: SettingDefinition[] = [
  {
    id: 'session.sendKey',
    category: 'session',
    title: '发送消息',
    description: '选择发送消息的按键。',
    keywords: ['发送', 'send', '回车', 'Enter', '快捷键'],
    control: {
      kind: 'enum',
      presentation: 'toggle',
      options: SESSION_SEND_KEY_OPTIONS.map((option) => ({ ...option })),
    },
    default: 'enter',
    source: { kind: 'preference', preference: 'session.sendKey' },
  },
  {
    id: 'session.workspace',
    category: 'session',
    title: '工作区',
    description: '会话固定绑定此目录，不在聊天界面提供临时切换。',
    keywords: ['工作区', 'workspace', '目录', '路径'],
    control: custom('workspace'),
    readonly: true,
    source: { kind: 'readonly' },
  },
];

const NOTIFICATIONS_CATEGORY: SettingDefinition[] = [
  {
    id: 'notifications.system',
    category: 'notifications',
    title: '系统通知',
    description: '窗口不在前台时发送系统通知。',
    keywords: ['系统通知', 'system', '通知'],
    control: { kind: 'boolean' },
    default: true,
    source: { kind: 'preference', preference: 'notifications.system' },
  },
  {
    id: 'notifications.events',
    category: 'notifications',
    title: '通知的事件',
    description: '选择哪些事件进入通知历史并弹出提示。',
    keywords: ['事件', 'event', '通知', '完成', '失败', '额度', '更新'],
    control: custom('notificationEvents'),
    // One row over several `notifications.events.<id>` preferences; the control
    // owns its own writes through the bridge.
    source: { kind: 'custom' },
  },
  {
    id: 'notifications.doNotDisturb',
    category: 'notifications',
    title: '勿扰',
    description: '开启后只记录历史，不弹出提示；错误仍会显示。',
    keywords: ['勿扰', 'doNotDisturb', '静音'],
    control: { kind: 'boolean' },
    default: false,
    source: { kind: 'preference', preference: 'notifications.doNotDisturb' },
  },
  {
    id: 'notifications.sound',
    category: 'notifications',
    title: '通知声音',
    description: '系统通知播放提示音。',
    keywords: ['声音', 'sound', '提示音'],
    control: { kind: 'boolean' },
    default: true,
    source: { kind: 'preference', preference: 'notifications.sound' },
  },
];

const MODELS_CATEGORY: SettingDefinition[] = [
  {
    id: 'models.providers',
    category: 'models',
    title: '供应商',
    description: '凭据与排序在模型供应页管理，设置页不重复。',
    keywords: ['供应商', 'provider', '模型供应'],
    control: custom('providerSummary'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'models.autoPriceCap',
    category: 'models',
    title: '自动派发参考输出单价上限',
    description: '收紧自动选择的候选范围；留空表示沿用各 Task 默认值。',
    keywords: ['单价', 'price', 'cap', '上限', '自动派发'],
    control: custom('autoPriceCap'),
    source: { kind: 'daemon' },
  },
  {
    id: 'models.routingWeights',
    category: 'models',
    title: '路由权重',
    description: '调整自动派发时四项因子的相对比重，四项之和须为 100。',
    keywords: ['路由权重', 'routing', 'weights', '价格', '速度', '额度', '智能'],
    control: custom('routingWeights'),
    source: { kind: 'daemon' },
  },
  {
    id: 'models.runtimeAliases',
    category: 'models',
    title: '运行时别名',
    description: '保存供任务引用的运行时短别名。',
    keywords: ['别名', 'alias', '运行时', 'runtime'],
    control: custom('runtimeAliases'),
    source: { kind: 'daemon' },
  },
];

const PET_CATEGORY: SettingDefinition[] = [
  {
    id: 'pet.enabled',
    category: 'pet',
    group: 'basic',
    title: '启用桌宠',
    description: '关闭后保留设置，但不创建任何悬浮窗口',
    keywords: ['桌宠', 'pet', '启用', '显示'],
    control: custom('petEnabled'),
    source: { kind: 'custom' },
  },
  {
    id: 'pet.display',
    category: 'pet',
    group: 'basic',
    title: '显示器',
    description: '切换后会重置房屋拖动位置',
    keywords: ['显示器', 'display', '屏幕'],
    control: custom('petDisplay'),
    source: { kind: 'custom' },
  },
  {
    id: 'pet.houseSkin',
    category: 'pet',
    group: 'basic',
    title: '房屋外观',
    description: '沿用桌宠现有像素主题',
    keywords: ['房屋', '外观', 'skin', 'house'],
    control: custom('petHouseSkin'),
    source: { kind: 'custom' },
  },
  {
    id: 'pet.scale',
    category: 'pet',
    group: 'basic',
    title: '渲染缩放',
    description: '范围 1–6',
    keywords: ['缩放', 'scale', '渲染'],
    control: custom('petScale'),
    source: { kind: 'custom' },
  },
  {
    id: 'pet.showHouse',
    category: 'pet',
    group: 'content',
    title: '房屋',
    description: '额度提示与今日观测',
    keywords: ['房屋', 'house'],
    control: custom('petShowHouse'),
    source: { kind: 'custom' },
  },
  {
    id: 'pet.showWorkers',
    category: 'pet',
    group: 'content',
    title: '工人',
    description: '运行任务的桌面角色',
    keywords: ['工人', 'worker'],
    control: custom('petShowWorkers'),
    source: { kind: 'custom' },
  },
  {
    id: 'pet.showTaskgraphs',
    category: 'pet',
    group: 'content',
    title: '图纸燕',
    description: '活跃 TaskGraph 与图纸详情',
    keywords: ['图纸燕', 'taskgraph'],
    control: custom('petShowTaskgraphs'),
    source: { kind: 'custom' },
  },
  {
    id: 'pet.bottomOffset',
    category: 'pet',
    group: 'behavior',
    title: '底部偏移',
    description: '与屏幕底边的距离，范围 0–512',
    keywords: ['底部偏移', 'offset', '位置'],
    control: custom('petBottomOffset'),
    source: { kind: 'custom' },
  },
  {
    id: 'pet.bubbleSeconds',
    category: 'pet',
    group: 'behavior',
    title: '气泡时长',
    description: '消息显示秒数，范围 1–60',
    keywords: ['气泡', 'bubble', '时长'],
    control: custom('petBubbleSeconds'),
    source: { kind: 'custom' },
  },
];

const RUNTIME_CATEGORY: SettingDefinition[] = [
  {
    id: 'runtime.daemon',
    category: 'runtime',
    title: '本地 Daemon',
    description: '按生命周期归属启动或重启本地服务。',
    keywords: ['daemon', '本地服务', '重启', '启动'],
    control: custom('daemon'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'runtime.service',
    category: 'runtime',
    title: '本地服务',
    description: 'Desktop 通过公开协议读取 Wrenyard 控制面。',
    keywords: ['服务', 'service', '连接'],
    control: custom('service'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'runtime.endpoint',
    category: 'runtime',
    title: 'IPC Endpoint',
    description: 'Desktop、DSH 与观测模块共享的只读数据通路。',
    keywords: ['endpoint', 'ipc', '路径'],
    control: custom('endpoint'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'runtime.logs',
    category: 'runtime',
    title: '日志',
    description: 'Daemon 与 Desktop 的运行日志目录。',
    keywords: ['日志', 'log', '目录'],
    control: custom('logs'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'runtime.settingsFile',
    category: 'runtime',
    title: '设置文件',
    description: 'Desktop 偏好设置文件，可直接用系统编辑器打开。',
    keywords: ['设置文件', 'settings', 'json'],
    control: custom('settingsFile'),
    readonly: true,
    source: { kind: 'readonly' },
  },
];

const UPDATE_CATEGORY: SettingDefinition[] = [
  {
    id: 'update.status',
    category: 'update',
    title: '当前版本',
    description: '自动检查啾啾工坊套件的新版本，由你决定何时安装。',
    keywords: ['更新', 'update', '版本', 'version'],
    control: custom('updateStatus'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'update.autoCheck',
    category: 'update',
    title: '自动检查更新',
    description: '关闭后只在手动检查时检查。',
    keywords: ['自动检查', 'update', 'auto', '检查'],
    control: { kind: 'boolean' },
    default: true,
    source: { kind: 'preference', preference: 'update.autoCheck' },
  },
];

const ABOUT_CATEGORY: SettingDefinition[] = [
  {
    id: 'about.theme',
    category: 'about',
    title: '当前主题',
    description: '啾啾工坊是 Wrenyard 套件的 Desktop 主界面。',
    keywords: ['主题', 'theme', '关于'],
    control: custom('aboutTheme'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'about.wrenyardVersion',
    category: 'about',
    title: 'Wrenyard',
    keywords: ['版本', 'version', 'wrenyard'],
    control: custom('aboutWrenyardVersion'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'about.desktopVersion',
    category: 'about',
    title: 'Desktop',
    keywords: ['版本', 'version', 'desktop'],
    control: custom('aboutDesktopVersion'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'about.buildTime',
    category: 'about',
    title: '构建时间',
    keywords: ['构建', 'build', '时间'],
    control: custom('aboutBuildTime'),
    readonly: true,
    source: { kind: 'readonly' },
  },
  {
    id: 'about.diagnostics',
    category: 'about',
    title: '诊断信息',
    description: '把版本、平台与 Daemon 状态复制为一段文本，便于反馈问题。',
    keywords: ['诊断', 'diagnostic', '复制'],
    control: custom('aboutDiagnostics'),
    readonly: true,
    source: { kind: 'readonly' },
  },
];

/** Every declarative setting, in display order inside each category. */
export const SETTINGS_REGISTRY: readonly SettingDefinition[] = [
  ...GENERAL_CATEGORY,
  ...APPEARANCE_CATEGORY,
  ...SESSION_CATEGORY,
  ...MODELS_CATEGORY,
  ...NOTIFICATIONS_CATEGORY,
  ...PET_CATEGORY,
  ...RUNTIME_CATEGORY,
  ...UPDATE_CATEGORY,
  ...ABOUT_CATEGORY,
];

export function settingsForCategory(category: SettingsCategoryId): readonly SettingDefinition[] {
  return SETTINGS_REGISTRY.filter((definition) => definition.category === category);
}

/** All keyword-bearing text for one definition, for search haystacks. */
export function settingSearchFields(definition: SettingDefinition): {
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
} {
  return {
    id: definition.id,
    title: definition.title,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    ...(definition.keywords !== undefined ? { keywords: definition.keywords } : {}),
  };
}
