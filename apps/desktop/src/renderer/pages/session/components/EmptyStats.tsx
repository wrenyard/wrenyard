import { dateGroupOf, formatCount, formatTokenCount } from '@/renderer/lib/format';
import { useQuotaQuery, useSessionListQuery } from '@/renderer/lib/queries';
import { selectWindow } from '@/renderer/pages/stats/model/stats';
import { useStatsQuery } from '@/renderer/pages/stats/queries';
import { eligibleQuotaProviders } from '@/shell-contract';

interface StatCell {
  label: string;
  value: string;
  note?: string;
}

/** One compact figure: muted label, tabular value, optional one-line note. */
function Cell({ label, value, note, compact }: StatCell & { compact: boolean }) {
  return (
    <div
      className={compact
        ? 'flex flex-col gap-0.5 rounded-lg border bg-card/50 px-2.5 py-2'
        : 'flex flex-col gap-1 rounded-lg border bg-card/50 px-3 py-2.5'}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={compact ? 'text-base font-semibold tabular-nums' : 'text-xl font-semibold tabular-nums'}>
        {value}
      </span>
      {note !== undefined && !compact && (
        <span className="truncate text-xs text-muted-foreground">{note}</span>
      )}
    </div>
  );
}

/**
 * Key figures for the blank new-chat page: conversations started today, tasks
 * dispatched today, tokens spent today with their average speed, and the number
 * of usable providers. Every value comes from data the renderer already loads;
 * a figure whose source has not loaded (or reports itself unavailable) shows an
 * em dash instead of hiding the grid.
 */
export function EmptyStats({ compact = false }: { compact?: boolean }) {
  const sessions = useSessionListQuery();
  const stats = useStatsQuery();
  const quota = useQuotaQuery();

  const now = Date.now();
  const sessionsToday = sessions.data === undefined
    ? '—'
    : formatCount(sessions.data.filter((session) => !session.archived && dateGroupOf(session.createdAt, now) === '今天').length);

  const snapshot = stats.data !== undefined && stats.data.status === 'available' ? stats.data : undefined;
  const today = snapshot?.today ?? null;
  const dispatchValue = today === null ? '—' : formatCount(today.dispatchCount);
  const dispatchNote = today?.outcomes ? `完成 ${formatCount(today.outcomes.done)}` : undefined;

  const tokenValue = today === null ? '—' : formatTokenCount(today.totalTokens);
  const window = snapshot === undefined ? undefined : selectWindow(snapshot, '24h');
  const tpsRows = (window?.byProfile ?? []).filter((row) => typeof row.averageTps === 'number');
  const tpsWeight = tpsRows.reduce((sum, row) => sum + row.runCount, 0);
  const tokenNote = tpsWeight > 0
    ? `均速 ${Math.round(tpsRows.reduce((sum, row) => sum + (row.averageTps ?? 0) * row.runCount, 0) / tpsWeight)} TPS`
    : undefined;

  const quotaData = quota.data;
  const providersValue = quotaData !== undefined && quotaData.status === 'available'
    ? formatCount(eligibleQuotaProviders(quotaData).length)
    : '—';

  const cells: StatCell[] = [
    { label: '今日会话', value: sessionsToday },
    { label: '今日调度', value: dispatchValue, note: dispatchNote },
    { label: '今日 Token', value: tokenValue, note: tokenNote },
    { label: '可用提供者', value: providersValue },
  ];

  return (
    <div className={compact ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-4 gap-3'}>
      {cells.map((cell) => (
        <Cell key={cell.label} label={cell.label} value={cell.value} note={cell.note} compact={compact} />
      ))}
    </div>
  );
}
