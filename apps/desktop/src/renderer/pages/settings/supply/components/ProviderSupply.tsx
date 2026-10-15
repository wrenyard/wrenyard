import { useId, type ReactNode } from 'react';
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
import { GripVerticalIcon } from 'lucide-react';
import { BrandIcon } from '@/renderer/components/brand-icon';
import type { StatusTone } from '@/renderer/components/status-badge';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/renderer/components/ui/context-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/renderer/components/ui/hover-card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { providerBrand } from '@/renderer/lib/model-brand';
import { cn } from 'cn';
import { reorderProviders } from '@/provider-order';
import type { ProviderCatalogSnapshot, QuotaProviderSnapshot, QuotaSnapshot } from '@/shell-contract';
import {
  ACTIVATION_NOTE,
  MOVE_DOWN_LABEL,
  MOVE_UP_LABEL,
  ORDER_SAVE_ERROR_PREFIX,
  SUPPLY_EMPTY,
  SUPPLY_UNAVAILABLE,
  configureProviderLabel,
  dragHandleLabel,
  modelCountLabel,
  providerStatusDot,
} from '../model/describe.js';

/** Status-dot colour per resolved tone (usage spec 6.5). */
const DOT_CLASS: Record<StatusTone, string> = {
  running: 'bg-muted-foreground',
  success: 'bg-success',
  danger: 'bg-destructive',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground',
};

const ACTIVATED_EMPTY = '还没有已激活的供应商。';
const UNCONFIGURED_EMPTY = '所有供应商都已激活。';

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
 * Provider catalog for the settings 供应商 page: an 已激活 card of reorderable
 * rows above an always-visible 未配置 card. Order comes from the snapshot; the
 * component never reorders on render and only asks the page to persist a drag,
 * keyboard move or context-menu move. Quota and balance detail lives on the
 * 用量 page, so nothing here renders a bar.
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

  if (catalog.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {reorderError !== '' && (
          <p className="text-sm text-destructive" role="alert">{`${ORDER_SAVE_ERROR_PREFIX}${reorderError}`}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {snapshot.status === 'available' ? SUPPLY_EMPTY : SUPPLY_UNAVAILABLE}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {reorderError !== '' && (
        <p className="text-sm text-destructive" role="alert">{`${ORDER_SAVE_ERROR_PREFIX}${reorderError}`}</p>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">已激活</h3>
        <div className="overflow-hidden rounded-xl border bg-card">
          {orderedConfigured.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{ACTIVATED_EMPTY}</p>
          ) : (
            <DndContext
              id={dndContextId}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              sensors={sensors}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={configuredIds} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col divide-y">
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
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">未配置</h3>
        <div className="overflow-hidden rounded-xl border bg-card">
          {unconfigured.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{UNCONFIGURED_EMPTY}</p>
          ) : (
            <div className="flex flex-col divide-y">
              {unconfigured.map((entry) => (
                <UnconfiguredRow key={entry.id} entry={entry} onConfigure={onConfigure} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
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
    <ContextMenu>
      <ContextMenuTrigger
        ref={setNodeRef}
        render={
          <div
            role="listitem"
            data-dragging={isDragging || undefined}
            style={{
              transform: CSS.Transform.toString(transform),
              transition,
            }}
            className="relative z-0 bg-card data-[dragging=true]:z-10 data-[dragging=true]:opacity-80"
          />
        }
      >
        <ActivatedRowBody
          entry={entry}
          onConfigure={onConfigure}
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

/** One activated-provider row: drag handle, brand, name, status, models, 配置. */
function ActivatedRowBody({
  entry,
  onConfigure,
  dragHandle,
}: {
  entry: ProviderCatalogSnapshot;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
  dragHandle?: ReactNode;
}) {
  const name = entry.label || entry.id;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {dragHandle}
      <BrandIcon brand={providerBrand(entry.id)} />
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      {entry.quota !== undefined && <ProviderStatus quota={entry.quota} />}
      <ModelCount entry={entry} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={configureProviderLabel(name, entry.configured)}
        onClick={() => onConfigure(entry)}
      >
        配置
      </Button>
    </div>
  );
}

/** One unconfigured-provider row: brand, name, activation hint, 激活 button. */
function UnconfiguredRow({
  entry,
  onConfigure,
}: {
  entry: ProviderCatalogSnapshot;
  onConfigure: (entry: ProviderCatalogSnapshot) => void;
}) {
  const name = entry.label || entry.id;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <BrandIcon brand={providerBrand(entry.id)} />
      <span className="min-w-0 shrink-0 truncate font-medium">{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{ACTIVATION_NOTE}</span>
      <Button
        type="button"
        size="sm"
        aria-label={configureProviderLabel(name, false)}
        onClick={() => onConfigure(entry)}
      >
        激活
      </Button>
    </div>
  );
}

/** Status dot plus its label for one activated provider. */
function ProviderStatus({ quota }: { quota: QuotaProviderSnapshot }) {
  const view = providerStatusDot(quota.status, quota.stale);
  const tooltip = quota.message ? `${view.label} · ${quota.message}` : view.label;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger
          render={<span className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[view.tone])} />}
        />
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      {view.label}
    </span>
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
