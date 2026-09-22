import { resolveModelSpeed } from '@wrenyard/providers'
import type { Catalog, ProviderDefinition, ModelDefinition, LocalSpeedSample } from '@wrenyard/providers/catalog'
import type { ProviderRuntime } from '@wrenyard/providers'
import { QuotaService, currentCodeBuddyContext } from '@wrenyard/quota'
import type { CodeBuddyQueryContext } from '@wrenyard/quota'
import type {
  ProviderConfigureParams,
  ProviderConfigureResult,
  ProviderListModel,
  ProviderListResult,
  ProviderQuotaParams,
  ProviderQuotaResult,
  ProviderQuotaSnapshot,
} from '@wrenyard/protocol/provider'

/** Per-model resolver status: whether a credential admits the pair and its TPS. */
export interface ProviderModelStatus {
  effectiveTps: number | null
  quotaAbundant: boolean
}

/**
 * Daemon-owned callback the feature must NOT reimplement: it reads the current
 * resolver's admitted provider/model set (which codifies the credential state).
 * Injected rather than imported so the feature never depends on the daemon.
 */
export type ProviderModelStatusReader = () => Promise<Map<string, ProviderModelStatus>>

/**
 * Daemon-owned callback returning the trailing-31-day local speed samples
 * shared by every model in one `provider.list` request.
 */
export type ProviderLocalSpeedReader = () => readonly LocalSpeedSample[]

/** Timeout passed to each native quota operation. */
export const PROVIDER_QUOTA_TIMEOUT_MS = 30_000

/** Successful-result cache lifetime; refresh requests never read it. */
const PROVIDER_QUOTA_CACHE_MS = 60_000

export interface ProviderServiceOptions {
  catalog: Catalog
  runtime: ProviderRuntime
  /** Daemon-owned model-status reader. */
  modelStatus: ProviderModelStatusReader
  /** Daemon-owned local-speed reader. */
  localSpeed: ProviderLocalSpeedReader
  /** Quota acquisition feature; defaults to a fresh `QuotaService`. */
  quota?: QuotaService
  /** Operation timeout for a quota request in ms. Defaults to 30 000. */
  quotaTimeoutMs?: number
}

/**
 * Provider product feature.
 *
 * Owns the `provider.list` and `provider.configure` business implementations
 * (moved out of the daemon) and the IPC-only `provider.quota` acquisition. It
 * depends only on the foundational providers catalog/runtime, the protocol DTOs
 * and the quota feature; the daemon owns its dependencies and injects its
 * model-status/local-speed callbacks, so there is no import back into daemon.
 */
export class ProviderService {
  private readonly catalog: Catalog
  private readonly runtime: ProviderRuntime
  private readonly modelStatus: ProviderModelStatusReader
  private readonly localSpeed: ProviderLocalSpeedReader
  private readonly quota: QuotaService
  private readonly quotaTimeoutMs: number
  private quotaCache?: { key: string; result: ProviderQuotaResult }
  private pending?: { key: string; refresh: boolean; promise: Promise<ProviderQuotaResult> }
  private generation = 0
  constructor(options: ProviderServiceOptions) {
    this.catalog = options.catalog
    this.runtime = options.runtime
    this.modelStatus = options.modelStatus
    this.localSpeed = options.localSpeed
    this.quota = options.quota ?? new QuotaService()
    this.quotaTimeoutMs = options.quotaTimeoutMs ?? PROVIDER_QUOTA_TIMEOUT_MS
  }

  /**
   * Business implementation of `provider.list`. Availability, credential
   * resolution, speed evidence, pricing and per-model status are preserved
   * exactly from the former daemon implementation.
   */
  async list(): Promise<ProviderListResult> {
    let modelStatus = new Map<string, ProviderModelStatus>()
    try {
      modelStatus = await this.modelStatus()
    } catch {
      /* fail closed */
    }
    // One trailing-31-day local sample read per request, shared by every model
    // so the resolver never re-reads the event store per provider/model.
    const localSpeed = this.localSpeed()
    const providers = await Promise.all(this.catalog.providers().map(async (provider) => {
      const credential = await this.runtime.credential(provider)
      const nativeConfigured = provider.credentialResolver !== 'managed'
        && provider.credentialResolver !== 'codebuddy'
        && provider.models.some((model) => modelStatus.has(`${provider.id}/${model.id}`))
      const configured = credential !== undefined || nativeConfigured
      return {
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description ?? '',
        setupHint: provider.setupHint ?? '',
        configured,
        authMode: provider.credentialResolver === 'managed' ? 'api-key' as const
          : provider.credentialResolver ? 'native' as const : 'none' as const,
        protocols: (provider.protocols ?? []).map((capability) => capability.protocol),
        models: provider.models.map((model) => this.projectModel(provider, model, modelStatus, localSpeed, configured)),
      }
    }))
    return { providers }
  }

  /** Business implementation of `provider.configure`. */
  async configure(params: ProviderConfigureParams): Promise<ProviderConfigureResult> {
    const provider = this.catalog.provider(params.providerId)
    if (!provider) throw new Error(`unknown provider: ${params.providerId}`)
    await this.runtime.configureApiKey(provider, params.key)
    this.generation += 1
    this.quotaCache = undefined
    this.pending = undefined
    return { ok: true as const }
  }

  /** Coalesce reads; explicit refresh bypasses cached and non-refresh requests. */
  async quotaSnapshot(params: ProviderQuotaParams = {}): Promise<ProviderQuotaResult> {
    const context = await currentCodeBuddyContext()
    const key = JSON.stringify([context?.expectedScope, context?.expectedEnvironment])
    const refresh = params.forceRefresh === true
    if (this.pending?.key === key && (!refresh || this.pending.refresh)) return this.pending.promise
    if (!refresh && this.quotaCache?.key === key
      && Date.now() - this.quotaCache.result.fetchedAt < PROVIDER_QUOTA_CACHE_MS) {
      return this.quotaCache.result
    }
    const generation = ++this.generation
    const promise = this.acquireQuota(context, refresh).then(result => {
      if (generation === this.generation) this.quotaCache = { key, result }
      return result
    }).finally(() => {
      if (generation === this.generation) this.pending = undefined
    })
    this.pending = { key, refresh, promise }
    return promise
  }

  private async acquireQuota(context: CodeBuddyQueryContext | undefined, refresh: boolean): Promise<ProviderQuotaResult> {
    const rows = await this.quota.list(context, { timeoutMs: this.quotaTimeoutMs, refresh })
    return { providers: rows.map(toQuotaSnapshot), fetchedAt: Date.now() }
  }
  private projectModel(
    provider: ProviderDefinition,
    model: ModelDefinition,
    modelStatus: Map<string, ProviderModelStatus>,
    localSpeed: readonly LocalSpeedSample[],
    configured: boolean,
  ): ProviderListModel {
    const key = `${provider.id}/${model.id}`
    const status = modelStatus.get(key)
    // The shared resolver owns effectiveTps for every model, active or not.
    const speed = resolveModelSpeed(provider, model, localSpeed)
    return {
      id: model.id,
      displayName: model.displayName,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.taskOnly === undefined ? {} : { taskOnly: model.taskOnly }),
      ...(model.free === undefined ? {} : { free: model.free }),
      ...(status === undefined ? {} : status),
      effectiveTps: speed.tps,
      speedSource: speed.source,
      canonicalId: model.canonicalModel?.id ?? model.id,
      intelligence: model.intelligence,
      pricing: model.pricing,
      // Availability is a fact about the current credential AND the resolver's
      // admitted provider/model set; no model is hardcoded.
      available: configured && modelStatus.has(key),
    }
  }
}

/**
 * Projects the provider-owned quota observation onto the protocol DTO. The
 * shapes are structurally identical (nested `windows`/`balances` preserved);
 * the copy keeps the protocol boundary explicit and free of runtime imports.
 */
export function toQuotaSnapshot(row: ProviderQuotaSnapshot): ProviderQuotaSnapshot {
  return {
    provider: row.provider,
    status: row.status,
    stale: row.stale,
    ...(row.code === undefined ? {} : { code: row.code }),
    ...(row.used === undefined ? {} : { used: row.used }),
    ...(row.total === undefined ? {} : { total: row.total }),
    ...(row.balances === undefined ? {} : { balances: row.balances.map((balance) => ({ currency: balance.currency, amount: balance.amount })) }),
    ...(row.fetched_at === undefined ? {} : { fetched_at: row.fetched_at }),
    ...(row.source === undefined ? {} : { source: row.source }),
    ...(row.message === undefined ? {} : { message: row.message }),
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(row.windows === undefined ? {} : {
      windows: row.windows.map((window) => ({
        name: window.name,
        pct: window.pct,
        window_minutes: window.window_minutes,
        ...(window.resets_at === undefined ? {} : { resets_at: window.resets_at }),
      })),
    }),
    ...(row.not_applicable_windows === undefined ? {} : { not_applicable_windows: [...row.not_applicable_windows] }),
  }
}

export type { CodeBuddyQueryContext } from '@wrenyard/quota'
