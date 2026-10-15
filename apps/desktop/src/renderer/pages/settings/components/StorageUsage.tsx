import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { QueryError } from '@/renderer/components/query-error';
import { Button } from '@/renderer/components/ui/button';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { shell } from '@/renderer/lib/desktop';
import { formatDateTime } from '@/renderer/lib/format';
import {
  STORAGE_CATEGORY_DOT_CLASS,
  STORAGE_CATEGORY_LABELS,
  STORAGE_CATEGORY_UNREADABLE_SUFFIX,
  STORAGE_DEVICE_NOTE,
  STORAGE_DEVICE_PREFIX,
  STORAGE_FAILED_PREFIX,
  STORAGE_REFRESH_FAILED_PREFIX,
  STORAGE_REFRESH_LABEL,
  STORAGE_ROOT_CONFIG_LABEL,
  STORAGE_ROOT_STATE_LABEL,
  STORAGE_SCANNED_AT_PREFIX,
  STORAGE_SCANNING_LABEL,
  STORAGE_SCAN_STATUS,
  STORAGE_SCOPE_NOTE,
  STORAGE_TOTAL_PREFIX,
  STORAGE_UNAVAILABLE_TITLE,
  STORAGE_UNREADABLE_NOTE_PREFIX,
  STORAGE_UNREADABLE_NOTE_SUFFIX,
  storagePlatformLabel,
} from '../model/describe.js';
import { errorMessage } from '../model/settings.js';
import { storageUsageQueryKey, useStorageUsageQuery } from '../queries.js';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Apparent size, 1024-based with one decimal; `undefined` is never faked as 0. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${BYTE_UNITS[0]}`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

export interface StorageUsageProps {
  /** True while the 存储 category is the visible settings page. */
  active: boolean;
}

/**
 * Read-only WY data-directory usage (Codex Storage parity, but observation
 * only): the reporting device, the total with a refresh action, a stacked ratio
 * bar, a wrapping legend, the resolved data directories, the scan status and the
 * unreadable/scope notes. It never manages, cleans or deletes anything, and a
 * value that has not resolved is never rendered as a fake zero.
 */
export function StorageUsage({ active }: StorageUsageProps) {
  const queryClient = useQueryClient();
  const query = useStorageUsageQuery(active);
  const refresh = useMutation({
    mutationFn: () => shell.getStorageUsage(true),
    onSuccess: (next) => {
      queryClient.setQueryData(storageUsageQueryKey, next);
    },
  });

  const snapshot = query.data ?? null;
  const result = snapshot?.result ?? null;
  const scanning = snapshot?.status === 'scanning' || refresh.isPending;
  const failure = snapshot !== null && snapshot.status === 'failed' ? snapshot.error ?? '' : null;
  const scannedAt = snapshot?.scannedAt;
  const total = result?.totalBytes ?? 0;
  // Zero-byte categories are omitted from the ratio bar (but kept in the legend).
  const barCategories = useMemo(
    () => (result?.categories ?? []).filter((category) => category.bytes > 0),
    [result],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* (1) Reporting device and platform. */}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          {STORAGE_DEVICE_PREFIX}
          <span className="break-all text-foreground">{snapshot?.device.hostname ?? '—'}</span>
          {snapshot !== null && (
            <span className="ml-2 whitespace-nowrap rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {storagePlatformLabel(snapshot.device.platform)}
            </span>
          )}
        </p>
        <p className="text-sm text-muted-foreground">{STORAGE_DEVICE_NOTE}</p>
      </div>

      {query.isError && snapshot === null && (
        <QueryError query={query} title={STORAGE_UNAVAILABLE_TITLE} />
      )}

      {/* (2) Total and the refresh action. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <span className="text-base font-semibold">
          {STORAGE_TOTAL_PREFIX}{' '}
          {result === null
            ? (scanning || query.isPending
              ? <Skeleton className="inline-block h-5 w-24 align-middle" />
              : '—')
            : formatBytes(total)}
        </span>
        <Button
          variant="outline"
          className="shrink-0"
          disabled={scanning}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw />
          {scanning ? STORAGE_SCANNING_LABEL : STORAGE_REFRESH_LABEL}
        </Button>
      </div>

      {refresh.isError && (
        <p role="alert" className="text-sm text-destructive">
          {`${STORAGE_REFRESH_FAILED_PREFIX}${errorMessage(refresh.error)}`}
        </p>
      )}

      {/* (3) Stacked ratio bar; an empty bar stays muted when nothing is counted. */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {total > 0 && barCategories.map((category) => (
          <span
            key={category.id}
            className={cn('h-full min-w-1', STORAGE_CATEGORY_DOT_CLASS[category.id])}
            style={{ width: `${(category.bytes / total) * 100}%` }}
          />
        ))}
      </div>

      {/* (4) Legend; wraps automatically on narrow windows. */}
      {result !== null && result.categories.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {result.categories.map((category) => (
            <div key={category.id} className="flex min-w-0 items-start gap-2">
              <span
                className={cn('mt-1 size-2.5 shrink-0 rounded-full', STORAGE_CATEGORY_DOT_CLASS[category.id])}
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-col">
                <span className="text-sm">{STORAGE_CATEGORY_LABELS[category.id]}</span>
                <span className="text-xs text-muted-foreground">
                  {formatBytes(category.bytes)}
                  {category.unreadable > 0 && ` · ${category.unreadable}${STORAGE_CATEGORY_UNREADABLE_SUFFIX}`}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* (5) Resolved data directories on the reporting device. */}
      {snapshot !== null && snapshot.roots.length > 0 && (
        <div className="flex flex-col gap-2">
          {snapshot.roots.map((root) => (
            <div key={`${root.kind}:${root.path}`} className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                {root.kind === 'state' ? STORAGE_ROOT_STATE_LABEL : STORAGE_ROOT_CONFIG_LABEL}
              </span>
              <code className="select-text break-all text-xs text-muted-foreground">{root.path}</code>
            </div>
          ))}
        </div>
      )}

      {/* (6) Scan status; a failed re-scan still shows the retained result time. */}
      <div className="flex flex-col gap-1">
        {scanning && <p className="text-sm text-muted-foreground">{STORAGE_SCAN_STATUS}</p>}
        {!scanning && failure !== null && (
          <p role="alert" className="text-sm text-destructive">
            {`${STORAGE_FAILED_PREFIX}${failure}`}
          </p>
        )}
        {!scanning && scannedAt !== undefined && (
          <p className="text-sm text-muted-foreground">
            {`${STORAGE_SCANNED_AT_PREFIX}${formatDateTime(scannedAt)}`}
          </p>
        )}
      </div>

      {/* (7) Unreadable entries are reported, never silently dropped. */}
      {result !== null && result.unreadable > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            {`${STORAGE_UNREADABLE_NOTE_PREFIX}${result.unreadable}${STORAGE_UNREADABLE_NOTE_SUFFIX}`}
          </p>
          {result.unreadableSamples.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {result.unreadableSamples.map((sample) => (
                <li key={sample} className="select-text break-all text-xs text-muted-foreground">{sample}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* (8) Scope note. */}
      <p className="text-xs text-muted-foreground">{STORAGE_SCOPE_NOTE}</p>
    </div>
  );
}
