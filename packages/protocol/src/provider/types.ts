import type { ReasoningEffort } from '@wrenyard/models'
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
  /** Route-owned reasoning levels; absent when the ladder is unknown (a route
   * naming no registered canonical model materializes no level). */
  reasoningEfforts?: readonly ReasoningEffort[]
  supportedClients?: readonly string[]
  id: string
  displayName: string
  contextWindow?: number
  maxTokens?: number
  effectiveTps?: number | null
  /** Unified quota state of this offering; absent when no quota was assessed. */
  quotaState?: 'abundant' | 'sufficient' | 'insufficient' | 'exhausted'
  /** How that state was obtained; absent when no quota was assessed. */
  quotaEvidence?: 'measured' | 'unknown_by_design' | 'not_obtained'
  free?: boolean
  /** CodeBuddy per-model credit multiplier string carried verbatim from the live
   * `/v3/config` offering (e.g. `x1.33 credits`); absent when the provider
   * declares none. A display-only multiplier, never a balance or USD price. */
  credits?: string
  taskOnly?: boolean
  /** Catalog intelligence tier for the model; absent when genuinely unknown. */
  intelligence?: 'low' | 'mid' | 'high' | 'premium'
  /** Catalog list price as [cached, input, output] USD per million tokens;
   * absent when the price is genuinely unknown (never defaulted to zero). */
  pricing?: ProviderListModelPricing
  /** Which evidence tier produced `effectiveTps`. */
  speedSource?: 'local_31d' | 'provider_override' | 'catalog_default' | 'free_supply_floor'
  /** True when a credential is configured AND the resolver admits provider/model. */
  available?: boolean
}

/** One provider entry in a `provider.list` result. */
export interface ProviderListEntry {
  quotaProvider?: string
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
  /** Explicit provider-reported account plan name; absent means unknown. */
  plan?: string
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
  /**
   * Estimated per-model USD spend inside each quota window, priced from the
   * catalog's [cached, input, output] USD-per-million tuple. Present only for
   * providers whose gateway traffic is recorded (Devin) and only for windows
   * that observed traffic; never fabricated.
   */
  estimatedSpend?: readonly ProviderEstimatedSpend[]
  /** Verified login type the provider reported for this observation; absent
   * when it reports none. Carried verbatim, never derived from quota numbers. */
  accountType?: string
  /** Verified identity provider of that login (e.g. `ioa_auth`); absent when
   * the provider reports none. */
  idp?: string
}

/** Estimated spend inside one named quota window. */
export interface ProviderEstimatedSpend {
  /** Quota window `name` this estimate covers. */
  window: string
  /** USD per public model id (e.g. `devin/swe-2`), estimated from recorded token usage. */
  models: Record<string, number>
  /** Total estimated USD across all models in the window. */
  totalUsd: number
}

/**
 * One balance row. Monetary rows carry `currency` + `amount` (uppercase
 * ISO-4217 code plus decimal string). A unit-denominated row carries a stable
 * `id`, a non-currency `unit` (e.g. `Credits`), `amount` (decimal string, or
 * `null` when the provider reported the balance slot without a value) and an
 * optional provider-declared `unlimited` flag. Currency conversion and
 * low-balance thresholds apply only to monetary rows.
 */
/**
 * The shared three-state balance availability literal union, mirroring the
 * provider-side `QuotaBalanceAvailability`. Explicit parser/provider-flag
 * classification only (ChatGPT Credits); absent on all other balance rows.
 */
export type ProviderQuotaBalanceAvailability = 'available' | 'unavailable' | 'unknown'

export interface ProviderQuotaBalance {
  /** Stable balance identity (e.g. `chatgpt/credits`); absent for monetary rows. */
  id?: string
  currency?: string
  /** Verbatim decimal-string amount; null means reported-but-unknown. */
  amount: string | null
  /** Non-currency display unit of a unit-denominated row. */
  unit?: string
  /** Provider-declared unlimited balance; never a fabricated large amount. */
  unlimited?: boolean
  /**
   * Explicit provider-flag availability classification (ChatGPT Credits only).
   * Absent on other rows.
   */
  availability?: ProviderQuotaBalanceAvailability
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

/** Params of `provider.signIn`. */
export interface ProviderSignInParams {
  provider: 'workbuddy' | 'workbuddy-ai'
  /** Explicit account switch: discard the stored WorkBuddy login and its
   * derived caches before starting a new browser login. Absent (or false)
   * keeps the existing behaviour of reporting an existing login as signed in. */
  switchAccount?: boolean
  /** Login source an explicit switch binds: re-authenticate in the browser
   * (default) or re-import the desktop native client's own login. */
  source?: 'browser' | 'desktop'
}

/** Sanitized identity of the bound WorkBuddy account. Only the classified
 * login kind and, when the login reports one, its domain — never a token,
 * uid or enterprise id. */
export interface ProviderSignInAccount {
  kind: 'ioa' | 'personal' | 'enterprise' | 'unknown'
  domain?: string
}

/** Result of `provider.signIn`. */
export interface ProviderSignInResult {
  authUrl: string
  alreadySignedIn: boolean
  /** Sanitized identity of the account bound by this sign-in. */
  account?: ProviderSignInAccount
}
