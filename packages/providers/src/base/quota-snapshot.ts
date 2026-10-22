/**
 * One provider-reported balance row. Two shapes exist:
 *
 * - monetary: `{ currency, amount }` — an uppercase ISO-4217 code plus a
 *   non-negative decimal string. Currency conversion and low-balance
 *   thresholds apply only to this shape.
 * - unit-denominated: `{ id, unit, amount }` — a stable balance identity, a
 *   display unit that is not a currency (e.g. `Credits`), and the provider's
 *   verbatim decimal string. `amount: null` means the provider reported the
 *   balance slot without a value (unknown, never zero); `unlimited: true`
 *   marks an explicit provider-declared unlimited balance.
 */
export interface QuotaBalance {
  /** Stable balance identity when the provider distinguishes one (e.g.
   * `chatgpt/credits`); absent for a plain monetary row. */
  readonly id?: string;
  readonly currency?: string;
  /** Verbatim decimal-string amount; null means reported-but-unknown. */
  readonly amount: string | null;
  /** Non-currency display unit of a unit-denominated row (e.g. `Credits`). */
  readonly unit?: string;
  /** Provider-declared unlimited balance; never a fabricated large amount. */
  readonly unlimited?: boolean;
}

/** Provider-owned observation, serialized using the existing daemon quota DTO. */
export interface QuotaSnapshot {
  readonly provider: string;
  /**
   * Explicit provider-reported account plan name. Absent means the plan is
   * unknown; never inferred from quota amounts or other quota data.
   */
  readonly plan?: string;
  readonly status: 'ok' | 'error' | 'unavailable';
  readonly stale: boolean;
  readonly code?: string;
  readonly used?: number;
  readonly total?: number;
  readonly balances?: readonly QuotaBalance[];
  readonly fetched_at?: string;
  readonly source?: string;
  readonly message?: string;
  readonly error?: string;
  readonly windows?: readonly {
    readonly name: string;
    readonly pct: number;
    readonly window_minutes: number;
    readonly resets_at?: string;
  }[];
  readonly not_applicable_windows?: readonly string[];
  /**
   * Verified login type of the account this observation was read from, carried
   * verbatim from the provider's own account block. Absent when the provider
   * reports none; never derived from quota amounts.
   */
  readonly accountType?: string;
  /** Verified identity provider of that login (e.g. `ioa_auth`). Absent when
   * the provider reports none. */
  readonly idp?: string;
}
