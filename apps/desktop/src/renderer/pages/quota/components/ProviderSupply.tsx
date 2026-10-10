import { useId, useState, type ReactNode } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronRightIcon, GripVerticalIcon, SettingsIcon } from 'lucide-react';
import { BrandIcon } from '@/renderer/components/brand-icon';
import type { StatusTone } from '@/renderer/components/status-badge';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/renderer/components/ui/context-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/renderer/components/ui/hover-card';
import { Item, ItemGroup } from '@/renderer/components/ui/item';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { QuotaBar } from '@/renderer/components/usage/QuotaBar';
import { providerBrand } from '@/renderer/lib/model-brand';
import { cn } from 'cn';
import { reorderProviders } from '@/provider-order';
import type { ProviderCatalogSnapshot, QuotaProviderSnapshot, QuotaSnapshot } from '@/shell-contract';
import {
  ACTIVATION_NOTE,
  BALANCE_LABEL,
  MOVE_DOWN_LABEL,
  MOVE_UP_LABEL,
  NO_DATA_NOTE,
  ORDER_SAVE_ERROR_PREFIX,
  RETRY_LABEL,
  SUPPLY_EMPTY,
  SUPPLY_UNAVAILABLE,
  configureProviderLabel,
  dragHandleLabel,
  modelCountLabel,
  providerNoQuotaNote,
  providerStatusDot,
  unconfiguredTitle,
} from '../model/describe.js';

/** Status-dot colour per resolved tone (usage spec 6.5). */
const DOT_CLASS: Record<StatusTone, string> = {
  running: 'bg-muted-foreground',
  success: 'bg-success',
  danger: 'bg-destructive',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground',
};

export interface ProviderSupplyProps {
  snapshot: QuotaSnapshot;
  /** True while a provider-order save is in flight. */
  savingOrder: boolean;
  /** Error from the last reorder attempt, shown above the catalog. */
  reorderError: string;
  onReorder: (providerIds: string[]) => void;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
  /** Force-refresh the quota snapshot after a failed provider read. */
  onRetry: () => void;
}

/**
 * Provider catalog: compact configured rows (reorderable) above an
 * unconfigured disclosure. Order comes from the snapshot; the component never
 * reorders on render and only asks the page to persist a drag, keyboard move or
 * context-menu move.
 */
export function ProviderSupply({
  snapshot,
  savingOrder,
  reorderError,
  onReorder,
  onConfigure,
  onRetry,
}: ProviderSupplyProps) {
  const dndContextId = useId();

  const catalog = snapshot.catalog ?? [];
  const configured = catalog.filter((entry) => entry.configured);
  const unconfigured = catalog.filter((entry) => !entry.configured);
  const orderIds = reorderProviders(snapshot.providerOrder ?? [], catalog.map((entry) => entry.id))
    .map((entry) => entry.id);
  const configuredIds = orderIds.filter((id) => configured.some((entry) => entry.id === id));
  const configuredById = new Map(configured.map((entry) => [entry.id, entry]));
  const orderedConfigured = configuredIds
    .map((id) => configuredById.get(id))
    .filter((entry): entry is ProviderCatalogSnapshot => entry !== undefined);

  const sensors = useSensors(
    useSensor(MouseSensor, {}),
    useSensor(TouchSensor, {}),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const persistConfigured = (nextIds: string[]): void => {
    const rest = orderIds.filter((id) => !configuredIds.includes(id));
    onReorder([...nextIds, ...rest]);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    if (savingOrder) return;
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const oldIndex = configuredIds.indexOf(String(active.id));
    const newIndex = configuredIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    persistConfigured(arrayMove(configuredIds, oldIndex, newIndex));
  };

  const move = (id: string, delta: number): void => {
    if (savingOrder) return;
    const index = configuredIds.indexOf(id);
    const next = index + delta;
    if (index === -1 || next < 0 || next >= configuredIds.length) return;
    persistConfigured(arrayMove(configuredIds, index, next));
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
          {orderedConfigured.length > 0 && (
            <DndContext
              id={dndContextId}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              sensors={sensors}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={configuredIds} strategy={verticalListSortingStrategy}>
                <ItemGroup>
                  {orderedConfigured.map((entry, index) => (
                    <SortableRow
                      key={entry.id}
                      entry={entry}
                      position={index}
                      lastPosition={orderedConfigured.length - 1}
                      savingOrder={savingOrder}
                      onConfigure={onConfigure}
                      onRetry={onRetry}
                      onMove={move}
                    />
                  ))}
                </ItemGroup>
              </SortableContext>
            </DndContext>
          )}
          {unconfigured.length > 0 && (
            <UnconfiguredGroup entries={unconfigured} onConfigure={onConfigure} onRetry={onRetry} />
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

function UnconfiguredGroup({
  entries,
  onConfigure,
  onRetry,
}: {
  entries: ProviderCatalogSnapshot[];
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger className="flex w-fit cursor-pointer items-center gap-1 text-sm text-muted-foreground">
        <ChevronRightIcon className={cn('size-4 transition-transform', open && 'rotate-90')} />
        {unconfiguredTitle(entries.length)}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ItemGroup>
          {entries.map((entry) => (
            <Item key={entry.id} role="listitem" size="xs" className="flex-nowrap opacity-60">
              <RowContent entry={entry} onConfigure={onConfigure} onRetry={onRetry} />
            </Item>
          ))}
        </ItemGroup>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface SortableRowProps {
  entry: ProviderCatalogSnapshot;
  position: number;
  lastPosition: number;
  savingOrder: boolean;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
  onRetry: () => void;
  onMove: (id: string, delta: number) => void;
}

function SortableRow({
  entry,
  position,
  lastPosition,
  savingOrder,
  onConfigure,
  onRetry,
  onMove,
}: SortableRowProps) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: entry.id, disabled: savingOrder });

  return (
    <ContextMenu>
      <ContextMenuTrigger
        ref={setNodeRef}
        render={
          <Item
            role="listitem"
            size="xs"
            data-dragging={isDragging || undefined}
            style={{
              transform: CSS.Transform.toString(transform),
              transition,
            }}
            className="relative z-0 flex-nowrap data-[dragging=true]:z-10 data-[dragging=true]:opacity-80"
          />
        }
      >
        <RowContent
          entry={entry}
          onConfigure={onConfigure}
          onRetry={onRetry}
          dragHandle={
            <DragHandle
              label={entry.label || entry.id}
              savingOrder={savingOrder}
              setActivatorNodeRef={setActivatorNodeRef}
              attributes={attributes}
              listeners={listeners}
            />
          }
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={savingOrder || position <= 0}
          onClick={() => onMove(entry.id, -1)}
        >
          {MOVE_UP_LABEL}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={savingOrder || position >= lastPosition}
          onClick={() => onMove(entry.id, 1)}
        >
          {MOVE_DOWN_LABEL}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

type DragHandleProps = Pick<
  ReturnType<typeof useSortable>,
  'attributes' | 'listeners' | 'setActivatorNodeRef'
> & {
  label: string;
  savingOrder: boolean;
};

function DragHandle({
  label,
  savingOrder,
  setActivatorNodeRef,
  attributes,
  listeners,
}: DragHandleProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      ref={setActivatorNodeRef}
      disabled={savingOrder}
      {...attributes}
      {...listeners}
    >
      <GripVerticalIcon />
      <span className="sr-only">{dragHandleLabel(label)}</span>
    </Button>
  );
}

/** Single compact row body shared by configured (sortable) and unconfigured rows. */
function RowContent({
  entry,
  onConfigure,
  onRetry,
  dragHandle,
}: {
  entry: ProviderCatalogSnapshot;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
  onRetry: () => void;
  dragHandle?: ReactNode;
}) {
  const name = entry.label || entry.id;
  return (
    <>
      {entry.configured && dragHandle}
      <div className="flex w-40 shrink-0 items-center gap-2">
        <BrandIcon brand={providerBrand(entry.id)} />
        <span className="min-w-0 truncate font-medium">{name}</span>
      </div>
      {entry.quota && <ProviderStatusDot quota={entry.quota} />}
      <div className="min-w-0 flex-1">
        <QuotaContent entry={entry} onRetry={onRetry} />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ModelCount entry={entry} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={configureProviderLabel(name, entry.configured)}
          title={entry.configured ? '配置' : '激活'}
          onClick={() => onConfigure(entry)}
        >
          <SettingsIcon />
        </Button>
      </div>
    </>
  );
}

function ProviderStatusDot({ quota }: { quota: QuotaProviderSnapshot }) {
  const view = providerStatusDot(quota.status, quota.stale);
  const tooltip = quota.message ? `${view.label} · ${quota.message}` : view.label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[view.tone])} />}
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Model-count badge with a hover card listing the provider's models. */
function ModelCount({ entry }: { entry: ProviderCatalogSnapshot }) {
  const models = entry.models ?? [];
  if (models.length === 0) return null;
  return (
    <HoverCard>
      <HoverCardTrigger
        render={<Badge variant="secondary">{modelCountLabel(models.length)}</Badge>}
      />
      <HoverCardContent className="max-h-64 w-56 overflow-auto">
        <ul className="flex flex-col gap-1">
          {models.map((model) => (
            <li key={model.id} className="truncate">{model.displayName}</li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}

function QuotaContent({ entry, onRetry }: { entry: ProviderCatalogSnapshot; onRetry: () => void }) {
  if (!entry.configured) {
    return <span className="text-xs text-muted-foreground">{ACTIVATION_NOTE}</span>;
  }
  const quota = entry.quota;
  if (!quota) {
    return <span className="text-xs text-muted-foreground">{providerNoQuotaNote(entry.authMode)}</span>;
  }
  if (quota.status === 'error' || quota.status === 'unavailable') {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        <span>{quota.message ?? NO_DATA_NOTE}</span>
        <Button type="button" variant="link" size="xs" onClick={onRetry}>{RETRY_LABEL}</Button>
      </span>
    );
  }
  const windows = quota.windows;
  const balances = quota.balances;
  const hasStructured = windows.length > 0 || balances.length > 0;
  return (
    <div className="flex items-center gap-x-4">
      {windows.map((window) => (
        <QuotaBar
          key={window.name}
          name={window.name}
          remainingPct={window.remainingPct}
          expectedRemainingPct={window.expectedRemainingPct}
          resetsAt={window.resetsAt}
          windowMinutes={window.windowMinutes}
        />
      ))}
      {balances.map((balance) => (
        <span key={`${balance.currency}:${balance.display}`} className="flex items-baseline gap-1 text-xs">
          <span className="text-muted-foreground">{BALANCE_LABEL}</span>
          <strong className="tabular-nums">{balance.display}</strong>
        </span>
      ))}
      {!hasStructured && quota.message && (
        <span className="text-xs text-muted-foreground">{quota.message}</span>
      )}
      {!hasStructured && !quota.message && (
        <span className="text-xs text-destructive">{NO_DATA_NOTE}</span>
      )}
    </div>
  );
}
