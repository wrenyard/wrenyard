import type { QuotaProviderState } from '@wrenyard/pet/runtime';
import type {
  QuotaBalanceSnapshot,
  QuotaProviderSnapshot,
  QuotaSnapshot,
  QuotaWindowSnapshot,
} from './shell-contract.js';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

export interface QuotaProviderSource {
  listProviders(forceRefresh?: boolean): Promise<QuotaProviderState[]>;
}

export interface DesktopQuotaControllerOptions {
  source: QuotaProviderSource;
  getProviderOrder(): Array<{ id: string; enabled: boolean }>;
  onChanged?(snapshot: QuotaSnapshot, providers: QuotaProviderState[]): void;
  refreshIntervalMs?: number;
}

/** Desktop-owned quota lifecycle shared by the app page, tray and passive Pet. */
export class DesktopQuotaController {
  private providers: QuotaProviderState[] = [];
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
    );
  }

  async getSnapshot(forceRefresh = false): Promise<QuotaSnapshot> {
    if (forceRefresh || this.refreshedAt === undefined) return this.refresh(forceRefresh);
    return this.snapshot();
  }

  notifyConfigurationChanged(): QuotaSnapshot {
    const snapshot = this.snapshot();
    this.options.onChanged?.(snapshot, cloneProviders(this.providers));
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
      this.providers = cloneProviders(await this.options.source.listProviders(forceRefresh));
      this.refreshedAt = Date.now();
      this.message = this.providers.length > 0 ? undefined : '暂时无法读取额度数据，请稍后刷新。';
    } catch (error) {
      this.providers = [];
      this.refreshedAt = Date.now();
      this.message = sanitizeQuotaText(error instanceof Error ? error.message : String(error));
    }
    const snapshot = this.snapshot();
    this.options.onChanged?.(snapshot, cloneProviders(this.providers));
    return snapshot;
  }
}

export function projectQuotaSnapshot(
  providers: QuotaProviderState[],
  configuredOrder: Array<{ id: string; enabled: boolean }>,
  refreshedAt?: number,
  message?: string,
): QuotaSnapshot {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const order = configuredOrder.filter((entry) => {
    if (!entry.enabled || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  const projected = order.map((entry) => projectProvider(entry.id, byId.get(entry.id)));
  return {
    status: providers.length > 0 || order.length === 0 ? 'available' : 'unavailable',
    providers: projected,
    ...(refreshedAt !== undefined ? { refreshedAt } : {}),
    ...(message ? { message: sanitizeQuotaText(message) } : {}),
  };
}

function projectProvider(id: string, provider: QuotaProviderState | undefined): QuotaProviderSnapshot {
  if (!provider) {
    return {
      id,
      label: id,
      status: 'unavailable',
      stale: false,
      windows: [],
      balances: [],
      message: '当前额度结果中没有这个来源。',
    };
  }
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
  return {
    id,
    label: sanitizeQuotaText(provider.label || id),
    status: provider.status,
    stale: provider.stale,
    windows,
    balances,
    ...(provider.displayLine ? { displayLine: sanitizeQuotaText(provider.displayLine) } : {}),
    ...(provider.error ? { message: sanitizeQuotaText(provider.error) } : {}),
  };
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

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function sanitizeQuotaText(value: string): string {
  const normalized = value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 219)}…`;
}
