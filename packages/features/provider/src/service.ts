import { isCredentialFreeNativeRoute, resolveModelSpeed } from '@wrenyard/providers'
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
  /** Unified quota state of this offering: abundant > sufficient > insufficient > exhausted. */
  quotaState: 'abundant' | 'sufficient' | 'insufficient' | 'exhausted'
  /** How the state was obtained: measured, unknown by design, or not obtained. */
  quotaEvidence: 'measured' | 'unknown_by_design' | 'not_obtained'
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
const PROVIDER_LIST_CACHE_MS = 5_000

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
  /**
   * Daemon-owned reader of each WorkBuddy provider's current login type, keyed
   * by provider id (absent until a login was read). The quota cache is keyed by
   * it alongside the CodeBuddy context, so switching the WorkBuddy login type
   * can never serve the previous type's cached quota.
   */
  workBuddyAccountKinds?: () => Readonly<Record<string, string>>
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
  private readonly workBuddyAccountKinds: (() => Readonly<Record<string, string>>) | undefined
  private quotaCache?: { key: string; result: ProviderQuotaResult }
  private pending?: { key: string; refresh: boolean; promise: Promise<ProviderQuotaResult> }
  private generation = 0
  private listCache?: { key: string; result: ProviderListResult; completedAt: number }
  private listPending?: { key: string; generation: number; promise: Promise<ProviderListResult> }
  private listGeneration = 0
  constructor(options: ProviderServiceOptions) {
    this.catalog = options.catalog
    this.runtime = options.runtime
    this.modelStatus = options.modelStatus
    this.localSpeed = options.localSpeed
    this.quota = options.quota ?? new QuotaService()
    this.quotaTimeoutMs = options.quotaTimeoutMs ?? PROVIDER_QUOTA_TIMEOUT_MS
    this.workBuddyAccountKinds = options.workBuddyAccountKinds
  }

  /**
   * Business implementation of `provider.list`. Availability, credential
   * resolution, speed evidence, pricing and per-model status are preserved
   * exactly from the former daemon implementation.
   */
  async list(): Promise<ProviderListResult> {
    const localSpeed = this.localSpeed()
    const key = JSON.stringify([this.catalog.providers(), localSpeed])
    const now = Date.now()
    if (this.listCache?.key === key && now - this.listCache.completedAt < PROVIDER_LIST_CACHE_MS) {
      return this.listCache.result
    }
    if (this.listPending?.key === key) return this.listPending.promise

    const generation = this.listGeneration
    const fill = this.readList(localSpeed).then(({ result, cacheable }) => {
      if (cacheable && generation === this.listGeneration) {
        this.listCache = { key, result, completedAt: Date.now() }
      }
      return result
    }).finally(() => {
      if (this.listPending?.promise === fill) this.listPending = undefined
    })
    this.listPending = { key, generation, promise: fill }
    return fill
  }

  /** Clear provider-list state; an older fill cannot repopulate it. */
  invalidateList(): void {
    this.listGeneration += 1
    this.listCache = undefined
    this.listPending = undefined
  }

  private async readList(localSpeed: ReturnType<ProviderLocalSpeedReader>): Promise<{ result: ProviderListResult; cacheable: boolean }> {
    let modelStatus = new Map<string, ProviderModelStatus>()
    let cacheable = true
    try {
      modelStatus = await this.modelStatus()
    } catch {
      /* fail closed */
      cacheable = false
    }
    // One trailing-31-day local sample read per request, shared by every model
    // so the resolver never re-reads the event store per provider/model.
    const providers = await Promise.all(this.catalog.providers().map(async (provider) => {
      const credential = await this.runtime.credential(provider)
      const nativeConfigured = provider.credentialResolver !== 'managed'
        && provider.credentialResolver !== 'codebuddy'
        && provider.models.some((model) => modelStatus.has(`${provider.id}/${model.id}`))
      // A credential-free native route is genuinely usable with no credential of
      // any kind, but only for the exact model the shared predicate classifies
      // as explicitly free on its native client route — never from a zero price
      // or a `-free` id suffix — and only once the resolver actually admitted
      // that exact provider/model pair.
      const credentialFreeNativeConfigured = provider.models.some((model) =>
        modelStatus.has(`${provider.id}/${model.id}`)
        && isCredentialFreeNativeRoute(provider, model.id, { client: 'opencode', mode: 'native' }))
      const configured = credential !== undefined || nativeConfigured || credentialFreeNativeConfigured
      return {
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description ?? '',
        setupHint: provider.setupHint ?? '',
        configured,
        authMode: provider.credentialResolver === 'managed' ? 'api-key' as const
          : provider.credentialResolver ? 'native' as const : 'none' as const,
        protocols: (provider.protocols ?? []).map((capability) => capability.protocol),
        quotaProvider: provider.quotaProvider ?? provider.id,
        models: provider.models.map((model) => this.projectModel(provider, model, modelStatus, localSpeed, configured)),
      }
    }))
    return { result: { providers }, cacheable }
  }

  /** Business implementation of `provider.configure`. */
  async configure(params: ProviderConfigureParams): Promise<ProviderConfigureResult> {
    const provider = this.catalog.provider(params.providerId)
    if (!provider) throw new Error(`unknown provider: ${params.providerId}`)
    await this.runtime.configureApiKey(provider, params.key)
    this.invalidateList()
    this.generation += 1
    this.quotaCache = undefined
    this.pending = undefined
    return { ok: true as const }
  }

  /** Coalesce reads; explicit refresh bypasses cached and non-refresh requests. */
  async quotaSnapshot(params: ProviderQuotaParams = {}): Promise<ProviderQuotaResult> {
    if (params.forceRefresh === true) this.invalidateList()
    const context = await currentCodeBuddyContext()
    // The WorkBuddy login type joins the key: its quota source and validation
    // path are chosen by that type, so a cached result of the previous type is
    // never served after an account switch.
    const key = JSON.stringify([context?.expectedScope, context?.expectedEnvironment, this.workBuddyAccountKinds?.() ?? {}])
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
      // A route with no ladder — a model naming no registered canonical model —
      // has UNKNOWN efforts, so the DTO omits them rather than fabricating a
      // level; the row still lists. A registered route always carries its ladder.
      ...(model.reasoningEfforts.length === 0 ? {} : { reasoningEfforts: [...model.reasoningEfforts] }),
      ...(model.supportedClients === undefined ? {} : { supportedClients: model.supportedClients }),
      displayName: model.displayName,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.taskOnly === undefined ? {} : { taskOnly: model.taskOnly }),
      ...(model.free === undefined ? {} : { free: model.free }),
      // The CodeBuddy per-model credit multiplier crosses verbatim when the
      // definition carries one; a model without it omits the field entirely.
      ...(model.credits === undefined ? {} : { credits: model.credits }),
      ...(status === undefined ? {} : status),
      // A genuinely unknown speed has no evidence at all: both facts are omitted
      // together rather than reported as a zero or a dangling catalog_default source.
      ...(speed === undefined ? {} : { effectiveTps: speed.tps, speedSource: speed.source }),
      ...(model.intelligence === undefined ? {} : { intelligence: model.intelligence }),
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
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
    ...(row.plan === undefined || row.plan === '' ? {} : { plan: row.plan }),
    status: row.status,
    stale: row.stale,
    ...(row.code === undefined ? {} : { code: row.code }),
    ...(row.used === undefined ? {} : { used: row.used }),
    ...(row.total === undefined ? {} : { total: row.total }),
    ...(row.balances === undefined ? {} : {
      balances: row.balances.map((balance) => ({
        ...(balance.id === undefined ? {} : { id: balance.id }),
        ...(balance.currency === undefined ? {} : { currency: balance.currency }),
        amount: balance.amount,
        ...(balance.unit === undefined ? {} : { unit: balance.unit }),
        ...(balance.unlimited === undefined ? {} : { unlimited: balance.unlimited }),
        ...(balance.availability === undefined ? {} : { availability: balance.availability }),
      })),
    }),
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
    ...(row.accountType === undefined ? {} : { accountType: row.accountType }),
    ...(row.idp === undefined ? {} : { idp: row.idp }),
  }
}

export type { CodeBuddyQueryContext } from '@wrenyard/quota'
