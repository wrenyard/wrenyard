import { QUOTA_EVIDENCE_GRACE_MS, quotaStateOf } from '@wrenyard/auto-routing';
import type { BalanceEvidence, QuotaEvidence } from '@wrenyard/auto-routing';
import type { QuotaProviderState } from './main/projections/quota-runtime';
import type {
  ProviderAuthMode,
  ProviderAuthStatus,
  ProviderCatalogSnapshot,
  QuotaBalanceSnapshot,
  QuotaPoolState,
  QuotaProviderSnapshot,
  QuotaSnapshot,
  QuotaWindowSnapshot,
} from './shell-contract.js';
import { normalizeProviderId, normalizeProviderOrder, sortProvidersByAvailability } from './provider-order.js';

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
  private pendingForced = false;

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

  /**
   * Drop every cached business snapshot on a connection transition. Unlike a
   * refetch, this does not wait for the new endpoint: the previous context's
   * quota and provider rows (and the Pet projection built from them) are cleared
   * immediately, so no stale data survives the switch. The next refresh
   * repopulates from the committed endpoint.
   */
  resetSnapshots(): QuotaSnapshot {
    this.providers = [];
    this.discovered = [];
    this.refreshedAt = undefined;
    this.message = undefined;
    const snapshot = this.snapshot();
    this.options.onChanged?.(snapshot, []);
    return snapshot;
  }

  private refresh(forceRefresh: boolean): Promise<QuotaSnapshot> {
    if (this.pending) {
      return forceRefresh && !this.pendingForced
        ? this.pending.then(() => this.refresh(true))
        : this.pending;
    }
    this.pendingForced = forceRefresh;
    this.pending = this.performRefresh(forceRefresh).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async performRefresh(forceRefresh: boolean): Promise<QuotaSnapshot> {
    const [quota, discovery] = await Promise.allSettled([
      this.options.source.listProviders(forceRefresh),
      this.options.providerSource?.listProviders() ?? Promise.resolve(this.discovered),
    ]);
    if (discovery.status === 'fulfilled') this.discovered = discovery.value;
    if (quota.status === 'fulfilled') {
      this.providers = cloneProviders(quota.value);
      this.refreshedAt = Date.now();
      this.message = this.providers.length > 0 ? undefined : '暂时无法读取额度数据，请稍后刷新。';
    } else {
      this.providers = this.providers.map(provider => ({ ...provider, stale: true }));
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
  const catalog = projectCatalog(canonicalProviders, canonicalOrder, canonicalDiscovered, refreshedAt);
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
    const id = normalizeProviderId(provider.id);
    if (!id || byId.has(id)) continue;
    byId.set(id, { ...provider, id });
  }
  return [...byId.values()];
}

function canonicalizeOrder(order: Array<{ id: string; enabled: boolean }>): Array<{ id: string; enabled: boolean }> {
  const byId = new Map<string, { id: string; enabled: boolean }>();
  for (const entry of order) {
    const id = normalizeProviderId(entry.id);
    if (!id) continue;
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
    const id = normalizeProviderId(entry.id);
    if (!id) continue;
    const existing = byId.get(id);
    byId.set(id, existing
      ? { ...existing, id, configured: existing.configured || entry.configured }
      : { ...entry, id });
  }
  return [...byId.values()];
}

function projectProvider(id: string, provider: QuotaProviderState, lastSuccessAt?: number): QuotaProviderSnapshot {
  const nowMs = Date.now();
  // The measurement behind these numbers: the last successful read, or this
  // projection when none is recorded. It is the age the grace rules use.
  const observedAtMs = lastSuccessAt ?? nowMs;
  const windows: QuotaWindowSnapshot[] = (provider.bars?.windows ?? []).map((window) => {
    const row: QuotaWindowSnapshot = {
      name: sanitizeQuotaText(window.name),
      remainingPct: clampPercentage(window.remainingPct),
      expectedRemainingPct: window.expectedRemainingPct === null
        ? null
        : clampPercentage(window.expectedRemainingPct),
      ...(window.poolLabel !== undefined ? { poolLabel: sanitizeQuotaText(window.poolLabel) } : {}),
      ...windowTiming(window.resetsAt, window.windowMinutes),
    };
    return { ...row, state: windowPoolState(row, observedAtMs, nowMs) };
  });
  if (windows.length === 0 && provider.bars?.remainingPct !== null && provider.bars?.remainingPct !== undefined) {
    const row: QuotaWindowSnapshot = {
      name: 'quota',
      remainingPct: clampPercentage(provider.bars.remainingPct),
      expectedRemainingPct: provider.bars.expectedRemainingPct === null
        ? null
        : clampPercentage(provider.bars.expectedRemainingPct),
    };
    windows.push({ ...row, state: windowPoolState(row, observedAtMs, nowMs) });
  }
  const balances: QuotaBalanceSnapshot[] = (provider.balances ?? []).map((balance) => {
    const row: QuotaBalanceSnapshot = {
      ...(balance.id === undefined ? {} : { id: balance.id }),
      ...(balance.currency === undefined ? {} : { currency: balance.currency }),
      amount: balance.amount,
      ...(balance.unit === undefined ? {} : { unit: balance.unit }),
      ...(balance.unlimited === undefined ? {} : { unlimited: balance.unlimited }),
      display: sanitizeQuotaText(balance.display),
    };
    return { ...row, state: balancePoolState(row, observedAtMs, nowMs) };
  });
  // A successful status preserves the runtime's friendly message (e.g. the
  // observed CodeBuddy monthly exhaustion) alongside any display line, while
  // error/unavailable statuses keep the generic unavailable copy. A rate-limit
  // observation keeps the last good data and gets its own retry copy.
  const unavailable = isQuotaUnavailable(provider.status);
  const message = provider.code === 'rate_limited'
    ? rateLimitedMessage(provider.error)
    : unavailable
      ? '额度数据暂不可用。'
      : provider.status === 'ok' && provider.error
        ? sanitizeQuotaText(provider.error)
        : undefined;
  const displayLine = !unavailable && provider.displayLine
    ? sanitizeQuotaText(provider.displayLine)
    : undefined;
  const plan = typeof provider.plan === 'string' ? sanitizeQuotaText(provider.plan) : undefined;
  // Sanitized login identity the provider reported. Providers that report none
  // keep both fields absent, so the renderer shows no identity for them.
  const accountType = typeof provider.accountType === 'string' && provider.accountType.length > 0
    ? sanitizeQuotaText(provider.accountType)
    : undefined;
  const idp = typeof provider.idp === 'string' && provider.idp.length > 0
    ? sanitizeQuotaText(provider.idp)
    : undefined;
  const snapshot: QuotaProviderSnapshot = {
    id,
    label: sanitizeQuotaText(provider.label || id),
    ...(plan ? { plan } : {}),
    status: provider.status,
    stale: provider.stale,
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
    windows,
    balances,
    ...(message ? { message } : {}),
    ...(displayLine ? { displayLine } : {}),
    ...(provider.code ? { code: sanitizeQuotaText(provider.code) } : {}),
    ...(provider.estimatedSpend ? { estimatedSpend: provider.estimatedSpend } : {}),
  };
  const identity = {
    ...(accountType ? { accountType } : {}),
    ...(idp ? { idp } : {}),
  };
  return { ...snapshot, ...identity };
}

function projectCatalog(
  providers: QuotaProviderState[],
  configuredOrder: Array<{ id: string; enabled: boolean }>,
  discovered: ProviderAuthStatus[],
  lastSuccessAt?: number,
): ProviderCatalogSnapshot[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const discoveredById = new Map(discovered.map((entry) => [entry.id, entry]));

  // Rows come only from current authoritative sources (discovery and quota).
  // Saved order preferences never synthesize a row; they only reorder these ids.
  const ids: string[] = [];
  const seen = new Set<string>();
  const pushId = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const entry of discovered) pushId(entry.id);
  for (const provider of providers) pushId(provider.id);

  const catalog = ids.map((id) => {
    const discoveredStatus = discoveredById.get(id);
    const quota = byId.get(id);
    const authMode = discoveredStatus?.authMode ?? 'none';
    const projectedQuota = quota ? projectProvider(id, quota, lastSuccessAt) : undefined;
    const configured = discoveredStatus?.configured
      ?? (quota !== undefined && quota.status !== 'unavailable');
    if (projectedQuota && isQuotaUnavailable(projectedQuota.status)) {
      // CodeBuddy never advertises a quota lookup source: only the locally
      // observed exhaustion is ever projected, so a connected-but-unobserved
      // row keeps the product "no quota lookup" wording.
      projectedQuota.message = id === 'codebuddy'
        ? '此 Provider 暂不提供额度查询。'
        : unavailableQuotaMessage(authMode, configured, projectedQuota.code, quota?.error);
    }
    // Quota observations carry the raw provider id as their label; surfaces
    // such as the status bar should show the catalog display name instead.
    if (projectedQuota && discoveredStatus?.displayName) projectedQuota.label = discoveredStatus.displayName;
    const base = {
      id,
      configured,
      ...(projectedQuota ? { quota: projectedQuota } : {}),
    };
    return {
      ...base,
      label: discoveredStatus?.displayName ?? quota?.label ?? id,
      description: discoveredStatus?.description ?? '由 Wrenyard Catalog 提供的模型服务。',
      authMode,
      setupHint: discoveredStatus?.setupHint ?? (authMode === 'native'
        ? '请在对应的原生客户端完成登录，返回啾啾工坊后刷新状态。'
        : '该来源没有独立 API Key 配置入口。'),
      models: (discoveredStatus?.models ?? []).map((model) => ({
        id: model.id, displayName: model.displayName,
        ...Object.fromEntries(['contextWindow', 'maxTokens', 'taskOnly', 'effectiveTps', 'quotaState', 'quotaEvidence', 'free', 'credits', 'intelligence', 'speedSource', 'available']
          .filter((key) => model[key as keyof typeof model] !== undefined)
          .map((key) => [key, model[key as keyof typeof model]])),
        // Pricing is projected explicitly from the catalog value when present:
        // only the three USD-per-million numbers, never a default.
        ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
      })),
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

/**
 * Structured reset timing for one quota window. A reset time is passed only
 * when it parses to a future instant; an absent, invalid or already-past time
 * is dropped rather than substituted. A non-positive/unknown window length is
 * likewise omitted.
 */
function windowTiming(
  resetsAt?: string,
  windowMinutes?: number,
): Pick<QuotaWindowSnapshot, 'resetsAt' | 'windowMinutes'> {
  const resetMs = typeof resetsAt === 'string' ? Date.parse(resetsAt) : Number.NaN;
  return {
    ...(typeof resetsAt === 'string' && Number.isFinite(resetMs) && resetMs > Date.now()
      ? { resetsAt }
      : {}),
    ...(typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) && windowMinutes > 0
      ? { windowMinutes }
      : {}),
  };
}

/**
 * Full-cycle facts of one window: a reset inside its own cycle, measured from
 * now. A window without them has no pace, so the rolling bands apply.
 */
function fullCycleFacts(
  window: QuotaWindowSnapshot,
  nowMs: number,
): { resetAtMs: number; windowMs: number } | null {
  if (typeof window.resetsAt !== 'string' || typeof window.windowMinutes !== 'number') return null;
  const resetAtMs = Date.parse(window.resetsAt);
  const windowMs = window.windowMinutes * 60_000;
  if (!Number.isFinite(resetAtMs) || !(windowMs > 0)) return null;
  const horizonMs = resetAtMs - nowMs;
  if (horizonMs <= 0 || horizonMs > windowMs) return null;
  return { resetAtMs, windowMs };
}

/**
 * Per-pool state of one windowed pool, mapped by the routing quota rules
 * (`quotaStateOf`): a full-cycle window compares its remaining share with the
 * cycle pace, any other window uses the rolling 80%/10% bands, and an
 * observation older than the evidence grace is insufficient.
 */
function windowPoolState(
  window: QuotaWindowSnapshot,
  observedAtMs: number,
  nowMs: number,
): QuotaPoolState {
  const cycle = fullCycleFacts(window, nowMs);
  const evidence: QuotaEvidence = {
    remainingPercent: window.remainingPct,
    observedAtMs,
    validForMs: QUOTA_EVIDENCE_GRACE_MS,
    replenishmentKind: cycle ? 'full_cycle' : 'rolling_partial',
    ...(cycle ?? {}),
  };
  return quotaStateOf([{ id: window.name, kind: 'quota', evidence }], nowMs).state;
}

/**
 * Per-pool state of one balance: exhausted at zero, insufficient at or below
 * its currency threshold. A unit row has no threshold (zero exhausts it); an
 * explicit unlimited row is sufficient; a reported-but-absent amount is
 * insufficient, never a fabricated zero.
 */
function balancePoolState(
  balance: QuotaBalanceSnapshot,
  observedAtMs: number,
  nowMs: number,
): QuotaPoolState {
  const balanceEvidence: BalanceEvidence = {
    ...(balance.amount === null ? {} : { amount: balance.amount }),
    currency: balance.currency ?? null,
    ...(balance.unit === undefined ? {} : { unit: balance.unit }),
    ...(balance.unlimited === true ? { unlimited: true } : {}),
    observedAtMs,
    validForMs: QUOTA_EVIDENCE_GRACE_MS,
  };
  return quotaStateOf([{ id: balance.id ?? balance.currency ?? 'balance', kind: 'balance', evidence: null, balance: balanceEvidence }], nowMs).state;
}

function isQuotaUnavailable(status: QuotaProviderSnapshot['status']): boolean {
  return status === 'error' || status === 'unavailable';
}

/**
 * Retry hint the quota feature embeds in a rate-limited observation
 * (`Rate limited; retry in <n> min`); the controller owns the Chinese copy.
 */
const RATE_LIMIT_RETRY_RE = /retry in (\d+) min/;

/** Chinese copy for a rate-limited provider, retaining the retry window when present. */
function rateLimitedMessage(detail?: string | null): string {
  const minutes = typeof detail === 'string' ? detail.match(RATE_LIMIT_RETRY_RE)?.[1] : undefined;
  return minutes ? `额度接口限流，约 ${minutes} 分钟后重试。` : '额度接口限流，请稍后重试。';
}

function unavailableQuotaMessage(authMode: ProviderAuthMode, configured: boolean, code?: string, detail?: string | null): string {
  if (code === 'rate_limited') return rateLimitedMessage(detail);
  if (code === 'configuration_missing') return '尚未配置，请先完成登录或填写 API Key 后刷新。';
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
