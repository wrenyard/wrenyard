import { useId, type CSSProperties, type ReactNode } from 'react';
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
          <DndContext
            id={dndContextId}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            sensors={sensors}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={configuredIds} strategy={verticalListSortingStrategy}>
              <div role="list" className="flex flex-col gap-3">
                {orderedConfigured.map((entry, index) => (
                  <SortableRow
                    key={entry.id}
                    entry={entry}
                    position={index}
                    lastPosition={orderedConfigured.length - 1}
                    savingOrder={savingOrder}
                    onConfigure={onConfigure}
                    onMove={move}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {unconfigured.length > 0 && (
            <details className="flex flex-col gap-2" open>
              <summary className="text-muted-foreground cursor-pointer">{UNCONFIGURED_TITLE}</summary>
              <div role="list" className="mt-2 flex flex-col gap-3">
                {unconfigured.map((entry) => (
                  <ProviderRow
                    key={entry.id}
                    entry={entry}
                    position={-1}
                    lastPosition={configuredIds.length - 1}
                    savingOrder={savingOrder}
                    onConfigure={onConfigure}
                    onMove={move}
                  />
                ))}
              </div>
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

interface ProviderRowProps {
  entry: ProviderCatalogSnapshot;
  position: number;
  lastPosition: number;
  savingOrder: boolean;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
  onMove: (id: string, delta: number) => void;
  itemRef?: (node: HTMLElement | null) => void;
  itemStyle?: CSSProperties;
  isDragging?: boolean;
  dragHandle?: ReactNode;
}

function ProviderRow({
  entry,
  position,
  lastPosition,
  savingOrder,
  onConfigure,
  onMove,
  itemRef,
  itemStyle,
  isDragging,
  dragHandle,
}: ProviderRowProps) {
  const configuredRow = entry.configured;
  return (
    <Item
      ref={itemRef}
      role="listitem"
      variant="outline"
      data-dragging={isDragging || undefined}
      style={itemStyle}
      className={cn(
        'flex-col items-stretch gap-2',
        configuredRow && 'relative z-0 data-[dragging=true]:z-10 data-[dragging=true]:opacity-80',
      )}
    >
      <ItemHeader>
        <div className="flex min-w-0 items-center gap-2">
          {configuredRow && dragHandle}
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
                onClick={() => onMove(entry.id, -1)}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={MOVE_DOWN_LABEL}
                title={MOVE_DOWN_LABEL}
                disabled={savingOrder || position === -1 || position >= lastPosition}
                onClick={() => onMove(entry.id, 1)}
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
}

interface SortableRowProps {
  entry: ProviderCatalogSnapshot;
  position: number;
  lastPosition: number;
  savingOrder: boolean;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
  onMove: (id: string, delta: number) => void;
}

function SortableRow({
  entry,
  position,
  lastPosition,
  savingOrder,
  onConfigure,
  onMove,
}: SortableRowProps) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: entry.id, disabled: savingOrder });

  return (
    <ProviderRow
      entry={entry}
      position={position}
      lastPosition={lastPosition}
      savingOrder={savingOrder}
      onConfigure={onConfigure}
      onMove={onMove}
      itemRef={setNodeRef}
      itemStyle={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      isDragging={isDragging}
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
