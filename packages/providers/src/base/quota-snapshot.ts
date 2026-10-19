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
  readonly balances?: readonly { currency: string; amount: string }[];
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
}
