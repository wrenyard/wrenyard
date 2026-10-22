import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Check, ChevronDown, ChevronRight, CircleAlert, Copy, FileText, Filter, GitBranch, Layers3, Network, RefreshCw, Search, Sparkles, Workflow } from 'lucide-react';
import type { LedgerEvent, SessionSummary } from '@wrenyard/protocol/session';
import { Elapsed } from '@/renderer/components/elapsed';
import { Timestamp } from '@/renderer/components/timestamp';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs';
import { copyText } from '@/renderer/lib/desktop';
import { useNavLocation } from '@/renderer/lib/navigation';
import { listSessions, readLedger, subscribeLedger } from './api.js';
import { buildTrace, type TraceKind, type TraceModel, type TraceNode } from './model/trace.js';

type FlatRow = { node: TraceNode; depth: number };
const kindLabel: Record<TraceKind, string> = { session: '会话', turn: '轮次', step: '推理步骤', reasoning: '推理', auxiliary: '辅助任务', task: '智能体任务', action: '行动', content: '内容', notice: '通知' };
const icons: Record<TraceKind, typeof Network> = { session: Network, turn: Layers3, step: Sparkles, reasoning: Sparkles, auxiliary: Workflow, task: GitBranch, action: Activity, content: FileText, notice: CircleAlert };

function eventRaw(node: TraceNode): string { return node.events.map((event) => JSON.stringify(event)).join('\n'); }
function nodeOutput(node: TraceNode): string {
  return node.events.map((event) => {
    if (event.type === 'span.finished' && event.kind !== 'task') return [event.output, event.reasoning].filter(Boolean).join('\n\n');
    if (event.type === 'reasoning.completed' || event.type === 'reasoning.thinking' || event.type === 'reply.sent') return event.text;
    if (event.type === 'document.content') return event.content;
    if (event.type === 'action.finished') return event.result;
    return '';
  }).filter(Boolean).join('\n\n');
}
function nodeFields(node: TraceNode): Array<[string, string]> {
  const fields: Array<[string, string]> = [['类型', kindLabel[node.kind]], ['状态', node.status]];
  if (node.id) fields.push(['ID', node.id]);
  if (node.parentId) fields.push(['Parent', node.parentId]);
  fields.push(['Seq', node.endSeq && node.endSeq !== node.seq ? `${node.seq}–${node.endSeq}` : String(node.seq)]);
  if (node.startAt) fields.push(['开始', new Date(node.startAt).toLocaleString()]);
  if (node.endAt) fields.push(['结束', new Date(node.endAt).toLocaleString()]);
  if (node.model) fields.push(['模型', node.model]);
  for (const event of node.events) {
    if (event.type === 'span.started' && event.kind === 'task') {
      fields.push(['任务', event.request.task], ['项目', event.request.project ?? '—'], ['运行 ID', event.request.taskRunId]);
    }
    if (event.type === 'span.started' && event.kind !== 'task') {
      fields.push(['角色', event.request.role ?? '主推理'], ['输入估算', String(event.request.inputEstimate)], ['思考等级', `${event.request.effort?.requested ?? '—'} / ${event.request.effort?.sent ?? '—'}`]);
      fields.push(['各层占用', JSON.stringify(event.request.layers)]);
    }
    if (event.type === 'span.finished') {
      fields.push(['结束原因', event.kind !== 'task' ? event.metrics?.finishReason ?? '—' : event.metrics?.taskStatus ?? '—']);
      if (event.metrics) fields.push(['指标', JSON.stringify(event.metrics)]);
    }
    if (event.type === 'reply.sent' && event.source !== undefined) fields.push(['来源', event.source]);
    if (event.type === 'action.started') fields.push(['提示', event.action.prompt]);
    if (event.type === 'action.finished') fields.push(['结果', event.result]);
  }
  if (node.tokens) fields.push(['用量', `输入 ${node.tokens.input} · 缓存 ${node.tokens.cached} · 输出 ${node.tokens.output} · 推理 ${node.tokens.reasoning}`]);
  return fields;
}

export function TracePage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['session']));
  const [keyword, setKeyword] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [kindFilter, setKindFilter] = useState<Set<TraceKind>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const loadGeneration = useRef(0);
  const eventsBySession = useRef(new Map<string, LedgerEvent[]>());
  const selectedSession = useRef<string | null>(null);

  const refreshSessions = useCallback(async () => {
    setListLoading(true);
    try { setSessions(await listSessions()); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取会话列表'); }
    finally { setListLoading(false); }
  }, []);
  useEffect(() => { void refreshSessions(); }, [refreshSessions]);
  const loadSession = useCallback(async (sessionId: string) => {
    const generation = ++loadGeneration.current;
    selectedSession.current = sessionId;
    setSelectedId(sessionId); setLoading(true); setEvents(eventsBySession.current.get(sessionId) ?? []); setSelectedKey(null); setError('');
    try {
      const snapshot = await readLedger(sessionId);
      if (generation !== loadGeneration.current) return;
      const merged = new Map((eventsBySession.current.get(sessionId) ?? []).map((event) => [event.seq, event]));
      for (const event of snapshot) merged.set(event.seq, event);
      const ordered = [...merged.values()].sort((a, b) => a.seq - b.seq);
      eventsBySession.current.set(sessionId, ordered);
      setEvents(ordered);
      setError('');
    } catch (cause) {
      if (generation === loadGeneration.current) setError(cause instanceof Error ? cause.message : '无法读取会话账本');
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);
  useNavLocation({ sessionId: selectedId ?? '' }, (location) => {
    const sessionId = location.sessionId;
    if (!sessionId) return false;
    if (sessionId !== selectedId) void loadSession(sessionId);
    return true;
  });
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const unsubscribe = subscribeLedger(({ sessionId, event }) => {
      if (!active || sessionId !== selectedSession.current) return;
      const previous = eventsBySession.current.get(sessionId) ?? [];
      if (previous.some((item) => item.seq === event.seq)) return;
      const next = [...previous, event].sort((a, b) => a.seq - b.seq);
      eventsBySession.current.set(sessionId, next);
      setEvents(next);
    });
    return () => { active = false; unsubscribe(); };
  }, [selectedId]);
  const model: TraceModel | null = useMemo(() => events.length ? buildTrace(events) : null, [events]);
  const selectedNode = useMemo(() => {
    if (!model) return null;
    const find = (node: TraceNode): TraceNode | null => node.key === selectedKey ? node : node.children.map(find).find(Boolean) ?? null;
    return find(model.root);
  }, [model, selectedKey]);
  const filteredSessions = useMemo(() => sessions.filter((session) => (session.title ?? '').toLowerCase().includes(query.toLowerCase())), [sessions, query]);
  const matchingKeys = useMemo(() => {
    if (!model) return new Set<string>();
    const result = new Set<string>();
    const visit = (node: TraceNode): boolean => {
      const childMatches = node.children.map((child) => visit(child));
      const textMatch = `${node.label} ${node.kind} ${node.status} ${node.id ?? ''}`.toLowerCase().includes(keyword.toLowerCase());
      const statusMatch = !failedOnly || ['failed', 'error', 'interrupted', 'aborted'].some((word) => node.status.toLowerCase().includes(word)) || childMatches.some(Boolean);
      const kindMatch = kindFilter.size === 0 || kindFilter.has(node.kind) || childMatches.some(Boolean) || node.kind === 'session';
      const matches = (textMatch || childMatches.some(Boolean)) && statusMatch && kindMatch;
      if (matches) result.add(node.key);
      return matches;
    };
    visit(model.root);
    return result;
  }, [model, keyword, failedOnly, kindFilter]);
  function toggleExpand(key: string) { setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  const visibleRows = useMemo(() => {
    const rows: FlatRow[] = [];
    const accepted = matchingKeys;
    const visitFiltered = (node: TraceNode, depth: number) => { if (!accepted.has(node.key)) return; rows.push({ node, depth }); if (expanded.has(node.key)) for (const child of node.children) visitFiltered(child, depth + 1); };
    if (model) visitFiltered(model.root, 0);
    return rows;
  }, [model, matchingKeys, expanded]);
  const copyAll = async () => { await copyText(events.map((event) => JSON.stringify(event)).join('\n')); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
  const now = Date.now();
  const rangeStart = model?.summary.startedAt ? new Date(model.summary.startedAt).getTime() : now;
  const rangeEnd = model?.summary.running ? now : model?.summary.endedAt ? new Date(model.summary.endedAt).getTime() : now;

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2"><Network className="size-4 text-primary" /><h1 className="text-sm font-semibold">会话追踪</h1><span className="text-xs text-muted-foreground">基于账本事件</span></div>
      {selectedId && <div className="flex items-center gap-1"><Button variant="ghost" size="sm" onClick={() => void copyAll()}>{copied ? <Check /> : <Copy />}{copied ? '已复制' : '复制全部 JSONL'}</Button><Button variant="ghost" size="icon-sm" aria-label="刷新" onClick={() => void loadSession(selectedId)}><RefreshCw /></Button></div>}
    </header>
    {error && <div className="border-b border-destructive/30 px-4 py-2 text-xs text-destructive">{error}</div>}
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize="20%" minSize="15%" className="min-w-48 border-r">
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b p-3"><div className="relative"><Search className="absolute top-2 left-2 size-3.5 text-muted-foreground" /><Input className="pl-7" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" /></div></div>
          <ScrollArea className="min-h-0 flex-1"><div className="space-y-1 p-2">
            {listLoading && <div className="p-3 text-xs text-muted-foreground">正在载入会话…</div>}
            {!listLoading && filteredSessions.map((session) => <button key={session.sessionId} type="button" onClick={() => void loadSession(session.sessionId)} className={`w-full rounded-md px-3 py-2 text-left hover:bg-muted ${selectedId === session.sessionId ? 'bg-muted' : ''}`}>
              <span className="block truncate text-sm">{session.title || '未命名会话'}</span><span className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground"><span>{new Date(session.updatedAt).toLocaleString()}</span>{session.running && <span className="text-primary">运行中</span>}</span>
            </button>)}
            {!listLoading && filteredSessions.length === 0 && <div className="p-3 text-xs text-muted-foreground">{query ? '没有匹配的会话' : '还没有会话'}</div>}
          </div></ScrollArea>
          <Button variant="ghost" size="sm" className="m-2 justify-start" onClick={() => void refreshSessions()}><RefreshCw />刷新会话列表</Button>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="52%" minSize="30%" className="min-w-0">
        {!selectedId ? <div className="grid h-full place-items-center text-sm text-muted-foreground">选择一个会话以查看追踪</div> : loading ? <div className="grid h-full place-items-center text-sm text-muted-foreground">正在读取账本…</div> : !model ? <div className="grid h-full place-items-center text-sm text-muted-foreground">这个会话还没有账本事件</div> : <div className="flex h-full min-h-0 flex-col">
          <div className="grid shrink-0 grid-cols-4 gap-2 border-b p-3 text-xs">
            <Metric label="轮次 / 行动" value={`${model.summary.turns} / ${model.summary.actions}`} /><Metric label="推理 / 辅助 / 任务" value={`${model.summary.reasoning} / ${model.summary.auxiliary} / ${model.summary.tasks}`} /><Metric label="输入 / 缓存 / 输出" value={`${model.summary.usage.input} / ${model.summary.usage.cached} / ${model.summary.usage.output}`} /><Metric label="错误 / 警告" value={`${model.summary.errors} / ${model.summary.warnings}`} />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <div className="relative min-w-32 flex-1"><Search className="absolute top-2 left-2 size-3.5 text-muted-foreground" /><Input className="h-7 pl-7 text-xs" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="筛选节点" /></div>
            <Button size="xs" variant={failedOnly ? 'secondary' : 'ghost'} onClick={() => setFailedOnly((value) => !value)}><Filter />仅看失败</Button>
            <select aria-label="节点种类" className="h-7 rounded-md border bg-background px-2 text-xs" value="" onChange={(event) => { const kind = event.target.value as TraceKind; if (kind) setKindFilter((current) => { const next = new Set(current); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; }); }}><option value="">种类筛选</option>{(Object.keys(kindLabel) as TraceKind[]).filter((kind) => kind !== 'session').map((kind) => <option key={kind} value={kind}>{kindLabel[kind]}</option>)}</select>
            {kindFilter.size > 0 && <button className="text-xs text-muted-foreground" onClick={() => setKindFilter(new Set())}>清除种类</button>}
          </div>
          <ScrollArea className="min-h-0 flex-1"><div className="min-w-[560px] p-2">
            {visibleRows.map(({ node, depth }) => <TraceRow key={node.key} node={node} depth={depth} selected={selectedKey === node.key} expanded={expanded.has(node.key)} rangeStart={rangeStart} rangeEnd={rangeEnd} onSelect={() => setSelectedKey(node.key)} onToggle={() => toggleExpand(node.key)} />)}
            {visibleRows.length === 0 && <div className="p-5 text-center text-xs text-muted-foreground">没有匹配的事件</div>}
          </div></ScrollArea>
          <footer className="flex items-center justify-between border-t px-3 py-1.5 text-[10px] text-muted-foreground"><span>事件按 seq 排序 · {events.length} 条</span><span>{model.summary.running ? '会话运行中' : '账本快照'}</span></footer>
        </div>}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="28%" minSize="20%" className="min-w-56 border-l">
        {!selectedNode ? <div className="grid h-full place-items-center text-sm text-muted-foreground">选择一个节点查看详情</div> : <div className="flex h-full min-h-0 flex-col">
          <div className="border-b p-3"><div className="flex items-center gap-2 text-[11px] text-muted-foreground"><span>{kindLabel[selectedNode.kind]}</span><span>·</span><span>seq {selectedNode.seq}{selectedNode.endSeq && selectedNode.endSeq !== selectedNode.seq ? `–${selectedNode.endSeq}` : ''}</span></div><h2 className="mt-1 break-words text-sm font-semibold">{selectedNode.label}</h2>{selectedNode.startAt && <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><Timestamp value={selectedNode.startAt} precision="second" />{selectedNode.endAt ? <Elapsed start={selectedNode.startAt} end={selectedNode.endAt} /> : selectedNode.running ? <Elapsed start={selectedNode.startAt} /> : null}</div>}</div>
          <Tabs defaultValue="overview" className="min-h-0 flex-1"><TabsList variant="line" className="mx-3 mt-2"><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="output">输出</TabsTrigger><TabsTrigger value="raw">原始</TabsTrigger></TabsList>
            <TabsContent value="overview" className="min-h-0 overflow-auto p-3"><div className="space-y-2">{nodeFields(selectedNode).map(([label, value]) => <div key={label} className="rounded-md bg-muted/50 p-2"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-0.5 break-all whitespace-pre-wrap text-xs">{value}</div></div>)}</div></TabsContent>
            <TabsContent value="output" className="min-h-0 overflow-auto p-3"><pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">{nodeOutput(selectedNode) || '该节点没有单独记录输出。'}</pre></TabsContent>
            <TabsContent value="raw" className="flex min-h-0 flex-col p-3"><div className="mb-2 flex justify-end"><Button size="xs" variant="ghost" onClick={() => void copyText(eventRaw(selectedNode))}><Copy />复制节点事件</Button></div><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 text-[10px]">{eventRaw(selectedNode) || '没有直接事件'}</pre></TabsContent>
          </Tabs>
        </div>}
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-md bg-muted/50 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-0.5 truncate font-medium tabular-nums">{value}</div></div>; }
function TraceRow({ node, depth, selected, expanded, rangeStart, rangeEnd, onSelect, onToggle }: { node: TraceNode; depth: number; selected: boolean; expanded: boolean; rangeStart: number; rangeEnd: number; onSelect: () => void; onToggle: () => void }) {
  const Icon = icons[node.kind];
  const start = node.startAt ? new Date(node.startAt).getTime() : null;
  const end = node.endAt ? new Date(node.endAt).getTime() : node.running ? Date.now() : start;
  const total = Math.max(1, rangeEnd - rangeStart);
  const left = start === null ? 0 : Math.max(0, Math.min(100, ((start - rangeStart) / total) * 100));
  const width = start === null || end === null ? 1 : Math.max(1, Math.min(100 - left, ((end - start) / total) * 100));
  const hasChildren = node.children.length > 0;
  return <div className={`group mb-0.5 grid h-9 grid-cols-[minmax(260px,1.1fr)_minmax(120px,0.8fr)_70px_72px] items-center rounded-md pr-2 text-xs ${selected ? 'bg-accent' : 'hover:bg-muted/70'}`}>
    <button type="button" onClick={onSelect} className="flex min-w-0 items-center gap-1.5 text-left" style={{ paddingLeft: 8 + depth * 16 }}>
      <span role="button" tabIndex={0} aria-label={expanded ? '折叠' : '展开'} onClick={(event) => { event.stopPropagation(); onToggle(); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onToggle(); } }} className="grid size-4 shrink-0 place-items-center text-muted-foreground">{hasChildren ? expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" /> : <span className="size-1 rounded-full bg-border" />}</span>
      <Icon className={`size-3.5 shrink-0 ${node.kind === 'notice' ? 'text-amber-600' : node.kind === 'reasoning' ? 'text-violet-500' : 'text-muted-foreground'}`} />
      <span className="truncate">{node.label}</span><span className="shrink-0 text-[10px] text-muted-foreground">{kindLabel[node.kind]}</span>
    </button>
    <div className="relative h-4 overflow-hidden rounded-sm bg-muted/60"><span className={`absolute top-1 h-2 rounded-sm ${node.status.includes('failed') || node.status.includes('error') ? 'bg-destructive/70' : node.running ? 'animate-pulse bg-primary' : 'bg-primary/55'}`} style={{ left: `${left}%`, width: `${width}%` }} /></div>
    <span className="text-right tabular-nums text-muted-foreground">{node.tokens ? node.tokens.input + node.tokens.output : '—'}</span>
    <span className="text-right tabular-nums text-muted-foreground">{node.startAt && node.endAt ? <Elapsed start={node.startAt} end={node.endAt} /> : node.startAt && node.running ? <Elapsed start={node.startAt} /> : node.events[0]?.at ? new Date(node.events[0].at).toLocaleTimeString() : '—'}</span>
  </div>;
}
