import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Badge } from '@/renderer/components/ui/badge';
import { CopyButton } from '@/renderer/components/copy-button';
import { Input } from '@/renderer/components/ui/input';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/renderer/components/ui/item';
import { Markdown } from '@/renderer/components/markdown';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { Timestamp } from '@/renderer/components/timestamp';
import { ledgerEventType, summarizeLedgerEvent } from '../../model/describe.js';
import type { LedgerEvent, SessionModel } from '../../model/types.js';

export interface LedgerListProps {
  model: SessionModel;
  events: readonly LedgerEvent[];
  /** When set, the list clears hiding filters and scrolls this seq into view. */
  focusSeq?: number;
}

/** Virtualised raw-ledger list with turn/type/keyword filters. */
export function LedgerList({ events, focusSeq }: LedgerListProps) {
  const [types, setTypes] = useState<string[]>([]);
  const [turn, setTurn] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);
  const focusedSeq = useRef<number | null>(null);

  const allTypes = useMemo(() => [...new Set(events.map((event) => ledgerEventType(event)))], [events]);
  const turnIds = useMemo(() => [...new Set(events.map((event) => event.turn).filter((value): value is number => value !== undefined))], [events]);

  const rows = useMemo(() => events.filter((event) => {
    if (types.length > 0 && !types.includes(ledgerEventType(event))) return false;
    if (turn !== 'all' && String(event.turn ?? '') !== turn) return false;
    if (keyword !== '' && !summarizeLedgerEvent(event).toLowerCase().includes(keyword.toLowerCase())) return false;
    return true;
  }), [events, types, turn, keyword]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 10,
    getItemKey: (index) => rows[index]!.seq,
  });

  const jsonl = useMemo(() => events.map((event) => JSON.stringify(event)).join('\n'), [events]);

  // Deep jump from the usage panel / context tab: drop any filter that would
  // hide the target, then focus its row once the virtualizer can see it.
  useEffect(() => {
    if (focusSeq === undefined) {
      focusedSeq.current = null;
      return;
    }
    if (focusedSeq.current === focusSeq) return;
    if (types.length > 0 || turn !== 'all' || keyword !== '') {
      setTypes([]);
      setTurn('all');
      setKeyword('');
      return;
    }
    const index = rows.findIndex((row) => row.seq === focusSeq);
    if (index < 0) return;
    focusedSeq.current = focusSeq;
    virtualizer.scrollToIndex(index, { align: 'center' });
  }, [focusSeq, types, turn, keyword, rows, virtualizer]);

  const toggle = (seq: number): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Select value={turn} onValueChange={(value) => setTurn(String(value))}>
            <SelectTrigger className="w-28" aria-label="按轮次过滤">
              <SelectValue>{(value) => (value === 'all' ? '全部轮次' : `轮次 ${value}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部轮次</SelectItem>
              {turnIds.map((id) => <SelectItem key={id} value={String(id)}>{`轮次 ${id}`}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={keyword} placeholder="关键字过滤…" className="flex-1" onChange={(event) => setKeyword(event.target.value)} />
          <CopyButton text={jsonl} label="复制全部 JSONL" />
        </div>
        <ToggleGroup multiple value={types} onValueChange={(value) => setTypes(value as string[])} variant="outline" size="sm" className="flex-wrap">
          {allTypes.map((type) => (
            <ToggleGroupItem key={type} value={type}>
              {type}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的事件</p>}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const event = rows[item.index]!;
            const open = expanded.has(event.seq);
            return (
              <div
                key={event.seq}
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
              >
                <Item
                  render={<button type="button" />}
                  size="sm"
                  onClick={() => toggle(event.seq)}
                >
                  <ItemContent>
                    <ItemTitle>{summarizeLedgerEvent(event)}</ItemTitle>
                    <ItemDescription className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums">{event.seq}</span>
                      <Timestamp value={event.at} precision="second" />
                      {event.turn !== undefined && (
                        <span>{`T${event.turn}${event.cycle !== undefined && event.cycle > 0 ? ` · C${event.cycle}` : ''}`}</span>
                      )}
                    </ItemDescription>
                  </ItemContent>
                  <Badge variant="secondary" className="shrink-0">{ledgerEventType(event)}</Badge>
                </Item>
                {open && (
                  <Markdown>{`\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``}</Markdown>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
