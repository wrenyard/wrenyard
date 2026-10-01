import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { formatRatio, formatTokenCount } from '@/renderer/lib/format';
import type { ContextInspection, ContextItemKind } from '@/shell-contract';
import { contextTreeRows, ITEM_KIND_LABEL, USAGE_GROUP_ORDER, type ContextTreeRow, type UsageGroupId } from '../../../model/usage.js';
import { Section } from '../parts.js';

/** Four columns; the 类型 column collapses below the narrow inspector width. */
const TREE_GRID = 'grid w-full grid-cols-[minmax(0,1fr)_5rem_4.5rem_3.5rem] items-center gap-x-2 @max-[420px]:grid-cols-[minmax(0,1fr)_4rem_3.5rem]';
const TYPE_HEAD = 'text-right @max-[420px]:hidden';
const TYPE_CELL = 'truncate text-xs text-muted-foreground @max-[420px]:hidden';
const INDENT: Record<0 | 1 | 2, string> = { 0: '', 1: 'pl-4', 2: 'pl-8' };

export interface ContextTreeProps {
  inspection: ContextInspection;
  onInspect: (options?: { tab?: 'context' | 'ledger'; seq?: number }) => void;
}

/** Group → type → item composition tree, virtualised and rendered from `contextTreeRows`. */
export function ContextTree({ inspection, onInspect }: ContextTreeProps) {
  const [turn, setTurn] = useState('all');
  const [kinds, setKinds] = useState<ContextItemKind[]>([]);
  const [sort, setSort] = useState<'seq' | 'tokens'>('tokens');
  const [expandedGroups, setExpandedGroups] = useState<Set<UsageGroupId>>(() => new Set(USAGE_GROUP_ORDER));
  const [expandedKinds, setExpandedKinds] = useState<Set<string>>(() => new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const turnIds = useMemo(
    () => [...new Set(inspection.items.map((item) => item.turn))].sort((left, right) => left - right),
    [inspection.items],
  );
  const allKinds = useMemo(() => [...new Set(inspection.items.map((item) => item.kind))], [inspection.items]);

  const rows = useMemo(() => contextTreeRows(inspection, {
    expandedGroups,
    expandedKinds,
    sort,
    ...(turn === 'all' ? {} : { turn: Number(turn) }),
    ...(kinds.length === 0 ? {} : { kinds: new Set(kinds) }),
  }), [inspection, expandedGroups, expandedKinds, sort, turn, kinds]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
    getItemKey: (index) => rows[index]!.key,
  });

  const toggleGroup = (group: UsageGroupId): void => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const toggleKind = (key: string): void => {
    setExpandedKinds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Section title="构成">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={turn} onValueChange={(value) => setTurn(String(value))}>
            <SelectTrigger className="w-28" aria-label="按轮次筛选">
              <SelectValue>{(value) => (value === 'all' ? '全部轮次' : `轮次 ${value}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部轮次</SelectItem>
              {turnIds.map((id) => <SelectItem key={id} value={String(id)}>{`轮次 ${id}`}</SelectItem>)}
            </SelectContent>
          </Select>
          <ToggleGroup multiple value={kinds} onValueChange={(value) => setKinds(value as ContextItemKind[])} variant="outline" size="sm" className="flex-wrap">
            {allKinds.map((kind) => (
              <ToggleGroupItem key={kind} value={kind}>{ITEM_KIND_LABEL[kind]}</ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select value={sort} onValueChange={(value) => setSort(value as 'seq' | 'tokens')}>
            <SelectTrigger className="ml-auto w-28" aria-label="排序方式">
              <SelectValue>{(value) => (value === 'seq' ? '按序号' : '按 Token')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="seq">按序号</SelectItem>
              <SelectItem value="tokens">按 Token</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="@container">
          <div className={`${TREE_GRID} border-b pb-1 text-xs text-muted-foreground`}>
            <span>条目</span>
            <span className={TYPE_HEAD}>类型</span>
            <span className="text-right">Token</span>
            <span className="text-right">占比</span>
          </div>
          <div ref={parentRef} className="max-h-80 min-h-0 overflow-auto">
            {rows.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的条目</p>}
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]!;
                return (
                  <div
                    key={row.key}
                    className="absolute left-0 top-0 w-full"
                    style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <TreeRowView
                      row={row}
                      onInspect={onInspect}
                      expandedGroups={expandedGroups}
                      expandedKinds={expandedKinds}
                      onToggleGroup={toggleGroup}
                      onToggleKind={toggleKind}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function TreeRowView({ row, onInspect, expandedGroups, expandedKinds, onToggleGroup, onToggleKind }: {
  row: ContextTreeRow;
  onInspect: (options?: { tab?: 'context' | 'ledger'; seq?: number }) => void;
  expandedGroups: Set<UsageGroupId>;
  expandedKinds: Set<string>;
  onToggleGroup: (group: UsageGroupId) => void;
  onToggleKind: (key: string) => void;
}) {
  if (row.kind === 'item' && row.item) {
    const item = row.item;
    return (
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className={`${TREE_GRID} text-left`}
        title={item.label}
        onClick={() => onInspect({ tab: 'ledger', seq: item.seq })}
      >
        <span className={`flex min-w-0 items-baseline gap-1 ${INDENT[row.depth]}`}>
          <span className="truncate">{item.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{`#${item.seq} · T${item.turn}`}</span>
        </span>
        <span className={TYPE_CELL}>{ITEM_KIND_LABEL[item.kind]}</span>
        <span className="text-right tabular-nums">{formatTokenCount(item.tokens)}</span>
        <span className="text-right tabular-nums">{formatRatio(row.share)}</span>
      </Button>
    );
  }

  const expanded = row.kind === 'group' ? expandedGroups.has(row.key as UsageGroupId) : expandedKinds.has(row.key);
  const onToggle = (): void => {
    if (row.kind === 'group') onToggleGroup(row.key as UsageGroupId);
    else onToggleKind(row.key);
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="lg"
      className={`${TREE_GRID} text-left`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className={`flex min-w-0 items-center gap-1 font-medium ${INDENT[row.depth]}`}>
        {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span className="truncate">{row.label}</span>
      </span>
      <span className={TYPE_HEAD} />
      <span className="text-right tabular-nums">{formatTokenCount(row.tokens)}</span>
      <span className="text-right tabular-nums">{formatRatio(row.share)}</span>
    </Button>
  );
}
