/**
 * Shared balance row: label-left `余额`, right-aligned amount in tabular
 * numbers on a fixed h-6 row. Used by the provider block, the supplier card,
 * and the quota tips so every balance renders identically. It never renders a
 * state word; the amount arrives already formatted.
 */

export interface QuotaBalanceRowProps {
  amount: string;
  label?: string;
}

export function QuotaBalanceRow({ amount, label = '余额' }: QuotaBalanceRowProps) {
  return (
    <div className="flex h-6 items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 text-right tabular-nums">{amount}</span>
    </div>
  );
}
