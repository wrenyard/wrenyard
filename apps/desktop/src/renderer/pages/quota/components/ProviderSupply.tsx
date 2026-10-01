import { useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, GripVerticalIcon, SettingsIcon } from 'lucide-react';
import { BrandIcon } from '@/renderer/components/brand-icon';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemHeader,
  ItemTitle,
} from '@/renderer/components/ui/item';
import { Progress, ProgressLabel, ProgressValue } from '@/renderer/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { providerBrand } from '@/renderer/lib/model-brand';
import { cn } from 'cn';
import { reorderProviders } from '@/provider-order';
import type { ProviderCatalogSnapshot, QuotaProviderSnapshot, QuotaSnapshot } from '@/shell-contract';
import {
  ACTIVATION_NOTE,
  MOVE_DOWN_LABEL,
  MOVE_UP_LABEL,
  NO_DATA_NOTE,
  ORDER_SAVE_ERROR_PREFIX,
  STALE_LABEL,
  SUPPLY_EMPTY,
  SUPPLY_UNAVAILABLE,
  UNCONFIGURED_TITLE,
  configureProviderLabel,
  dragHandleLabel,
  providerNoQuotaNote,
  quotaStatusView,
  windowExpectedTooltip,
} from '../model/describe.js';

export interface ProviderSupplyProps {
  snapshot: QuotaSnapshot;
  /** True while a provider-order save is in flight. */
  savingOrder: boolean;
  /** Error from the last reorder attempt, shown above the catalog. */
  reorderError: string;
  onReorder: (providerIds: string[]) => void;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
}

interface DropTarget {
  id: string;
  before: boolean;
}

/**
 * Provider catalog: configured rows (reorderable) above an unconfigured
 * disclosure. Order comes from the snapshot; the component never reorders on
 * render and only asks the page to persist an explicit drag or move action.
 */
export function ProviderSupply({
  snapshot,
  savingOrder,
  reorderError,
  onReorder,
  onConfigure,
}: ProviderSupplyProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const catalog = snapshot.catalog ?? [];
  const configured = catalog.filter((entry) => entry.configured);
  const unconfigured = catalog.filter((entry) => !entry.configured);
  const orderIds = reorderProviders(snapshot.providerOrder ?? [], catalog.map((entry) => entry.id))
    .map((entry) => entry.id);
  const configuredIds = orderIds.filter((id) => configured.some((entry) => entry.id === id));

  const commitDrop = (sourceId: string, targetId: string, before: boolean): void => {
    if (savingOrder || sourceId === targetId) return;
    const ids = orderIds.filter((id) => id !== sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex === -1) return;
    ids.splice(before ? targetIndex : targetIndex + 1, 0, sourceId);
    onReorder(ids);
  };

  const move = (id: string, delta: number): void => {
    if (savingOrder) return;
    const index = configuredIds.indexOf(id);
    const next = index + delta;
    if (index === -1 || next < 0 || next >= configuredIds.length) return;
    const swapped = [...configuredIds];
    [swapped[index], swapped[next]] = [swapped[next], swapped[index]];
    const rest = orderIds.filter((candidate) => !configuredIds.includes(candidate));
    onReorder([...swapped, ...rest]);
  };

  const renderRow = (entry: ProviderCatalogSnapshot) => {
    const configuredRow = entry.configured;
    const dragActive = dragId === entry.id;
    const drop = dropTarget?.id === entry.id ? dropTarget : null;
    const position = configuredIds.indexOf(entry.id);
    return (
      <Item
        key={entry.id}
        role="listitem"
        variant="outline"
       
        className={cn(
          'flex-col items-stretch gap-2',
          dragActive && 'opacity-60',
          drop?.before && 'border-t-primary',
          drop && !drop.before && 'border-b-primary',
        )}
        onDragOver={(event) => {
          if (!dragId || dragId === entry.id || savingOrder) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setDropTarget({ id: entry.id, before: event.clientY < rect.top + rect.height / 2 });
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(event) => {
          event.preventDefault();
          const sourceId = dragId ?? event.dataTransfer.getData('text/plain');
          const before = dropTarget?.before ?? true;
          setDropTarget(null);
          setDragId(null);
          commitDrop(sourceId, entry.id, before);
        }}
      >
        <ItemHeader>
          <div className="flex min-w-0 items-center gap-2">
            {configuredRow && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={dragHandleLabel(entry.label)}
                title="拖动调整顺序"
                draggable
                className="text-muted-foreground cursor-grab active:cursor-grabbing"
                onDragStart={(event) => {
                  setDragId(entry.id);
                  event.dataTransfer.setData('text/plain', entry.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropTarget(null);
                }}
              >
                <GripVerticalIcon />
              </Button>
            )}
            <BrandIcon brand={providerBrand(entry.id)} />
            <ItemTitle>{entry.label || entry.id}</ItemTitle>
            {entry.quota && <StatusBadge {...quotaStatusView(entry.quota.status)} />}
            {entry.quota?.stale === true && <Badge variant="outline">{STALE_LABEL}</Badge>}
          </div>
          <ItemActions>
            {configuredRow && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={MOVE_UP_LABEL}
                  title={MOVE_UP_LABEL}
                  disabled={savingOrder || position <= 0}
                  onClick={() => move(entry.id, -1)}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={MOVE_DOWN_LABEL}
                  title={MOVE_DOWN_LABEL}
                  disabled={savingOrder || position === -1 || position >= configuredIds.length - 1}
                  onClick={() => move(entry.id, 1)}
                >
                  <ChevronDownIcon />
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={configureProviderLabel(entry.label || entry.id, entry.configured)}
              title={entry.configured ? '配置' : '激活'}
              onClick={() => onConfigure(entry)}
            >
              <SettingsIcon />
            </Button>
          </ItemActions>
        </ItemHeader>
        <ItemContent>
          {(entry.models ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {(entry.models ?? []).map((model) => (
                <Badge key={model.id} variant="outline">{model.displayName}</Badge>
              ))}
            </div>
          )}
          <QuotaContent entry={entry} />
        </ItemContent>
      </Item>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {reorderError !== '' && (
        <p className="text-destructive" role="alert">{`${ORDER_SAVE_ERROR_PREFIX}${reorderError}`}</p>
      )}
      {catalog.length === 0 ? (
        <p className="text-muted-foreground">{SUPPLY_EMPTY_TEXT(snapshot)}</p>
      ) : (
        <>
          <div role="list" className="flex flex-col gap-3">{configured.map(renderRow)}</div>
          {unconfigured.length > 0 && (
            <details className="flex flex-col gap-2" open>
              <summary className="text-muted-foreground cursor-pointer">{UNCONFIGURED_TITLE}</summary>
              <div role="list" className="mt-2 flex flex-col gap-3">{unconfigured.map(renderRow)}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Snapshot-level empty copy: an unavailable snapshot reads differently from an empty catalog. */
function SUPPLY_EMPTY_TEXT(snapshot: QuotaSnapshot): string {
  return snapshot.status === 'available' ? SUPPLY_EMPTY : SUPPLY_UNAVAILABLE;
}

function QuotaContent({ entry }: { entry: ProviderCatalogSnapshot }) {
  if (!entry.configured) {
    return <p className="text-muted-foreground">{ACTIVATION_NOTE}</p>;
  }
  const quota = entry.quota;
  if (!quota) {
    return <p className="text-muted-foreground">{providerNoQuotaNote(entry.authMode)}</p>;
  }
  const windows = quota.windows;
  const balances = quota.balances;
  const hasStructured = windows.length > 0 || balances.length > 0;
  return (
    <div className="flex flex-col gap-2">
      {windows.map((window) => (
        <QuotaWindow key={window.name} provider={entry} window={window} />
      ))}
      {balances.map((balance) => (
        <div key={`${balance.currency}:${balance.display}`} className="flex items-baseline justify-between">
          <span className="text-muted-foreground">{balance.currency}</span>
          <strong className="tabular-nums">{balance.display}</strong>
        </div>
      ))}
      {quota.message && (
        <p className={quota.status === 'ok' ? 'text-muted-foreground' : 'text-destructive'}>{quota.message}</p>
      )}
      {quota.displayLine && <p className="text-muted-foreground">{quota.displayLine}</p>}
      {!quota.displayLine && !hasStructured && !quota.message && (
        <p className="text-destructive">{NO_DATA_NOTE}</p>
      )}
    </div>
  );
}

function QuotaWindow({ provider, window }: { provider: ProviderCatalogSnapshot; window: QuotaProviderSnapshot['windows'][number] }) {
  const label = `${provider.label || provider.id} ${window.name}`;
  return (
    <Progress value={window.remainingPct}>
      <ProgressLabel>
        {window.expectedRemainingPct === null ? (
          label
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span>{label}</span>} />
            <TooltipContent>{windowExpectedTooltip(window.expectedRemainingPct)}</TooltipContent>
          </Tooltip>
        )}
      </ProgressLabel>
      <ProgressValue>{(_, value) => `${Math.floor(value ?? 0)}%`}</ProgressValue>
    </Progress>
  );
}
