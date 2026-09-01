import type { QuotaProviderState } from '@wrenyard/pet/runtime';
import type {
  ProviderAuthMode,
  ProviderAuthStatus,
  ProviderCatalogSnapshot,
  QuotaBalanceSnapshot,
  QuotaProviderSnapshot,
  QuotaSnapshot,
  QuotaWindowSnapshot,
} from './shell-contract.js';
import { canonicalProviderId, normalizeProviderOrder, sortProvidersByAvailability } from './provider-order.js';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

export interface QuotaProviderSource {
  listProviders(forceRefresh?: boolean): Promise<QuotaProviderState[]>;
}

export interface ProviderDiscoverySource {
  listProviders(): Promise<ProviderAuthStatus[]>;
}

export interface DesktopQuotaControllerOptions {
  source: QuotaProviderSource;
  providerSource?: ProviderDiscoverySource;
  getProviderOrder(): Array<{ id: string; enabled: boolean }>;
  onChanged?(snapshot: QuotaSnapshot, providers: QuotaProviderState[]): void;
  refreshIntervalMs?: number;
}

/** Desktop-owned quota lifecycle shared by the app page, tray and passive Pet. */
export class DesktopQuotaController {
  private providers: QuotaProviderState[] = [];
  private discovered: ProviderAuthStatus[] = [];
  private refreshedAt: number | undefined;
  private message: string | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<QuotaSnapshot> | null = null;

  constructor(private readonly options: DesktopQuotaControllerOptions) {}

  async start(): Promise<QuotaSnapshot> {
    const snapshot = await this.refresh(false);
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(
        () => void this.refresh(false),
        this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      );
    }
    return snapshot;
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  snapshot(): QuotaSnapshot {
    return projectQuotaSnapshot(
      this.providers,
      this.options.getProviderOrder(),
      this.refreshedAt,
      this.message,
      this.discovered,
    );
  }

  async getSnapshot(forceRefresh = false): Promise<QuotaSnapshot> {
    if (forceRefresh || this.refreshedAt === undefined) return this.refresh(forceRefresh);
    return this.snapshot();
  }

  notifyConfigurationChanged(): QuotaSnapshot {
    const snapshot = this.snapshot();
    this.options.onChanged?.(snapshot, selectVisibleProviderStates(this.providers, snapshot));
    return snapshot;
  }

  private refresh(forceRefresh: boolean): Promise<QuotaSnapshot> {
    if (this.pending) return this.pending;
    this.pending = this.performRefresh(forceRefresh).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async performRefresh(forceRefresh: boolean): Promise<QuotaSnapshot> {
    try {
      const [providers, discovered] = await Promise.all([
        this.options.source.listProviders(forceRefresh),
        this.options.providerSource
          ? this.options.providerSource.listProviders().catch(() => [] as ProviderAuthStatus[])
          : Promise.resolve([] as ProviderAuthStatus[]),
      ]);
      this.providers = cloneProviders(providers);
      this.discovered = discovered;
      this.refreshedAt = Date.now();
      this.message = this.providers.length > 0 ? undefined : '暂时无法读取额度数据，请稍后刷新。';
    } catch (error) {
      this.providers = [];
      this.refreshedAt = Date.now();
      this.message = '暂时无法读取额度数据，请稍后刷新。';
    }
    const snapshot = this.snapshot();
    this.options.onChanged?.(snapshot, selectVisibleProviderStates(this.providers, snapshot));
    return snapshot;
  }
}

export function projectQuotaSnapshot(
  providers: QuotaProviderState[],
  configuredOrder: Array<{ id: string; enabled: boolean }>,
  refreshedAt?: number,
  message?: string,
  discovered: ProviderAuthStatus[] = [],
): QuotaSnapshot {
  const canonicalProviders = canonicalizeProviders(providers);
  const canonicalOrder = canonicalizeOrder(configuredOrder);
  const canonicalDiscovered = canonicalizeDiscovered(discovered);
  const catalog = projectCatalog(canonicalProviders, canonicalOrder, canonicalDiscovered);
  const projected = catalog.flatMap((entry) => entry.configured && entry.quota ? [entry.quota] : []);
  return {
    status: canonicalProviders.length > 0 || canonicalOrder.length === 0 ? 'available' : 'unavailable',
    providers: projected,
    catalog,
    providerOrder: normalizeProviderOrder(canonicalOrder),
    ...(refreshedAt !== undefined ? { refreshedAt } : {}),
    ...(message ? { message: sanitizeQuotaText(message) } : {}),
  };
}

function canonicalizeProviders(providers: QuotaProviderState[]): QuotaProviderState[] {
  const byId = new Map<string, QuotaProviderState>();
  for (const provider of providers) {
    const id = canonicalProviderId(provider.id);
    if (!byId.has(id)) byId.set(id, { ...provider, id });
  }
  return [...byId.values()];
}

function canonicalizeOrder(order: Array<{ id: string; enabled: boolean }>): Array<{ id: string; enabled: boolean }> {
  const byId = new Map<string, { id: string; enabled: boolean }>();
  for (const entry of order) {
    const id = canonicalProviderId(entry.id);
    const existing = byId.get(id);
    byId.set(id, existing
      ? { id, enabled: existing.enabled || entry.enabled }
      : { id, enabled: entry.enabled });
  }
  return [...byId.values()];
}

function canonicalizeDiscovered(discovered: ProviderAuthStatus[]): ProviderAuthStatus[] {
  const byId = new Map<string, ProviderAuthStatus>();
  for (const entry of discovered) {
    const id = canonicalProviderId(entry.id);
    const existing = byId.get(id);
    byId.set(id, existing
      ? { ...existing, id, configured: existing.configured || entry.configured }
      : { ...entry, id });
  }
  return [...byId.values()];
}

function projectProvider(id: string, provider: QuotaProviderState): QuotaProviderSnapshot {
  const windows: QuotaWindowSnapshot[] = (provider.bars?.windows ?? []).map((window) => ({
    name: sanitizeQuotaText(window.name),
    remainingPct: clampPercentage(window.remainingPct),
    expectedRemainingPct: window.expectedRemainingPct === null
      ? null
      : clampPercentage(window.expectedRemainingPct),
  }));
  if (windows.length === 0 && provider.bars?.remainingPct !== null && provider.bars?.remainingPct !== undefined) {
    windows.push({
      name: 'quota',
      remainingPct: clampPercentage(provider.bars.remainingPct),
      expectedRemainingPct: provider.bars.expectedRemainingPct === null
        ? null
        : clampPercentage(provider.bars.expectedRemainingPct),
    });
  }
  const balances: QuotaBalanceSnapshot[] = (provider.balances ?? []).map((balance) => ({
    currency: balance.currency,
    amount: balance.amount,
    display: sanitizeQuotaText(balance.display),
  }));
  // A successful status preserves the runtime's friendly message (e.g. the
  // observed CodeBuddy monthly exhaustion) alongside any display line, while
  // error/unavailable statuses keep the generic unavailable copy.
  const unavailable = isQuotaUnavailable(provider.status);
  const message = unavailable
    ? '额度数据暂不可用。'
    : provider.status === 'ok' && provider.error
      ? sanitizeQuotaText(provider.error)
      : undefined;
  const displayLine = !unavailable && provider.displayLine
    ? sanitizeQuotaText(provider.displayLine)
    : undefined;
  return {
    id,
    label: sanitizeQuotaText(provider.label || id),
    status: provider.status,
    stale: provider.stale,
    windows,
    balances,
    ...(message ? { message } : {}),
    ...(displayLine ? { displayLine } : {}),
    ...(provider.code ? { code: sanitizeQuotaText(provider.code) } : {}),
  };
}

interface ProductProviderDescriptor {
  label: string;
  description: string;
  authMode: ProviderAuthMode;
  setupHint: string;
}

/** Product copy for canonical providers; unknown/custom ids fall back to generic text. */
const KNOWN_PROVIDERS: Record<string, ProductProviderDescriptor> = {
  anthropic: {
    label: 'Anthropic',
    description: 'Claude Code 与 Anthropic 模型服务。',
    authMode: 'native',
    setupHint: '请使用 Claude Code 完成登录，返回啾啾工坊后刷新状态。',
  },
  'anthropic-api': {
    label: 'Anthropic API',
    description: 'Anthropic 官方开放平台 API，与 Claude Code 登录态分开配置。',
    authMode: 'api-key',
    setupHint: '输入 Anthropic API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  codebuddy: {
    label: 'CodeBuddy',
    description: 'CodeBuddy 提供的 DeepSeek、混元与 Kimi 模型。',
    authMode: 'native',
    setupHint: '请在 CodeBuddy 客户端完成登录，返回啾啾工坊后刷新状态。',
  },
  codex: {
    label: 'Codex',
    description: 'OpenAI Codex 编程模型与订阅额度。',
    authMode: 'native',
    setupHint: '请使用 Codex CLI 完成登录，返回啾啾工坊后刷新状态。',
  },
  'codex-spark': {
    label: 'Codex Spark',
    description: '低延迟 Codex Spark 模型与独立额度池。',
    authMode: 'native',
    setupHint: 'Codex Spark 复用 Codex 登录状态；请先使用 Codex CLI 登录。',
  },
  cursor: {
    label: 'Cursor',
    description: 'Cursor Composer 与 Grok 模型服务。',
    authMode: 'native',
    setupHint: '请在 Cursor Desktop 中完成登录，返回啾啾工坊后刷新状态。',
  },
  'kimi-coding': {
    label: 'Kimi Coding',
    description: 'Moonshot Kimi K3 编程模型与订阅额度。',
    authMode: 'api-key',
    setupHint: '输入 Kimi Coding API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  moonshot: {
    label: 'Kimi 开放平台',
    description: '月之暗面官方开放平台的 Kimi 模型。',
    authMode: 'api-key',
    setupHint: '输入 Kimi 开放平台 API Key；它与 Kimi Coding Key 分开保存。',
  },
  minimax: {
    label: 'MiniMax 开放平台',
    description: 'MiniMax 官方按量计费 API。',
    authMode: 'api-key',
    setupHint: '输入 MiniMax 按量计费 API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  'minimax-coding': {
    label: 'MiniMax Coding Plan',
    description: 'MiniMax Token Plan 的订阅 Key 接入。',
    authMode: 'api-key',
    setupHint: '输入 MiniMax 订阅 Key；订阅 Key 与按量计费 API Key 不可混用。',
  },
  openai: {
    label: 'OpenAI API',
    description: 'OpenAI 官方开放平台 API，与 Codex 登录态分开配置。',
    authMode: 'api-key',
    setupHint: '输入 OpenAI API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  qwen: {
    label: 'Qwen 开放平台',
    description: '阿里云百炼按量计费的 Qwen 模型。',
    authMode: 'api-key',
    setupHint: '输入百炼按量计费 API Key；它与 Coding Plan Key 分开保存。',
  },
  'qwen-coding': {
    label: 'Qwen Coding Plan',
    description: '阿里云百炼 Coding Plan 订阅模型。',
    authMode: 'api-key',
    setupHint: '输入 Coding Plan API Key（sk-sp-）；不要使用百炼按量计费 Key。',
  },
  tokenhub: {
    label: '腾讯云 TokenHub',
    description: '腾讯云大模型服务平台 TokenHub 的公开 API。',
    authMode: 'api-key',
    setupHint: '输入腾讯云 TokenHub API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  volcengine: {
    label: '火山引擎方舟',
    description: '火山引擎方舟官方模型 API。',
    authMode: 'api-key',
    setupHint: '输入火山方舟 API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  zhipu: {
    label: '智谱开放平台',
    description: '智谱 BigModel 官方按量计费 API。',
    authMode: 'api-key',
    setupHint: '输入智谱开放平台 API Key；它与 GLM Coding Key 分开保存。',
  },
  'zhipu-coding': {
    label: 'GLM Coding',
    description: '智谱 GLM-5.3 系列编程模型与订阅额度。',
    authMode: 'api-key',
    setupHint: '输入 GLM Coding API Key；Key 仅写入本机 Wrenyard runtime。',
  },
  deepseek: {
    label: 'DeepSeek',
    description: 'DeepSeek 官方 API 模型与账户余额。',
    authMode: 'environment',
    setupHint: '通过 DEEPSEEK_API_KEY 或 FORGE_DEEPSEEK_API_KEY 环境变量提供 Key。',
  },
  'spacex-ai': {
    label: 'SpaceXAI',
    description: 'SpaceXAI 提供的 Grok 原生 OAuth 模型服务。',
    authMode: 'native',
    setupHint: '请使用 Grok 客户端完成 OAuth 登录，返回啾啾工坊后刷新状态。',
  },
  'super-grok': {
    label: 'SuperGrok',
    description: 'SuperGrok 订阅额度观察来源。',
    authMode: 'native',
    setupHint: '请使用 Grok 客户端完成登录；若登录已过期，请重新登录后返回工坊刷新。',
  },
};

function projectCatalog(
  providers: QuotaProviderState[],
  configuredOrder: Array<{ id: string; enabled: boolean }>,
  discovered: ProviderAuthStatus[],
): ProviderCatalogSnapshot[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const discoveredById = new Map(discovered.map((entry) => [entry.id, entry]));

  const ids: string[] = [];
  const seen = new Set<string>();
  const pushId = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const entry of configuredOrder) pushId(entry.id);
  for (const entry of discovered) pushId(entry.id);
  for (const provider of providers) pushId(provider.id);

  const catalog = ids.map((id) => {
    const known = KNOWN_PROVIDERS[id];
    const discoveredStatus = discoveredById.get(id);
    const quota = byId.get(id);
    const authMode = known?.authMode ?? discoveredStatus?.authMode ?? 'none';
    const projectedQuota = quota ? projectProvider(id, quota) : undefined;
    const configured = projectedQuota?.code === 'configuration_missing'
      || projectedQuota?.code === 'authentication_required'
      ? false
      : projectedQuota?.code === 'quota_query_failed'
        ? true
        : discoveredStatus?.configured
          ?? (authMode === 'none'
            ? known !== undefined
            : quota !== undefined && quota.status !== 'unavailable');
    if (projectedQuota && isQuotaUnavailable(projectedQuota.status)) {
      // CodeBuddy never advertises a quota lookup source: only the locally
      // observed exhaustion is ever projected, so a connected-but-unobserved
      // row keeps the product "no quota lookup" wording.
      projectedQuota.message = id === 'codebuddy'
        ? '此 Provider 暂不提供额度查询。'
        : unavailableQuotaMessage(authMode, configured, projectedQuota.code);
    }
    const base = {
      id,
      configured,
      ...(projectedQuota ? { quota: projectedQuota } : {}),
    };
    if (known) {
      return {
        ...base,
        label: known.label,
        description: known.description,
        authMode: known.authMode,
        setupHint: known.setupHint,
      };
    }
    return {
      ...base,
      label: id,
      description: '由 Wrenyard runtime 提供的模型服务。',
      authMode,
      setupHint: authMode === 'native'
        ? '请在对应的原生客户端完成登录，返回啾啾工坊后刷新状态。'
        : '该来源没有独立 API Key 配置入口。',
    };
  });
  return sortProvidersByAvailability(catalog, configuredOrder);
}

function cloneProviders(providers: QuotaProviderState[]): QuotaProviderState[] {
  return providers.map((provider) => ({
    ...provider,
    ...(provider.bars ? {
      bars: {
        ...provider.bars,
        windows: provider.bars.windows.map((window) => ({ ...window })),
      },
    } : {}),
    ...(provider.balances ? { balances: provider.balances.map((balance) => ({ ...balance })) } : {}),
  }));
}

/** Preserve the Provider page order while withholding inactive/non-quota rows from Pet. */
function selectVisibleProviderStates(
  providers: QuotaProviderState[],
  snapshot: QuotaSnapshot,
): QuotaProviderState[] {
  const byId = new Map(canonicalizeProviders(providers).map((provider) => [provider.id, provider]));
  return snapshot.providers.flatMap((provider) => {
    const source = byId.get(provider.id);
    return source ? cloneProviders([source]) : [];
  });
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function isQuotaUnavailable(status: QuotaProviderSnapshot['status']): boolean {
  return status === 'error' || status === 'unavailable';
}

function unavailableQuotaMessage(authMode: ProviderAuthMode, configured: boolean, code?: string): string {
  if (code === 'configuration_missing') return '尚未配置，请先完成 Grok 登录。';
  if (code === 'authentication_required') return '登录已失效，请重新登录后刷新。';
  if (code === 'quota_query_failed') return '额度查询失败，请稍后刷新。';
  if (authMode === 'none') return '此 Provider 暂不提供额度查询。';
  if (!configured) {
    return authMode === 'native'
      ? '尚未登录，请完成登录后刷新。'
      : '尚未配置，请完成配置后刷新。';
  }
  return '已连接；暂时无法读取额度，请稍后刷新。';
}

function sanitizeQuotaText(value: string): string {
  const normalized = value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 219)}…`;
}
