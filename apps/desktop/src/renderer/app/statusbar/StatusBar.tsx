import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/renderer/components/ui/context-menu';
import { executeCommand } from '@/renderer/lib/commands';
import { shell } from '@/renderer/lib/desktop';
import { daemonQuery, preferencesQuery } from '@/renderer/lib/queries';
import {
  STATUS_BAR_CONFIGURABLE_ITEMS,
  isMandatoryStatusBarItem,
  useStatusBarItems,
} from '@/renderer/app/statusbar/registry';
import { onQuotaPanelOpen } from '@/renderer/lib/statusbar';
import type { StatusBarItemDefinition, StatusBarSide } from '@/renderer/app/statusbar/registry';
import { DaemonItem, isDaemonDisconnected } from '@/renderer/app/statusbar/DaemonItem';
import { ActivityItem, TaskGraphItem } from '@/renderer/app/statusbar/ActivityItem';
import { QuotaItem } from '@/renderer/app/statusbar/QuotaItem';
import { UpdateItem } from '@/renderer/app/statusbar/UpdateItem';
import { NotificationItem } from '@/renderer/app/statusbar/NotificationItem';
import { cn } from 'cn';

/**
 * Full-width status bar (window-chrome spec 4). It renders the fixed shell
 * items plus every item registered by a visible page, hides items the user
 * turned off or that no longer fit the available width, and exposes the same
 * hide list through a right-click context menu. When the daemon is
 * disconnected the whole bar switches to the destructive surface.
 */

/** Width assumed for an item that has not reported its measured size yet. */
const UNMEASURED_WIDTH = 64;
/** Horizontal chrome (border/padding) reserved when fitting items. */
const BAR_RESERVE = 16;
/** Inter-item gap (`gap-1`) counted into the width budget per boundary. */
const ENTRY_GAP = 4;
/** Fixed priorities for the directly-rendered items; lower hides first. */
const FIXED_PRIORITY = {
  update: 10,
  'activity.taskgraphs': 20,
  'activity.tasks': 30,
  quota: 40,
} as const;

interface BarEntry {
  id: string;
  side: StatusBarSide;
  priority: number;
  mandatory: boolean;
  render: () => ReactNode;
}

function byPriority<T extends { priority: number }>(a: T, b: T): number {
  return a.priority - b.priority;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * One measured item slot; reports its width so the bar can drop it when tight.
 * Every entry stays mounted — an item hidden by preference or by the width
 * budget keeps its CSS-hidden slot so its effects (e.g. the quota panel-open
 * listener) remain live. A hidden slot is not re-measured, which preserves the
 * last width for width-hidden recovery and prevents a hide/re-measure loop; a
 * visible slot records its real width, including 0 when the item's render
 * disappears, so an empty slot never consumes budget.
 */
function EntrySlot({
  entry,
  hidden,
  onMeasure,
}: {
  entry: BarEntry;
  hidden: boolean;
  onMeasure: (id: string, width: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (hidden) return;
    const measure = (): void => onMeasure(entry.id, element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [entry.id, hidden, onMeasure]);
  return (
    <div ref={ref} className={cn('flex items-center', hidden && 'hidden')}>
      {entry.render()}
    </div>
  );
}

export function StatusBar({ onOpenUpdate }: { onOpenUpdate: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widthsRef = useRef<Map<string, number>>(new Map());
  const [containerWidth, setContainerWidth] = useState(0);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [hiddenByWidth, setHiddenByWidth] = useState<ReadonlySet<string>>(() => new Set<string>());
  // While the global `quota.showPanel` command opens the (possibly hidden)
  // quota item, force that one slot visible so the popover anchors to a laid
  // out element instead of a display:none one. This never rewrites the persisted
  // preference; it is released when the panel closes.
  const [quotaForcedVisible, setQuotaForcedVisible] = useState(false);

  const daemon = useQuery(daemonQuery);
  const preferences = useQuery(preferencesQuery);
  const registryItems = useStatusBarItems();
  const destructive = isDaemonDisconnected(daemon.data);

  const hidden = preferences.data?.statusBar.hidden ?? [];
  const hiddenKey = hidden.join('\u0000');
  const prefHidden = useMemo(
    () => new Set(hiddenKey === '' ? [] : hiddenKey.split('\u0000')),
    [hiddenKey],
  );

  useEffect(() => onQuotaPanelOpen(() => setQuotaForcedVisible(true)), []);
  const releaseQuotaForce = useCallback((next: boolean): void => {
    if (!next) setQuotaForcedVisible(false);
  }, []);

  // Fixed items occupy the exact left-to-right order the chrome spec requires;
  // registered page items are inserted by side, ordered by priority.
  const entries = useMemo<BarEntry[]>(() => {
    const toEntry = (item: StatusBarItemDefinition): BarEntry => ({
      id: item.id,
      side: item.side,
      priority: item.priority,
      mandatory: item.mandatory,
      render: item.render,
    });
    const registeredStart = registryItems
      .filter((item) => item.side === 'start')
      .sort(byPriority)
      .map(toEntry);
    const registeredEnd = registryItems
      .filter((item) => item.side === 'end')
      .sort(byPriority)
      .map(toEntry);
    return [
      { id: 'daemon', side: 'start', priority: 0, mandatory: true, render: () => <DaemonItem /> },
      {
        id: 'activity.tasks',
        side: 'start',
        priority: FIXED_PRIORITY['activity.tasks'],
        mandatory: false,
        render: () => <ActivityItem />,
      },
      {
        id: 'activity.taskgraphs',
        side: 'start',
        priority: FIXED_PRIORITY['activity.taskgraphs'],
        mandatory: false,
        render: () => <TaskGraphItem />,
      },
      ...registeredStart,
      ...registeredEnd,
      {
        id: 'quota',
        side: 'end',
        priority: FIXED_PRIORITY.quota,
        mandatory: false,
        render: () => <QuotaItem onOpenChange={releaseQuotaForce} />,
      },
      {
        id: 'update',
        side: 'end',
        priority: FIXED_PRIORITY.update,
        mandatory: false,
        render: () => <UpdateItem onOpenUpdate={onOpenUpdate} />,
      },
      {
        id: 'notifications',
        side: 'end',
        priority: 0,
        mandatory: true,
        render: () => <NotificationItem />,
      },
    ];
  }, [registryItems, onOpenUpdate, releaseQuotaForce]);

  const widthOf = useCallback(
    (id: string): number => widthsRef.current.get(id) ?? UNMEASURED_WIDTH,
    [],
  );

  const measure = useCallback((id: string, width: number): void => {
    // An item whose render returns null reports 0; recording it keeps an empty
    // slot from consuming the width budget.
    const bounded = Number.isFinite(width) && width > 0 ? width : 0;
    if (widthsRef.current.get(id) === bounded) return;
    widthsRef.current.set(id, bounded);
    setMeasureVersion((version) => version + 1);
  }, []);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const update = (): void => setContainerWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const isPrefHidden = (entry: BarEntry): boolean =>
    prefHidden.has(entry.id) && !(entry.id === 'quota' && quotaForcedVisible);

  // Drop the lowest-priority non-mandatory items until the kept widths fit the
  // budget; mandatory items are never dropped and overflow is clipped. The
  // budget counts each item width plus a 4px gap per boundary between kept
  // candidates; a hidden item's measured width is preserved so it can return
  // when the bar widens.
  useLayoutEffect(() => {
    if (containerWidth <= 0) return;
    const budget = containerWidth - BAR_RESERVE;
    const candidates = entries.filter((entry) => entry.mandatory || !isPrefHidden(entry));
    const gaps = Math.max(0, candidates.length - 1) * ENTRY_GAP;
    let total = gaps + candidates.reduce((sum, entry) => sum + widthOf(entry.id), 0);
    const hideOrder = candidates.filter((entry) => !entry.mandatory && !(entry.id === 'quota' && quotaForcedVisible)).sort(byPriority);
    const next = new Set<string>();
    for (const entry of hideOrder) {
      if (total <= budget) break;
      next.add(entry.id);
      total -= widthOf(entry.id) + ENTRY_GAP;
    }
    setHiddenByWidth((previous) => (sameSet(previous, next) ? previous : next));
  }, [entries, prefHidden, containerWidth, measureVersion, widthOf, quotaForcedVisible]);

  const isHidden = (entry: BarEntry): boolean => {
    if (isMandatoryStatusBarItem(entry.id)) return false;
    if (entry.id === 'quota' && quotaForcedVisible) return false;
    return prefHidden.has(entry.id) || hiddenByWidth.has(entry.id);
  };

  const start = entries.filter((entry) => entry.side === 'start');
  const end = entries.filter((entry) => entry.side === 'end');

  const toggleHidden = (id: string, checked: boolean): void => {
    const next = checked ? hidden.filter((value) => value !== id) : [...new Set([...hidden, id])];
    // The main process pushes `preferences-changed`, which invalidates the
    // shared preferences query in `app/query-client`.
    void shell.setPreference('statusBar.hidden', next);
  };

  const rootClass = cn(
    'flex h-(--statusbar-height) shrink-0 items-center gap-1 overflow-hidden border-t px-1 text-xs',
    destructive
      ? 'bg-destructive text-destructive-foreground [&_[data-slot=status-bar-button]]:text-destructive-foreground'
      : 'bg-sidebar text-muted-foreground',
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div data-statusbar ref={containerRef} className={rootClass}>
            <div className="flex items-center gap-1">
              {start.map((entry) => (
                <EntrySlot key={entry.id} entry={entry} hidden={isHidden(entry)} onMeasure={measure} />
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1">
              {end.map((entry) => (
                <EntrySlot key={entry.id} entry={entry} hidden={isHidden(entry)} onMeasure={measure} />
              ))}
            </div>
          </div>
        }
      />
      <ContextMenuContent>
        <ContextMenuLabel>状态栏</ContextMenuLabel>
        {STATUS_BAR_CONFIGURABLE_ITEMS.map((item) => (
          <ContextMenuCheckboxItem
            key={item.id}
            checked={!prefHidden.has(item.id)}
            onCheckedChange={(checked) => toggleHidden(item.id, checked)}
          >
            {item.label}
          </ContextMenuCheckboxItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => executeCommand('settings.open', 'appearance.statusBar')}>
          状态栏设置…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
