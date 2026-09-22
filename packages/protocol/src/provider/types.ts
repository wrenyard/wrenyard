/**
 * Provider feature wire DTOs.
 *
 * These are declared independently of any runtime package: the shapes are
 * structural and describe exactly what crosses the IPC boundary. There is no
 * import from `@wrenyard/providers` (or any other runtime package) here.
 *
 * `ProviderQuotaSnapshot` structurally preserves the provider-owned
 * `QuotaSnapshot` observation (`packages/providers/src/base/quota-snapshot.ts`),
 * including the nested `windows` and `balances` shapes, so a provider adapter
 * observation can cross the wire unchanged.
 */

/** USD per million tokens: [cached, input, output]. */
export type ProviderListModelPricing = readonly [number, number, number]

/** One model advertised by a configured provider. */
export interface ProviderListModel {
  id: string
  displayName: string
  contextWindow?: number
  maxTokens?: number
  effectiveTps?: number | null
  quotaAbundant?: boolean
  free?: boolean
  taskOnly?: boolean
  /** Provider-independent canonical model id; falls back to the model id. */
  canonicalId?: string
  /** Catalog intelligence tier for the model. */
  intelligence?: 'low' | 'mid' | 'high' | 'premium'
  /** Catalog list price as [cached, input, output] USD per million tokens. */
  pricing: ProviderListModelPricing
  /** Which evidence tier produced `effectiveTps`. */
  speedSource?: 'local_31d' | 'provider_override' | 'catalog_default'
  /** True when a credential is configured AND the resolver admits provider/model. */
  available?: boolean
}

/** One provider entry in a `provider.list` result. */
export interface ProviderListEntry {
  id: string
  displayName: string
  description: string
  setupHint: string
  configured: boolean
  authMode: 'api-key' | 'native' | 'none'
  protocols: Array<'openai_chat' | 'openai_responses' | 'anthropic_messages'>
  models: ProviderListModel[]
}

/** Params of `provider.list` (empty object). */
export interface ProviderListParams {}

/** Result of `provider.list`. */
export interface ProviderListResult {
  providers: ProviderListEntry[]
}

/** Params of `provider.configure`. */
export interface ProviderConfigureParams {
  providerId: string
  key: string
}

/** Result of `provider.configure`. */
export interface ProviderConfigureResult {
  ok: true
}

/** Params of `provider.quota`. */
export interface ProviderQuotaParams {
  /** Request a real account refresh where the provider/native client supports it. */
  forceRefresh?: boolean
}

/** One provider quota observation; structurally mirrors the provider-owned shape. */
export interface ProviderQuotaSnapshot {
  provider: string
  status: 'ok' | 'error' | 'unavailable'
  stale: boolean
  code?: string
  used?: number
  total?: number
  balances?: readonly ProviderQuotaBalance[]
  fetched_at?: string
  source?: string
  message?: string
  error?: string
  windows?: readonly ProviderQuotaWindow[]
  not_applicable_windows?: readonly string[]
}

/** One monetary balance row. */
export interface ProviderQuotaBalance {
  currency: string
  amount: string
}

/** One usage window row. */
export interface ProviderQuotaWindow {
  name: string
  pct: number
  window_minutes: number
  resets_at?: string
}

/** Result of `provider.quota`. */
export interface ProviderQuotaResult {
  providers: ProviderQuotaSnapshot[]
  /** Epoch milliseconds the snapshot set was produced. */
  fetchedAt: number
}
