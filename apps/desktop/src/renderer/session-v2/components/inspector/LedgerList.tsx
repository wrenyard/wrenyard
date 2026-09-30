import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check } from 'lucide-react';
import { Badge } from '@/renderer/components/ui/badge';
import { CopyButton } from '@/renderer/components/copy-button';
import { Input } from '@/renderer/components/ui/input';
import { Markdown } from '@/renderer/components/markdown';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/components/ui/toggle-group';
import { formatClockSeconds } from '@/renderer/lib/format';
import type { LedgerEvent, SessionModel } from '../../model/types.js';

function eventType(event: LedgerEvent): string {
  return (event as { type: string }).type;
}

function oneLine(value: string, max = 140): string {
  const line = value.split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function summarize(event: LedgerEvent): string {
  const record = event as unknown as Record<string, unknown>;
  switch (eventType(event)) {
    case 'session.created': return String(record.workspaceRoot ?? '');
    case 'turn.started': return oneLine(String(record.text ?? ''));
    case 'context.selected': return `${(record.selections as unknown[] | undefined)?.length ?? 0} 项`;
    case 'memory.recalled':
    case 'doc.read': return String(record.path ?? '');
    case 'reason.completed':
    case 'action.block':
    case 'reply':
    case 'title': return oneLine(String(record.text ?? ''));
    case 'action.started': return String(record.kind ?? '');
    case 'action.finished': return oneLine(`${record.kind} · ${record.status}: ${record.result ?? ''}`);
    case 'ws.updated': return `${record.change} ${record.path}`;
    case 'turn.interrupted': return String(record.reason ?? '');
    case 'turn.finished': return String(record.status ?? '');
    case 'call': return `${record.role} · ${record.model} · ${record.status}`;
    case 'call.started': return `${record.role} · ${record.model}`;
    case 'error': return oneLine(`${record.stage}: ${record.message}`);
    default: return '';
  }
}

export interface LedgerListProps {
  model: SessionModel;
  events: readonly LedgerEvent[];
}

/** Virtualised raw-ledger list with turn/type/keyword filters. */
export function LedgerList({ events }: LedgerListProps) {
  const [types, setTypes] = useState<string[]>([]);
  const [turn, setTurn] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const allTypes = useMemo(() => [...new Set(events.map((event) => eventType(event)))], [events]);
  const turnIds = useMemo(() => [...new Set(events.map((event) => event.turn).filter((value): value is number => value !== undefined))], [events]);

  const rows = useMemo(() => events.filter((event) => {
    if (types.length > 0 && !types.includes(eventType(event))) return false;
    if (turn !== 'all' && String(event.turn ?? '') !== turn) return false;
    if (keyword !== '' && !summarize(event).toLowerCase().includes(keyword.toLowerCase())) return false;
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
      <div className="flex flex-col gap-2 border-b border-border p-2">
        <div className="flex items-center gap-2">
          <Select value={turn} onValueChange={(value) => setTurn(String(value))}>
            <SelectTrigger size="sm" className="w-28" aria-label="按轮次过滤">
              <SelectValue>{(value) => (value === 'all' ? '全部轮次' : `轮次 ${value}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部轮次</SelectItem>
              {turnIds.map((id) => <SelectItem key={id} value={String(id)}>{`轮次 ${id}`}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={keyword} placeholder="关键字过滤…" className="h-7 flex-1" onChange={(event) => setKeyword(event.target.value)} />
          <CopyButton text={jsonl} label="复制全部 JSONL" />
        </div>
        <ToggleGroup multiple value={types} onValueChange={(value) => setTypes(value as string[])} className="flex-wrap">
          {allTypes.map((type) => {
            const selected = types.includes(type);
            return (
              <ToggleGroupItem
                key={type}
                value={type}
                size="sm"
                variant="outline"
                className="gap-1 text-xs data-pressed:border-primary! data-pressed:bg-primary! data-pressed:text-primary-foreground! hover:data-pressed:bg-primary! hover:data-pressed:text-primary-foreground!"
              >
                {selected && <Check className="size-3" />}
                {type}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && <p className="p-3 text-sm text-muted-foreground">没有匹配的事件</p>}
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
                className="border-b border-border/60"
              >
                <button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                  onClick={() => toggle(event.seq)}>
                  <span className="w-8 shrink-0 text-right font-mono text-muted-foreground">{event.seq}</span>
                  <span className="w-16 shrink-0 font-mono text-muted-foreground">{formatClockSeconds(event.at)}</span>
                  <Badge variant="secondary" className="shrink-0">{eventType(event)}</Badge>
                  {event.turn !== undefined && <span className="shrink-0 text-muted-foreground">T{event.turn}{event.cycle !== undefined && event.cycle > 0 ? ` · C${event.cycle}` : ''}</span>}
                  <span className="min-w-0 flex-1 truncate">{summarize(event)}</span>
                </button>
                {open && (
                  <div className="px-2 pb-2">
                    <Markdown size="sm">{`\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``}</Markdown>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
