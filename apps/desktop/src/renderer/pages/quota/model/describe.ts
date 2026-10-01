import type { StatusTone } from '@/renderer/components/status-badge';
import type { ProviderAuthMode, QuotaProviderSnapshot } from '@/shell-contract';

/**
 * Central product copy and status mappings for the Model Supply page. Code and
 * identifiers stay English; every user-visible string lives here in Chinese.
 */

export const PAGE_TITLE = '模型供应';
export const REFRESH_LABEL = '刷新';
export const REFRESHING_LABEL = '刷新中…';
export const RETRY_LABEL = '重试';

/* ---------------------------------------------------------------- */
/* Tabs                                                              */
/* ---------------------------------------------------------------- */

export type QuotaTab = 'supply' | 'routing' | 'models';

export const QUOTA_TABS: ReadonlyArray<{ value: QuotaTab; label: string }> = [
  { value: 'supply', label: '供应商' },
  { value: 'routing', label: '派发测试' },
  { value: 'models', label: '模型' },
];

export function isQuotaTab(value: unknown): value is QuotaTab {
  return value === 'supply' || value === 'routing' || value === 'models';
}

/* ---------------------------------------------------------------- */
/* Supply                                                            */
/* ---------------------------------------------------------------- */

export const SUPPLY_EMPTY = '未发现受支持的 Provider。';
export const SUPPLY_UNAVAILABLE = 'Provider 数据暂时不可用，请稍后刷新。';
export const QUOTA_UNAVAILABLE_FALLBACK = '供应数据暂不可用';
export const UNCONFIGURED_TITLE = '未配置的供应商';
export const ACTIVATION_NOTE = '请先激活 Provider；激活后才会加入模型与额度服务。';
export const NO_DATA_NOTE = '暂无可展示的额度数据。';
export const ORDER_SAVE_ERROR_PREFIX = '顺序保存失败：';

/** Guidance shown for a configured provider that exposes no quota block yet. */
export function providerNoQuotaNote(mode: ProviderAuthMode): string {
  if (mode === 'native') return '尚未登录，请完成登录后刷新。';
  if (mode === 'api-key') return '尚未配置 Key，配置后可在这里查看额度。';
  if (mode === 'environment') return '尚未配置，请提供环境变量后刷新。';
  return '此 Provider 暂不提供额度查询。';
}

const QUOTA_STATUS_VIEW: Record<QuotaProviderSnapshot['status'], { tone: StatusTone; label: string }> = {
  ok: { tone: 'success', label: '正常' },
  pending: { tone: 'warning', label: '同步中' },
  error: { tone: 'danger', label: '异常' },
  unavailable: { tone: 'muted', label: '不可用' },
};

export function quotaStatusView(status: QuotaProviderSnapshot['status']): { tone: StatusTone; label: string } {
  return QUOTA_STATUS_VIEW[status] ?? { tone: 'muted', label: '未知' };
}

export const STALE_LABEL = '数据可能过期';

/** Tooltip copy for the expected-remaining pace marker on a quota window. */
export function windowExpectedTooltip(pct: number): string {
  return `按当前时间进度建议剩余 ${Math.floor(pct)}%`;
}

export function configureProviderLabel(name: string, configured: boolean): string {
  return configured ? `配置 ${name}` : `激活 ${name}`;
}

export function dragHandleLabel(name: string): string {
  return `拖动调整 ${name} 的顺序`;
}

export const MOVE_UP_LABEL = '上移';
export const MOVE_DOWN_LABEL = '下移';

/* ---------------------------------------------------------------- */
/* Provider dialog                                                   */
/* ---------------------------------------------------------------- */

export const PROVIDER_DIALOG_EYEBROW = 'PROVIDER CONFIGURATION';
export const PROVIDER_KEY_LABEL = 'API Key';
export const OPEN_KEY_PAGE_LABEL = '打开官方密钥页面 ↗';
export const DIALOG_CANCEL_LABEL = '取消';
export const DIALOG_SAVE_LABEL = '保存';
export const DIALOG_UPDATE_LABEL = '更新';
export const KEY_REQUIRED_ERROR = '请输入 API Key。';
export const KEY_SAVE_ERROR = '密钥保存失败，请重试。';
export const KEY_PAGE_ERROR = '打开密钥页面失败，请重试。';

export function providerDialogTitle(mode: ProviderAuthMode, configured: boolean): string {
  if (mode !== 'api-key') return '提供方配置指引';
  return configured ? '更新 API Key' : '配置 API Key';
}

/** Auth-mode guidance shown when the provider carries no setup hint. */
export function providerAuthGuidance(mode: ProviderAuthMode): string {
  if (mode === 'api-key') return '在 Provider 控制台创建 API Key 后粘贴到这里；Key 仅写入本地运行时，不会回显到页面。';
  if (mode === 'native') return '此提供方使用浏览器登录授权，无需 API 密钥。请在提供方登录页完成验证后回到工坊继续使用。';
  if (mode === 'environment') return '此提供方的密钥由启动环境的环境变量提供，本页面不接收密钥输入。请调整启动环境后重新加载会话。';
  return '此提供方无需配置密钥。';
}

/* ---------------------------------------------------------------- */
/* Model list                                                        */
/* ---------------------------------------------------------------- */

export const MODELS_EMPTY = '未发现受支持的模型。';
export const MODEL_PRICE_SUFFIX = '（$/Mtok）';
export const MODEL_FILTER_ALL_LABEL = '全部家族';
export const MODEL_FAMILY_FILTER_LABEL = '家族';
export const MODEL_SEARCH_PLACEHOLDER = '搜索模型…';
export const MODEL_SORT_LABEL = '排序';

export interface ModelColumn {
  id: 'model' | 'cache' | 'input' | 'output' | 'tps' | 'providers';
  label: string;
  /** True when the heading carries the USD-per-million-token unit. */
  price: boolean;
}

export const MODEL_COLUMNS: ReadonlyArray<ModelColumn> = [
  { id: 'model', label: '模型', price: false },
  { id: 'cache', label: '缓存', price: true },
  { id: 'input', label: '输入', price: true },
  { id: 'output', label: '输出', price: true },
  { id: 'tps', label: '速度', price: false },
  { id: 'providers', label: '供应商', price: false },
];

export const MODEL_SORT_OPTIONS: ReadonlyArray<{ value: 'default' | 'name' | 'speed'; label: string }> = [
  { value: 'default', label: '推荐顺序' },
  { value: 'name', label: '名称' },
  { value: 'speed', label: '速度' },
];

/* ---------------------------------------------------------------- */
/* Routing test                                                      */
/* ---------------------------------------------------------------- */

export const ROUTING_TITLE = '派发测试';
export const ROUTING_TASK_PLACEHOLDER = '选择 Task';
export const ROUTING_TASK_EMPTY = '没有匹配的 Task';
export const ROUTING_LABEL = '路由测试';

export const MIN_INTELLIGENCE_LABEL = '最低智能';
export const EXPECTED_INTELLIGENCE_LABEL = '推荐智能';
export const INTELLIGENCE_ANY_LABEL = '不限';
/** Sentinel Select value meaning "no minimum intelligence" (empty strings are not used as values). */
export const INTELLIGENCE_ANY_VALUE = '__any__';
export const MIN_TPS_LABEL = '最低 TPS';
export const EXPECTED_TPS_LABEL = '期望 TPS';
export const OUTPUT_CAP_LABEL = '输出单价上限';
export const OUTPUT_CAP_PLACEHOLDER = '可选，USD / 百万 Token';
export const OPTIONAL_PLACEHOLDER = '可选';
export const REQUIRE_IMAGE_LABEL = '需要图片输入';
export const REQUIRE_SEARCH_LABEL = '需要联网搜索';
export const EXCLUDE_MODELS_LABEL = '排除模型';
export const EXCLUDE_PROVIDERS_LABEL = '排除供应商';
export const EXCLUSION_EMPTY = '没有匹配项';

export const ROUTING_RUN_LABEL = '测试';
export const ROUTING_RUNNING_LABEL = '测试中…';
export const ROUTING_EMPTY = '暂无可用模型';
export const ROUTING_IMPORT_ERROR_PREFIX = '导入失败：';
export const ROUTING_RUN_ERROR_PREFIX = '测试失败：';

export interface RoutingResultColumn {
  id: 'rank' | 'provider' | 'model' | 'tps' | 'price' | 'speed' | 'quota' | 'intelligence' | 'score' | 'reason';
  label: string;
}

export const ROUTING_RESULT_COLUMNS: ReadonlyArray<RoutingResultColumn> = [
  { id: 'rank', label: '排名' },
  { id: 'provider', label: '供应商' },
  { id: 'model', label: '模型' },
  { id: 'tps', label: 'TPS' },
  { id: 'price', label: '价格分' },
  { id: 'speed', label: '速度分' },
  { id: 'quota', label: '额度分' },
  { id: 'intelligence', label: '智能分' },
  { id: 'score', label: '总分' },
  { id: 'reason', label: '原因' },
];

/* ---------------------------------------------------------------- */
/* Errors                                                            */
/* ---------------------------------------------------------------- */

/** Strip the Electron IPC wrapper so only the daemon message is shown. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  return String(error);
}
