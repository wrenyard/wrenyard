import { useEffect, useState } from 'react';
import { Clock, X } from 'lucide-react';
import { formatCost, formatTokenCount } from '@/renderer/lib/format';
import type { DisplayCurrency } from '@/shell-contract';

const IDLE_LIMIT_MS = 60 * 60 * 1000;
const IDLE_TICK_MS = 60_000;

/** Dismissed latest-user timestamp per session, for the renderer's lifetime. */
const dismissedBySession = new Map<string, string | undefined>();

export interface IdleCacheNoticeProps {
  sessionKey: string;
  latestMessageAt: string | undefined;
  latestUserMessageAt: string | undefined;
  /** Existing context estimate; the notice adds no estimator of its own. */
  estimatedInputTokens: number | undefined;
  /** Catalog fresh-input USD per million tokens; omit the ≈ suffix when unknown. */
  inputUsdPerMillion: number | undefined;
  /** Global display currency (`general.displayCurrency` when persisted). */
  displayCurrency: DisplayCurrency;
}

/** Hint above the composer when the shown session has been idle for over an hour. */
export function IdleCacheNotice({
  sessionKey,
  latestMessageAt,
  latestUserMessageAt,
  estimatedInputTokens,
  inputUsdPerMillion,
  displayCurrency,
}: IdleCacheNoticeProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), IDLE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const latest = latestMessageAt === undefined ? Number.NaN : Date.parse(latestMessageAt);
  const idle = Number.isFinite(latest) && latest < Date.now() - IDLE_LIMIT_MS;
  const estimate = estimatedInputTokens !== undefined
    && Number.isFinite(estimatedInputTokens)
    && estimatedInputTokens >= 0
    ? estimatedInputTokens
    : undefined;
  // Only the shown session's entry closes it; a newer user or pending send makes
  // that session eligible again, while an assistant reply never does.
  const closed = dismissedBySession.has(sessionKey)
    && dismissedBySession.get(sessionKey) === latestUserMessageAt;

  if (!idle || estimate === undefined || closed) return null;

  const priced = inputUsdPerMillion !== undefined && Number.isFinite(inputUsdPerMillion);
  const approx = priced
    ? ` ≈ ${formatCost((estimate * inputUsdPerMillion) / 1_000_000, displayCurrency)}`
    : '';

  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {`距上次消息已超过 1 小时，推理缓存可能已过期，下次发送将按约 ${formatTokenCount(estimate)} 词元输入计费${approx}`}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-sm p-0.5 hover:text-foreground"
        aria-label="关闭提示"
        onClick={() => {
          dismissedBySession.set(sessionKey, latestUserMessageAt);
          setTick((value) => value + 1);
        }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
